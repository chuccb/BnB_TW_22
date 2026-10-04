import { decryptPayload, encryptPayload } from "./cipher.ts";
import { decodeClientText, encodeClientText } from "./textEncoding.ts";
import { SmartStreamReader, SmartStreamWriter } from "./stream.ts";

/**
 * Exact reconstruction of CSendPacket / CSendPacketBase and CReceivedPacketBase / CReceivedPacketConnect
 * primitive readers & writers (0x00669010 - 0x00669510, 0x00695570 - 0x00698350).
 *
 * Degrees:
 * - deg = 0: Unscrambled Big-Endian (used by CReceivedPacketConnect and CSendPacketUDP)
 * - deg = 1, 2, 3: XOR + Big-Endian scrambled (used by CSendPacket deg=2 and CReceivedPacketBase deg=3)
 */

const OLE_EPOCH_OFFSET_DAYS = 25569.0; // Days between 1899-12-30 and 1970-01-01
const MS_PER_DAY = 86_400_000;

/**
 * Convert Unix timestamp in milliseconds to OLE Automation `DATE` (`VariantTime`, IEEE-754 f64 LE).
 * Used by `sub_58EBFE` (`S->C 199`), `sub_53A6F1` (`S->C 204`), `sub_56FB09` (`S->C 277`),
 * and `sub_594ECF` (`S->C 188` / `S->C 194`) via `sub_697640` + `VariantTimeToSystemTime`.
 * When `unixMs <= 0`, returns a far-future permanent date (+100 years).
 */
export function unixMsToVariantTime(unixMs: number = Date.now()): number {
  if (unixMs <= 0) {
    return (Date.now() / MS_PER_DAY) + OLE_EPOCH_OFFSET_DAYS + 36500.0;
  }
  return (unixMs / MS_PER_DAY) + OLE_EPOCH_OFFSET_DAYS;
}

/**
 * Convert an IPv4 dotted-quad string (`"127.0.0.1"`) into four network-order octets.
 */
export function ipv4ToBytes(ip: string): Uint8Array {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10) & 0xff);
  return new Uint8Array([parts[0] ?? 127, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]);
}

/**
 * Converts a dotted-quad into the u32 value the client expects when reading `S->C 7`.
 * `PacketWriter.writeU32` emits that value in network byte order on the wire.
 */
