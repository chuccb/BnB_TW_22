import { describe, expect, test } from "bun:test";
import {
  decodeConnectHelloFirstByte,
  encodeConnectHelloFirstByte,
  encryptPayload,
  decryptPayload,
  getConnectHelloTable,
} from "../src/protocol/cipher.ts";
import { computeAdler32Zero, computeCRC8, computeCRC32 } from "../src/protocol/crc.ts";
import {
  MTUDPPeer,
  PacketSocketState,
  decodeUdpDatagram,
  encodeUdpDatagram,
} from "../src/protocol/framing.ts";
import {
  PacketReader,
  PacketWriter,
  ipv4ToInAddrLittleEndian,
  ipv4ToUint32,
  scrambleBlock,
  unixMsToVariantTime,
  unscrambleBlock,
  variantTimeToUnixMs,
} from "../src/protocol/primitives.ts";
import {
  SmartStreamReader,
  SmartStreamWriter,
  computeSmartStreamBodyChecksum,
} from "../src/protocol/stream.ts";
import {
  DEFAULT_C_CHANNELS,
  findCChannelByCategoryOrdinal,
  getCChannelCategoryOrdinal,
  normalizeCChannelCategory,
} from "../src/protocol/channelCache.ts";
import { decodeClientText, encodeClientText } from "../src/protocol/textEncoding.ts";
import { parseSessionHandoffPayload } from "../src/handlers/channelHandler.ts";
import { ClientOpcode, ServerOpcode, StageId } from "../src/protocol/opcodes.ts";
import { ClientSession } from "../src/state/worldState.ts";
import {
  clearRecentLogs,
  formatClientOpcode,
  formatServerOpcode,
  formatStageId,
  getRecentLogs,
  getLogLevel,
  setLogLevel,
} from "../src/utils/logger.ts";

