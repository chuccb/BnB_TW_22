import { describe, expect, test } from "bun:test";
import { buildSetPlayerPacket } from "../src/handlers/roomHandler.ts";
import type { StockEntry, UserRecord } from "../src/db/database.ts";
import { PacketReader } from "../src/protocol/primitives.ts";
import { ServerOpcode } from "../src/protocol/opcodes.ts";
import type { RoomSlot, WorldState } from "../src/state/worldState.ts";

function makeFixture(feature15: boolean): {
  state: WorldState;
  slot: RoomSlot;
  user: UserRecord;
  stock: StockEntry[];
} {
  const user: UserRecord = {
    id: 7,
    username: "avatar_user",
    nickname: "avatar_user",
    password: "test-only",
    gender: 2,
    level: 23,
    exp: 0x10203040,
    wins: 0x11111111,
    losses: 0x22222222,
    draws: 0x33333333,
    lucci: 0x44444444,
    cash: 100,
    grade: 5,
    rankFlag: 0x1234,
    equippedChar: 0,
    guildName: "test_guild",
    guildMark: 0x55667788,
  };
  const stock: StockEntry[] = [
    {
      id: 1,
      userId: user.id,
      itemCode: 0x2345,
      quantity: 1,
      equipped: 1,
      expireTs: 0,
    },
  ];
  const state = {
    config: { enabledFeatures: feature15 ? new Set([15]) : new Set<number>() },
    db: { getUserStock: (_userId: number) => stock },
  } as unknown as WorldState;
  const slot: RoomSlot = {
    slotIdx: 2,
    occupied: true,
    open: true,
    ready: false,
    inShop: false,
    charId: 0,
    teamColor: 1,
    session: null,
    localPlayerIdx: 0,
    netSlotId: 0x10203040,
    user,
    loadedGame: false,
    alive: true,
    trapped: false,
    kills: 0,
    saves: 0,
    udpEndpoints: [
      { ip: 0, port: 0 },
      { ip: 0, port: 0 },
      { ip: 0, port: 0 },
    ],
  };
  return { state, slot, user, stock };
}

function readAccessoryBlock(reader: PacketReader) {
  const equippedCount = reader.readU8();
  if (equippedCount > 32) {
    throw new Error(`Unexpected equipped item count ${equippedCount}; likely field misalignment`);
  }
  const equippedPad = equippedCount > 0 ? reader.readU8() : undefined;
  const equippedItems = Array.from({ length: equippedCount }, () => ({
    slotType: reader.readU8(),
    itemCode: reader.readU16(),
  }));

  const effectCount = reader.readU8();
  if (effectCount > 32) {
    throw new Error(`Unexpected effect count ${effectCount}; likely field misalignment`);
  }
  if (effectCount > 0) reader.readU8(); // Client-discarded pad.
  const effects = Array.from({ length: effectCount }, () => [
    reader.readU32(),
    reader.readU32(),
    reader.readU32(),
  ]);

  const flags = [reader.readU8(), reader.readU8(), reader.readU8()];
  const value33 = reader.readU32();
  const extraCount = reader.readU8();
  if (extraCount > 32) {
    throw new Error(`Unexpected extra count ${extraCount}; likely field misalignment`);
  }
  const extraValues = Array.from({ length: extraCount }, () => [
    reader.readU32(),
    reader.readU32(),
    reader.readU32(),
  ]);
  return { equippedCount, equippedPad, equippedItems, effectCount, effects, flags, value33, extraCount, extraValues };
}

function parseSetPlayerPacket(reader: PacketReader, feature15: boolean) {
  const slotIdx = reader.readU8();
  const slotNetId = reader.readU32();
  const selector = reader.readU8();
  const packetField20 = reader.readU8();
  const packetField36 = reader.readU8();
  const discardedByte = reader.readU8();
  const conditionalByte = selector !== 0 ? reader.readU8() : undefined;
  const slotBlock = Array.from(reader.readBlock(3));

  const user = {
    username: reader.readString(),
    gender: reader.readU8(),
    level: reader.readU8(),
    exp: reader.readU32(),
    rankFlag: reader.readU16(),
    wins: reader.readU32(),
    losses: reader.readU32(),
    draws: reader.readU32(),
    lucci: reader.readU32(),
    grade: reader.readU8(),
    discardedU16: reader.readU16(),
    memberC0: reader.readU16(),
    memberCC: reader.readU16(),
    memberD8: reader.readU16(),
  };
  const trailingCUserValue = reader.readU32();
  const wrapperByte = reader.readU8();
  const extension = feature15
    ? { string: reader.readString(), value: reader.readU32() }
    : undefined;
  const accessories = readAccessoryBlock(reader);

  return {
    slotIdx,
    slotNetId,
    selector,
    packetField20,
    packetField36,
    discardedByte,
    conditionalByte,
    slotBlock,
    user,
    trailingCUserValue,
    wrapperByte,
    extension,
    accessories,
  };
}

describe("S->C 102 SetPlayer packet builder", () => {
  test("matches the Client parser order with feature 15 and both selector branches", () => {
    const { state, slot, user, stock } = makeFixture(true);

    for (const selector of [0, 1]) {
      const reader = new PacketReader(buildSetPlayerPacket(state, slot, selector).toPayload(), 3);
      expect(reader.opcode).toBe(ServerOpcode.SetPlayerOnPrepare);
      const parsed = parseSetPlayerPacket(reader, true);

      expect(parsed).toEqual({
        slotIdx: slot.slotIdx,
        slotNetId: slot.netSlotId,
        selector,
        packetField20: 0,
        packetField36: 0,
        discardedByte: 0,
        conditionalByte: selector !== 0 ? 0 : undefined,
        slotBlock: [3, 0, 1],
        user: {
          username: user.username,
          gender: user.gender,
          level: user.level,
          exp: user.exp,
          rankFlag: user.rankFlag,
          wins: user.wins,
          losses: user.losses,
          draws: user.draws,
          lucci: user.lucci,
          grade: user.grade,
          discardedU16: 0,
          memberC0: 0,
          memberCC: 0,
          memberD8: 0,
        },
        trailingCUserValue: 0,
        wrapperByte: 0xff,
        extension: { string: user.guildName, value: user.guildMark },
        accessories: {
          equippedCount: 1,
          equippedPad: 0,
          equippedItems: [{ slotType: 0, itemCode: stock[0]!.itemCode }],
          effectCount: 0,
          effects: [],
          flags: [0, 0, 0],
          value33: 0,
          extraCount: 0,
          extraValues: [],
        },
      });
      expect(reader.remaining).toBe(0);
    }
  });

  test("omits feature-15 extension fields when the Client feature is disabled", () => {
    const { state, slot, user, stock } = makeFixture(false);
    const reader = new PacketReader(buildSetPlayerPacket(state, slot, 1).toPayload(), 3);

    expect(reader.opcode).toBe(ServerOpcode.SetPlayerOnPrepare);
    const parsed = parseSetPlayerPacket(reader, false);
    expect(parsed.selector).toBe(1);
    expect(parsed.conditionalByte).toBe(0);
    expect(parsed.extension).toBeUndefined();
    expect(parsed.accessories.equippedCount).toBe(1);
    expect(parsed.accessories.equippedItems).toEqual([
      { slotType: 0, itemCode: stock[0]!.itemCode },
    ]);
    expect(parsed.user.username).toBe(user.username);
    expect(reader.remaining).toBe(0);
  });
});
