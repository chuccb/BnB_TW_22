import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/index.ts";
import { dispatchTcpPacket, dispatchUdpDatagram } from "../src/handlers/dispatcher.ts";
import { CrazyArcadeServer } from "../src/network/server.ts";
import {
  buildUdpPeerData,
  buildUdpPeerProbe,
  MTUDPPeer,
  PacketSocketState,
} from "../src/protocol/framing.ts";
import { ClientOpcode, ServerOpcode, StageId } from "../src/protocol/opcodes.ts";
import { PacketReader, PacketWriter } from "../src/protocol/primitives.ts";
import { verifySmartStreamSchema } from "../src/resources/archive.ts";
import { WorldState } from "../src/state/worldState.ts";
import { clearRecentLogs, formatU8Hex, getRecentLogs } from "../src/utils/logger.ts";

type LiveTcpSocket = {
  write(bytes: Uint8Array): number;
  end(): void | number;
};

interface PacketWaiter {
  opcode: number;
  resolve(packet: PacketReader): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal real-socket client for verifying the LoginServer -> GameServer reconnect. */
class LiveTcpClient {
  public readonly socketState = new PacketSocketState("client");
  public socket: LiveTcpSocket | null = null;

  private helloReceived = false;
  private preHelloBytes = new Uint8Array(0);
  private readonly queuedPackets: PacketReader[] = [];
  private readonly waiters: PacketWaiter[] = [];
  public readonly receivedOpcodes: number[] = [];
  private resolveHello!: () => void;
  private rejectHello!: (error: Error) => void;
  private readonly helloReady = new Promise<void>((resolve, reject) => {
    this.resolveHello = resolve;
    this.rejectHello = reject;
  });

