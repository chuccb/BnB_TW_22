/**
 * Builds the `CUserItemMan` item-master records (S->C 197 `UserItemsData` / S->C 63)
 * from the served `fxstock.ini` body.
 *
 * Client chain (CA.exe):
 *   S->C 197 -> `CStage::sub_4BDBF5` case 197 -> `sub_4B9654` -> `CUserItemMan::sub_598BEC`
 *   (`0x00598BEC`) -> per record `UserItem::sub_597611` (`0x00597611`).
 *
 * Why the server must send this packet:
 *   `ShopItem::sub_5890CC` (`0x005890CC`) resolves every shop-list icon through
 *   `sub_597E6F(dword_929C70, key)` where key is the fxstock entry's +104 field and
 *   `dword_929C70` is the `CUserItemMan` singleton. Without a UserItem hit the icon
 *   handle is left 0 and the shop draws an empty slot. Only categories 9, 11, 17 and
 *   21..26 skip the lookup (`sub_48A0CA`, `0x0048A0CA`) and fall back to the row's own
 *   +128 path. The same table gates `S->C 194` inventory parsing (`sub_595272` drops
 *   records whose id is unknown to `CUserItemMan`).
 *
 * Icon-path derivation (`UserItem::sub_5971F6`, `0x005971F6` + `CIconMan` builders):
 *   type 0/7/8/9/17/33 -> empty path   -> shop falls back to fxstock +128 path
 *   type 1             -> `CItemResourceMan` name remap; unknown name -> empty path
 *   type 2/5/6/13/15/20/30/31/36/37 -> path = the +0x20 name string verbatim
 *   type 3             -> "Icon/Emotion_%c%03dIcon" (letter=a+65, idx=c) if present,
 *                         else the emoticon set image `(&off_91C1C0)[a]`:
 *                         0 Shop/EmotSmile, 1 Shop/EmotAngry, 2 Shop/EmotLove,
 *                         3 Shop/EmotSad, 4 Shop/EmotGreet, 5 Shop/EmotShy,
 *                         6 Shop/EmotDance, 7 Shop/EmotSpecial
 *   type 4             -> "Icon/Fanfare%03d" (a) if present else "Icon/Fanfare000"
 *   type 10            -> "Icon/Slot%02d_%04dIcon" (a, b) if present else "Icon/Slot000"
 *   type 11            -> no case -> empty path -> fxstock +128 fallback (set icons)
 *   type 12            -> "Icon/CharDeco_%c%04dIcon" (b+65, c) if present else "Icon/Slot000"
 *   type 14            -> "Icon/Bomb%03dicon" (c) if present else "Icon/Slot000"
 *   type 16            -> "Item/Bomber%d" (a)
 *   type 18            -> "Icon/ItemIDdeco_C%03d" (a) if present else "Icon/Slot000"
 *   type 19            -> composed avatar-deco name
 *
 * The per-item art for room decorations (cat 10), char decorations (cat 12) and
 * balloons (cat 14) is not present in the shipped Fx/CharTE/EmoTE packs under the
 * names those builders produce, so the client falls back to "Icon/Slot000" for them
 * regardless of the index values; the catalog still populates faithful field values.
 */

import type { UserItemRecord } from "../handlers/shopHandler.ts";

/** One `fxstock.ini` row, pre-v22 / v22 shared prefix (wire order). */
export interface FxStockCatalogRow {
  id8: number;
  cat20: number;
  /** Raw Big5/ASCII bytes of the +32 display-name string. */
  nameBytes: Uint8Array;
  f80: number;
  f92: number;
  /** +104 lookup key used by `ShopItem::sub_5890CC`. */
  pkg104: number;
  f116: number;
  /** Raw bytes of the +128 icon-path hint string. */
  pathBytes: Uint8Array;
}

class BodyReader {
  private view: DataView;
  private offset = 0;

  constructor(private body: Uint8Array) {
    this.view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  }

