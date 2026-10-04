import {
  decodeConnectHelloFirstByte,
  decryptPayload,
  encodeConnectHelloFirstByte,
  encryptPayload,
} from "./cipher.ts";
import { computeCRC8 } from "./crc.ts";
import { PacketReader, PacketWriter } from "./primitives.ts";
import { ClientOpcode, ServerOpcode } from "./opcodes.ts";
import {
  formatClientOpcode,
  formatHexPreview,
  formatServerOpcode,
  formatU8Hex,
  logger,
} from "../utils/logger.ts";

/**
 * Exact reconstruction of CPacketSocket (0x005D82E1, 0x00699B10 - 0x0069A120),
 * MTUDPPeer (0x005EBFA0, 0x00693100), CUDPPeerManBase (0x005EC7F5 - 0x005ECE3C),
 * CUDPPeerMan (0x0057BEAE), sub_4ED400 (0x004ED400), and CGameStage::sub_4ECF93 (0x004ECF93).
 */

// Never write plaintext passwords or session tokens to the diagnostic log ring/console.
const REDACTED_CLIENT_PAYLOAD_OPCODES = new Set<number>([
  ClientOpcode.LoginCredentials,
  ClientOpcode.SessionHandoff,
  ClientOpcode.LoginPassport,
  ClientOpcode.CreateOrUpdateAccount,
  ClientOpcode.RegisterAccount,
  ClientOpcode.LoginBeanfunToken,
  ClientOpcode.LoginVariant29,
  ClientOpcode.LoginVariant30,
  ClientOpcode.EKeyVerify,
  ClientOpcode.EKeyChallengeResponse,
  ClientOpcode.SubmitRegistrationForm,
  ClientOpcode.ChangeAccountPassword,
  ClientOpcode.RequestShopConnection,
  ClientOpcode.AuthenticateShopConnection,
  ClientOpcode.RequestShopConnectionAlt,
]);
const REDACTED_SERVER_PAYLOAD_OPCODES = new Set<number>([
  ServerOpcode.LoginResult,
  ServerOpcode.ShopReturnHandoff,
  ServerOpcode.ShopServerEndpoint,
]);
const MAX_TCP_PAYLOAD_BYTES = 16 * 1024 * 1024;
// CPacketSocket advances packet counters by three only after successful frames. Probe
// nearby values and two sequence-byte cycle values on CRC failure; candidates never make
// a failed frame acceptable. With a counter step of 3, the sequence repeats after 256 packets
// (768 counter units), since lcm(256, 3) = 768.
const CRC_COUNTER_PROBE_DELTAS = [-6, -3, 3, 6, 768, 1536] as const;
const MAX_CRC_SEED_SCAN_PAYLOAD_BYTES = 4096;

function readUntrustedClientOpcode(plain: Uint8Array): number | undefined {
  if (plain.length < 2) return undefined;
  const encodedOpcode = ((plain[0]! << 8) | plain[1]!) & 0xffff;
  return (encodedOpcode ^ 0xa569) & 0xffff;
}

function findClientOpcodeDiagnostic(plain: Uint8Array): string {
  const opcode = readUntrustedClientOpcode(plain);
  if (opcode === undefined) return "<unavailable: payload shorter than opcode>";
  return REDACTED_CLIENT_PAYLOAD_OPCODES.has(opcode)
    ? "<redacted sensitive client opcode>"
    : formatClientOpcode(opcode);
}

function findCounterCrcMatches(
  counter: number,
  cipher: Uint8Array,
  actualCrc: number,
  payloadBytes: number
): number[] {
  const matches: number[] = [];
  for (const delta of CRC_COUNTER_PROBE_DELTAS) {
    const candidateCounter = (counter + delta) >>> 0;
    const candidatePlain = decryptPayload(candidateCounter, cipher);
    if (computeCRC8(candidateCounter & 0xff, candidatePlain, payloadBytes) === actualCrc) {
      matches.push(delta);
    }
  }
  return matches;
}

function findCrcSeedMatches(counter: number, plain: Uint8Array, actualCrc: number): number[] {
  return [-6, -3, 3, 6].filter(
    (delta) => computeCRC8((counter + delta) & 0xff, plain) === actualCrc
  );
}

function findCrcSeedsForTrailer(
  plain: Uint8Array,
  actualCrc: number
): { scanned: boolean; seeds: string[] } {
  if (plain.length > MAX_CRC_SEED_SCAN_PAYLOAD_BYTES) {
    return { scanned: false, seeds: [] };
  }

  const seeds: string[] = [];
  for (let seed = 0; seed <= 0xff; seed++) {
    if (computeCRC8(seed, plain) === actualCrc) seeds.push(formatU8Hex(seed));
  }
  return { scanned: true, seeds };
}

export type PreLoginSsdChecksumFieldName =
  | "fxdynimginfo"
  | "csysstr"
  | "multisvr"
  | "filterstr"
  | "multisvrn";

