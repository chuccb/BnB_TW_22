/**
 * Exact reconstruction of:
 * - CCRC32 (`0x00668EE0` - `0x00668F90`, table `dword_9C8060`, MSB-first poly `0x04C11DB7`)
 * - CCRC8  (`0x00668DE0` - `0x00668E80`, table `byte_9C8460`, MSB-first poly `0x07`)
 * - Adler-32 Seed 0 (`sub_658610` at `0x00658610`, called by `CSmartStream::sub_6984B0` at `0x006984B0`
 *   and `"ssi1"` loader `sub_699410` at `0x00699410`)
 * from `CA.exe.c`.
 */

const CRC32_TABLE = new Uint32Array(256);
const CRC8_TABLE = new Uint8Array(256);

// Initialize MSB-first CRC32 table with polynomial 0x04C11DB7 (sub_668EF0)
for (let i = 0; i < 256; i++) {
  let c = (i << 24) >>> 0;
  for (let bit = 0; bit < 8; bit++) {
    if ((c & 0x80000000) !== 0) {
      c = ((c << 1) ^ 0x04c11db7) >>> 0;
    } else {
      c = (c << 1) >>> 0;
    }
  }
  CRC32_TABLE[i] = c >>> 0;
}

// Initialize MSB-first CRC8 table with polynomial 0x07 (sub_668DF0)
for (let i = 0; i < 256; i++) {
  let c = i & 0xff;
  for (let bit = 0; bit < 8; bit++) {
    if ((c & 0x80) !== 0) {
      c = ((c << 1) ^ 0x07) & 0xff;
    } else {
      c = (c << 1) & 0xff;
    }
  }
  CRC8_TABLE[i] = c & 0xff;
}

/**
 * CCRC32::sub_668F90(seed, buf, len)
 */
export function computeCRC32(seed: number, buf: Uint8Array, len: number = buf.length): number {
  let crc = seed >>> 0;
  for (let i = 0; i < len; i++) {
    const idx = ((crc >>> 24) ^ buf[i]!) & 0xff;
    crc = ((crc << 8) ^ CRC32_TABLE[idx]!) >>> 0;
  }
  return crc >>> 0;
}

/**
 * CCRC8::sub_668E80(seed, buf, len)
 */
export function computeCRC8(seed: number, buf: Uint8Array, len: number = buf.length): number {
  let crc = seed & 0xff;
  for (let i = 0; i < len; i++) {
    crc = CRC8_TABLE[(crc ^ buf[i]!) & 0xff]!;
  }
  return crc & 0xff;
}

/**
 * sub_658610(seed, buf, len) at 0x00658610:
 * Adler-32 variant where s1 = seed & 0xFFFF, s2 = (seed >>> 16) & 0xFFFF, modulo 0xFFF1 (65521).
 * `CSmartStream::sub_6984B0` calls `sub_658610(0, body, bodySize)` (initial seed = 0, NOT 1).
 */
export function computeAdler32Zero(
  buf: Uint8Array,
  seed: number = 0,
  len: number = buf.length
): number {
  let s1 = seed & 0xffff;
  let s2 = (seed >>> 16) & 0xffff;
  let offset = 0;
  let remaining = len;

  while (remaining > 0) {
    const chunk = remaining < 5552 ? remaining : 5552;
    remaining -= chunk;
    for (let i = 0; i < chunk; i++) {
      s1 += buf[offset++]!;
      s2 += s1;
    }
    s1 %= 0xfff1;
    s2 %= 0xfff1;
  }

  return (((s2 << 16) | s1) >>> 0);
}
