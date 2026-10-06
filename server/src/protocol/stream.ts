import { deflateSync, inflateSync } from "zlib";
import { computeAdler32Zero } from "./crc.ts";
import { decodeClientText, encodeClientText } from "./textEncoding.ts";

/**
 * Exact reconstruction of COSmartStream and CISmartStream (0x006983F0 - 0x00699860)
 *
 * Outer container layout:
 * - byte[0] = 0x18 (magic)
 * - byte[1..4] = u32 LE bodySize (total bytes following byte[4])
 * - byte[5] = mode (0 = raw, 1 = zlib compressed)
 *   - If mode == 0: raw bytes (bodySize - 1 bytes)
 *   - If mode == 1: u32 LE uncompressedLength + zlib stream (bodySize - 5 bytes)
 *
 * Inside the stream, primitives use native x86 Little-Endian (`memcpy` in `sub_698B20`–`sub_6997B0`):
 * - u8 / i8: 1 byte (`sub_698B80` / `sub_699630`)
 * - u16 / i16: u16 LE (`sub_698BA0` / `sub_699650`)
 * - u32 / i32: u32 LE (`sub_698BC0` / `sub_699670`)
 * - str: u32 LE length + raw bytes (`sub_699090` / `sub_6997B0`)
 *
 * `CISmartStream::sub_6984B0(this)` (`0x006984B0`) computes `sub_658610(0, body, bodySize)`
 * (Adler-32 seed 0 over `container[5..5+bodySize]`). Separately, `sub_699410` validates an `"ssi1"`
 * file-header checksum over the entire COSmartStream container. Its layout is
 * `["ssi1" (4B)][u32 LE adler32Zero(container)][[0x18][u32 LE bodySize][...]]`.
 */

export class SmartStreamWriter {
  private chunks: Uint8Array[] = [];
  private totalLen = 0;

  writeU8(val: number): this {
    const b = new Uint8Array(1);
    b[0] = val & 0xff;
    this.chunks.push(b);
    this.totalLen += 1;
    return this;
  }

  writeI8(val: number): this {
    return this.writeU8(val);
  }

  writeU16(val: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, val & 0xffff, true);
    this.chunks.push(b);
    this.totalLen += 2;
    return this;
  }

  writeI16(val: number): this {
    return this.writeU16(val);
  }

  writeU32(val: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, val >>> 0, true);
    this.chunks.push(b);
    this.totalLen += 4;
    return this;
  }

  writeI32(val: number): this {
    return this.writeU32(val >>> 0);
  }

  writeBytes(bytes: Uint8Array): this {
    if (bytes.length > 0) {
      const copy = bytes.slice();
      this.chunks.push(copy);
      this.totalLen += copy.length;
    }
    return this;
  }

  writeRaw(bytes: Uint8Array): this {
    return this.writeBytes(bytes);
  }

  /**
   * COSmartStream::sub_699090 / CISmartStream::sub_6997B0:
   * Stream strings use a 4-byte u32 LE length prefix followed by raw string bytes.
   */
  writeString(str: string): this {
    const encoded = encodeClientText(str);
    this.writeU32(encoded.length);
    this.writeBytes(encoded);
    return this;
  }

  toRawPayload(): Uint8Array {
    const out = new Uint8Array(this.totalLen);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  /**
   * Wrap into COSmartStream outer container (0x006983F0):
   * [0x18][u32 LE bodySize][u8 mode][...]
   */
  toSmartStreamBuffer(compress: boolean = true): Uint8Array {
    const raw = this.toRawPayload();
    if (!compress) {
      const bodySize = 1 + raw.length;
      const out = new Uint8Array(5 + bodySize);
      const dv = new DataView(out.buffer);
      out[0] = 0x18;
      dv.setUint32(1, bodySize, true);
      out[5] = 0; // mode 0 = raw
      out.set(raw, 6);
      return out;
    } else {
      const z = new Uint8Array(deflateSync(raw));
      const bodySize = 1 + 4 + z.length;
      const out = new Uint8Array(5 + bodySize);
      const dv = new DataView(out.buffer);
      out[0] = 0x18;
      dv.setUint32(1, bodySize, true);
      out[5] = 1; // mode 1 = zlib
      dv.setUint32(6, raw.length, true);
      out.set(z, 10);
      return out;
    }
  }

  /**
   * Wrap into an `"ssi1"` file buffer (`sub_699410` at `0x00699410`):
   * `["ssi1" (4B)][u32 LE adler32Zero(container)][COSmartStream container]`
   */
  toSsi1Buffer(compress: boolean = true): Uint8Array {
    const streamBuf = this.toSmartStreamBuffer(compress);
    const containerChecksum = computeAdler32Zero(streamBuf, 0);
    const out = new Uint8Array(8 + streamBuf.length);
    out[0] = 0x73; // 's'
    out[1] = 0x73; // 's'
    out[2] = 0x69; // 'i'
    out[3] = 0x31; // '1'
    new DataView(out.buffer).setUint32(4, containerChecksum, true);
    out.set(streamBuf, 8);
    return out;
  }
}

/**
 * `CISmartStream::sub_6984B0(this)` (`0x006984B0`):
 * Computes `sub_658610(0, body, bodySize)` over the `bodySize` bytes starting at `container[5]`.
 */