  public static async connect(port: number): Promise<LiveTcpClient> {
    const client = new LiveTcpClient();
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (connectedSocket) => {
          client.socket = connectedSocket;
        },
        data: (_connectedSocket, chunk) => client.onData(chunk),
        error: (_connectedSocket, error) => client.fail(error),
        connectError: (_connectedSocket, error) => client.fail(error),
      },
    });
    client.socket = socket;
    await client.helloReady;
    return client;
  }

  public send(writer: PacketWriter): void {
    if (!this.helloReceived || !this.socket) {
      throw new Error("Cannot send before the ConnectHello handshake completes");
    }
    this.socket.write(this.socketState.encodePacket(writer));
  }

  public waitForOpcode(opcode: number, timeoutMs = 5000): Promise<PacketReader> {
    const queuedIndex = this.queuedPackets.findIndex((packet) => packet.opcode === opcode);
    if (queuedIndex >= 0) {
      return Promise.resolve(this.queuedPackets.splice(queuedIndex, 1)[0]!);
    }

    return new Promise((resolve, reject) => {
      const waiter: PacketWaiter = {
        opcode,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for S->C opcode ${opcode}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  public hasQueuedOpcode(opcode: number): boolean {
    return this.queuedPackets.some((packet) => packet.opcode === opcode);
  }

  public close(): void {
    this.socket?.end();
    this.socket = null;
  }

  private onData(chunk: Uint8Array | ArrayBuffer): void {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (!this.helloReceived) {
      const merged = new Uint8Array(this.preHelloBytes.length + bytes.length);
      merged.set(this.preHelloBytes);
      merged.set(bytes, this.preHelloBytes.length);
      this.preHelloBytes = merged;
      if (merged.length < 3) return;

      const length = new DataView(merged.buffer, merged.byteOffset, merged.byteLength).getUint16(1, false);
      const frameLength = 3 + length;
      if (merged.length < frameLength) return;

      this.socketState.decodeConnectHello(merged.subarray(0, frameLength));
      this.helloReceived = true;
      this.resolveHello();
      const remainder = merged.subarray(frameLength).slice();
      this.preHelloBytes = new Uint8Array(0);
      if (remainder.length > 0) this.decodePackets(remainder);
      return;
    }

    this.decodePackets(bytes);
  }

  private decodePackets(bytes: Uint8Array): void {
    for (const packet of this.socketState.feed(bytes)) {
      this.receivedOpcodes.push(packet.opcode);
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.opcode === packet.opcode);
      if (waiterIndex < 0) {
        this.queuedPackets.push(packet);
        continue;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(packet);
    }
  }

  private fail(error: Error): void {
    if (!this.helloReceived) this.rejectHello(error);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

class SimulatedClient {
  public readonly socketState = new PacketSocketState("client");
  public readonly receivedPackets: PacketReader[] = [];
  public helloReceived = false;

  public onWireBytes = (bytes: Uint8Array): void => {
    if (!this.helloReceived) {
      this.socketState.decodeConnectHello(bytes);
      this.helloReceived = true;
      return;
    }
    const decoded = this.socketState.feed(bytes);
    this.receivedPackets.push(...decoded);
  };

  public sendToServer(state: WorldState, sessionId: number, writer: PacketWriter): void {
    const session = state.sessions.get(sessionId)!;
    const wireFrame = this.socketState.encodePacket(writer);
    const decoded = session.socketState.feed(wireFrame);
    for (const pkt of decoded) {
      dispatchTcpPacket(state, session, pkt);
    }
  }

  public popByOpcode(opcode: number): PacketReader | undefined {
    const idx = this.receivedPackets.findIndex((p) => p.opcode === opcode);
    if (idx === -1) {
      return undefined;
    }
    const [pkt] = this.receivedPackets.splice(idx, 1);
    return pkt;
  }
}

describe("End-to-End Playable Loop — Login -> Channel -> Lobby -> Room -> Match -> Result -> Shop", () => {
  test("Taiwan default endpoints match the client topology", () => {
    const config = loadConfig();
    expect(config.tcpPort).toBe(3838);
    expect(config.udpPort).toBe(config.tcpPort + 1);
    expect(config.gameTcpPort).toBe(9339);
    expect(config.gameUdpPort).toBe(config.gameTcpPort + 1);
  });

  test("Full 2-player playable loop across all client stages and exact CA.exe opcodes", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:", publicIp: "198.51.100.28" });
    using state = new WorldState(config);

    const client1 = new SimulatedClient();
    const session1 = state.createSession(client1.onWireBytes, "127.0.0.1", 51001);
    session1.sendConnectHello(config);
    expect(client1.helloReceived).toBe(true);
    expect(client1.socketState.degree).toBe(3);

    // 1. Pre-login SSD Check (`C->S 0`, `sub_5A1E40`). The first field is the
    //    dynamic-image cache context (zero after this flow's `extraFlag=0` ConnectHello),
    //    followed by simulated matching values for csysstr, multisvr, filterstr and multisvrn.
    //    Matching values -> `hasStream = 0`.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.PreLoginSsdCheck)
        .writeU32(0) // dword_92AAF8[2], fresh dynamic-image context sentinel
        .writeU32(0xe734d04f) // csysstr.ssd
        .writeU32(state.resources.ssdFiles.multisvr.adler32Zero) // multisvr.ssd
        .writeU32(0x000e496d) // filterstr.ssd
        .writeU32(state.resources.ssdFiles.multisvrn.adler32Zero) // multisvrn.ssd
    );
    expect(client1.popByOpcode(ServerOpcode.DynamicImgInfoSsd)?.readU8()).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.SystemStringSsd)?.readU8()).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.MultiServerSsd)?.readU8()).toBe(0);
    const p53 = client1.popByOpcode(ServerOpcode.FilterStringSsd)!;
    expect(p53).toBeDefined();
    expect(p53.readU8()).toBe(0);
    expect(p53.readU8()).toBe(0);

    //    Now test when client has stale/missing `.ssd` files (`checksum = 1`) -> server streams all 5 `.ssd` files (`hasStream = 1`)!
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.PreLoginSsdCheck)
        .writeU32(1) // mismatch fxdynimginfo.ssd
        .writeU32(1) // mismatch csysstr.ssd
        .writeU32(1) // mismatch multisvr.ssd
        .writeU32(1) // mismatch filterstr.ssd
        .writeU32(1) // mismatch multisvrn.ssd
    );
    const p189Stream = client1.popByOpcode(ServerOpcode.DynamicImgInfoSsd)!;
    expect(p189Stream.readU8()).toBe(1);
    const fxdynimgStream = p189Stream.readSmartStream();
    expect(verifySmartStreamSchema("fxdynimginfo.ssd", fxdynimgStream.bytes)).toEqual({
      entryCount: 8,
      remaining: 0,
    });

    const p2Stream = client1.popByOpcode(ServerOpcode.SystemStringSsd)!;
    expect(p2Stream.readU8()).toBe(1);
    const csysstrStream = p2Stream.readSmartStream();
    expect(verifySmartStreamSchema("csysstr.ssd", csysstrStream.bytes)).toEqual({
      entryCount: 5335,
      remaining: 0,
    });

    const p1Stream = client1.popByOpcode(ServerOpcode.MultiServerSsd)!;
    expect(p1Stream.readU8()).toBe(1); // hasMultiSvr = 1
    const multisvrStream = p1Stream.readSmartStream();
    expect(verifySmartStreamSchema("multisvr.ssd", multisvrStream.bytes).remaining).toBe(0);
    expect(p1Stream.readU8()).toBe(1); // hasMultiSvrn = 1
    const multisvrnStream = p1Stream.readSmartStream();
    expect(verifySmartStreamSchema("multisvrn.ssd", multisvrnStream.bytes).remaining).toBe(0);

    const p53Stream = client1.popByOpcode(ServerOpcode.FilterStringSsd)!;
    expect(p53Stream.readU8()).toBe(1);
    const filterstrStream = p53Stream.readSmartStream();
    expect(verifySmartStreamSchema("filterstr.ssd", filterstrStream.bytes)).toEqual({
      entryCount: 30,
      remaining: 0,
    });
    expect(p53Stream.readU8()).toBe(0); // extraCount = 0

    // A non-sentinel custom multisvr CRC indicates the client edited its local server list;
    // the LoginServer must not overwrite that file with its generated localhost entry.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.PreLoginSsdCheck)
        .writeU32(state.resources.ssdFiles.fxdynimginfo.adler32Zero)
        .writeU32(state.resources.ssdFiles.csysstr.adler32Zero)
        .writeU32(0x12345678)
        .writeU32(state.resources.ssdFiles.filterstr.adler32Zero)
        .writeU32(state.resources.ssdFiles.multisvrn.adler32Zero)
    );
    expect(client1.popByOpcode(ServerOpcode.DynamicImgInfoSsd)?.readU8()).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.SystemStringSsd)?.readU8()).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.MultiServerSsd)?.readU8()).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.FilterStringSsd)?.readU8()).toBe(0);

    // Legacy INI checks (C->S 252, 267, 294, 305)
    client1.sendToServer(state, session1.sessionId, new PacketWriter(252).writeU32(0xdcec1a37));
    expect(client1.popByOpcode(157)?.readU8()).toBe(0);
    client1.sendToServer(state, session1.sessionId, new PacketWriter(267));
    expect(client1.popByOpcode(163)?.readString()).toContain("http");
    client1.sendToServer(state, session1.sessionId, new PacketWriter(294).writeU32(0x6683b836));
    expect(client1.popByOpcode(179)?.readU8()).toBe(0);
    client1.sendToServer(state, session1.sessionId, new PacketWriter(305).writeU32(0xb5c71db3));
    expect(client1.popByOpcode(188)?.readU8()).toBe(0);

    // 2. Account ID Check (C->S 16 -> S->C 59) & Register (C->S 18 -> S->C 61)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(16).writeString("bazzi_tw")
    );
    expect(client1.popByOpcode(59)?.readU8()).toBe(0); // Available

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(18).writeString("bazzi_tw").writeString("pass123")
    );
    expect(client1.popByOpcode(61)?.readU8()).toBe(0); // Registered

    // 3. Login via C->S 2 (with 0x11223344 & 0x44332211 keyed strings) -> S->C 4 (sub_567461)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(2)
        .writeU8(1)
        .writeKeyedString("bazzi_tw", 0x11223344)
        .writeKeyedString("pass123", 0x44332211)
        .writeBlock(new Uint8Array(16))
        .writeU32(0)
    );
    const p4 = client1.popByOpcode(4)!;
    expect(p4).toBeDefined();
    expect(p4.readU8()).toBe(0); // errCode = 0
    expect(p4.readU16()).toBe(1); // worldId = 1
    expect(p4.readU8()).toBe(1); // 1 local player
    const lucci1 = p4.readU32();
    expect(lucci1).toBe(50000);
    expect(p4.readU32()).toBe(0); // wins
    expect(p4.readU32()).toBe(0); // losses
    const token1 = p4.readU32();
    expect(p4.readString()).toBe("bazzi_tw");
    const loggedInUser = state.db.getUserByUsername("bazzi_tw")!;
    expect(p4.readU8()).toBe(loggedInUser.gender);
    expect(p4.readU32()).toBe(1); // isRegisteredFlag = 1
    expect(p4.readString()).toBe(loggedInUser.nickname || loggedInUser.username);
    expect(p4.readU32()).toBe(loggedInUser.exp);
    p4.readU8(); // separate post-exp field parsed by `sub_561F62`, not the level-gate value
    const loginResultGateLevel = p4.readU16(); // `sub_5ED30E` -> `sub_5ED43B`
    expect(loggedInUser.level).toBe(1);
    expect(loggedInUser.rankFlag).toBe(0);
    expect(loginResultGateLevel).toBe(loggedInUser.level);

    // 4. Post-login Channel List Request (C->S 9 -> S->C 10 `channel2_001.ssd`, 12, 11)
    client1.sendToServer(state, session1.sessionId, new PacketWriter(9).writeU32(0));
    const p10 = client1.popByOpcode(10)!;
    expect(p10).toBeDefined();
    expect(p10.readU8()).toBe(1); // hasStream = 1
    const chStream = p10.readSmartStream();
    expect(verifySmartStreamSchema("channel2_001.ssd", chStream.bytes).remaining).toBe(0);
    expect(chStream.readU16()).toBe(4); // u16 channelCount (`CChannelCache::sub_5D3D3F`)
    const channelRecords = Array.from({ length: 4 }, () => {
      const record = {
        name: chStream.readString(),
        maxUsers: chStream.readU16(),
        badgeId: chStream.readU8(),
        categoryCode: chStream.readU8(),
        channelFlags: chStream.readU16(),
        restrictionFlags: chStream.readU8(),
        tabIndex: chStream.readU8(),
        minGrade: chStream.readU8(),
        maxGrade: chStream.readU8(),
        minLevel: chStream.readU16(),
        maxLevel: chStream.readU16(),
      };
      expect(record.maxUsers).toBeGreaterThan(0);
      expect(record.categoryCode).toBe(10);
      return record;
    });
    expect(channelRecords.map((record) => record.tabIndex)).toEqual([0, 1, 2, 3]);
    expect(channelRecords[0]?.badgeId).toBe(2); // `sub_56CE10` auto-selects Novice for eligible players
    expect(channelRecords.map((record) => record.minLevel)).toEqual([1, 1, 1, 1]); // Preserve fallback minima; these are not official channel data.
    expect(loginResultGateLevel).toBeGreaterThanOrEqual(channelRecords[0]!.minLevel);
    expect(chStream.remaining()).toBe(0);
    const p12 = client1.popByOpcode(ServerOpcode.ChannelLoads)!;
    expect(p12.readU16()).toBe(4);
    expect([p12.readU16(), p12.readU16(), p12.readU16(), p12.readU16()]).toEqual([0, 0, 0, 0]);
    expect(client1.popByOpcode(ServerOpcode.MessengerHandoff)).toBeDefined();
    expect(session1.stageId).toBe(StageId.SelectServer);

    // 5. Select Channel (C->S 5 -> S->C 7) & Session Auth Handoff (C->S 6 -> S->C 33, 75)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.SelectChannel).writeU8(10).writeU32(0)
    );
    const p7 = client1.popByOpcode(ServerOpcode.ChannelSelectResult)!;
    expect(p7.readU8()).toBe(1); // success; 0 maps to ErrCannotConnect in `sub_56C0C8`
    expect(p7.readU8()).toBe(10); // normalized channel category (`sub_5D4071`)
    expect(p7.readU32()).toBe(0); // category-relative ordinal (`sub_5D40F5`)
    expect(p7.readU32()).toBe(0xc633641c); // PUBLIC_IP, distinct from the local bind address
    expect(p7.readU16()).toBe(9339); // GameServer TCP, not LoginServer TCP

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(6).writeU8(1).writeString("bazzi_tw").writeU32(token1)
    );
    expect(client1.popByOpcode(ServerOpcode.SessionHandoffAck)?.readU8()).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.StageTransition)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.QuestConfigSync)?.readU32()).toBe(0);
    expect(session1.stageId).toBe(StageId.Lobby);

    // `CStage::sub_4B94A6` may request channel data again after reconnect. On the
    // GameServer/Lobby session this is not a second LoginServer handoff.
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.RequestChannelList).writeU32(0));
    expect(client1.popByOpcode(ServerOpcode.ChannelListSsd)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.ChannelLoads)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.MessengerHandoff)).toBeUndefined();

    // 5b. Post-stage-sync C->S 338 -> S->C 207 (`sub_4BCABF`) -> C->S 282 (`sub_4DD5D3`) -> S->C 205 (`sub_4E0131` `fxdynmapinfo.ssd`)
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.PostStageSync338).writeU8(1));
    const p207 = client1.popByOpcode(ServerOpcode.DynamicMapAndStageConfig)!;
    expect(p207).toBeDefined();
    expect(p207.readU8()).toBe(1);
    expect(p207.readU32()).toBe(state.resources.ssdFiles.fxdynmapinfo.adler32Zero);

    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.RequestDynamicMapInfoSsd));
    const p205 = client1.popByOpcode(ServerOpcode.DynamicMapInfoSsdStream)!;
    expect(p205).toBeDefined();
    const dynMapStream = p205.readSmartStream();
    expect(verifySmartStreamSchema("fxdynmapinfo.ssd", dynMapStream.bytes)).toEqual({
      entryCount: 871,
      remaining: 0,
    });

    // 6. Enter Lobby (C->S 83 -> S->C 89, 186, 194, 196, 268, 250) & User Info Query (C->S 70 -> S->C 70 + S->C 81)
    client1.sendToServer(state, session1.sessionId, new PacketWriter(83));
    expect(client1.popByOpcode(89)).toBeDefined();
    expect(client1.popByOpcode(186)).toBeDefined();
    const p194_init = client1.popByOpcode(ServerOpcode.InventoryData)!;
    expect(p194_init).toBeDefined();
    expect(p194_init.readU8()).toBe(1); // playerCount = 1
    expect(p194_init.readI32()).toBeGreaterThanOrEqual(1); // starter inventory item
    expect(p194_init.readU32()).toBe(1001); // stockId = 1001
    expect(client1.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.InventoryExpansionSlots)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.CoupleInfoSync)).toBeDefined();

    const lobbyInitLog = getRecentLogs().findLast((entry) => entry.category === "LobbyInit");
    expect(lobbyInitLog?.data?.playerCount).toBe(1);
    expect(lobbyInitLog?.data?.serverOpcodes).toEqual([
      "89 (ExpSync)",
      "186 (LucciSync)",
      "194 (InventoryData)",
      "196 (EquippedAvatarData)",
      "268 (InventoryExpansionSlots)",
      "250 (CoupleInfoSync)",
    ]);
    const lobbyPlayerFields = lobbyInitLog?.data?.playerFields as
      | Record<string, unknown>
      | undefined;
    expect(lobbyPlayerFields?.expValueIn89).toBe(loggedInUser.exp);
    expect(lobbyPlayerFields?.opcode186WireU32Values).toEqual([0, loggedInUser.lucci]);
    expect(lobbyPlayerFields?.opcode186SecondU32LowByte).toBe(formatU8Hex(loggedInUser.lucci));

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(70).writeU8(0).writeString("bazzi_tw")
    );
    const p70 = client1.popByOpcode(70)!;
    expect(p70).toBeDefined();
    expect(p70.readU32()).toBe(1);
    expect(p70.readU32()).toBe(1);
    expect(p70.readU8()).toBe(0);
    expect(p70.readString()).toBe("bazzi_tw");
    const p81 = client1.popByOpcode(81)!;
    expect(p81).toBeDefined();
    expect(p81.readString()).toBe("bazzi_tw");

    // 7. Create Room (C->S 75 -> S->C 79 sub_4C244A + S->C 102 sub_4D67B5)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(75)
        .writeString("TW Battle Room")
        .writeString("")
        .writeU8(0)
        .writeU8(1)
        .writeU8(0)
        .writeU8(0)
        .writeU32(0)
    );
    const p79 = client1.popByOpcode(79)!;
    expect(p79).toBeDefined();
    expect(p79.readU8()).toBe(0); // errCode = 0
    const roomNum = p79.readU16();
    expect(roomNum).toBe(1);
    expect(client1.popByOpcode(102)).toBeDefined(); // Full room snapshot S->C 102
    expect(session1.stageId).toBe(StageId.Prepare);

    // 8. Second player logs in and joins Room #1 (C->S 76 -> S->C 80 + S->C 102 + S->C 100 to Chief)
    const client2 = new SimulatedClient();
    const session2 = state.createSession(client2.onWireBytes, "127.0.0.1", 51002);
    session2.sendConnectHello(config);
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(31).writeU8(0).writeString("dao_tw")
    );
    expect(client2.popByOpcode(4)?.readU8()).toBe(0);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(76).writeU16(roomNum).writeU32(0xffffffff).writeU8(0).writeU8(1).writeU8(2)
    );
    const p80 = client2.popByOpcode(80)!;
    expect(p80).toBeDefined();
    expect(p80.readU8()).toBe(0); // Join success
    expect(client2.popByOpcode(102)).toBeDefined(); // Full room snapshot to joiner
    expect(session2.stageId).toBe(StageId.Prepare);
    expect(client1.popByOpcode(102)).toBeDefined(); // S->C 102 (`CSetPlayerOnPreparePacket`) to Chief

    // 9. Room interactions (CPrepareStage::sub_4DCF07)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(87).writeU16(5).writeU32(0)
    );
    expect(client1.popByOpcode(109)?.readU16()).toBe(5);
    expect(client2.popByOpcode(109)?.readU16()).toBe(5);

    client1.sendToServer(state, session1.sessionId, new PacketWriter(88).writeU8(0x01)); // localIdx=0, team=1
    expect(client1.popByOpcode(105)).toBeDefined();
    expect(client2.popByOpcode(105)).toBeDefined();
    client1.popByOpcode(104);
    client2.popByOpcode(104);

    client1.sendToServer(state, session1.sessionId, new PacketWriter(89).writeU8(0).writeU8(1));
    expect(client1.popByOpcode(106)).toBeDefined();
    expect(client2.popByOpcode(106)).toBeDefined();
    client1.popByOpcode(104);
    client2.popByOpcode(104);

    // Player 2 toggles Ready (C->S 86: [u8 ready, u32 mapCrc]) -> S->C 104
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(86).writeU8(1).writeU32(0)
    );
    expect(client1.popByOpcode(104)).toBeDefined();
    expect(client2.popByOpcode(104)).toBeDefined();

    // Normal Chat (C->S 16 -> S->C 21) & Whisper (C->S 20 -> S->C 23 + S->C 24)
    client1.sendToServer(state, session1.sessionId, new PacketWriter(16).writeString("Ready?"));
    expect(client1.popByOpcode(21)?.readString()).toBe("bazzi_tw : Ready?");
    expect(client2.popByOpcode(21)?.readString()).toBe("bazzi_tw : Ready?");

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(20).writeString("dao_tw").writeString("GLHF!")
    );
    expect(client1.popByOpcode(24)?.readU8()).toBe(1); // delivered
    expect(client2.popByOpcode(23)?.readString()).toBe("bazzi_tw : GLHF!");

    // 9b. CExchangeStage (`C->S 101` pass check -> `S->C 130` + `S->C 126`, `C->S 100` offer items -> `S->C 128` + `S->C 126`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ExchangePassCheck).writeString("pass123")
    );
    expect(client1.popByOpcode(ServerOpcode.ExchangePassResult)?.readU8()).toBe(1);
    const p126_unlock = client1.popByOpcode(ServerOpcode.ExchangeState)!;
    expect(p126_unlock.readU8()).toBe(2); // state = 2 (unlocked)
    expect(p126_unlock.readU8()).toBe(1); // msgId = 1 ("ExUnlocked")
    expect(p126_unlock.readString()).toBe("bazzi_tw");
    client2.popByOpcode(ServerOpcode.ExchangeState);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ExchangeAction)
        .writeU8(3) // state = 3 (offer items)
        .writeU32(10000) // lucci
        .writeU8(1) // 1 item
        .writeU32(2005)
        .writeSystemTime()
    );
    const p128 = client2.popByOpcode(ServerOpcode.ExchangeItems)!;
    expect(p128).toBeDefined();
    expect(p128.readU8()).toBe(0); // slotIdx = 0
    expect(p128.readU32()).toBe(10000);
    expect(p128.readU8()).toBe(1);
    expect(p128.readU32()).toBe(2005);
    expect(p128.readSystemTime().getUTCFullYear()).toBeGreaterThanOrEqual(2020);
    client1.popByOpcode(ServerOpcode.ExchangeItems);
    client1.popByOpcode(ServerOpcode.ExchangeState);
    client2.popByOpcode(ServerOpcode.ExchangeState);

    // 10. Chief starts match (C->S 93 -> S->C 112 sub_4D4D61 + S->C 113 sub_4D9F8A)
    client1.sendToServer(state, session1.sessionId, new PacketWriter(93));
    expect(client1.popByOpcode(112)?.readU8()).toBe(0);
    const p113_1 = client1.popByOpcode(113)!;
    const p113_2 = client2.popByOpcode(113)!;
    expect(p113_1).toBeDefined();
    expect(p113_2).toBeDefined();
    expect(session1.stageId).toBe(StageId.Game);
    expect(session2.stageId).toBe(StageId.Game);

    // Verify S->C 113 payload (`CPrepareStage::sub_4D9F8A`)
    const seed = p113_1.readU32();
    expect(seed).toBe(0x13572468);
    expect(p113_1.readU16()).toBe(5); // mapId = 5
    const mapFolder = p113_1.readString();
    expect(mapFolder.length).toBeGreaterThan(0);

    // 11. Client 1 registers load via 36B UDP opcode 1 (`sub_4ED400`) & Client 2 via TCP C->S 113
    //     -> Both receive S->C 136 (`sub_4EA206`) and S->C 135 (`sub_4F2065`)
    const udpLoadInner = new Uint8Array(36);
    const loadDv = new DataView(udpLoadInner.buffer);
    loadDv.setUint16(0, 1, false); // opcode = 1
    loadDv.setUint32(2, session1.users[0]!.id, false); // userId
    loadDv.setUint16(6, roomNum, false); // roomId
    loadDv.setUint32(8, 0x13572468, false); // roomGameKey
    loadDv.setUint32(12, 0xc0a80119, false); // client-local ip0 = 192.168.1.25
    loadDv.setUint16(16, 56002, false); // client-local port0
    dispatchUdpDatagram(state, MTUDPPeer.encodeFrame(udpLoadInner), "203.0.113.52", 55001);
    expect(client1.popByOpcode(136)?.readU8()).toBe(0);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(113).writeU8(1).writeU8(0)
    );
    expect(client2.popByOpcode(136)).toBeDefined();
    const p135_1 = client1.popByOpcode(135)!;
    const p135_2 = client2.popByOpcode(135)!;
    expect(p135_1).toBeDefined();
    expect(p135_2).toBeDefined();

    const readPeerSetup = (packet: PacketReader, expectedPrimarySlot: number) => {
      packet.readU32(); // startSeed
      expect(packet.readU32()).toBe(180_000);
      expect(packet.readU32()).toBe(120);
      expect(packet.readU32()).toBe(150);
      expect(packet.readU32()).toBe(0);
      expect(packet.readU8()).toBe(1); // 30 FPS
      expect(packet.readU32()).toBe(0xc633641c); // configured PUBLIC_IP, not bind HOST
      expect(packet.readU16()).toBe(config.gameUdpPort);
      expect(packet.readU8()).toBe(expectedPrimarySlot);

      const slots: Array<Array<{ ip: number; port: number }> | null> = [];
      for (let slotIdx = 0; slotIdx < 10; slotIdx++) {
        const isPresent = packet.readU8();
        if (isPresent === 0) {
          slots.push(null);
          continue;
        }
        slots.push(
          Array.from({ length: 3 }, () => ({
            ip: packet.readU32(),
            port: packet.readU16(),
          }))
        );
      }
      expect(packet.remaining).toBe(0);
      return slots;
    };

    const peerSlots1 = readPeerSetup(p135_1, 0);
    const peerSlots2 = readPeerSetup(p135_2, 1);
    const expectedRegisteredEndpoints = [
      { ip: 0xc0a80119, port: 56002 }, // client-advertised local interface
      { ip: 0, port: 0 }, // absent second interface remains absent
      { ip: 0xcb007134, port: 55001 }, // UDP source observed by the server
    ];
    expect(peerSlots1[0]).toEqual(expectedRegisteredEndpoints);
    expect(peerSlots2[0]).toEqual(expectedRegisteredEndpoints);
    expect(peerSlots1[1]).toEqual([
      { ip: 0, port: 0 },
      { ip: 0, port: 0 },
      { ip: 0, port: 0 },
    ]); // no UDP registration was available for the second client
    expect(peerSlots2[1]).toEqual(peerSlots1[1]);
    expect(peerSlots1.slice(2)).toEqual(Array(8).fill(null));
    expect(peerSlots2.slice(2)).toEqual(Array(8).fill(null));

    // 12. Reconstructed UDP keepalive: 6B `[u16(0), u32(userId)]` -> 1B `[u8(4)]`; production cadence is unverified.
    const keepaliveInner = new Uint8Array(6);
    new DataView(keepaliveInner.buffer).setUint32(2, session1.users[0]!.id, false);
    const keepaliveReplies = dispatchUdpDatagram(
      state,
      MTUDPPeer.encodeFrame(keepaliveInner),
      "203.0.113.52",
      55001
    );
    expect(keepaliveReplies.length).toBe(1);
    const keepaliveAck = MTUDPPeer.decodeFrame(keepaliveReplies[0]!.datagram)!;
    expect(Array.from(keepaliveAck)).toEqual([4]);

    // CUDPPeerClient::sub_5EC195 probe `[0, 0, localPeerIdx]` -> reconstructed `[0, 1, localPeerIdx]` reply.
    const peerProbeReplies = dispatchUdpDatagram(
      state,
      buildUdpPeerProbe(0),
      "203.0.113.52",
      55001
    );
    expect(peerProbeReplies).toHaveLength(1);
    const peerProbeReplyInner = MTUDPPeer.decodeFrame(peerProbeReplies[0]!.datagram)!;
    expect(Array.from(peerProbeReplyInner)).toEqual([0, 1, 0]);
    const companionProbe = MTUDPPeer.decodeFrame(buildUdpPeerProbe(2, 1))!;
    expect(Array.from(companionProbe)).toEqual([0, 1, 2]); // CUDPPeerClient::sub_5EC1FF shape

    // Register player 2's UDP route so the following check covers byte-for-byte GameServer peer relay.
    while (client1.popByOpcode(ServerOpcode.PlayerLoadedAck)) {}
    while (client2.popByOpcode(ServerOpcode.PlayerLoadedAck)) {}
    const udpLoadInner2 = new Uint8Array(36);
    const loadDv2 = new DataView(udpLoadInner2.buffer);
    loadDv2.setUint16(0, 1, false);
    loadDv2.setUint32(2, session2.users[0]!.id, false);
    loadDv2.setUint16(6, roomNum, false);
    loadDv2.setUint32(8, 0x13572468, false);
    loadDv2.setUint32(12, 0xc0a8011a, false); // 192.168.1.26
    loadDv2.setUint16(16, 56003, false);
    dispatchUdpDatagram(
      state,
      MTUDPPeer.encodeFrame(udpLoadInner2),
      "203.0.113.53",
      55002
    );
    expect(session2.udpEndpoint).toEqual({ address: "203.0.113.53", port: 55002 });
    const player1LoadAcks: number[] = [];
    const player2LoadAcks: number[] = [];
    for (
      let ack = client1.popByOpcode(ServerOpcode.PlayerLoadedAck);
      ack;
      ack = client1.popByOpcode(ServerOpcode.PlayerLoadedAck)
    ) {
      player1LoadAcks.push(ack.readU8());
    }
    for (
      let ack = client2.popByOpcode(ServerOpcode.PlayerLoadedAck);
      ack;
      ack = client2.popByOpcode(ServerOpcode.PlayerLoadedAck)
    ) {
      player2LoadAcks.push(ack.readU8());
    }
    expect(player1LoadAcks).toContain(1);
    expect(player2LoadAcks).toContain(1);
    const updatedPeerSlots1 = readPeerSetup(
      client1.popByOpcode(ServerOpcode.AllPlayersLoadedStart)!,
      0
    );
    const updatedPeerSlots2 = readPeerSetup(
      client2.popByOpcode(ServerOpcode.AllPlayersLoadedStart)!,
      1
    );
    const expectedPlayer2Endpoints = [
      { ip: 0xc0a8011a, port: 56003 },
      { ip: 0, port: 0 },
      { ip: 0xcb007135, port: 55002 },
    ];
    expect(updatedPeerSlots1[1]).toEqual(expectedPlayer2Endpoints);
    expect(updatedPeerSlots2[1]).toEqual(expectedPlayer2Endpoints);

    const peerGameplayPayload = new PacketWriter(0, 0)
      .writeU8(0)
      .writeU16(0x0102)
      .writeU16(0x0304)
      .writeU8(1);
    const peerDataDatagram = buildUdpPeerData(0, peerGameplayPayload);
    const peerDataInner = MTUDPPeer.decodeFrame(peerDataDatagram)!;
    expect(Array.from(peerDataInner.subarray(0, 2))).toEqual([1, 0]);
    expect(Array.from(peerDataInner.subarray(2))).toEqual(
      Array.from(peerGameplayPayload.toPayload())
    );
    const relayedPeerDatagrams = dispatchUdpDatagram(
      state,
      peerDataDatagram,
      "203.0.113.52",
      55001
    );
    expect(relayedPeerDatagrams).toHaveLength(1);
    expect(relayedPeerDatagrams[0]).toMatchObject({
      address: "203.0.113.53",
      port: 55002,
    });
    expect(Array.from(relayedPeerDatagrams[0]!.datagram)).toEqual(
      Array.from(peerDataDatagram)
    );

    // 13. In-game TCP events (`CGameStage::sub_4F672F`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(107).writeU8(0).writeU8(7).writeU8(6).writeU8(3).writeU8(0)
    );
    expect(client1.popByOpcode(138)).toBeDefined();
    expect(client2.popByOpcode(138)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(109).writeU8(0).writeU8(1)
    );
    expect(client1.popByOpcode(137)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(127).writeU8(1).writeU8(5).writeU8(5)
    );
    expect(client1.popByOpcode(149)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(110).writeU8(2).writeU8(0).writeU8(5).writeU8(5).writeU8(5).writeU8(6)
    );
    expect(client1.popByOpcode(140)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(111).writeU8(0).writeU8(1).writeU8(5).writeU8(5).writeU8(1)
    );
    expect(client1.popByOpcode(141)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(112).writeU8(0).writeU8(5).writeU8(5)
    );
    expect(client1.popByOpcode(142)).toBeDefined();

    // Extended CGameStage (`sub_4F672F`) opcodes: `118, 121..125, 128..144, 149, 153`
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.BomberSpecialAction)
        .writeU8(0)
        .writeU8(2)
        .writeU8(3)
        .writeU8(4)
        .writeU8(0)
        .writeU8(0)
    );
    expect(client2.popByOpcode(ServerOpcode.SpecialTileEffect)?.readU8()).toBe(3);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.PushBomb).writeU8(0x10).writeU8(3).writeU8(4)
    );
    expect(client2.popByOpcode(ServerOpcode.ThrowBombBroadcast)?.readU8()).toBe(0x10);

    while (client2.popByOpcode(ServerOpcode.NormalChat)) {
      // drain earlier room/lobby chat packets
    }
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.InGameBubbleChat).writeU8(0).writeString("Watch out!")
    );
    const p21Bubble = client2.popByOpcode(ServerOpcode.NormalChat)!;
    expect(p21Bubble).toBeDefined();
    expect(p21Bubble.readString()).toContain("Watch out!");
    expect(p21Bubble.readU8()).toBe(0);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ThrowBombAction).writeU8(5).writeU8(6).writeU8(0x02)
    );
    expect(client2.popByOpcode(ServerOpcode.BombThrownBroadcast)?.readU8()).toBe(1);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.BomberReviveOrGhost).writeU8(0).writeU8(0).writeU8(0).writeU8(0)
    );
    expect(client2.popByOpcode(ServerOpcode.BomberRevived)?.readU8()).toBe(0);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.PickupMapItem).writeU8(0).writeU8(6).writeU8(6)
    );
    expect(client2.popByOpcode(ServerOpcode.DestroyTileBroadcast)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.DestroyTilesBatch)
        .writeU8(1)
        .writeU16(0)
        .writeU16(0)
        .writeU8(0)
        .writeU16(0)
        .writeU8(4)
        .writeU8(4)
    );
    expect(client2.popByOpcode(ServerOpcode.SpawnMapItemsBroadcast)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.SyncGameObjectUpdate)
        .writeU16(10)
        .writeBlock(new Uint8Array(20))
    );
    expect(client2.popByOpcode(ServerOpcode.SyncObjectUpdate)?.readU16()).toBe(10);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.SyncGameObjectEvent).writeU16(10).writeU32(99)
    );
    expect(client2.popByOpcode(ServerOpcode.SyncObjectRemove)?.readU16()).toBe(10);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.TriggerRemoteBomb).writeU8(0).writeU8(2).writeU8(1)
    );
    expect(client2.popByOpcode(ServerOpcode.PickUpItemBroadcast)?.readU8()).toBe(0);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.PlayerTrappedInBalloon).writeU8(0)
    );
    expect(client2.popByOpcode(ServerOpcode.BomberTrapped)?.readU8()).toBe(0);

    // CUDPPeerMan::sub_57BEF6 sends exactly one `u8 peerIdx`; S->C 125 carries the same index.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestUdpRelay).writeU8(1)
    );
    const fallbackNotice1 = client1.popByOpcode(ServerOpcode.UdpRelayFallback)!;
    const fallbackNotice2 = client2.popByOpcode(ServerOpcode.UdpRelayFallback)!;
    expect(fallbackNotice1.readU8()).toBe(1);
    expect(fallbackNotice1.remaining).toBe(0);
    expect(fallbackNotice2.readU8()).toBe(1);
    expect(fallbackNotice2.remaining).toBe(0);

    // Reject malformed lengths and indexes the client-side sub_5ECBF0 cannot mark.
    for (const malformed of [
      new PacketWriter(ClientOpcode.RequestUdpRelay),
      new PacketWriter(ClientOpcode.RequestUdpRelay).writeU8(1).writeU8(2),
      new PacketWriter(ClientOpcode.RequestUdpRelay).writeU8(12),
    ]) {
      client1.sendToServer(state, session1.sessionId, malformed);
      expect(client1.popByOpcode(ServerOpcode.UdpRelayFallback)).toBeUndefined();
      expect(client2.popByOpcode(ServerOpcode.UdpRelayFallback)).toBeUndefined();
    }

    // 14. Player 2 trapped (`sub_4EA4EE` C->S 113 subType=2) then killed by Player 1 (subType=4, killer=0)
    //     -> S->C 144 (`sub_4F267E`), S->C 148 (`sub_4F2F8B` scoreboard), S->C 153 (`sub_4F2D1A` return to Stage 12)
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(113)
        .writeU8((2 << 4) | 1)
        .writeU16(200)
        .writeU16(200)
    );
    expect(client1.popByOpcode(144)).toBeDefined();

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(113)
        .writeU8((4 << 4) | 1)
        .writeU16(200)
        .writeU16(200)
        .writeU8(0) // killerSlotIdx = 0 (Player 1)
        .writeU8(0) // dropCount = 0
    );
    expect(client1.popByOpcode(144)).toBeDefined();

    // Match finishes automatically: S->C 148 (scoreboard) & S->C 153 (return to Stage 12)
    const p148 = client1.popByOpcode(148)!;
    expect(p148).toBeDefined();
    expect(p148.readU8()).toBe(1); // isNormalFinish = 1

    const p153 = client1.popByOpcode(153)!;
    expect(p153).toBeDefined();
    expect(p153.readU8()).toBe(0); // targetMode = 0 -> Stage 12
    expect(session1.stageId).toBe(StageId.Prepare);
    expect(session2.stageId).toBe(StageId.Prepare);

    // Verify DB stats were updated for winner (bazzi_tw) and loser (dao_tw)
    const updatedBazzi = state.db.getUserByUsername("bazzi_tw")!;
    const updatedDao = state.db.getUserByUsername("dao_tw")!;
    expect(updatedBazzi.wins).toBe(1);
    expect(updatedBazzi.lucci).toBeGreaterThan(50000);
    expect(updatedDao.losses).toBe(1);

    // 15. Shop & Inventory flow (`C->S 37 -> S->C 261 + S->C 48`, `C->S 38 -> S->C 16 sub_4BB82A`,
    //     `C->S 276 -> S->C 193 fxstock.ini`, `C->S 278 -> S->C 200 stringtable.ini`,
    //     `C->S 281 -> S->C 210 packagemap.ini`, `C->S 273` buy & equip)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestShopConnection).writeU8(11).writeU32(0)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopConnectionPermission)?.readU8()).toBe(1);
    expect(client1.popByOpcode(ServerOpcode.ShopServerEndpoint)?.readU8()).toBe(1);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.AuthenticateShopConnection)
    );
    const p16 = client1.popByOpcode(ServerOpcode.ShopInitAndStage14)!;
    expect(p16).toBeDefined();
    expect(p16.readU8()).toBe(0);
    expect(p16.readU8()).toBe(0);
    expect(p16.readU32()).toBe(updatedBazzi.cash);
    expect(p16.readU32()).toBe(updatedBazzi.lucci);
    expect(p16.readU32()).toBe(state.resources.ssdFiles.fxstock.adler32Zero);
    expect(p16.readU32()).toBe(state.resources.ssdFiles.stringtable.adler32Zero);
    expect(p16.readU32()).toBe(state.resources.ssdFiles.packagemap.adler32Zero);
    expect(p16.readString()).toContain("http");
    expect(p16.readU32()).toBe(0); // bannerCount = 0
    expect(client1.popByOpcode(ServerOpcode.InventoryData)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeDefined();

    // Request fxstock.ini (`C->S 276 -> S->C 193`), stringtable.ini (`C->S 278 -> S->C 200`), packagemap.ini (`C->S 281 -> S->C 210`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestFxStockIni)
    );
    const p193 = client1.popByOpcode(ServerOpcode.FxStockIniStream)!;
    expect(p193).toBeDefined();
    expect(verifySmartStreamSchema("fxstock.ini", p193.readSmartStream().bytes)).toEqual({
      entryCount: 1461,
      remaining: 0,
    });

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestStringTableOrBalance).writeU8(0)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopCashBalance)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.ShopLucciBalance)).toBeDefined();
    const p200 = client1.popByOpcode(ServerOpcode.StringTableIniStream)!;
    expect(p200).toBeDefined();
    expect(verifySmartStreamSchema("stringtable.ini", p200.readSmartStream().bytes)).toEqual({
      entryCount: 114,
      remaining: 0,
    });

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestPackageMapIni)
    );
    const p210 = client1.popByOpcode(ServerOpcode.PackageMapIniStream)!;
    expect(p210).toBeDefined();
    expect(verifySmartStreamSchema("packagemap.ini", p210.readSmartStream().bytes)).toEqual({
      entryCount: 988,
      remaining: 0,
    });

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopAction).writeU8(1).writeU32(2005).writeU8(0).writeU32(500)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopBuyResult)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.ShopUserStockList)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopAction).writeU8(3).writeU32(2005).writeU8(1)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopEquipResult)).toBeDefined();

    // 16. Leave Room (current server output: C->S 78 -> S->C 9 u32(11) + S->C 103).
    // The opcode-9 leave response is a separate known defect in the generic CPrepareStage path.
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.LeaveRoom));
    client1.popByOpcode(ServerOpcode.StageTransition); // pop earlier Stage 14 transition
    expect(client1.popByOpcode(ServerOpcode.StageTransition)?.readU32()).toBe(StageId.Lobby);
    expect(session1.stageId).toBe(StageId.Lobby);
    expect(session1.udpEndpoint).toBeNull();
    expect(state.rooms.get(roomNum)?.slots[0]?.udpEndpoints).toEqual([
      { ip: 0, port: 0 },
      { ip: 0, port: 0 },
      { ip: 0, port: 0 },
    ]);

    const p103 = client2.popByOpcode(ServerOpcode.PlayerLeftSlot)!;
    expect(p103).toBeDefined();
    expect(p103.readU8()).toBe(0); // leftSlotIdx = 0
    expect(p103.readU32()).toBeGreaterThan(0); // newChiefSlotNetId
    expect(p103.readU8()).toBe(0); // bannedByLeaderFlag = 0
    expect(p103.readU16()).toBe(0); // unused u16 in CPrepareStage::sub_4D4154
    expect(p103.readU8()).toBe(1); // newChiefSlotIdx = 1 (`j[779]`)
    expect(p103.remaining).toBe(0);

    // 17. UserMarket flow (`C->S 318 -> S->C 262`, `C->S 320 -> S->C 270`, `C->S 324 -> S->C 274`, `C->S 326 -> S->C 99`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestUserMarketConnection).writeU8(0)
    );
    expect(client1.popByOpcode(ServerOpcode.UserMarketPermission)?.readU8()).toBe(1);
    expect(session1.stageId).toBe(StageId.UserMarket);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketSearch320)
        .writeU8(0)
        .writeU8(0)
        .writeU16(0)
        .writeString("")
    );
    const p270 = client1.popByOpcode(ServerOpcode.UserMarketListingPage)!;
    expect(p270).toBeDefined();
    expect(p270.readU8()).toBe(0); // tab
    expect(p270.readU8()).toBe(1); // res = 1

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketMyListings324)
    );
    const p274 = client1.popByOpcode(ServerOpcode.UserMarketMyListings)!;
    expect(p274).toBeDefined();
    expect(p274.readU8()).toBe(1); // res = 1
    expect(p274.readU8()).toBe(0); // count = 0

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketLeave326).writeU8(1)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopLeaveReturnStage)?.readU16()).toBe(StageId.Lobby);
    expect(session1.stageId).toBe(StageId.Lobby);

    // 18. Real CShopDlg (`269..285`), CGachaponDlg (`307`), CBasketDlg (`313..314`),
    //     CUserMarketStage (`324..330`), CSmsDlg (`297..300`), CCouple (`304..306`), and CExchangeStage (`100..101`)
    // 18a. Shop Buy (`C->S 270`, `sub_58EAEF`), Equip (`C->S 274`, `sub_541682`), Custom Text (`C->S 275`, `sub_48ED44`),
    //      Gift (`C->S 279`, `sub_52C5A2`), Coupon (`C->S 280`, `sub_492CD9`), Resell (`C->S 283`, `sub_58BFE0`),
    //      Gachapon (`C->S 307`), Basket (`C->S 313, 314`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopBuyItem)
        .writeU32(3001) // stockId
        .writeU32(100) // price
        .writeU16(0) // couponType = 0
        .writeU8(2) // currencyType = 2 (Lucci)
    );
    const p199 = client1.popByOpcode(ServerOpcode.ShopBuyResult)!;
    expect(p199).toBeDefined();
    expect(p199.readU8()).toBe(0); // result = 0 (`sub_52DA5E` success)
    expect(p199.readVariantTime()).toBeGreaterThan(45000);
    expect(client1.popByOpcode(ServerOpcode.ShopUserStockList)).toBeDefined();

    // Equip slot (`C->S 274`, `sub_541682`: `[u8 playerIdx, u8 slotIdx, u32 stockId, str text]`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopUseOrEquip274)
        .writeU8(0)
        .writeU8(0)
        .writeU32(3001)
        .writeString("Bazzi Hat")
    );
    const p196 = client1.popByOpcode(ServerOpcode.EquippedAvatarData)!;
    expect(p196).toBeDefined();
    expect(p196.readU8()).toBe(1); // playerCount = 1
    expect(p196.readU32()).toBe(3001); // slot 0 stockId
    expect(p196.readString()).toBe("Bazzi Hat");

    // Batch update custom text (`C->S 275`, `CShopTextDlg::sub_48ED44`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopInventoryTab275)
        .writeU8(0)
        .writeU32(1)
        .writeU32(3001)
        .writeString("Updated Text")
    );
    expect(client1.popByOpcode(ServerOpcode.ShopUserStockList)).toBeDefined();

    // Send Gift (`C->S 279`, `sub_52C5A2`: `[u32 packageId, str receiverName, str title, str message, u8 flag]`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopSendGift)
        .writeU32(3002)
        .writeString("dao_tw")
        .writeString("Gift Title")
        .writeString("Happy Birthday!")
        .writeU8(0)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopBuyResult)?.readU8()).toBe(0);
    const p203 = client2.popByOpcode(ServerOpcode.ShopGiftList)!;
    expect(p203).toBeDefined();
    expect(p203.readU32()).toBeGreaterThanOrEqual(0); // sentCount

    // Redeem Coupon (`C->S 280`, `sub_492CD9`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopBuy280)
        .writeString("BNB-COUPON-2026")
        .writeString("")
    );
    const p204 = client1.popByOpcode(ServerOpcode.ShopCouponResult)!;
    expect(p204).toBeDefined();
    expect(p204.readU8()).toBe(1); // result = 1 (self coupon redeemed)
    expect(p204.readU32()).toBe(1); // itemCount = 1

    // Gachapon Roll (`C->S 307`, `CGachaponDlg::sub_5C3330`: `[u32 couponStockId]`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.GachaponRoll).writeU32(4001)
    );
    const p255 = client1.popByOpcode(ServerOpcode.GachaponResult)!;
    expect(p255).toBeDefined();
    expect(p255.readU8()).toBe(1); // 1 = success
    expect(p255.readU32()).toBe(4001);

    // Basket Info & Coupons (`C->S 313, 314` -> `S->C 259, 260`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.BasketQueryInfo)
    );
    expect(client1.popByOpcode(ServerOpcode.BasketInfo)).toBeDefined();
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.BasketQueryCoupons)
    );
    expect(client1.popByOpcode(ServerOpcode.BasketCouponCounts)).toBeDefined();

    // Resell Item (`C->S 283`, `sub_58BFE0`: `[u32 stockId, u32 slotIdx]`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopResellItem).writeU32(3001).writeU32(0)
    );
    const p212 = client1.popByOpcode(ServerOpcode.ShopResellResult)!;
    expect(p212).toBeDefined();
    expect(p212.readU8()).toBe(0); // result = 0 (`sub_546D3F` resell success)
    expect(p212.readString()).toContain("3001");
    expect(p212.readU32()).toBe(3001);

    // 18b. Real UserMarket registration, purchase & Lucci transfer (`C->S 326, 330, 329`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketLeave326).writeU32(2005).writeU32(1000)
    );
    const p273 = client1.popByOpcode(ServerOpcode.UserMarketRegisterResult)!;
    expect(p273).toBeDefined();
    expect(p273.readU16()).toBe(0); // 0 = RegistrationComplete (`sub_50F8CA`)

    const listings = state.db.getActiveMarketListings();
    expect(listings.length).toBeGreaterThanOrEqual(1);
    const listingId = listings[0]!.id;

    // Player 2 buys the listing (`C->S 330` -> `S->C 277`)
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.UserMarketBuyListing).writeU32(listingId)
    );
    const p277 = client2.popByOpcode(ServerOpcode.UserMarketPurchaseResult)!;
    expect(p277).toBeDefined();
    expect(p277.readU16()).toBe(0); // 0 = PurchaseComplete (`sub_50FE88`)
    expect(p277.readU32()).toBe(2005); // stockId

    // Player 1 transfers Market Lucci -> Game Lucci (`C->S 329` -> `S->C 276`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketTransferLucci).writeU8(1).writeU32(500)
    );
    const p276 = client1.popByOpcode(ServerOpcode.UserMarketTransferResult)!;
    expect(p276).toBeDefined();
    expect(p276.readU16()).toBe(0); // 0 = MoveComplete (`sub_50FD30`)

    // 18c. SMS Mailbox (`CSmsDlg` `297..300` -> `S->C 242..246`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.SmsSend)
        .writeString("bazzi_tw")
        .writeString("dao_tw")
        .writeString("GG well played!")
    );
    expect(client1.popByOpcode(ServerOpcode.SmsSendResult)?.readU8()).toBe(10); // 10 = MessageSuccess
    expect(client2.popByOpcode(ServerOpcode.SmsNewNotice)?.readU8()).toBe(1); // 1 = new mail popup

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.SmsQuery).writeString("dao_tw").writeU8(0)
    );
    const p243 = client2.popByOpcode(ServerOpcode.SmsList)!;
    expect(p243).toBeDefined();
    expect(p243.readU8()).toBe(15); // status = 15 (`sub_484465`)
    expect(p243.readU8()).toBe(1); // count = 1
    const smsId = p243.readU32();
    expect(p243.readString()).toBe("bazzi_tw");
    expect(p243.readString()).toBe("GG well played!");

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.SmsDelete).writeString("dao_tw").writeU32(smsId)
    );
    expect(client2.popByOpcode(ServerOpcode.SmsDeleteResult)?.readU8()).toBe(1);

    // 18d. Couple Ring (`CCouple` `304..306` -> `S->C 251..254`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.CouplePropose)
        .writeU8(0)
        .writeString("dao_tw")
        .writeString("Be my couple partner!")
    );
    const p252 = client1.popByOpcode(ServerOpcode.CoupleProposeStatus)!;
    expect(p252).toBeDefined();
    expect(p252.readU8()).toBe(0);
    expect(p252.readU8()).toBe(2); // 2 = waiting for partner
    const p251 = client2.popByOpcode(ServerOpcode.CoupleProposeIncoming)!;
    expect(p251).toBeDefined();
    expect(p251.readU8()).toBe(0);
    expect(p251.readString()).toBe("bazzi_tw");

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.CoupleRespond).writeU8(0).writeU8(1)
    );
    const p253 = client2.popByOpcode(ServerOpcode.CoupleCongratulate)!;
    expect(p253).toBeDefined();
    expect(p253.readU8()).toBe(0);
    expect(p253.readU8()).toBe(12); // 12 = accepted (`sub_5BBD3E`)

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.CoupleBreakup).writeU8(0)
    );
    expect(client1.popByOpcode(ServerOpcode.CoupleBreakupNotice)?.readU8()).toBe(0);

    // 19. Ranking (`C->S 64, 296, 311` -> `S->C 69, 240, 256`), Profile (`C->S 302, 66` -> `S->C 71, 248`),
    //     Chat Macro (`C->S 40` -> `S->C 50`), Exchange (`C->S 99..101`), Coupon (`C->S 286` -> `S->C 204`),
    //     and Account Registration (`C->S 32..36, 46`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.QueryRankingPage).writeU16(1)
    );
    const p69 = client1.popByOpcode(ServerOpcode.RankingList)!;
    expect(p69).toBeDefined();
    expect(p69.readU16()).toBe(1); // startRank = 1 (`sub_4A5114`)
    expect(p69.readU8()).toBeGreaterThanOrEqual(1); // count

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.QueryTop3Rank)
    );
    const p240 = client1.popByOpcode(ServerOpcode.RankingTop3)!;
    expect(p240).toBeDefined();
    expect(p240.readU8()).toBeGreaterThanOrEqual(1); // count (`sub_4A522B`)

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.QueryMyCharacterRank)
    );
    const p256 = client1.popByOpcode(ServerOpcode.MyCharacterRank)!;
    expect(p256).toBeDefined();
    expect(p256.readU8()).toBe(1); // hasRank = 1 (`sub_4A527F`)

    // User Profile + Quest Info (`C->S 302 + 66` -> `S->C 81, 71, 220..222, 248`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.MyPagePreOpen)
    );
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.QueryUserInfo66).writeString("bazzi_tw").writeU8(1).writeU8(0)
    );
    const p71 = client1.popByOpcode(ServerOpcode.UserStats71)!;
    expect(p71).toBeDefined();
    expect(p71.readU8()).toBe(1); // found = 1 (`sub_5403BB`)
    expect(p71.readString()).toBe("bazzi_tw");
    const p248 = client1.popByOpcode(ServerOpcode.UserQuestAndSlotInfo248)!;
    expect(p248).toBeDefined();
    expect(p248.readU8()).toBe(0); // playerIdx = 0 (`sub_4B9DB6`)

    // Chat Macro (`C->S 40` -> `S->C 50`, `sub_4A27CB`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.MacroListQuery).writeU8(0)
    );
    const p50 = client1.popByOpcode(ServerOpcode.MacroList)!;
    expect(p50).toBeDefined();
    expect(p50.remaining).toBe(0);

    // Shop Coupon Code (`C->S 286` -> `S->C 204`, `CCouponDlg::sub_5B6215`) & NexonClub (`C->S 284` -> `S->C 232`, `CStage::sub_4BC337`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RedeemCouponCode).writeU32(5001)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopCouponResult)?.readU8()).toBe(1);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.NexonClubAuth)
        .writeU8(0)
        .writeString("bazzi_club")
        .writeString("club_pass")
    );
    const p232 = client1.popByOpcode(ServerOpcode.NexonClubAuthResult)!;
    expect(p232).toBeDefined();
    expect(p232.readU8()).toBe(1);
    expect(p232.readU8()).toBe(0);
    expect(p232.readString()).toBe("bazzi_club");

    // Dynamic .I16 Table Request (`C->S 27 / 28` -> `S->C 32`, `CStage::sub_4B8D5F`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestDynI16Table).writeU32(12345).writeU16(1)
    );
    const p32 = client1.popByOpcode(ServerOpcode.DynamicI16Data)!;
    expect(p32).toBeDefined();
    expect(p32.readU32()).toBe(12345);
    expect(p32.readU16()).toBe(0);
    expect(p32.readU32()).toBe(0);

    // Exchange Stage (`C->S 100` -> `S->C 128`, `C->S 101` -> `S->C 130 + 126`)
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.ExchangeAction)
        .writeU8(3)
        .writeU32(100)
        .writeU8(1)
        .writeU32(2005)
        .writeSystemTime(new Date())
    );
    const p128Ex = client2.popByOpcode(ServerOpcode.ExchangeItems)!;
    expect(p128Ex).toBeDefined();
    expect(p128Ex.readU8()).toBe(1); // slotIdx = 1 (client2)
    expect(p128Ex.readU32()).toBe(100); // lucci = 100
    expect(client2.popByOpcode(ServerOpcode.ExchangeState)?.readU8()).toBe(4);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.ExchangePassCheck).writeString("pass123")
    );
    expect(client2.popByOpcode(ServerOpcode.ExchangePassResult)?.readU8()).toBe(1);
    expect(client2.popByOpcode(ServerOpcode.ExchangeState)?.readU8()).toBe(2);

    // Account Registration & Password Change (`C->S 32..36, 46`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.CheckUserIdAvailable).writeString("new_hero_tw")
    );
    expect(client1.popByOpcode(ServerOpcode.CheckIdResult)?.readU8()).toBe(0);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.SubmitRegistrationForm)
        .writeString("new_hero_tw")
        .writeString("secret123")
    );
    expect(client1.popByOpcode(ServerOpcode.RegisterAccountResult)?.readU8()).toBe(0);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ChangeAccountPassword)
        .writeString("secret123")
        .writeString("newpass456")
        .writeString("newpass456")
    );
    expect(client1.popByOpcode(ServerOpcode.GuildOrUserStatus)?.readU8()).toBe(0);
  });

  test("server shutdown is reported as a server-requested TCP close", async () => {
    const server = new CrazyArcadeServer({
      host: "127.0.0.1",
      tcpPort: 0,
      udpPort: 0,
      gameTcpPort: 0,
      gameUdpPort: 0,
      dbPath: ":memory:",
    });
    let client: LiveTcpClient | null = null;
    let stopped = false;

    try {
      const ports = await server.start();
      client = await LiveTcpClient.connect(ports.tcpPort);
      const sessionId = [...server.state.sessions.values()][0]?.sessionId;
      expect(sessionId).toBeDefined();

      clearRecentLogs();
      server.stop();
      stopped = true;
      await Bun.sleep(10);

      const closeLog = getRecentLogs().findLast(
        (entry) =>
          entry.category === "TCP" &&
          entry.message === "LoginServer TCP socket closed" &&
          entry.data?.sessionId === sessionId
      );
      expect(closeLog?.data?.closeInitiator).toBe("server-requested");
      expect(closeLog?.data?.serverCloseReason).toBe("server-shutdown");
      expect(closeLog?.data?.serverToClientWriteCalls).toBe(1);
      expect(closeLog?.data?.clientToServerDecodedPackets).toBe(0);
    } finally {
      client?.close();
      if (!stopped) server.stop();
    }
  });

  test("LoginServer -> GameServer TCP handoff uses ConnectHello, channel ordinal, and auth token", async () => {
    await using server = new CrazyArcadeServer({
      host: "127.0.0.1",
      tcpPort: 0,
      udpPort: 0,
      gameTcpPort: 0,
      gameUdpPort: 0,
      publicIp: "203.0.113.7",
      dbPath: ":memory:",
    });
    const ports = await server.start();
    expect(ports.tcpPort).toBeGreaterThan(0);
    expect(ports.udpPort).toBeGreaterThan(0);
    expect(ports.gameTcpPort).toBeGreaterThan(0);
    expect(ports.gameUdpPort).toBeGreaterThan(0);
    expect(ports.udpPort).not.toBe(ports.gameUdpPort);

    const loginClient = await LiveTcpClient.connect(ports.tcpPort);
    const loginResult = loginClient.waitForOpcode(ServerOpcode.LoginResult);
    loginClient.send(
      new PacketWriter(ClientOpcode.LoginBeanfunToken).writeU8(0).writeString("live_tester")
    );
    const p4 = await loginResult;
    expect(p4.readU8()).toBe(0); // login success
    expect(p4.readU16()).toBe(1); // world id
    expect(p4.readU8()).toBe(1); // one local player
    p4.readU32(); // Lucci
    p4.readU32(); // Wins
    p4.readU32(); // Losses
    const authToken = p4.readU32();
    expect(authToken).toBeGreaterThan(0);

    const channelList = loginClient.waitForOpcode(ServerOpcode.ChannelListSsd);
    const channelLoads = loginClient.waitForOpcode(ServerOpcode.ChannelLoads);
    const messengerHandoff = loginClient.waitForOpcode(ServerOpcode.MessengerHandoff);
    loginClient.send(new PacketWriter(ClientOpcode.RequestChannelList).writeU32(0));
    expect((await channelList).readU8()).toBe(1);
    expect(await channelLoads).toBeDefined();
    expect(await messengerHandoff).toBeDefined();

    const channelSelect = loginClient.waitForOpcode(ServerOpcode.ChannelSelectResult);
    loginClient.send(
      new PacketWriter(ClientOpcode.SelectChannel).writeU8(10).writeU32(0)
    );
    const p7 = await channelSelect;
    expect(p7.readU8()).toBe(1);
    expect(p7.readU8()).toBe(10);
    expect(p7.readU32()).toBe(0);
    expect(p7.readU32()).toBe(0xcb007107); // advertised PUBLIC_IP, not local 127.0.0.1
    expect(p7.readU16()).toBe(ports.gameTcpPort);

    // `sub_56C0C8` closes the LoginServer socket before connecting to the advertised GameServer.
    loginClient.close();
    const gameClient = await LiveTcpClient.connect(ports.gameTcpPort);
    let gameSessionId: number | undefined;
    try {
      const handoffAck = gameClient.waitForOpcode(ServerOpcode.SessionHandoffAck);
      const questSync = gameClient.waitForOpcode(ServerOpcode.QuestConfigSync);
      gameClient.send(
        new PacketWriter(ClientOpcode.SessionHandoff)
          .writeU8(1)
          .writeString("live_tester")
          .writeU32(authToken)
      );

      expect((await handoffAck).readU8()).toBe(0);
      expect((await questSync).readU32()).toBe(0);
      // S->C 33 performs the Lobby transition. S->C 9 would instead be treated by
      // CStage::sub_4B8D42 as a Crash_CA.dmp offset request and cause an unsolicited C->S 8.
      expect(gameClient.receivedOpcodes).toEqual([
        ServerOpcode.SessionHandoffAck,
        ServerOpcode.QuestConfigSync,
      ]);
      expect(gameClient.hasQueuedOpcode(ServerOpcode.StageTransition)).toBe(false);

      const gameSession = [...server.state.sessions.values()].find(
        (session) => session.connectionKind === "game"
      );
      gameSessionId = gameSession?.sessionId;
      expect(gameSession?.stageId).toBe(StageId.Lobby);
      expect(gameSession?.channelIndex).toBe(0);
      expect(gameSession?.users[0]?.username).toBe("live_tester");

      // C->S 8 is a Crash_CA.dmp upload, not the channel-cache CRC request (C->S 9).
      // Follow it with C->S 83 to synchronize on a server reply over the same TCP stream.
      clearRecentLogs();
      const dumpChunk = new Uint8Array(16_000).fill(0xcd);
      const lobbyInit = gameClient.waitForOpcode(ServerOpcode.ExpSync);
      gameClient.send(
        new PacketWriter(ClientOpcode.UploadCrashDump).writeU8(0).writeU32(dumpChunk.length)
      );
      gameClient.send(
        new PacketWriter(ClientOpcode.UploadCrashDump)
          .writeU8(1)
          .writeU32(dumpChunk.length)
          .writeBlock(dumpChunk)
      );
      gameClient.send(new PacketWriter(ClientOpcode.EnterLobby));
      expect((await lobbyInit).readU8()).toBe(0);

      const uploadLogs = getRecentLogs().filter((entry) => entry.category === "CrashDump");
      expect(uploadLogs).toHaveLength(2);
      expect(uploadLogs[0]?.data?.uploadForm).toBe("metadata");
      expect(uploadLogs[0]?.data?.transferFieldU32).toBe(16_000);
      expect(uploadLogs[0]?.data?.declaredByteCount).toBeUndefined();
      expect(uploadLogs[0]?.data?.payloadShapeMatches).toBe(true);
      expect(uploadLogs[1]?.data?.uploadForm).toBe("chunk");
      expect(uploadLogs[1]?.data?.transferFieldU32).toBe(16_000);
      expect(uploadLogs[1]?.data?.declaredByteCount).toBe(16_000);
      expect(uploadLogs[1]?.data?.payloadByteCount).toBe(16_000);
      expect(uploadLogs[1]?.data?.payloadShapeMatches).toBe(true);
      expect(
        getRecentLogs().some(
          (entry) => entry.category === "ChannelCache" && entry.message.includes("Received 9")
        )
      ).toBe(false);

      const gameFramingLogs = getRecentLogs().filter(
        (entry) => entry.category === "Framing" && entry.data?.sessionId === gameSession?.sessionId
      );
      const lobbyInitPackets = gameFramingLogs.filter(
        (entry) => entry.data?.direction === "S->C"
      );
      expect(lobbyInitPackets.map((entry) => entry.data?.opcode)).toEqual([
        ServerOpcode.ExpSync,
        ServerOpcode.LucciSync,
        ServerOpcode.InventoryData,
        ServerOpcode.EquippedAvatarData,
        ServerOpcode.InventoryExpansionSlots,
        ServerOpcode.CoupleInfoSync,
      ]);
      expect(lobbyInitPackets.map((entry) => entry.data?.payloadBytes)).toEqual([
        7, 10, 31, 51, 7, 6,
      ]);
      expect(lobbyInitPackets.every((entry) =>
        entry.data?.connectionKind === "game" && entry.data?.stageId === StageId.Lobby
      )).toBe(true);
      expect(lobbyInitPackets.every((entry) => entry.data?.payloadContent === "<omitted>")).toBe(true);
      expect(
        gameFramingLogs.some((entry) =>
          entry.data?.direction === "C->S" && entry.data?.opcode === ClientOpcode.EnterLobby
        )
      ).toBe(true);

      // After reconnect the original CStage may repeat C->S 9; it must not replay the login handoff.
      gameClient.send(new PacketWriter(ClientOpcode.RequestChannelList).writeU32(0));
      await Bun.sleep(30);
      expect(gameClient.hasQueuedOpcode(ServerOpcode.ChannelListSsd)).toBe(false);
      expect(gameClient.hasQueuedOpcode(ServerOpcode.ChannelLoads)).toBe(false);
      expect(gameClient.hasQueuedOpcode(ServerOpcode.MessengerHandoff)).toBe(false);
    } finally {
      gameClient.close();
    }

    await Bun.sleep(10);
    const gameCloseLog = getRecentLogs().findLast(
      (entry) =>
        entry.category === "TCP" &&
        entry.message === "GameServer TCP socket closed" &&
        entry.data?.sessionId === gameSessionId
    );
    expect(gameCloseLog?.data?.closeInitiator).toBe("unknown");
    expect(gameCloseLog?.data?.serverCloseReason).toBeUndefined();
    expect(gameCloseLog?.data?.clientToServerDecodedPackets).toBe(5);
    expect(gameCloseLog?.data?.serverToClientWriteCalls).toBe(9);
    expect(gameCloseLog?.data?.pendingReceiveBytes).toBe(0);
    expect(gameCloseLog?.data?.packetFlow).toContain("C->S 83 (EnterLobby)");
    expect(gameCloseLog?.data?.packetFlow).toContain("S->C 89 (ExpSync)");
    expect(gameCloseLog?.data?.packetFlow).not.toContain("live_tester");
  });
});