  get remaining(): number {
    return this.body.length - this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  bytes(len: number): Uint8Array {
    const v = this.body.subarray(this.offset, this.offset + len);
    this.offset += len;
    return v;
  }
}

/** Byte length of the per-row suffix after the +128 string, pre-v22 (32B) vs v22 (33B). */
const FXSTOCK_TAIL_BYTES_V22 = 33;

/**
 * Parses the served (v22) `fxstock.ini` stream body: `u16 count` + `count` rows of
 * `u32 +8, u8 +20, str +32, u16 +80, u16 +92, u32 +104, u32 +116, str +128, tail`.
 * Only the fields needed for the UserItem catalog are kept; the tail is skipped.
 */
export function parseFxStockCatalog(body: Uint8Array): FxStockCatalogRow[] {
  const reader = new BodyReader(body);
  const count = reader.u16();
  const rows: FxStockCatalogRow[] = [];

  for (let i = 0; i < count; i++) {
    const id8 = reader.u32();
    const cat20 = reader.u8();
    const nameLen = reader.u32();
    const nameBytes = reader.bytes(nameLen);
    const f80 = reader.u16();
    const f92 = reader.u16();
    const pkg104 = reader.u32();
    const f116 = reader.u32();
    const pathLen = reader.u32();
    const pathBytes = reader.bytes(pathLen);
    if (reader.remaining < FXSTOCK_TAIL_BYTES_V22) {
      throw new Error(`fxstock.ini truncated at row ${i}: ${reader.remaining} tail byte(s)`);
    }
    reader.bytes(FXSTOCK_TAIL_BYTES_V22);

    rows.push({ id8, cat20, nameBytes, f80, f92, pkg104, f116, pathBytes });
  }

  if (reader.remaining !== 0) {
    throw new Error(`fxstock.ini body has ${reader.remaining} trailing byte(s)`);
  }
  return rows;
}

/** `off_91C1C0` in CA.exe: emoticon set index -> set-image resource path. */
export const EMOTICON_SET_BY_PATH: ReadonlyMap<string, number> = new Map([
  ["shop/emotsmile", 0],
  ["shop/emotangry", 1],
  ["shop/emotlove", 2],
  ["shop/emotsad", 3],
  ["shop/emotgreet", 4],
  ["shop/emotshy", 5],
  ["shop/emotdance", 6],
  ["shop/emotspecial", 7],
]);

/** Emoticon rows whose +128 path is not one of the eight set images. */
const EMOTICON_SET_FALLBACK_BY_PATH: ReadonlyMap<string, number> = new Map([
  ["shot/emotspecial", 7],
  ["icon/set_emotionicon", 5],
]);

/** Icon-builder types whose +0x20 name string is used verbatim as the icon path. */
const PATH_IS_NAME_TYPES: ReadonlySet<number> = new Set([2, 5, 6, 13, 15, 20, 30, 31, 36, 37]);

/** Types whose icon path comes from the +0x20 name via an "Icon/%s" or "%s" wrap. */
const NAME_AS_PATH_TYPES: ReadonlySet<number> = new Set([1, 27, 32, 34, 35, 38, 100]);

/** Sentinel index that never matches local art so builders fall back to the safe image. */
const NO_SUCH_ICON_INDEX = 9999;

function decodeAsciiPath(bytes: Uint8Array): string {
  // Paths are ASCII ("Item/SlotDeco"); some rows carry stray trailing control bytes
  // ("Item/ItemSpeaker\r\n", "Item/Scanner\t") which break the image lookup.
  let end = bytes.length;
  while (end > 0 && bytes[end - 1]! <= 0x20) {
    end -= 1;
  }
  let out = "";
  for (let i = 0; i < end; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

function decodeBig5(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  // iconv-lite lives behind the packet text codec; keep this module dependency-free
  // by preserving the bytes through latin-1 code units. PacketWriter.writeString
  // re-encodes via CP950, so latin-1 code units 0x80..0xff would NOT round-trip.
  // Instead decode with the platform TextDecoder fallback used elsewhere is avoided:
  // names are only decorative here (types that use them for icons use ASCII paths).
  // Decode Big5 with a tiny mapping via TextDecoder when available.
  try {
    return new TextDecoder("big5").decode(bytes);
  } catch {
    return bytes.reduce((acc, b) => acc + String.fromCharCode(b), "");
  }
}

/**
 * Derives one `UserItem` master record per distinct fxstock +104 key.
 * When several rows share a key (duration variants of the same item), the first row
 * supplies the type/fields; the shop still shows each row's own +128 fallback image
 * whenever the derived icon path is empty (types 0/7/8/9/11/17/33).
 */
export function buildUserItemCatalog(rows: readonly FxStockCatalogRow[]): UserItemRecord[] {
  const byKey = new Map<number, FxStockCatalogRow>();
  for (const row of rows) {
    if (!byKey.has(row.pkg104)) {
      byKey.set(row.pkg104, row);
    }
  }

  const records: UserItemRecord[] = [];
  for (const [pkg104, row] of byKey) {
    const path = decodeAsciiPath(row.pathBytes);
    const type = row.cat20;
    let name = decodeBig5(row.nameBytes);
    let field0x38U32 = 0;
    let field0x44U32 = 0;
    let field0x50U32 = 0;

    if (PATH_IS_NAME_TYPES.has(type) || NAME_AS_PATH_TYPES.has(type)) {
      // Icon path = name string (or name remapped through CItemResourceMan for type 1,
      // where an unknown name resolves to an empty path and the +128 fallback applies).
      name = path;
    }

    switch (type) {
      case 3: {
        const setIndex =
          EMOTICON_SET_BY_PATH.get(path.toLowerCase()) ??
          EMOTICON_SET_FALLBACK_BY_PATH.get(path.toLowerCase()) ??
          7;
        field0x38U32 = setIndex;
        // 9999 forces the "not present" branch: icon = the emoticon set image.
        field0x50U32 = NO_SUCH_ICON_INDEX;
        break;
      }
      case 4: {
        // +128 paths are "Item/Fanfare000".."Item/Fanfare006".
        const suffix = /(\d{3})$/.exec(path)?.[1];
        field0x38U32 = suffix ? Number(suffix) : 0;
        break;
      }
      case 14: {
        // "Icon/Bomb%03dicon" art is absent from the shipped packs; the client falls
        // back to "Icon/Slot000" whatever the index. Still assign distinct indices.
        field0x50U32 = rows.filter((r) => r.cat20 === 14).findIndex((r) => r.pkg104 === pkg104);
        if (field0x50U32 < 0) {
          field0x50U32 = 0;
        }
        break;
      }
      case 18: {
        // Both ID-decoration rows hint at "Item/IDDeco_C001"; icon art is
        // "Icon/ItemIDdeco_C001".."Icon/ItemIDdeco_C049" in EmoTE.idx.
        field0x38U32 = 1;
        break;
      }
      default:
        break;
    }

    records.push({
      field0x08U32: pkg104,
      field0x14U8: type,
      field0x20String: name,
      field0x38U32,
      field0x44U32,
      field0x50U32,
      field0x5cString: "",
      field0x74U16: 0,
      field0x80U8: 0,
    });
  }

  return records;
}
