import type { ServerConfig } from "../config/index.ts";
import { GameDatabase, type UserRecord } from "../db/database.ts";
import {
  PacketSocketState,
  type ConnectHelloInfo,
  type PacketLogContext,
} from "../protocol/framing.ts";
import { DEFAULT_C_CHANNELS, type CChannelInfo } from "../protocol/channelCache.ts";
import type { PacketWriter } from "../protocol/primitives.ts";
import { StageId } from "../protocol/opcodes.ts";
import { loadClientResources, type ClientResources } from "../resources/archive.ts";
import {
  formatClientOpcode,
  formatServerOpcode,
  formatStageId,
} from "../utils/logger.ts";

export type { CChannelInfo } from "../protocol/channelCache.ts";

export interface AuthSessionSnapshot {
  usernames: string[];
  netSlotIds: number[];
  charIds: number[];
  /** LoginServer TCP session that issued this opaque token; retained only for log correlation. */
  loginSessionId: number;
  /** Chosen absolute `CChannelCache` record index, set when C->S 5 succeeds. */
  channelIndex: number | null;
}

export interface UdpEndpoint {
  ip: number; // IPv4 as u32 BE integer
  port: number;
}

export interface RoomSlot {
  slotIdx: number;
  occupied: boolean;
  open: boolean;
  ready: boolean;
  inShop: boolean;
  charId: number;
  teamColor: number;
  session: ClientSession | null;
  localPlayerIdx: number;
  netSlotId: number;
  user: UserRecord | null;
  loadedGame: boolean;
  alive: boolean;
  trapped: boolean;
  kills: number;
  saves: number;
  udpEndpoints: [UdpEndpoint, UdpEndpoint, UdpEndpoint];
}

function createEmptyUdpEndpoints(): [UdpEndpoint, UdpEndpoint, UdpEndpoint] {
  return [
    { ip: 0, port: 0 },
    { ip: 0, port: 0 },
    { ip: 0, port: 0 },
  ];
}

export interface GameRoom {
  roomNumber: number;
  name: string;
  password: string;
  hasPassword: boolean;
  maxPlayers: number;
  gameMode: number;
  gameSubMode: number;
  mapId: number;
  mapTheme: number;
  chiefSlotNetId: number;
  isPlaying: boolean;
  randomSeed: number;
  startTick: number;
  slots: RoomSlot[];
}

export type ClientConnectionKind = "login" | "game";
export type ServerCloseReason = "startup-failure" | "server-shutdown" | "packet-processing-error";
export type TcpPacketDirection = "C->S" | "S->C";

interface TcpPacketTraceEvent {
  atMs: number;
  direction: TcpPacketDirection;
  label: string;
  packetBytes: number;
  stageId: number;
}

export interface TcpPacketTraceSummary {
  /** Inbound events are decoded packets; outbound events are server socket.write calls. */
  clientToServerDecodedPackets: number;
  serverToClientWriteCalls: number;
  /** Number of old events omitted from the bounded, per-session timeline. */
  omittedTraceEvents: number;
  lastClientPacketAgoMs: number | null;
  lastServerWriteAgoMs: number | null;
  pendingReceiveBytes: number;
  /** Human-readable chronological summary; packet bodies are never included. */
  packetFlow: string;
}

const MAX_SESSION_TRACE_EVENTS = 48;

export class ClientSession {
  public readonly sessionId: number;
  public readonly socketState: PacketSocketState;
  public readonly sendRaw: (bytes: Uint8Array) => void;
  public readonly connectedAtMs: number;
  public readonly connectionKind: ClientConnectionKind;
  public remoteAddress: string;
  public remotePort: number;
  /** Server-side local endpoint metadata, used for diagnostics only; publicIp controls handoffs. */
  public localAddress: string;
  public localPort: number;

  public sessionKey: number;
  public ssdSynced = false;
  /** Server-side stage model from the connection path and client packets; not client UI/modal state. */
  public stageId: number;
  /** Destination requested by the last server transition but not yet observed through its client signal. */
  public pendingStageId: number | null = null;
  /** LoginServer TCP session that issued this GameServer handoff token; never a wire field. */
  public linkedLoginSessionId: number | null = null;
  /** True after the client emits C->S 83 (`EnterLobby`); does not expose local modal state. */
  public lobbyEntryPacketSeen = false;
  public channelIndex = 0;

  // Up to 2 local players per client (1P / 2P)
  public users: UserRecord[] = [];
  public netSlotIds: number[] = [];
  public authTokens: number[] = [];
  public equippedCharIds: number[] = [0, 1];