export interface PreLoginSsdChecksumExpectations {
  fieldVariants: Partial<Record<PreLoginSsdChecksumFieldName, readonly number[]>>;
  knownResourceVariants: readonly number[];
}

export interface PacketLogContext {
  sessionId?: number;
  connectionKind?: string;
  stageId?: number;
  /**
   * Server-known checksum candidates used only for boolean diagnostics.
   * Synthesized entries do not prove the client's local files; zero is a valid sentinel.
   */
  preLoginSsdChecksumExpectations?: PreLoginSsdChecksumExpectations;
}

function packetLogContextFields(context: PacketLogContext): Record<string, unknown> {
  return {
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.connectionKind !== undefined ? { connectionKind: context.connectionKind } : {}),
    ...(context.stageId !== undefined ? { stageId: context.stageId } : {}),
  };
}

function diagnosePreLoginSsdChecksumFields(
  plain: Uint8Array,
  expectations?: PreLoginSsdChecksumExpectations
):
  | {
      comparedFieldCount: number;
      zeroSentinelCount: number;
      trailingBytes: number;
      fields: Array<{
        name: PreLoginSsdChecksumFieldName;
        present: boolean;
        fieldResourceAvailable: boolean;
        zeroSentinel: boolean | null;
        matchesFieldResource: boolean | null;
        matchesAnyKnownResource: boolean | null;
      }>;
    }
  | undefined {
  if (
    !expectations ||
    readUntrustedClientOpcode(plain) !== ClientOpcode.PreLoginSsdCheck ||
    plain.length < 2
  ) {
    return undefined;
  }

  const reader = new PacketReader(plain, 2);
  const fields: PreLoginSsdChecksumFieldName[] = [
    "fxdynimginfo",
    "csysstr",
    "multisvr",
    "filterstr",
    "multisvrn",
  ];
  const fieldResults: Array<{
    name: PreLoginSsdChecksumFieldName;
    present: boolean;
    fieldResourceAvailable: boolean;
    zeroSentinel: boolean | null;
    matchesFieldResource: boolean | null;
    matchesAnyKnownResource: boolean | null;
  }> = [];

  for (const name of fields) {
    const expectedVariants = expectations.fieldVariants[name];
    const fieldResourceAvailable = expectedVariants !== undefined && expectedVariants.length > 0;
    const present = reader.remaining >= 4;
    if (!present) {
      fieldResults.push({
        name,
        present: false,
        fieldResourceAvailable,
        zeroSentinel: null,
        matchesFieldResource: null,
        matchesAnyKnownResource: null,
      });
      continue;
    }

    const clientValue = reader.readU32();
    const zeroSentinel = clientValue === 0;
    fieldResults.push({
      name,
      present: true,
      fieldResourceAvailable,
      zeroSentinel,
      // Zero is an accepted sentinel, not evidence that a client-side file hash matched.
      matchesFieldResource:
        fieldResourceAvailable && !zeroSentinel ? expectedVariants!.includes(clientValue) : null,
      matchesAnyKnownResource: zeroSentinel
        ? null
        : expectations.knownResourceVariants.includes(clientValue),
    });
  }

  return {
    comparedFieldCount: fieldResults.filter(
      (field) => field.present && !field.zeroSentinel && field.fieldResourceAvailable
    ).length,
    zeroSentinelCount: fieldResults.filter((field) => field.zeroSentinel).length,
    trailingBytes: reader.remaining,
    fields: fieldResults,
  };
}

export interface ConnectHelloInfo {
  flag: number;
  minVersion: number;
  currentVersion: number;
  sessionKey: number;
  noticeUrl: string;
  extraFlag: number;
}

export class PacketSocketState {
  public readonly role: "server" | "client";
  public degree = 0;
  public key = 0;
  public hasKey = 0;

  // CPacketSocket constants from sub_5D82E1: c1=0x66, c2=0xC0, c3=0xE7,
  // initial counters=40 and steps=3 (sub_699A50).
  public readonly c1 = 0x66;
  public readonly c2 = 0xc0;
  public readonly c3 = 0xe7;
  // Server-side mirror of the client's C->S TX field +14 in sub_699E70,
  // initialized to 40 by sub_699A50; the peer increments it after successful sends.
  public clientToServerCounter = 40;
  // Server-side TX counter / client RX field +13. The client's ConnectHello
  // parser (sub_699D60) advances its RX counter 40 -> 43 exactly once.
  public serverToClientCounter = 40;
  public readonly step = 3;

  private rxBuffer: Uint8Array = new Uint8Array(0);

  /** Bytes received but not yet enough to form a complete TCP frame. */
  public get pendingReceiveBytes(): number {
    return this.rxBuffer.length;
  }

  constructor(role: "server" | "client" = "server") {
    this.role = role;
  }