export function computeSmartStreamBodyChecksum(container: Uint8Array): number {
  if (container.length < 6 || container[0] !== 0x18) {
    throw new Error(`Invalid COSmartStream magic: expected 0x18, got 0x${container[0]?.toString(16)}`);
  }
  const dv = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const bodySize = dv.getUint32(1, true);
  const expectedLength = 5 + bodySize;
  if (container.length !== expectedLength) {
    throw new Error(
      `Invalid COSmartStream container length: expected ${expectedLength}, got ${container.length}`
    );
  }
  return computeAdler32Zero(container.subarray(5, expectedLength), 0);
}

export class SmartStreamReader {
  private view: DataView;
  public offset = 0;
  public readonly raw: Uint8Array;

  constructor(rawPayload: Uint8Array) {
    this.raw = rawPayload;
    this.view = new DataView(rawPayload.buffer, rawPayload.byteOffset, rawPayload.byteLength);
  }

  public get bytes(): Uint8Array {
    return this.raw;
  }

  /**
   * Parse an outer COSmartStream container ([0x18][u32 LE bodySize][mode]...)
   */
  static fromSmartStreamBuffer(container: Uint8Array): SmartStreamReader {
    if (container.length < 6 || container[0] !== 0x18) {
      throw new Error(`Invalid COSmartStream magic: expected 0x18, got 0x${container[0]?.toString(16)}`);
    }
    const dv = new DataView(container.buffer, container.byteOffset, container.byteLength);
    const bodySize = dv.getUint32(1, true);
    const expectedLength = 5 + bodySize;
    if (container.length !== expectedLength) {
      throw new Error(
        `Invalid COSmartStream container length: expected ${expectedLength}, got ${container.length}`
      );
    }
    if (bodySize < 1) {
      throw new Error(`Invalid COSmartStream body size: ${bodySize} does not include a mode byte`);
    }

    const mode = container[5]!;
    if (mode === 0) {
      const raw = container.subarray(6, expectedLength);
      return new SmartStreamReader(raw);
    } else if (mode === 1) {
      if (bodySize < 5) {
        throw new Error(`Invalid compressed COSmartStream body size: expected at least 5, got ${bodySize}`);
      }
      const uncompLen = dv.getUint32(6, true);
      const zData = container.subarray(10, expectedLength);
      const inflated = new Uint8Array(inflateSync(zData));
      if (inflated.length !== uncompLen) {
        throw new Error(`COSmartStream uncompressed length mismatch: expected ${uncompLen}, got ${inflated.length}`);
      }
      return new SmartStreamReader(inflated);
    } else {
      throw new Error(`Unsupported COSmartStream mode: ${mode}`);
    }
  }

  /**
   * Parse an `"ssi1"` buffer (`sub_699410` at `0x00699410`), validating its checksum over the complete
   * embedded `COSmartStream`, then return the separate `sub_6984B0` body checksum.
   */
  static fromSsi1Buffer(buf: Uint8Array): { reader: SmartStreamReader; checksum: number } {
    if (
      buf.length < 14 ||
      buf[0] !== 0x73 ||
      buf[1] !== 0x73 ||
      buf[2] !== 0x69 ||
      buf[3] !== 0x31
    ) {
      throw new Error("Invalid ssi1 header magic");
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const expectedChecksum = dv.getUint32(4, true);
    const container = buf.subarray(8);
    // sub_699410 (`0x00699410`) compares the ssi1 header with sub_658610(0, container, container.length).
    const actualContainerChecksum = computeAdler32Zero(container, 0);
    if (actualContainerChecksum !== expectedChecksum) {
      throw new Error(
        `ssi1 checksum mismatch: header=0x${expectedChecksum.toString(16)}, container=0x${actualContainerChecksum.toString(16)}`
      );
    }
    // CSmartStream::sub_6984B0 (`0x006984B0`) separately computes the checksum over container[5..5+bodySize].
    const bodyChecksum = computeSmartStreamBodyChecksum(container);
    return {
      reader: SmartStreamReader.fromSmartStreamBuffer(container),
      checksum: bodyChecksum,
    };
  }

  remaining(): number {
    return this.raw.length - this.offset;
  }

  private ensureAvailable(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid SmartStream read length ${length} at offset ${this.offset}`);
    }
    if (this.offset < 0 || this.offset > this.raw.length || length > this.raw.length - this.offset) {
      const remaining = Math.max(0, this.raw.length - this.offset);
      throw new RangeError(
        `SmartStreamReader out of bounds at offset ${this.offset}: requested ${length} byte(s), ${remaining} remain`
      );
    }
  }

  readU8(): number {
    this.ensureAvailable(1);
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }

  readI8(): number {
    this.ensureAvailable(1);
    const val = this.view.getInt8(this.offset);
    this.offset += 1;
    return val;
  }

  readU16(): number {
    this.ensureAvailable(2);
    const val = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readI16(): number {
    this.ensureAvailable(2);
    const val = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readU32(): number {
    this.ensureAvailable(4);
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readI32(): number {
    this.ensureAvailable(4);
    const val = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readBytes(len: number): Uint8Array {
    this.ensureAvailable(len);
    const slice = this.raw.subarray(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  readString(): string {
    const len = this.readU32();
    const bytes = this.readBytes(len);
    return decodeClientText(bytes);
  }
}
