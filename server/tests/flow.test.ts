import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/index.ts";
import { dispatchTcpPacket, dispatchUdpDatagram } from "../src/handlers/dispatcher.ts";
import { finishMatch } from "../src/handlers/gameHandler.ts";
import { announceRoomListAfterLeave } from "../src/handlers/lobbyRoomList.ts";
import { CrazyArcadeServer } from "../src/network/server.ts";
import {
  buildUdpGameLoadRegistration,
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

describe("UDP game-load registration admission", () => {
  test("rejects truncated frames, resolves the active GameServer slot, and makes retries idempotent", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const user = state.db.createUser("udp_load_user", "password");
    const loginClient = new SimulatedClient();
    const gameClient = new SimulatedClient();
    const loginSession = state.createSession(
      loginClient.onWireBytes,
      "203.0.113.51",
      51000,
      "0.0.0.0",
      0,
      "login"
    );
    const gameSession = state.createSession(
      gameClient.onWireBytes,
      "203.0.113.52",
      51001,
      "0.0.0.0",
      0,
      "game"
    );
    loginSession.sendConnectHello(config);
    gameSession.sendConnectHello(config);
    loginSession.users = [user]; // The LoginServer connection can overlap the GameServer reconnect.
    gameSession.users = [user];
    gameSession.netSlotIds = [state.allocateNetSlotId()];

    const room = state.createRoom(gameSession, "UDP registration", "", false, 0, 0, [0]);
    room.isPlaying = true;
    room.startTick = 0x1234;
    gameSession.stageId = StageId.Game;

    const registrationFrame = buildUdpGameLoadRegistration({
      userId: user.id,
      roomId: room.roomNumber,
      roomGameKey: room.chiefSlotNetId,
      localIp0: 0xc0a80119,
      localPort0: 56002,
      localIp1: 0,
      localPort1: 0,
      mapCrc8: 0x11223344,
      player0Attrs: [0xaa, 0xbb, 0xcc, 0xdd],
      player1Attrs: [0x10, 0x20, 0x30, 0x40],
    });
    const fullInner = MTUDPPeer.decodeFrame(registrationFrame)!;
    expect(fullInner).toHaveLength(36);

    // The recovered C->S 113 writers carry at least the packed state byte and two u16
    // coordinates. A 2-byte guess is not a second load-completion channel.
    gameClient.sendToServer(
      state,
      gameSession.sessionId,
      new PacketWriter(ClientOpcode.PlayerStateChange).writeU8(1).writeU8(0)
    );
    expect(room.slots[0]?.loadedGame).toBe(false);
    expect(gameClient.receivedPackets).toHaveLength(0);

    const playerStateChange = new PacketWriter(ClientOpcode.PlayerStateChange)
      .writeU8(0x20) // subtype 2, slot 0
      .writeU16(3)
      .writeU16(4);
    gameSession.stageId = StageId.Prepare;
    gameClient.sendToServer(state, gameSession.sessionId, playerStateChange);
    expect(room.slots[0]?.trapped).toBe(false);
    gameSession.stageId = StageId.Game;
    room.isPlaying = false;
    gameClient.sendToServer(state, gameSession.sessionId, playerStateChange);
    expect(room.slots[0]?.trapped).toBe(false);
    expect(gameClient.receivedPackets).toHaveLength(0);
    room.isPlaying = true;

    // These prefixes have a valid outer MTUDPPeer CRC. The current Client writer is still 36B;
    // a truncated packet must not mark a slot loaded or be attributed to the stale Login session.
    for (let byteCount = 12; byteCount < 36; byteCount++) {
      const truncatedFrame = MTUDPPeer.encodeFrame(fullInner.subarray(0, byteCount));
      expect(dispatchUdpDatagram(state, truncatedFrame, "203.0.113.52", 55001)).toEqual([]);
      expect(room.slots[0]?.loadedGame).toBe(false);
      expect(loginSession.udpEndpoint).toBeNull();
      expect(gameSession.udpEndpoint).toBeNull();
      expect(gameClient.receivedPackets).toHaveLength(0);
    }

    // `[u8(0), u8(1), u8(peerIdx)]` is the Client's 3-byte peer-control shape, not opcode 1.
    expect(
      dispatchUdpDatagram(
        state,
        MTUDPPeer.encodeFrame(new Uint8Array([0, 1, 0])),
        "203.0.113.52",
        55001
      )
    ).toEqual([]);
    expect(room.slots[0]?.loadedGame).toBe(false);

    dispatchUdpDatagram(state, registrationFrame, "203.0.113.52", 55001);
    expect(room.slots[0]?.loadedGame).toBe(true);
    expect(loginSession.udpEndpoint).toBeNull();
    expect(gameSession.udpEndpoint).toEqual({ address: "203.0.113.52", port: 55001 });
    expect(room.slots[0]?.udpEndpoints).toEqual([
      { ip: 0xc0a80119, port: 56002 },
      { ip: 0, port: 0 },
      { ip: 0xcb007134, port: 55001 },
    ]);
    expect(gameClient.receivedPackets.map((packet) => packet.opcode)).toEqual([
      ServerOpcode.PlayerLoadedAck,
      ServerOpcode.AllPlayersLoadedStart,
    ]);
    expect(gameClient.receivedPackets[0]?.readU8()).toBe(0);
    const firstStartTick = room.startTick;

    // Same datagram/source is the Client's retry shape: no duplicate ack or start packet.
    dispatchUdpDatagram(state, registrationFrame, "203.0.113.52", 55001);
    expect(gameClient.receivedPackets.map((packet) => packet.opcode)).toEqual([
      ServerOpcode.PlayerLoadedAck,
      ServerOpcode.AllPlayersLoadedStart,
    ]);
    expect(room.startTick).toBe(firstStartTick);

    // A changed source updates the relay target even when the room-context word differs.
    // The local handler currently does not compare `roomGameKey`; this is not evidence that
    // an official server ignores or validates the Client's `j[92]` value.
    const changedRouteWithDifferentRoomContext = buildUdpGameLoadRegistration({
      userId: user.id,
      roomId: room.roomNumber,
      roomGameKey: room.chiefSlotNetId ^ 1,
      localIp0: 0xc0a80119,
      localPort0: 56002,
      localIp1: 0,
      localPort1: 0,
      mapCrc8: 0x11223344,
      player0Attrs: [0xaa, 0xbb, 0xcc, 0xdd],
      player1Attrs: [0x10, 0x20, 0x30, 0x40],
    });
    // The reconstruction does not resend S->C 135 after setup because that Client packet
    // initializes countdown/game state; official route-refresh policy remains unknown.
    dispatchUdpDatagram(state, changedRouteWithDifferentRoomContext, "203.0.113.52", 55002);
    expect(room.slots[0]?.udpEndpoints[2]).toEqual({ ip: 0xcb007134, port: 55002 });
    expect(gameSession.udpEndpoint).toEqual({ address: "203.0.113.52", port: 55002 });
    expect(gameClient.receivedPackets.map((packet) => packet.opcode)).toEqual([
      ServerOpcode.PlayerLoadedAck,
      ServerOpcode.AllPlayersLoadedStart,
    ]);
    expect(room.startTick).toBe(firstStartTick);
  });
});

describe("C->S 21 MessengerInviteUser writer variants", () => {
  test("accepts callers with no trailing flag and caller-specific zero/one flags", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const senderUser = state.db.createUser("invite_sender", "password");
    const targetUser = state.db.createUser("invite_target", "password");
    const senderClient = new SimulatedClient();
    const targetClient = new SimulatedClient();
    const senderSession = state.createSession(senderClient.onWireBytes, "203.0.113.70", 51020);
    const targetSession = state.createSession(targetClient.onWireBytes, "203.0.113.71", 51021);
    senderSession.users = [senderUser];
    targetSession.users = [targetUser];
    senderSession.sendConnectHello(config);
    targetSession.sendConnectHello(config);

    // Client writers: sub_4DB16C/sub_5E9F86 have no suffix; sub_55AAF0 adds 0;
    // sub_4B4F83 adds 1. The responses below are this reconstruction's whisper fallback only.
    for (const callerFlag of [null, 0, 1] as const) {
      const invite = new PacketWriter(ClientOpcode.MessengerInviteUser)
        .writeU16(17)
        .writeU32(0x12345678)
        .writeString(targetUser.username);
      if (callerFlag !== null) invite.writeU8(callerFlag);

      senderClient.sendToServer(state, senderSession.sessionId, invite);
      const notice = targetClient.popByOpcode(ServerOpcode.WhisperOrEmotion);
      expect(notice?.readString()).toBe(`${senderUser.username} : [Invite to Room #17]`);
      expect(notice?.remaining).toBe(0);
      const delivery = senderClient.popByOpcode(ServerOpcode.WhisperDeliveryStatus);
      expect(delivery?.readU8()).toBe(1);
      expect(delivery?.remaining).toBe(0);
    }

    expect(senderClient.receivedPackets).toHaveLength(0);
    expect(targetClient.receivedPackets).toHaveLength(0);
  });
});