  /**
   * Build S->C Connect Hello frame (deg=0, CReceivedPacketConnect, N+3 bytes)
   * and upgrade the socket state to deg=3 (S->C) / deg=2 (C->S) with sessionKey!
   */
  public encodeConnectHello(
    info: ConnectHelloInfo,
    initialKey: number = 1,
    repoRoot?: string,
    logContext: PacketLogContext = {}
  ): Uint8Array {
    const initKey = initialKey & 0x0f;
    const writer = new PacketWriter(null, 0);
    writer.writeU8(info.flag & 0xff);
    writer.writeI16(info.minVersion);
    writer.writeI16(info.currentVersion);
    writer.writeU32(info.sessionKey >>> 0);
    writer.writeString(info.noticeUrl);
    writer.writeU8(info.extraFlag & 0xff);

    const plain = writer.toPayload();
    const N = plain.length;
    const frame = new Uint8Array(3 + N);
    const dv = new DataView(frame.buffer);

    // First S->C frame[0] encodes initialKey via sub_699AB0:
    // initialKey == (u8)((frame[0] ^ (c1 + (u8)serverToClientCounter)) - c3)
    const seqByte =
      (((initKey + this.c3) & 0xff) ^ ((this.c1 + (this.serverToClientCounter & 0xff)) & 0xff)) &
      0xff;
    frame[0] = seqByte;
    dv.setUint16(1, N, false);
    frame.set(plain, 3);

    // Encode payload[0] via inverse of byte_924D10[256 * initKey + cipherByte] (sub_696F60)
    frame[3] = encodeConnectHelloFirstByte(initKey, plain[0]!, repoRoot);

    const prevCounter = this.serverToClientCounter;
    // The peer's CPacketSocket::sub_699D60 (0x00699D60, via vtable +52 in
    // sub_5D80A7) accepts ConnectHello and advances its RX field +13 by step
    // +15 once (40 -> 43). Mirror that next S->C counter on this server state.
    this.serverToClientCounter += this.step;
    this.hasKey = 1;
    this.degree = 3;
    this.key = info.sessionKey >>> 0;

    logger.debug("Framing", "Encoded ConnectHello (S->C CReceivedPacketConnect)", {
      ...packetLogContextFields(logContext),
      direction: "S->C",
      counterDirection: "S->C",
      counterBefore: prevCounter,
      counterAfter: this.serverToClientCounter,
      clientToServerCounterUnchanged: this.clientToServerCounter,
      step: this.step,
      seqByte: formatU8Hex(seqByte),
      initKey,
      sessionKeyPresent: this.hasKey === 1,
      minVersion: info.minVersion,
      currentVersion: info.currentVersion,
      noticeUrlPresent: info.noticeUrl.length > 0,
      frameBytes: frame.length,
      framePreview: "<omitted; ConnectHello contains sessionKey>",
    });

    return frame;
  }

  /**
   * Client-side parser for S->C Connect Hello frame (deg=0, N+3 bytes, sub_5D86DD)
   */
  public decodeConnectHello(frame: Uint8Array, repoRoot?: string): ConnectHelloInfo {
    if (frame.length < 3) {
      logger.error("Framing", "Received truncated ConnectHello header", {
        frameBytes: frame.length,
        frameHex: formatHexPreview(frame, 24),
      });
      throw new Error("ConnectHello frame too short");
    }
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const N = dv.getUint16(1, false);
    if (frame.length < 3 + N) {
      logger.error("Framing", "Received truncated ConnectHello payload", {
        payloadBytes: N,
        expectedFrameBytes: 3 + N,
        actualFrameBytes: frame.length,
        frameHex: formatHexPreview(frame, 32),
      });
      throw new Error(`ConnectHello frame truncated: expected ${3 + N}, got ${frame.length}`);
    }

    // sub_699AB0: extract initialKey from frame[0]
    const counterBefore = this.serverToClientCounter;
    const initKey =
      (((frame[0]! ^ ((this.c1 + (counterBefore & 0xff)) & 0xff)) & 0xff) - this.c3) &
      0xff;
    this.hasKey = 1;
    // CPacketSocket::sub_699D60 increments rxCounter by +3 once (40 -> 43)
    this.serverToClientCounter += this.step;

    const plain = frame.subarray(3, 3 + N).slice();
    plain[0] = decodeConnectHelloFirstByte(initKey, plain[0]!, repoRoot);

    const reader = new PacketReader(plain, 0, false);
    const flag = reader.readU8();
    const minVersion = reader.readI16();
    const currentVersion = reader.readI16();
    const sessionKey = reader.readU32();
    const noticeUrl = reader.readString();
    const extraFlag = reader.readU8();

    // sub_5D86DD upgrades socket degree to 3 and key to sessionKey
    this.degree = 3;
    this.key = sessionKey >>> 0;

    const info = {
      flag,
      minVersion,
      currentVersion,
      sessionKey,
      noticeUrl,
      extraFlag,
    };
    logger.debug("Framing", "Decoded ConnectHello (client accepted S->C bootstrap)", {
      counterBefore,
      counterAfter: this.serverToClientCounter,
      step: this.step,
      initKey,
      sessionKeyPresent: this.hasKey === 1,
      minVersion,
      currentVersion,
      noticeUrl,
      frameBytes: frame.length,
    });
    return info;
  }