function parseIPv4Octets(ip: string): [number, number, number, number] {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    throw new TypeError(`Invalid IPv4 address: ${ip}`);
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    throw new TypeError(`Invalid IPv4 address: ${ip}`);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** Network-order numeric IPv4 value used by the TCP packet primitive writer. */
export function ipv4ToUint32(ip: string): number {
  const [a, b, c, d] = parseIPv4Octets(ip);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * Little-endian SmartStream value whose in-memory bytes are the network-order `in_addr`
 * bytes passed by the client to Windows `inet_ntoa` (for example 127.0.0.1 -> 0x0100007F).
 */
export function ipv4ToInAddrLittleEndian(ip: string): number {
  const [a, b, c, d] = parseIPv4Octets(ip);
  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

/**
 * Convert OLE Automation `DATE` (`VariantTime`) back to Unix milliseconds.
 */
export function variantTimeToUnixMs(vt: number): number {
  return Math.round((vt - OLE_EPOCH_OFFSET_DAYS) * MS_PER_DAY);
}

/**
 * sub_6692F0(dst, src, len): Scramble byte block for deg 1..3
 */
export function scrambleBlock(src: Uint8Array): Uint8Array {
  const len = src.length;
  const dst = new Uint8Array(len);
  const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const dstView = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);

  let offset = 0;
  let rem = len;
  while (rem > 0) {
    if (rem >= 4) {
      const val = srcView.getUint32(offset, true);
      dstView.setUint32(offset, (val ^ 0x96ca5395) >>> 0, false);
      offset += 4;
      rem -= 4;
    } else if (rem >= 2) {
      const val = srcView.getUint16(offset, true);
      dstView.setUint16(offset, (val ^ 0xa569) & 0xffff, false);
      offset += 2;
      rem -= 2;
    } else {
      dst[offset] = (src[offset]! ^ 0x5a) & 0xff;
      offset += 1;
      rem -= 1;
    }
  }
  return dst;
}

/**
 * sub_669490(dst, src, len): Unscramble byte block for deg 1..3
 */
export function unscrambleBlock(src: Uint8Array): Uint8Array {
  const len = src.length;
  const dst = new Uint8Array(len);
  const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const dstView = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);

  let offset = 0;
  let rem = len;
  while (rem > 0) {
    if (rem >= 4) {
      const val = srcView.getUint32(offset, false);
      dstView.setUint32(offset, (val ^ 0x96ca5395) >>> 0, true);
      offset += 4;
      rem -= 4;
    } else if (rem >= 2) {
      const val = srcView.getUint16(offset, false);
      dstView.setUint16(offset, (val ^ 0xa569) & 0xffff, true);
      offset += 2;
      rem -= 2;
    } else {
      dst[offset] = (src[offset]! ^ 0x5a) & 0xff;
      offset += 1;
      rem -= 1;
    }
  }
  return dst;
}

export class PacketWriter {
  public readonly degree: number;
  public readonly opcode: number | null;
  private chunks: Uint8Array[] = [];
  private totalLen = 0;

  /**
   * If opcode is provided, writes it immediately as a 2-byte u16 (CSendPacketBase::sub_695D70).
   * Pass opcode = null for Connect Hello (CSendPacketConnect), which has no 2-byte opcode prefix.
   */
  constructor(opcode: number | null, degree: number = 3) {
    this.degree = degree;
    this.opcode = opcode;
    if (opcode !== null) {
      this.writeU16(opcode);
    }
  }

  private isScrambled(): boolean {
    return this.degree >= 1 && this.degree <= 3;
  }

  /**
   * CSendPacketBase::sub_695630 (1 byte)
   */
  writeU8(val: number): this {
    const b = new Uint8Array(1);
    b[0] = this.isScrambled() ? (val ^ 0x5a) & 0xff : val & 0xff;
    this.chunks.push(b);
    this.totalLen += 1;
    return this;
  }

  writeI8(val: number): this {
    return this.writeU8(val & 0xff);
  }

  /**
   * CSendPacket::sub_695650 (2 bytes)
   */
  writeU16(val: number): this {
    const b = new Uint8Array(2);
    const v = this.isScrambled() ? (val ^ 0xa569) & 0xffff : val & 0xffff;
    new DataView(b.buffer).setUint16(0, v, false);
    this.chunks.push(b);
    this.totalLen += 2;
    return this;
  }

  writeI16(val: number): this {
    return this.writeU16(val & 0xffff);
  }

  /**
   * CSendPacket::sub_695670 (4 bytes)
   */
  writeU32(val: number): this {
    const b = new Uint8Array(4);
    const v = this.isScrambled() ? (val ^ 0x96ca5395) >>> 0 : val >>> 0;
    new DataView(b.buffer).setUint32(0, v, false);
    this.chunks.push(b);
    this.totalLen += 4;
    return this;
  }

  writeI32(val: number): this {
    return this.writeU32(val >>> 0);
  }

  /**
   * CSendPacket::sub_695690 (8 bytes, sub_669280 / sub_669060)
   */
  writeU64(val: bigint): this {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    const hi = Number((val >> 32n) & 0xffffffffn) >>> 0;
    const lo = Number(val & 0xffffffffn) >>> 0;
    dv.setUint32(0, hi, false);
    dv.setUint32(4, this.isScrambled() ? (lo ^ 0x71b18589) >>> 0 : lo, false);
    this.chunks.push(b);
    this.totalLen += 8;
    return this;
  }

  /**
   * CSendPacket::sub_695710 (block of bytes, sub_6692F0)
   */
  writeBlock(bytes: Uint8Array): this {
    if (bytes.length === 0) {
      return this;
    }
    const encoded = this.isScrambled() ? scrambleBlock(bytes) : bytes.slice();
    this.chunks.push(encoded);
    this.totalLen += encoded.length;
    return this;
  }

  /**
   * Writes an 8-byte IEEE-754 little-endian OLE Automation `VariantTime` via `writeBlock(8)`.
   * Decoded on client by `sub_697640(pkt, &vt, 8u)` + `VariantTimeToSystemTime(vt, &SystemTime)`.
   */
  writeVariantTime(vt: number = unixMsToVariantTime()): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, vt, true);
    return this.writeBlock(b);
  }

  /**
   * Writes a 16-byte Windows `SYSTEMTIME` struct (`8 * u16 LE`) via `writeBlock(16)`.
   * Used by `CStockInfo::sub_5C7EAE` in `CExchangeStage`.
   */
  writeSystemTime(date: Date = new Date()): this {
    const b = new Uint8Array(16);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, date.getUTCFullYear(), true);
    dv.setUint16(2, date.getUTCMonth() + 1, true);
    dv.setUint16(4, date.getUTCDay(), true);
    dv.setUint16(6, date.getUTCDate(), true);
    dv.setUint16(8, date.getUTCHours(), true);
    dv.setUint16(10, date.getUTCMinutes(), true);
    dv.setUint16(12, date.getUTCSeconds(), true);
    dv.setUint16(14, date.getUTCMilliseconds(), true);
    return this.writeBlock(b);
  }

  /**
   * CSendPacket::sub_6956C0 (sub_6979B0): u16 length + block-scrambled bytes
   */
  writeString(str: string): this {
    const raw = encodeClientText(str);
    const len = Math.min(raw.length, 0x7fff);
    this.writeU16(len);
    this.writeBlock(raw.subarray(0, len));
    return this;
  }

  /**
   * CSendPacket::sub_6956E0 (sub_697AD0): u16 length + sub_695B00(raw, key)
   * Used in C->S 31, C->S 2, C->S 11 login packets with keys 0x11223344, 0x44332211, 0xAABBCCDD.
   */
  writeCipherString(str: string, key: number): this {
    const raw = encodeClientText(str);
    const len = Math.min(raw.length, 0x7fff);
    this.writeU16(len);
    const enc = encryptPayload(key >>> 0, raw.subarray(0, len));
    this.chunks.push(enc);
    this.totalLen += enc.length;
    return this;
  }

  writeKeyedString(str: string, key: number): this {
    return this.writeCipherString(str, key);
  }

  /**
   * CSendPacket::sub_695740 (sub_6962A0):
   * If deg 1..3: u32 length + block-scrambled COSmartStream bytes.
   * If deg 0: raw COSmartStream bytes.
   */
  writeSmartStream(
    streamOrWriter: Uint8Array | SmartStreamWriter,
    compress: boolean = true
  ): this {
    const streamBytes =
      streamOrWriter instanceof SmartStreamWriter
        ? streamOrWriter.toSmartStreamBuffer(compress)
        : streamOrWriter;
    if (this.isScrambled()) {
      this.writeU32(streamBytes.length);
      this.writeBlock(streamBytes);
    } else {
      this.writeBlock(streamBytes);
    }
    return this;
  }

  writeSmartStreamWriter(writer: SmartStreamWriter, compress: boolean = true): this {
    return this.writeSmartStream(writer.toSmartStreamBuffer(compress));
  }

  toPayload(): Uint8Array {
    const out = new Uint8Array(this.totalLen);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  toBytes(): Uint8Array {
    return this.toPayload();
  }
}