  public currentRoomNumber: number | null = null;
  public roomSlotIndices: number[] = [];
  public udpEndpoint: { address: string; port: number } | null = null;

  public lastAntiHackStatus = 0;

  /** Explicit server-initiated close request, if one was made before TCP close. */
  public serverCloseReason: ServerCloseReason | null = null;
  /** Socket errors are retained for the final connection summary without implying who closed it. */
  public socketErrorMessage: string | null = null;

  private readonly packetTrace: TcpPacketTraceEvent[] = [];
  private omittedPacketTraceEvents = 0;
  private clientToServerDecodedPackets = 0;
  private serverToClientWriteCalls = 0;
  private lastClientPacketAtMs: number | null = null;
  private lastServerWriteAtMs: number | null = null;

  constructor(
    sessionId: number,
    sendRaw: (bytes: Uint8Array) => void,
    remoteAddress: string = "127.0.0.1",
    remotePort: number = 0,
    localAddress: string = "0.0.0.0",
    localPort: number = 0,
    connectionKind: ClientConnectionKind = "login"
  ) {
    this.sessionId = sessionId;
    this.socketState = new PacketSocketState("server");
    this.sendRaw = sendRaw;
    this.connectedAtMs = Date.now();
    this.connectionKind = connectionKind;
    // A fresh GameServer socket is opened from CSelectServerStage; C->S 6 later
    // authenticates the handoff but does not itself prove Lobby entry.
    this.stageId = connectionKind === "game" ? StageId.SelectServer : StageId.Login;
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
    this.localAddress = localAddress;
    this.localPort = localPort;
    this.sessionKey = (0x12340000 + (sessionId & 0xffff)) >>> 0;
  }

  private packetLogContext(): PacketLogContext {
    return {
      sessionId: this.sessionId,
      connectionKind: this.connectionKind,
      stageId: this.stageId,
    };
  }

  /** Record only packet direction, opcode, stage, size, and time—never the body. */
  public recordPacketTrace(
    direction: TcpPacketDirection,
    opcode: number | null,
    packetBytes: number,
    stageId: number = this.stageId,
    label?: string,
    atMs: number = Date.now()
  ): void {
    const packetLabel =
      label ??
      (opcode === null
        ? "ConnectHello"
        : direction === "C->S"
          ? formatClientOpcode(opcode)
          : formatServerOpcode(opcode, stageId));

    if (direction === "C->S") {
      this.clientToServerDecodedPackets++;
      this.lastClientPacketAtMs = atMs;
    } else {
      this.serverToClientWriteCalls++;
      this.lastServerWriteAtMs = atMs;
    }

    if (this.packetTrace.length === MAX_SESSION_TRACE_EVENTS) {
      this.packetTrace.shift();
      this.omittedPacketTraceEvents++;
    }

    this.packetTrace.push({
      atMs,
      direction,
      label: packetLabel,
      packetBytes: Math.max(0, packetBytes),
      stageId,
    });
  }

  public getPacketTraceSummary(closedAtMs: number = Date.now()): TcpPacketTraceSummary {
    const packetFlow = this.packetTrace.length === 0
      ? "<no decoded TCP packets>"
      : this.packetTrace
          .map((event, index) => {
            const elapsedMs = Math.max(0, event.atMs - this.connectedAtMs);
            const sequence = this.omittedPacketTraceEvents + index + 1;
            const observation = event.direction === "C->S" ? "decoded" : "write-call";
            return (
              `#${String(sequence).padStart(2, "0")} +${elapsedMs}ms ${event.direction} ` +
              `[${observation}] ${event.label} ${event.packetBytes}B @${formatStageId(event.stageId)}`
            );
          })
          .join("\n");

    return {
      clientToServerDecodedPackets: this.clientToServerDecodedPackets,
      serverToClientWriteCalls: this.serverToClientWriteCalls,
      omittedTraceEvents: this.omittedPacketTraceEvents,
      lastClientPacketAgoMs:
        this.lastClientPacketAtMs === null
          ? null
          : Math.max(0, closedAtMs - this.lastClientPacketAtMs),
      lastServerWriteAgoMs:
        this.lastServerWriteAtMs === null
          ? null
          : Math.max(0, closedAtMs - this.lastServerWriteAtMs),
      pendingReceiveBytes: this.socketState.pendingReceiveBytes,
      packetFlow,
    };
  }

  public sendConnectHello(config: ServerConfig): ConnectHelloInfo {
    const info: ConnectHelloInfo = {
      flag: 0,
      minVersion: config.minClientVersion,
      currentVersion: config.clientVersion,
      sessionKey: this.sessionKey,
      noticeUrl: config.noticeUrl,
      extraFlag: 0,
    };
    const frame = this.socketState.encodeConnectHello(
      info,
      1,
      config.repoRoot,
      this.packetLogContext()
    );
    this.sendRaw(frame);
    this.recordPacketTrace("S->C", null, frame.length - 3, this.stageId, "ConnectHello");
    return info;
  }