  /**
   * Encode an outbound packet frame:
   * - If role === "server": encodes S->C deg=3 frame (N + 7 bytes)
   * - If role === "client": encodes C->S deg=2 frame (N + 5 bytes)
   */
  public encodePacket(
    writer: PacketWriter,
    padByte: number = 0x00,
    logContext: PacketLogContext = {}
  ): Uint8Array {
    const plain = writer.toPayload();
    const N = plain.length;

    if (this.role === "server") {
      // S->C deg=3 frame: [seq][pad][(N^0x96CA5395) BE32][cipher][CRC8]
      const counter = this.serverToClientCounter;
      const seq =
        ((((this.key & 0xff) + this.c3) & 0xff) ^ ((this.c1 + (counter & 0xff)) & 0xff)) & 0xff;
      const cipher = encryptPayload(counter, plain);
      const crc = computeCRC8(counter & 0xff, plain, N);

      const frame = new Uint8Array(N + 7);
      const dv = new DataView(frame.buffer);
      frame[0] = seq;
      frame[1] = padByte & 0xff;
      dv.setUint32(2, (N ^ 0x96ca5395) >>> 0, false);
      frame.set(cipher, 6);
      frame[6 + N] = crc;

      this.serverToClientCounter += this.step;
      if (writer.opcode !== null) {
        logger.debug("Framing", `Encoded S->C packet ${formatServerOpcode(writer.opcode)}`, {
          ...packetLogContextFields(logContext),
          direction: "S->C",
          opcode: writer.opcode,
          counter,
          nextCounter: this.serverToClientCounter,
          seqByte: formatU8Hex(seq),
          payloadBytes: N,
          frameBytes: frame.length,
          crc8: formatU8Hex(crc),
          payloadContent: "<omitted>",
        });
      }
      return frame;
    } else {
      // C->S deg=2 frame: [seq][pad][(N^0xA569) BE16][cipher][CRC8]
      const counter = this.clientToServerCounter;
      const seq =
        ((((this.key & 0xff) + this.c3) & 0xff) ^ ((this.c2 + (counter & 0xff)) & 0xff)) & 0xff;
      const cipher = encryptPayload(counter, plain);
      const crc = computeCRC8(counter & 0xff, plain, N);

      const frame = new Uint8Array(N + 5);
      const dv = new DataView(frame.buffer);
      frame[0] = seq;
      frame[1] = padByte & 0xff;
      dv.setUint16(2, (N ^ 0xa569) & 0xffff, false);
      frame.set(cipher, 4);
      frame[4 + N] = crc;

      this.clientToServerCounter += this.step;
      return frame;
    }
  }

