import type { TCPSocketListener, udp } from "bun";
import { type ServerConfig, loadConfig } from "../config/index.ts";
import { dispatchTcpPacket, dispatchUdpDatagram } from "../handlers/dispatcher.ts";
import { type ClientConnectionKind, type ClientSession, WorldState } from "../state/worldState.ts";
import { formatHexPreview, logger } from "../utils/logger.ts";

interface SocketData {
  session: ClientSession;
}

export interface BoundServerPorts {
  tcpPort: number;
  udpPort: number;
  gameTcpPort: number;
  gameUdpPort: number;
}

const CONNECTION_LABEL: Record<ClientConnectionKind, string> = {
  login: "LoginServer",
  game: "GameServer",
};

/**
 * Runs the separate LoginServer and GameServer TCP endpoints plus their UDP peer ports.
 * The client logs into 3838, then reconnects to the GameServer endpoint advertised by
 * CSelectServerStage (`S->C 7`) before it sends the session token in C->S 6.
 */
export class CrazyArcadeServer implements Disposable, AsyncDisposable {
  public readonly config: ServerConfig;
  public readonly state: WorldState;

  private readonly tcpServers: TCPSocketListener<SocketData>[] = [];
  private readonly udpSockets: udp.Socket<"buffer">[] = [];

  constructor(configOverrides: Partial<ServerConfig> = {}, state?: WorldState) {
    this.config = loadConfig(configOverrides);
    this.state = state ?? new WorldState(this.config);
  }