describe("Lobby room writers are parsed as exact, distinct Client layouts", () => {
  test("handles 75/76/77/79/81 variants without guessing counts, password markers, or tails", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);

    const makeLobbySession = (username: string, count = 1) => {
      const client = new SimulatedClient();
      const session = state.createSession(
        client.onWireBytes,
        "203.0.113.150",
        51150 + state.sessions.size,
        "0.0.0.0",
        0,
        "game"
      );
      session.users = Array.from({ length: count }, (_, index) =>
        state.db.createUser(`${username}_${index}`, "password")
      );
      session.netSlotIds = session.users.map(() => state.allocateNetSlotId());
      session.equippedCharIds = session.users.map(() => 0);
      session.channelSelected = true;
      session.channelIndex = 0;
      session.stageId = StageId.Lobby;
      session.sendConnectHello(config);
      return { client, session };
    };

    const creator = makeLobbySession("exact_create", 2);
    // A truncated 75 with a two-local count must not synthesize a missing char ID/default.
    creator.client.sendToServer(
      state,
      creator.session.sessionId,
      new PacketWriter(ClientOpcode.CreateRoom)
        .writeString("Truncated")
        .writeString("")
        .writeU8(0)
        .writeU8(2)
        .writeU8(0)
    );
    expect(state.rooms.size).toBe(0);
    expect(creator.session.currentRoomNumber).toBeNull();
    expect(creator.client.receivedPackets).toHaveLength(0);

    creator.client.sendToServer(
      state,
      creator.session.sessionId,
      new PacketWriter(ClientOpcode.CreateRoom)
        .writeString("Exact public room")
        .writeString("")
        .writeU8(0) // opaque prefix byte
        .writeU8(2)
        .writeU8(0)
        .writeU8(1)
        .writeU8(2) // opaque one-byte tail candidate
        .writeU32(0x1234_5607) // opaque four-byte tail candidate
    );
    const publicRoom = state.rooms.get(creator.session.currentRoomNumber!)!;
    expect(publicRoom.name).toBe("Exact public room");
    expect(publicRoom.hasPassword).toBe(false);
    expect(publicRoom.gameMode).toBe(2); // local mapping only
    expect(publicRoom.mapTheme).toBe(7); // local low-byte mapping only
    expect(creator.session.roomSlotIndices.map((idx) => publicRoom.slots[idx]!.charId)).toEqual([0, 1]);
    expect(creator.client.popByOpcode(ServerOpcode.CreateRoomResult)).toBeDefined();
    expect(creator.client.popByOpcode(ServerOpcode.SetPlayerOnPrepare)).toBeUndefined();
    creator.client.sendToServer(
      state,
      creator.session.sessionId,
      new PacketWriter(ClientOpcode.ClientPeriodicStatus).writeU32(1).writeU32(2)
    );
    expect(creator.client.popByOpcode(ServerOpcode.SetPlayerOnPrepare)).toBeDefined();
    expect(creator.client.popByOpcode(ServerOpcode.SetPlayerOnPrepare)).toBeDefined();

    const emptyPasswordJoiner = makeLobbySession("empty_password_join");
    // The normal 76 writer always includes an empty length-prefixed string. After room/context,
    // that valid one-user body is exactly four bytes; do not infer a string from total length.
    emptyPasswordJoiner.client.sendToServer(
      state,
      emptyPasswordJoiner.session.sessionId,
      new PacketWriter(ClientOpcode.JoinRoom)
        .writeU16(publicRoom.roomNumber)
        .writeU32(0x1122_3344)
        .writeString("")
        .writeU8(1)
        .writeU8(3)
    );
    expect(emptyPasswordJoiner.session.currentRoomNumber).toBe(publicRoom.roomNumber);
    expect(publicRoom.slots[emptyPasswordJoiner.session.roomSlotIndices[0]!]!.charId).toBe(3);
    expect(emptyPasswordJoiner.client.popByOpcode(ServerOpcode.JoinRoomResult)).toBeDefined();

    const inviteMarkerJoiner = makeLobbySession("invite_marker_join");
    inviteMarkerJoiner.client.sendToServer(
      state,
      inviteMarkerJoiner.session.sessionId,
      new PacketWriter(ClientOpcode.JoinRoom)
        .writeU16(publicRoom.roomNumber)
        .writeU32(0x5566_7788)
        .writeU8(0) // separate invite-writer marker; no password string
        .writeU8(1)
        .writeU8(2)
    );
    expect(inviteMarkerJoiner.session.currentRoomNumber).toBe(publicRoom.roomNumber);
    expect(publicRoom.slots[inviteMarkerJoiner.session.roomSlotIndices[0]!]!.charId).toBe(2);

    const mismatchedLocalCount = makeLobbySession("count_mismatch_join", 2);
    const occupiedBeforeMismatch = publicRoom.slots.filter((slot) => slot.occupied).length;
    mismatchedLocalCount.client.sendToServer(
      state,
      mismatchedLocalCount.session.sessionId,
      new PacketWriter(ClientOpcode.JoinRoom)
        .writeU16(publicRoom.roomNumber)
        .writeU32(0)
        .writeString("")
        .writeU8(1)
        .writeU8(0)
    );
    expect(mismatchedLocalCount.session.currentRoomNumber).toBeNull();
    expect(publicRoom.slots.filter((slot) => slot.occupied)).toHaveLength(occupiedBeforeMismatch);
    expect(mismatchedLocalCount.client.receivedPackets).toHaveLength(0);

    const passwordCreator = makeLobbySession("password_create");
    passwordCreator.client.sendToServer(
      state,
      passwordCreator.session.sessionId,
      new PacketWriter(ClientOpcode.CreateRoom)
        .writeString("Password room")
        .writeString("local-pass")
        .writeU8(1)
        .writeU8(1)
        .writeU8(0)
        .writeU8(0)
        .writeU32(0)
    );
    const passwordRoom = state.rooms.get(passwordCreator.session.currentRoomNumber!)!;
    expect(passwordRoom.hasPassword).toBe(true);

    const unverifiedInvite = makeLobbySession("unverified_invite");
    unverifiedInvite.client.sendToServer(
      state,
      unverifiedInvite.session.sessionId,
      new PacketWriter(ClientOpcode.JoinRoom)
        .writeU16(passwordRoom.roomNumber)
        .writeU32(0)
        .writeU8(0)
        .writeU8(1)
        .writeU8(0)
    );
    expect(unverifiedInvite.session.currentRoomNumber).toBeNull();
    expect(unverifiedInvite.client.popByOpcode(ServerOpcode.JoinRoomResult)?.readU8()).toBe(1);

    const regionalPasswordJoiner = makeLobbySession("regional_password_join");
    regionalPasswordJoiner.client.sendToServer(
      state,
      regionalPasswordJoiner.session.sessionId,
      new PacketWriter(ClientOpcode.JoinRoom)
        .writeU16(passwordRoom.roomNumber)
        .writeU32(0x99)
        .writeU8(1) // region-128 writer prefix; runtime region is not inferred here
        .writeString("local-pass")
        .writeU8(1)
        .writeU8(2)
    );
    expect(regionalPasswordJoiner.session.currentRoomNumber).toBe(passwordRoom.roomNumber);
    expect(passwordRoom.slots[regionalPasswordJoiner.session.roomSlotIndices[0]!]!.charId).toBe(2);

    const opaqueU32TailCreator = makeLobbySession("opaque_u32_tail");
    opaqueU32TailCreator.client.sendToServer(
      state,
      opaqueU32TailCreator.session.sessionId,
      new PacketWriter(ClientOpcode.CreateRoom)
        .writeString("Opaque u32 tail room")
        .writeString("")
        .writeU8(0)
        .writeU8(1)
        .writeU8(0)
        .writeU32(0x8765_4321)
    );
    const opaqueU32TailRoom = state.rooms.get(opaqueU32TailCreator.session.currentRoomNumber!)!;
    expect(opaqueU32TailRoom.gameMode).toBe(0);
    expect(opaqueU32TailRoom.mapTheme).toBe(0);

    const shortCreator = makeLobbySession("short_create");
    shortCreator.client.sendToServer(
      state,
      shortCreator.session.sessionId,
      new PacketWriter(ClientOpcode.CreateRoomShort)
        .writeString("Opaque short room")
        .writeU8(0x23) // opaque prefix byte
        .writeU8(1)
        .writeU8(1)
        .writeU8(0x77) // opaque tail byte
        .writeU32(0x7654_3210) // opaque trailing word
    );
    const shortRoom = state.rooms.get(shortCreator.session.currentRoomNumber!)!;
    expect(shortRoom.name).toBe("Opaque short room");
    expect(shortRoom.password).toBe("");
    expect(shortRoom.gameMode).toBe(0);
    expect(shortRoom.mapTheme).toBe(0);

    const quick77 = makeLobbySession("quick_join_77");
    quick77.client.sendToServer(
      state,
      quick77.session.sessionId,
      new PacketWriter(ClientOpcode.QuickJoin).writeU8(1).writeU8(2).writeU8(0xab)
    );
    expect(quick77.session.currentRoomNumber).toBe(publicRoom.roomNumber);
    expect(publicRoom.slots[quick77.session.roomSlotIndices[0]!]!.charId).toBe(2);
    expect(quick77.client.popByOpcode(ServerOpcode.QuickJoinOrUserProfile)?.readU8()).toBe(0);

    const malformedQuick77 = makeLobbySession("malformed_quick_join");
    malformedQuick77.client.sendToServer(
      state,
      malformedQuick77.session.sessionId,
      new PacketWriter(ClientOpcode.QuickJoin).writeU8(1).writeU8(1)
    );
    expect(malformedQuick77.session.currentRoomNumber).toBeNull();
    expect(malformedQuick77.client.receivedPackets).toHaveLength(0);

    const quick81 = makeLobbySession("quick_join_81");
    quick81.client.sendToServer(
      state,
      quick81.session.sessionId,
      new PacketWriter(ClientOpcode.QuickJoinShort).writeU8(1).writeU8(3).writeU32(0xdead_beef)
    );
    expect(quick81.session.currentRoomNumber).toBe(publicRoom.roomNumber);
    expect(publicRoom.slots[quick81.session.roomSlotIndices[0]!]!.charId).toBe(3);
    expect(quick81.client.popByOpcode(ServerOpcode.QuickJoinOrUserProfile)?.readU8()).toBe(0);

    const roomDetailRequester = makeLobbySession("room_detail_67");
    roomDetailRequester.client.sendToServer(
      state,
      roomDetailRequester.session.sessionId,
      new PacketWriter(ClientOpcode.RoomDetailOrUserInfo)
        .writeU16(publicRoom.roomNumber)
        .writeU32(0x1234_5678)
    );
    expect(roomDetailRequester.client.popByOpcode(ServerOpcode.RoomDetailInfo)?.readU8()).toBe(1);

    // C->S 82's opaque context is not used to switch the session into another room.
    quick77.session.stageId = StageId.Shop;
    quick77.client.sendToServer(
      state,
      quick77.session.sessionId,
      new PacketWriter(ClientOpcode.ReturnToRoom)
        .writeU16(passwordRoom.roomNumber)
        .writeU32(0x1234_5678)
    );
    expect(quick77.session.stageId).toBe(StageId.Shop);
    expect(quick77.client.popByOpcode(ServerOpcode.JoinRoomResult)).toBeUndefined();
    const userBeforeShopReturn = state.db.getUserById(quick77.session.users[0]!.id)!;
    quick77.client.sendToServer(
      state,
      quick77.session.sessionId,
      new PacketWriter(ClientOpcode.ReturnToRoom)
        .writeU16(publicRoom.roomNumber)
        .writeU32(0x1234_5678)
    );
    expect(quick77.session.stageId).toBe(StageId.Prepare);
    expect(quick77.session.currentRoomNumber).toBe(publicRoom.roomNumber);
    expect(quick77.client.popByOpcode(ServerOpcode.JoinRoomResult)).toBeDefined();
    expect(state.db.getUserById(quick77.session.users[0]!.id)).toEqual(userBeforeShopReturn);
    const returnToRoomAudit = getRecentLogs().findLast(
      (entry) =>
        entry.category === "PacketAudit" &&
        entry.data?.wireOpcode === ClientOpcode.ReturnToRoom &&
        entry.data?.responseSent === true
    );
    expect(returnToRoomAudit?.data?.sessionStageChanged).toBe(true);
    expect(returnToRoomAudit?.data?.roomStateChanged).toBe(false);
    expect(returnToRoomAudit?.data?.databaseMutation).toBe(false);
    expect(JSON.stringify(returnToRoomAudit)).not.toContain("305419896");

    // The other recovered C->S 82 caller is the Stage-20 UserMarket parser after S->C 99.
    quick77.session.stageId = StageId.UserMarket;
    const userBeforeMarketReturn = state.db.getUserById(quick77.session.users[0]!.id)!;
    quick77.client.sendToServer(
      state,
      quick77.session.sessionId,
      new PacketWriter(ClientOpcode.ReturnToRoom)
        .writeU16(publicRoom.roomNumber)
        .writeU32(0xdead_beef)
    );
    expect(quick77.session.stageId).toBe(StageId.Prepare);
    expect(quick77.session.currentRoomNumber).toBe(publicRoom.roomNumber);
    expect(quick77.client.popByOpcode(ServerOpcode.JoinRoomResult)).toBeDefined();
    expect(state.db.getUserById(quick77.session.users[0]!.id)).toEqual(userBeforeMarketReturn);
  });
});

describe("Lobby room list announcements keep every Lobby viewer's list in sync", () => {
  const makeLobbySession = (
    state: WorldState,
    config: ReturnType<typeof loadConfig>,
    username: string
  ) => {
    const client = new SimulatedClient();
    const session = state.createSession(
      client.onWireBytes,
      "203.0.113.150",
      51150 + state.sessions.size,
      "0.0.0.0",
      0,
      "game"
    );
    session.users = [state.db.createUser(username, "password")];
    session.netSlotIds = session.users.map(() => state.allocateNetSlotId());
    session.equippedCharIds = session.users.map(() => 0);
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.Lobby;
    session.sendConnectHello(config);
    return { client, session };
  };

  /** Parses the S->C 82 row body in `buildLobbyRoomEntryPacket` field order. */
  const parseRoomEntry = (packet: PacketReader) => ({
    roomNumber: packet.readU16(),
    contextWord: packet.readU32(),
    name: packet.readString(),
    occupied: packet.readU8(),
    openCount: packet.readU8(),
    isPlaying: packet.readU8(),
    mapId: packet.readU16(),
    gameMode: packet.readU8(),
    gameSubMode: packet.readU8(),
    hasPassword: packet.readU8(),
    mapTheme: packet.readU32(),
    mapThemeLo: packet.readU8(),
  });

  test("room creation, join, and leave refresh or remove the row for every Lobby viewer", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const viewerA = makeLobbySession(state, config, "list_viewer_a");
    const viewerB = makeLobbySession(state, config, "list_viewer_b");
    const creator = makeLobbySession(state, config, "list_creator");

    creator.client.sendToServer(
      state,
      creator.session.sessionId,
      new PacketWriter(ClientOpcode.CreateRoom)
        .writeString("Announced room")
        .writeString("")
        .writeU8(0)
        .writeU8(1)
        .writeU8(0)
        .writeU8(0)
        .writeU32(0)
    );
    const room = state.rooms.get(creator.session.currentRoomNumber!)!;
    expect(creator.session.stageId).toBe(StageId.Prepare);
    // The creator already left the Lobby audience and must not receive its own row.
    expect(creator.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)).toBeUndefined();
    for (const viewer of [viewerA, viewerB]) {
      const entry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
      expect(entry.roomNumber).toBe(room.roomNumber);
      expect(entry.contextWord).toBe(room.chiefSlotNetId);
      expect(entry.name).toBe("Announced room");
      expect(entry.occupied).toBe(1);
      expect(entry.openCount).toBe(room.slots.filter((slot) => slot.open).length);
      expect(entry.isPlaying).toBe(0);
      expect(entry.mapId).toBe(room.mapId);
      expect(entry.gameMode).toBe(room.gameMode);
      expect(entry.gameSubMode).toBe(room.gameSubMode);
      expect(entry.hasPassword).toBe(0);
      expect(entry.mapTheme).toBe(room.mapTheme);
      expect(entry.mapThemeLo).toBe(room.mapTheme & 0xff);
      // Exactly one row packet per viewer per event.
      expect(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)).toBeUndefined();
    }

    // A join refreshes the same row with the new occupied count.
    const joiner = makeLobbySession(state, config, "list_joiner");
    joiner.client.sendToServer(
      state,
      joiner.session.sessionId,
      new PacketWriter(ClientOpcode.JoinRoom)
        .writeU16(room.roomNumber)
        .writeU32(0x1122_3344)
        .writeString("")
        .writeU8(1)
        .writeU8(3)
    );
    expect(joiner.session.currentRoomNumber).toBe(room.roomNumber);
    for (const viewer of [viewerA, viewerB]) {
      const entry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
      expect(entry.roomNumber).toBe(room.roomNumber);
      expect(entry.occupied).toBe(2);
    }
    // The joiner is already in the room (Prepare) and receives no Lobby row packet.
    expect(joiner.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)).toBeUndefined();

    // Leaving refreshes the row again; the leaver re-enters the Lobby audience and also
    // receives the refreshed row so its local list stays correct.
    joiner.client.sendToServer(
      state,
      joiner.session.sessionId,
      new PacketWriter(ClientOpcode.LeaveRoom)
    );
    expect(joiner.session.currentRoomNumber).toBeNull();
    expect(joiner.session.stageId).toBe(StageId.Lobby);
    for (const viewer of [viewerA, viewerB, joiner]) {
      const entry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
      expect(entry.roomNumber).toBe(room.roomNumber);
      expect(entry.occupied).toBe(1);
    }

    // The last member leaving destroys the room: viewers get S->C 86 with the last context.
    creator.client.sendToServer(
      state,
      creator.session.sessionId,
      new PacketWriter(ClientOpcode.LeaveRoom)
    );
    expect(state.rooms.has(room.roomNumber)).toBe(false);
    for (const viewer of [viewerA, viewerB, joiner, creator]) {
      const removal = viewer.client.popByOpcode(ServerOpcode.LobbyRoomSlotRemove)!;
      expect(removal.readU16()).toBe(room.roomNumber);
      expect(removal.readU32()).toBe(room.chiefSlotNetId);
    }
  });

  test("quick join refreshes the row and a chief disconnect rewrites the row context", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const viewer = makeLobbySession(state, config, "quick_viewer");
    const creator = makeLobbySession(state, config, "quick_creator");
    creator.client.sendToServer(
      state,
      creator.session.sessionId,
      new PacketWriter(ClientOpcode.CreateRoom)
        .writeString("Quick target")
        .writeString("")
        .writeU8(0)
        .writeU8(1)
        .writeU8(0)
        .writeU8(0)
        .writeU32(0)
    );
    const room = state.rooms.get(creator.session.currentRoomNumber!)!;
    viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry);

    const quickJoiner = makeLobbySession(state, config, "quick_joiner");
    quickJoiner.client.sendToServer(
      state,
      quickJoiner.session.sessionId,
      new PacketWriter(ClientOpcode.QuickJoin).writeU8(1).writeU8(2).writeU8(0xab)
    );
    expect(quickJoiner.session.currentRoomNumber).toBe(room.roomNumber);
    const joinedEntry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
    expect(joinedEntry.roomNumber).toBe(room.roomNumber);
    expect(joinedEntry.occupied).toBe(2);

    // The TCP close path: removeSession reports the leave outcome and the caller announces it.
    // The chief disconnect promotes the remaining member, changing the row context word, so
    // the announcement must be a fresh S->C 82 (not S->C 86) with the rewritten context.
    const previousContext = room.chiefSlotNetId;
    const leaveOutcome = state.removeSession(creator.session.sessionId);
    expect(leaveOutcome).not.toBeNull();
    if (leaveOutcome) {
      announceRoomListAfterLeave(state, leaveOutcome.room, leaveOutcome.roomDeleted);
    }
    expect(state.rooms.has(room.roomNumber)).toBe(true);
    expect(room.chiefSlotNetId).not.toBe(previousContext);
    expect(room.chiefSlotNetId).toBe(quickJoiner.session.netSlotIds[0]);
    const promotedEntry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
    expect(promotedEntry.roomNumber).toBe(room.roomNumber);
    expect(promotedEntry.contextWord).toBe(room.chiefSlotNetId);
    expect(promotedEntry.occupied).toBe(1);
    expect(viewer.client.popByOpcode(ServerOpcode.LobbyRoomSlotRemove)).toBeUndefined();
  });

  test("game start and match end flip the playing flag for Lobby viewers", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const viewer = makeLobbySession(state, config, "playing_viewer");
    const chief = makeLobbySession(state, config, "playing_chief");
    const member = makeLobbySession(state, config, "playing_member");
    const room = state.createRoom(chief.session, "Playing flag", "", false, 0, 0, [0]);
    state.assignSessionToRoom(member.session, room, [1]);
    const memberSlot = room.slots.find((slot) => slot.occupied && slot.session === member.session)!;
    memberSlot.ready = true;
    viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry); // discard creation row

    chief.client.sendToServer(
      state,
      chief.session.sessionId,
      new PacketWriter(ClientOpcode.StartMatch)
        .writeU32(0x10203040) // dyn-group counter
        .writeU32(5) // fxdynmapinfo map ID applied to the room on start
        .writeU8(0)
        .writeU32(0)
        .writeU8(0)
        .writeU32(0) // trailing ESFN checksum
    );
    expect(room.isPlaying).toBe(true);
    expect(room.mapId).toBe(5);
    const playingEntry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
    expect(playingEntry.roomNumber).toBe(room.roomNumber);
    expect(playingEntry.isPlaying).toBe(1);
    expect(playingEntry.mapId).toBe(5);
    // Room members are in the Game stage and receive no Lobby row packet.
    expect(chief.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)).toBeUndefined();
    expect(member.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)).toBeUndefined();

    finishMatch(state, room, null);
    expect(room.isPlaying).toBe(false);
    const endedEntry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
    expect(endedEntry.roomNumber).toBe(room.roomNumber);
    expect(endedEntry.isPlaying).toBe(0);
  });

  test("map and room-settings changes refresh the row for Lobby viewers", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const viewer = makeLobbySession(state, config, "settings_viewer");
    const chief = makeLobbySession(state, config, "settings_chief");
    const room = state.createRoom(chief.session, "Before", "", false, 0, 0, [0]);
    viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry); // discard direct-create row (none sent)

    // C->S 87 map change: the row's map ID refreshes for Lobby viewers.
    chief.client.sendToServer(
      state,
      chief.session.sessionId,
      new PacketWriter(ClientOpcode.SelectMap).writeU16(5)
    );
    const mapEntry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
    expect(mapEntry.roomNumber).toBe(room.roomNumber);
    expect(mapEntry.mapId).toBe(5);

    // C->S 84 settings change: the row's name / password flag / mode refresh as well.
    chief.client.sendToServer(
      state,
      chief.session.sessionId,
      new PacketWriter(ClientOpcode.UpdateRoomSettings)
        .writeString("After")
        .writeString("pw")
        .writeU8(4)
        .writeU8(2)
    );
    const settingsEntry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
    expect(settingsEntry.roomNumber).toBe(room.roomNumber);
    expect(settingsEntry.name).toBe("After");
    expect(settingsEntry.hasPassword).toBe(1);
    expect(settingsEntry.gameMode).toBe(2);
  });

  test("kicking a member refreshes the row's occupied count for Lobby viewers", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const viewer = makeLobbySession(state, config, "kick_viewer");
    const chief = makeLobbySession(state, config, "kick_chief");
    const member = makeLobbySession(state, config, "kick_member");
    const room = state.createRoom(chief.session, "Kick room", "", false, 0, 0, [0]);
    state.assignSessionToRoom(member.session, room, [1]);
    const memberSlot = room.slots.find((slot) => slot.occupied && slot.session === member.session)!;
    viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry); // discard creation/join rows
    viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry);

    chief.client.sendToServer(
      state,
      chief.session.sessionId,
      new PacketWriter(ClientOpcode.KickPlayer)
        .writeU32(memberSlot.netSlotId)
        .writeU8(0)
    );
    expect(member.session.currentRoomNumber).toBeNull();
    const kickedEntry = parseRoomEntry(viewer.client.popByOpcode(ServerOpcode.LobbyRoomListEntry)!);
    expect(kickedEntry.roomNumber).toBe(room.roomNumber);
    expect(kickedEntry.occupied).toBe(1);
  });
});