  /**
   * Append incoming TCP chunk and extract all complete, authenticated packets.
   * - If role === "server": decodes C->S deg=2 frames (N + 5 bytes)
   * - If role === "client": decodes S->C deg=3 frames (N + 7 bytes)
   */
  public feed(chunk: Uint8Array, logContext: PacketLogContext = {}): PacketReader[] {
    const bufferedBytesBeforeChunk = this.rxBuffer.length;
    if (this.rxBuffer.length + chunk.length > MAX_TCP_PAYLOAD_BYTES * 2) {
      logger.error("Framing", "TCP receive buffer exceeded the safety limit", {
        ...packetLogContextFields(logContext),
        direction: this.role === "server" ? "C->S" : "S->C",
        role: this.role,
        bufferedBytes: this.rxBuffer.length,
        incomingBytes: chunk.length,
        maxBufferedBytes: MAX_TCP_PAYLOAD_BYTES * 2,
      });
      throw new RangeError("TCP receive buffer exceeded the framing safety limit");
    }

    if (chunk.length > 0) {
      const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
      merged.set(this.rxBuffer, 0);
      merged.set(chunk, this.rxBuffer.length);
      this.rxBuffer = merged;
    }

    const packets: PacketReader[] = [];

    while (true) {
      if (this.role === "server") {
        // Expect C->S deg=2 frame (min 5 bytes)
        if (this.rxBuffer.length < 5) {
          break;
        }
        const dv = new DataView(
          this.rxBuffer.buffer,
          this.rxBuffer.byteOffset,
          this.rxBuffer.byteLength
        );
        const N = (dv.getUint16(2, false) ^ 0xa569) & 0xffff;
        const totalFrameLen = N + 5;
        if (this.rxBuffer.length < totalFrameLen) {
          logger.debug("Framing", "Waiting for more C->S TCP bytes", {
            ...packetLogContextFields(logContext),
            direction: "C->S",
            bufferedBytes: this.rxBuffer.length,
            neededBytes: totalFrameLen,
            payloadBytes: N,
          });
          break;
        }

        const frame = this.rxBuffer.subarray(0, totalFrameLen);
        this.rxBuffer = this.rxBuffer.subarray(totalFrameLen).slice();

        const counter = this.clientToServerCounter;
        const expectedSeq =
          ((((this.key & 0xff) + this.c3) & 0xff) ^ ((this.c2 + (counter & 0xff)) & 0xff)) & 0xff;
        if (frame[0] !== expectedSeq) {
          logger.error("Framing", "C->S sequence byte mismatch (CPacketSocket::sub_699AB0 error 6)", {
            ...packetLogContextFields(logContext),
            direction: "C->S",
            expectedSeq: formatU8Hex(expectedSeq),
            actualSeq: formatU8Hex(frame[0]!),
            counter,
            keyPresent: this.hasKey === 1,
            frameHex: formatHexPreview(frame, 32),
          });
          throw new Error(
            `C->S sequence byte mismatch: expected 0x${expectedSeq.toString(16)}, got 0x${frame[0]!.toString(16)}`
          );
        }

        const cipher = frame.subarray(4, 4 + N);
        const plain = decryptPayload(counter, cipher);
        const expectedCrc = computeCRC8(counter & 0xff, plain, N);
        const actualCrc = frame[4 + N]!;
        if (actualCrc !== expectedCrc) {
          // Never log the decrypted body here: the first C->S packet may contain
          // credentials or session tokens. Only inspect the scrambled opcode and
          // CRC outcomes under nearby counters, without accepting any candidate.
          const counterCrcMatches = findCounterCrcMatches(counter, cipher, actualCrc, N);
          const crcSeedMatches = findCrcSeedMatches(counter, plain, actualCrc);
          const crcSeedsForTrailer = findCrcSeedsForTrailer(plain, actualCrc);
          const preLoginSsdChecksumFields = diagnosePreLoginSsdChecksumFields(
            plain,
            logContext.preLoginSsdChecksumExpectations
          );
          const crcScopeProbes = [
            { scope: "decryptedPayloadFull", bytes: plain },
            { scope: "decryptedPayloadWithoutOpcode", bytes: plain.subarray(Math.min(2, N)) },
            { scope: "decryptedPayloadMinusLastByte", bytes: plain.subarray(0, Math.max(0, N - 1)) },
            { scope: "ciphertextPayload", bytes: cipher },
            { scope: "frameHeaderAndCiphertext", bytes: frame.subarray(0, 4 + N) },
          ].map(({ scope, bytes }) => {
            const crc = computeCRC8(counter & 0xff, bytes);
            return {
              scope,
              byteCount: bytes.length,
              crc8: formatU8Hex(crc),
              matchesTrailer: crc === actualCrc,
            };
          });
          logger.error("Framing", "C->S CRC8 mismatch (CReceivedPacketBase::sub_6963B0 error 7)", {
            sessionId: logContext.sessionId,
            connectionKind: logContext.connectionKind,
            stageId: logContext.stageId,
            incomingChunkBytes: chunk.length,
            bufferedBytesBeforeChunk,
            direction: "C->S",
            degree: 2,
            sequenceValidated: true,
            expectedSequenceByte: formatU8Hex(expectedSeq),
            actualSequenceByte: formatU8Hex(frame[0]!),
            padByte: formatU8Hex(frame[1]!),
            encodedPayloadLength: `0x${((frame[2]! << 8) | frame[3]!).toString(16).toUpperCase().padStart(4, "0")}`,
            frameBytes: frame.length,
            bufferedBytesAfterFrame: this.rxBuffer.length,
            payloadOffset: 4,
            payloadBytes: N,
            trailerOffset: 4 + N,
            untrustedOpcode: findClientOpcodeDiagnostic(plain),
            preLoginSsdChecksumFields,
            counter,
            cipherCounter: counter,
            crcSeedByte: formatU8Hex(counter),
            counterStep: this.step,
            counterAfterValidFrame: (counter + this.step) >>> 0,
            keyPresent: this.hasKey === 1,
            crcAlgorithm: "MSB-first CRC-8 poly 0x07 (CA.exe sub_668F90)",
            expectedCrc: formatU8Hex(expectedCrc),
            actualCrc: formatU8Hex(actualCrc),
            crcXorDelta: formatU8Hex(actualCrc ^ expectedCrc),
            crcScopeProbes,
            nearbyCounterProbeDeltas: [-6, -3, 3, 6],
            sequenceCyclePacketPeriod: 256,
            sequenceCycleProbeDeltas: [768, 1536],
            counterProbeDeltas: [...CRC_COUNTER_PROBE_DELTAS],
            counterCrcMatches,
            crcSeedMatches,
            crcSeedScanCompleted: crcSeedsForTrailer.scanned,
            crcSeedScanMaxPayloadBytes: MAX_CRC_SEED_SCAN_PAYLOAD_BYTES,
            matchingCrcSeedsForCurrentPlain: crcSeedsForTrailer.seeds,
            diagnosticOnly: true,
          });
          throw new Error(
            `C->S CRC8 mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`
          );
        }

        this.clientToServerCounter += this.step;
        const reader = new PacketReader(plain, 2);
        logger.debug("Framing", `Decoded C->S packet ${formatClientOpcode(reader.opcode)}`, {
          ...packetLogContextFields(logContext),
          direction: "C->S",
          opcode: reader.opcode,
          counter,
          nextCounter: this.clientToServerCounter,
          seqByte: formatU8Hex(frame[0]!),
          payloadBytes: N,
          frameBytes: frame.length,
          crc8: formatU8Hex(actualCrc),
          plainHex: REDACTED_CLIENT_PAYLOAD_OPCODES.has(reader.opcode)
            ? "<redacted>"
            : formatHexPreview(plain, 24),
        });
        packets.push(reader);
      } else {
        // Expect S->C deg=3 frame (min 7 bytes)
        if (this.rxBuffer.length < 7) {
          break;
        }
        const dv = new DataView(
          this.rxBuffer.buffer,
          this.rxBuffer.byteOffset,
          this.rxBuffer.byteLength
        );
        const N = (dv.getUint32(2, false) ^ 0x96ca5395) >>> 0;
        if (N > MAX_TCP_PAYLOAD_BYTES) {
          logger.error("Framing", "S->C frame declares an oversized payload", {
            payloadBytes: N,
            maxPayloadBytes: MAX_TCP_PAYLOAD_BYTES,
            headerHex: formatHexPreview(this.rxBuffer.subarray(0, 7), 7),
          });
          throw new RangeError(`S->C frame payload ${N} exceeds the safety limit`);
        }
        const totalFrameLen = N + 7;
        if (this.rxBuffer.length < totalFrameLen) {
          logger.debug("Framing", "Waiting for more S->C TCP bytes", {
            bufferedBytes: this.rxBuffer.length,
            neededBytes: totalFrameLen,
            payloadBytes: N,
          });
          break;
        }

        const frame = this.rxBuffer.subarray(0, totalFrameLen);
        this.rxBuffer = this.rxBuffer.subarray(totalFrameLen).slice();

        const counter = this.serverToClientCounter;
        const expectedSeq =
          ((((this.key & 0xff) + this.c3) & 0xff) ^ ((this.c1 + (counter & 0xff)) & 0xff)) & 0xff;
        if (frame[0] !== expectedSeq) {
          logger.error("Framing", "S->C sequence byte mismatch (CPacketSocket::sub_699AB0 error 6)", {
            expectedSeq: formatU8Hex(expectedSeq),
            actualSeq: formatU8Hex(frame[0]!),
            counter,
            keyPresent: this.hasKey === 1,
            frameHex: formatHexPreview(frame, 32),
          });
          throw new Error(
            `S->C sequence byte mismatch: expected 0x${expectedSeq.toString(16)}, got 0x${frame[0]!.toString(16)}`
          );
        }

        const cipher = frame.subarray(6, 6 + N);
        const plain = decryptPayload(counter, cipher);
        const expectedCrc = computeCRC8(counter & 0xff, plain, N);
        const actualCrc = frame[6 + N]!;
        if (actualCrc !== expectedCrc) {
          logger.error("Framing", "S->C CRC8 mismatch (CReceivedPacketBase::sub_6963B0 error 7)", {
            expectedCrc: formatU8Hex(expectedCrc),
            actualCrc: formatU8Hex(actualCrc),
            counter,
            payloadBytes: N,
            plaintextPreview: "<omitted; CRC failed>",
          });
          throw new Error(
            `S->C CRC8 mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`
          );
        }

        this.serverToClientCounter += this.step;
        const reader = new PacketReader(plain, 3);
        logger.debug("Framing", `Decoded S->C packet ${formatServerOpcode(reader.opcode)}`, {
          ...packetLogContextFields(logContext),
          direction: "S->C",
          opcode: reader.opcode,
          counter,
          nextCounter: this.serverToClientCounter,
          seqByte: formatU8Hex(frame[0]!),
          payloadBytes: N,
          frameBytes: frame.length,
          crc8: formatU8Hex(actualCrc),
          plainHex: REDACTED_SERVER_PAYLOAD_OPCODES.has(reader.opcode)
            ? "<redacted>"
            : formatHexPreview(plain, 24),
        });
        packets.push(reader);
      }
    }

    return packets;
  }
}

