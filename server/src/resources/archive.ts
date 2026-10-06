import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { computeCRC32 } from "../protocol/crc.ts";
import { ipv4ToInAddrLittleEndian } from "../protocol/primitives.ts";
import {
  DEFAULT_C_CHANNELS,
  writeCChannelCache,
  type CChannelCacheRecord,
} from "../protocol/channelCache.ts";
import {
  SmartStreamReader,
  SmartStreamWriter,
  computeSmartStreamBodyChecksum,
} from "../protocol/stream.ts";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CLIENT_RESOURCE_ROOT = existsSync(resolve(SERVER_ROOT, "CA.exe"))
  ? SERVER_ROOT
  : resolve(SERVER_ROOT, "..");

/**
 * Exact reconstruction of:
 * - CPackSysMan (.idx / .idd decryption, 0x00673110 - 0x006731A0, 0x006749C0)
 * - CData::sub_674590 (0x00674590)
 * - CBomberAttrMan (sub_4EC1FD, 0x004EC1FD)
 * - CItemAttrMan (sub_4EF2BD, 0x004EF2BD)
 * - CGameMapInfoList (sub_4E8597, 0x004E8597) & CGameMap::sub_4E5845 (0x004E5845, stores the low byte of CCRC32 from sub_668E80)
 * - All 12 Client .ssd / .ini SmartStream caches ("ssi1" loader sub_699410 at 0x00699410 & sub_6984B0 at 0x006984B0):
 *   1. fxdynimginfo.ssd (sub_49E093 / sub_49DF97, S->C 189)
 *   2. csysstr.ssd      (sub_5D00B9 / sub_5CFE6C, S->C 2)
 *   3. multisvr.ssd     (sub_5D7E8E / sub_5D782C, S->C 1)
 *   4. multisvrn.ssd    (sub_5D7E8E / sub_5D79AE, S->C 1)
 *   5. filterstr.ssd    (sub_5C8BE3 / sub_5C89D7, S->C 53)
 *   6. channel2_001.ssd (sub_5D3E91 / sub_5D3D3F, S->C 10)
 *   7. fxdynmapinfo.ssd (sub_4E0131 / sub_4DFE20, S->C 207 -> C->S 282 -> S->C 205)
 *   8. esfn.ssd         (sub_5CA65A / sub_5CA523, C->S 86/93 -> S->C 113)
 *   9. fxstock.ini      (sub_4B95B0 / sub_593FF6 / sub_588ED2, S->C 16/208 -> C->S 276 -> S->C 193)
 *  10. stringtable.ini  (sub_4B95F7 / sub_594136, S->C 16/208 -> C->S 278 -> S->C 200)
 *  11. packagemap.ini   (sub_4B966A / sub_59426D / sub_5886A9, S->C 16/208 -> C->S 281 -> S->C 210)
 *  12. qmarksfn.ssd     (sub_5B988A / sub_5B9743, S->C 16/208)
 */

export interface IdxEntry {
  index: number;
  offset: number;
  size: number;
  maskId: number;
  crc32: number;
  compressedLength: number;
  isCompressed: boolean;
  path: string;
}

export interface BomberAttr {
  id: number;
  name: string;
  bombStart: number;
  bombMax: number;
  powerStart: number;
  powerMax: number;
  speedStart: number;
  speedMax: number;
}

export interface ItemAttr {
  id: number;
  name: string;
  codeName: string;
}

export interface MapGroupEntry {
  groupId: number;
  groupName: string;
  mapNames: string[];
}

export interface ObjectTableEntry {
  name: string;
  offset: number;
}

export interface TileInfoEntry {
  name: string;
  data: string;
}

export interface MapInfo {
  mapId: number;
  name: string; // e.g. "Map/vet01"
  shortName: string; // e.g. "vet01"
  folderName: string; // e.g. "vet01"
  version: number; // e.g. 1000 (`*v4` in `CGameMapInfoList::sub_4E8597`)
  theme: number; // `v46` in `CGameMapInfoList::sub_4E8597`
  maxPlayers: number; // `n8` in `CGameMapInfoList::sub_4E8597`
  width: number; // `n1000_2` in `CGameMapInfoList::sub_4E8597`
  height: number; // `v11` in `CGameMapInfoList::sub_4E8597`
  crc32: number; // `CCRC32::sub_668E80(0, mapData, mapSize)` stored at `CGameMap + 24` (`sub_4E5845`)
  crc8: number; // Client field name; `(CCRC32::sub_668E80(0, mapData, mapSize) & 0xff)` stored at `CGameMap + 24`
  byteSize: number;
}

export interface SsdCacheEntry {
  filename: string;
  rawBytes: Uint8Array;
  streamContainer: Uint8Array;
  uncompressedBytes: Uint8Array;
  decompressed: Uint8Array;
  adler32Zero: number; // sub_6984B0 body checksum of the current streamContainer, after any schema upgrade.
  diskAdler32Zero: number; // Original stream-body checksum before v22 normalization; not the outer ssi1 checksum.
  rawCrc32: number;
  uncompressedCrc32: number;
  crc32: number;
  entryCount: number;
}

export type SsdFileCollection = Map<string, SsdCacheEntry> & {
  fxdynimginfo: SsdCacheEntry;
  csysstr: SsdCacheEntry;
  multisvr: SsdCacheEntry;
  multisvrn: SsdCacheEntry;
  esfn: SsdCacheEntry;
  filterstr: SsdCacheEntry;
  fxdynmapinfo: SsdCacheEntry;
  fxstock: SsdCacheEntry;
  stringtable: SsdCacheEntry;
  packagemap: SsdCacheEntry;
  channel2: SsdCacheEntry;
  qmarksfn: SsdCacheEntry;
};

export interface ClientResources {
  fxEntries: IdxEntry[];
  charTeEntries: IdxEntry[];
  emoTeEntries: IdxEntry[];
  maps: MapInfo[];
  mapList: MapInfo[];
  mapsById: Map<number, MapInfo>;
  mapsByName: Map<string, MapInfo>;
  mapGroups: MapGroupEntry[];
  bombers: BomberAttr[];
  bomberAttrs: BomberAttr[];
  items: ItemAttr[];
  itemAttrs: ItemAttr[];
  fxObjectTable: ObjectTableEntry[];
  charTeObjectTable: ObjectTableEntry[];
  emoTeObjectTable: ObjectTableEntry[];
  tileInfos: TileInfoEntry[];
  initXml: string;
  ssdFiles: SsdFileCollection;
}

export type LoadedResources = ClientResources;

/**
 * CPackSysMan::sub_673110 (0x00673110):
 * Decrypts an .idx file with initial key (0x719CAB30 for Fx.idx, 0x05B201FC for CharTE/EmoTE.idx).
 */
export function decryptIdxBuffer(src: Uint8Array, initialKey: number = 0x719cab30): Uint8Array {
  const len = src.length;
  const dst = new Uint8Array(len);
  const sdv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const ddv = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);

  const wordCount = len >>> 2;
  let lastWord = initialKey >>> 0;
  if (wordCount > 0) {
    ddv.setUint32(0, (initialKey ^ sdv.getUint32(0, true)) >>> 0, true);
    for (let i = 1; i < wordCount; i++) {
      const prev = ddv.getUint32((i - 1) * 4, true);
      const cur = sdv.getUint32(i * 4, true);
      ddv.setUint32(i * 4, (prev ^ cur) >>> 0, true);
    }
    lastWord = ddv.getUint32((wordCount - 1) * 4, true);
  }

  const tailBytes = len & 3;
  for (let b = 0; b < tailBytes; b++) {
    dst[wordCount * 4 + b] =
      (src[wordCount * 4 + b]! ^ ((lastWord >>> (8 * b)) & 0xff)) & 0xff;
  }

  return dst;
}

