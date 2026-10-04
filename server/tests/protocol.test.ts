import { describe, expect, test } from "bun:test";
import {
  decodeConnectHelloFirstByte,
  encodeConnectHelloFirstByte,
  encryptPayload,
  decryptPayload,
  getConnectHelloTable,
} from "../src/protocol/cipher.ts";
import { computeCRC8, computeCRC32 } from "../src/protocol/crc.ts";
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
import { SmartStreamReader, SmartStreamWriter } from "../src/protocol/stream.ts";
import {
  DEFAULT_C_CHANNELS,
  findCChannelByCategoryOrdinal,
  getCChannelCategoryOrdinal,
  normalizeCChannelCategory,
} from "../src/protocol/channelCache.ts";
import { decodeClientText, encodeClientText } from "../src/protocol/textEncoding.ts";
import { ClientOpcode } from "../src/protocol/opcodes.ts";
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

  test("Structured logs use reverse symbolic names for client/server opcodes and stages", () => {
    expect(formatClientOpcode(5)).toBe("5 (SelectChannel)");
    expect(formatServerOpcode(7)).toBe("7 (ChannelSelectResult)");
    expect(formatStageId(10)).toBe("10 (SelectServer)");
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

  test("CRC-failed pre-login packets compare resource hashes without logging their values", () => {
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
        fxdynimginfo: 0x084341a5,
        csysstr: 0xe734d04f,
        multisvr: 0x11111111,
        filterstr: 0x000e496d,
      };
      const frame = client.encodePacket(
        new PacketWriter(ClientOpcode.PreLoginSsdCheck, 2)
          .writeU32(checksums.fxdynimginfo)
          .writeU32(checksums.csysstr)
          .writeU32(0x22222222)
          .writeU32(checksums.filterstr)
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
            trailingBytes: number;
            fields: Array<{
              name: string;
              present: boolean;
              matchesFieldResource: boolean | null;
              matchesAnyKnownResource: boolean | null;
            }>;
          }
        | undefined;
      expect(analysis?.comparedFieldCount).toBe(4);
      expect(analysis?.trailingBytes).toBe(0);
      expect(
        analysis?.fields.map(({ name, present, matchesFieldResource, matchesAnyKnownResource }) => [
          name,
          present,
          matchesFieldResource,
          matchesAnyKnownResource,
        ])
      ).toEqual([
        ["fxdynimginfo", true, true, true],
        ["csysstr", true, true, true],
        ["multisvr", true, false, false],
        ["filterstr", true, true, true],
        ["multisvrn", false, null, null],
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