describe("Prepare room packets enforce exact writers and local sender context", () => {
  test("maps packed fields correctly and prevents malformed or non-chief mutations", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "203.0.113.160", 51160, "0.0.0.0", 0, "game");
    const userA = state.db.createUser("prepare_local_a", "password");
    const userB = state.db.createUser("prepare_local_b", "password");
    session.users = [userA, userB];
    session.netSlotIds = [state.allocateNetSlotId(), state.allocateNetSlotId()];
    session.equippedCharIds = [0, 0];
    session.channelSelected = true;
    session.sendConnectHello(config);
    const room = state.createRoom(session, "Prepare exact", "", false, 0, 0, [0, 0]);

    const memberClient = new SimulatedClient();
    const member = state.createSession(memberClient.onWireBytes, "203.0.113.161", 51161, "0.0.0.0", 0, "game");
    member.users = [state.db.createUser("prepare_member", "password")];
    member.netSlotIds = [state.allocateNetSlotId()];
    member.equippedCharIds = [0];
    member.channelSelected = true;
    member.sendConnectHello(config);
    state.assignSessionToRoom(member, room, [0]);

    const localSlot0 = room.slots[session.roomSlotIndices[0]!]!;
    const localSlot1 = room.slots[session.roomSlotIndices[1]!]!;

    // C->S 88 has a one-byte packed team-color form only. A two-byte body must not be
    // reinterpreted as a character selection or trigger an equipped-character DB update.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.SelectTeamColor).writeU8(1).writeU8(2)
    );
    expect(localSlot1.teamColor).toBe(1);
    expect(localSlot1.charId).toBe(0);
    expect(state.db.getUserByUsername(userB.username)?.equippedChar).toBe(0);

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.SelectTeamColor).writeU8((1 << 4) | 3)
    );
    expect(localSlot1.teamColor).toBe(3);

    // C->S 89 requires its exact two-byte form and a session-owned local index.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.SelectCharacter).writeU8(1)
    );
    expect(localSlot1.charId).toBe(0);
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.SelectCharacter).writeU8(1).writeU8(2)
    );
    expect(localSlot1.charId).toBe(2);
    expect(localSlot0.charId).toBe(0);
    expect(state.db.getUserByUsername(userB.username)?.equippedChar).toBe(2);

    // C->S 90 packs a target slot in the high nibble and desired open state in the low nibble.
    // Setting slot 2 closed must not toggle/select slot 1 based on the raw byte.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ToggleSlotOpen).writeU8((3 << 4) | 0)
    );
    expect(room.slots[3]?.open).toBe(false);
    expect(room.slots[1]?.open).toBe(true);
    expect(room.maxPlayers).toBe(7);
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ToggleSlotOpen).writeU8((3 << 4) | 1)
    );
    expect(room.slots[3]?.open).toBe(true);
    expect(room.maxPlayers).toBe(8);
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.ToggleSlotOpen));
    expect(room.slots[3]?.open).toBe(true);

    // C->S 86's recovered writer is exactly u8 state + u32 checksum, not a toggle fallback.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ToggleReady).writeU8(1).writeU32(0x1234_5678)
    );
    expect(localSlot0.ready).toBe(true);
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ToggleReady).writeU8(0).writeU8(1)
    );
    expect(localSlot0.ready).toBe(true);
    // A separate recovered one-byte Client writer is also exact; it sets, not toggles.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ToggleReady).writeU8(0)
    );
    expect(localSlot0.ready).toBe(false);

    // A well-formed C->S 84 changes room settings only for the local chief in Prepare.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UpdateRoomSettings)
        .writeString("Updated locally")
        .writeString("room-pass")
        .writeU8(4)
        .writeU8(2)
    );
    expect(room.name).toBe("Updated locally");
    expect(room.password).toBe("room-pass");
    expect(room.hasPassword).toBe(true);
    expect(room.maxPlayers).toBe(4);
    expect(room.gameMode).toBe(2);

    // The second Client writer sends only the two strings; it does not overwrite numeric fields.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UpdateRoomSettings).writeString("Strings only").writeString("pass-two")
    );
    expect(room.name).toBe("Strings only");
    expect(room.password).toBe("pass-two");
    expect(room.maxPlayers).toBe(4);
    expect(room.gameMode).toBe(2);

    memberClient.sendToServer(
      state,
      member.sessionId,
      new PacketWriter(ClientOpcode.UpdateRoomSettings)
        .writeString("Unauthorized")
        .writeString("")
        .writeU8(8)
        .writeU8(0)
    );
    expect(room.name).toBe("Strings only");
    expect(room.password).toBe("pass-two");

    session.stageId = StageId.Game;
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UpdateRoomSettings)
        .writeString("Wrong stage")
        .writeString("")
        .writeU8(8)
        .writeU8(0)
    );
    expect(room.name).toBe("Strings only");
  });
});

describe("Room match-start authorization", () => {
  const makeStartMatchRequest = (
    payloadBytes: 18 | 19 | 23,
    startFieldMapId = 0
  ): PacketWriter => {
    const writer = new PacketWriter(ClientOpcode.StartMatch)
      .writeU32(0x10203040) // Client dyn-group counter (`sub_4DE164` of the selection's group).
      .writeU32(startFieldMapId) // fxdynmapinfo `v34` map ID (`sub_4DDB1E`), C->S 93 field1.
      .writeU8(0)
      .writeU32(0) // Client dyn-list selection index.
      .writeU8(0); // Client map selectable flag.
    if (payloadBytes === 19) {
      writer.writeU8(1); // optional one-byte Client map-check status
    } else if (payloadBytes === 23) {
      writer.writeU8(0).writeU32(0x55667788); // optional status + map-file CRC
    }
    return writer.writeU32(0); // trailing ESFN checksum
  };

  test("uses the sender's chief slot, validates Client packet sizes, and prevents stale restarts", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const chiefClient = new SimulatedClient();
    const memberClient = new SimulatedClient();
    const chiefUser = state.db.createUser("start_chief", "password");
    const memberUser = state.db.createUser("start_member", "password");
    const chiefSession = state.createSession(
      chiefClient.onWireBytes,
      "203.0.113.80",
      51030,
      "0.0.0.0",
      0,
      "game"
    );
    const memberSession = state.createSession(
      memberClient.onWireBytes,
      "203.0.113.81",
      51031,
      "0.0.0.0",
      0,
      "game"
    );
    chiefSession.users = [chiefUser];
    memberSession.users = [memberUser];
    chiefSession.netSlotIds = [state.allocateNetSlotId()];
    memberSession.netSlotIds = [state.allocateNetSlotId()];
    chiefSession.sendConnectHello(config);
    memberSession.sendConnectHello(config);
    chiefSession.channelSelected = true;
    memberSession.channelSelected = true;

    const room = state.createRoom(chiefSession, "Start policy", "", false, 0, 0, [0]);
    state.assignSessionToRoom(memberSession, room, [0]);
    const chiefSlot = room.slots.find((slot) => slot.occupied && slot.session === chiefSession)!;
    const memberSlot = room.slots.find((slot) => slot.occupied && slot.session === memberSession)!;
    expect(chiefSlot.netSlotId).toBe(room.chiefSlotNetId);

    // j[92] is a room-context word, not the sender's slot identity. A non-chief's valid
    // C->S 93 request is silently denied locally; its proposed map selection is not applied.
    memberClient.sendToServer(
      state,
      memberSession.sessionId,
      makeStartMatchRequest(18, 7)
    );
    expect(room.isPlaying).toBe(false);
    expect(room.mapId).toBe(0);
    expect(chiefClient.receivedPackets).toHaveLength(0);
    expect(memberClient.receivedPackets).toHaveLength(0);

    // The chief still cannot start while another occupied player slot is unready.
    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      makeStartMatchRequest(18, 7)
    );
    expect(chiefClient.popByOpcode(ServerOpcode.StartGameError)?.readU8()).toBe(2);
    expect(chiefClient.popByOpcode(ServerOpcode.StartGameTransition)).toBeUndefined();
    expect(memberClient.popByOpcode(ServerOpcode.StartGameTransition)).toBeUndefined();
    expect(room.isPlaying).toBe(false);
    expect(room.mapId).toBe(0);
    memberSlot.ready = true;

    // Empty C->S 87 is not a start request; the recovered writers carry 2 or 6 payload bytes.
    chiefClient.sendToServer(state, chiefSession.sessionId, new PacketWriter(ClientOpcode.SelectMap));
    // Client CGameMapInfoList has 319 entries (IDs 0..318); reject the first out-of-range ID.
    const firstInvalidMapId = state.resources.mapList.length;
    expect(firstInvalidMapId).toBe(319);
    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      new PacketWriter(ClientOpcode.SelectMap).writeU16(firstInvalidMapId)
    );
    expect(room.mapId).toBe(0);
    expect(chiefClient.receivedPackets).toHaveLength(0);
    expect(memberClient.receivedPackets).toHaveLength(0);
    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      new PacketWriter(ClientOpcode.SelectMap).writeU16(firstInvalidMapId - 1)
    );
    expect(room.mapId).toBe(firstInvalidMapId - 1); // highest loaded map ID is valid
    expect(chiefClient.popByOpcode(ServerOpcode.MapSelectSync)).toBeDefined();
    expect(memberClient.popByOpcode(ServerOpcode.MapSelectSync)).toBeDefined();
    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      new PacketWriter(ClientOpcode.SelectMap).writeU16(0)
    );
    expect(room.mapId).toBe(0);
    expect(chiefClient.popByOpcode(ServerOpcode.MapSelectSync)).toBeDefined();
    expect(memberClient.popByOpcode(ServerOpcode.MapSelectSync)).toBeDefined();
    // A truncated C->S 93 (14-byte prefix plus only 3 of the final/check suffix bytes) is ignored.
    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      new PacketWriter(ClientOpcode.StartMatch)
        .writeU32(2)
        .writeU32(0)
        .writeU8(0)
        .writeU32(0)
        .writeU8(0)
        .writeBlock(new Uint8Array(3))
    );
    expect(room.isPlaying).toBe(false);
    expect(room.mapId).toBe(0);
    expect(chiefClient.receivedPackets).toHaveLength(0);
    expect(memberClient.receivedPackets).toHaveLength(0);

    // The 19-byte Client form includes its one-byte map-check suffix and final ESFN checksum.
    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      makeStartMatchRequest(19, 5)
    );
    expect(room.isPlaying).toBe(true);
    expect(room.mapId).toBe(5);
    expect(chiefSession.stageId).toBe(StageId.Game);
    expect(memberSession.stageId).toBe(StageId.Game);
    expect(chiefClient.popByOpcode(ServerOpcode.StartGameError)?.readU8()).toBe(0);
    expect(chiefClient.popByOpcode(ServerOpcode.StartGameTransition)).toBeDefined();
    expect(memberClient.popByOpcode(ServerOpcode.StartGameTransition)).toBeDefined();

    // The 23-byte form is structurally parsed, but a stale duplicate cannot restart the match
    // or change its map while the session is already in Game / the room is playing.
    const startTick = room.startTick;
    chiefClient.sendToServer(
      state,
      chiefSession.sessionId,
      makeStartMatchRequest(23, 6)
    );
    expect(room.isPlaying).toBe(true);
    expect(room.mapId).toBe(5);
    expect(room.startTick).toBe(startTick);
    expect(chiefClient.receivedPackets).toHaveLength(0);
    expect(memberClient.receivedPackets).toHaveLength(0);
  });
});