describe("Protocol Layer — CRC, Cipher, Primitives, SmartStream & Framing", () => {
  test("CCRC32 and CCRC8 match MSB-first polynomials 0x04C11DB7 and 0x07", () => {
    const sample = new TextEncoder().encode("CrazyArcade_TW_22");
    const crc32a = computeCRC32(sample.length, sample, sample.length);
    const crc32b = computeCRC32(sample.length, sample, sample.length);
    expect(crc32a).toBe(crc32b);
    expect(crc32a).not.toBe(0);

    const crc8a = computeCRC8(40, sample, sample.length);
    const crc8b = computeCRC8(40, sample, sample.length);
    expect(crc8a).toBe(crc8b);
    const crc8Reference = new TextEncoder().encode("123456789");
    expect(computeCRC8(0, crc8Reference)).toBe(0xf4);
    expect(computeCRC8(40, crc8Reference)).toBe(0x38);
    expect(crc8a).toBeGreaterThanOrEqual(0);
    expect(crc8a).toBeLessThanOrEqual(255);
  });

  test("CPacketCipher (sub_695B00 / sub_695BA0) round-trips all payload lengths including tail bytes", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 31, 64, 129]) {
      const plain = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        plain[i] = (i * 73 + 19) & 0xff;
      }
      const counter = 40 + len * 3;
      const cipher = encryptPayload(counter, plain);
      const recovered = decryptPayload(counter, cipher);
      expect(Array.from(recovered)).toEqual(Array.from(plain));
    }
  });

  test("CPacketCipher reproduces the 09:50 C->S PreLoginSsdCheck vector from CA.exe", () => {
    // CA.exe decompiles the word-step subtraction as 1674226915; machine code at
    // 0x695B46/0x695BE7 confirms 0x63CAACE3. The 09:50 trace shows the first 16
    // ciphertext bytes and CRC trailer; the two-byte tail below is predicted by CA's code.
    const serverSock = new PacketSocketState("server");
    const clientSock = new PacketSocketState("client");
    const hello = serverSock.encodeConnectHello({
      flag: 0,
      minVersion: 22,
      currentVersion: 22,
      sessionKey: 0x12340001,
      noticeUrl: "http://tw.beanfun.com/bnb/",
      extraFlag: 0,
    });
    clientSock.decodeConnectHello(hello);

    // Field 0 is the dynamic-image context's zero sentinel. Field 2 is also zero
    // in this capture; CMultiServer initializes +108 to zero unless a local
    // multisvr.ssd checksum is loaded. The other two values match checked-in .ssd files.
    const writer = new PacketWriter(ClientOpcode.PreLoginSsdCheck, 2)
      .writeU32(0)
      .writeU32(0xe734d04f)
      .writeU32(0)
      .writeU32(0x000e496d);
    expect(Array.from(writer.toPayload())).toEqual([
      0xa5, 0x69, 0x96, 0xca, 0x53, 0x95, 0x71, 0xfe, 0x83,
      0xda, 0x96, 0xca, 0x53, 0x95, 0x96, 0xc4, 0x1a, 0xf8,
    ]);

    const frame = clientSock.encodePacket(writer, 0xe2);
    expect(Array.from(frame)).toEqual([
      0x00, 0xe2, 0xa5, 0x7b,
      0x11, 0x74, 0xa3, 0x99, 0x27, 0x8c, 0x8d, 0xdb,
      0x3e, 0x8c, 0x78, 0xbf, 0xdb, 0x58, 0xd5, 0x29,
      0x49, 0x6d, 0xc0,
    ]);
    expect(Array.from(frame.subarray(4, 20))).toEqual([
      0x11, 0x74, 0xa3, 0x99, 0x27, 0x8c, 0x8d, 0xdb,
      0x3e, 0x8c, 0x78, 0xbf, 0xdb, 0x58, 0xd5, 0x29,
    ]);

    const [received] = serverSock.feed(frame);
    expect(received?.opcode).toBe(ClientOpcode.PreLoginSsdCheck);
    expect(received?.readU32()).toBe(0);
    expect(received?.readU32()).toBe(0xe734d04f);
    expect(received?.readU32()).toBe(0);
    expect(received?.readU32()).toBe(0x000e496d);
    expect(received?.remaining).toBe(0);
  });

  test("Connect Hello substitution table (byte_924D10) from CA.exe round-trips first byte", () => {
    const table = getConnectHelloTable();
    expect(table.length).toBe(16 * 256);

    for (let key = 0; key < 16; key++) {
      for (const b of [0x00, 0x01, 0x16, 0x5a, 0x7f, 0xa5, 0xff]) {
        const enc = encodeConnectHelloFirstByte(key, b);
        const dec = decodeConnectHelloFirstByte(key, enc);
        expect(dec).toBe(b);
      }
    }
  });

  test("Block scrambler (sub_6692F0 / sub_669490) and PacketWriter/PacketReader primitives round-trip", () => {
    const rawBlock = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const scrambled = scrambleBlock(rawBlock);
    expect(Array.from(unscrambleBlock(scrambled))).toEqual(Array.from(rawBlock));

    const writer = new PacketWriter(31, 2);
    writer
      .writeU8(0xab)
      .writeI8(-12)
      .writeU16(0x1234)
      .writeI16(-1234)
      .writeU32(0x89abcdef)
      .writeI32(-12345678)
      .writeU64(0x0102030405060708n)
      .writeString("泡泡堂TW")
      .writeCipherString("secretPwd", 0x44332211);

    const ss = new SmartStreamWriter();
    ss.writeU16(4).writeString("自由頻道 1").writeU32(400);
    writer.writeSmartStream(ss, true);

    const payload = writer.toPayload();
    const reader = new PacketReader(payload, 2);
    expect(reader.opcode).toBe(31);
    expect(reader.readU8()).toBe(0xab);
    expect(reader.readI8()).toBe(-12);
    expect(reader.readU16()).toBe(0x1234);
    expect(reader.readI16()).toBe(-1234);
    expect(reader.readU32()).toBe(0x89abcdef);
    expect(reader.readI32()).toBe(-12345678);
    expect(reader.readU64()).toBe(0x0102030405060708n);
    expect(reader.readString()).toBe("泡泡堂TW");
    expect(reader.readCipherString(0x44332211)).toBe("secretPwd");

    const ssReader = reader.readSmartStream();
    expect(ssReader.readU16()).toBe(4);
    expect(ssReader.readString()).toBe("自由頻道 1");
    expect(ssReader.readU32()).toBe(400);
    expect(reader.remaining).toBe(0);
  });

  test("IPv4 fields preserve distinct TCP-packet and SmartStream byte orders", () => {
    expect(ipv4ToUint32("127.0.0.1")).toBe(0x7f000001);
    expect(ipv4ToInAddrLittleEndian("127.0.0.1")).toBe(0x0100007f);
    expect(ipv4ToUint32("192.0.2.71")).toBe(0xc0000247);
    expect(ipv4ToInAddrLittleEndian("192.0.2.71")).toBe(0x470200c0);
    expect(() => ipv4ToUint32("192.0.2.999")).toThrow();
  });

  test("CChannelCache category ordinals normalize raw category 18 exactly like sub_5D4071", () => {
    const channels = DEFAULT_C_CHANNELS.map((channel, index) => ({
      ...channel,
      categoryCode: index % 2 === 0 ? 18 : 10,
    }));
    expect(normalizeCChannelCategory(18)).toBe(10);
    expect(getCChannelCategoryOrdinal(channels, 2)).toBe(2);
    expect(findCChannelByCategoryOrdinal(channels, 10, 2)?.channelIndex).toBe(2);
    expect(findCChannelByCategoryOrdinal(channels, 18, 0)?.channelIndex).toBe(0);
  });

  test("Taiwan client strings are encoded as byte-counted CP950, not UTF-8", () => {
    const text = "爆爆王測試";
    const encoded = encodeClientText(text);
    expect([...encoded]).toEqual([0xc3, 0x7a, 0xc3, 0x7a, 0xa4, 0xfd, 0xb4, 0xfa, 0xb8, 0xd5]);
    expect(decodeClientText(encoded)).toBe(text);

    const stream = new SmartStreamWriter().writeString(text);
    const raw = stream.toRawPayload();
    expect(new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true)).toBe(10);
    expect([...raw.subarray(4)]).toEqual([...encoded]);
  });

  test("COSmartStream / CISmartStream supports both mode 0 (raw) and mode 1 (zlib)", () => {
    const w = new SmartStreamWriter();
    w.writeU8(7).writeU16(1024).writeU32(999999).writeString("Hello SmartStream");

    const rawBuf = w.toSmartStreamBuffer(false);
    expect(rawBuf[0]).toBe(0x18);
    expect(rawBuf[5]).toBe(0);
    const r0 = SmartStreamReader.fromSmartStreamBuffer(rawBuf);
    expect(r0.readU8()).toBe(7);
    expect(r0.readU16()).toBe(1024);
    expect(r0.readU32()).toBe(999999);
    expect(r0.readString()).toBe("Hello SmartStream");

    const zlibBuf = w.toSmartStreamBuffer(true);
    expect(zlibBuf[0]).toBe(0x18);
    expect(zlibBuf[5]).toBe(1);
    const r1 = SmartStreamReader.fromSmartStreamBuffer(zlibBuf);
    expect(r1.readU8()).toBe(7);
    expect(r1.readU16()).toBe(1024);
    expect(r1.readU32()).toBe(999999);
    expect(r1.readString()).toBe("Hello SmartStream");
  });

  test("ssi1 validates the full-container checksum separately from SmartStream body checksums", () => {
    const writer = new SmartStreamWriter().writeU8(7).writeU32(0x12345678);
    const file = writer.toSsi1Buffer(true);
    const parsed = SmartStreamReader.fromSsi1Buffer(file);
    const container = file.subarray(8);

    const fileChecksum = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(4, true);
    expect(fileChecksum).toBe(computeAdler32Zero(container, 0));
    expect(parsed.checksum).toBe(computeSmartStreamBodyChecksum(container));
    expect(fileChecksum).not.toBe(parsed.checksum);
    expect(parsed.reader.readU8()).toBe(7);
    expect(parsed.reader.readU32()).toBe(0x12345678);
    expect(parsed.reader.remaining()).toBe(0);

    const badChecksum = file.slice();
    badChecksum[4] = badChecksum[4]! ^ 0x01;
    expect(() => SmartStreamReader.fromSsi1Buffer(badChecksum)).toThrow(/ssi1 checksum mismatch/);
    expect(() => new SmartStreamReader(Uint8Array.of(1, 2, 3)).readU32()).toThrow(
      /requested 4 byte\(s\), 3 remain/
    );
  });

  test("PacketSocketState Connect Hello + Degree 2 C->S and Degree 3 S->C framing with fragmentation", () => {
    const serverSock = new PacketSocketState("server");
    const clientSock = new PacketSocketState("client");

    // 1. Server sends Degree-0 Connect Hello
    const helloFrame = serverSock.encodeConnectHello({
      flag: 0,
      minVersion: 22,
      currentVersion: 22,
      sessionKey: 0x12340001,
      noticeUrl: "http://tw.beanfun.com/bnb/",
      extraFlag: 0,
    });
    expect(serverSock.degree).toBe(3);

    // Client decodes Connect Hello
    const helloInfo = clientSock.decodeConnectHello(helloFrame);
    expect(helloInfo.currentVersion).toBe(22);
    expect(helloInfo.sessionKey).toBe(0x12340001);
    expect(clientSock.degree).toBe(3);

    // 2. Client sends two C->S packets (Degree 2 framing on wire)
    const c1 = new PacketWriter(0).writeU32(111).writeU32(222);
    const c2 = new PacketWriter(31).writeU8(1).writeString("player1");
    const f1 = clientSock.encodePacket(c1);
    const f2 = clientSock.encodePacket(c2);

    // Coalesce and feed in 3-byte fragments to test stream reassembly
    const combined = new Uint8Array(f1.length + f2.length);
    combined.set(f1, 0);
    combined.set(f2, f1.length);

    const receivedByServer: PacketReader[] = [];
    for (let i = 0; i < combined.length; i += 3) {
      const slice = combined.subarray(i, Math.min(i + 3, combined.length));
      receivedByServer.push(...serverSock.feed(slice));
    }
    expect(receivedByServer.length).toBe(2);
    expect(receivedByServer[0]!.opcode).toBe(0);
    expect(receivedByServer[0]!.readU32()).toBe(111);
    expect(receivedByServer[0]!.readU32()).toBe(222);
    expect(receivedByServer[1]!.opcode).toBe(31);
    expect(receivedByServer[1]!.readU8()).toBe(1);
    expect(receivedByServer[1]!.readString()).toBe("player1");

    // 3. Server sends Degree-3 S->C packet
    const s1 = new PacketWriter(4).writeU8(0).writeU16(1);
    const sf1 = serverSock.encodePacket(s1);
    const receivedByClient = clientSock.feed(sf1);
    expect(receivedByClient.length).toBe(1);
    expect(receivedByClient[0]!.opcode).toBe(4);
    expect(receivedByClient[0]!.readU8()).toBe(0);
    expect(receivedByClient[0]!.readU16()).toBe(1);
  });

  test("TCP packet logs correlate sessions, omit S->C bodies, and redact credential-bearing C->S previews", () => {
    const previousLevel = getLogLevel();
    setLogLevel("silent");
    clearRecentLogs();
    try {
      const context = { sessionId: 77, connectionKind: "game", stageId: 11 };
      const helloInfo = {
        flag: 0,
        minVersion: 22,
        currentVersion: 22,
        sessionKey: 0x12340005,
        noticeUrl: "http://tw.beanfun.com/bnb/",
        extraFlag: 0,
      };

      const outbound = new PacketSocketState("server");
      outbound.encodeConnectHello(helloInfo, 1, undefined, context);
      outbound.encodePacket(
        new PacketWriter(ServerOpcode.QuestConfigSync).writeU32(0),
        0,
        context
      );

      const connectHelloLog = getRecentLogs().find(
        (entry) => entry.message.includes("Encoded ConnectHello")
      );
      expect(connectHelloLog?.data?.sessionId).toBe(77);
      expect(connectHelloLog?.data?.connectionKind).toBe("game");
      expect(connectHelloLog?.data?.noticeUrlPresent).toBe(true);
      expect(connectHelloLog?.data?.noticeUrl).toBeUndefined();

      const outboundPacketLog = getRecentLogs().find(
        (entry) => entry.data?.direction === "S->C" && entry.data?.opcode === ServerOpcode.QuestConfigSync
      );
      expect(outboundPacketLog?.data?.sessionId).toBe(77);
      expect(outboundPacketLog?.data?.connectionKind).toBe("game");
      expect(outboundPacketLog?.data?.stageId).toBe(11);
      expect(outboundPacketLog?.data?.payloadBytes).toBe(6);
      expect(outboundPacketLog?.data?.payloadContent).toBe("<omitted>");
      expect(outboundPacketLog?.data?.plainHex).toBeUndefined();

      const inboundServer = new PacketSocketState("server");
      const inboundClient = new PacketSocketState("client");
      const hello = inboundServer.encodeConnectHello(helloInfo);
      inboundClient.decodeConnectHello(hello);
      const enterLobbyFrame = inboundClient.encodePacket(
        new PacketWriter(ClientOpcode.EnterLobby, 2)
      );
      inboundServer.feed(enterLobbyFrame, context);

      const inboundPacketLog = getRecentLogs().find(
        (entry) => entry.data?.direction === "C->S" && entry.data?.opcode === ClientOpcode.EnterLobby
      );
      expect(inboundPacketLog?.data?.sessionId).toBe(77);
      expect(inboundPacketLog?.data?.connectionKind).toBe("game");
      expect(inboundPacketLog?.data?.stageId).toBe(11);

      const sensitiveClientPackets = [
        {
          writer: new PacketWriter(ClientOpcode.ShopBuyItemPass, 2)
            .writeString("private-nexon-pass")
            .writeU32(1001)
            .writeU32(7),
          secret: "private-nexon-pass",
        },
        {
          writer: new PacketWriter(ClientOpcode.ShopBuy280, 2)
            .writeString("private-coupon-code")
            .writeString("private-recipient"),
          secret: "private-coupon-code",
        },
        {
          writer: new PacketWriter(ClientOpcode.NexonClubAuth, 2)
            .writeU8(0)
            .writeString("club-id")
            .writeString("private-club-pass"),
          secret: "private-club-pass",
        },
      ];
      for (const { writer, secret } of sensitiveClientPackets) {
        inboundServer.feed(inboundClient.encodePacket(writer), context);
        const sensitivePacketLog = getRecentLogs().findLast(
          (entry) => entry.data?.direction === "C->S" && entry.data?.opcode === writer.opcode
        );
        expect(sensitivePacketLog?.data?.plainHex).toBe("<redacted>");
        expect(JSON.stringify(sensitivePacketLog)).not.toContain(secret);
      }
    } finally {
      setLogLevel(previousLevel);
    }
  });

  test("C->S 6 parser keeps the three client handoff layouts and numeric namespaces distinct", () => {
    const selectServerHandoff = new PacketWriter(ClientOpcode.SessionHandoff)
      .writeU8(2)
      .writeString("player_one")
      .writeU32(0x11111111) // field95 / LoginResult session token
      .writeU32(0xa1a1a1a1) // field97; meaning unknown
      .writeString("player_two")
      .writeU32(0x22222222)
      .writeU32(0xb2b2b2b2)
      .writeU8(14) // opaque CNetworkFacade+8 byte, not a StageId
      .writeU32(0x01020304) // dword_92AAEC + 888
      .writeU32(0x05060708); // dword_92AAEC + 892
    const parsedSelectServer = parseSessionHandoffPayload(
      new PacketReader(selectServerHandoff.toPayload(), 3)
    );
    expect(parsedSelectServer).toEqual({
      declaredPlayerCount: 2,
      players: [
        { username: "player_one", sessionToken: 0x11111111, field97U32: 0xa1a1a1a1 },
        { username: "player_two", sessionToken: 0x22222222, field97U32: 0xb2b2b2b2 },
      ],
      wireLayout: "sub_5D893D",
      networkObjectByte: 14,
      trailingHandoffFieldsU32: [0x01020304, 0x05060708],
      unreadTrailingBytes: 0,
    });

    const reconnect = new PacketWriter(ClientOpcode.SessionHandoff)
      .writeU8(1)
      .writeString("player_one")
      .writeU32(0x11111111)
      .writeU8(StageId.Shop);
    const parsedReconnect = parseSessionHandoffPayload(new PacketReader(reconnect.toPayload(), 3));
    expect(parsedReconnect.wireLayout).toBe("sub_5D8A3F");
    expect(parsedReconnect.reconnectContextByte).toBe(StageId.Shop);
    expect(parsedReconnect.networkObjectByte).toBeUndefined();
    expect(parsedReconnect.unreadTrailingBytes).toBe(0);

    const minimal = new PacketWriter(ClientOpcode.SessionHandoff)
      .writeU8(1)
      .writeString("player_one")
      .writeU32(0x11111111);
    expect(parseSessionHandoffPayload(new PacketReader(minimal.toPayload(), 3)).wireLayout)
      .toBe("sub_5D8879");
  });

  test("Structured logs keep client opcodes, server opcodes, and StageIds in separate namespaces", () => {
    expect(formatClientOpcode(5)).toBe("5 (SelectChannel)");
    expect(formatServerOpcode(7)).toBe("7 (ChannelSelectResult)");
    expect(formatClientOpcode(13)).toBe("13 (ReturnToChannelSelect)");
    expect(formatServerOpcode(13)).toBe("13 (LobbyStageTransition)");
    expect(formatServerOpcode(33)).toBe("33 (SelectServerDynamicI16Data)");
    expect(formatStageId(10)).toBe("10 (SelectServer)");
    expect(formatStageId(11)).toBe("11 (Lobby)");
    expect(formatStageId(13)).toBe("13 (Game)");
  });

  test("TCP close trace summarizes direction, opcode, stage, sizes, and quiet time without bodies", () => {
    const session = new ClientSession(
      77,
      () => {},
      "127.0.0.1",
      61964,
      "127.0.0.1",
      9339,
      "game"
    );
    const startedAt = session.connectedAtMs;

    session.recordPacketTrace("S->C", null, 48, StageId.Login, "ConnectHello", startedAt + 4);
    session.recordPacketTrace(
      "C->S",
      ClientOpcode.SessionHandoff,
      29,
      StageId.SelectServer,
      undefined,
      startedAt + 101
    );
    session.recordPacketTrace(
      "S->C",
      ServerOpcode.LobbyStageTransition,
      3,
      StageId.SelectServer,
      undefined,
      startedAt + 102
    );

    const summary = session.getPacketTraceSummary(startedAt + 103);
    expect(summary.clientToServerDecodedPackets).toBe(1);
    expect(summary.serverToClientWriteCalls).toBe(2);
    expect(summary.lastClientPacketAgoMs).toBe(2);
    expect(summary.lastServerWriteAgoMs).toBe(1);
    expect(summary.pendingReceiveBytes).toBe(0);
    expect(summary.packetFlow).toBe(
      "#01 +4ms S->C [write-call] ConnectHello 48B @1 (Login)\n" +
        "#02 +101ms C->S [decoded] 6 (SessionHandoff) 29B @10 (SelectServer)\n" +
        "#03 +102ms S->C [write-call] 13 (LobbyStageTransition) 3B @10 (SelectServer)"
    );
    expect(summary.packetFlow).not.toContain("sessionKey");
  });

  test("TCP close trace retains only the newest 48 events and counts omissions", () => {
    const session = new ClientSession(
      78,
      () => {},
      "127.0.0.1",
      61965,
      "127.0.0.1",
      9339,
      "login"
    );
    const startedAt = session.connectedAtMs;

    for (let index = 0; index < 50; index++) {
      session.recordPacketTrace(
        "C->S",
        ClientOpcode.RequestChannelList,
        6,
        StageId.SelectServer,
        undefined,
        startedAt + index
      );
    }

    const summary = session.getPacketTraceSummary(startedAt + 51);
    expect(summary.clientToServerDecodedPackets).toBe(50);
    expect(summary.omittedTraceEvents).toBe(2);
    expect(summary.packetFlow.split("\n")).toHaveLength(48);
    expect(summary.packetFlow).not.toContain("#01 +0ms");
    expect(summary.packetFlow).toContain("#03 +2ms C->S [decoded] 9 (RequestChannelList)");
  });

  test("ConnectHello advances the S->C counter exactly once and logs the 40 -> 43 handshake", () => {
    const previousLevel = getLogLevel();
    setLogLevel("silent");
    clearRecentLogs();
    try {
      const server = new PacketSocketState("server");
      const client = new PacketSocketState("client");
      const frame = server.encodeConnectHello({
        flag: 0,
        minVersion: 22,
        currentVersion: 22,
        sessionKey: 0x12340005,
        noticeUrl: "http://tw.beanfun.com/bnb/",
        extraFlag: 0,
      });
      expect(server.serverToClientCounter).toBe(43);
      client.decodeConnectHello(frame);
      expect(client.serverToClientCounter).toBe(43);

      const handshakeLog = getRecentLogs().find(
        (entry) => entry.category === "Framing" && entry.message.includes("ConnectHello")
      );
      expect(handshakeLog?.data?.direction).toBe("S->C");
      expect(handshakeLog?.data?.counterBefore).toBe(40);
      expect(handshakeLog?.data?.counterAfter).toBe(43);
      expect(handshakeLog?.data?.clientToServerCounterUnchanged).toBe(40);
    } finally {
      setLogLevel(previousLevel);
    }
  });

  test("C->S CRC diagnostics flag a nearby counter candidate without accepting the frame", () => {
    const previousLevel = getLogLevel();
    setLogLevel("silent");
    clearRecentLogs();
    try {
      const server = new PacketSocketState("server");
      const client = new PacketSocketState("client");
      const hello = server.encodeConnectHello({
        flag: 0,
        minVersion: 22,
        currentVersion: 22,
        sessionKey: 0x12340001,
        noticeUrl: "http://tw.beanfun.com/bnb/",
        extraFlag: 0,
      });
      client.decodeConnectHello(hello);

      // Simulate one successful client frame that the server missed. Force the
      // sequence byte to the server's expected value so this test reaches CRC diagnosis.
      client.clientToServerCounter = 43;
      const frame = client.encodePacket(
        new PacketWriter(ClientOpcode.PreLoginSsdCheck, 2)
          .writeU32(0x12345678)
          .writeU32(0xabcdef01)
      );
      frame[0] = 0;

      expect(() => server.feed(frame, {
        sessionId: 77,
        connectionKind: "login",
        stageId: 1,
      })).toThrow("C->S CRC8 mismatch");
      const mismatch = getRecentLogs().find((entry) =>
        entry.message.includes("C->S CRC8 mismatch")
      );
      expect(mismatch?.data?.sessionId).toBe(77);
      expect(mismatch?.data?.connectionKind).toBe("login");
      expect(mismatch?.data?.stageId).toBe(1);
      expect(mismatch?.data?.incomingChunkBytes).toBe(frame.length);
      expect(mismatch?.data?.bufferedBytesBeforeChunk).toBe(0);
      expect(mismatch?.data?.sequenceValidated).toBe(true);
      expect(mismatch?.data?.expectedSequenceByte).toBe("0x00");
      expect(mismatch?.data?.payloadOffset).toBe(4);
      expect(mismatch?.data?.counter).toBe(40);
      expect(mismatch?.data?.counterCrcMatches).toContain(3);
      expect(mismatch?.data?.diagnosticOnly).toBe(true);
      expect(JSON.stringify(mismatch)).not.toContain("plaintextPreview");
      expect(JSON.stringify(mismatch)).not.toContain("12345678");
    } finally {
      setLogLevel(previousLevel);
    }
  });

  test("C->S CRC diagnostics also probe the sequence-byte cycle at 256 packets", () => {
    const previousLevel = getLogLevel();
    setLogLevel("silent");
    clearRecentLogs();
    try {
      const server = new PacketSocketState("server");
      const client = new PacketSocketState("client");
      const hello = server.encodeConnectHello({
        flag: 0,
        minVersion: 22,
        currentVersion: 22,
        sessionKey: 0x12340001,
        noticeUrl: "http://tw.beanfun.com/bnb/",
        extraFlag: 0,
      });
      client.decodeConnectHello(hello);

      // After 256 sends, the +3 counter wraps back to the same sequence byte:
      // 40 + (256 * 3) = 808, which is indistinguishable by the 8-bit sequence alone.
      client.clientToServerCounter = 808;
      const frame = client.encodePacket(
        new PacketWriter(ClientOpcode.PreLoginSsdCheck, 2).writeU32(0x10203040)
      );
      expect(frame[0]).toBe(0);

      expect(() => server.feed(frame)).toThrow("C->S CRC8 mismatch");
      const mismatch = getRecentLogs().find((entry) =>
        entry.message.includes("C->S CRC8 mismatch")
      );
      expect(mismatch?.data?.sequenceValidated).toBe(true);
      expect(mismatch?.data?.sequenceCyclePacketPeriod).toBe(256);
      expect(mismatch?.data?.counterCrcMatches).toContain(768);
      expect(mismatch?.data?.sequenceCycleProbeDeltas).toContain(768);
      expect(mismatch?.data?.diagnosticOnly).toBe(true);
      expect(JSON.stringify(mismatch)).not.toContain("10203040");
    } finally {
      setLogLevel(previousLevel);
    }
  });

  test("CRC-failed pre-login packets compare cache values without logging their values", () => {
    const previousLevel = getLogLevel();
    setLogLevel("silent");
    clearRecentLogs();
    try {
      const server = new PacketSocketState("server");
      const client = new PacketSocketState("client");
      const hello = server.encodeConnectHello({
        flag: 0,
        minVersion: 22,
        currentVersion: 22,
        sessionKey: 0x12340001,
        noticeUrl: "http://tw.beanfun.com/bnb/",
        extraFlag: 0,
      });
      client.decodeConnectHello(hello);

      const checksums = {
        // Fresh ConnectHello uses extraFlag=0; the client's dynamic-image context field is 0,
        // not the checked-in file's Adler-32 checksum.
        fxdynimginfo: 0,
        csysstr: 0xe734d04f,
        multisvr: 0,
        filterstr: 0x000e496d,
      };
      const frame = client.encodePacket(
        new PacketWriter(ClientOpcode.PreLoginSsdCheck, 2)
          .writeU32(checksums.fxdynimginfo)
          .writeU32(checksums.csysstr)
          .writeU32(checksums.multisvr)
          .writeU32(0x22222222)
      );
      frame[frame.length - 1] ^= 0x01;

      expect(() => server.feed(frame, {
        preLoginSsdChecksumExpectations: {
          fieldVariants: {
            fxdynimginfo: [checksums.fxdynimginfo],
            csysstr: [checksums.csysstr],
            multisvr: [checksums.multisvr],
            filterstr: [checksums.filterstr],
          },
          knownResourceVariants: Object.values(checksums),
        },
      })).toThrow("C->S CRC8 mismatch");
      const mismatch = getRecentLogs().find((entry) =>
        entry.message.includes("C->S CRC8 mismatch")
      );
      const analysis = mismatch?.data?.preLoginSsdChecksumFields as
        | {
            comparedFieldCount: number;
            zeroSentinelCount: number;
            trailingBytes: number;
            fields: Array<{
              name: string;
              present: boolean;
              zeroSentinel: boolean | null;
              matchesFieldResource: boolean | null;
              matchesAnyKnownResource: boolean | null;
            }>;
          }
        | undefined;
      expect(analysis?.comparedFieldCount).toBe(2);
      expect(analysis?.zeroSentinelCount).toBe(2);
      expect(analysis?.trailingBytes).toBe(0);
      expect(
        analysis?.fields.map(({
          name,
          present,
          zeroSentinel,
          matchesFieldResource,
          matchesAnyKnownResource,
        }) => [name, present, zeroSentinel, matchesFieldResource, matchesAnyKnownResource])
      ).toEqual([
        ["fxdynimginfo", true, true, null, null],
        ["csysstr", true, false, true, true],
        ["multisvr", true, true, null, null],
        ["filterstr", true, false, false, false],
        ["multisvrn", false, null, null, null],
      ]);
      const serializedLog = JSON.stringify(mismatch);
      expect(serializedLog).not.toContain("084341A5");
      expect(serializedLog).not.toContain("E734D04F");
      expect(serializedLog).not.toContain("22222222");
      expect(serializedLog).not.toContain("000E496D");
    } finally {
      setLogLevel(previousLevel);
    }
  });

  test("CRC-failed trace vector diagnostics distinguish zero sentinels from local cache hashes", () => {
    const previousLevel = getLogLevel();
    setLogLevel("silent");
    clearRecentLogs();
    try {
      const server = new PacketSocketState("server");
      const client = new PacketSocketState("client");
      const hello = server.encodeConnectHello({
        flag: 0,
        minVersion: 22,
        currentVersion: 22,
        sessionKey: 0x12340001,
        noticeUrl: "http://tw.beanfun.com/bnb/",
        extraFlag: 0,
      });
      client.decodeConnectHello(hello);

      const frame = client.encodePacket(
        new PacketWriter(ClientOpcode.PreLoginSsdCheck, 2)
          .writeU32(0)
          .writeU32(0xe734d04f)
          .writeU32(0)
          .writeU32(0x000e496d),
        0xe2
      );
      frame[frame.length - 1] ^= 0x01;

      expect(() => server.feed(frame, {
        preLoginSsdChecksumExpectations: {
          fieldVariants: {
            fxdynimginfo: [0x084341a5],
            csysstr: [0xe734d04f],
            multisvr: [0xfc711697],
            filterstr: [0x000e496d],
          },
          knownResourceVariants: [0, 0x084341a5, 0xe734d04f, 0xfc711697, 0x000e496d],
        },
      })).toThrow("C->S CRC8 mismatch");

      const mismatch = getRecentLogs().find((entry) =>
        entry.message.includes("C->S CRC8 mismatch")
      );
      const analysis = mismatch?.data?.preLoginSsdChecksumFields as
        | {
            comparedFieldCount: number;
            zeroSentinelCount: number;
            fields: Array<{
              name: string;
              zeroSentinel: boolean | null;
              matchesFieldResource: boolean | null;
              matchesAnyKnownResource: boolean | null;
            }>;
          }
        | undefined;
      expect(analysis?.comparedFieldCount).toBe(2);
      expect(analysis?.zeroSentinelCount).toBe(2);
      expect(
        analysis?.fields.map(({
          name,
          zeroSentinel,
          matchesFieldResource,
          matchesAnyKnownResource,
        }) => [name, zeroSentinel, matchesFieldResource, matchesAnyKnownResource])
      ).toEqual([
        ["fxdynimginfo", true, null, null],
        ["csysstr", false, true, true],
        ["multisvr", true, null, null],
        ["filterstr", false, true, true],
        ["multisvrn", null, null, null],
      ]);

      const serializedLog = JSON.stringify(mismatch);
      for (const rawValue of ["084341A5", "E734D04F", "FC711697", "000E496D"]) {
        expect(serializedLog).not.toContain(rawValue);
      }
    } finally {
      setLogLevel(previousLevel);
    }
  });

  test("C->S CRC failure logs redact credential opcodes and never log plaintext payloads", () => {
    const previousLevel = getLogLevel();
    setLogLevel("silent");
    clearRecentLogs();
    try {
      const server = new PacketSocketState("server");
      const client = new PacketSocketState("client");
      const hello = server.encodeConnectHello({
        flag: 0,
        minVersion: 22,
        currentVersion: 22,
        sessionKey: 0x12340001,
        noticeUrl: "http://tw.beanfun.com/bnb/",
        extraFlag: 0,
      });
      client.decodeConnectHello(hello);
      const frame = client.encodePacket(
        new PacketWriter(ClientOpcode.LoginCredentials, 2).writeString("private-login-payload")
      );
      frame[frame.length - 1] ^= 0x01;

      expect(() => server.feed(frame)).toThrow("C->S CRC8 mismatch");
      const mismatch = getRecentLogs().find((entry) =>
        entry.message.includes("C->S CRC8 mismatch")
      );
      expect(mismatch?.data?.untrustedOpcode).toBe("<redacted sensitive client opcode>");
      expect(mismatch?.data?.crcAlgorithm).toContain("poly 0x07");
      expect(mismatch?.data?.crcSeedScanCompleted).toBe(true);
      expect(mismatch?.data?.matchingCrcSeedsForCurrentPlain).toHaveLength(1);
      expect(mismatch?.data?.matchingCrcSeedsForCurrentPlain).not.toContain("0x28");
      expect(mismatch?.data?.crcXorDelta).toBe("0x01");
      expect(JSON.stringify(mismatch)).toContain("decryptedPayloadWithoutOpcode");
      expect(JSON.stringify(mismatch)).not.toContain("private-login-payload");
    } finally {
      setLogLevel(previousLevel);
    }
  });

  test("MTUDPPeer outer UDP datagram framing (0x00693100) encodes and validates CRC8", () => {
    const inner1 = new Uint8Array([0, 0, 2]);
    const inner2 = new Uint8Array([1, 2, 0x00, 0x00, 10, 20]);
    const datagram = encodeUdpDatagram([inner1, inner2]);
    const decoded = decodeUdpDatagram(datagram);
    expect(decoded.length).toBe(2);
    expect(Array.from(decoded[0]!)).toEqual(Array.from(inner1));
    expect(Array.from(decoded[1]!)).toEqual(Array.from(inner2));

    const single = MTUDPPeer.encodeFrame(inner1);
    const singleDec = MTUDPPeer.decodeFrame(single);
    expect(singleDec).not.toBeNull();
    expect(Array.from(singleDec!)).toEqual(Array.from(inner1));
  });

  test("OLE DATE VariantTime (sub_697640) and Win32 SYSTEMTIME (sub_5C7EAE) round-trip via block scrambler", () => {
    const nowMs = Date.UTC(2026, 9, 4, 12, 30, 0);
    const vt = unixMsToVariantTime(nowMs);
    expect(vt).toBeGreaterThan(45000);
    expect(Math.abs(variantTimeToUnixMs(vt) - nowMs)).toBeLessThan(5);

    const w = new PacketWriter(194, 3).writeVariantTime(vt).writeSystemTime(new Date(nowMs));
    const r = new PacketReader(w.toPayload(), 3);
    expect(r.opcode).toBe(194);
    expect(r.readVariantTime()).toBeCloseTo(vt, 8);
    const st = r.readSystemTime();
    expect(st.getUTCFullYear()).toBe(2026);
    expect(st.getUTCMonth() + 1).toBe(10);
    expect(st.getUTCDate()).toBe(4);
    expect(st.getUTCHours()).toBe(12);
    expect(st.getUTCMinutes()).toBe(30);
    expect(r.remaining).toBe(0);
  });
});