/**
 * MTUDPPeer outer framing (`0x005EBFA0` / `0x00693100`):
 * `[u8 L = 1 + innerPayload.length][innerPayload][u8 CRC8(0, chunk[0..L-1])]`
 * All UDP inner payloads use `CSendPacketUDP` (`0x0057B6FA`, `degree = 0` plain Big-Endian, NO XOR).
 */
export function encodeUdpDatagram(innerPayloads: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const inner of innerPayloads) {
    total += 2 + inner.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const inner of innerPayloads) {
    const L = (1 + inner.length) & 0xff;
    out[offset] = L;
    out.set(inner, offset + 1);
    const crc = computeCRC8(0, out.subarray(offset, offset + L), L);
    out[offset + L] = crc;
    offset += L + 1;
  }
  return out;
}

export function decodeUdpDatagram(datagram: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < datagram.length) {
    const L = datagram[offset]!;
    if (L < 1 || offset + L >= datagram.length) {
      throw new Error(`Invalid MTUDPPeer chunk length L=${L} at offset ${offset}`);
    }
    const bodyWithLen = datagram.subarray(offset, offset + L);
    const expectedCrc = computeCRC8(0, bodyWithLen, L);
    const actualCrc = datagram[offset + L]!;
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `MTUDPPeer CRC8 mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`
      );
    }
    chunks.push(datagram.subarray(offset + 1, offset + L).slice());
    offset += L + 1;
  }
  return chunks;
}