/**
 * CPackSysMan::sub_6731A0 (0x006731A0) + CData::sub_674590 (0x00674590):
 * Decrypts an entry payload from .idd using its MaskId and verifies its CRC32 against expectedCrc.
 */
export function decryptIddEntry(
  src: Uint8Array,
  maskId: number,
  expectedCrc: number = 0
): Uint8Array {
  if (maskId === 0) {
    return src.slice();
  }
  const len = src.length;
  const dst = new Uint8Array(len);
  const sdv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const ddv = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);

  const v4 = len >>> 2;
  const v6 = len & 3;
  let lastWord = maskId >>> 0;

  if (v4 > 0) {
    ddv.setUint32(0, (maskId ^ sdv.getUint32(0, true) ^ 0x9c6c95ce) >>> 0, true);
    for (let v8 = 1; v8 < v4; v8++) {
      const p1 = Math.imul(v8, v8);
      const p2 = Math.imul(p1, v8 + 966);
      const poly = Math.imul(p2, v8 + 2020) >>> 0;
      const v10 = (sdv.getUint32(v8 * 4, true) ^ poly) >>> 0;
      const v11 = (ddv.getUint32((v8 - 1) * 4, true) ^ v10) >>> 0;
      ddv.setUint32(v8 * 4, (v11 ^ 0x9c6c95ce) >>> 0, true);
    }
    lastWord = ddv.getUint32((v4 - 1) * 4, true);
  }

  for (let b = 0; b < v6; b++) {
    dst[v4 * 4 + b] = (src[v4 * 4 + b]! ^ ((lastWord >>> (8 * b)) & 0xff)) & 0xff;
  }

  if (expectedCrc !== 0 && expectedCrc !== 1) {
    const actualCrc = computeCRC32(maskId >>> 0, dst, len);
    if (actualCrc !== (expectedCrc >>> 0)) {
      throw new Error(
        `CData::sub_674590 CRC32 mismatch: expected 0x${(expectedCrc >>> 0).toString(16)}, got 0x${actualCrc.toString(16)}`
      );
    }
  }

  return dst;
}

export function decryptPackEntry(src: Uint8Array, _isCompressed: boolean = false): Uint8Array {
  return decryptIdxBuffer(src, 0x719cab30);
}

/**
 * CPackSysMan::sub_6749C0 (0x006749C0):
 * Parses decrypted `.idx` records in either legacy `[u32 count, ...]` form
 * (`nameLen + path + [offset, size, maskId]`) or CRC-bearing `[0, 15, u32 count, ...]`
 * form (`nameLen + path + [offset, size, maskId, crc32]`).
 */
export function parseDecryptedIdx(plainIdx: Uint8Array): IdxEntry[] {
  if (plainIdx.byteLength < 8) {
    throw new Error(`Invalid .idx header: expected at least 8 bytes, got ${plainIdx.byteLength}`);
  }

  const dv = new DataView(plainIdx.buffer, plainIdx.byteOffset, plainIdx.byteLength);
  const w0 = dv.getUint32(0, true);
  const w1 = dv.getUint32(4, true);

  let entryCount: number;
  let pos: number;
  let hasCrc: boolean;

  if (w0 !== 0) {
    entryCount = w0;
    pos = 4;
    hasCrc = false;
  } else if (w1 === 15) {
    if (plainIdx.byteLength < 12) {
      throw new Error(`Invalid .idx header: CRC format requires 12 bytes, got ${plainIdx.byteLength}`);
    }
    entryCount = dv.getUint32(8, true);
    pos = 12;
    hasCrc = true;
  } else {
    throw new Error(`Invalid .idx header: w0=${w0}, w1=${w1}`);
  }

  const fixedRecordBytes = hasCrc ? 16 : 12;
  const minimumRecordBytes = 4 + 1 + fixedRecordBytes; // name length + at least one path byte + fields
  const maximumPossibleCount = Math.floor((plainIdx.byteLength - pos) / minimumRecordBytes);
  if (entryCount > maximumPossibleCount) {
    throw new Error(
      `Invalid .idx entry count ${entryCount}: buffer can contain at most ${maximumPossibleCount} ${hasCrc ? "CRC" : "legacy"} record(s)`
    );
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: IdxEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (pos + 4 > plainIdx.byteLength) {
      throw new Error(`Truncated .idx entry ${i}: missing path length at byte ${pos}`);
    }

    const nameLen = dv.getUint32(pos, true);
    const pathStart = pos + 4;
    if (nameLen <= 0 || nameLen >= 0x80) {
      throw new Error(`Invalid .idx entry nameLen=${nameLen} at entry ${i}`);
    }

    const recordEnd = pathStart + nameLen + fixedRecordBytes;
    if (recordEnd > plainIdx.byteLength) {
      throw new Error(
        `Truncated .idx entry ${i}: nameLen=${nameLen} requires ${fixedRecordBytes} fixed byte(s), buffer ends at ${plainIdx.byteLength}`
      );
    }

    const rawPath = decoder.decode(plainIdx.subarray(pathStart, pathStart + nameLen));
    const path = rawPath.replace(/\\/g, "/");

    const iddOffset = dv.getUint32(pathStart + nameLen, true);
    const sizeOffset = pathStart + nameLen + 4;
    const size = dv.getUint32(sizeOffset, true);
    const maskId = dv.getUint32(sizeOffset + 4, true);
    const crc32 = hasCrc ? dv.getUint32(sizeOffset + 8, true) : 0;
    pos = sizeOffset + (hasCrc ? 12 : 8);

    entries.push({
      index: i,
      offset: iddOffset,
      size,
      maskId,
      crc32,
      compressedLength: size,
      isCompressed: maskId !== 0,
      path,
    });
  }

  return entries;
}

/** Rejects corrupt `.idx` ranges before entry bytes are read. */
function assertIdxEntryFitsArchive(
  entry: IdxEntry,
  archiveName: string,
  archiveSize: number
): void {
  if (entry.offset > archiveSize || entry.size > archiveSize - entry.offset) {
    throw new Error(
      `${archiveName} entry ${entry.index} (${entry.path}) range [${entry.offset}, ${entry.offset + entry.size}) exceeds the ${archiveSize}-byte archive`
    );
  }
}

function assertIdxEntriesFitArchive(
  entries: readonly IdxEntry[],
  archiveName: string,
  archiveSize: number
): void {
  for (const entry of entries) {
    assertIdxEntryFitsArchive(entry, archiveName, archiveSize);
  }
}

/** Bounds-checks and fully reads an `.idd` slice, retrying if `readSync` returns a short read. */
function readIddEntry(
  fd: number,
  archiveName: string,
  archiveSize: number,
  entry: IdxEntry
): Uint8Array {
  assertIdxEntryFitsArchive(entry, archiveName, archiveSize);

  const bytes = new Uint8Array(entry.size);
  let bytesRead = 0;
  while (bytesRead < bytes.byteLength) {
    const count = readSync(
      fd,
      bytes,
      bytesRead,
      bytes.byteLength - bytesRead,
      entry.offset + bytesRead
    );
    if (count === 0) {
      throw new Error(
        `Unexpected end of ${archiveName} while reading entry ${entry.index} (${entry.path}) at byte ${entry.offset + bytesRead}`
      );
    }
    bytesRead += count;
  }
  return bytes;
}

