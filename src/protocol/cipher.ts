import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Exact reconstruction of payload stream cipher:
 * - sub_695B00 (0x00695B00): Encrypt
 * - sub_695BA0 (0x00695BA0): Decrypt
 * - byte_924D10 (VA 0x00924D10, file offset 0x00524D10 in CA.exe): Connect Hello substitution table
 */

const BYTE_924D10_OFFSET = 0x00524d10;
const BYTE_924D10_SIZE = 16 * 256;

let connectTableCache: Uint8Array | null = null;

export function getConnectHelloTable(repoRoot: string = process.cwd()): Uint8Array {
  if (connectTableCache) {
    return connectTableCache;
  }
  const exePath = resolve(repoRoot, "CA.exe");
  if (existsSync(exePath)) {
    const fd = readFileSync(exePath);
    if (fd.length >= BYTE_924D10_OFFSET + BYTE_924D10_SIZE) {
      connectTableCache = new Uint8Array(
        fd.buffer,
        fd.byteOffset + BYTE_924D10_OFFSET,
        BYTE_924D10_SIZE
      ).slice();
      return connectTableCache;
    }
  }
  // Fallback identity rows if CA.exe is not present
  const fallback = new Uint8Array(BYTE_924D10_SIZE);
  for (let k = 0; k < 16; k++) {
    for (let i = 0; i < 256; i++) {
      fallback[k * 256 + i] = i;
    }
  }
  connectTableCache = fallback;
  return connectTableCache;
}

/**
 * Encode Connect Hello first byte so that byte_924D10[256 * key + encodedByte] == plainByte
 * (sub_696F60, 0x00696F60)
 */
export function encodeConnectHelloFirstByte(
  key: number,
  plainByte: number,
  repoRoot?: string
): number {
  const table = getConnectHelloTable(repoRoot);
  const k = key & 0x0f;
  const rowOffset = k * 256;
  const target = plainByte & 0xff;
  for (let i = 0; i < 256; i++) {
    if (table[rowOffset + i] === target) {
      return i;
    }
  }
  return target;
}

/**
 * Decode Connect Hello first byte via byte_924D10[256 * key + cipherByte] (sub_696F60)
 */
export function decodeConnectHelloFirstByte(
  key: number,
  cipherByte: number,
  repoRoot?: string
): number {
  const table = getConnectHelloTable(repoRoot);
  const k = key & 0x0f;
  return table[k * 256 + (cipherByte & 0xff)]!;
}

/**
 * sub_695B00(counter, dst, src, len): Encrypt plaintext payload in 4-byte LE words + tail
 */
export function encryptPayload(counter: number, plain: Uint8Array): Uint8Array {
  const len = plain.length;
  const cipher = new Uint8Array(len);
  if (len === 0) {
    return cipher;
  }

  const plainView = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const cipherView = new DataView(cipher.buffer, cipher.byteOffset, cipher.byteLength);

  let k = (counter ^ 0x53351d9c) >>> 0;
  const wordCount = len >>> 2;
  let tailKey = k;

  if (wordCount > 0) {
    const src0 = plainView.getUint32(0, true);
    cipherView.setUint32(0, (k ^ src0) >>> 0, true);
    let prevSrc = src0;

    for (let i = 1; i < wordCount; i++) {
      k = (k - 0x63ca6283) >>> 0;
      const curSrc = plainView.getUint32(i * 4, true);
      const encWord = (k ^ curSrc ^ prevSrc) >>> 0;
      cipherView.setUint32(i * 4, encWord, true);
      prevSrc = curSrc;
    }
    tailKey = prevSrc;
  }

  const tailOffset = wordCount * 4;
  const tailBytes = len & 3;
  for (let b = 0; b < tailBytes; b++) {
    cipher[tailOffset + b] = (plain[tailOffset + b]! ^ ((tailKey >>> (8 * b)) & 0xff)) & 0xff;
  }

  return cipher;
}

/**
 * sub_695BA0(counter, dst, src, len): Decrypt ciphertext payload in 4-byte LE words + tail
 */
export function decryptPayload(counter: number, cipher: Uint8Array): Uint8Array {
  const len = cipher.length;
  const plain = new Uint8Array(len);
  if (len === 0) {
    return plain;
  }

  const cipherView = new DataView(cipher.buffer, cipher.byteOffset, cipher.byteLength);
  const plainView = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);

  let k = (counter ^ 0x53351d9c) >>> 0;
  const wordCount = len >>> 2;
  let tailKey = k;

  if (wordCount > 0) {
    const enc0 = cipherView.getUint32(0, true);
    let prevPlain = (k ^ enc0) >>> 0;
    plainView.setUint32(0, prevPlain, true);

    for (let i = 1; i < wordCount; i++) {
      k = (k - 0x63ca6283) >>> 0;
      const encWord = cipherView.getUint32(i * 4, true);
      const curPlain = (k ^ encWord ^ prevPlain) >>> 0;
      plainView.setUint32(i * 4, curPlain, true);
      prevPlain = curPlain;
    }
    tailKey = prevPlain;
  }

  const tailOffset = wordCount * 4;
  const tailBytes = len & 3;
  for (let b = 0; b < tailBytes; b++) {
    plain[tailOffset + b] = (cipher[tailOffset + b]! ^ ((tailKey >>> (8 * b)) & 0xff)) & 0xff;
  }

  return plain;
}