export class PacketReader {
  public readonly plain: Uint8Array;
  public readonly degree: number;
  public readonly opcode: number;
  private view: DataView;
  public offset = 0;

  constructor(plain: Uint8Array, degree: number = 2, hasOpcode: boolean = degree !== 0) {
    this.plain = plain;
    this.degree = degree;
    this.view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    this.opcode = hasOpcode && plain.length >= 2 ? this.readU16() : 0;
  }

  private isScrambled(): boolean {
    return this.degree >= 1 && this.degree <= 3;
  }

  get remaining(): number {
    return Math.max(0, this.plain.length - this.offset);
  }

  reset(newOffset: number = 2): void {
    this.offset = Math.min(newOffset, this.plain.length);
  }

  /**
   * Read 2-byte opcode
   */
  readOpcode(): number {
    return this.opcode;
  }

  /**
   * Peek 2-byte opcode without changing this.offset
   */
  peekOpcode(): number {
    return this.opcode;
  }

  /**
   * CReceivedPacketBase::sub_6974B0 (1 byte)
   */
  readU8(): number {
    if (this.offset + 1 > this.plain.length) {
      return 0;
    }
    const raw = this.plain[this.offset]!;
    this.offset += 1;
    return this.isScrambled() ? (raw ^ 0x5a) & 0xff : raw & 0xff;
  }

  peekU8(): number {
    if (this.offset + 1 > this.plain.length) {
      return 0;
    }
    const raw = this.plain[this.offset]!;
    return this.isScrambled() ? (raw ^ 0x5a) & 0xff : raw & 0xff;
  }

  readI8(): number {
    const u = this.readU8();
    return u >= 0x80 ? u - 0x100 : u;
  }

  /**
   * CReceivedPacketBase::sub_697510 (2 bytes)
   */
  readU16(): number {
    if (this.offset + 2 > this.plain.length) {
      return 0;
    }
    const raw = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return this.isScrambled() ? (raw ^ 0xa569) & 0xffff : raw & 0xffff;
  }

