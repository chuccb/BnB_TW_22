import type { ServerConfig } from "../config/index.ts";
import { GameDatabase, type UserRecord } from "../db/database.ts";
import { PacketSocketState, type ConnectHelloInfo } from "../protocol/framing.ts";
import type { PacketWriter } from "../protocol/primitives.ts";
import { loadClientResources, type ClientResources } from "../resources/archive.ts";

export interface ChannelInfo {
  type: number;
  number: number;
  category: string;
  name: string;
  subName: string;
  tooltip: string;
  minLv: number;
  maxLv: number;
  minGrade: number;
  maxGrade: number;
  eventFlag: number;
  isLadder: number;
  gameType: number;
  load: number;
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

export class ClientSession {
  public readonly sessionId: number;
  public readonly socketState: PacketSocketState;
  public readonly sendRaw: (bytes: Uint8Array) => void;
  public remoteAddress: string;
  public remotePort: number;

  public sessionKey: number;
  public ssdSynced = false;
  public stageId = 1; // 1 = CLoginStage, 10 = CSelectServerStage, 11 = CLobbyStage, 12 = CPrepareStage, 13 = CGameStage, 14 = CShopStageNew
  public channelIndex = 0;

  // Up to 2 local players per client (1P / 2P)
  public users: UserRecord[] = [];
  public netSlotIds: number[] = [];
  public authTokens: number[] = [];
  public equippedCharIds: number[] = [0, 1];

  public currentRoomNumber: number | null = null;
  public roomSlotIndices: number[] = [];
  public udpEndpoint: { address: string; port: number } | null = null;

  public lastPingTick = 0;
  public lastAntiHackStatus = 0;

  constructor(
    sessionId: number,
    sendRaw: (bytes: Uint8Array) => void,
    remoteAddress: string = "127.0.0.1",
    remotePort: number = 0
  ) {
    this.sessionId = sessionId;
    this.socketState = new PacketSocketState("server");
    this.sendRaw = sendRaw;
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
    this.sessionKey = (0x12340000 + (sessionId & 0xffff)) >>> 0;
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
    const frame = this.socketState.encodeConnectHello(info, 1, config.repoRoot);
    this.sendRaw(frame);
    return info;
  }

  public sendPacket(writer: PacketWriter): void {
    const frame = this.socketState.encodePacket(writer);
    this.sendRaw(frame);
  }
}

export class WorldState implements Disposable {
  public readonly config: ServerConfig;
  public readonly db: GameDatabase;
  public readonly resources: ClientResources;
  public readonly channels: ChannelInfo[];

  public readonly sessions = new Map<number, ClientSession>();
  public readonly sessionsByToken = new Map<number, { usernames: string[]; netSlotIds: number[]; charIds: number[] }>();
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

  private createDefaultChannels(): ChannelInfo[] {
    return [
      {
        type: 1,
        number: 1,
        category: "Free",
        name: "自由頻道 1",
        subName: "Free-1",
        tooltip: "適合所有玩家的自由對戰頻道",
        minLv: 1,
        maxLv: 400,
        minGrade: 0,
        maxGrade: 50,
        eventFlag: 0,
        isLadder: 0,
        gameType: 0,
        load: 15,
      },
      {
        type: 1,
        number: 2,
        category: "Free",
        name: "自由頻道 2",
        subName: "Free-2",
        tooltip: "適合所有玩家的自由對戰頻道",
        minLv: 1,
        maxLv: 400,
        minGrade: 0,
        maxGrade: 50,
        eventFlag: 0,
        isLadder: 0,
        gameType: 0,
        load: 10,
      },
      {
        type: 2,
        number: 3,
        category: "Novice",
        name: "新手頻道 1",
        subName: "Novice-1",
        tooltip: "適合初學者練習的頻道",
        minLv: 1,
        maxLv: 50,
        minGrade: 0,
        maxGrade: 20,
        eventFlag: 0,
        isLadder: 0,
        gameType: 0,
        load: 8,
      },
      {
        type: 3,
        number: 4,
        category: "Guild",
        name: "公會頻道 1",
        subName: "Guild-1",
        tooltip: "公會成員專屬對戰頻道",
        minLv: 1,
        maxLv: 400,
        minGrade: 0,
        maxGrade: 50,
        eventFlag: 0,
        isLadder: 0,
        gameType: 0,
        load: 5,
      },
    ];
  }

  public createSession(
    sendRaw: (bytes: Uint8Array) => void,
    remoteAddress: string = "127.0.0.1",
    remotePort: number = 0
  ): ClientSession {
    const id = this.nextSessionId++;
    const session = new ClientSession(id, sendRaw, remoteAddress, remotePort);
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

  public allocateAuthToken(usernames: string[], netSlotIds: number[], charIds: number[]): number {
    const token = this.nextToken++ >>> 0;
    this.sessionsByToken.set(token, {
      usernames: [...usernames],
      netSlotIds: [...netSlotIds],
      charIds: [...charIds],
    });
    return token;
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

    const defaultEndpoint: UdpEndpoint = { ip: 0x7f000001, port: this.config.udpPort };
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
        udpEndpoints: [
          { ...defaultEndpoint },
          { ...defaultEndpoint },
          { ...defaultEndpoint },
        ],
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