  public sendPacket(writer: PacketWriter): void {
    const frame = this.socketState.encodePacket(writer, 0x00, this.packetLogContext());
    this.sendRaw(frame);
    this.recordPacketTrace("S->C", writer.opcode, frame.length - 7);
  }
}

export class WorldState implements Disposable {
  public readonly config: ServerConfig;
  public readonly db: GameDatabase;
  public readonly resources: ClientResources;
  public readonly channels: CChannelInfo[];

  public readonly sessions = new Map<number, ClientSession>();
  public readonly sessionsByToken = new Map<number, AuthSessionSnapshot>();
  public readonly rooms = new Map<number, GameRoom>();

  private nextSessionId = 1;
  private nextNetSlotId = 100;
  private nextToken = 0x20000001;

  constructor(config: ServerConfig, db?: GameDatabase, resources?: ClientResources) {
    this.config = config;
    this.db = db ?? new GameDatabase(config.dbPath);
    this.resources = resources ?? loadClientResources(config.repoRoot);
    this.channels = this.createDefaultChannels();
  }

  private createDefaultChannels(): CChannelInfo[] {
    // `channel2_001.ssd` is dynamically supplied by the LoginServer in this client version,
    // not present as a standalone file in the checked-in client assets. These structurally
    // valid defaults reproduce the four TW `CSelectServerStage` tabs until configured.
    return DEFAULT_C_CHANNELS.map((channel) => ({ ...channel }));
  }

  public createSession(
    sendRaw: (bytes: Uint8Array) => void,
    remoteAddress: string = "127.0.0.1",
    remotePort: number = 0,
    localAddress: string = "0.0.0.0",
    localPort: number = 0,
    connectionKind: ClientConnectionKind = "login"
  ): ClientSession {
    const id = this.nextSessionId++;
    const session = new ClientSession(
      id,
      sendRaw,
      remoteAddress,
      remotePort,
      localAddress,
      localPort,
      connectionKind
    );
    this.sessions.set(id, session);
    return session;
  }