  peekU16(): number {
    if (this.offset + 2 > this.plain.length) {
      return 0;
    }
    const raw = this.view.getUint16(this.offset, false);
    return this.isScrambled() ? (raw ^ 0xa569) & 0xffff : raw & 0xffff;
  }

  readI16(): number {
    const u = this.readU16();
    return u >= 0x8000 ? u - 0x10000 : u;
  }

  /**
   * CReceivedPacketBase::sub_697580 (4 bytes)
   */
  readU32(): number {
    if (this.offset + 4 > this.plain.length) {
      return 0;
    }
    const raw = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return this.isScrambled() ? (raw ^ 0x96ca5395) >>> 0 : raw >>> 0;
  }

  readI32(): number {
    return this.readU32() | 0;
  }

  /**
   * CReceivedPacketBase::sub_6975E0 (8 bytes)
   */
  readU64(): bigint {
    if (this.offset + 8 > this.plain.length) {
      return 0n;
    }
    const hi = this.view.getUint32(this.offset, false) >>> 0;
    const loRaw = this.view.getUint32(this.offset + 4, false) >>> 0;
    const lo = this.isScrambled() ? (loRaw ^ 0x71b18589) >>> 0 : loRaw;
    this.offset += 8;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  /**
   * CReceivedPacketBase::sub_697640 (block of bytes, sub_669490)
   */
  readBlock(len: number): Uint8Array {
    if (len <= 0 || this.offset + len > this.plain.length) {
      return new Uint8Array(0);
    }
    const slice = this.plain.subarray(this.offset, this.offset + len);
    this.offset += len;
    return this.isScrambled() ? unscrambleBlock(slice) : slice.slice();
  }

  /**
   * Reads an 8-byte IEEE-754 little-endian OLE Automation `VariantTime` via `readBlock(8)`.
   */
  readVariantTime(): number {
    const b = this.readBlock(8);
    if (b.length < 8) {
      return 0;
    }
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(0, true);
  }

  /**
   * Reads a 16-byte Windows `SYSTEMTIME` struct (`8 * u16 LE`) via `readBlock(16)`.
   */
  readSystemTime(): Date {
    const b = this.readBlock(16);
    if (b.length < 16) {
      return new Date(0);
    }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const year = dv.getUint16(0, true);
    const month = Math.max(1, dv.getUint16(2, true)) - 1;
    const day = Math.max(1, dv.getUint16(6, true));
    const hour = dv.getUint16(8, true);
    const minute = dv.getUint16(10, true);
    const second = dv.getUint16(12, true);
    const ms = dv.getUint16(14, true);
    return new Date(Date.UTC(year, month, day, hour, minute, second, ms));
  }

  /**
   * CReceivedPacketBase::sub_698270 / sub_698290 (sub_697D90): u16 length + block
   */
  readString(): string {
    if (this.offset + 2 > this.plain.length) {
      return "";
    }
    const len = this.readU16();
    if (len === 0 || this.offset + len > this.plain.length) {
      return "";
    }
    const bytes = this.readBlock(len);
    return decodeClientText(bytes);
  }

  /**
   * CReceivedPacketBase::sub_697EF0: u16 length + sub_695BA0(cipherBytes, key)
   */
  readCipherString(key: number): string {
    if (this.offset + 2 > this.plain.length) {
      return "";
    }
    const len = this.readU16();
    if (len === 0 || this.offset + len > this.plain.length) {
      return "";
    }
    const cipherSlice = this.plain.subarray(this.offset, this.offset + len);
    this.offset += len;
    const plainBytes = decryptPayload(key >>> 0, cipherSlice);
    return decodeClientText(plainBytes);
  }

  readKeyedString(key: number): string {
    return this.readCipherString(key);
  }

  /**
   * CReceivedPacketBase::sub_697660 (sub_6967D0): u32 length + block-scrambled COSmartStream
   */
  readSmartStreamBuffer(): Uint8Array {
    if (this.isScrambled()) {
      const len = this.readU32();
      return this.readBlock(len);
    } else {
      if (this.remaining < 6) {
        return new Uint8Array(0);
      }
      const dv = new DataView(
        this.plain.buffer,
        this.plain.byteOffset + this.offset,
        this.remaining
      );
      const bodySize = dv.getUint32(1, true);
      const total = 5 + bodySize;
      return this.readBlock(total);
    }
  }

  readSmartStream(): SmartStreamReader {
    const buf = this.readSmartStreamBuffer();
    return SmartStreamReader.fromSmartStreamBuffer(buf);
  }
}