describe("C->S 87 map-ID resolution and diagnostics", () => {
  const setupChiefRoom = () => {
    const config = loadConfig({ dbPath: ":memory:" });
    const state = new WorldState(config);
    const chiefClient = new SimulatedClient();
    const chiefUser = state.db.createUser("mapid_chief", "password");
    const chiefSession = state.createSession(
      chiefClient.onWireBytes,
      "203.0.113.140",
      52040,
      "0.0.0.0",
      0,
      "game"
    );
    chiefSession.users = [chiefUser];
    chiefSession.netSlotIds = [state.allocateNetSlotId()];
    chiefSession.sendConnectHello(config);
    chiefSession.channelSelected = true;
    const room = state.createRoom(chiefSession, "Map ID policy", "", false, 0, 0, [0]);
    return { config, state, chiefClient, chiefSession, room };
  };

  test("accepts the 0xFFFF random-map marker and resolves it to a loaded map", () => {
    const { state, chiefClient, chiefSession, room } = setupChiefRoom();
    try {
      chiefClient.sendToServer(
        state,
        chiefSession.sessionId,
        new PacketWriter(ClientOpcode.SelectMap).writeU16(0xffff).writeU32(0)
      );
      expect(room.mapId).toBeGreaterThanOrEqual(0);
      expect(room.mapId).toBeLessThan(state.resources.mapList.length);
      // S->C 109 carries the resolved local map ID so other clients'
      // `CGameMapInfoList[mapId]` lookups (`sub_4F5263`) resolve.
      const sync = chiefClient.popByOpcode(ServerOpcode.MapSelectSync)!;
      expect(sync.readU16()).toBe(room.mapId);
      expect(sync.readU32()).toBe(0);
    } finally {
      state[Symbol.dispose]();
    }
  });

  test("rejects foreign catalog map IDs with the fxdynmapinfo entry name in the log", () => {
    const { state, chiefClient, chiefSession, room } = setupChiefRoom();
    try {
      clearRecentLogs();
      // 644 is the checked-in fxdynmapinfo.ssd v34 low half for "Monster15" (local map 216);
      // it is not a CGameMapInfoList index, so the request must not change the room.
      chiefClient.sendToServer(
        state,
        chiefSession.sessionId,
        new PacketWriter(ClientOpcode.SelectMap).writeU16(644).writeU32(0)
      );
      expect(room.mapId).toBe(0);
      expect(chiefClient.receivedPackets).toHaveLength(0);
      const warn = getRecentLogs().find((entry) =>
        entry.message.includes("Ignored C->S 87 map ID outside the loaded Client map list")
      );
      expect(warn).toBeDefined();
      expect(warn?.data?.mapId).toBe(644);
      expect(warn?.data?.mapListLength).toBe(319);
      expect(warn?.data?.fxdynmapinfoEntryName).toBe("Monster15");
      expect(warn?.data?.fxdynmapinfoRawMapId).toBe(0x00030284);
    } finally {
      state[Symbol.dispose]();
    }
  });

  test("logs the resolved map name when the room map changes", () => {
    const { state, chiefClient, chiefSession, room } = setupChiefRoom();
    try {
      clearRecentLogs();
      const target = state.resources.mapsByName.get("monster15")!;
      chiefClient.sendToServer(
        state,
        chiefSession.sessionId,
        new PacketWriter(ClientOpcode.SelectMap).writeU16(target.mapId).writeU32(7)
      );
      expect(room.mapId).toBe(target.mapId);
      const info = getRecentLogs().find((entry) => entry.message === "Room map changed");
      expect(info?.data?.mapId).toBe(target.mapId);
      expect(info?.data?.mapName).toBe("Monster15");
      expect(info?.data?.requestedMapId).toBe(target.mapId);
      expect(info?.data?.mapOptionKey).toBe(7);
    } finally {
      state[Symbol.dispose]();
    }
  });
});

describe("Shop handlers preserve source-backed local-player indices", () => {
  test("updates only the selected local user's stock for C->S 274 and 275", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const firstUser = state.db.createUser("shop_local_0", "password");
    const secondUser = state.db.createUser("shop_local_1", "password");
    const firstStockId = state.db.addStockItem(firstUser.id, 3001);
    const secondStockId = state.db.addStockItem(secondUser.id, 3002);
    const firstStarterStockId = state.db.getUserStock(firstUser.id).find((item) => item.itemCode === 1001)!.id;
    const secondStarterStockId = state.db.getUserStock(secondUser.id).find((item) => item.itemCode === 1001)!.id;

    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "203.0.113.60", 51010, "0.0.0.0", 0, "game");
    session.users = [firstUser, secondUser];
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.Shop;
    session.sendConnectHello(config);
    expect(client.helloReceived).toBe(true);

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ShopUseOrEquip274)
        .writeU8(1) // local player 1
        .writeU8(2) // avatar slot 2
        .writeU32(secondStockId) // local adapter resolves the SQLite inventory row ID
        .writeString("Player two hat")
    );
    expect(state.db.getUserStock(firstUser.id).find((item) => item.id === firstStockId)).toMatchObject({
      equipped: 0,
      customText: "",
    });
    expect(state.db.getUserStock(secondUser.id).find((item) => item.id === secondStockId)).toMatchObject({
      equipped: 3,
      customText: "Player two hat",
    });

    const avatarSync = client.popByOpcode(ServerOpcode.EquippedAvatarData)!;
    expect(avatarSync.readU8()).toBe(2);
    for (let slot = 0; slot < 8; slot++) {
      expect(avatarSync.readU32()).toBe(slot === 0 ? firstStarterStockId : 0); // local inventory row ID
      expect(avatarSync.readString()).toBe("");
    }
    for (let slot = 0; slot < 8; slot++) {
      expect(avatarSync.readU32()).toBe(
        slot === 0 ? secondStarterStockId : slot === 2 ? secondStockId : 0
      );
      expect(avatarSync.readString()).toBe(slot === 2 ? "Player two hat" : "");
    }
    expect(avatarSync.remaining).toBe(0);
    expect(client.popByOpcode(ServerOpcode.InventoryUpdate)).toBeDefined();

    // Three recovered 274 writers place literal zero in this field. The reconstruction does
    // not guess what zero means and rejects it under the local inventory-row-ID mapping.
    const secondUserBeforeZeroField = state.db.getUserStock(secondUser.id);
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ShopUseOrEquip274)
        .writeU8(1)
        .writeU8(2)
        .writeU32(0)
        .writeString("Client zero-field writer")
    );
    expect(state.db.getUserStock(secondUser.id)).toEqual(secondUserBeforeZeroField);
    expect(client.popByOpcode(ServerOpcode.InventoryUpdate)).toBeUndefined();
    expect(client.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeUndefined();

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ShopInventoryTab275)
        .writeU8(1) // local player 1
        .writeU8(1) // one custom-text update
        .writeU32(secondStockId) // local adapter resolves the SQLite inventory row ID
        .writeString("Updated player two text")
    );
    expect(state.db.getUserStock(firstUser.id).find((item) => item.id === firstStockId)?.customText).toBe("");
    expect(state.db.getUserStock(secondUser.id).find((item) => item.id === secondStockId)?.customText).toBe(
      "Updated player two text"
    );
    expect(client.popByOpcode(ServerOpcode.InventoryUpdate)).toBeDefined();
    expect(client.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeDefined();

    const firstUserBeforeFallback = state.db.getUserStock(firstUser.id);
    const secondUserBeforeFallback = state.db.getUserStock(secondUser.id);
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ShopUseOrEquip274).writeU16(0).writeU32(9999)
    );
    expect(state.db.getUserStock(firstUser.id)).toEqual(firstUserBeforeFallback);
    expect(state.db.getUserStock(secondUser.id)).toEqual(secondUserBeforeFallback);
    expect(client.popByOpcode(ServerOpcode.ShopUseOrEquipResult202)).toBeUndefined();
    expect(client.popByOpcode(ServerOpcode.InventoryUpdate)).toBeUndefined();
    expect(client.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeUndefined();
  });
});

describe("UserMarket operations use the locally selected session user", () => {
  test("routes no-index listing/cancel/buy packets to an explicit local player and syncs transfer snapshots", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const firstUser = state.db.createUser("market_local_0", "password");
    const secondUser = state.db.createUser("market_local_1", "password");
    const secondStockId = state.db.addStockItem(secondUser.id, 4102);

    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "203.0.113.61", 51011, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.users = [firstUser, secondUser];
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.UserMarket;

    // C->S 326 carries no local-player selector. A 2P session with no observed
    // UserMarket selection must not silently mutate session.users[0].
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketRegisterListing326).writeU32(4102).writeU32(1_000)
    );
    expect(state.db.getActiveMarketListings()).toHaveLength(0);
    expect(client.popByOpcode(ServerOpcode.UserMarketRegisterResult)).toBeUndefined();

    // Client C->S 321's second byte carries the selector used by this local adapter.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketStageEntry321).writeU8(1).writeU8(1)
    );
    expect(session.userMarketLocalIdx).toBe(1);
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketRegisterListing326).writeU32(4102).writeU32(1_000)
    );
    const registerResult = client.popByOpcode(ServerOpcode.UserMarketRegisterResult)!;
    expect(registerResult.readU16()).toBe(0); // local fixture result
    expect(registerResult.readU32()).toBe(4102); // local item-code mapping
    expect(registerResult.remaining).toBe(0);
    const listing = state.db.getActiveMarketListings()[0]!;
    expect(listing.sellerUserId).toBe(secondUser.id);
    expect(listing.stockId).toBe(secondStockId);

    const publicList = client.popByOpcode(ServerOpcode.UserMarketList)!;
    expect(publicList.readU16()).toBe(1);
    expect(publicList.readU32()).toBe(listing.id);
    expect(publicList.readU32()).toBe(4102);
    expect(publicList.readString()).toBe(secondUser.username);
    expect(publicList.readU32()).toBe(1_000);
    expect(publicList.readU16()).toBe(24); // local fixture field
    expect(publicList.remaining).toBe(0);
    const mySales = client.popByOpcode(ServerOpcode.UserMarketMySalesList)!;
    expect(mySales.readU16()).toBe(1);
    expect(mySales.readU32()).toBe(listing.id);
    expect(mySales.readU32()).toBe(4102);
    expect(mySales.readString()).toBe(secondUser.username);
    expect(mySales.readU32()).toBe(1_000);
    expect(mySales.readU16()).toBe(24); // local fixture field
    expect(mySales.remaining).toBe(0);

    // Selecting player 0 makes the same no-index cancel candidate fail the local owner check.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketStageEntry321).writeU8(0).writeU8(0)
    );
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketCancelListing).writeU32(listing.id)
    );
    expect(state.db.getActiveMarketListings()).toHaveLength(1);
    expect(state.db.getUserStock(secondUser.id).find((item) => item.id === secondStockId)?.marketStatus).toBe(1);
    expect(client.popByOpcode(ServerOpcode.UserMarketCancelResult274)).toBeUndefined();

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketStageEntry321).writeU8(0).writeU8(1)
    );
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketCancelListing).writeU32(listing.id)
    );
    const cancelResult = client.popByOpcode(ServerOpcode.UserMarketCancelResult274)!;
    expect(cancelResult.readU16()).toBe(0); // local fixture result
    expect(cancelResult.readU32()).toBe(4102); // local item-code mapping
    expect(cancelResult.remaining).toBe(0);
    expect(state.db.getActiveMarketListings()).toHaveLength(0);
    expect(state.db.getUserStock(secondUser.id).find((item) => item.id === secondStockId)?.marketStatus).toBe(0);
    expect(client.popByOpcode(ServerOpcode.UserMarketList)?.readU16()).toBe(0);
    expect(client.popByOpcode(ServerOpcode.UserMarketMySalesList)?.readU16()).toBe(0);

    // The no-index C->S 330 buyer is likewise the selected local user, not users[0].
    const seller = state.db.createUser("market_external_seller", "password");
    const sellerStockId = state.db.addStockItem(seller.id, 4103);
    const externalListing = state.db.createMarketListing(seller.id, seller.username, 4103, 500)!;
    const firstBalanceBeforeBuy = state.db.getUserById(firstUser.id)!.marketLucci;
    const secondBalanceBeforeBuy = state.db.getUserById(secondUser.id)!.marketLucci;
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketBuyListing).writeU32(externalListing.id)
    );
    const purchaseResult = client.popByOpcode(ServerOpcode.UserMarketPurchaseResult)!;
    expect(purchaseResult.readU16()).toBe(0); // local fixture result
    expect(purchaseResult.readU32()).toBe(4103); // local listing itemCode mapping
    expect(purchaseResult.readU32()).toBe(secondBalanceBeforeBuy! - 500);
    purchaseResult.readVariantTime();
    expect(purchaseResult.remaining).toBe(0);
    expect(state.db.getUserById(firstUser.id)?.marketLucci).toBe(firstBalanceBeforeBuy);
    expect(state.db.getUserById(secondUser.id)?.marketLucci).toBe(secondBalanceBeforeBuy! - 500);
    expect(state.db.getUserStock(seller.id).some((item) => item.id === sellerStockId)).toBe(false);
    expect(state.db.getUserStock(secondUser.id).some((item) => item.itemCode === 4103)).toBe(true);
    expect(client.popByOpcode(ServerOpcode.InventoryUpdate)).toBeDefined();
    expect(client.popByOpcode(ServerOpcode.UserMarketList)?.readU16()).toBe(0);

    // Transfer uses its explicit byte and refreshes all active in-memory snapshots of that user.
    const observerClient = new SimulatedClient();
    const observerSession = state.createSession(
      observerClient.onWireBytes,
      "203.0.113.62",
      51012,
      "0.0.0.0",
      0,
      "game"
    );
    observerSession.sendConnectHello(config);
    observerSession.users = [state.db.getUserById(secondUser.id)!];
    const secondLucciBeforeTransfer = state.db.getUserById(secondUser.id)!.lucci;
    const secondMarketBeforeTransfer = state.db.getUserById(secondUser.id)!.marketLucci;
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketTransferLucci).writeU8(1).writeU32(200)
    );
    const transferResult = client.popByOpcode(ServerOpcode.UserMarketTransferResult)!;
    expect(transferResult.readU16()).toBe(0); // local fixture result
    expect(transferResult.readU32()).toBe(secondLucciBeforeTransfer! + 200);
    expect(transferResult.readU32()).toBe(secondMarketBeforeTransfer! - 200);
    expect(transferResult.remaining).toBe(0);
    expect(observerSession.users[0]?.lucci).toBe(secondLucciBeforeTransfer! + 200);
    expect(observerSession.users[0]?.marketLucci).toBe(secondMarketBeforeTransfer! - 200);
  });
});