  public removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.currentRoomNumber !== null) {
      this.leaveRoom(session);
    }
    this.sessions.delete(sessionId);
  }

  public findSessionByUsername(username: string): ClientSession | undefined {
    const target = username.trim().toLowerCase();
    if (!target) {
      return undefined;
    }
    for (const s of this.sessions.values()) {
      if (s.users.some((u) => u.username.toLowerCase() === target)) {
        return s;
      }
    }
    return undefined;
  }

  public allocateNetSlotId(): number {
    return this.nextNetSlotId++;
  }

  public allocateAuthToken(
    usernames: string[],
    netSlotIds: number[],
    charIds: number[],
    loginSessionId: number
  ): number {
    const token = this.nextToken++ >>> 0;
    this.sessionsByToken.set(token, {
      usernames: [...usernames],
      netSlotIds: [...netSlotIds],
      charIds: [...charIds],
      loginSessionId,
      channelIndex: null,
    });
    return token;
  }

  public setAuthTokenChannel(token: number, channelIndex: number): void {
    const snapshot = this.sessionsByToken.get(token >>> 0);
    if (snapshot) {
      snapshot.channelIndex = channelIndex;
    }
  }

  public createRoom(
    chiefSession: ClientSession,
    name: string,
    password: string,
    hasPassword: boolean,
    gameMode: number,
    mapTheme: number,
    charIds: number[]
  ): GameRoom {
    let roomNumber = 1;
    while (this.rooms.has(roomNumber)) {
      roomNumber++;
    }

    const slots: RoomSlot[] = [];
    for (let i = 0; i < 8; i++) {
      slots.push({
        slotIdx: i,
        occupied: false,
        open: true,
        ready: false,
        inShop: false,
        charId: 0,
        teamColor: i % 2,
        session: null,
        localPlayerIdx: 0,
        netSlotId: 0,
        user: null,
        loadedGame: false,
        alive: true,
        trapped: false,
        kills: 0,
        saves: 0,
        // Keep unknown peer routes empty. The client cannot create a peer for a zero IP or port.
        udpEndpoints: createEmptyUdpEndpoints(),
      });
    }

    const chiefNetSlotId = chiefSession.netSlotIds[0] ?? this.allocateNetSlotId();
    const room: GameRoom = {
      roomNumber,
      name: name || "CrazyArcade Room",
      password,
      hasPassword: hasPassword || password.length > 0,
      maxPlayers: 8,
      gameMode,
      gameSubMode: 0,
      mapId: 0, // Map/vet01 (or first map in CGameMapInfoList)
      mapTheme,
      chiefSlotNetId: chiefNetSlotId,
      isPlaying: false,
      randomSeed: 0x13572468,
      startTick: Date.now() >>> 0,
      slots,
    };

    this.rooms.set(roomNumber, room);
    this.assignSessionToRoom(chiefSession, room, charIds);
    return room;
  }

  public assignSessionToRoom(
    session: ClientSession,
    room: GameRoom,
    charIds: number[]
  ): number[] {
    const playerCount = Math.max(1, session.users.length);
    const assignedSlots: number[] = [];
    session.udpEndpoint = null;

    for (let p = 0; p < playerCount; p++) {
      const freeSlot = room.slots.find((s) => s.open && !s.occupied);
      if (!freeSlot) {
        break;
      }
      const user = session.users[p]!;
      const netSlotId = session.netSlotIds[p] ?? this.allocateNetSlotId();
      const charId = charIds[p] ?? session.equippedCharIds[p] ?? 0;

      freeSlot.occupied = true;
      freeSlot.ready = false;
      freeSlot.inShop = false;
      freeSlot.charId = charId;
      freeSlot.teamColor = freeSlot.slotIdx % 2;
      freeSlot.session = session;
      freeSlot.localPlayerIdx = p;
      freeSlot.netSlotId = netSlotId;
      freeSlot.user = user;
      freeSlot.loadedGame = false;
      freeSlot.udpEndpoints = createEmptyUdpEndpoints();
      freeSlot.alive = true;
      freeSlot.trapped = false;
      freeSlot.kills = 0;
      freeSlot.saves = 0;

      assignedSlots.push(freeSlot.slotIdx);
    }

    session.currentRoomNumber = room.roomNumber;
    session.roomSlotIndices = assignedSlots;
    session.stageId = 12; // CPrepareStage
    return assignedSlots;
  }

  public leaveRoom(session: ClientSession): {
    room: GameRoom | null;
    removedSlots: number[];
    roomDeleted: boolean;
  } {
    if (session.currentRoomNumber === null) {
      return { room: null, removedSlots: [], roomDeleted: false };
    }
    const room = this.rooms.get(session.currentRoomNumber) ?? null;
    session.currentRoomNumber = null;
    const removedSlots = [...session.roomSlotIndices];
    session.roomSlotIndices = [];
    session.udpEndpoint = null;
    session.stageId = 11; // CLobbyStage

    if (!room) {
      return { room: null, removedSlots, roomDeleted: false };
    }

    for (const slotIdx of removedSlots) {
      const slot = room.slots[slotIdx];
      if (slot && slot.session === session) {
        slot.occupied = false;
        slot.ready = false;
        slot.inShop = false;
        slot.session = null;
        slot.user = null;
        slot.netSlotId = 0;
        slot.loadedGame = false;
        slot.udpEndpoints = createEmptyUdpEndpoints();
      }
    }

    const remainingOccupied = room.slots.filter((s) => s.occupied && s.session !== null);
    if (remainingOccupied.length === 0) {
      this.rooms.delete(room.roomNumber);
      return { room, removedSlots, roomDeleted: true };
    }

    // Reassign chief if needed
    if (!remainingOccupied.some((s) => s.netSlotId === room.chiefSlotNetId)) {
      room.chiefSlotNetId = remainingOccupied[0]!.netSlotId;
    }

    return { room, removedSlots, roomDeleted: false };
  }

  public resetRoomUdpEndpoints(room: GameRoom): void {
    for (const slot of room.slots) {
      slot.udpEndpoints = createEmptyUdpEndpoints();
      if (slot.session) {
        slot.session.udpEndpoint = null;
      }
    }
  }

  public broadcastToRoom(
    room: GameRoom,
    buildPacket: (session: ClientSession) => PacketWriter
  ): void {
    const visitedSessions = new Set<number>();
    for (const slot of room.slots) {
      if (slot.occupied && slot.session && !visitedSessions.has(slot.session.sessionId)) {
        visitedSessions.add(slot.session.sessionId);
        slot.session.sendPacket(buildPacket(slot.session));
      }
    }
  }

  public broadcastToLobby(channelIndex: number, buildPacket: () => PacketWriter): void {
    for (const session of this.sessions.values()) {
      if (session.stageId === 11 && session.channelIndex === channelIndex) {
        session.sendPacket(buildPacket());
      }
    }
  }

  public [Symbol.dispose](): void {
    this.db.close();
  }
}
