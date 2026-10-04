import type { TCPSocketListener, udp } from "bun";
import { type ServerConfig, loadConfig } from "../config/index.ts";
import { dispatchTcpPacket, dispatchUdpDatagram } from "../handlers/dispatcher.ts";
import { type ClientSession, WorldState } from "../state/worldState.ts";

interface SocketData {
  session: ClientSession;
}

export class CrazyArcadeServer implements Disposable, AsyncDisposable {
  public readonly config: ServerConfig;
  public readonly state: WorldState;

  private tcpServer: TCPSocketListener<SocketData> | null = null;
  private udpSocket: udp.Socket<"buffer"> | null = null;

  constructor(configOverrides: Partial<ServerConfig> = {}, state?: WorldState) {
    this.config = loadConfig(configOverrides);
    this.state = state ?? new WorldState(this.config);
  }

  public async start(): Promise<{ tcpPort: number; udpPort: number }> {
    const self = this;

    const tcpListener = Bun.listen<SocketData>({
      hostname: this.config.host,
      port: this.config.tcpPort,
      socket: {
        open(socket) {
          const session = self.state.createSession(
            (bytes: Uint8Array) => {
              socket.write(bytes);
            },
            socket.remoteAddress || "127.0.0.1",
            0
          );
          socket.data = {
            session,
          };
          // Immediately send Degree-0 Connect Hello upon TCP accept (`sub_5D8B10` / `sub_5D86DD`)
          session.sendConnectHello(self.config);
        },

        data(socket, chunk) {
          const data = socket.data;
          if (!data) {
            return;
          }

          // Feed incoming chunk to per-socket stream buffer (`CPacketSocket::sub_69A000`)
          const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          const packets = data.session.socketState.feed(incoming);
          for (const reader of packets) {
            dispatchTcpPacket(self.state, data.session, reader);
          }
        },

        close(socket) {
          if (socket.data?.session) {
            self.state.removeSession(socket.data.session.sessionId);
          }
        },

        error(socket, _err) {
          if (socket.data?.session) {
            self.state.removeSession(socket.data.session.sessionId);
          }
        },
      },
    });
    this.tcpServer = tcpListener;

    const boundTcpPort = tcpListener.port;
    const targetUdpPort =
      this.config.tcpPort === 0 ? 0 : this.config.udpPort || boundTcpPort + 1;

    const udpListener = await Bun.udpSocket({
      hostname: this.config.host,
      port: targetUdpPort,
      socket: {
        data(socket, buf, port, addr) {
          const datagram = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
          const replies = dispatchUdpDatagram(self.state, datagram, addr, port);
          for (const reply of replies) {
            socket.send(reply.datagram, reply.port, reply.address);
          }
        },
      },
    });
    this.udpSocket = udpListener;

    this.config.tcpPort = boundTcpPort;
    this.config.udpPort = udpListener.port;

    return {
      tcpPort: this.config.tcpPort,
      udpPort: this.config.udpPort,
    };
  }

  public stop(): void {
    if (this.tcpServer) {
      this.tcpServer.stop(true);
      this.tcpServer = null;
    }
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
    this.state.db.close();
  }

  public [Symbol.dispose](): void {
    this.stop();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    this.stop();
  }
}