describe("C->S 38 Shop follow-up candidate", () => {
  test("validates the dynamic Client body without authenticating or entering Shop on the redirected socket", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const persistedUser = state.db.createUser("shop_redirect_identity", "password");
    const persistedUserBefore = state.db.getUserById(persistedUser.id);
    const client = new SimulatedClient();
    // S->C 48 can cause CShopConnectionMan to allocate a separate CClientSocket.
    // This fresh Login-kind session intentionally has no authenticated users/session binding.
    const session = state.createSession(client.onWireBytes, "203.0.113.109", 51109, "0.0.0.0", 0, "login");
    session.sendConnectHello(config);

    const firstField95 = 0x89ab_cdef;
    const secondField95 = 0x1029_3847;
    const followUp = new PacketWriter(ClientOpcode.ShopConnectionFollowUp38)
      .writeU8(2) // mode copied from the connection-manager object in the mapped Lobby caller
      .writeU8(2) // local-user record count
      .writeString("shop_redirect_identity")
      .writeU32(firstField95) // field95 source; authentication semantics are not established
      .writeString("another_local_identity")
      .writeU32(secondField95)
      .writeU8(7) // trailing Client field; business meaning unknown
      .writeU32(0x7654_3210); // trailing Client field; business meaning unknown
    const expectedBodyBytes = followUp.toBytes().length - 2;
    client.sendToServer(state, session.sessionId, followUp);

    const observation = getRecentLogs().findLast(
      (entry) => entry.category === "PacketAudit" && entry.message.includes("exact C->S 38 Client writer")
    );
    expect(observation?.data?.connectionKind).toBe("login");
    expect(observation?.data?.payloadBytes).toBe(expectedBodyBytes);
    expect(observation?.data?.mode).toBe(2);
    expect(observation?.data?.localUserCount).toBe(2);
    expect(observation?.data?.authenticationValidated).toBe(false);
    expect(observation?.data?.responseSent).toBe(false);
    expect(observation?.data?.stageChanged).toBe(false);
    expect(observation?.data?.databaseMutation).toBe(false);
    expect(session.stageId).toBe(StageId.Login);
    expect(session.users).toEqual([]);
    expect(client.receivedPackets).toHaveLength(0);

    for (const malformed of [
      new PacketWriter(ClientOpcode.ShopConnectionFollowUp38),
      new PacketWriter(ClientOpcode.ShopConnectionFollowUp38)
        .writeU8(2)
        .writeU8(1)
        .writeString("truncated_identity"),
      new PacketWriter(ClientOpcode.ShopConnectionFollowUp38)
        .writeU8(2)
        .writeU8(3),
      new PacketWriter(ClientOpcode.ShopConnectionFollowUp38)
        .writeU8(2)
        .writeU8(0)
        .writeU8(0)
        .writeU32(0)
        .writeU8(0),
    ]) {
      client.sendToServer(state, session.sessionId, malformed);
    }
    expect(session.stageId).toBe(StageId.Login);
    expect(session.users).toEqual([]);
    expect(client.receivedPackets).toHaveLength(0);
    expect(state.db.getUserById(persistedUser.id)).toEqual(persistedUserBefore);

    const diagnostics = JSON.stringify(getRecentLogs());
    expect(diagnostics).not.toContain("shop_redirect_identity");
    expect(diagnostics).not.toContain("another_local_identity");
    expect(diagnostics).not.toContain(String(firstField95));
    expect(diagnostics).not.toContain(String(secondField95));
  });

  test("enters Shop through the client-verified S->C 16 + S->C 213 chain when C->S 38 follows an authenticated C->S 316", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const created = state.db.createUser("shop_entry_lobby", "password");
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51222, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.users = [state.db.getUserById(created.id)!];
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.Lobby;

    // Lobby Shop button: `sub_4BAACB` -> `sub_529AFB` latches CShopConnectionMan state 2 and
    // writes C->S 316 (byte-228 path). The local handler mirrors the latch on the session.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.RequestShopConnectionAlt).writeU8(0)
    );
    expect(session.shopConnectionPending).toBe(true);
    expect(client.popByOpcode(ServerOpcode.ShopConnectionPermission)?.readU8()).toBe(1);
    expect(client.popByOpcode(ServerOpcode.ShopServerEndpoint)?.readU8()).toBe(1);

    // `sub_52A129` (S->C 261 reader) consumes the latch and writes the exact C->S 38 body
    // (mode 2), then `sub_529D8E` appends the empty C->S 318 on the same path.
    const followUp = new PacketWriter(ClientOpcode.ShopConnectionFollowUp38)
      .writeU8(2) // mode 2 = Lobby Shop-button caller (`sub_4BAACB`)
      .writeU8(1) // one local user
      .writeString("shop_entry_lobby")
      .writeU32(0x1122_3344) // field95; not validated by local policy
      .writeU8(0) // trailing Client field
      .writeU32(0);
    client.sendToServer(state, session.sessionId, followUp);
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.RequestUserMarketConnection));

    // Local Shop-entry reply policy: S->C 16 (Stage 14 via `sub_4BB82A`) + S->C 213
    // (`CShopStageNew::sub_536555` -> C->S 269 [u8(1)] trigger).
    const p16 = client.popByOpcode(ServerOpcode.ShopInitAndStage14)!;
    expect(p16).toBeDefined();
    expect(p16.readU8()).toBe(0); // localPlayerIdx
    expect(p16.readU8()).toBe(0); // flag2
    const userAfter = state.db.getUserById(created.id)!;
    expect(p16.readU32()).toBe(userAfter.cash);
    expect(p16.readU32()).toBe(userAfter.lucci);
    expect(p16.readU32()).toBe(state.resources.ssdFiles.fxstock.adler32Zero);
    expect(p16.readU32()).toBe(state.resources.ssdFiles.stringtable.adler32Zero);
    expect(p16.readU32()).toBe(state.resources.ssdFiles.packagemap.adler32Zero);
    expect(p16.readString()).toContain("http");
    expect(p16.readU32()).toBe(0); // bannerCount
    expect(p16.remaining).toBe(0);
    const trigger = client.popByOpcode(ServerOpcode.NexonClubAuthResult)!;
    expect(trigger.readU8()).toBe(0); // ok = 0: no clubId field, no modal
    expect(trigger.readU8()).toBe(0); // playerIdx
    expect(trigger.remaining).toBe(0);
    expect(session.stageId).toBe(StageId.Shop);
    expect(session.shopConnectionPending).toBe(false);

    // The mode-2 companion C->S 318 must not start the UserMarket fee chain mid-entry.
    expect(client.popByOpcode(ServerOpcode.UserMarketPermission)?.readU8()).toBe(0);
    expect(client.popByOpcode(ServerOpcode.UserMarketFeeInfo)).toBeUndefined();
    expect(session.userMarketPermissionGranted).toBe(false);

    // Client-verified follow-up: CShopStageNew::sub_536555 answers S->C 213 with C->S 269 [1].
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.ShopEnter).writeU8(1));
    const cash = client.popByOpcode(ServerOpcode.ShopCashBalance198)!;
    expect(cash.readU32()).toBe(userAfter.cash);
    expect(cash.readU8()).toBe(1); // status 1 suppresses the client's C->S 269 retry
    expect(cash.remaining).toBe(0);
    expect(client.popByOpcode(ServerOpcode.ShopConfigCrc224)).toBeDefined();

    // A second, unprompted C->S 38 (no pending latch) stays observation-only.
    const receivedBeforeSecond = client.receivedPackets.length;
    client.sendToServer(state, session.sessionId, followUp);
    expect(client.receivedPackets).toHaveLength(receivedBeforeSecond);
    expect(session.stageId).toBe(StageId.Shop);

    // Room-stage C->S 38 bodies are served by the C->S 98 room-context policy instead,
    // so the C->S 38 reply policy stays observation-only there even with the latch set.
    const unprompted = new PacketWriter(ClientOpcode.ShopConnectionFollowUp38)
      .writeU8(2)
      .writeU8(1)
      .writeString("shop_entry_lobby")
      .writeU32(0)
      .writeU8(0)
      .writeU32(0);
    session.shopConnectionPending = true;
    session.stageId = StageId.Prepare;
    const receivedBeforeRoomStage = client.receivedPackets.length;
    client.sendToServer(state, session.sessionId, unprompted);
    expect(session.stageId).toBe(StageId.Prepare);
    expect(client.receivedPackets).toHaveLength(receivedBeforeRoomStage);
    expect(session.shopConnectionPending).toBe(true);
    session.stageId = StageId.Shop;
  });
});

describe("C->S 313/314 Basket query body boundaries", () => {
  test("accepts the empty snapshot request and a selected local-player u8 only in Shop context", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const firstUser = state.db.createUser("basket_local_0", "password");
    const secondUser = state.db.createUser("basket_local_1", "password");
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51028, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.users = [firstUser, secondUser];
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.Shop;

    const queuedBeforeMalformed = client.receivedPackets.length;
    for (const malformed of [
      new PacketWriter(ClientOpcode.BasketQueryInfo).writeU8(0),
      new PacketWriter(ClientOpcode.BasketQueryCoupons),
      new PacketWriter(ClientOpcode.BasketQueryCoupons).writeU8(0).writeU8(1),
      new PacketWriter(ClientOpcode.BasketQueryCoupons).writeU8(2),
    ]) {
      client.sendToServer(state, session.sessionId, malformed);
    }
    expect(client.receivedPackets).toHaveLength(queuedBeforeMalformed);

    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.BasketQueryInfo));
    const basketSnapshot = client.popByOpcode(ServerOpcode.BasketInfo258)!;
    expect(basketSnapshot.readU8()).toBe(1); // local fixture flag
    expect(basketSnapshot.readU16()).toBe(1); // local fixture count
    expect(basketSnapshot.readU32()).toBe(1001);
    expect(basketSnapshot.readU32()).toBe(1000);
    expect(basketSnapshot.readU32()).toBe(500);
    expect(basketSnapshot.readString()).toBe("Basket Special Offer");
    expect(basketSnapshot.remaining).toBe(0);
    const snapshotCouponCounts = client.popByOpcode(ServerOpcode.BasketInfo)!;
    expect(snapshotCouponCounts.readU8()).toBe(2); // playerCount
    for (let player = 0; player < 2; player++) {
      expect(snapshotCouponCounts.readU16()).toBe(1); // local fixture basket coupon count
      expect(snapshotCouponCounts.readU16()).toBe(1); // local fixture gachapon coupon count
    }
    expect(snapshotCouponCounts.remaining).toBe(0);
    expect(client.popByOpcode(ServerOpcode.BasketCouponCounts)).toBeUndefined();

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.BasketQueryCoupons).writeU8(1)
    );
    const selectedCouponCounts = client.popByOpcode(ServerOpcode.BasketInfo)!;
    expect(selectedCouponCounts.readU8()).toBe(2); // response retains the session's local-player array
    for (let player = 0; player < 2; player++) {
      expect(selectedCouponCounts.readU16()).toBe(1);
      expect(selectedCouponCounts.readU16()).toBe(1);
    }
    expect(selectedCouponCounts.remaining).toBe(0);
    expect(client.popByOpcode(ServerOpcode.BasketCouponCounts)?.readU32()).toBe(0);
    expect(client.popByOpcode(ServerOpcode.BasketInfo258)).toBeUndefined();

    const queuedBeforeInvalidContext = client.receivedPackets.length;
    session.stageId = StageId.Lobby;
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.BasketQueryCoupons).writeU8(0)
    );
    session.stageId = StageId.Shop;
    session.channelSelected = false;
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.BasketQueryInfo)
    );
    expect(client.receivedPackets).toHaveLength(queuedBeforeInvalidContext);
  });
});

describe("C->S 273 inventory-sync writer variants", () => {
  test("uses the u16 count, exact mode suffixes, session-local player index, and local stock-row IDs", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const firstUser = state.db.createUser("sync_player_0", "password");
    const secondUser = state.db.createUser("sync_player_1", "password");
    const firstStockId = state.db.addStockItem(firstUser.id, 4100);
    const secondStockIds = Array.from({ length: 256 }, (_, index) =>
      state.db.addStockItem(secondUser.id, 4200 + index)
    );

    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "203.0.113.62", 51012, "0.0.0.0", 0, "game");
    session.users = [firstUser, secondUser];
    session.channelSelected = true;
    session.stageId = StageId.Shop;
    session.sendConnectHello(config);

    const makeSync = (
      mode: number,
      playerIdx: number,
      rows: readonly { slotField: number; stockId: number }[] = [],
      suffix?: readonly [number, number]
    ): PacketWriter => {
      const writer = new PacketWriter(ClientOpcode.InventoryEquipSync)
        .writeU8(mode)
        .writeU8(playerIdx)
        .writeU16(rows.length);
      for (const row of rows) writer.writeU8(row.slotField).writeU32(row.stockId);
      if (suffix) writer.writeU8(suffix[0]).writeU8(suffix[1]);
      return writer;
    };

    const firstUserBefore = state.db.getUserStock(firstUser.id);
    const rowsOverU8CountBoundary = secondStockIds.map((stockId, index) => ({
      slotField: (index % 8) + 1,
      stockId,
    }));
    client.sendToServer(state, session.sessionId, makeSync(0, 1, rowsOverU8CountBoundary));
    expect(state.db.getUserStock(firstUser.id)).toEqual(firstUserBefore);
    const secondUserAfter = state.db.getUserStock(secondUser.id);
    expect(secondUserAfter.find((item) => item.id === secondStockIds[255])?.equipped).toBe(8);
    expect(state.db.getUserStock(firstUser.id).find((item) => item.id === firstStockId)?.equipped).toBe(0);
    const avatarSync = client.popByOpcode(ServerOpcode.EquippedAvatarData)!;
    expect(avatarSync.readU8()).toBe(2);
    for (let playerIdx = 0; playerIdx < 2; playerIdx++) {
      for (let slotIdx = 0; slotIdx < 8; slotIdx++) {
        avatarSync.readU32();
        avatarSync.readString();
      }
    }
    expect(avatarSync.remaining).toBe(0);

    // Equal catalog codes remain separate local rows. The reconstruction resolves each wire
    // stockId to inventory.id; this does not establish the official Client/Server ID mapping.
    const duplicateItemCode = 5000;
    const duplicateStockIds = [
      state.db.addStockItem(secondUser.id, duplicateItemCode),
      state.db.addStockItem(secondUser.id, duplicateItemCode),
    ];
    expect(duplicateStockIds[0]).not.toBe(duplicateStockIds[1]);
    client.sendToServer(
      state,
      session.sessionId,
      makeSync(0, 1, [
        { slotField: 5, stockId: duplicateStockIds[0]! },
        { slotField: 6, stockId: duplicateStockIds[1]! },
      ])
    );
    const duplicateRows = state.db.getUserStock(secondUser.id)
      .filter((item) => item.itemCode === duplicateItemCode)
      .sort((left, right) => left.id - right.id);
    expect(duplicateRows.map(({ id, equipped }) => ({ id, equipped }))).toEqual([
      { id: duplicateStockIds[0], equipped: 5 },
      { id: duplicateStockIds[1], equipped: 6 },
    ]);
    expect(client.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeDefined();

    // Direct Client callers found in this build emit modes 0, 1, 2, and 4. Modes 1 and 4
    // append exactly two u8 values; mode 3 has no recovered direct writer and is observation-only.
    for (const [mode, playerIdx, suffix] of [
      [1, 1, [7, 1]],
      [2, 0, undefined],
      [4, 1, [0, 0]],
    ] as const) {
      client.sendToServer(
        state,
        session.sessionId,
        makeSync(mode, playerIdx, [], suffix)
      );
      expect(client.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeDefined();
    }

    const secondUserBeforeInvalid = state.db.getUserStock(secondUser.id);
    const receivedCountBeforeInvalid = client.receivedPackets.length;
    const invalidRequests = [
      makeSync(1, 1), // missing the two required mode-1 suffix bytes
      makeSync(4, 1, [], [0, 0]).writeU8(0), // trailing byte
      makeSync(0, 2), // no third local player
      makeSync(0, 1, [{ slotField: 1, stockId: 0xffff_ffff }]), // not owned
      makeSync(0, 1, [{ slotField: 1, stockId: 0 }]), // Client list writer skips zero IDs
      makeSync(3, 1), // no direct writer context recovered for mode 3
      makeSync(5, 1), // outside the recovered mode range
    ];
    for (const packet of invalidRequests) client.sendToServer(state, session.sessionId, packet);
    expect(state.db.getUserStock(secondUser.id)).toEqual(secondUserBeforeInvalid);
    expect(client.receivedPackets).toHaveLength(receivedCountBeforeInvalid);

    const validEmptyMode0 = (): PacketWriter => makeSync(0, 0);
    const beforeInvalidContexts = state.db.getUserStock(firstUser.id);
    session.stageId = StageId.Prepare;
    client.sendToServer(state, session.sessionId, validEmptyMode0());
    session.stageId = StageId.Shop;
    session.channelSelected = false;
    client.sendToServer(state, session.sessionId, validEmptyMode0());
    session.channelSelected = true;
    expect(state.db.getUserStock(firstUser.id)).toEqual(beforeInvalidContexts);
    expect(client.receivedPackets).toHaveLength(receivedCountBeforeInvalid);
  });
});

