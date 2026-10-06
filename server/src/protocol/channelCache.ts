import { SmartStreamWriter } from "./stream.ts";

/**
 * Values reconstructed from `CChannelCache::sub_5D3D3F` and
 * `CChannelInfo::sub_5D418E` (`CA.exe.c`, 0x005D3D3F / 0x005D418E).
 *
 * The wire record's numeric fields are intentionally named by observed client use rather
 * than by the uncertain server-side labels from the unavailable `channel2_001.ssd` file.
 */
export interface CChannelCacheRecord {
  name: string;
  /** u16 field #1; `sub_56AAB6`, compared against current users in `sub_56C846`. */
  maxUsers: number;
  /** u8 field #2; `sub_56AACC`, used by the channel selector's class/icon and auto-tab logic. */
  badgeId: number;
  /** u8 field #3; raw 10/18 are normalized to 10 by `sub_5D4071`. */
  categoryCode: number;
  /** u16 field #4; exposed by `sub_56AAE2`. */
  channelFlags: number;
  /** u8 field #5; restriction bits checked in `sub_56AF39`. */
  restrictionFlags: number;
  /** u8 field #6; selected-tab match in `sub_56AB0E`. */
  tabIndex: number;
  /** u8 field #7; exposed by `sub_56AB3A`. */
  minGrade: number;
  /** u8 field #8; exposed by `sub_56AB50`. */
  maxGrade: number;
  /** u16 field #9; exposed by `sub_56AB66`. */
  minLevel: number;
  /** u16 field #10; exposed by `sub_56AB7C`. */
  maxLevel: number;
}

/** Runtime state adds the current-user count supplied separately by S->C 12. */
export interface CChannelInfo extends CChannelCacheRecord {
  currentUsers: number;
}

export const CChannelCategoryCode = {
  Standard: 10,
  Slow: 18,
} as const;

/**
 * `sub_5D4071` maps raw category 18 to 10 before grouping and selection.
 * The client also normalizes gameType 5..9 to 0..4 when it reads a category-10 row.
 */
export function normalizeCChannelCategory(categoryCode: number): number {
  return categoryCode === CChannelCategoryCode.Slow
    ? CChannelCategoryCode.Standard
    : categoryCode;
}

/**
 * `sub_5D40F5`: zero-based ordinal among preceding entries with the same normalized
 * category code. This ordinal, not the record's capacity or absolute row number, is used
 * in C->S 5 and S->C 7.
 */
export function getCChannelCategoryOrdinal(
  channels: readonly CChannelInfo[],
  channelIndex: number
): number {
  const channel = channels[channelIndex];
  if (!channel) {
    return -1;
  }
  const category = normalizeCChannelCategory(channel.categoryCode);
  let ordinal = 0;
  for (let index = 0; index < channelIndex; index++) {
    if (normalizeCChannelCategory(channels[index]!.categoryCode) === category) {
      ordinal++;
    }
  }
  return ordinal;
}

/**
 * Resolves the C->S 5 category + category-relative ordinal back to the server's channel
 * record. The normalized category grouping mirrors `sub_5D40F5` and `sub_5D4071`.
 */
export function findCChannelByCategoryOrdinal(
  channels: readonly CChannelInfo[],
  categoryCode: number,
  ordinal: number
): { channel: CChannelInfo; channelIndex: number } | undefined {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    return undefined;
  }
  const requestedCategory = normalizeCChannelCategory(categoryCode);
  let matchingOrdinal = 0;
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    const channel = channels[channelIndex]!;
    if (normalizeCChannelCategory(channel.categoryCode) !== requestedCategory) {
      continue;
    }
    if (matchingOrdinal === ordinal) {
      return { channel, channelIndex };
    }
    matchingOrdinal++;
  }
  return undefined;
}

/**
 * Exact `channel2_001.ssd` record order from `CChannelCache::sub_5D3D3F`:
 * `str name, u16 maxUsers, u8 badgeId, u8 categoryCode, u16 channelFlags,
 *  u8 restrictionFlags, u8 tabIndex, u8 minGrade, u8 maxGrade, u16 minLevel, u16 maxLevel`.
 *
 * String bytes use the Taiwan client's CP950 code page; SmartStreamWriter owns the
 * length-prefixed string encoding.
 */
