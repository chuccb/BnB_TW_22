import iconv from "iconv-lite";

/**
 * The shipped Taiwan client initializes region 8 (`tw`) and uses CP950/Big5 ANSI strings.
 * Packet and SmartStream string lengths are byte lengths, so all text on the wire must be
 * encoded before its length is written. UTF-8 happens to work for ASCII but corrupts
 * Traditional Chinese names and notices.
 */
export const CLIENT_TEXT_ENCODING = "cp950" as const;

export function encodeClientText(value: string): Uint8Array {
  return iconv.encode(value, CLIENT_TEXT_ENCODING);
}

export function decodeClientText(bytes: Uint8Array): string {
  return iconv.decode(bytes, CLIENT_TEXT_ENCODING);
}