describe("C->S 95 cross-context audit", () => {
  test("only the exact Prepare candidate uses the local adapter; other contexts are observation-only", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const user = state.db.createUser("packet95_context_user", "password");
    const session = state.createSession(client.onWireBytes, "203.0.113.91", 51041, "0.0.0.0", 0, "game");
    session.users = [user];
    session.netSlotIds = [state.allocateNetSlotId()];
    session.equippedCharIds = [0];
    session.channelSelected = true;
    session.channelIndex = 1;
    session.stageId = StageId.Prepare;
    session.sendConnectHello(config);
    const room = state.createRoom(session, "Packet 95 context", "", false, 0, 0, [0]);
    const send = (writer: PacketWriter): void => client.sendToServer(state, session.sessionId, writer);
    const preparePacket95 = (): PacketWriter =>
      new PacketWriter(ClientOpcode.ClientPacket95).writeU8(0).writeU8(2).writeU8(1).writeU16(0x1234);

    // Wrong lengths are observed; they are not a short-form RoomEmotion or quick-slot request.
    send(new PacketWriter(ClientOpcode.ClientPacket95).writeBlock(new Uint8Array(6)));
    send(new PacketWriter(ClientOpcode.ClientPacket95).writeU8(0).writeU8(2).writeU8(1));
    expect(client.popByOpcode(ServerOpcode.PrepareStageRoute115)).toBeUndefined();
    expect(client.popByOpcode(ServerOpcode.WhisperOrEmotion)).toBeUndefined();
    expect(client.receivedPackets).toHaveLength(0);

    // Exact 5-byte Prepare form reaches only the local Prepare-115 adapter. Its field mapping
    // and emitted S->C 115 form are reconstruction policy, not an official-server association.
    send(preparePacket95());
    const localPrepare115 = client.popByOpcode(ServerOpcode.PrepareStageRoute115)!;
    expect(localPrepare115.readU8()).toBe(0);
    expect(localPrepare115.readU8()).toBe(2);
    expect(localPrepare115.readU8()).toBe(2);
    expect(localPrepare115.readU8()).toBe(1);
    expect(localPrepare115.readU16()).toBe(0x1234);
    expect(localPrepare115.readU8()).toBe(1);
    expect(localPrepare115.remaining).toBe(0);
    expect(client.popByOpcode(ServerOpcode.WhisperOrEmotion)).toBeUndefined();

    // The same 5-byte shape remains observation-only without a selected channel or room number.
    session.channelSelected = false;
    send(preparePacket95());
    expect(client.popByOpcode(ServerOpcode.PrepareStageRoute115)).toBeUndefined();
    session.channelSelected = true;
    const currentRoomNumber = session.currentRoomNumber;
    session.currentRoomNumber = null;
    send(preparePacket95());
    expect(client.popByOpcode(ServerOpcode.PrepareStageRoute115)).toBeUndefined();
    session.currentRoomNumber = currentRoomNumber;

    // Even synthetic room membership must not make a login transport eligible for the local route.
    const loginClient = new SimulatedClient();
    const loginSession = state.createSession(
      loginClient.onWireBytes,
      "203.0.113.95",
      51045,
      "0.0.0.0",
      0,
      "login"
    );
    loginSession.users = [state.db.createUser("packet95_non_game_user", "password")];
    loginSession.netSlotIds = [state.allocateNetSlotId()];
    loginSession.channelSelected = true;
    loginSession.sendConnectHello(config);
    state.createRoom(loginSession, "Non-game test room", "", false, 0, 0, [0]);
    loginSession.stageId = StageId.Prepare;
    loginClient.sendToServer(state, loginSession.sessionId, preparePacket95());
    expect(loginClient.receivedPackets).toHaveLength(0);

    // The Client census has Chatting-helper, Game, and Exchange writer contexts. Do not
    // dispatch those through Prepare logic or generalize the Prepare S->C 115 parser.
    session.channelSelected = true;
    for (const context of [StageId.Lobby, StageId.Chatting, StageId.Game, StageId.Exchange]) {
      session.stageId = context;
      send(preparePacket95());
      expect(client.popByOpcode(ServerOpcode.PrepareStageRoute115)).toBeUndefined();
      expect(client.popByOpcode(ServerOpcode.WhisperOrEmotion)).toBeUndefined();
      expect(client.receivedPackets).toHaveLength(0);
    }

    // Restore the local route conditions, then tamper first with the session's claimed slot list
    // and then with the actual slot owner. Both fail closed despite the exact body and stage.
    session.stageId = StageId.Prepare;
    session.channelSelected = true;
    const memberSlotIdx = session.roomSlotIndices[0]!;
    const memberSlot = room.slots[memberSlotIdx]!;
    const originalSlotSession = memberSlot.session;
    const originalRoomSlotIndices = session.roomSlotIndices;
    session.roomSlotIndices = [];
    send(preparePacket95());
    expect(client.popByOpcode(ServerOpcode.PrepareStageRoute115)).toBeUndefined();
    session.roomSlotIndices = originalRoomSlotIndices;

    memberSlot.session = null;
    send(preparePacket95());
    expect(client.popByOpcode(ServerOpcode.PrepareStageRoute115)).toBeUndefined();
    memberSlot.session = originalSlotSession;
    expect(client.receivedPackets).toHaveLength(0);

    expect(state.rooms.get(room.roomNumber)).toBe(room);
    const observations = getRecentLogs().filter(
      (entry) => entry.category === "PacketAudit" && entry.data?.wireOpcode === ClientOpcode.ClientPacket95
    );
    expect(observations.length).toBeGreaterThanOrEqual(8);
    expect(observations.every((entry) => entry.data?.responseSent === false)).toBe(true);
    expect(observations.every((entry) => entry.data?.databaseMutation === false)).toBe(true);
  });
});

describe("C->S 99 generic stage packet", () => {
  test("validates the count-sized structure without room-avatar replies or state mutation", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const user = state.db.createUser("stage_packet99_user", "password");
    const session = state.createSession(client.onWireBytes, "203.0.113.92", 51042, "0.0.0.0", 0, "game");
    session.users = [user];
    session.netSlotIds = [state.allocateNetSlotId()];
    session.equippedCharIds = [0];
    session.channelSelected = true;
    session.stageId = StageId.Prepare;
    session.sendConnectHello(config);
    const room = state.createRoom(session, "Stage packet 99", "", false, 0, 0, [0]);
    const stockBefore = state.db.getUserStock(user.id);

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.StagePacket99).writeU8(0).writeU16(1)
    );
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.StagePacket99)
        .writeU8(0)
        .writeU16(1)
        .writeU32(0x0102_0304)
        .writeU32(0x0506_0708)
        .writeU32(0x090a_0b0c)
    );
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.StagePacket99).writeU8(0).writeU16(0));

    expect(client.receivedPackets).toHaveLength(0);
    expect(state.db.getUserStock(user.id)).toEqual(stockBefore);
    expect(state.rooms.get(room.roomNumber)).toBe(room);

    // The generic CStage writer is also observed without room membership in Lobby.
    const lobbyClient = new SimulatedClient();
    const lobbySession = state.createSession(lobbyClient.onWireBytes, "203.0.113.93", 51043, "0.0.0.0", 0, "game");
    lobbySession.users = [state.db.createUser("stage_packet99_lobby", "password")];
    lobbySession.stageId = StageId.Lobby;
    lobbySession.sendConnectHello(config);
    lobbyClient.sendToServer(
      state,
      lobbySession.sessionId,
      new PacketWriter(ClientOpcode.StagePacket99).writeU8(0).writeU16(0)
    );
    expect(lobbySession.currentRoomNumber).toBeNull();
    expect(lobbyClient.receivedPackets).toHaveLength(0);
  });
});

describe("C->S 286 opaque Client packet", () => {
  test("observes exactly one u32 without assigning a reward, reply, or database effect", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const user = state.db.createUser("packet286_opaque_user", "password");
    const session = state.createSession(client.onWireBytes, "203.0.113.96", 51046, "0.0.0.0", 0, "game");
    session.users = [user];
    session.stageId = StageId.Shop;
    session.sendConnectHello(config);
    const userBefore = state.db.getUserById(user.id);
    const stockBefore = state.db.getUserStock(user.id);

    for (const payloadBytes of [3, 4, 5]) {
      const receivedBefore = client.receivedPackets.length;
      client.sendToServer(
        state,
        session.sessionId,
        new PacketWriter(ClientOpcode.ClientPacket286).writeBlock(new Uint8Array(payloadBytes))
      );
      expect(client.popByOpcode(ServerOpcode.StageSpecificRoute204)).toBeUndefined();
      expect(client.receivedPackets).toHaveLength(receivedBefore);
    }

    expect(state.db.getUserById(user.id)).toEqual(userBefore);
    expect(state.db.getUserStock(user.id)).toEqual(stockBefore);
    const observations = getRecentLogs().filter(
      (entry) => entry.category === "PacketAudit" && entry.data?.wireOpcode === ClientOpcode.ClientPacket286
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]?.data).toMatchObject({
      payloadBytes: 4,
      payloadMeaning: "UNKNOWN",
      responseAssociation: "UNKNOWN",
      responseSent: false,
      databaseMutation: false,
    });
  });
});

