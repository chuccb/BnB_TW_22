import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/index.ts";
import { dispatchTcpPacket, dispatchUdpDatagram } from "../src/handlers/dispatcher.ts";
import { CrazyArcadeServer } from "../src/network/server.ts";
import {
  buildUdpPeerData,
  buildUdpPeerProbe,
  encodeUdpDatagram,
  MTUDPPeer,
  PacketSocketState,
} from "../src/protocol/framing.ts";
import { ClientOpcode, ServerOpcode, StageId } from "../src/protocol/opcodes.ts";
import { PacketReader, PacketWriter } from "../src/protocol/primitives.ts";
import {
  computeSmartStreamBodyChecksum,
  SmartStreamReader,
} from "../src/protocol/stream.ts";
import { verifySmartStreamSchema } from "../src/resources/archive.ts";
import { WorldState } from "../src/state/worldState.ts";
import {
  clearRecentLogs,
  formatClientOpcode,
  formatStageId,
  formatU8Hex,
  getRecentLogs,
} from "../src/utils/logger.ts";

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
  test("does not dispatch batched frames from the current Client UDP send path", () => {
    using state = new WorldState(loadConfig({ dbPath: ":memory:" }));
    // Client sub_693100 wraps one payload and calls sendto once per invocation. Its
    // receive-side batch loop does not establish that Client requests are batched.
    const datagram = encodeUdpDatagram([
      new Uint8Array([0, 0, 3]),
      new Uint8Array([0, 0, 4]),
    ]);

    expect(dispatchUdpDatagram(state, datagram, "203.0.113.52", 55001)).toEqual([]);
  });

  test("Taiwan default endpoints match the client topology", () => {
    const config = loadConfig();
    expect(config.tcpPort).toBe(3838);
    expect(config.udpPort).toBe(config.tcpPort + 1);
    expect(config.gameTcpPort).toBe(9339);
    expect(config.gameUdpPort).toBe(config.gameTcpPort + 1);
  });

  test("C->S 3 is a new-user identifier check, not channel selection", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51016, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.SelectServer;

    // CNewUserDlgChina::sub_496AA6 writes [str, u8 selector]; CNewUserDlg::sub_498367
    // writes [str]. Keep both source-confirmed forms distinct and do not guess a reply.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.NewUserIdentifierCheck3)
        .writeString("ChinaUser")
        .writeU8(0)
    );
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.NewUserIdentifierCheck3).writeString("identifier-marker-two")
    );

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.stageId).toBe(StageId.SelectServer);
    const trace = session.getPacketTraceSummary();
    expect(trace.clientToServerDecodedPackets).toBe(2);
    expect(trace.packetFlow).toContain("C->S [decoded] 3 (NewUserIdentifierCheck3)");
    expect(trace.packetFlow).not.toContain("S->C 7");
    const checks = getRecentLogs().filter(
      (entry) =>
        entry.category === "Registration" &&
        entry.message.includes("response association UNKNOWN")
    );
    expect(checks).toHaveLength(2);
    expect(checks.every((entry) => entry.data?.responseSent === false)).toBe(true);
    expect(checks.every((entry) => entry.data?.databaseMutation === false)).toBe(true);
    expect(JSON.stringify(getRecentLogs())).not.toContain("ChinaUser");
    expect(JSON.stringify(getRecentLogs())).not.toContain("identifier-marker-two");
  });

  test("C->S 4/34/35/36 form writers do not share a guessed schema or response", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51021, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Login;

    // C->S 4 has a five-string + u8 writer and feature/state-dependent China variants.
    // C->S 34 has separate mode-0/mode-1 [u8, str] writers; 35 is [5*str, u8, 2*str];
    // 36 is [2*str, u8]. None has a confirmed server reply/backend association here.
    const packet4Standard = new PacketWriter(ClientOpcode.UnresolvedClientPacket4)
      .writeString("marker-packet4-standard")
      .writeString("field-2")
      .writeString("field-3")
      .writeString("field-4")
      .writeString("field-5")
      .writeU8(1);
    const packet4China = new PacketWriter(ClientOpcode.UnresolvedClientPacket4)
      .writeU8(1)
      .writeString("marker-packet4-china")
      .writeString("opaque-form-value")
      .writeU8(0);
    const packet34Mode0 = new PacketWriter(ClientOpcode.UnresolvedClientPacket34)
      .writeU8(0)
      .writeString("marker-packet34-mode0");
    const packet34Mode1 = new PacketWriter(ClientOpcode.UnresolvedClientPacket34)
      .writeU8(1)
      .writeString("marker-packet34-mode1");
    const packet35 = new PacketWriter(ClientOpcode.UnresolvedClientPacket35)
      .writeString("marker-packet35")
      .writeString("field-2")
      .writeString("field-3")
      .writeString("field-4")
      .writeString("field-5")
      .writeU8(1)
      .writeString("field-6")
      .writeString("field-7");
    const packet36 = new PacketWriter(ClientOpcode.UnresolvedClientPacket36)
      .writeString("marker-packet36")
      .writeString("opaque-value")
      .writeU8(0);

    for (const packet of [packet4Standard, packet4China, packet34Mode0, packet34Mode1, packet35, packet36]) {
      client.sendToServer(state, session.sessionId, packet);
    }

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.stageId).toBe(StageId.Login);
    expect(session.users).toHaveLength(0);
    expect(state.db.db.query("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
    for (const marker of [
      "marker-packet4-standard",
      "marker-packet4-china",
      "marker-packet34-mode0",
      "marker-packet34-mode1",
      "marker-packet35",
      "marker-packet36",
    ]) {
      expect(state.db.getUserByUsername(marker)).toBeNull();
    }

    const observations = getRecentLogs().filter(
      (entry) => entry.category === "PacketAudit" && entry.data?.responseAssociation === "UNKNOWN"
    );
    expect(observations).toHaveLength(6);
    expect(JSON.stringify(getRecentLogs())).not.toContain("marker-packet");
    expect(observations.every((entry) => entry.data?.responseSent === false)).toBe(true);
    expect(observations.every((entry) => entry.data?.databaseMutation === false)).toBe(true);
  });

  test("C->S 10 contextual signal is not routed as a C->S 9 channel-cache request", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51017, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Login;

    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.ClientSignal10));
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ClientSignal10).writeString("opaque-client-value")
    );

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.stageId).toBe(StageId.Login);
    const signals = getRecentLogs().filter(
      (entry) =>
        entry.category === "Protocol" &&
        entry.message.includes("C->S 10 contextual Client signal")
    );
    expect(signals).toHaveLength(2);
    expect(signals.every((entry) => entry.data?.responseSent === false)).toBe(true);
  });

  test("C->S 29 NexonClub credentials are not parsed as generic login credentials", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51018, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Login;

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.NexonClubAuthRequest29)
        .writeString("NexonClubUser")
        .writeString("opaque-secret")
    );

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.users).toHaveLength(0);
    expect(state.db.getUserByUsername("NexonClubUser")).toBeNull();
    expect(JSON.stringify(getRecentLogs())).not.toContain("opaque-secret");
    const request = getRecentLogs().find(
      (entry) =>
        entry.category === "NexonClub" &&
        entry.message.includes("response association UNKNOWN")
    );
    expect(request?.data?.credentialValuesLogged).toBe(false);
    expect(request?.data?.responseSent).toBe(false);
  });

  test("C->S 261 Lobby initialization signal does not trigger Shop entry", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51019, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Lobby;

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.LobbyConditionalSignal261)
    );

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.stageId).toBe(StageId.Lobby);
    const trace = session.getPacketTraceSummary();
    expect(trace.packetFlow).toContain("C->S [decoded] 261 (LobbyConditionalSignal261)");
    const signal = getRecentLogs().find(
      (entry) =>
        entry.category === "Lobby" &&
        entry.message.includes("conditional Lobby signal")
    );
    expect(signal?.data?.emptyBodyObserved).toBe(true);
    expect(signal?.data?.responseSent).toBe(false);
    expect(getRecentLogs().some((entry) => entry.message.includes("Shop-flow candidate packet"))).toBe(false);
  });

  test("unresolved Client opcode candidates and unverified legacy replies stay observation-only", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51020, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Login;

    // These are project-side symbolic candidates with no recovered current-build Client writer;
    // arbitrary string bodies only catch accidental generic parsing, not establish schemas.
    // Opcode 294 is different: its recovered Lobby-setup writer has an empty body.
    const unresolvedOpcodes = [
      ClientOpcode.ContextualClientPacket16,
      ClientOpcode.UnresolvedClientPacket17,
      ClientOpcode.UnresolvedClientPacket18,
      ClientOpcode.UnresolvedClientPacket19,
      ClientOpcode.UnresolvedClientPacket30,
      ClientOpcode.UnresolvedClientPacket49,
      ClientOpcode.UnresolvedClientPacket252,
      ClientOpcode.UnresolvedClientPacket266,
      ClientOpcode.UnresolvedClientPacket267,
    ];
    for (const opcode of unresolvedOpcodes) {
      client.sendToServer(
        state,
        session.sessionId,
        new PacketWriter(opcode).writeString("opaque-unresolved-value")
      );
    }
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.LobbyInitializationSignal294)
    );
    // A four-byte C->S 305 body is not the current Client's two-byte CoupleRespond writer.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.CoupleRespond).writeU32(0x12345678)
    );

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.users).toHaveLength(0);
    expect(state.db.db.query("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
    expect(state.db.getUserByUsername("opaque-unresolved-value")).toBeNull();
    expect(JSON.stringify(getRecentLogs())).not.toContain("opaque-unresolved-value");
    const observations = getRecentLogs().filter(
      (entry) => entry.category === "PacketAudit" && entry.data?.responseAssociation === "UNKNOWN"
    );
    expect(observations).toHaveLength(11);
    expect(new Set(observations.map((entry) => entry.data?.wireOpcode))).toEqual(
      new Set([...unresolvedOpcodes, ClientOpcode.LobbyInitializationSignal294, ClientOpcode.CoupleRespond])
    );
    expect(observations.every((entry) => entry.data?.responseSent === false)).toBe(true);
    expect(observations.every((entry) => entry.data?.databaseMutation === false)).toBe(true);
    const packet18 = observations.find((entry) => entry.data?.wireOpcode === 18);
    expect(packet18?.data?.payloadSchema).toBe("UNKNOWN");
    expect(packet18?.data?.semanticRole).toBe("UNKNOWN");
    const packet294 = observations.find((entry) => entry.data?.wireOpcode === 294);
    expect(packet294?.data?.payloadSchema).toBe("empty in the recovered writer");
    expect(session.stageId).toBe(StageId.Login);
  });

  test("C->S 323 writer does not imply an S->C stage transition policy", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51021, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Lobby;

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.StageAction323).writeU8(7).writeU8(2)
    );

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.stageId).toBe(StageId.Lobby);
    const observation = getRecentLogs().find(
      (entry) => entry.category === "PacketAudit" && entry.data?.wireOpcode === 323
    );
    expect(observation?.data?.payloadSchema).toBe("two u8 fields in the recovered writer; field meanings UNKNOWN");
    expect(observation?.data?.responseAssociation).toBe("UNKNOWN");
    expect(observation?.data?.responseSent).toBe(false);
    expect(observation?.data?.databaseMutation).toBe(false);
  });

  test("C->S 310 is observed without a guessed gift acknowledgement or mutation", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51022, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Shop;

    const user = state.db.createUser("packet310_receiver", "password");
    session.users = [user];
    state.db.createGift(user.id, "packet310_sender", 5001, 5002, "existing title", "existing message");
    const userBefore = state.db.getUserByUsername(user.username);
    const inventoryBefore = state.db.getInventory(user.id);
    const giftsBefore = state.db.getGiftsByUser(user.id);

    // The current Client conditionally writes one byte from sub_58EBFE's caller-supplied n0xB.
    // This observation test checks routing and width only; it does not prove acknowledgement
    // semantics or server reply policy.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UnresolvedClientPacket310).writeU8(7)
    );

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.stageId).toBe(StageId.Shop);
    expect(state.db.getUserByUsername(user.username)).toEqual(userBefore);
    expect(state.db.getInventory(user.id)).toEqual(inventoryBefore);
    expect(state.db.getGiftsByUser(user.id)).toEqual(giftsBefore);
    expect(session.getPacketTraceSummary().packetFlow).toContain(
      "C->S [decoded] 310 (UnresolvedClientPacket310)"
    );

    const observation = getRecentLogs().find(
      (entry) => entry.category === "PacketAudit" && entry.data?.wireOpcode === 310
    );
    expect(observation?.data?.payloadBytes).toBe(1);
    expect(observation?.data?.payloadSchema).toBe("u8 caller-supplied n0xB value; meaning UNKNOWN");
    expect(observation?.data?.payloadWidthValid).toBe(true);
    expect(observation?.data?.callerSuppliedValue).toBe(7);
    expect(observation?.data?.responseAssociation).toBe("UNKNOWN");
    expect(observation?.data?.responseSent).toBe(false);
    expect(observation?.data?.databaseMutation).toBe(false);
  });

  test("C->S 14 periodic status is not misrouted as chat or an S->C 15 Lobby alert", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51010, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Lobby;
    session.channelIndex = 1;

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ClientPeriodicStatus)
        .writeU32(123_456) // `timeGetTime()` from `sub_5AA9CC`
        .writeU32(0x1234_5678) // opaque `dword_974D8C + 24`
    );

    expect(client.receivedPackets).toHaveLength(0);
    expect(session.stageId).toBe(StageId.Lobby);
  });

  test("C->S 322 is decoded as a NexonClub dialog submission, not a UserMarket purchase", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51015, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Lobby;

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.NexonClubDialogSubmit322)
        .writeString("opaque-first-field")
        .writeString("opaque-dialog-field")
    );

    expect(session.stageId).toBe(StageId.Lobby);
    expect(client.receivedPackets).toHaveLength(0);
    const trace = session.getPacketTraceSummary();
    expect(trace.clientToServerDecodedPackets).toBe(1);
    expect(trace.packetFlow).toContain("C->S [decoded] 322 (NexonClubDialogSubmit322)");
    expect(trace.packetFlow).not.toContain("S->C 322");
    const dialogLog = getRecentLogs().find(
      (entry) => entry.category === "NexonClub" && entry.message.includes("Decoded C->S 322")
    );
    expect(dialogLog?.data?.firstFieldWireBytes).toBeGreaterThan(0);
    expect(dialogLog?.data?.secondFieldWireBytes).toBeGreaterThan(0);
    expect(JSON.stringify(dialogLog?.data)).not.toContain("opaque-first-field");
    expect(JSON.stringify(dialogLog?.data)).not.toContain("opaque-dialog-field");
  });

  test("C->S 13 returns a Lobby session to SelectServer without chat side effects", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51011, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Lobby;
    session.channelIndex = 1;

    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.ReturnToChannelSelect));

    expect(session.stageId).toBe(StageId.SelectServer);
    expect(client.receivedPackets).toHaveLength(0);
  });

  test("empty C->S 96 does not act as a room leave or emit S->C 9", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51029, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.users = [state.db.createUser("handicap_user", "password")];
    session.netSlotIds = [state.allocateNetSlotId()];
    session.equippedCharIds = [0];
    session.stageId = StageId.Prepare;
    session.channelIndex = 1;
    const room = state.createRoom(session, "Handicap test", "", false, 0, 0, [0]);

    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.PracticeHandicap));

    expect(session.stageId).toBe(StageId.Prepare);
    expect(session.currentRoomNumber).toBe(room.roomNumber);
    expect(room.slots[0]?.occupied).toBe(true);
    expect(client.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
    expect(client.popByOpcode(ServerOpcode.PlayerLeftSlot)).toBeUndefined();
  });

  test("C->S 91 notifies the kicked Client with S->C 103 instead of S->C 9", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const chiefClient = new SimulatedClient();
    const kickedClient = new SimulatedClient();
    const normalClient = new SimulatedClient();
    const chiefSession = state.createSession(
      chiefClient.onWireBytes,
      "127.0.0.1",
      51030,
      "0.0.0.0",
      0,
      "game"
    );
    const kickedSession = state.createSession(
      kickedClient.onWireBytes,
      "127.0.0.1",
      51031,
      "0.0.0.0",
      0,
      "game"
    );
    const normalSession = state.createSession(
      normalClient.onWireBytes,
      "127.0.0.1",
      51034,
      "0.0.0.0",
      0,
      "game"
    );
    chiefSession.sendConnectHello(config);
    kickedSession.sendConnectHello(config);
    normalSession.sendConnectHello(config);

    chiefSession.users = [state.db.createUser("kick_chief", "password")];
    chiefSession.netSlotIds = [state.allocateNetSlotId()];
    chiefSession.equippedCharIds = [0];
    kickedSession.users = [
      state.db.createUser("kick_target_a", "password"),
      state.db.createUser("kick_target_b", "password"),
    ];
    kickedSession.netSlotIds = [state.allocateNetSlotId(), state.allocateNetSlotId()];
    kickedSession.equippedCharIds = [0, 0];
    normalSession.users = [state.db.createUser("kick_normal_target", "password")];
    normalSession.netSlotIds = [state.allocateNetSlotId()];
    normalSession.equippedCharIds = [0];

    const room = state.createRoom(chiefSession, "Kick test", "", false, 0, 0, [0]);
    state.assignSessionToRoom(kickedSession, room, [0, 0]);
    state.assignSessionToRoom(normalSession, room, [0]);
    const kickedSlotIndices = [...kickedSession.roomSlotIndices];
    const kickedNetSlotIds = [...kickedSession.netSlotIds];
    const selectedLocalIdx = 1;
    const kickedSlotIdx = kickedSlotIndices[selectedLocalIdx]!;
    const kickedNetSlotId = kickedNetSlotIds[selectedLocalIdx]!;

    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      new PacketWriter(ClientOpcode.KickPlayer).writeU32(kickedNetSlotId).writeU8(1)
    );

    const kickedNotice = kickedClient.popByOpcode(ServerOpcode.PlayerLeftSlot);
    expect(kickedNotice).toBeDefined();
    expect(kickedNotice!.readU8()).toBe(kickedSlotIdx);
    expect(kickedNotice!.readU32()).toBe(kickedNetSlotId);
    expect(kickedNotice!.readU8()).toBe(1); // hasSuperChiefItem from the C->S 91 request
    expect(kickedNotice!.remaining).toBe(0);
    expect(kickedClient.popByOpcode(ServerOpcode.PlayerLeftSlot)).toBeUndefined();
    expect(kickedClient.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
    expect(kickedSession.stageId).toBe(StageId.Lobby);
    expect(kickedSession.currentRoomNumber).toBeNull();
    for (const slotIdx of kickedSlotIndices) {
      expect(room.slots[slotIdx]?.occupied).toBe(false);
    }

    for (let index = 0; index < kickedSlotIndices.length; index++) {
      const chiefNotice = chiefClient.popByOpcode(ServerOpcode.PlayerLeftSlot);
      expect(chiefNotice).toBeDefined();
      expect(chiefNotice!.readU8()).toBe(kickedSlotIndices[index]);
      expect(chiefNotice!.readU32()).toBe(kickedNetSlotIds[index]);
      expect(chiefNotice!.readU8()).toBe(1);
      expect(chiefNotice!.remaining).toBe(0);
    }
    expect(chiefClient.popByOpcode(ServerOpcode.PlayerLeftSlot)).toBeUndefined();
    expect(chiefClient.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();

    // The other room session receives one identity-matched notice for each removed local slot.
    for (let index = 0; index < kickedSlotIndices.length; index++) {
      const notice = normalClient.popByOpcode(ServerOpcode.PlayerLeftSlot);
      expect(notice).toBeDefined();
      expect(notice!.readU8()).toBe(kickedSlotIndices[index]);
      expect(notice!.readU32()).toBe(kickedNetSlotIds[index]);
      expect(notice!.readU8()).toBe(1);
      expect(notice!.remaining).toBe(0);
    }
    expect(normalClient.popByOpcode(ServerOpcode.PlayerLeftSlot)).toBeUndefined();
    expect(normalSession.currentRoomNumber).toBe(room.roomNumber);
    expect(normalClient.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();

    // A normal leader kick carries the zero item flag through the same Client packet fields.
    const normalSlotIdx = normalSession.roomSlotIndices[0]!;
    const normalNetSlotId = normalSession.netSlotIds[0]!;
    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      new PacketWriter(ClientOpcode.KickPlayer).writeU32(normalNetSlotId).writeU8(0)
    );
    const normalNotice = normalClient.popByOpcode(ServerOpcode.PlayerLeftSlot);
    expect(normalNotice).toBeDefined();
    expect(normalNotice!.readU8()).toBe(normalSlotIdx);
    expect(normalNotice!.readU32()).toBe(normalNetSlotId);
    expect(normalNotice!.readU8()).toBe(0);
    expect(normalNotice!.remaining).toBe(0);
    expect(normalClient.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
    expect(normalSession.stageId).toBe(StageId.Lobby);
    expect(normalSession.currentRoomNumber).toBeNull();

    const normalNoticeToChief = chiefClient.popByOpcode(ServerOpcode.PlayerLeftSlot);
    expect(normalNoticeToChief).toBeDefined();
    expect(normalNoticeToChief!.readU8()).toBe(normalSlotIdx);
    expect(normalNoticeToChief!.readU32()).toBe(normalNetSlotId);
    expect(normalNoticeToChief!.readU8()).toBe(0);
    expect(normalNoticeToChief!.remaining).toBe(0);
    expect(chiefClient.popByOpcode(ServerOpcode.PlayerLeftSlot)).toBeUndefined();
    expect(chiefClient.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
    expect(room.slots[normalSlotIdx]?.occupied).toBe(false);
  });

  test("C->S 78 reports each removed local slot by its own net ID and sends no S->C 9", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const leavingClient = new SimulatedClient();
    const remainingClient = new SimulatedClient();
    const leavingSession = state.createSession(
      leavingClient.onWireBytes,
      "127.0.0.1",
      51032,
      "0.0.0.0",
      0,
      "game"
    );
    const remainingSession = state.createSession(
      remainingClient.onWireBytes,
      "127.0.0.1",
      51033,
      "0.0.0.0",
      0,
      "game"
    );
    leavingSession.sendConnectHello(config);
    remainingSession.sendConnectHello(config);
    leavingSession.users = [
      state.db.createUser("leave_local_a", "password"),
      state.db.createUser("leave_local_b", "password"),
    ];
    leavingSession.netSlotIds = [state.allocateNetSlotId(), state.allocateNetSlotId()];
    leavingSession.equippedCharIds = [0, 0];
    remainingSession.users = [state.db.createUser("remain_user", "password")];
    remainingSession.netSlotIds = [state.allocateNetSlotId()];
    remainingSession.equippedCharIds = [0];

    const room = state.createRoom(leavingSession, "Multi-local leave", "", false, 0, 0, [0, 0]);
    state.assignSessionToRoom(remainingSession, room, [0]);
    const leavingSlots = [...leavingSession.roomSlotIndices];
    const leavingNetSlotIds = [...leavingSession.netSlotIds];

    leavingClient.sendToServer(state, leavingSession.sessionId, new PacketWriter(ClientOpcode.LeaveRoom));

    expect(leavingSession.stageId).toBe(StageId.Lobby);
    expect(leavingSession.currentRoomNumber).toBeNull();
    expect(leavingClient.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
    expect(leavingClient.popByOpcode(ServerOpcode.PlayerLeftSlot)).toBeUndefined();
    expect(remainingSession.stageId).toBe(StageId.Prepare);
    expect(remainingSession.currentRoomNumber).toBe(room.roomNumber);

    for (let index = 0; index < leavingSlots.length; index++) {
      expect(room.slots[leavingSlots[index]!]?.occupied).toBe(false);
      const notice = remainingClient.popByOpcode(ServerOpcode.PlayerLeftSlot);
      expect(notice).toBeDefined();
      expect(notice!.readU8()).toBe(leavingSlots[index]);
      expect(notice!.readU32()).toBe(leavingNetSlotIds[index]);
      expect(notice!.readU8()).toBe(0);
      expect(notice!.remaining).toBe(0);
    }
    expect(remainingClient.popByOpcode(ServerOpcode.PlayerLeftSlot)).toBeUndefined();
    expect(remainingClient.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
  });

  test("empty Lobby ignores C->S 80 room-detail prefetch instead of showing NotValidRoomInfo", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51013, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Lobby;
    session.channelIndex = 1;

    // CLobbyStage::sub_4C99DC constructs the empty room list and calls
    // sub_4A496F(..., 0) even though there is no room to inspect.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.RoomListScrollOrDetail).writeU16(0)
    );

    expect(state.rooms.size).toBe(0);
    expect(client.receivedPackets).toHaveLength(0);
    expect(session.stageId).toBe(StageId.Lobby);
  });

  test("C->S 80 still returns S->C 83 details when the room exists", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51014, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.users = [state.db.createUser("DetailUser", "password")];
    session.netSlotIds = [state.allocateNetSlotId()];
    session.stageId = StageId.Lobby;
    session.channelIndex = 1;
    const room = state.createRoom(session, "Lobby detail", "", false, 0, 0, [0]);
    session.stageId = StageId.Lobby;

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.RoomListScrollOrDetail).writeU16(room.roomNumber)
    );

    const detail = client.popByOpcode(ServerOpcode.RoomDetailInfo);
    expect(detail).toBeDefined();
    expect(detail!.readU8()).toBe(1); // validFlag
    expect(detail!.readU8()).toBe(1); // slot 0 is occupied
    expect(detail!.readU8()).toBe(0); // charId
    expect(detail!.readString()).toBe("DetailUser");
  });

  test("Lobby normal chat sends S->C 21 only, never the S->C 15 GuildUserOnly modal", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51012, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.stageId = StageId.Lobby;
    session.channelIndex = 1;

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ContextualClientPacket16).writeString("hello")
    );

    const normalChat = client.popByOpcode(ServerOpcode.NormalChat)!;
    expect(normalChat.readString()).toBe("Player1 : hello");
    expect(normalChat.readU8()).toBe(0);
    expect(client.popByOpcode(ServerOpcode.LobbyGuildUserOnlyNotice)).toBeUndefined();
  });

  test("Full 2-player playable loop across all client stages and exact CA.exe opcodes", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:", publicIp: "198.51.100.28" });
    // Exercise the alternate source-confirmed path where the client emits the
    // empty C->S 338 packet (the default Taiwan feature set does not enable 32).
    config.enabledFeatures = new Set(config.enabledFeatures).add(32);
    using state = new WorldState(config);

    let client1 = new SimulatedClient();
    let session1 = state.createSession(client1.onWireBytes, "127.0.0.1", 51001);
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
    // Observed S->C 53 has 3 payload bytes (u16 opcode + flag) and 10 frame bytes.
    // Degree-3 framing adds seven bytes; only the flag remains after the opcode.
    expect(p53.remaining).toBe(1);
    expect(p53.readU8()).toBe(0); // sub_5C8BE3 reads only hasFilterStream when no stream is sent.
    expect(p53.remaining).toBe(0); // No packet-level extraCount follows the flag.

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
    expect(p53Stream.remaining).toBe(0); // No packet-level field follows the SmartStream.

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
    const p53Custom = client1.popByOpcode(ServerOpcode.FilterStringSsd)!;
    expect(p53Custom.readU8()).toBe(0);
    expect(p53Custom.remaining).toBe(0);

    // Enum-only config opcodes and the pre-login C->S 16 interpretation are not used as
    // evidence for a server response. The playable-flow fixture provisions its local demo account.
    state.db.createUser("bazzi_tw", "pass123");

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
    expect(client1.receivedPackets.slice(-2).map((packet) => packet.opcode)).toEqual([
      ServerOpcode.LoginResult,
      ServerOpcode.UserDynamicInfoSync,
    ]);
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
    expect(p4.readU8()).toBe(0); // separate `sub_561F62` field; local placeholder, not level gate
    const loginResultGateLevel = p4.readU16(); // `sub_5ED30E` -> `sub_5ED43B`
    expect(loggedInUser.level).toBe(1);
    expect(loggedInUser.rankFlag).toBe(0);
    expect(loginResultGateLevel).toBe(loggedInUser.level);

    // S->C 19 follows LoginResult while LoginStage is active; its Client fallback parser
    // initializes the dynamic-info record and sets the App-global +380 readiness gate.
    const p19 = client1.popByOpcode(ServerOpcode.UserDynamicInfoSync)!;
    expect(p19.readU8()).toBe(1);
    expect(p19.readU16()).toBe(loggedInUser.level);
    expect(p19.readU8()).toBe(0);
    expect(p19.readU32()).toBe(0);
    expect(p19.readU8()).toBe(0);
    expect(p19.readU8()).toBe(0);
    expect(p19.readU32()).toBe(0);
    expect(p19.readU32()).toBe(0);
    expect(p19.readU8()).toBe(0);
    expect(p19.readU32()).toBe(0);
    expect(p19.readU8()).toBe(0);
    expect(p19.readU16()).toBe(0);
    expect(p19.readU8()).toBe(0);
    expect(p19.readU8()).toBe(0);
    expect(p19.readString()).toBe("");
    expect(p19.readU8()).toBe(0);
    expect(p19.readU8()).toBe(0);
    expect(p19.remaining).toBe(0);

    const loginResponseLog = getRecentLogs().findLast(
      (entry) =>
        entry.category === "Login" &&
        entry.message === "Authentication succeeded; wrote ordered Login responses"
    );
    expect(loginResponseLog?.data?.connectionKind).toBe("login");
    expect(loginResponseLog?.data?.stageId).toBe("1 (Login)");
    expect(loginResponseLog?.data?.serverOpcodes).toEqual([
      "4 (LoginResult)",
      "19 (UserDynamicInfoSync)",
    ]);
    expect(loginResponseLog?.data?.serverWriteCalls).toBe(2);
    expect(loginResponseLog?.data?.clientReceiptVerified).toBe(false);

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

    // 5. Select Channel (C->S 5 -> S->C 7) & Session Auth Handoff (C->S 6 -> S->C 13, then 75)
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

    // Model the actual separate TCP reconnect: keep the token snapshot, remove the closed
    // LoginServer session, and begin a new GameServer socket with fresh packet state.
    const loginSession1 = session1;
    expect(state.sessionsByToken.get(token1)?.loginSessionId).toBe(loginSession1.sessionId);
    state.removeSession(loginSession1.sessionId);
    client1 = new SimulatedClient();
    session1 = state.createSession(
      client1.onWireBytes,
      "127.0.0.1",
      51003,
      "0.0.0.0",
      0,
      "game"
    );
    session1.sendConnectHello(config);
    expect(client1.helloReceived).toBe(true);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.SessionHandoff)
        .writeU8(1)
        .writeString("bazzi_tw")
        .writeU32(token1) // field95 from LoginResult (`sub_5D92A8`)
        .writeU32(0) // field97 from LoginResult (`sub_5D92F2`); meaning unconfirmed
        .writeU8(14) // opaque `CNetworkFacade+8`; value 14 is not inferred to mean StageId.Shop
        .writeU32(0) // global handoff field A (`dword_92AAEC + 888`)
        .writeU32(0) // global handoff field B (`dword_92AAEC + 892`)
    );
    const p13 = client1.popByOpcode(ServerOpcode.LobbyStageTransition)!;
    expect(p13.readU8()).toBe(0); // TW feature 22; `sub_4B96B1` consumes one byte
    expect(p13.remaining).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.SelectServerDynamicI16Data)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.QuestConfigSync)?.readU32()).toBe(0);
    expect(session1.stageId).toBe(StageId.SelectServer);
    expect(session1.pendingStageId).toBe(StageId.Lobby);
    expect(session1.lobbyEntryPacketSeen).toBe(false);

    const handoffReceiveLog = getRecentLogs().findLast(
      (entry) => entry.category === "SessionHandoff" && entry.message === "Received 6 (SessionHandoff)"
    );
    expect(handoffReceiveLog?.data?.wireLayout).toBe("sub_5D893D");
    expect(handoffReceiveLog?.data?.networkObjectByte).toBe("14 (0x0E)");
    expect(handoffReceiveLog?.data?.tokenFound).toBe(true);
    expect(handoffReceiveLog?.data?.linkedLoginSessionId).toBe(loginSession1.sessionId);
    expect(JSON.stringify(handoffReceiveLog?.data)).not.toContain(String(token1));
    const handoffSendLog = getRecentLogs().findLast(
      (entry) => entry.category === "SessionHandoff" && entry.message === "Sent GameServer Lobby transition sequence"
    );
    expect(handoffSendLog?.data?.targetStage).toBe("11 (Lobby)");
    expect(handoffSendLog?.data?.sessionId).toBe(session1.sessionId);
    expect(handoffSendLog?.data?.loginSessionId).toBe(loginSession1.sessionId);
    expect(handoffSendLog?.data?.lobbyEntrySignalObserved).toBe(false);
    expect(handoffSendLog?.data?.serverOpcodes).toEqual([
      "13 (LobbyStageTransition)",
      "75 (QuestConfigSync)",
    ]);
    expect(handoffSendLog?.data?.opcode13PayloadBytes).toBe(1);
    expect(handoffSendLog?.data?.clientStageLifecyclePath).toBe(
      "sub_4B96B1 -> sub_5AAA5C(StageId 11) -> CMainSystem::sub_5AA3F4 -> sub_5AEF3F(CMainWnd*)"
    );
    expect(handoffSendLog?.data?.clientStageLifecycleRuntimeVerified).toBe(false);
    expect(handoffSendLog?.data?.clientAcceptanceVerified).toBe(false);

    // `CStage::sub_4B94A6` may request channel data again after reconnect. On the
    // GameServer/Lobby session this is not a second LoginServer handoff.
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.RequestChannelList).writeU32(0));
    expect(client1.popByOpcode(ServerOpcode.ChannelListSsd)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.ChannelLoads)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.MessengerHandoff)).toBeUndefined();

    // S->C 75's client handler emits C->S 83 after requesting any conditional
    // C->S 9 update. This is an observed Lobby-entry signal, not proof of UI dismissal.
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.EnterLobby));
    expect(session1.stageId).toBe(StageId.Lobby);
    expect(session1.pendingStageId).toBeNull();
    expect(session1.lobbyEntryPacketSeen).toBe(true);

    // This flow enables feature 32 above, so use the empty C->S 338 path to obtain S->C 207.
    // The default Taiwan C->S 83 -> S->C 207 path is asserted in the separate handoff test below.
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.PostStageSync338));
    const p207 = client1.popByOpcode(ServerOpcode.DynamicMapAndStageConfig)!;
    expect(p207).toBeDefined();
    expect(p207.readU8()).toBe(0); // opaque stage/config field; local reconstruction default
    const declaredDynMapBodyChecksum = p207.readU32();
    expect(declaredDynMapBodyChecksum).toBe(state.resources.ssdFiles.fxdynmapinfo.adler32Zero);
    expect(p207.readU8()).toBe(0); // macroDetectorFlag
    expect(p207.readU16()).toBe(0); // val9757A0 (semantics unresolved)
    expect(p207.readU32()).toBe(0); // val9757A4 (semantics unresolved)
    expect(p207.readU8()).toBe(0); // extraCount
    expect(p207.remaining).toBe(0);

    // Manual packet injection exercises only the server's C->S 282 -> S->C 205 path;
    // it does not run the official Client's checksum comparison after S->C 207.
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.RequestDynamicMapInfoSsd));
    const p205 = client1.popByOpcode(ServerOpcode.DynamicMapInfoSsdStream)!;
    expect(p205).toBeDefined();
    const dynMapContainer = p205.readSmartStreamBuffer();
    // `sub_4DFE20` compares the received packed SmartStream body checksum with S->C 207's declaration.
    expect(computeSmartStreamBodyChecksum(dynMapContainer)).toBe(declaredDynMapBodyChecksum);
    const dynMapStream = SmartStreamReader.fromSmartStreamBuffer(dynMapContainer);
    expect(verifySmartStreamSchema("fxdynmapinfo.ssd", dynMapStream.bytes)).toEqual({
      entryCount: 871,
      remaining: 0,
    });
    expect(p205.remaining).toBe(0);

    // 6. Consume the Lobby sync frames queued after the earlier C->S 83, then query User Info.
    expect(client1.popByOpcode(89)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.UserDynamicInfoFieldSync186)).toBeDefined();
    const p194_init = client1.popByOpcode(ServerOpcode.InventoryData)!;
    expect(p194_init).toBeDefined();
    expect(p194_init.readU8()).toBe(1); // playerCount = 1
    expect(p194_init.readI32()).toBeGreaterThanOrEqual(1); // starter inventory item
    expect(p194_init.readU32()).toBe(1001); // stockId = 1001
    expect(client1.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.InventoryExpansionSlots)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.CoupleInfoSync)).toBeDefined();

    const lobbyInitLog = getRecentLogs().findLast((entry) => entry.category === "LobbyInit");
    expect(lobbyInitLog?.data?.clientRequest).toBe("83 (EnterLobby)");
    expect(lobbyInitLog?.data?.linkedLoginSessionId).toBe(loginSession1.sessionId);
    expect(lobbyInitLog?.data?.lobbyEntrySignalObserved).toBe(true);
    expect(lobbyInitLog?.data?.clientUiModalStateObservable).toBe(false);
    expect(lobbyInitLog?.data?.playerCount).toBe(1);
    expect(lobbyInitLog?.data?.serverOpcodes).toEqual([
      "89 (ExpSync)",
      "186 (UserDynamicInfoFieldSync186)",
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
    let client2 = new SimulatedClient();
    let session2 = state.createSession(client2.onWireBytes, "127.0.0.1", 51002);
    session2.sendConnectHello(config);
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.LoginBeanfunToken).writeU8(0).writeString("dao_tw")
    );
    const loginResult2 = client2.popByOpcode(ServerOpcode.LoginResult)!;
    expect(loginResult2.readU8()).toBe(0);
    loginResult2.readU16(); // worldId
    expect(loginResult2.readU8()).toBe(1); // one local player
    loginResult2.readU32(); // Lucci
    loginResult2.readU32(); // wins
    loginResult2.readU32(); // losses
    const token2 = loginResult2.readU32();
    expect(token2).toBeGreaterThan(0);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.RequestChannelList).writeU32(0)
    );
    expect(client2.popByOpcode(ServerOpcode.ChannelListSsd)?.readU8()).toBe(1);
    expect(client2.popByOpcode(ServerOpcode.ChannelLoads)).toBeDefined();
    expect(client2.popByOpcode(ServerOpcode.MessengerHandoff)).toBeDefined();
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.SelectChannel).writeU8(10).writeU32(0)
    );
    expect(client2.popByOpcode(ServerOpcode.ChannelSelectResult)?.readU8()).toBe(1);

    const loginSession2 = session2;
    state.removeSession(loginSession2.sessionId);
    client2 = new SimulatedClient();
    session2 = state.createSession(
      client2.onWireBytes,
      "127.0.0.1",
      51004,
      "0.0.0.0",
      0,
      "game"
    );
    session2.sendConnectHello(config);
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.SessionHandoff)
        .writeU8(1)
        .writeString("dao_tw")
        .writeU32(token2)
        .writeU32(0)
        .writeU8(1)
        .writeU32(0)
        .writeU32(0)
    );
    expect(client2.popByOpcode(ServerOpcode.LobbyStageTransition)?.readU8()).toBe(0);
    expect(client2.popByOpcode(ServerOpcode.QuestConfigSync)?.readU32()).toBe(0);
    expect(session2.stageId).toBe(StageId.SelectServer);
    expect(session2.pendingStageId).toBe(StageId.Lobby);
    client2.sendToServer(state, session2.sessionId, new PacketWriter(ClientOpcode.EnterLobby));
    expect(session2.stageId).toBe(StageId.Lobby);
    // Feature 32 is enabled for this flow, so the source-confirmed empty C->S 338
    // elicits S->C 207, the Lobby code path that closes a pending LoadingChannelInfo notice.
    client2.sendToServer(state, session2.sessionId, new PacketWriter(ClientOpcode.PostStageSync338));
    const client2StageConfig = client2.popByOpcode(ServerOpcode.DynamicMapAndStageConfig)!;
    expect(client2StageConfig.readU8()).toBe(0);
    expect(client2StageConfig.readU32()).toBe(state.resources.ssdFiles.fxdynmapinfo.adler32Zero);
    expect(client2StageConfig.readU8()).toBe(0);
    expect(client2StageConfig.readU16()).toBe(0);
    expect(client2StageConfig.readU32()).toBe(0);
    expect(client2StageConfig.readU8()).toBe(0);
    expect(client2StageConfig.remaining).toBe(0);
    for (const opcode of [
      ServerOpcode.ExpSync,
      ServerOpcode.UserDynamicInfoFieldSync186,
      ServerOpcode.InventoryData,
      ServerOpcode.EquippedAvatarData,
      ServerOpcode.InventoryExpansionSlots,
      ServerOpcode.CoupleInfoSync,
    ]) {
      client2.popByOpcode(opcode);
    }

    // Local reconstruction policy only: C->S 303 has multiple Client writers, this Lobby/Prepare
    // caller includes a byte, while CShopStage::sub_5382EA sends only the opcode. These tests do not
    // establish an official S->C 186 response association or the meaning of either field.
    const lobbyUser = session2.users[0]!;
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.ContextualClientPacket303).writeU8(0)
    );
    const p186Indexed = client2.popByOpcode(ServerOpcode.UserDynamicInfoFieldSync186)!;
    expect(p186Indexed.readU32()).toBe(0);
    expect(p186Indexed.readU32()).toBe(lobbyUser.lucci);
    expect(p186Indexed.remaining).toBe(0);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.ContextualClientPacket303)
    );
    const p186Empty = client2.popByOpcode(ServerOpcode.UserDynamicInfoFieldSync186)!;
    expect(p186Empty.readU32()).toBe(0);
    expect(p186Empty.readU32()).toBe(lobbyUser.lucci);
    expect(p186Empty.remaining).toBe(0);

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
      new PacketWriter(ClientOpcode.Whisper).writeString("dao_tw").writeString("GLHF!")
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

    // 12. Local UDP keepalive candidate: 6B `[u16(0), u32(userId)]` -> 1B `[u8(4)]` policy; sender/direction and production behavior are unverified.
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
    const shopRequestStage = session1.stageId;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestShopConnection).writeU8(11).writeU32(0)
    );
    const shopRequestTrace = getRecentLogs().findLast(
      (entry) =>
        entry.category === "ShopTrace" &&
        entry.data?.opcode === formatClientOpcode(ClientOpcode.RequestShopConnection)
    );
    expect(shopRequestTrace?.data?.direction).toBe("C->S");
    expect(shopRequestTrace?.data?.sessionId).toBe(session1.sessionId);
    expect(shopRequestTrace?.data?.connectionKind).toBe("game");
    expect(shopRequestTrace?.data?.stageId).toBe(formatStageId(shopRequestStage));
    expect(shopRequestTrace?.data?.remotePort).toBe(session1.remotePort);
    expect(shopRequestTrace?.data?.payloadBytes).toBe(5);
    expect(client1.popByOpcode(ServerOpcode.ShopConnectionPermission)?.readU8()).toBe(1);
    expect(client1.popByOpcode(ServerOpcode.ShopServerEndpoint)?.readU8()).toBe(1);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.AuthenticateShopConnection)
    );
    const shopAuthTrace = getRecentLogs().findLast(
      (entry) =>
        entry.category === "ShopTrace" &&
        entry.data?.opcode === formatClientOpcode(ClientOpcode.AuthenticateShopConnection)
    );
    expect(shopAuthTrace?.data?.sessionId).toBe(session1.sessionId);
    expect(shopAuthTrace?.data?.connectionKind).toBe("game");
    expect(shopAuthTrace?.data?.payloadBytes).toBe(0);
    expect(shopAuthTrace?.data?.candidateRole).toBe("conditional follow-up");
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
    expect(client1.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
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
      new PacketWriter(ClientOpcode.RequestStringTableIni)
    );
    expect(client1.popByOpcode(ServerOpcode.MarketExpiredReturns)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.MarketSoldNotifications)).toBeUndefined();
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
    expect(client1.popByOpcode(ServerOpcode.ShopLocalStockList198)).toBeDefined();

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopAction).writeU8(3).writeU32(2005).writeU8(1)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopEquipResult)).toBeDefined();

    // 16. Leave Room: CPrepareStage::sub_4D1F0F changes to Lobby locally before C->S 78.
    // The server updates its model and notifies remaining room members with S->C 103;
    // S->C 9 would be parsed by the Client's generic GameServer path as a dump-file offset.
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.LeaveRoom));
    expect(client1.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
    expect(session1.stageId).toBe(StageId.Lobby);
    expect(session1.udpEndpoint).toBeNull();
    expect(state.rooms.get(roomNum)?.slots[0]?.udpEndpoints).toEqual([
      { ip: 0, port: 0 },
      { ip: 0, port: 0 },
      { ip: 0, port: 0 },
    ]);

    const p103 = client2.popByOpcode(ServerOpcode.PlayerLeftSlot)!;
    expect(p103).toBeDefined();
    expect(p103.readU8()).toBe(0); // removed slotIdx
    expect(p103.readU32()).toBe(session1.netSlotIds[0]); // removed slot's own NetID
    expect(p103.readU8()).toBe(0); // hasSuperChiefItem / leave reason flag
    expect(p103.remaining).toBe(0);

    // 17. UserMarket packet sequence. The source confirms the client writers/readers;
    // this local server's response sequence is tested separately from production behavior.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestUserMarketConnection)
    );
    const permission262 = client1.popByOpcode(ServerOpcode.UserMarketPermission)!;
    expect(permission262.readU8()).toBe(1);
    expect(permission262.remaining).toBe(0);
    const feeInfo265 = client1.popByOpcode(ServerOpcode.UserMarketFeeInfo)!;
    expect(feeInfo265.readU32()).toBe(5);
    expect(feeInfo265.readString()).toBe("");
    expect(feeInfo265.readU32()).toBe(100);
    expect(feeInfo265.remaining).toBe(0);
    expect(session1.stageId).toBe(StageId.Lobby); // S->C 262 is permission, not the stage transition.

    // CStage::sub_4BB408 copies S->C 265 into a C->S 320 [u32, str, u32].
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketFeeInfoReply320)
        .writeU32(5)
        .writeString("")
        .writeU32(100)
    );
    const enterResult269 = client1.popByOpcode(ServerOpcode.UserMarketEnterResult)!;
    expect(enterResult269.readU8()).toBe(1);
    expect(enterResult269.remaining).toBe(0);
    expect(session1.stageId).toBe(StageId.UserMarket);

    // CUserMarketStage::sub_5723F6 writes two u8 fields; an empty C->S 321 is not a leave.
    const receivedPacketCountBefore321 = client1.receivedPackets.length;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketStageEntry321).writeU8(1).writeU8(0)
    );
    expect(client1.receivedPackets).toHaveLength(receivedPacketCountBefore321);
    expect(session1.stageId).toBe(StageId.UserMarket);

    // The same Client function separately sends C->S 98 [u8(0)]. With no room,
    // this reconstruction's room-only handler must not force a Prepare-stage response.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RoomAux98).writeU8(0)
    );
    expect(client1.receivedPackets).toHaveLength(receivedPacketCountBefore321);
    expect(session1.stageId).toBe(StageId.UserMarket);

    // CUserMarketStage::sub_5722B3 writes [u8 localIdx]; inspect the Client-compatible
    // widths for the local reconstruction's initial snapshot, including S->C 272's count.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketStageSync324).writeU8(0)
    );
    const p270 = client1.popByOpcode(ServerOpcode.UserMarketMaxLucci)!;
    expect(p270.readU32()).toBe(2_000_000); // reconstruction fixture only
    expect(p270.remaining).toBe(0);
    const p271 = client1.popByOpcode(ServerOpcode.UserMarketBalance)!;
    expect(p271.readU32()).toBeGreaterThanOrEqual(0);
    expect(p271.remaining).toBe(0);
    const p280 = client1.popByOpcode(ServerOpcode.UserMarketTradeableItems)!;
    const tradeableCount = p280.readI32();
    expect(tradeableCount).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < tradeableCount; i++) p280.readU32();
    expect(p280.remaining).toBe(0);
    const p272 = client1.popByOpcode(ServerOpcode.UserMarketList)!;
    expect(p272.readU16()).toBe(0); // no local demo listings exist yet
    expect(p272.remaining).toBe(0);

    // 18. Real CShopDlg (`269..285`), CGachaponDlg (`307`), CBasketDlg (`313..314`),
    //     CUserMarketStage (`324..330`), CSmsDlg (`297..300`), CCouple (`304..306`), and CExchangeStage (`100..101`)
    // 18a. Shop Buy (`C->S 270`, `sub_58EAEF`), Equip (`C->S 274`, `sub_541682`), Custom Text (`C->S 275`, `sub_48ED44`),
    //      Gift (`C->S 279`, `sub_52C5A2`), Coupon (`C->S 280`, `sub_492CD9`), Resell (`C->S 283`, `sub_58BFE0`),
    //      Gachapon (`C->S 307`), Basket (`C->S 313, 314`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopBuyItem)
        .writeU32(3001) // client item-object field at +8; used as demo item key by this reconstruction
        .writeU32(0) // opaque second u32; meaning unconfirmed
    );
    const p199 = client1.popByOpcode(ServerOpcode.ShopBuyResult)!;
    expect(p199).toBeDefined();
    expect(p199.readU8()).toBe(0); // result = 0 (`sub_52DA5E` success)
    expect(p199.readVariantTime()).toBeGreaterThan(45000);
    expect(client1.popByOpcode(ServerOpcode.ShopLocalStockList198)).toBeDefined();

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
    expect(client1.popByOpcode(ServerOpcode.ShopLocalStockList198)).toBeDefined();

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
    // S->C 203's Client route is CStage case 203 -> sub_4B965F -> sub_5954D2:
    // one u8 playerCount, then one u8 recordCount and the exact record widths below.
    expect(p203.readU8()).toBe(1); // playerCount
    expect(p203.readU8()).toBe(1); // recordCount for the receiver
    expect(p203.readU8()).toBe(200); // local record-type fixture; semantic mapping UNKNOWN
    expect(p203.readU32()).toBe(3002); // local lookup value; Client/database key mapping unverified
    expect(p203.readU32()).toBe(1); // local value fixture
    expect(p203.readU8()).toBe(1); // local flag fixture
    expect(p203.readU16()).toBe(30); // local u16 fixture
    expect(p203.readString()).toBe("bazzi_tw");
    expect(p203.readString()).toBe("Happy Birthday!");
    expect(p203.remaining).toBe(0);

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

    // Resell Item (`C->S 283`, `sub_58BFE0`: object `+8` u32, caller-supplied u32).
    // In this fixture only, 3001 matches the stored `itemId`; this does not establish a
    // client-key-to-SQLite-row-ID mapping.
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

    // A missing inventory item receives the client's explicit result=1 failure branch;
    // it must not credit the fixture refund or claim a successful sale.
    const balanceAfterResell = state.db.getUserById(loggedInUser.id)!.lucci;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopResellItem).writeU32(0xffff_ffff).writeU32(0)
    );
    const failedResell = client1.popByOpcode(ServerOpcode.ShopResellResult)!;
    expect(failedResell.readU8()).toBe(1); // `sub_546D3F` -> `ResellItemFail`
    expect(failedResell.remaining).toBe(0);
    expect(state.db.getUserById(loggedInUser.id)?.lucci).toBe(balanceAfterResell);

    // 18b. Real UserMarket registration, purchase & Lucci transfer (`C->S 326, 330, 329`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketRegisterListing326).writeU32(2005).writeU32(1000)
    );
    const p273 = client1.popByOpcode(ServerOpcode.UserMarketRegisterResult)!;
    expect(p273).toBeDefined();
    expect(p273.readU16()).toBe(0); // local reconstruction result value
    expect(p273.readU32()).toBe(2005); // selected item field echoed by the local fixture
    expect(p273.remaining).toBe(0);

    const listings = state.db.getActiveMarketListings();
    expect(listings.length).toBeGreaterThanOrEqual(1);
    const listingId = listings[0]!.id;

    // S->C 272 and S->C 275 both start with one u16 count, then client-decoded
    // [u32, u32, str, u32, u16] rows. Field meanings are local fixture mappings.
    for (const opcode of [ServerOpcode.UserMarketList, ServerOpcode.UserMarketMySalesList]) {
      const marketRows = client1.popByOpcode(opcode)!;
      expect(marketRows.readU16()).toBe(1);
      expect(marketRows.readU32()).toBe(listingId);
      expect(marketRows.readU32()).toBe(2005);
      expect(marketRows.readString()).toBe("bazzi_tw");
      expect(marketRows.readU32()).toBe(1000);
      expect(marketRows.readU16()).toBe(24);
      expect(marketRows.remaining).toBe(0);
    }

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

    // The observed C->S 329 writer sends [localIdx, amount], with no direction field.
    // This local reconstruction models the dialog path as Market Lucci -> Game Lucci.
    const beforeTransfer = state.db.getUserById(loggedInUser.id)!;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketTransferLucci).writeU8(0).writeU32(500)
    );
    const p276 = client1.popByOpcode(ServerOpcode.UserMarketTransferResult)!;
    expect(p276).toBeDefined();
    expect(p276.readU16()).toBe(0); // local reconstruction success result
    const afterTransfer = state.db.getUserById(loggedInUser.id)!;
    expect(p276.readU32()).toBe(afterTransfer.lucci);
    const afterMarketLucci = afterTransfer.marketLucci ?? afterTransfer.lucci;
    const beforeMarketLucci = beforeTransfer.marketLucci ?? beforeTransfer.lucci;
    expect(p276.readU32()).toBe(afterMarketLucci);
    expect(p276.remaining).toBe(0);
    expect(afterTransfer.lucci).toBe(beforeTransfer.lucci + 500);
    expect(afterMarketLucci).toBe(beforeMarketLucci - 500);

    // 18c. SMS Mailbox (`CSmsDlg` `297..300` -> `S->C 242..246`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.SmsSend)
        .writeString("bazzi_tw")
        .writeString("dao_tw")
        .writeString("GG well played!")
    );
    const p242 = client1.popByOpcode(ServerOpcode.SmsSendResult)!;
    expect(p242.readU8()).toBe(10); // 10 = MessageSuccess
    expect(p242.remaining).toBe(0);
    const p246Notice = client2.popByOpcode(ServerOpcode.SmsNewNotice)!;
    expect(p246Notice.readU8()).toBe(1); // 1 = new mail popup
    expect(p246Notice.remaining).toBe(0);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.SmsQuery).writeString("dao_tw").writeU8(1)
    );
    const p246Unread = client2.popByOpcode(ServerOpcode.SmsNewNotice)!;
    expect(p246Unread.readU8()).toBe(1); // The received message is unread.
    expect(p246Unread.remaining).toBe(0);

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
    const month = p243.readU16();
    const day = p243.readU16();
    const hour = p243.readU16();
    const minute = p243.readU16();
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(31);
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThan(24);
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThan(60);
    expect(p243.readU8()).toBe(0); // newly received / unread
    expect(p243.remaining).toBe(0);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.SmsDelete).writeString("dao_tw").writeU32(smsId)
    );
    const p244 = client2.popByOpcode(ServerOpcode.SmsDeleteResult)!;
    expect(p244.readU8()).toBe(1);
    expect(p244.remaining).toBe(0);
    expect(state.db.getSmsByUser(session2.users[0]!.id).some((mail) => mail.id === smsId)).toBe(false);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.SmsSend)
        .writeString("bazzi_tw")
        .writeString("dao_tw")
        .writeString("Delete-all regression mail")
    );
    const p242Second = client1.popByOpcode(ServerOpcode.SmsSendResult)!;
    expect(p242Second.readU8()).toBe(10);
    expect(p242Second.remaining).toBe(0);
    const p246Second = client2.popByOpcode(ServerOpcode.SmsNewNotice)!;
    expect(p246Second.readU8()).toBe(1);
    expect(p246Second.remaining).toBe(0);
    expect(state.db.getSmsByUser(session2.users[0]!.id)).toHaveLength(1);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.SmsDeleteAll).writeString("dao_tw")
    );
    const p245 = client2.popByOpcode(ServerOpcode.SmsDeleteAllResult)!;
    expect(p245.readU8()).toBe(1);
    expect(p245.remaining).toBe(0);
    expect(state.db.getSmsByUser(session2.users[0]!.id)).toHaveLength(0);

    // CSmsDlg refreshes its list after the acknowledgement; model that follow-up query.
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.SmsQuery).writeString("dao_tw").writeU8(0)
    );
    const p243AfterDeleteAll = client2.popByOpcode(ServerOpcode.SmsList)!;
    expect(p243AfterDeleteAll.readU8()).toBe(15);
    expect(p243AfterDeleteAll.readU8()).toBe(0);
    expect(p243AfterDeleteAll.remaining).toBe(0);

    // 18d. Couple Ring Client readers/writers and local demo response schemas
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.CouplePropose)
        .writeU8(0)
        .writeString("dao_tw")
        .writeString("Be my couple partner!")
    );
    const p252 = client1.popByOpcode(ServerOpcode.CoupleStatus252)!;
    expect(p252).toBeDefined();
    expect(p252.readU8()).toBe(0);
    expect(p252.readU8()).toBe(2); // local status choice
    expect(p252.readString()).toBe("dao_tw");
    expect(p252.readString()).toBe(""); // second Client-read string; meaning UNKNOWN
    expect(p252.remaining).toBe(0);
    const p251 = client2.popByOpcode(ServerOpcode.CoupleProposeIncoming)!;
    expect(p251).toBeDefined();
    expect(p251.readU8()).toBe(0);
    expect(p251.readString()).toBe("bazzi_tw");
    expect(p251.readString()).toBe("Be my couple partner!");
    expect(p251.readU8()).toBe(1);
    expect(p251.remaining).toBe(0);

    // Unknown target path uses the same full S->C 252 Client-read prefix, without
    // asserting that the local status choice or response association is official.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.CouplePropose)
        .writeU8(0)
        .writeString("missing_couple_target")
        .writeString("opaque local test message")
    );
    const p252MissingTarget = client1.popByOpcode(ServerOpcode.CoupleStatus252)!;
    expect(p252MissingTarget.readU8()).toBe(0);
    expect(p252MissingTarget.readU8()).toBe(3);
    expect(p252MissingTarget.readString()).toBe("missing_couple_target");
    expect(p252MissingTarget.readString()).toBe("");
    expect(p252MissingTarget.remaining).toBe(0);

    // Exercise the local rejection builder, whose S->C 252 body also includes two strings.
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.CoupleRespond).writeU8(0).writeU8(0)
    );
    const p252Rejected = client1.popByOpcode(ServerOpcode.CoupleStatus252)!;
    expect(p252Rejected.readU8()).toBe(0);
    expect(p252Rejected.readU8()).toBe(14);
    expect(p252Rejected.readString()).toBe("dao_tw");
    expect(p252Rejected.readString()).toBe("");
    expect(p252Rejected.remaining).toBe(0);

    // A fresh local proposal re-establishes the demo pair for the status-253 reader check below.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.CouplePropose)
        .writeU8(0)
        .writeString("dao_tw")
        .writeString("Second local test proposal")
    );
    const p252Retry = client1.popByOpcode(ServerOpcode.CoupleStatus252)!;
    expect(p252Retry.readU8()).toBe(0);
    expect(p252Retry.readU8()).toBe(2);
    expect(p252Retry.readString()).toBe("dao_tw");
    expect(p252Retry.readString()).toBe("");
    expect(p252Retry.remaining).toBe(0);
    const p251Retry = client2.popByOpcode(ServerOpcode.CoupleProposeIncoming)!;
    expect(p251Retry.readU8()).toBe(0);
    expect(p251Retry.readString()).toBe("bazzi_tw");
    expect(p251Retry.readString()).toBe("Second local test proposal");
    expect(p251Retry.readU8()).toBe(1);
    expect(p251Retry.remaining).toBe(0);

    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.CoupleRespond).writeU8(0).writeU8(1)
    );
    const p253 = client2.popByOpcode(ServerOpcode.CoupleStatus253)!;
    expect(p253).toBeDefined();
    expect(p253.readU8()).toBe(0);
    expect(p253.readU8()).toBe(12); // Local status choice; exact official association UNKNOWN.
    expect(p253.readString()).toBe("bazzi_tw");
    expect(p253.remaining).toBe(0); // `sub_5BBAA7` reads only u8, u8, str.
    const p253ToPartner = client1.popByOpcode(ServerOpcode.CoupleStatus253)!;
    expect(p253ToPartner.readU8()).toBe(0);
    expect(p253ToPartner.readU8()).toBe(12);
    expect(p253ToPartner.readString()).toBe("dao_tw");
    expect(p253ToPartner.remaining).toBe(0);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.CoupleBreakup).writeU8(0)
    );
    const p254Actor = client1.popByOpcode(ServerOpcode.CoupleBreakupNotice)!;
    expect(p254Actor.readU8()).toBe(0);
    expect(p254Actor.remaining).toBe(0);
    const p254Partner = client2.popByOpcode(ServerOpcode.CoupleBreakupNotice)!;
    expect(p254Partner.readU8()).toBe(0);
    expect(p254Partner.remaining).toBe(0);

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

    // The Client emits 290/68/293 from one user-page routine, but no reply association is
    // established. Do not infer S->C 242, 34, or 220 merely because separate parsers exist.
    for (const opcode of [
      ClientOpcode.UserPagePacket290,
      ClientOpcode.UserPagePacket68,
      ClientOpcode.UserPagePacket293,
    ]) {
      client1.sendToServer(
        state,
        session1.sessionId,
        new PacketWriter(opcode).writeString("dao_tw")
      );
    }
    expect(client1.popByOpcode(ServerOpcode.SmsSendResult)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.NexonClubDialogStatus34)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.MyPageData220)).toBeUndefined();

    // Chat Macro (`C->S 40` -> `S->C 50`, `sub_4A27CB`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.MacroListQuery).writeU8(0)
    );
    const p50 = client1.popByOpcode(ServerOpcode.MacroList)!;
    expect(p50).toBeDefined();
    expect(p50.remaining).toBe(0); // Empty body means zero 19-byte records; macro persistence is unsupported.

    // Coupon-code behavior below is local.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RedeemCouponCode).writeU32(5001)
    );
    expect(client1.popByOpcode(ServerOpcode.ShopCouponResult)?.readU8()).toBe(1);

    // The Client has S->C 213 as an NXClub result parser, but this local C->S 284 -> S->C 213
    // response is not proven as official behavior.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.NexonClubAuth)
        .writeU8(0)
        .writeString("bazzi_club")
        .writeString("club_pass")
    );
    const p213 = client1.popByOpcode(ServerOpcode.NexonClubAuthResult)!;
    expect(p213).toBeDefined();
    expect(p213.readU8()).toBe(1);
    expect(p213.readU8()).toBe(0);
    expect(p213.readString()).toBe("bazzi_club");

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

    // C->S 34/35 registration forms have source-backed but distinct grammars;
    // their response/backend association is UNKNOWN, so they do not create users or reply.
    const queuedPacketsBeforeUnknownForms = client1.receivedPackets.length;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UnresolvedClientPacket34).writeU8(0).writeString("new_hero_tw")
    );
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UnresolvedClientPacket35)
        .writeString("new_hero_tw")
        .writeString("secret123")
        .writeString("field-3")
        .writeString("field-4")
        .writeString("field-5")
        .writeU8(1)
        .writeString("field-6")
        .writeString("field-7")
    );
    expect(client1.receivedPackets).toHaveLength(queuedPacketsBeforeUnknownForms);
    expect(state.db.getUserByUsername("new_hero_tw")).toBeNull();

    // The source-backed C->S 46 writer has no confirmed response/backend path.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ChangeAccountPassword)
        .writeString("secret123")
        .writeString("newpass456")
        .writeString("newpass456")
    );
    expect(client1.popByOpcode(ServerOpcode.NexonClubDialogStatus34)).toBeUndefined();

    // Opaque test bodies here exercise routing only; they do not assert E-Key wire schemas.
    for (const opcode of [ClientOpcode.EKeyVerify, ClientOpcode.EKeyChallengeResponse]) {
      client1.sendToServer(
        state,
        session1.sessionId,
        new PacketWriter(opcode).writeString("opaque-e-key-input")
      );
    }
    expect(client1.popByOpcode(ServerOpcode.NexonClubDialogStatus34)).toBeUndefined();
    expect(state.db.getUserByUsername("bazzi_tw")?.password).toBe("pass123");
  });

  test("parses C->S 309's leading Nexon Pass string before the opaque u32 pair", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51007, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    const user = state.db.createUser("pass_buyer", "test-password");
    const startingLucci = user.lucci;
    session.users = [user];

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ShopBuyItemPass)
        .writeString("fixture-pass")
        .writeU32(3002)
        .writeU32(0xdead_beef)
    );

    const result = client.popByOpcode(ServerOpcode.ShopBuyResult)!;
    expect(result.readU8()).toBe(0);
    expect(result.readVariantTime()).toBeGreaterThan(45000);
    expect(state.db.getUserStock(user.id).some((item) => item.itemCode === 3002)).toBe(true);
    expect(state.db.getUserById(user.id)?.lucci).toBe(startingLucci - 100);
  });

  test("failed demo purchase returns only the client's failure result and grants no stock", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51006, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    const user = state.db.createUser("no_funds", "test-password");
    state.db.updateUserCurrency(user.id, 0, 0);
    session.users = [user];
    const inventoryCount = state.db.getUserStock(user.id).length;

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ShopBuyItem).writeU32(3001).writeU32(0)
    );

    const result = client.popByOpcode(ServerOpcode.ShopBuyResult)!;
    expect(result.readU8()).toBe(1); // `sub_58EBFE`'s purchase-error path
    expect(result.remaining).toBe(0);
    expect(state.db.getUserStock(user.id)).toHaveLength(inventoryCount);
    expect(state.db.getUserById(user.id)?.lucci).toBe(0);
    expect(state.db.getUserById(user.id)?.cash).toBe(0);
    expect(client.popByOpcode(ServerOpcode.InventoryUpdate)).toBeUndefined();
    expect(client.popByOpcode(ServerOpcode.ShopLocalUpdate190)).toBeUndefined();
  });

  test("rejects an unknown GameServer handoff token without creating a user or entering Lobby", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(
      client.onWireBytes,
      "127.0.0.1",
      51005,
      "0.0.0.0",
      0,
      "game"
    );
    session.sendConnectHello(config);

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.SessionHandoff)
        .writeU8(1)
        .writeString("untrusted_user")
        .writeU32(0xdead_beef)
        .writeU32(0)
        .writeU8(1)
        .writeU32(0)
        .writeU32(0)
    );

    expect(client.popByOpcode(ServerOpcode.LobbyStageTransition)).toBeUndefined();
    expect(client.popByOpcode(ServerOpcode.QuestConfigSync)).toBeUndefined();
    expect(session.stageId).toBe(StageId.SelectServer);
    expect(session.users).toHaveLength(0);
    expect(state.db.getUserByUsername("untrusted_user")).toBeNull();
    expect(
      getRecentLogs().some(
        (entry) =>
          entry.category === "SessionHandoff" &&
          entry.message === "Rejected GameServer session handoff; no Lobby transition sent" &&
          entry.data?.rejectionReason === "no-auth-session-for-token"
      )
    ).toBe(true);
  });

  test("failed listener startup rolls back ports and can be retried", async () => {
    const gameTcpReservation = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const gameTcpPort = gameTcpReservation.port;
    gameTcpReservation.stop(true);

    const occupiedGameUdp = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    let udpReservationOpen = true;
    const server = new CrazyArcadeServer({
      host: "127.0.0.1",
      tcpPort: 0,
      udpPort: 0,
      gameTcpPort,
      gameUdpPort: occupiedGameUdp.port,
      dbPath: ":memory:",
    });

    try {
      await expect(server.start()).rejects.toThrow();
      expect(server.config.tcpPort).toBe(0);
      expect(server.config.udpPort).toBe(0);
      expect(server.config.gameTcpPort).toBe(gameTcpPort);
      expect(server.config.gameUdpPort).toBe(occupiedGameUdp.port);

      occupiedGameUdp.close();
      udpReservationOpen = false;
      const ports = await server.start();
      expect(ports.tcpPort).toBeGreaterThan(0);
      expect(ports.udpPort).toBeGreaterThan(0);
      expect(ports.gameTcpPort).toBe(gameTcpPort);
      expect(ports.gameUdpPort).toBe(occupiedGameUdp.port);
    } finally {
      if (udpReservationOpen) occupiedGameUdp.close();
      server.stop();
    }
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
      expect(() => server.stop()).not.toThrow();
      await expect(server.start()).rejects.toThrow("CrazyArcadeServer has been stopped");
      await Bun.sleep(10);

      const closeLog = getRecentLogs().findLast(
        (entry) =>
          entry.category === "TCP" &&
          entry.message.startsWith("LoginServer TCP socket closed\n") &&
          entry.data?.sessionId === sessionId
      );
      expect(closeLog?.data?.closeInitiator).toBe("server-requested");
      expect(closeLog?.data?.serverCloseReason).toBe("server-shutdown");
      expect(closeLog?.data?.serverToClientWriteCalls).toBe(1);
      expect(closeLog?.data?.clientToServerDecodedPackets).toBe(0);
      expect(closeLog?.message).toContain("Packet timeline (S->C entries are socket.write calls");
      expect(closeLog?.message).toContain("S->C [write-call] ConnectHello");
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
    const userDynamicInfo = loginClient.waitForOpcode(ServerOpcode.UserDynamicInfoSync);
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
    const p19 = await userDynamicInfo;
    expect(p19.readU8()).toBe(1);
    expect(p19.readU16()).toBe(1); // source-mapped `user.level` for this new account

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
    const linkedLoginSessionId = [...server.state.sessions.values()].find(
      (session) => session.connectionKind === "login"
    )?.sessionId;
    expect(linkedLoginSessionId).toBeDefined();
    expect(server.state.sessionsByToken.get(authToken)?.loginSessionId).toBe(linkedLoginSessionId);

    // `sub_56C0C8` closes the LoginServer socket before connecting to the advertised GameServer.
    loginClient.close();
    const gameClient = await LiveTcpClient.connect(ports.gameTcpPort);
    let gameSessionId: number | undefined;
    try {
      const lobbyTransition = gameClient.waitForOpcode(ServerOpcode.LobbyStageTransition);
      const questSync = gameClient.waitForOpcode(ServerOpcode.QuestConfigSync);
      gameClient.send(
        new PacketWriter(ClientOpcode.SessionHandoff)
          .writeU8(1)
          .writeString("live_tester")
          .writeU32(authToken) // field95 (`sub_5D92A8`)
          .writeU32(0) // field97 (`sub_5D92F2`); opaque to the server
          .writeU8(1) // `CNetworkFacade+8`; not interpreted as a StageId
          .writeU32(0) // `dword_92AAEC + 888`
          .writeU32(0) // `dword_92AAEC + 892`
      );

      expect((await lobbyTransition).readU8()).toBe(0); // TW feature 22 payload
      expect((await questSync).readU32()).toBe(0);
      // S->C 13 requests StageId.Lobby; S->C 33 maps to the SelectServer dynamic-I16
      // parser, while S->C 9 would be treated as a Crash_CA.dmp offset request.
      expect(gameClient.receivedOpcodes).toEqual([
        ServerOpcode.LobbyStageTransition,
        ServerOpcode.QuestConfigSync,
      ]);
      expect(gameClient.hasQueuedOpcode(ServerOpcode.CrashDumpChunkRequest)).toBe(false);
      expect(gameClient.hasQueuedOpcode(ServerOpcode.SelectServerDynamicI16Data)).toBe(false);

      const gameSession = [...server.state.sessions.values()].find(
        (session) => session.connectionKind === "game"
      );
      gameSessionId = gameSession?.sessionId;
      expect(gameSession?.stageId).toBe(StageId.SelectServer);
      expect(gameSession?.pendingStageId).toBe(StageId.Lobby);
      expect(gameSession?.lobbyEntryPacketSeen).toBe(false);
      expect(gameSession?.linkedLoginSessionId).toBe(linkedLoginSessionId);
      expect(gameSession?.channelIndex).toBe(0);
      expect(gameSession?.users[0]?.username).toBe("live_tester");

      // C->S 8 is a Crash_CA.dmp upload, not the channel-cache CRC request (C->S 9).
      // Follow it with C->S 83 to synchronize on a server reply over the same TCP stream.
      clearRecentLogs();
      const dumpChunk = new Uint8Array(16_000).fill(0xcd);
      const lobbyInit = gameClient.waitForOpcode(ServerOpcode.ExpSync);
      const loadingChannelInfoStageConfig = gameClient.waitForOpcode(
        ServerOpcode.DynamicMapAndStageConfig
      );
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
      const stageConfig207 = await loadingChannelInfoStageConfig;
      expect(stageConfig207.readU8()).toBe(0); // opaque first field; reconstruction placeholder
      expect(stageConfig207.readU32()).toBe(server.state.resources.ssdFiles.fxdynmapinfo.adler32Zero);
      expect(stageConfig207.readU8()).toBe(0);
      expect(stageConfig207.readU16()).toBe(0);
      expect(stageConfig207.readU32()).toBe(0);
      expect(stageConfig207.readU8()).toBe(0);
      expect(stageConfig207.remaining).toBe(0);
      expect(gameSession?.stageId).toBe(StageId.Lobby);
      expect(gameSession?.pendingStageId).toBeNull();
      expect(gameSession?.lobbyEntryPacketSeen).toBe(true);

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
        ServerOpcode.UserDynamicInfoFieldSync186,
        ServerOpcode.InventoryData,
        ServerOpcode.EquippedAvatarData,
        ServerOpcode.InventoryExpansionSlots,
        ServerOpcode.CoupleInfoSync,
        ServerOpcode.DynamicMapAndStageConfig,
      ]);
      expect(lobbyInitPackets.map((entry) => entry.data?.payloadBytes)).toEqual([
        7, 10, 31, 51, 7, 6, 15,
      ]);
      const lobbyInitLog = getRecentLogs().findLast((entry) => entry.category === "LobbyInit");
      expect(lobbyInitLog?.data?.feature32Enabled).toBe(false);
      expect(lobbyInitLog?.data?.stageConfig207WriteCall).toBe(true);
      expect(lobbyInitLog?.data?.clientModalDismissalVerified).toBe(false);
      expect(lobbyInitLog?.data?.serverOpcodes).toEqual([
        "89 (ExpSync)",
        "186 (UserDynamicInfoFieldSync186)",
        "194 (InventoryData)",
        "196 (EquippedAvatarData)",
        "268 (InventoryExpansionSlots)",
        "250 (CoupleInfoSync)",
        "207 (DynamicMapAndStageConfig)",
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
        entry.message.startsWith("GameServer TCP socket closed\n") &&
        entry.data?.sessionId === gameSessionId
    );
    expect(gameCloseLog?.data?.closeInitiator).toBe("unknown");
    expect(gameCloseLog?.data?.serverCloseReason).toBeUndefined();
    expect(gameCloseLog?.data?.clientToServerDecodedPackets).toBe(5);
    expect(gameCloseLog?.data?.serverToClientWriteCalls).toBe(10);
    expect(gameCloseLog?.data?.pendingReceiveBytes).toBe(0);
    expect(gameCloseLog?.data?.lobbyEntryPacketSeen).toBe(true);
    expect(gameCloseLog?.data?.linkedLoginSessionId).toBe(linkedLoginSessionId);
    expect(gameCloseLog?.message).toContain("C->S [decoded] 83 (EnterLobby)");
    expect(gameCloseLog?.message).toContain("S->C [write-call] 89 (ExpSync)");
    expect(gameCloseLog?.message).toContain("S->C [write-call] 207 (DynamicMapAndStageConfig)");
    expect(gameCloseLog?.message).toContain("modal/UI state remains unobservable");
    expect(gameCloseLog?.message).not.toContain("live_tester");
  });
});
