import { closeSync, openSync, readSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, test } from "bun:test";

const CLIENT_RESOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
import {
  buildMultiSvrSmartStream,
  decryptIddEntry,
  loadClientResources,
  verifySmartStreamSchema,
} from "../src/resources/archive.ts";
import { SmartStreamReader } from "../src/protocol/stream.ts";

describe("Client Resource Archives — Fx.idx, .i16 Tables, Maps & All 12 .ssd/.ini Streams", () => {
  test("Decrypts Fx.idx (sub_673110), loads CGameMapInfoList, BomberAttr, ItemAttr, and verifies all 12 .ssd/.ini streams", () => {
    const resources = loadClientResources();

    // Fx.idx has 3,948 entries (seed 0x719CAB30), CharTE.idx has 3,046 (seed 0x05B201FC), EmoTE.idx has 3,005 (seed 0x05B201FC)
    expect(resources.fxEntries.length).toBe(3948);
    expect(resources.charTeEntries.length).toBe(3046);
    expect(resources.emoTeEntries.length).toBe(3005);

    // Cross-verify all 325 encrypted (.idd maskId != 0) entries across Fx.idd, CharTE.idd, and EmoTE.idd via CData::sub_674590 CRC32
    let verifiedMaskedCount = 0;
    for (const [iddFile, entries] of [
      ["Fx.idd", resources.fxEntries],
      ["CharTE.idd", resources.charTeEntries],
      ["EmoTE.idd", resources.emoTeEntries],
    ] as const) {
      const fd = openSync(resolve(CLIENT_RESOURCE_ROOT, iddFile), "r");
      try {
        for (const entry of entries) {
          if (entry.maskId !== 0) {
            const raw = new Uint8Array(entry.size);
            readSync(fd, raw, 0, entry.size, entry.offset);
            const plain = decryptIddEntry(raw, entry.maskId, entry.crc32);
            expect(plain.length).toBe(entry.size);
            verifiedMaskedCount++;
          }
        }
      } finally {
        closeSync(fd);
      }
    }
    expect(verifiedMaskedCount).toBe(325);

    // Attr/MapGroup (3 groups: PraticeMapGroup=45, LadderMapGroup=6, ReBirthMapGroup=2) & XML/init
    expect(resources.mapGroups.length).toBe(3);
    expect(resources.mapGroups[0]?.groupName).toBe("PraticeMapGroup");
    expect(resources.mapGroups[0]?.mapNames.length).toBe(45);
    expect(resources.mapGroups[1]?.groupName).toBe("LadderMapGroup");
    expect(resources.mapGroups[1]?.mapNames.length).toBe(6);
    expect(resources.mapGroups[2]?.groupName).toBe("ReBirthMapGroup");
    expect(resources.mapGroups[2]?.mapNames.length).toBe(2);
    expect(resources.initXml).toContain('<nation name="taiwan"/>');

    // CGameMapInfoList::sub_4E8597 extracts Map/* entries in exact Fx.idx order with sub_4E5845 CRC32 & CRC8
    expect(resources.maps.length).toBe(319);
    expect(resources.maps[0]!.name.startsWith("Map/")).toBe(true);
    expect(resources.maps[0]!.folderName.length).toBeGreaterThan(0);
    expect(resources.maps[0]!.crc32).toBeGreaterThan(0);
    expect(resources.maps[0]!.crc8).toBeGreaterThanOrEqual(0);
    expect(resources.maps[0]!.crc8).toBeLessThanOrEqual(255);

    // CGameObjectTemplateLib::sub_462364 ObjectTables & CMapObjToTileInfo::sub_5C7AC3 TileInfoList
    expect(resources.fxObjectTable.length).toBe(1187);
    expect(resources.fxObjectTable[0]?.name).toBe("Bomb");
    expect(resources.charTeObjectTable.length).toBe(634);
    expect(resources.emoTeObjectTable.length).toBe(1397);
    expect(resources.tileInfos.length).toBe(899);
    expect(resources.tileInfos[0]?.name).toBe("Tile00_Box/BoxGray");

    // CBomberAttrMan::sub_4EC1FD loads 11 bomber entries (Character/C00 .. Character/C10) from Attr/BomberAttr
    expect(resources.bombers.length).toBe(11);
    expect(resources.bombers[0]!.bombStart).toBeGreaterThanOrEqual(1);
    expect(resources.bombers[0]!.bombMax).toBeGreaterThanOrEqual(resources.bombers[0]!.bombStart);

    // CItemAttrMan::sub_4EF2BD loads items from Attr/ItemAttr
    expect(resources.items.length).toBeGreaterThan(20);

    // Original disk "ssi1" Adler-32 seed 0 checksums (sub_6984B0)
    expect(resources.ssdFiles.get("csysstr.ssd")?.diskAdler32Zero).toBe(0xe734d04f);
    expect(resources.ssdFiles.get("filterstr.ssd")?.diskAdler32Zero).toBe(0x000e496d);
    expect(resources.ssdFiles.get("esfn.ssd")?.diskAdler32Zero).toBe(0x491e0722);
    expect(resources.ssdFiles.get("fxdynimginfo.ssd")?.diskAdler32Zero).toBe(0x084341a5);
    expect(resources.ssdFiles.get("fxdynmapinfo.ssd")?.diskAdler32Zero).toBe(0x39ac6777);
    expect(resources.ssdFiles.get("packagemap.ini")?.diskAdler32Zero).toBe(0xdcec1a37);
    expect(resources.ssdFiles.get("stringtable.ini")?.diskAdler32Zero).toBe(0x6683b836);
    expect(resources.ssdFiles.get("fxstock.ini")?.diskAdler32Zero).toBe(0xb5c71db3);

    // All 12 .ssd and .ini streams parse with remaining === 0 under exact CA.exe v22 reader schemas
    const expectedStreams: ReadonlyArray<{ name: string; minEntries: number }> = [
      { name: "fxdynimginfo.ssd", minEntries: 8 },
      { name: "csysstr.ssd", minEntries: 5335 },
      { name: "multisvr.ssd", minEntries: 2 },
      { name: "multisvrn.ssd", minEntries: 1 },
      { name: "filterstr.ssd", minEntries: 30 },
      { name: "channel2_001.ssd", minEntries: 4 },
      { name: "fxdynmapinfo.ssd", minEntries: 871 },
      { name: "esfn.ssd", minEntries: 1 },
      { name: "fxstock.ini", minEntries: 1461 },
      { name: "stringtable.ini", minEntries: 114 },
      { name: "packagemap.ini", minEntries: 988 },
      { name: "qmarksfn.ssd", minEntries: 2 },
    ];

    for (const { name, minEntries } of expectedStreams) {
      const entry = resources.ssdFiles.get(name);
      expect(entry).toBeDefined();
      const verified = verifySmartStreamSchema(name, entry!.decompressed);
      expect(verified.entryCount).toBeGreaterThanOrEqual(minEntries);
      expect(verified.remaining).toBe(0);
    }
  });

  test("CMultiServer reads the LE in_addr value as network-order IPv4 and CP950 labels", () => {
    const stream = new SmartStreamReader(
      buildMultiSvrSmartStream("192.0.2.71", 3838).toRawPayload()
    );
    expect(stream.readU8()).toBe(1); // server-list group count
    expect(stream.readString()).toBe("tw_world_01");
    expect(stream.readString()).toBe("爆爆王台灣伺服器");
    expect(stream.readU32()).toBe(1); // group attributes
    expect(stream.readU16()).toBe(1); // endpoint count
    expect(stream.readU32()).toBe(0x470200c0); // memory bytes C0 00 02 47 -> inet_ntoa(192.0.2.71)
    expect(stream.readU16()).toBe(3838);
    expect(stream.readU8()).toBe(0); // endpoint selector
    expect(stream.readU8()).toBe(0); // default selector
    expect(stream.remaining()).toBe(0);
  });
});