/**
 * Builds the 6-byte plain-BE UDP keepalive payload `[u16 BE(0), u32 BE(userId)]`.
 * The checked-in decompilation does not establish the client's send cadence.
 */
export function buildUdpServerKeepalive(userId: number): Uint8Array {
  const w = new PacketWriter(0, 0);
  w.writeU32(userId >>> 0);
  return MTUDPPeer.encodeFrame(w.toPayload());
}

/**
 * CUDPPeerManBase::sub_5EC943 (`0x005EC943`) case `4`:
 * Server replies 1-byte inner payload `[u8(4)]` (`MTUDPPeer` frame `[0x02, 0x04, crc8]`).
 */
export function buildUdpServerKeepaliveAck(): Uint8Array {
  return MTUDPPeer.encodeFrame(new Uint8Array([4]));
}

export interface UdpGameLoadRegistration {
  userId: number;
  roomId: number;
  roomGameKey: number;
  localIp0: number;
  localPort0: number;
  localIp1: number;
  localPort1: number;
  mapCrc8: number;
  player0Attrs: [number, number, number, number];
  player1Attrs: [number, number, number, number];
}

/**
 * sub_4ED400 (`0x004ED400`):
 * Sends 36-byte plain BE (`degree = 0`) UDP load-complete registration (`u16 BE opcode = 1`)
 * to Server UDP port (`tcpPort + 1`) on `CGameStage` init and every 1000ms until `S->C 136` or `S->C 135`.
 */
export function buildUdpGameLoadRegistration(reg: UdpGameLoadRegistration): Uint8Array {
  const w = new PacketWriter(1, 0);
  w.writeU32(reg.userId >>> 0);
  w.writeU16(reg.roomId & 0xffff);
  w.writeU32(reg.roomGameKey >>> 0);
  w.writeU32(reg.localIp0 >>> 0);
  w.writeU16(reg.localPort0 & 0xffff);
  w.writeU32(reg.localIp1 >>> 0);
  w.writeU16(reg.localPort1 & 0xffff);
  w.writeU32(reg.mapCrc8 >>> 0);
  w.writeBlock(new Uint8Array(reg.player0Attrs));
  w.writeBlock(new Uint8Array(reg.player1Attrs));
  return MTUDPPeer.encodeFrame(w.toPayload());
}

export function parseUdpGameLoadRegistration(inner: Uint8Array): UdpGameLoadRegistration | null {
  if (inner.length < 36) {
    return null;
  }
  const r = new PacketReader(inner, 0, true);
  if (r.opcode !== 1) {
    return null;
  }
  const userId = r.readU32();
  const roomId = r.readU16();
  const roomGameKey = r.readU32();
  const localIp0 = r.readU32();
  const localPort0 = r.readU16();
  const localIp1 = r.readU32();
  const localPort1 = r.readU16();
  const mapCrc8 = r.readU32();
  const p0 = r.readBlock(4);
  const p1 = r.readBlock(4);
  return {
    userId,
    roomId,
    roomGameKey,
    localIp0,
    localPort0,
    localIp1,
    localPort1,
    mapCrc8,
    player0Attrs: [p0[0]!, p0[1]!, p0[2]!, p0[3]!],
    player1Attrs: [p1[0]!, p1[1]!, p1[2]!, p1[3]!],
  };
}

/**
 * CUDPPeerClient::sub_5EC195 (`0x005EC195`) and companion `sub_5EC1FF`:
 * Emit `[u8(0), u8(probePeerIdx), u8(localPeerIdx)]`, with the observed probe indexes 0 and 1.
 */
export function buildUdpPeerProbe(
  localPeerIdx: number,
  probePeerIdx: 0 | 1 = 0
): Uint8Array {
  return MTUDPPeer.encodeFrame(new Uint8Array([0, probePeerIdx, localPeerIdx & 0xff]));
}

/** @deprecated Use `buildUdpPeerProbe`; retained for existing callers. */
export function buildUdpPeerKeepalive(localPeerIdx: number): Uint8Array {
  return buildUdpPeerProbe(localPeerIdx, 0);
}

/**
 * CUDPPeerManBase::sub_5ECA87 (fan-out) / sub_5ECB1E (targeted),
 * at `0x005ECA87` / `0x005ECB1E`:
 * Prepends `[u8(1), u8(localPeerIdx)]` before a `CSendPacketUDP` (`degree = 0`) inner payload.
 */