/**
 * CBomberAttrMan::sub_4EC1FD (0x004EC1FD):
 * Parses decrypted Attr/BomberAttr binary buffer.
 */
export function parseBomberAttrBuffer(plain: Uint8Array): BomberAttr[] {
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const bombers: BomberAttr[] = [];

  let pos = 0;
  let id = 0;
  while (pos + 4 <= plain.length) {
    const nameLen = dv.getUint32(pos, true);
    pos += 4;
    if (nameLen < 1 || nameLen > 0x35 || pos + nameLen + 40 > plain.length) {
      break;
    }
    const name = decoder.decode(plain.subarray(pos, pos + nameLen));
    pos += nameLen;

    dv.getUint32(pos, true); // Opaque record field; the server's BomberAttr model does not use it.
    const speedStart = dv.getUint32(pos + 4, true);
    const speedMax = dv.getUint32(pos + 8, true);
    const bombStart = dv.getUint32(pos + 12, true);
    const bombMax = Math.min(10, dv.getUint32(pos + 16, true));
    const powerStart = dv.getUint32(pos + 20, true);
    const powerMax = dv.getUint32(pos + 24, true);
    pos += 40; // 10 x u32

    bombers.push({
      id: id++,
      name,
      bombStart,
      bombMax,
      powerStart,
      powerMax,
      speedStart,
      speedMax,
    });
  }

  return bombers;
}

/**
 * CItemAttrMan::sub_4EF2BD (0x004EF2BD):
 * Parses decrypted Attr/ItemAttr binary buffer.
 */
export function parseItemAttrBuffer(plain: Uint8Array): ItemAttr[] {
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const items: ItemAttr[] = [];

  if (plain.length < 12) {
    return items;
  }

  const shipCount = dv.getUint32(8, true);
  let pos = 12;

  for (let s = 0; s < shipCount && pos + 8 <= plain.length; s++) {
    dv.getUint32(pos, true); // Ship identifier is outside the server's ItemAttr lookup model.
    const nameLen = dv.getUint32(pos + 4, true);
    pos += 8 + nameLen + 32;
  }

  let itemId = 0;
  while (pos + 4 <= plain.length) {
    const codeLen = dv.getUint32(pos, true);
    pos += 4;
    if (codeLen <= 0 || codeLen >= 64 || pos + codeLen + 4 > plain.length) {
      break;
    }
    const codeName = decoder.decode(plain.subarray(pos, pos + codeLen));
    pos += codeLen;

    const nameLen = dv.getUint32(pos, true);
    pos += 4;
    if (nameLen <= 0 || nameLen >= 64 || pos + nameLen + 32 > plain.length) {
      break;
    }
    const name = decoder.decode(plain.subarray(pos, pos + nameLen));
    pos += nameLen + 32;

    items.push({
      id: itemId++,
      codeName,
      name,
    });
  }

  return items;
}

/**
 * CMapGroup (`Attr/MapGroup` in `Fx.idd`):
 *   u32 LE groupCount
 *   For each group:
 *     u32 LE groupNameLen + char[groupNameLen]
 *     u32 LE mapCount
 *     mapCount * (u32 LE mapNameLen + char[mapNameLen])
 */
export function parseMapGroupBuffer(plain: Uint8Array): MapGroupEntry[] {
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const groups: MapGroupEntry[] = [];

  if (plain.length < 4) {
    return groups;
  }

  let pos = 0;
  const groupCount = dv.getUint32(pos, true);
  pos += 4;

  for (let g = 0; g < groupCount && pos + 4 <= plain.length; g++) {
    const nameLen = dv.getUint32(pos, true);
    pos += 4;
    if (pos + nameLen + 4 > plain.length) {
      break;
    }
    const groupName = decoder.decode(plain.subarray(pos, pos + nameLen));
    pos += nameLen;

    const mapCount = dv.getUint32(pos, true);
    pos += 4;
    const mapNames: string[] = [];
    for (let m = 0; m < mapCount && pos + 4 <= plain.length; m++) {
      const mLen = dv.getUint32(pos, true);
      pos += 4;
      if (pos + mLen > plain.length) {
        break;
      }
      mapNames.push(decoder.decode(plain.subarray(pos, pos + mLen)));
      pos += mLen;
    }
    groups.push({
      groupId: g,
      groupName,
      mapNames,
    });
  }

  return groups;
}

/**
 * CGameObjectTemplateLib::sub_462364 (0x00462364):
 * Parses decrypted `ObjectTable/ObjectTable`, `ObjectTable/CharTEObjectTable`,
 * and `ObjectTable/EmoTEObjectTable` binary tables.
 */
export function parseObjectTableBuffer(plain: Uint8Array): ObjectTableEntry[] {
  if (plain.length < 4) {
    return [];
  }
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const count = dv.getUint32(0, true);
  let pos = 4;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ObjectTableEntry[] = [];

  for (let i = 0; i < count && pos + 8 <= plain.length; i++) {
    const nameLen = dv.getUint32(pos, true);
    pos += 4;
    if (nameLen >= 0x80 || pos + nameLen + 4 > plain.length) {
      break;
    }
    const name = decoder.decode(plain.subarray(pos, pos + nameLen));
    pos += nameLen;
    const offset = dv.getUint32(pos, true);
    pos += 4;
    entries.push({ name, offset });
  }

  return entries;
}

/**
 * CMapObjToTileInfo::sub_5C7B73 / sub_5C7AC3 (0x005C7AC3):
 * Parses `TileInfo/TileInfoList` XML payload (`[u32 LE xmlSize, xmlBytes]`).
 */