  public async start(): Promise<BoundServerPorts> {
    if (this.tcpServers.length > 0 || this.udpSockets.length > 0) {
      throw new Error("CrazyArcadeServer is already started");
    }

    const requestedLoginTcpPort = this.config.tcpPort;
    const requestedGameTcpPort = this.config.gameTcpPort;

    try {
      const loginServer = this.listenTcp("login", requestedLoginTcpPort);
      this.tcpServers.push(loginServer);
      const gameServer = this.listenTcp("game", requestedGameTcpPort);
      this.tcpServers.push(gameServer);

      this.config.tcpPort = loginServer.port;
      this.config.gameTcpPort = gameServer.port;

      // When a TCP port is selected dynamically (port 0), select the UDP port dynamically
      // too rather than accidentally binding to port 1. Explicit/default ports retain the
      // official TCP + 1 relationship: 3838/3839 and 9339/9340.
      const loginUdpPort =
        requestedLoginTcpPort === 0 ? 0 : this.config.udpPort || loginServer.port + 1;
      const gameUdpPort =
        requestedGameTcpPort === 0 ? 0 : this.config.gameUdpPort || gameServer.port + 1;
      const loginUdp = await this.listenUdp("login", loginUdpPort);
      this.udpSockets.push(loginUdp);
      const gameUdp = await this.listenUdp("game", gameUdpPort);
      this.udpSockets.push(gameUdp);

      this.config.udpPort = loginUdp.port;
      this.config.gameUdpPort = gameUdp.port;

      const ports = {
        tcpPort: this.config.tcpPort,
        udpPort: this.config.udpPort,
        gameTcpPort: this.config.gameTcpPort,
        gameUdpPort: this.config.gameUdpPort,
      };
      logger.info("Network", "CrazyArcade v22 services listening", {
        host: this.config.host,
        ...ports,
      });
      return ports;
    } catch (error) {
      this.closeListeners();
      logger.error("Network", "Failed to start one or more server endpoints", {
        host: this.config.host,
        requestedLoginTcpPort,
        requestedGameTcpPort,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private listenTcp(
    connectionKind: ClientConnectionKind,
    port: number
  ): TCPSocketListener<SocketData> {
    const label = CONNECTION_LABEL[connectionKind];
    const world = this.state;
    const config = this.config;

    return Bun.listen<SocketData>({
      hostname: config.host,
      port,
      socket: {
        open(socket) {
          const session = world.createSession(
            (bytes) => {
              socket.write(bytes);
            },
            socket.remoteAddress || "127.0.0.1",
            socket.remotePort,
            socket.localAddress,
            socket.localPort,
            connectionKind
          );
          socket.data = { session };

          logger.info("TCP", `${label} accepted client`, {
            sessionId: session.sessionId,
            remoteAddress: session.remoteAddress,
            remotePort: session.remotePort,
            localAddress: session.localAddress,
            localPort: session.localPort,
          });

          // `CPacketSocket::sub_5D8B10` sends ConnectHello on every accepted socket,
          // including the separate GameServer handoff connection.
          session.sendConnectHello(config);
        },

        data(socket, chunk) {
          const session = socket.data?.session;
          if (!session) {
            logger.warn("TCP", `${label} received bytes before session initialization`, {
              remoteAddress: socket.remoteAddress,
              byteCount: chunk.byteLength,
            });
            return;
          }

          const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          logger.debug("TCP", `${label} received TCP bytes`, {
            sessionId: session.sessionId,
            stageId: session.stageId,
            byteCount: incoming.length,
            encryptedFramePreview: formatHexPreview(incoming, 20),
          });

          try {
            // `CPacketSocket::sub_69A000` buffers partial frames and validates sequence + CRC.
            const packets = session.socketState.feed(incoming);
            for (const packet of packets) {
              dispatchTcpPacket(world, session, packet);
            }
          } catch (error) {
            logger.error("TCP", `${label} packet processing failed; closing client socket`, {
              sessionId: session.sessionId,
              remoteAddress: session.remoteAddress,
              remotePort: session.remotePort,
              stageId: session.stageId,
              error: error instanceof Error ? error.message : String(error),
            });
            socket.end();
          }
        },

        close(socket) {
          const session = socket.data?.session;
          if (!session) return;
          logger.info("TCP", `${label} client disconnected`, {
            sessionId: session.sessionId,
            remoteAddress: session.remoteAddress,
            remotePort: session.remotePort,
            stageId: session.stageId,
            connectedForMs: Date.now() - session.connectedAtMs,
          });
          world.removeSession(session.sessionId);
        },

        error(socket, error) {
          const session = socket.data?.session;
          logger.error("TCP", `${label} socket error`, {
            sessionId: session?.sessionId,
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            error: error.message,
          });
          if (session) {
            world.removeSession(session.sessionId);
          }
        },
      },
    });
  }

  private async listenUdp(
    connectionKind: ClientConnectionKind,
    port: number
  ): Promise<udp.Socket<"buffer">> {
    const label = `${CONNECTION_LABEL[connectionKind]} UDP`;
    const world = this.state;

    return Bun.udpSocket({
      hostname: this.config.host,
      port,
      socket: {
        data(socket, buf, remotePort, remoteAddress) {
          const datagram = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          logger.debug("UDP", `${label} datagram received`, {
            remoteAddress,
            remotePort,
            byteCount: datagram.length,
            encryptedFramePreview: formatHexPreview(datagram, 24),
          });
          const replies = dispatchUdpDatagram(world, datagram, remoteAddress, remotePort);
          for (const reply of replies) {
            socket.send(reply.datagram, reply.port, reply.address);
            logger.debug("UDP", `${label} datagram sent`, {
              remoteAddress: reply.address,
              remotePort: reply.port,
              byteCount: reply.datagram.length,
              framePreview: formatHexPreview(reply.datagram, 24),
            });
          }
        },
      },
    });
  }

  private closeListeners(): void {
    for (const server of this.tcpServers.splice(0)) {
      server.stop(true);
    }
    for (const socket of this.udpSockets.splice(0)) {
      socket.close();
    }
  }

  public stop(): void {
    this.closeListeners();
    this.state.db.close();
  }

  public [Symbol.dispose](): void {
    this.stop();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    this.stop();
  }
}