export function buildUdpPeerData(
  localPeerIdx: number,
  innerWriterOrBytes: PacketWriter | Uint8Array
): Uint8Array {
  const body =
    innerWriterOrBytes instanceof PacketWriter
      ? innerWriterOrBytes.toPayload()
      : innerWriterOrBytes;
  const full = new Uint8Array(2 + body.length);
  full[0] = 1;
  full[1] = localPeerIdx & 0xff;
  full.set(body, 2);
  return MTUDPPeer.encodeFrame(full);
}

export type ParsedUdpPeerInner =
  | {
      innerOpcode: 0;
      roundXorSubSlot: number;
      slot: number;
      x: number;
      y: number;
      dir: number;
      seq: number;
    }
  | {
      innerOpcode: 1;
      stageRound: number;
      slot: number;
      subSlot: number;
      dir: number;
      x: number;
      y: number;
      f28: number;
      f32: number;
      f36: number;
    }
  | {
      innerOpcode: 2;
      stageRound: number;
      packedSlot: number;
      anim: number;
      x: number;
      y: number;
    }
  | {
      innerOpcode: 3;
      roundXorSubSlot: number;
      slot: number;
      x: number;
      y: number;
      dir: number;
      velocityBlock: Uint8Array;
      f64: number;
      f68: number;
      seq: number;
    }
  | {
      innerOpcode: 4;
      entityNetId: number;
      tick: number;
      syncData: Uint8Array;
    };

/**
 * CGameStage::sub_4ECF93 (`0x004ECF93`):
 * Parses the inner P2P payload after `CUDPPeerManBase::sub_5EC943` strips `[u8(1), u8(senderSlot)]`.
 */
export function parseUdpPeerInnerPacket(p2pBody: Uint8Array): ParsedUdpPeerInner | null {
  if (p2pBody.length < 2) {
    return null;
  }
  const r = new PacketReader(p2pBody, 0, true);
  switch (r.opcode) {
    case 0: {
      // 8 bytes total (`sub_6974A0(v2) == 8`): [u16 BE(0), u8(round^subSlot), 4B LE(packedPos), u8(seq)]
      if (p2pBody.length !== 8) return null;
      const roundXorSubSlot = r.readU8();
      const posBlock = r.readBlock(4);
      const packed = new DataView(
        posBlock.buffer,
        posBlock.byteOffset,
        posBlock.byteLength
      ).getUint32(0, true);
      const seq = r.readU8();
      return {
        innerOpcode: 0,
        roundXorSubSlot,
        slot: packed & 0x0f,
        x: (packed >>> 4) & 0x3ff,
        y: (packed >>> 14) & 0x3ff,
        dir: (packed >>> 24) & 0xff,
        seq,
      };
    }
    case 1: {
      // 13 bytes total (`sub_6974A0(v2) == 13`)
      if (p2pBody.length !== 13) return null;
      return {
        innerOpcode: 1,
        stageRound: r.readU8(),
        slot: r.readU8(),
        subSlot: r.readU8(),
        dir: r.readU8(),
        x: r.readU16(),
        y: r.readU16(),
        f28: r.readU8(),
        f32: r.readU8(),
        f36: r.readU8(),
      };
    }
    case 2: {
      // 9 bytes total (`sub_6974A0(v2) == 9`)
      if (p2pBody.length !== 9) return null;
      return {
        innerOpcode: 2,
        stageRound: r.readU8(),
        packedSlot: r.readU8(),
        anim: r.readU8(),
        x: r.readU16(),
        y: r.readU16(),
      };
    }
    case 3: {
      // 26 bytes total (`sub_6974A0(v2) == 26`)
      if (p2pBody.length !== 26) return null;
      const roundXorSubSlot = r.readU8();
      const posBlock = r.readBlock(4);
      const packed = new DataView(
        posBlock.buffer,
        posBlock.byteOffset,
        posBlock.byteLength
      ).getUint32(0, true);
      const velocityBlock = r.readBlock(16);
      const f64 = r.readU8();
      const f68 = r.readU8();
      const seq = r.readU8();
      return {
        innerOpcode: 3,
        roundXorSubSlot,
        slot: packed & 0x0f,
        x: (packed >>> 4) & 0x3ff,
        y: (packed >>> 14) & 0x3ff,
        dir: (packed >>> 24) & 0xff,
        velocityBlock,
        f64,
        f68,
        seq,
      };
    }
    case 4: {
      // CNetSyncMan::sub_57A288 (`0x0057A288`): [u16 BE(4), u16 BE(entityNetId), u32 BE(tick), ...]
      if (p2pBody.length < 8) return null;
      return {
        innerOpcode: 4,
        entityNetId: r.readU16(),
        tick: r.readU32(),
        syncData: r.readBlock(r.remaining),
      };
    }
    default:
      return null;
  }
}

export const MTUDPPeer = {
  encodeFrame(innerPayload: Uint8Array): Uint8Array {
    return encodeUdpDatagram([innerPayload]);
  },
  decodeFrame(datagram: Uint8Array): Uint8Array | null {
    try {
      const chunks = decodeUdpDatagram(datagram);
      return chunks[0] ?? null;
    } catch {
      return null;
    }
  },
};