export function parseTileInfoListBuffer(plain: Uint8Array): TileInfoEntry[] {
  if (plain.length < 4) {
    return [];
  }
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const xmlLen = Math.min(dv.getUint32(0, true), plain.length - 4);
  const xmlText = new TextDecoder("utf-8", { fatal: false }).decode(plain.subarray(4, 4 + xmlLen));
  const tiles: TileInfoEntry[] = [];
  const tagRegex = /<Tile\s+Name="([^"]+)"\s+Data="([^"]*)"/g;
  for (const match of xmlText.matchAll(tagRegex)) {
    tiles.push({
      name: match[1]!,
      data: match[2]!,
    });
  }
  return tiles;
}

type SsdLayoutVersion = "pre-v22" | "v22";

function readLengthPrefixedBytes(
  reader: SmartStreamReader,
  filename: string,
  version: SsdLayoutVersion
): void {
  const length = reader.readU32();
  if (length > reader.remaining()) {
    throw new RangeError(
      `${filename} ${version} string length ${length} exceeds ${reader.remaining()} remaining byte(s)`
    );
  }
  reader.readBytes(length);
}

function finishSsdLayout(
  reader: SmartStreamReader,
  filename: string,
  version: SsdLayoutVersion,
  entryCount: number
): { entryCount: number; remaining: number } {
  const remaining = reader.remaining();
  if (remaining !== 0) {
    throw new Error(`${filename} ${version} payload has ${remaining} trailing byte(s)`);
  }
  return { entryCount, remaining };
}

function verifyDynamicMapInfoLayout(
  rawBody: Uint8Array,
  version: SsdLayoutVersion
): { entryCount: number; remaining: number } {
  const reader = new SmartStreamReader(rawBody);
  const count = reader.readU16();

  for (let i = 0; i < count; i++) {
    reader.readU32(); // v20
    reader.readU8(); // v21
    readLengthPrefixedBytes(reader, "fxdynmapinfo.ssd", version); // v15
    readLengthPrefixedBytes(reader, "fxdynmapinfo.ssd", version); // v12
    reader.readU8(); // v24
    reader.readU8(); // v25
    readLengthPrefixedBytes(reader, "fxdynmapinfo.ssd", version); // v13
    readLengthPrefixedBytes(reader, "fxdynmapinfo.ssd", version); // v14
    reader.readU8(); // v28
    reader.readU8(); // v29
    reader.readU32(); // n0xFF
    reader.readU8(); // v31
    reader.readU8(); // v32
    reader.readU8(); // v33
    reader.readU32(); // v34
    reader.readU8(); // v35
    if (version === "pre-v22") {
      reader.readU16(); // v36 before widening
    } else {
      reader.readU32(); // v36 in CA.exe v22
    }
  }

  return finishSsdLayout(reader, "fxdynmapinfo.ssd", version, count);
}

function verifyFxStockLayout(
  rawBody: Uint8Array,
  version: SsdLayoutVersion
): { entryCount: number; remaining: number } {
  const reader = new SmartStreamReader(rawBody);
  const count = reader.readU16();

  for (let i = 0; i < count; i++) {
    reader.readU32(); // +8
    reader.readU8(); // +20
    readLengthPrefixedBytes(reader, "fxstock.ini", version); // +32 string
    reader.readU16(); // +80
    reader.readU16(); // +92
    reader.readU32(); // +104
    reader.readU32(); // +116
    readLengthPrefixedBytes(reader, "fxstock.ini", version); // +128 string
    reader.readU32(); // +152
    reader.readU32(); // +164
    reader.readU16(); // +176
    reader.readU8(); // +188
    reader.readU16(); // +200
    reader.readU16(); // +212
    reader.readU16(); // +224
    reader.readU32(); // +236
    reader.readU8(); // +248
    reader.readU8(); // +260
    reader.readU32(); // +272
    if (version === "pre-v22") {
      reader.readU8(); // +284 before widening
    } else {
      reader.readU16(); // +284 in CA.exe v22
    }
    reader.readU32(); // +296
  }

  return finishSsdLayout(reader, "fxstock.ini", version, count);
}

/**
 * Upgrades pre-v22 disk `fxstock.ini` (where field +284 at `tail[27]` was `u8`, 32B tail)
 * to `CA.exe` v22 (`sub_588ED2` at `0x0058909D`, where field +284 is `u16`, 33B tail).
 */
export function transcodeFxStockToV22(rawBody: Uint8Array): {
  writer: SmartStreamWriter;
  entryCount: number;
} {
  const { entryCount: count } = verifyFxStockLayout(rawBody, "pre-v22");
  const r = new SmartStreamReader(rawBody);
  r.readU16();
  const w = new SmartStreamWriter();
  w.writeU16(count);

  for (let i = 0; i < count; i++) {
    w.writeU32(r.readU32()); // +8
    w.writeU8(r.readU8()); // +20
    const nameLen = r.readU32();
    w.writeU32(nameLen);
    w.writeBytes(r.readBytes(nameLen)); // +32 (preserve raw Big5 bytes)
    w.writeU16(r.readU16()); // +80
    w.writeU16(r.readU16()); // +92
    w.writeU32(r.readU32()); // +104
    w.writeU32(r.readU32()); // +116
    const pathLen = r.readU32();
    w.writeU32(pathLen);
    w.writeBytes(r.readBytes(pathLen)); // +128
    const tail32 = r.readBytes(32);
    // Bytes 0..26 = [+152 u32, +164 u32, +176 u16, +188 u8, +200 u16, +212 u16, +224 u16, +236 u32, +248 u8, +260 u8, +272 u32]
    w.writeBytes(tail32.subarray(0, 27));
    // Byte 27 in pre-v22 was u8 -> widened to u16 in v22 (`sub_4A5F5C(this + 284, sub_6995F0(i))` at `0x0058909D`)
    w.writeU16(tail32[27]!);
    // Bytes 28..31 = [+296 u32]
    w.writeBytes(tail32.subarray(28, 32));
  }

  const upgradedPayload = w.toRawPayload();
  verifyFxStockLayout(upgradedPayload, "v22");
  return { writer: w, entryCount: count };
}

/**
 * Upgrades pre-v22 disk `fxdynmapinfo.ssd` (where final field `v36` at `tail[14..15]` was `u16`, 16B tail)
 * to `CA.exe` v22 (`sub_4DFE20` at `0x004E0024`, where `v36` is `u32`, 18B tail).
 */
export function transcodeDynamicMapInfoToV22(rawBody: Uint8Array): {
  writer: SmartStreamWriter;
  entryCount: number;
} {
  const { entryCount: count } = verifyDynamicMapInfoLayout(rawBody, "pre-v22");
  const r = new SmartStreamReader(rawBody);
  r.readU16();
  const w = new SmartStreamWriter();
  w.writeU16(count);

  for (let i = 0; i < count; i++) {
    w.writeU32(r.readU32()); // v20
    w.writeU8(r.readU8()); // v21
    for (let s = 0; s < 2; s++) {
      const len = r.readU32();
      w.writeU32(len);
      w.writeBytes(r.readBytes(len));
    }
    w.writeU8(r.readU8()); // v24
    w.writeU8(r.readU8()); // v25
    for (let s = 0; s < 2; s++) {
      const len = r.readU32();
      w.writeU32(len);
      w.writeBytes(r.readBytes(len));
    }
    const tail16 = r.readBytes(16);
    // Bytes 0..13 = [v28 u8, v29 u8, n0xFF u32, v31 u8, v32 u8, v33 u8, v34 u32, v35 u8]
    w.writeBytes(tail16.subarray(0, 14));
    // Bytes 14..15 in pre-v22 was u16 -> widened to u32 in v22 (`v36 = sub_699610(a2)` at `0x004E0024`)
    const v36 = tail16[14]! | (tail16[15]! << 8);
    w.writeU32(v36);
  }

  const upgradedPayload = w.toRawPayload();
  verifyDynamicMapInfoLayout(upgradedPayload, "v22");
  return { writer: w, entryCount: count };
}

/**
 * Upgrades pre-v22 disk `esfn.ssd` (25 bytes with two extra `0xFFFF` `u16` fields)
 * to `CA.exe` v22 (`sub_5CA523` at `0x005CA523`: `[u8 c1, (str key, u16 flag, str desc)*, u8 c2, (u16[4])*]`).
 */
export function transcodeEsfnToV22(rawBody: Uint8Array): {
  writer: SmartStreamWriter;
  entryCount: number;
} {
  const r = new SmartStreamReader(rawBody);
  const c1 = r.readU8();
  const w = new SmartStreamWriter();
  w.writeU8(c1);

  for (let i = 0; i < c1; i++) {
    const keyLen = r.readU32();
    w.writeU32(keyLen);
    w.writeBytes(r.readBytes(keyLen));
    const flag = r.readU16();
    w.writeU16(flag);
    // Skip legacy 0xFFFF u16 if present before the second string
    if (r.remaining() >= 6) {
      const peek = r.readU16();
      if (peek !== 0xffff) {
        r.offset -= 2;
      }
    }
    const descLen = r.readU32();
    w.writeU32(descLen);
    w.writeBytes(r.readBytes(descLen));
    if (r.remaining() >= 3) {
      const peek = r.readU16();
      if (peek !== 0xffff) {
        r.offset -= 2;
      }
    }
  }

  const c2 = r.remaining() >= 1 ? r.readU8() : 0;
  w.writeU8(c2);
  for (let i = 0; i < c2 && r.remaining() >= 8; i++) {
    w.writeU16(r.readU16());
    w.writeU16(r.readU16());
    w.writeU16(r.readU16());
    w.writeU16(r.readU16());
  }

  return { writer: w, entryCount: c1 + c2 };
}

/**
 * Synthesizes `multisvr.ssd` (`CMultiServer::sub_5D782C` at `0x005D782C`):
 *   u8 worldCount
 *   For each world:
 *     str worldId
 *     str worldName
 *     u32 LE worldAttr
 *   u16 LE serverEndpointCount
 *   For each server endpoint:
 *     u32 LE ipv4InAddr (e.g. 0x0100007F for 127.0.0.1)
 *     u16 LE port (e.g. 3838)
 *     u8 worldIdx
 *   u8 defaultWorldIdx
 */
export function buildMultiSvrSmartStream(
  publicIp: string = "127.0.0.1",
  tcpPort: number = 3838
): SmartStreamWriter {
  const inAddrLe = ipv4ToInAddrLittleEndian(publicIp);

  const w = new SmartStreamWriter();
  w.writeU8(1); // worldCount = 1
  w.writeString("tw_world_01");
  w.writeString("爆爆王台灣伺服器");
  w.writeU32(1); // worldAttr
  w.writeU16(1); // serverEndpointCount = 1
  w.writeU32(inAddrLe);
  w.writeU16(tcpPort & 0xffff);
  w.writeU8(0); // worldIdx = 0
  w.writeU8(0); // defaultWorldIdx = 0
  return w;
}

/**
 * Synthesizes `multisvrn.ssd` (`CMultiServer::sub_5D79AE` at `0x005D79AE`):
 *   u8 entryCount
 *   For each entry:
 *     u8 groupType (0 = primary, 1 = secondary)
 *     str serverName
 *     str serverAddress
 */
export function buildMultiSvrNSmartStream(
  publicIp: string = "127.0.0.1",
  tcpPort: number = 3838
): SmartStreamWriter {
  const w = new SmartStreamWriter();
  w.writeU8(1); // entryCount = 1
  w.writeU8(0); // groupType = 0
  w.writeString("爆爆王台灣伺服器");
  w.writeString(`${publicIp}:${tcpPort}`);
  return w;
}

/**
 * Synthesizes `channel2_001.ssd` (`CChannelCache::sub_5D3D3F` at `0x005D3D3F`).
 * The shared record writer documents the exact ten fields and CP950 string encoding.
 */
export function buildChannelCacheSmartStream(
  channels: ReadonlyArray<CChannelCacheRecord> = DEFAULT_C_CHANNELS
): SmartStreamWriter {
  const stream = new SmartStreamWriter();
  writeCChannelCache(stream, channels);
  return stream;
}

/**
 * Synthesizes `qmarksfn.ssd` (`CQuestionMarkCouponMan::sub_5B9743` at `0x005B9743`):
 *   u16 LE count1
 *   count1 * [u16 LE f0, u8 f1, u32 LE f2, u32 LE f3, u16 LE f4]
 *   u16 LE count2
 *   count2 * [str name, u32 LE val]
 */
export function buildQMarkSmartStream(): SmartStreamWriter {
  const w = new SmartStreamWriter();
  w.writeU16(1); // count1 = 1
  w.writeU16(1); // f0
  w.writeU8(1); // f1
  w.writeU32(100); // f2
  w.writeU32(1); // f3
  w.writeU16(0); // f4
  w.writeU16(1); // count2 = 1
  w.writeString("QMarkDefault");
  w.writeU32(1);
  return w;
}

/**
 * Validates any of the 12 `.ssd` / `.ini` uncompressed payloads using the exact
 * `CA.exe` v22 `CISmartStream` parser logic (`sub_49DF97`, `sub_5CFE6C`, `sub_5C89D7`,
 * `sub_5D782C`, `sub_5D79AE`, `sub_5D3D3F`, `sub_4DFE20`, `sub_5CA523`, `sub_5B9743`,
 * `sub_593FF6`/`sub_588ED2`, `sub_594136`, `sub_59426D`/`sub_5886A9`).
 */
export function verifySmartStreamSchema(
  filename: string,
  uncompressedPayload: Uint8Array
): { entryCount: number; remaining: number } {
  const s = new SmartStreamReader(uncompressedPayload);
  const skipStr = () => {
    const len = s.readU32();
    s.readBytes(len);
  };

  switch (filename) {
    case "fxdynimginfo.ssd": {
      // sub_49DF97 (0x0049DF97)
      const count = s.readU16();
      for (let i = 0; i < count; i++) {
        s.readU8();
        skipStr();
        s.readU8();
      }
      return { entryCount: count, remaining: s.remaining() };
    }
    case "csysstr.ssd": {
      // sub_5CFE6C (0x005CFE6C)
      const count = s.readU16();
      for (let i = 0; i < count; i++) {
        skipStr();
        skipStr();
      }
      return { entryCount: count, remaining: s.remaining() };
    }
    case "filterstr.ssd": {
      // sub_5C89D7 (0x005C89D7)
      const count = s.readU16();
      for (let i = 0; i < count; i++) {
        s.readU8();
        skipStr();
        skipStr();
      }
      return { entryCount: count, remaining: s.remaining() };
    }
    case "multisvr.ssd": {
      // sub_5D782C (0x005D782C)
      const worldCount = s.readU8();
      for (let i = 0; i < worldCount; i++) {
        skipStr();
        skipStr();
        s.readU32();
      }
      const serverCount = s.readU16();
      for (let j = 0; j < serverCount; j++) {
        s.readU32();
        s.readU16();
        s.readU8();
      }
      s.readU8(); // defaultWorldIdx
      return { entryCount: worldCount + serverCount, remaining: s.remaining() };
    }
    case "multisvrn.ssd": {
      // sub_5D79AE (0x005D79AE)
      const count = s.readU8();
      for (let i = 0; i < count; i++) {
        s.readU8();
        skipStr();
        skipStr();
      }
      return { entryCount: count, remaining: s.remaining() };
    }
    case "channel2_001.ssd": {
      // sub_5D3D3F (0x005D3D3F)
      const count = s.readU16();
      for (let i = 0; i < count; i++) {
        skipStr();
        s.readU16();
        s.readU8();
        s.readU8();
        s.readU16();
        s.readU8();
        s.readU8();
        s.readU8();
        s.readU8();
        s.readU16();
        s.readU16();
      }
      return { entryCount: count, remaining: s.remaining() };
    }
    case "fxdynmapinfo.ssd": {
      // sub_4DFE20 (0x004DFE20), CA.exe v22 field v36 is u32.
      return verifyDynamicMapInfoLayout(uncompressedPayload, "v22");
    }
    case "esfn.ssd": {
      // sub_5CA523 (0x005CA523)
      const c1 = s.readU8();
      for (let i = 0; i < c1; i++) {
        skipStr();
        s.readU16();
        skipStr();
      }
      const c2 = s.readU8();
      for (let i = 0; i < c2; i++) {
        s.readU16();
        s.readU16();
        s.readU16();
        s.readU16();
      }
      return { entryCount: c1 + c2, remaining: s.remaining() };
    }
    case "stringtable.ini": {
      // sub_594136 (0x00594136)
      const count = s.readU16();
      for (let i = 0; i < count; i++) {
        s.readU32();
        skipStr();
      }
      return { entryCount: count, remaining: s.remaining() };
    }
    case "packagemap.ini": {
      // sub_59426D + sub_5886A9 (0x005886A9)
      const count = s.readU16();
      for (let i = 0; i < count; i++) {
        s.readU32();
        s.readU32();
        s.readU32();
        s.readU32();
      }
      return { entryCount: count, remaining: s.remaining() };
    }
    case "fxstock.ini": {
      // sub_593FF6 + sub_588ED2 (0x00588ED2), CA.exe v22 field +284 is u16.
      return verifyFxStockLayout(uncompressedPayload, "v22");
    }
    case "qmarksfn.ssd": {
      // sub_5B9743 (0x005B9743)
      const c1 = s.readU16();
      for (let i = 0; i < c1; i++) {
        s.readU16();
        s.readU8();
        s.readU32();
        s.readU32();
        s.readU16();
      }
      const c2 = s.readU16();
      for (let i = 0; i < c2; i++) {
        skipStr();
        s.readU32();
      }
      return { entryCount: c1 + c2, remaining: s.remaining() };
    }
    default:
      return { entryCount: 0, remaining: 0 };
  }
}

interface VersionedPayloadResult {
  uncompressedBytes: Uint8Array;
  entryCount: number;
  transcodedWriter?: SmartStreamWriter;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeV22Payload(
  filename: string,
  rawBody: Uint8Array,
  verifyV22: (payload: Uint8Array) => { entryCount: number; remaining: number },
  verifyPreV22: (payload: Uint8Array) => { entryCount: number; remaining: number },
  transcode: (payload: Uint8Array) => { writer: SmartStreamWriter; entryCount: number }
): VersionedPayloadResult {
  let v22: { entryCount: number; remaining: number } | undefined;
  let preV22: { entryCount: number; remaining: number } | undefined;
  let v22Error = "unknown validation error";
  let preV22Error = "unknown validation error";

  try {
    v22 = verifyV22(rawBody);
  } catch (error) {
    v22Error = errorMessage(error);
  }

  try {
    preV22 = verifyPreV22(rawBody);
  } catch (error) {
    preV22Error = errorMessage(error);
  }

  if (v22 && preV22) {
    if (v22.entryCount === 0 && preV22.entryCount === 0) {
      // With zero records the two layouts are byte-for-byte identical; no widening is needed.
      return { uncompressedBytes: rawBody, entryCount: 0 };
    }
    throw new Error(`${filename} payload is ambiguous: it validates as both v22 and pre-v22`);
  }

  if (v22) {
    return { uncompressedBytes: rawBody, entryCount: v22.entryCount };
  }

  if (preV22) {
    const { writer, entryCount } = transcode(rawBody);
    const upgraded = writer.toRawPayload();
    const verifiedUpgrade = verifyV22(upgraded);
    if (verifiedUpgrade.entryCount !== entryCount) {
      throw new Error(
        `${filename} transcode entry-count mismatch: wrote ${entryCount}, validated ${verifiedUpgrade.entryCount}`
      );
    }
    return { uncompressedBytes: upgraded, entryCount, transcodedWriter: writer };
  }

  throw new Error(
    `Invalid ${filename} payload: matches neither the CA.exe v22 layout (${v22Error}) nor the pre-v22 layout (${preV22Error})`
  );
}

function buildSynthesizedSsdEntry(
  filename: string,
  writer: SmartStreamWriter,
  compress: boolean = true
): SsdCacheEntry {
  const rawBytes = writer.toSsi1Buffer(compress);
  const streamContainer = rawBytes.subarray(8);
  const uncompressedBytes = writer.toRawPayload();
  const adler32Zero = computeSmartStreamBodyChecksum(streamContainer);
  const rawCrc32 = computeCRC32(rawBytes.length, rawBytes, rawBytes.length);
  const uncompressedCrc32 = computeCRC32(
    uncompressedBytes.length,
    uncompressedBytes,
    uncompressedBytes.length
  );
  const { entryCount } = verifySmartStreamSchema(filename, uncompressedBytes);

  return {
    filename,
    rawBytes,
    streamContainer,
    uncompressedBytes,
    decompressed: uncompressedBytes,
    adler32Zero,
    diskAdler32Zero: adler32Zero,
    rawCrc32,
    uncompressedCrc32,
    crc32: adler32Zero || uncompressedCrc32,
    entryCount,
  };
}

export function loadSsdEntry(repoRoot: string, filename: string): SsdCacheEntry {
  const fullPath = resolve(repoRoot, filename);
  const rawBytes: Uint8Array = existsSync(fullPath)
    ? new Uint8Array(readFileSync(fullPath))
    : new Uint8Array(0);
  if (
    rawBytes.length === 0 &&
    (filename === "fxdynmapinfo.ssd" || filename === "fxstock.ini")
  ) {
    throw new Error(`${filename} is missing or empty; expected a versioned resource payload`);
  }

  let streamContainer: Uint8Array = rawBytes;
  let uncompressedBytes: Uint8Array = rawBytes;
  let diskAdler32Zero = 0;
  let hasSmartStreamContainer = false;

  const hasSsi1Magic =
    rawBytes.length >= 4 &&
    rawBytes[0] === 0x73 &&
    rawBytes[1] === 0x73 &&
    rawBytes[2] === 0x69 &&
    rawBytes[3] === 0x31;

  if (hasSsi1Magic) {
    const parsed = SmartStreamReader.fromSsi1Buffer(rawBytes);
    streamContainer = rawBytes.subarray(8);
    uncompressedBytes = new Uint8Array(parsed.reader.raw);
    diskAdler32Zero = parsed.checksum;
    hasSmartStreamContainer = true;
  } else if (
    rawBytes.length >= 6 &&
    rawBytes[0] === 0x18 &&
    (rawBytes[5] === 0 || rawBytes[5] === 1)
  ) {
    // Parse the complete declared COSmartStream container; do not hide malformed compression errors.
    const parsed = SmartStreamReader.fromSmartStreamBuffer(rawBytes);
    streamContainer = rawBytes;
    uncompressedBytes = new Uint8Array(parsed.raw);
    diskAdler32Zero = computeSmartStreamBodyChecksum(streamContainer);
    hasSmartStreamContainer = true;
  }

  let adler32Zero = diskAdler32Zero;
  let entryCount = 0;

  if (uncompressedBytes.length > 0 && filename === "fxdynmapinfo.ssd") {
    const normalized = normalizeV22Payload(
      filename,
      uncompressedBytes,
      (payload) => verifyDynamicMapInfoLayout(payload, "v22"),
      (payload) => verifyDynamicMapInfoLayout(payload, "pre-v22"),
      transcodeDynamicMapInfoToV22
    );
    uncompressedBytes = normalized.uncompressedBytes;
    entryCount = normalized.entryCount;
    if (normalized.transcodedWriter) {
      streamContainer = normalized.transcodedWriter.toSmartStreamBuffer(true);
      hasSmartStreamContainer = true;
    } else if (!hasSmartStreamContainer) {
      const writer = new SmartStreamWriter().writeRaw(uncompressedBytes);
      streamContainer = writer.toSmartStreamBuffer(true);
      hasSmartStreamContainer = true;
    }
    adler32Zero = computeSmartStreamBodyChecksum(streamContainer);
  } else if (uncompressedBytes.length > 0 && filename === "fxstock.ini") {
    const normalized = normalizeV22Payload(
      filename,
      uncompressedBytes,
      (payload) => verifyFxStockLayout(payload, "v22"),
      (payload) => verifyFxStockLayout(payload, "pre-v22"),
      transcodeFxStockToV22
    );
    uncompressedBytes = normalized.uncompressedBytes;
    entryCount = normalized.entryCount;
    if (normalized.transcodedWriter) {
      streamContainer = normalized.transcodedWriter.toSmartStreamBuffer(true);
      hasSmartStreamContainer = true;
    } else if (!hasSmartStreamContainer) {
      const writer = new SmartStreamWriter().writeRaw(uncompressedBytes);
      streamContainer = writer.toSmartStreamBuffer(true);
      hasSmartStreamContainer = true;
    }
    adler32Zero = computeSmartStreamBodyChecksum(streamContainer);
  } else if (
    uncompressedBytes.length > 0 &&
    filename === "esfn.ssd" &&
    uncompressedBytes.length === 25
  ) {
    const transcoded = transcodeEsfnToV22(uncompressedBytes);
    uncompressedBytes = transcoded.writer.toRawPayload();
    const verified = verifySmartStreamSchema(filename, uncompressedBytes);
    if (verified.remaining !== 0 || verified.entryCount !== transcoded.entryCount) {
      throw new Error(`Invalid esfn.ssd pre-v22 transcode: ${verified.remaining} trailing byte(s)`);
    }
    streamContainer = transcoded.writer.toSmartStreamBuffer(true);
    hasSmartStreamContainer = true;
    adler32Zero = computeSmartStreamBodyChecksum(streamContainer);
    entryCount = transcoded.entryCount;
  } else if (uncompressedBytes.length > 0) {
    const verified = verifySmartStreamSchema(filename, uncompressedBytes);
    entryCount = verified.entryCount;
    if (verified.remaining !== 0) {
      throw new Error(`${filename} payload has ${verified.remaining} trailing byte(s)`);
    }
    if (!hasSmartStreamContainer) {
      const writer = new SmartStreamWriter().writeRaw(uncompressedBytes);
      streamContainer = writer.toSmartStreamBuffer(true);
      adler32Zero = computeSmartStreamBodyChecksum(streamContainer);
    }
  }

  const rawCrc32 = computeCRC32(rawBytes.length, rawBytes, rawBytes.length);
  const uncompressedCrc32 = computeCRC32(
    uncompressedBytes.length,
    uncompressedBytes,
    uncompressedBytes.length
  );
  return {
    filename,
    rawBytes,
    streamContainer,
    uncompressedBytes,
    decompressed: uncompressedBytes,
    adler32Zero,
    diskAdler32Zero,
    rawCrc32,
    uncompressedCrc32,
    crc32: adler32Zero || uncompressedCrc32,
    entryCount,
  };
}

const cachedResourcesByRoot = new Map<string, ClientResources>();

export function loadClientResources(
  repoRoot: string = DEFAULT_CLIENT_RESOURCE_ROOT
): ClientResources {
  const resourceRoot = resolve(repoRoot);
  const cachedResources = cachedResourcesByRoot.get(resourceRoot);
  if (cachedResources) {
    return cachedResources;
  }

  const fxIdxPath = resolve(resourceRoot, "Fx.idx");
  const rawIdx = new Uint8Array(readFileSync(fxIdxPath));
  const plainIdx = decryptIdxBuffer(rawIdx, 0x719cab30);
  const fxEntries = parseDecryptedIdx(plainIdx);

  // sub_5A3257 (0x005A3257): CharTE.idx and EmoTE.idx use seed 0x05B201FC
  const charTeIdxPath = resolve(resourceRoot, "CharTE.idx");
  const charTeEntries = existsSync(charTeIdxPath)
    ? parseDecryptedIdx(decryptIdxBuffer(new Uint8Array(readFileSync(charTeIdxPath)), 0x05b201fc))
    : [];

  const emoTeIdxPath = resolve(resourceRoot, "EmoTE.idx");
  const emoTeEntries = existsSync(emoTeIdxPath)
    ? parseDecryptedIdx(decryptIdxBuffer(new Uint8Array(readFileSync(emoTeIdxPath)), 0x05b201fc))
    : [];

  const fxIddPath = resolve(resourceRoot, "Fx.idd");
  const iddFd = openSync(fxIddPath, "r");

  const maps: MapInfo[] = [];
  const mapsById = new Map<number, MapInfo>();
  const mapsByName = new Map<string, MapInfo>();
  let mapGroups: MapGroupEntry[] = [];
  let bombers: BomberAttr[] = [];
  let items: ItemAttr[] = [];
  let fxObjectTable: ObjectTableEntry[] = [];
  let charTeObjectTable: ObjectTableEntry[] = [];
  let emoTeObjectTable: ObjectTableEntry[] = [];
  let tileInfos: TileInfoEntry[] = [];
  let initXml = "";

  try {
    const fxIddSize = fstatSync(iddFd).size;
    assertIdxEntriesFitArchive(fxEntries, "Fx.idd", fxIddSize);

    for (const entry of fxEntries) {
      if (entry.path.startsWith("Map/")) {
        const mapId = maps.length;
        const shortName = entry.path.slice(4);
        const rawMap = readIddEntry(iddFd, "Fx.idd", fxIddSize, entry);
        const plainMap = decryptIddEntry(rawMap, entry.maskId, entry.crc32);
        const crc32 = computeCRC32(0, plainMap, plainMap.length);
        // The Client narrows the CRC32 result from sub_668E80 to one byte in CGameMap::sub_4E5845.
        const crc8 = crc32 & 0xff;

        let version = 1000;
        let maxPlayers = 8;
        let theme = 1;
        let width = 15;
        let height = 13;
        if (plainMap.length >= 8) {
          const mapDv = new DataView(plainMap.buffer, plainMap.byteOffset, plainMap.byteLength);
          const w0 = mapDv.getUint32(0, true);
          if (w0 < 1000) {
            version = 1000;
            maxPlayers = 8;
            theme = 1;
            width = w0;
            height = mapDv.getUint32(4, true);
          } else if (plainMap.length >= 20) {
            version = w0;
            maxPlayers = mapDv.getUint32(4, true);
            theme = mapDv.getUint32(8, true);
            width = mapDv.getUint32(12, true);
            height = mapDv.getUint32(16, true);
          }
        }

        const info: MapInfo = {
          mapId,
          name: entry.path,
          shortName,
          folderName: shortName,
          version,
          theme,
          maxPlayers,
          width,
          height,
          crc32,
          crc8,
          byteSize: plainMap.length,
        };
        maps.push(info);
        mapsById.set(mapId, info);
        mapsByName.set(entry.path.toLowerCase(), info);
        mapsByName.set(shortName.toLowerCase(), info);
      }
    }

    const bomberEntry = fxEntries.find((e) => e.path === "Attr/BomberAttr");
    if (bomberEntry) {
      const rawBomber = readIddEntry(iddFd, "Fx.idd", fxIddSize, bomberEntry);
      const plainBomber = decryptIddEntry(rawBomber, bomberEntry.maskId, bomberEntry.crc32);
      bombers = parseBomberAttrBuffer(plainBomber);
    }

    const itemEntry = fxEntries.find((e) => e.path === "Attr/ItemAttr");
    if (itemEntry) {
      const rawItem = readIddEntry(iddFd, "Fx.idd", fxIddSize, itemEntry);
      const plainItem = decryptIddEntry(rawItem, itemEntry.maskId, itemEntry.crc32);
      items = parseItemAttrBuffer(plainItem);
    }

    const mapGroupEntry = fxEntries.find((e) => e.path === "Attr/MapGroup");
    if (mapGroupEntry) {
      const rawMapGroup = readIddEntry(iddFd, "Fx.idd", fxIddSize, mapGroupEntry);
      const plainMapGroup = decryptIddEntry(
        rawMapGroup,
        mapGroupEntry.maskId,
        mapGroupEntry.crc32
      );
      mapGroups = parseMapGroupBuffer(plainMapGroup);
    }

    const objTableEntry = fxEntries.find((e) => e.path === "ObjectTable/ObjectTable");
    if (objTableEntry) {
      const rawObjTable = readIddEntry(iddFd, "Fx.idd", fxIddSize, objTableEntry);
      const plainObjTable = decryptIddEntry(
        rawObjTable,
        objTableEntry.maskId,
        objTableEntry.crc32
      );
      fxObjectTable = parseObjectTableBuffer(plainObjTable);
    }

    const tileInfoEntry = fxEntries.find((e) => e.path === "TileInfo/TileInfoList");
    if (tileInfoEntry) {
      const rawTileInfo = readIddEntry(iddFd, "Fx.idd", fxIddSize, tileInfoEntry);
      const plainTileInfo = decryptIddEntry(
        rawTileInfo,
        tileInfoEntry.maskId,
        tileInfoEntry.crc32
      );
      tileInfos = parseTileInfoListBuffer(plainTileInfo);
    }

    const xmlInitEntry = fxEntries.find((e) => e.path === "XML/init");
    if (xmlInitEntry) {
      const rawXml = readIddEntry(iddFd, "Fx.idd", fxIddSize, xmlInitEntry);
      const plainXml = decryptIddEntry(rawXml, xmlInitEntry.maskId, xmlInitEntry.crc32);
      if (plainXml.length >= 4) {
        initXml = new TextDecoder("utf-8", { fatal: false }).decode(plainXml.subarray(4));
      }
    }
  } finally {
    closeSync(iddFd);
  }

  const charTeIddPath = resolve(resourceRoot, "CharTE.idd");
  const charTeObjEntry = charTeEntries.find((e) => e.path === "ObjectTable/CharTEObjectTable");
  if (existsSync(charTeIddPath) && charTeObjEntry) {
    const fd = openSync(charTeIddPath, "r");
    try {
      const archiveSize = fstatSync(fd).size;
      assertIdxEntriesFitArchive(charTeEntries, "CharTE.idd", archiveSize);
      const raw = readIddEntry(fd, "CharTE.idd", archiveSize, charTeObjEntry);
      const plain = decryptIddEntry(raw, charTeObjEntry.maskId, charTeObjEntry.crc32);
      charTeObjectTable = parseObjectTableBuffer(plain);
    } finally {
      closeSync(fd);
    }
  }

  const emoTeIddPath = resolve(resourceRoot, "EmoTE.idd");
  const emoTeObjEntry = emoTeEntries.find((e) => e.path === "ObjectTable/EmoTEObjectTable");
  if (existsSync(emoTeIddPath) && emoTeObjEntry) {
    const fd = openSync(emoTeIddPath, "r");
    try {
      const archiveSize = fstatSync(fd).size;
      assertIdxEntriesFitArchive(emoTeEntries, "EmoTE.idd", archiveSize);
      const raw = readIddEntry(fd, "EmoTE.idd", archiveSize, emoTeObjEntry);
      const plain = decryptIddEntry(raw, emoTeObjEntry.maskId, emoTeObjEntry.crc32);
      emoTeObjectTable = parseObjectTableBuffer(plain);
    } finally {
      closeSync(fd);
    }
  }

  // 8 Disk .ssd / .ini streams (with automatic v22 transcoding for fxstock, fxdynmapinfo, esfn)
  const fxdynimginfo = loadSsdEntry(resourceRoot, "fxdynimginfo.ssd");
  const csysstr = loadSsdEntry(resourceRoot, "csysstr.ssd");
  const esfn = loadSsdEntry(resourceRoot, "esfn.ssd");
  const filterstr = loadSsdEntry(resourceRoot, "filterstr.ssd");
  const fxdynmapinfo = loadSsdEntry(resourceRoot, "fxdynmapinfo.ssd");
  const packagemap = loadSsdEntry(resourceRoot, "packagemap.ini");
  const stringtable = loadSsdEntry(resourceRoot, "stringtable.ini");
  const fxstock = loadSsdEntry(resourceRoot, "fxstock.ini");

  // 4 Server-synthesized .ssd streams (multisvr.ssd, multisvrn.ssd, channel2_001.ssd, qmarksfn.ssd)
  const multisvr = buildSynthesizedSsdEntry(
    "multisvr.ssd",
    buildMultiSvrSmartStream("127.0.0.1", 3838)
  );
  const multisvrn = buildSynthesizedSsdEntry(
    "multisvrn.ssd",
    buildMultiSvrNSmartStream("127.0.0.1", 3838)
  );
  const channel2 = buildSynthesizedSsdEntry(
    "channel2_001.ssd",
    buildChannelCacheSmartStream()
  );
  const qmarksfn = buildSynthesizedSsdEntry("qmarksfn.ssd", buildQMarkSmartStream());

  const baseMap = new Map<string, SsdCacheEntry>([
    ["a1", fxdynimginfo],
    ["a1.ssd", fxdynimginfo],
    ["a2", csysstr],
    ["a2.ssd", csysstr],
    ["a3", esfn],
    ["a3.ssd", esfn],
    ["b1", filterstr],
    ["b1.ssd", filterstr],
    ["fxdynimginfo.ssd", fxdynimginfo],
    ["csysstr.ssd", csysstr],
    ["multisvr.ssd", multisvr],
    ["multisvrn.ssd", multisvrn],
    ["esfn.ssd", esfn],
    ["filterstr.ssd", filterstr],
    ["fxdynmapinfo.ssd", fxdynmapinfo],
    ["packagemap.ini", packagemap],
    ["stringtable.ini", stringtable],
    ["fxstock.ini", fxstock],
    ["channel2_001.ssd", channel2],
    ["qmarksfn.ssd", qmarksfn],
  ]);

  const ssdFiles = Object.assign(baseMap, {
    fxdynimginfo,
    csysstr,
    multisvr,
    multisvrn,
    esfn,
    filterstr,
    fxdynmapinfo,
    fxstock,
    stringtable,
    packagemap,
    channel2,
    qmarksfn,
  }) as SsdFileCollection;

  const resources: ClientResources = {
    fxEntries,
    charTeEntries,
    emoTeEntries,
    maps,
    mapList: maps,
    mapsById,
    mapsByName,
    mapGroups,
    bombers,
    bomberAttrs: bombers,
    items,
    itemAttrs: items,
    fxObjectTable,
    charTeObjectTable,
    emoTeObjectTable,
    tileInfos,
    initXml,
    ssdFiles,
  };
  cachedResourcesByRoot.set(resourceRoot, resources);
  return resources;
}

export const loadAllResources = loadClientResources;