function assertUnsignedInteger(field: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`CChannelCache ${field} must be an integer in 0..${max}; got ${value}`);
  }
}

export function writeCChannelCache(
  stream: SmartStreamWriter,
  channels: readonly CChannelCacheRecord[]
): void {
  if (channels.length > 0xffff) {
    throw new RangeError(`CChannelCache has too many entries: ${channels.length}`);
  }

  stream.writeU16(channels.length);
  for (const [index, channel] of channels.entries()) {
    if (channel.maxUsers === 0) {
      throw new RangeError(`CChannelCache row ${index} maxUsers must be greater than zero`);
    }
    assertUnsignedInteger(`row ${index} maxUsers`, channel.maxUsers, 0xffff);
    assertUnsignedInteger(`row ${index} badgeId`, channel.badgeId, 0xff);
    assertUnsignedInteger(`row ${index} categoryCode`, channel.categoryCode, 0xff);
    assertUnsignedInteger(`row ${index} channelFlags`, channel.channelFlags, 0xffff);
    assertUnsignedInteger(`row ${index} restrictionFlags`, channel.restrictionFlags, 0xff);
    assertUnsignedInteger(`row ${index} tabIndex`, channel.tabIndex, 0xff);
    assertUnsignedInteger(`row ${index} minGrade`, channel.minGrade, 0xff);
    assertUnsignedInteger(`row ${index} maxGrade`, channel.maxGrade, 0xff);
    assertUnsignedInteger(`row ${index} minLevel`, channel.minLevel, 0xffff);
    assertUnsignedInteger(`row ${index} maxLevel`, channel.maxLevel, 0xffff);
    if (channel.maxGrade < channel.minGrade || channel.maxLevel < channel.minLevel) {
      throw new RangeError(`CChannelCache row ${index} has an inverted grade or level range`);
    }

    stream.writeString(channel.name);
    stream.writeU16(channel.maxUsers);
    stream.writeU8(channel.badgeId);
    stream.writeU8(channel.categoryCode);
    stream.writeU16(channel.channelFlags);
    stream.writeU8(channel.restrictionFlags);
    stream.writeU8(channel.tabIndex);
    stream.writeU8(channel.minGrade);
    stream.writeU8(channel.maxGrade);
    stream.writeU16(channel.minLevel);
    stream.writeU16(channel.maxLevel);
  }
}

/** Minimal structurally valid fallback data; real channel data is server-provided. */
export const DEFAULT_C_CHANNELS: readonly CChannelInfo[] = [
  {
    name: "新手頻道 1",
    maxUsers: 200,
    badgeId: 2,
    categoryCode: CChannelCategoryCode.Standard,
    channelFlags: 0,
    restrictionFlags: 0,
    tabIndex: 0,
    minGrade: 0,
    maxGrade: 50,
    minLevel: 1,
    maxLevel: 50,
    currentUsers: 0,
  },
  {
    name: "自由頻道 1",
    maxUsers: 300,
    badgeId: 0,
    categoryCode: CChannelCategoryCode.Standard,
    channelFlags: 0,
    restrictionFlags: 0,
    tabIndex: 1,
    minGrade: 0,
    maxGrade: 50,
    minLevel: 1,
    maxLevel: 400,
    currentUsers: 0,
  },
  {
    name: "天梯頻道 1",
    maxUsers: 200,
    badgeId: 72,
    categoryCode: CChannelCategoryCode.Standard,
    channelFlags: 0,
    restrictionFlags: 0,
    tabIndex: 2,
    minGrade: 0,
    maxGrade: 50,
    minLevel: 1,
    maxLevel: 400,
    currentUsers: 0,
  },
  {
    name: "特殊頻道 1",
    maxUsers: 200,
    badgeId: 0,
    categoryCode: CChannelCategoryCode.Standard,
    channelFlags: 0,
    restrictionFlags: 0,
    tabIndex: 3,
    minGrade: 0,
    maxGrade: 50,
    minLevel: 1,
    maxLevel: 400,
    currentUsers: 0,
  },
];