describe("C->S 100 exact Exchange audit", () => {
  test("validates known writer forms without inventing trade replies or DB changes", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const users = [
      state.db.createUser("exchange_audit_local_a", "password"),
      state.db.createUser("exchange_audit_local_b", "password"),
    ];
    const session = state.createSession(client.onWireBytes, "203.0.113.94", 51044, "0.0.0.0", 0, "game");
    session.users = users;
    session.netSlotIds = [state.allocateNetSlotId(), state.allocateNetSlotId()];
    session.equippedCharIds = [0, 0];
    session.channelSelected = true;
    session.sendConnectHello(config);
    const room = state.createRoom(session, "Exchange audit", "", false, 0, 0, [0, 0]);
    session.stageId = StageId.Exchange;
    const stockBefore = users.map((user) => state.db.getUserStock(user.id));

    for (const packet of [
      new PacketWriter(ClientOpcode.ExchangeAction).writeU8(2),
      new PacketWriter(ClientOpcode.ExchangeAction).writeU8(5),
      new PacketWriter(ClientOpcode.ExchangeAction).writeU8(3).writeU32(10000).writeU8(0),
      new PacketWriter(ClientOpcode.ExchangeAction)
        .writeU8(3)
        .writeU32(10000)
        .writeU8(1)
        .writeU32(2005)
        .writeSystemTime(new Date("2025-01-02T03:04:05.006Z")),
    ]) {
      client.sendToServer(state, session.sessionId, packet);
    }

    const malformedBodies = [
      new PacketWriter(ClientOpcode.ExchangeAction).writeU8(2).writeU8(0),
      new PacketWriter(ClientOpcode.ExchangeAction).writeU8(3),
      new PacketWriter(ClientOpcode.ExchangeAction).writeU8(3).writeU32(10000).writeU8(1),
      new PacketWriter(ClientOpcode.ExchangeAction)
        .writeU8(3)
        .writeU32(10000)
        .writeU8(1)
        .writeBlock(new Uint8Array(19)),
      new PacketWriter(ClientOpcode.ExchangeAction).writeU8(4),
    ];
    for (const packet of malformedBodies) client.sendToServer(state, session.sessionId, packet);

    // A shared C->S 94 string from Exchange is not reinterpreted as a room-password update;
    // C->S 101's exact pass string is checked without exposing it in logs or replies.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ChangeRoomPassword).writeString("exchange-password-marker")
    );
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ExchangePassCheck).writeString("exchange-secret-marker")
    );
    session.stageId = StageId.Chatting;
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ChangeRoomPassword).writeString("chatting-password-marker")
    );
    expect(room.password).toBe("");
    session.stageId = StageId.Exchange;

    // Exact formats in the wrong stage or without a selected channel are not acted on.
    session.stageId = StageId.Prepare;
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.ExchangeAction).writeU8(2));
    session.stageId = StageId.Exchange;
    session.channelSelected = false;
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.ExchangeAction).writeU8(2));

    expect(session.stageId).toBe(StageId.Exchange);
    expect(session.currentRoomNumber).toBe(room.roomNumber);
    expect(room.isPlaying).toBe(false);
    expect(room.password).toBe("");
    expect(users.map((user) => state.db.getUserStock(user.id))).toEqual(stockBefore);
    for (const opcode of [
      ServerOpcode.ExchangeItems,
      ServerOpcode.ExchangeState,
      ServerOpcode.ExchangeAccessories,
      ServerOpcode.ExchangePassResult,
    ]) {
      expect(client.popByOpcode(opcode)).toBeUndefined();
    }
    expect(client.receivedPackets).toHaveLength(0);
    const observations = getRecentLogs().filter(
      (entry) => entry.category === "PacketAudit" && entry.data?.wireOpcode === ClientOpcode.ExchangeAction
    );
    expect(observations).toHaveLength(4);
    expect(observations.every((entry) => entry.data?.responseSent === false)).toBe(true);
    expect(observations.every((entry) => entry.data?.databaseMutation === false)).toBe(true);
    expect(JSON.stringify(getRecentLogs())).not.toContain("exchange-secret-marker");
    expect(JSON.stringify(getRecentLogs())).not.toContain("exchange-password-marker");
    expect(JSON.stringify(getRecentLogs())).not.toContain("chatting-password-marker");
  });
});

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

  test("UserMarket entry stays behind Client feature 28 and the local 318 permission sequence", () => {
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51031, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.users = [state.db.createUser("market_feature_gate", "password")];
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.Lobby;
    expect(config.enabledFeatures.has(28)).toBe(false); // default Taiwan feature set

    // Empty-body validation and selected-channel/stage conditions are local gate inputs.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.RequestUserMarketConnection).writeU8(0)
    );
    session.channelSelected = false;
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.RequestUserMarketConnection));
    session.channelSelected = true;
    session.stageId = StageId.Prepare;
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.RequestUserMarketConnection));
    session.stageId = StageId.Lobby;
    expect(client.receivedPackets).toHaveLength(0);
    expect(session.userMarketPermissionGranted).toBe(false);

    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.RequestUserMarketConnection));
    expect(client.popByOpcode(ServerOpcode.UserMarketPermission)?.readU8()).toBe(0);
    expect(client.popByOpcode(ServerOpcode.UserMarketFeeInfo)).toBeUndefined();
    expect(session.userMarketPermissionGranted).toBe(false);

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketFeeInfoReply320).writeU32(5).writeString("").writeU32(100)
    );
    expect(client.popByOpcode(ServerOpcode.UserMarketEnterResult)).toBeUndefined();
    expect(session.stageId).toBe(StageId.Lobby);

    config.enabledFeatures = new Set(config.enabledFeatures).add(28);
    session.stageId = StageId.Prepare;
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.RequestUserMarketConnection));
    session.stageId = StageId.Lobby;
    session.channelSelected = false;
    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.RequestUserMarketConnection));
    session.channelSelected = true;
    expect(client.receivedPackets).toHaveLength(0);
    expect(session.userMarketPermissionGranted).toBe(false);

    client.sendToServer(state, session.sessionId, new PacketWriter(ClientOpcode.RequestUserMarketConnection));
    expect(client.popByOpcode(ServerOpcode.UserMarketPermission)?.readU8()).toBe(1);
    const feeInfo = client.popByOpcode(ServerOpcode.UserMarketFeeInfo)!;
    expect(feeInfo.readU32()).toBe(5); // local fixture value
    expect(feeInfo.readString()).toBe("");
    expect(feeInfo.readU32()).toBe(100); // local fixture value
    expect(feeInfo.remaining).toBe(0);
    expect(session.userMarketPermissionGranted).toBe(true);

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketFeeInfoReply320)
        .writeU32(5)
        .writeString("")
        .writeU32(100)
        .writeU8(0)
    );
    expect(client.popByOpcode(ServerOpcode.UserMarketEnterResult)).toBeUndefined();
    expect(session.stageId).toBe(StageId.Lobby);
    expect(session.userMarketPermissionGranted).toBe(true);

    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.UserMarketFeeInfoReply320).writeU32(5).writeString("").writeU32(100)
    );
    expect(client.popByOpcode(ServerOpcode.UserMarketEnterResult)?.readU8()).toBe(1);
    expect(session.stageId).toBe(StageId.UserMarket);
    expect(session.userMarketPermissionGranted).toBe(false);
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

  test("ShopTrace retains aliases for overloaded Client opcodes", () => {
    clearRecentLogs();
    const config = loadConfig({ dbPath: ":memory:" });
    using state = new WorldState(config);
    const client = new SimulatedClient();
    const session = state.createSession(client.onWireBytes, "127.0.0.1", 51019, "0.0.0.0", 0, "game");
    session.sendConnectHello(config);
    session.users = [state.db.createUser("shop_cash_trace", "password")];
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.Shop;

    // C->S 269 is labeled ShopEnter by the first declaration, but ShopCashQuery is also
    // documented for this value. Keep both names visible in the info-level candidate trace.
    client.sendToServer(
      state,
      session.sessionId,
      new PacketWriter(ClientOpcode.ShopEnter).writeU8(0)
    );

    const shopTrace = getRecentLogs().findLast(
      (entry) =>
        entry.category === "ShopTrace" &&
        entry.data?.opcode === formatClientOpcode(ClientOpcode.ShopEnter)
    );
    expect(shopTrace?.data?.stageId).toBe(formatStageId(StageId.Shop));
    expect(shopTrace?.data?.opcodeAliases).toEqual(["ShopCashQuery"]);
    expect(session.getPacketTraceSummary().packetFlow).toContain("aliases=[ShopCashQuery]");
    expect(client.popByOpcode(ServerOpcode.ShopCashBalance198)).toBeDefined();
    expect(session.stageId).toBe(StageId.Shop);
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
    chiefSession.channelSelected = true;
    kickedSession.channelSelected = true;
    normalSession.channelSelected = true;

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
    leavingSession.channelSelected = true;
    remainingSession.channelSelected = true;
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
    session.users = [state.db.createUser("LobbyDetailRequester", "password")];
    session.stageId = StageId.Lobby;
    session.channelIndex = 1;
    session.channelSelected = true;

    const roomOwnerClient = new SimulatedClient();
    const roomOwner = state.createSession(roomOwnerClient.onWireBytes, "127.0.0.1", 51015, "0.0.0.0", 0, "game");
    roomOwner.sendConnectHello(config);
    roomOwner.users = [state.db.createUser("DetailUser", "password")];
    roomOwner.netSlotIds = [state.allocateNetSlotId()];
    roomOwner.channelIndex = 1;
    roomOwner.channelSelected = true;
    const room = state.createRoom(roomOwner, "Lobby detail", "", false, 0, 0, [0]);

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
    // Client stores this at local-user +95. The same value authenticates C->S 6 and must be
    // echoed as room CUser+32 so `sub_5D9716` can resolve Prepare interactions to local player 0.
    expect(session1.netSlotIds).toEqual([token1]);
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
    expect(session1.netSlotIds).toEqual([token1]);

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
    expect(declaredDynMapBodyChecksum).toBe(state.resources.dynamicMapInfo.served.adler32Zero);
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
    const starterInventoryRow = state.db.getUserStock(loggedInUser.id).find((item) => item.itemCode === 1001)!;
    expect(p194_init.readU32()).toBe(starterInventoryRow.id); // local builder emits inventory.id, not itemCode
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
      "197 (UserItemsData)",
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

    // 7. Create Room (local C->S 75 -> S->C 79). The Client normal-strategy parser
    // sub_4CCE53 only requests Stage 12; CMainWnd constructs it on a later main-loop turn, so
    // local S->C 102 is deferred until the next decoded C->S packet establishes ordering.
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
    const roomGameKey = p79.readU32();
    expect(roomGameKey).toBe(state.rooms.get(roomNum)!.chiefSlotNetId);
    expect(client1.popByOpcode(102)).toBeUndefined();
    expect(session1.stageId).toBe(StageId.Prepare);
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ClientPeriodicStatus).writeU32(1).writeU32(2)
    );
    expect(client1.popByOpcode(102)).toBeDefined(); // Deferred S->C 102 after Client resumed

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
    expect(client2StageConfig.readU32()).toBe(state.resources.dynamicMapInfo.served.adler32Zero);
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

    // 9b. CExchangeStage `C->S 101` is confirmed as a pass-string writer, but this
    // reconstruction has no exchange-password store; it must not invent a successful unlock.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ExchangePassCheck).writeString("pass123")
    );
    expect(client1.popByOpcode(ServerOpcode.ExchangePassResult)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.ExchangeState)).toBeUndefined();
    expect(client2.popByOpcode(ServerOpcode.ExchangeState)).toBeUndefined();

    // The recovered C->S 100 body is parsed as a Client form, but the local server has no
    // trusted escrow/readiness transaction or confirmed S->C 128 association. Audit only.
    const exchangePacketsBefore = [client1, client2].map((client) => client.receivedPackets.length);
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ExchangeAction)
        .writeU8(3) // Client state value; exact body form only
        .writeU32(10000) // opaque Client u32 candidate; not applied as currency
        .writeU8(1) // one offered row
        .writeU32(2005) // opaque Client stock lookup candidate
        .writeSystemTime()
    );
    expect(client1.popByOpcode(ServerOpcode.ExchangeItems)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.ExchangeState)).toBeUndefined();
    expect(client2.popByOpcode(ServerOpcode.ExchangeItems)).toBeUndefined();
    expect(client2.popByOpcode(ServerOpcode.ExchangeState)).toBeUndefined();
    expect([client1, client2].map((client) => client.receivedPackets.length)).toEqual(exchangePacketsBefore);

    // 10. Chief starts match with the recovered C->S 93 base layout: 14-byte prefix + ESFN u32.
    // S->C 112 (`sub_4D9F26`) confirms the request, then S->C 113 (`sub_4D9F8A`) transitions.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.StartMatch)
        .writeU32(5) // Client dyn-group counter (`sub_4DE164`).
        .writeU32(5) // fxdynmapinfo `v34` map ID (`sub_4DDB1E`), C->S 93 field1.
        .writeU8(0) // Client writer's constant byte.
        .writeU32(0) // Client dyn-list selection index.
        .writeU8(0) // Client map selectable flag.
        .writeU32(0) // ESFN checksum
    );
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

    // 11. Both Clients register through the recovered 36B UDP opcode-1 writer.
    //     S->C 136 acknowledges each new slot once; the last registration triggers S->C 135.
    const udpRegistration1 = buildUdpGameLoadRegistration({
      userId: session1.users[0]!.id,
      roomId: roomNum,
      roomGameKey,
      localIp0: 0xc0a80119, // 192.168.1.25
      localPort0: 56002,
      localIp1: 0,
      localPort1: 0,
      mapCrc8: 0,
      player0Attrs: [0, 0, 0, 0],
      player1Attrs: [0, 0, 0, 0],
    });
    const udpRegistration2 = buildUdpGameLoadRegistration({
      userId: session2.users[0]!.id,
      roomId: roomNum,
      roomGameKey,
      localIp0: 0xc0a8011a, // 192.168.1.26
      localPort0: 56003,
      localIp1: 0,
      localPort1: 0,
      mapCrc8: 0,
      player0Attrs: [0, 0, 0, 0],
      player1Attrs: [0, 0, 0, 0],
    });
    dispatchUdpDatagram(state, udpRegistration1, "203.0.113.52", 55001);
    expect(client1.popByOpcode(ServerOpcode.PlayerLoadedAck)?.readU8()).toBe(0);
    expect(client2.popByOpcode(ServerOpcode.PlayerLoadedAck)?.readU8()).toBe(0);

    dispatchUdpDatagram(state, udpRegistration2, "203.0.113.53", 55002);
    expect(client1.popByOpcode(ServerOpcode.PlayerLoadedAck)?.readU8()).toBe(1);
    expect(client2.popByOpcode(ServerOpcode.PlayerLoadedAck)?.readU8()).toBe(1);
    const p135_1 = client1.popByOpcode(ServerOpcode.AllPlayersLoadedStart)!;
    const p135_2 = client2.popByOpcode(ServerOpcode.AllPlayersLoadedStart)!;
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
    const expectedPlayer2Endpoints = [
      { ip: 0xc0a8011a, port: 56003 }, // client-advertised local interface
      { ip: 0, port: 0 }, // absent second interface remains absent
      { ip: 0xcb007135, port: 55002 }, // UDP source observed by the server
    ];
    expect(peerSlots1[1]).toEqual(expectedPlayer2Endpoints);
    expect(peerSlots2[1]).toEqual(expectedPlayer2Endpoints);
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

    // A duplicate registration for player 2 is idempotent after the all-loaded transition.
    const startTickAfterAllLoaded = state.rooms.get(roomNum)!.startTick;
    dispatchUdpDatagram(state, udpRegistration2, "203.0.113.53", 55002);
    expect(session2.udpEndpoint).toEqual({ address: "203.0.113.53", port: 55002 });
    expect(client1.popByOpcode(ServerOpcode.PlayerLoadedAck)).toBeUndefined();
    expect(client2.popByOpcode(ServerOpcode.PlayerLoadedAck)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.AllPlayersLoadedStart)).toBeUndefined();
    expect(client2.popByOpcode(ServerOpcode.AllPlayersLoadedStart)).toBeUndefined();
    expect(state.rooms.get(roomNum)!.startTick).toBe(startTickAfterAllLoaded);

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

    // 15. Shop request telemetry plus the local room-context C->S 98 Shop-entry adapter;
    //     this does not assign C->S 38 authentication or official-server transition semantics.
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

    const receivedBeforeRoomValue0 = client1.receivedPackets.length;
    const roomBeforeRoomValue0 = state.rooms.get(session1.currentRoomNumber!)!;
    const localSlotBeforeRoomValue0 = roomBeforeRoomValue0.slots.find(
      (slot) => slot.session === session1 && slot.localPlayerIdx === 0
    )!;
    const slotStateBeforeRoomValue0 = {
      inShop: localSlotBeforeRoomValue0.inShop,
      ready: localSlotBeforeRoomValue0.ready,
    };
    const userBeforeRoomValue0 = state.db.getUserById(updatedBazzi.id)!;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ContextualClientPacket98).writeU8(0)
    );
    expect(session1.stageId).toBe(StageId.Prepare);
    expect(client1.receivedPackets).toHaveLength(receivedBeforeRoomValue0);
    expect(localSlotBeforeRoomValue0).toMatchObject(slotStateBeforeRoomValue0);
    expect(state.db.getUserById(updatedBazzi.id)).toEqual(userBeforeRoomValue0);

    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ContextualClientPacket98).writeU8(1)
    );
    expect(session1.stageId).toBe(StageId.Shop);
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
    expect(p16.remaining).toBe(0);
    const localShopStock = client1.popByOpcode(ServerOpcode.ShopLocalStockList198)!;
    const expectedShopStock = state.db.getUserStock(updatedBazzi.id);
    expect(localShopStock.readU16()).toBe(expectedShopStock.length);
    for (const item of expectedShopStock) {
      expect(localShopStock.readU32()).toBe(item.id);
      expect(localShopStock.readU32()).toBe(item.itemCode);
      expect(localShopStock.readU16()).toBe(item.quantity);
      expect(localShopStock.readU32()).toBe(item.expireTs);
      expect(localShopStock.readU8()).toBe(item.equipped);
    }
    expect(localShopStock.remaining).toBe(0);

    // Client-verified follow-up: the Shop stage's S->C 213 handler (CShopStageNew::sub_536555)
    // is the non-retry writer of C->S 269 [u8(1)] ShopEnter. The local room-context Shop-entry
    // policy sends the minimal ok=0 trigger after S->C 16.
    const shopEnterTrigger = client1.popByOpcode(ServerOpcode.NexonClubAuthResult)!;
    expect(shopEnterTrigger.readU8()).toBe(0); // ok = 0 (no clubId field)
    expect(shopEnterTrigger.readU8()).toBe(0); // playerIdx = 0
    expect(shopEnterTrigger.remaining).toBe(0);

    // Value 0 belongs to the separate UserMarket caller; it must not reuse the old local
    // room-leave interpretation while the same session is in Shop.
    const receivedBeforeWrongContext98 = client1.receivedPackets.length;
    const shopSlotStateBeforeWrongContext98 = {
      inShop: localSlotBeforeRoomValue0.inShop,
      ready: localSlotBeforeRoomValue0.ready,
    };
    const userBeforeWrongContext98 = state.db.getUserById(updatedBazzi.id)!;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ContextualClientPacket98).writeU8(0)
    );
    expect(session1.stageId).toBe(StageId.Shop);
    expect(client1.receivedPackets).toHaveLength(receivedBeforeWrongContext98);
    expect(localSlotBeforeRoomValue0).toMatchObject(shopSlotStateBeforeWrongContext98);
    expect(state.db.getUserById(updatedBazzi.id)).toEqual(userBeforeWrongContext98);

    expect(client1.popByOpcode(ServerOpcode.CrashDumpChunkRequest)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.InventoryData)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeUndefined();

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

    const starterStockId = state.db
      .getUserStock(updatedBazzi.id)
      .find((item) => item.itemCode === 1001)!.id;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.InventoryEquipSync)
        .writeU8(0) // observed active-item sync mode
        .writeU8(0) // local player index
        .writeU16(1) // u16 row count
        .writeU8(2) // opaque Client field; local reconstruction slot mapping only
        .writeU32(starterStockId)
    );
    const equipSync196 = client1.popByOpcode(ServerOpcode.EquippedAvatarData)!;
    expect(equipSync196.readU8()).toBe(1);
    expect(equipSync196.readU32()).toBe(0); // first local avatar slot is empty after the local mapping
    expect(equipSync196.readString()).toBe("");
    expect(equipSync196.readU32()).toBe(starterStockId);
    expect(equipSync196.readString()).toBe("");
    for (let slot = 2; slot < 8; slot++) {
      expect(equipSync196.readU32()).toBe(0);
      expect(equipSync196.readString()).toBe("");
    }
    expect(equipSync196.remaining).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.ShopBuyResult)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.StageSpecificRoute204)).toBeUndefined();

    // The Client writer is recovered in CPrepareStage; leave the synthetic Shop connection
    // context and restore Prepare before exercising its empty C->S 78 body.
    session1.stageId = StageId.Prepare;

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

    // 17. UserMarket packet sequence. The source confirms the Client writers/readers; the
    // local permission response is not official-server evidence. This happy path opts into
    // Client feature 28 explicitly; default Taiwan configuration keeps it disabled.
    config.enabledFeatures = new Set(config.enabledFeatures).add(28);
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

    // The same Client function separately sends C->S 98 [u8(0)] after C->S 321.
    // The stage-aware dispatcher keeps this UserMarket caller observation-only; it is not room leave.
    const userBeforeMarket98 = state.db.getUserById(loggedInUser.id)!;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ContextualClientPacket98).writeU8(0)
    );
    expect(client1.receivedPackets).toHaveLength(receivedPacketCountBefore321);
    expect(session1.stageId).toBe(StageId.UserMarket);
    const market98Audit = getRecentLogs().findLast(
      (entry) =>
        entry.category === "PacketAudit" &&
        entry.message.includes("C->S 98 UserMarket follow-up")
    );
    expect(market98Audit?.data?.responseAssociation).toBe("UNKNOWN");
    expect(market98Audit?.data?.responseSent).toBe(false);
    expect(market98Audit?.data?.stageChanged).toBe(false);
    expect(market98Audit?.data?.databaseMutation).toBe(false);
    expect(state.db.getUserById(loggedInUser.id)).toEqual(userBeforeMarket98);

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
    // Return from UserMarket through the recovered Shop-entry writer before Shop-only transactions.
    client1.sendToServer(state, session1.sessionId, new PacketWriter(ClientOpcode.ShopEnter).writeU8(1));
    expect(session1.stageId).toBe(StageId.Shop);
    // S->C 198 is overloaded; the earlier local stock snapshot was consumed above, so this
    // C->S 269 re-entry contributes only the local cash/status fixture here.
    const cash198 = client1.popByOpcode(ServerOpcode.ShopCashBalance198)!;
    expect(cash198.readU32()).toBe(state.db.getUserById(loggedInUser.id)!.cash);
    expect(cash198.readU8()).toBe(1);
    expect(cash198.remaining).toBe(0);
    expect(client1.popByOpcode(ServerOpcode.ShopConfigSync)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.ShopConfigCrc224)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.InventoryData)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.ShopGiftList)).toBeDefined();

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
    const boughtHatStockId = state.db
      .getUserStock(updatedBazzi.id)
      .find((item) => item.itemCode === 3001)!.id;
    expect(session1.connectionKind).toBe("game");
    expect(session1.channelSelected).toBe(true);
    expect(session1.stageId).toBe(StageId.Shop);
    expect(session1.users).toHaveLength(1);
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopUseOrEquip274)
        .writeU8(0)
        .writeU8(0)
        .writeU32(boughtHatStockId)
        .writeString("Bazzi Hat")
    );
    const p196 = client1.popByOpcode(ServerOpcode.EquippedAvatarData)!;
    expect(p196).toBeDefined();
    expect(p196.readU8()).toBe(1); // playerCount = 1
    expect(p196.readU32()).toBe(boughtHatStockId); // local inventory-row stockId mapping
    expect(p196.readString()).toBe("Bazzi Hat");
    expect(client1.popByOpcode(ServerOpcode.InventoryUpdate)).toBeDefined();

    // Batch update custom text (`C->S 275`, `CShopTextDlg::sub_48ED44`)
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopInventoryTab275)
        .writeU8(0)
        .writeU8(1)
        .writeU32(boughtHatStockId)
        .writeString("Updated Text")
    );
    expect(client1.popByOpcode(ServerOpcode.InventoryUpdate)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.EquippedAvatarData)).toBeDefined();
    expect(client1.popByOpcode(ServerOpcode.ShopLocalStockList198)).toBeUndefined();
    expect(state.db.getUserStock(loggedInUser.id).find((item) => item.id === boughtHatStockId)?.customText).toBe("Updated Text");

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

    // Coupon writer schema is known, but code validation/reward mapping is not. An arbitrary
    // coupon string must not mint the reconstruction's former fixed reward or fake an OK reply.
    expect(client1.popByOpcode(ServerOpcode.StageSpecificRoute204)).toBeUndefined();
    const packetCountBeforeCoupon = client1.receivedPackets.length;
    const stockCountBeforeCoupon = state.db.getUserStock(loggedInUser.id).length;
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ShopCouponRequest280)
        .writeString("BNB-COUPON-2026")
        .writeString("")
    );
    expect(client1.popByOpcode(ServerOpcode.StageSpecificRoute204)).toBeUndefined();
    expect(client1.receivedPackets).toHaveLength(packetCountBeforeCoupon);
    expect(state.db.getUserStock(loggedInUser.id)).toHaveLength(stockCountBeforeCoupon);

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
      new PacketWriter(ClientOpcode.BasketQueryCoupons).writeU8(0)
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

    // 18b. Re-enter the local UserMarket-stage candidate before its listing, purchase & transfer flows.
    // The Client writer/reader shapes are source-backed; this server-side transition sequence is local policy.
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.RequestUserMarketConnection)
    );
    expect(client1.popByOpcode(ServerOpcode.UserMarketPermission)?.readU8()).toBe(1);
    expect(client1.popByOpcode(ServerOpcode.UserMarketFeeInfo)).toBeDefined();
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketFeeInfoReply320).writeU32(5).writeString("").writeU32(100)
    );
    expect(client1.popByOpcode(ServerOpcode.UserMarketEnterResult)?.readU8()).toBe(1);
    expect(session1.stageId).toBe(StageId.UserMarket);

    // This newly seeded row avoids reusing the C->S 283 test item after its local resell path
    // has deleted it; no Client-to-inventory primary-key mapping is implied.
    const marketStockId = state.db.addStockItem(loggedInUser.id, 3002);
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.UserMarketRegisterListing326).writeU32(3002).writeU32(1000)
    );
    const p273 = client1.popByOpcode(ServerOpcode.UserMarketRegisterResult)!;
    expect(p273).toBeDefined();
    expect(p273.readU16()).toBe(0); // local reconstruction result value
    expect(p273.readU32()).toBe(3002); // locally mapped to the owned demo inventory item
    expect(p273.remaining).toBe(0);

    const listings = state.db.getActiveMarketListings();
    expect(listings).toHaveLength(1);
    const listing = listings[0]!;
    const listingId = listing.id;
    expect(listing.stockId).toBe(marketStockId); // local mapping to the escrowed SQLite inventory row
    expect(listing.itemCode).toBe(3002);
    expect(listing.price).toBe(1000); // local fixture policy, not official market price
    expect(state.db.getUserStock(loggedInUser.id).find((item) => item.id === marketStockId)?.marketStatus).toBe(1);

    // S->C 272 and S->C 275 both start with one u16 count, then client-decoded
    // [u32, u32, str, u32, u16] rows. Field meanings are local fixture mappings.
    for (const opcode of [ServerOpcode.UserMarketList, ServerOpcode.UserMarketMySalesList]) {
      const marketRows = client1.popByOpcode(opcode)!;
      expect(marketRows.readU16()).toBe(1);
      expect(marketRows.readU32()).toBe(listingId);
      expect(marketRows.readU32()).toBe(3002);
      expect(marketRows.readString()).toBe("bazzi_tw");
      expect(marketRows.readU32()).toBe(1000);
      expect(marketRows.readU16()).toBe(24);
      expect(marketRows.remaining).toBe(0);
    }

    // Player 2 is still in Prepare after the match; leave the room and follow the local
    // Lobby -> 318/265 -> 320 candidate sequence before attempting a UserMarket transaction.
    client2.sendToServer(state, session2.sessionId, new PacketWriter(ClientOpcode.LeaveRoom));
    expect(session2.stageId).toBe(StageId.Lobby);
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.RequestUserMarketConnection)
    );
    expect(client2.popByOpcode(ServerOpcode.UserMarketPermission)?.readU8()).toBe(1);
    expect(client2.popByOpcode(ServerOpcode.UserMarketFeeInfo)).toBeDefined();
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.UserMarketFeeInfoReply320).writeU32(5).writeString("").writeU32(100)
    );
    expect(client2.popByOpcode(ServerOpcode.UserMarketEnterResult)?.readU8()).toBe(1);
    expect(session2.stageId).toBe(StageId.UserMarket);

    // Player 2 buys the listing (`C->S 330` -> local S->C 277)
    const buyerStockIdsBeforeMarketPurchase = new Set(
      state.db.getUserStock(session2.users[0]!.id).map((item) => item.id)
    );
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.UserMarketBuyListing).writeU32(listingId)
    );
    const p277 = client2.popByOpcode(ServerOpcode.UserMarketPurchaseResult)!;
    expect(p277).toBeDefined();
    expect(p277.readU16()).toBe(0); // local success fixture; official result mapping is not inferred
    expect(p277.readU32()).toBe(3002); // local listing itemCode mapping; not established as a Client stock ID
    const buyerAfterMarketPurchase = state.db.getUserById(session2.users[0]!.id)!;
    const sellerAfterMarketPurchase = state.db.getUserById(session1.users[0]!.id)!;
    expect(p277.readU32()).toBe(buyerAfterMarketPurchase.marketLucci ?? buyerAfterMarketPurchase.lucci);
    expect(p277.readVariantTime()).toBeGreaterThan(45000);
    expect(p277.remaining).toBe(0);
    expect(state.db.db.query<{ status: number }, { id: number }>(
      "SELECT status FROM market_listings WHERE id = $id"
    ).get({ id: listingId })?.status).toBe(1);
    expect(state.db.getActiveMarketListings()).toHaveLength(0);
    expect(state.db.getUserStock(loggedInUser.id).some((item) => item.id === marketStockId)).toBe(false);
    const acquiredMarketStock = state.db
      .getUserStock(session2.users[0]!.id)
      .filter((item) => item.itemCode === 3002 && !buyerStockIdsBeforeMarketPurchase.has(item.id));
    expect(acquiredMarketStock).toHaveLength(1);
    expect(acquiredMarketStock[0]?.marketStatus).toBe(0);
    expect(session1.users[0]?.marketLucci).toBe(sellerAfterMarketPurchase.marketLucci);
    expect(session2.users[0]?.marketLucci).toBe(buyerAfterMarketPurchase.marketLucci);
    // No seller-side notification packet is emitted; its official association is unknown.
    expect(client1.popByOpcode(ServerOpcode.MarketExpiredReturns)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.MarketSoldNotifications)).toBeUndefined();

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
    //     Chat Macro (`C->S 40` -> `S->C 50`), Exchange (`C->S 99..101`), the observation-only
    //     one-u32 C->S 286 writer, and Account Registration (`C->S 32..36, 46`)
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

    // C->S 286 carries one Client-written u32, but neither its field meaning nor any official
    // response/reward association is established. The reconstruction validates width only.
    expect(client1.popByOpcode(ServerOpcode.StageSpecificRoute204)).toBeUndefined();
    const packetCountBeforeOpaque286 = client1.receivedPackets.length;
    const stockBeforeOpaque286 = state.db.getUserStock(loggedInUser.id);
    client1.sendToServer(
      state,
      session1.sessionId,
      new PacketWriter(ClientOpcode.ClientPacket286).writeU32(5001)
    );
    expect(client1.popByOpcode(ServerOpcode.StageSpecificRoute204)).toBeUndefined();
    expect(client1.receivedPackets).toHaveLength(packetCountBeforeOpaque286);
    expect(state.db.getUserStock(loggedInUser.id)).toEqual(stockBeforeOpaque286);

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

    // C->S 100/101 writer shapes are covered by the dedicated Exchange audit test.
    // These sessions have already left the room, so this unrelated context must not
    // synthesize an S->C 128 trade offer, S->C 126 state, or password-verification reply.
    const marketContextPacketCountBefore = [client1, client2].map((client) => client.receivedPackets.length);
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
    client2.sendToServer(
      state,
      session2.sessionId,
      new PacketWriter(ClientOpcode.ExchangePassCheck).writeString("pass123")
    );
    expect(client1.popByOpcode(ServerOpcode.ExchangeItems)).toBeUndefined();
    expect(client1.popByOpcode(ServerOpcode.ExchangeState)).toBeUndefined();
    expect(client2.popByOpcode(ServerOpcode.ExchangeItems)).toBeUndefined();
    expect(client2.popByOpcode(ServerOpcode.ExchangeState)).toBeUndefined();
    expect(client2.popByOpcode(ServerOpcode.ExchangePassResult)).toBeUndefined();
    expect([client1, client2].map((client) => client.receivedPackets.length)).toEqual(marketContextPacketCountBefore);

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
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.Shop;

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
    session.channelSelected = true;
    session.channelIndex = 0;
    session.stageId = StageId.Shop;
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
          entry.message === "LoginServer connection closed" &&
          entry.data?.sessionId === sessionId
      );
      expect(closeLog?.data?.closeInitiator).toBe("server-requested");
      expect(closeLog?.data?.serverCloseReason).toBe("server-shutdown");
      expect(closeLog?.data?.serverToClientWriteCalls).toBe(1);
      expect(closeLog?.data?.clientToServerDecodedPackets).toBe(0);
      expect(closeLog?.data?.packetFlow).toContain("S->C [write-call] ConnectHello");
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
      expect(stageConfig207.readU32()).toBe(server.state.resources.dynamicMapInfo.served.adler32Zero);
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
        ServerOpcode.UserItemsData,
        ServerOpcode.ExpSync,
        ServerOpcode.UserDynamicInfoFieldSync186,
        ServerOpcode.InventoryData,
        ServerOpcode.EquippedAvatarData,
        ServerOpcode.InventoryExpansionSlots,
        ServerOpcode.CoupleInfoSync,
        ServerOpcode.DynamicMapAndStageConfig,
      ]);
      expect(lobbyInitPackets.map((entry) => entry.data?.payloadBytes)).toEqual([
        36986, 5, 8, 29, 49, 5, 4, 13,
      ]);
      const lobbyInitLog = getRecentLogs().findLast((entry) => entry.category === "LobbyInit");
      expect(lobbyInitLog?.data?.feature32Enabled).toBe(false);
      expect(lobbyInitLog?.data?.stageConfig207WriteCall).toBe(true);
      expect(lobbyInitLog?.data?.clientModalDismissalVerified).toBe(false);
      expect(lobbyInitLog?.data?.serverOpcodes).toEqual([
        "197 (UserItemsData)",
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
        entry.message === "GameServer connection closed" &&
        entry.data?.sessionId === gameSessionId
    );
    expect(gameCloseLog?.data?.closeInitiator).toBe("unknown");
    expect(gameCloseLog?.data?.serverCloseReason).toBeUndefined();
    expect(gameCloseLog?.data?.clientToServerDecodedPackets).toBe(5);
    expect(gameCloseLog?.data?.serverToClientWriteCalls).toBe(11);
    expect(gameCloseLog?.data?.pendingReceiveBytes).toBe(0);
    expect(gameCloseLog?.data?.lobbyEntryPacketSeen).toBe(true);
    expect(gameCloseLog?.data?.linkedLoginSessionId).toBe(linkedLoginSessionId);
    expect(gameCloseLog?.data?.packetFlow).toContain("C->S [decoded] 83 (EnterLobby)");
    expect(gameCloseLog?.data?.packetFlow).toContain("S->C [write-call] 197 (UserItemsData)");
    expect(gameCloseLog?.data?.packetFlow).toContain("S->C [write-call] 89 (ExpSync)");
    expect(gameCloseLog?.data?.packetFlow).toContain(
      "S->C [write-call] 207 (DynamicMapAndStageConfig)"
    );
    expect(gameCloseLog?.message).not.toContain("live_tester");
  });
});
