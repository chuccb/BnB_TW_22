import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, test } from "bun:test";

const CLIENT_RESOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
import {
  buildDynamicMapInfoCatalog,
  buildMultiSvrSmartStream,
  decryptIddEntry,
  loadClientResources,
  parseDecryptedIdx,
  loadSsdEntry,
  resolveDynamicMapId,
  transcodeDynamicMapInfoToV22,
  verifySmartStreamSchema,
} from "../src/resources/archive.ts";
import { computeAdler32Zero } from "../src/protocol/crc.ts";
import {
  computeSmartStreamBodyChecksum,
  SmartStreamReader,
  SmartStreamWriter,
} from "../src/protocol/stream.ts";
import { TW_ENABLED_FEATURES, isFeatureEnabledTW } from "../src/config/index.ts";
import {
  buildUserItemCatalog,
  parseFxStockCatalog,
} from "../src/resources/userItemCatalog.ts";
import { buildUserItemRecordsPacket } from "../src/handlers/shopHandler.ts";
import { ServerOpcode } from "../src/protocol/opcodes.ts";

function makeClientFormatSsi1(streamContainer: Uint8Array): Uint8Array {
  // Build a format-valid SSI1 wrapper: magic, Adler-32 of the full container, then container bytes.
  const output = new Uint8Array(8 + streamContainer.length);
  output.set([0x73, 0x73, 0x69, 0x31], 0);
  new DataView(output.buffer).setUint32(4, computeAdler32Zero(streamContainer, 0), true);
  output.set(streamContainer, 8);
  return output;
}

describe("Client Resource Archives — Fx.idx, .i16 Tables, Maps & All 12 .ssd/.ini Streams", () => {
  test("Taiwan feature IDs match the region-8 branch in sub_5CEE8E", () => {
    expect([...TW_ENABLED_FEATURES]).toEqual([
      0, 1, 2, 7, 9, 10, 11, 14, 15, 16, 17, 19, 20, 21, 22, 24, 29, 30, 31, 33, 34, 35,
    ]);
    expect(isFeatureEnabledTW(22)).toBe(true);
    expect(isFeatureEnabledTW(23)).toBe(false);
    expect(isFeatureEnabledTW(26)).toBe(false);
    expect(isFeatureEnabledTW(32)).toBe(false);
  });

  test("parses legacy and CRC-bearing .idx records with checked bounds", () => {
    const legacy = new Uint8Array(21);
    const legacyView = new DataView(legacy.buffer);
    legacyView.setUint32(0, 1, true);
    legacyView.setUint32(4, 1, true);
    legacy[8] = 0x61; // "a"
    legacyView.setUint32(9, 0x20, true);
    legacyView.setUint32(13, 7, true);
    legacyView.setUint32(17, 0x1234, true);
    expect(parseDecryptedIdx(legacy)).toMatchObject([
      { index: 0, path: "a", offset: 0x20, size: 7, maskId: 0x1234, crc32: 0 },
    ]);

    const crcFormat = new Uint8Array(33);
    const crcView = new DataView(crcFormat.buffer);
    crcView.setUint32(0, 0, true);
    crcView.setUint32(4, 15, true);
    crcView.setUint32(8, 1, true);
    crcView.setUint32(12, 1, true);
    crcFormat[16] = 0x62; // "b"
    crcView.setUint32(17, 0x30, true);
    crcView.setUint32(21, 9, true);
    crcView.setUint32(25, 0x5678, true);
    crcView.setUint32(29, 0x9abcdef0, true);
    expect(parseDecryptedIdx(crcFormat)).toMatchObject([
      {
        index: 0,
        path: "b",
        offset: 0x30,
        size: 9,
        maskId: 0x5678,
        crc32: 0x9abcdef0,
      },
    ]);

    expect(() => parseDecryptedIdx(new Uint8Array(7))).toThrow(/expected at least 8 bytes/);
    const shortCrcHeader = new Uint8Array(8);
    new DataView(shortCrcHeader.buffer).setUint32(4, 15, true);
    expect(() => parseDecryptedIdx(shortCrcHeader)).toThrow(/CRC format requires 12 bytes/);
    expect(() => parseDecryptedIdx(crcFormat.subarray(0, 29))).toThrow(
      /buffer can contain at most 0 CRC record/
    );
    const truncatedRecord = crcFormat.slice();
    new DataView(truncatedRecord.buffer).setUint32(12, 0x7f, true);
    expect(() => parseDecryptedIdx(truncatedRecord)).toThrow(/Truncated \.idx entry 0/);
  });

  test("Decrypts Fx.idx (sub_673110), loads CGameMapInfoList, BomberAttr, ItemAttr, and verifies all 12 .ssd/.ini streams", () => {
    const resources = loadClientResources();

    // Fx.idx has 3,948 entries (seed 0x719CAB30), CharTE.idx has 3,046 (seed 0x05B201FC), EmoTE.idx has 3,005 (seed 0x05B201FC)
    expect(resources.fxEntries.length).toBe(3948);
    expect(resources.charTeEntries.length).toBe(3046);
    expect(resources.emoTeEntries.length).toBe(3005);

    // Every decrypted .idx slice must fit within its paired .idd archive.
    for (const [iddFile, entries] of [
      ["Fx.idd", resources.fxEntries],
      ["CharTE.idd", resources.charTeEntries],
      ["EmoTE.idd", resources.emoTeEntries],
    ] as const) {
      const iddBytes = statSync(resolve(CLIENT_RESOURCE_ROOT, iddFile)).size;
      const outOfBounds = entries.filter(
        (entry) => entry.offset > iddBytes || entry.size > iddBytes - entry.offset
      );
      expect(outOfBounds).toEqual([]);
    }

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
    expect(resources.initXml).toContain('<info name="couple" attr0="1"/>');
    expect(resources.initXml).toContain('<info name="quest"  attr0="1"/>');
    expect(resources.initXml).not.toContain('nation value="tw"');

    // Client map metadata stores the low byte of sub_4E5845's CRC32 result.
    expect(resources.maps.length).toBe(319);
    expect(resources.maps[0]!.name.startsWith("Map/")).toBe(true);
    expect(resources.maps[0]!.folderName.length).toBeGreaterThan(0);
    expect(resources.maps[0]!.crc32).toBeGreaterThan(0);
    expect(resources.maps[0]!.crc8).toBe(resources.maps[0]!.crc32 & 0xff);

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

    // Original disk SmartStream body checksums (sub_6984B0), not outer ssi1 file-header checksums.
    expect(resources.ssdFiles.get("csysstr.ssd")?.diskAdler32Zero).toBe(0xe734d04f);
    expect(resources.ssdFiles.get("filterstr.ssd")?.diskAdler32Zero).toBe(0x000e496d);
    expect(resources.ssdFiles.get("esfn.ssd")?.diskAdler32Zero).toBe(0x491e0722);
    expect(resources.ssdFiles.get("fxdynimginfo.ssd")?.diskAdler32Zero).toBe(0x084341a5);
    const dynamicMap = resources.ssdFiles.get("fxdynmapinfo.ssd")!;
    // File-identity pins for the CHECKED-IN fxdynmapinfo.ssd (11,560B, body 0x8a065068).
    // RE-09 and the original pins record an 11,593B / 0x39ac6777 file with the same 67,238B
    // v22 payload shape; the committed file's fixed-width map-ID field (v34) carries a
    // foreign content catalog's IDs (see `buildDynamicMapInfoCatalog`), which changed the
    // compressed container. The disk pins below therefore describe the committed file.
    expect(dynamicMap.diskAdler32Zero).toBe(0x8a065068); // original disk-body checksum
    // `sub_6989C0` reserializes the accepted v22 body; deflate bytes and therefore this
    // container-body checksum/length can vary with the compression implementation.
    expect(dynamicMap.adler32Zero).toBe(computeSmartStreamBodyChecksum(dynamicMap.streamContainer));
    expect(dynamicMap.streamContainer[0]).toBe(0x18);
    expect(dynamicMap.rawBytes).toHaveLength(11_560);
    expect(dynamicMap.decompressed).toHaveLength(67_238);
    expect(dynamicMap.entryCount).toBe(871);
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

    // Cross-check channel-level and connection/Lobby dialog strings in csysstr.ssd.
    const systemStrings = new SmartStreamReader(resources.ssdFiles.csysstr.decompressed);
    const systemStringCount = systemStrings.readU16();
    let upperLevelOnly: string | undefined;
    let failedToConnSvr: string | undefined;
    let loadingChannelInfo: string | undefined;
    let connectingToSvr: string | undefined;
    for (let i = 0; i < systemStringCount; i++) {
      const key = systemStrings.readString();
      const value = systemStrings.readString();
      if (key === "UpperLevelOnly") upperLevelOnly = value;
      if (key === "FailedToConnSvr") failedToConnSvr = value;
      if (key === "LoadingChannelInfo") loadingChannelInfo = value;
      if (key === "ConnectingToSvr") connectingToSvr = value;
    }
    expect(upperLevelOnly).toBe("選擇的頻道只能%d級以上才能進入");
    expect(failedToConnSvr).toBe("因您的連線不穩定，請重新登入");
    expect(loadingChannelInfo).toBe("頻道連線中請稍候…");
    expect(connectingToSvr).toBe("登入頻道中，請稍候！");
    expect(systemStrings.remaining()).toBe(0);
  });

  test("scopes the resource cache to the resolved client root", () => {
    const resources = loadClientResources(CLIENT_RESOURCE_ROOT);
    const sameRootAlias = join(CLIENT_RESOURCE_ROOT, ".", "unused", "..");
    expect(loadClientResources(sameRootAlias)).toBe(resources);

    const otherRoot = mkdtempSync(join(tmpdir(), "bnb-client-cache-root-"));
    try {
      writeFileSync(join(otherRoot, "Fx.idx"), readFileSync(resolve(CLIENT_RESOURCE_ROOT, "Fx.idx")));
      writeFileSync(join(otherRoot, "Fx.idd"), new Uint8Array(1));
      expect(() => loadClientResources(otherRoot)).toThrow(/Fx\.idd entry/);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test("reloads v22 ssi1 caches in the Client's disk format without widening them a second time", () => {
    const resources = loadClientResources();
    const tempRoot = mkdtempSync(join(tmpdir(), "bnb-client-cache-v22-"));
    const cases = [
      { filename: "fxdynmapinfo.ssd", entry: resources.ssdFiles.fxdynmapinfo },
      { filename: "fxstock.ini", entry: resources.ssdFiles.fxstock },
    ] as const;

    try {
      for (const { filename, entry } of cases) {
        const formatFixture = makeClientFormatSsi1(entry.streamContainer);
        const filePath = join(tempRoot, filename);
        writeFileSync(filePath, formatFixture);

        const loaded = loadSsdEntry(tempRoot, filename);
        expect(loaded.decompressed).toEqual(entry.decompressed);
        expect(loaded.streamContainer).toEqual(entry.streamContainer);
        expect(loaded.entryCount).toBe(entry.entryCount);
        expect(loaded.adler32Zero).toBe(entry.adler32Zero);
        expect(loaded.diskAdler32Zero).toBe(entry.adler32Zero);
        expect(verifySmartStreamSchema(filename, loaded.decompressed).remaining).toBe(0);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("keeps legacy dynamic-map upgrade and rejects malformed cache data with format context", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bnb-client-cache-validation-"));
    const legacyPath = join(tempRoot, "fxdynmapinfo.ssd");
    const legacyRawFile = new Uint8Array(readFileSync(resolve(CLIENT_RESOURCE_ROOT, "fxdynmapinfo.ssd")));
    const canonical = loadClientResources().ssdFiles.fxdynmapinfo;

    try {
      writeFileSync(legacyPath, legacyRawFile);
      const upgraded = loadSsdEntry(tempRoot, "fxdynmapinfo.ssd");
      expect(upgraded.diskAdler32Zero).toBe(0x8a065068); // checked-in file's disk-body checksum
      expect(upgraded.adler32Zero).toBe(computeSmartStreamBodyChecksum(upgraded.streamContainer));
      expect(upgraded.decompressed).toEqual(canonical.decompressed);
      expect(upgraded.entryCount).toBe(871);
      expect(() => transcodeDynamicMapInfoToV22(canonical.decompressed)).toThrow();

      const truncatedBody = canonical.decompressed.subarray(0, canonical.decompressed.length - 1);
      const malformedContainer = new SmartStreamWriter().writeRaw(truncatedBody).toSmartStreamBuffer(true);
      const malformedPath = join(tempRoot, "malformed-v22.ssi1");
      writeFileSync(malformedPath, makeClientFormatSsi1(malformedContainer));
      const malformedRoot = mkdtempSync(join(tmpdir(), "bnb-client-cache-malformed-"));
      try {
        writeFileSync(join(malformedRoot, "fxdynmapinfo.ssd"), readFileSync(malformedPath));
        expect(() => loadSsdEntry(malformedRoot, "fxdynmapinfo.ssd")).toThrow(
          /Invalid fxdynmapinfo\.ssd payload: matches neither the CA\.exe v22 layout.*pre-v22 layout/
        );
      } finally {
        rmSync(malformedRoot, { recursive: true, force: true });
      }

      const badChecksum = makeClientFormatSsi1(canonical.streamContainer);
      badChecksum[4] = badChecksum[4]! ^ 0x01;
      writeFileSync(legacyPath, badChecksum);
      expect(() => loadSsdEntry(tempRoot, "fxdynmapinfo.ssd")).toThrow(/ssi1 checksum mismatch/);

      writeFileSync(legacyPath, new Uint8Array());
      expect(() => loadSsdEntry(tempRoot, "fxdynmapinfo.ssd")).toThrow(/is missing or empty/);
      writeFileSync(join(tempRoot, "fxstock.ini"), new Uint8Array());
      expect(() => loadSsdEntry(tempRoot, "fxstock.ini")).toThrow(/is missing or empty/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
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

describe("fxdynmapinfo map-ID normalization for the served S->C 205/207 stream", () => {
  test("remaps v34 map IDs into the local CGameMapInfoList index space by map name", () => {
    const resources = loadClientResources();
    const catalog = resources.dynamicMapInfo;

    expect(catalog.entries.length).toBe(871);
    // The checked-in file's map-ID field is a foreign content catalog's index space
    // (e.g. wire ID 644 = "Monster15", which is local map 216); the served stream must
    // remap it so C->S 87 / S->C 109 / S->C 113 all agree on `CGameMapInfoList[mapId]`.
    expect(catalog.normalization.idSpaceMismatched).toBe(true);
    expect(catalog.normalization.remappedByName).toBeGreaterThan(300);

    const monster15 = catalog.byWireMapId.get(644)!;
    expect(monster15.name).toBe("Monster15");
    expect(monster15.rawMapId).toBe(0x00030284); // disk v34 (hi16 = 3, lo16 = 644)
    const localMonster15 = resources.mapsByName.get("monster15")!;
    expect(monster15.kind).toBe("map");
    expect(monster15.servedMapId).toBe(localMonster15.mapId);
    expect(monster15.resolvedMapId).toBe(localMonster15.mapId);

    // Random selectors normalize to the exact u32 that matches the u16 wire sentinel,
    // since `sub_4DE509` compares the full v32 value against the received u16.
    const campRandom = catalog.entries.find((entry) => entry.name === "CampRandom")!;
    expect(campRandom.kind).toBe("random");
    expect(campRandom.rawMapId).toBe(0x0001ffff);
    expect(campRandom.servedMapId).toBe(0x0000ffff);

    // Entries whose maps are absent from the local Fx.idx cannot be played; they leave
    // map selection (v29 = 0) instead of silently mis-resolving to some other map.
    const unresolved = catalog.entries.filter((entry) => entry.kind === "unresolved");
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((entry) => entry.selectable === 0)).toBe(true);
    expect(unresolved.every((entry) => entry.servedMapId === entry.rawMapId)).toBe(true);

    // The served stream advertises a new body checksum, so clients with the on-disk
    // cache re-fetch through C->S 282 -> S->C 205 and pick up the remapped IDs.
    expect(catalog.served.adler32Zero).not.toBe(resources.ssdFiles.fxdynmapinfo.adler32Zero);
    expect(catalog.served.adler32Zero).toBe(
      computeSmartStreamBodyChecksum(catalog.served.streamContainer)
    );
    expect(catalog.served.entryCount).toBe(871);

    // Re-normalizing the served stream is a fixed point: every name-resolved entry
    // already carries its local map-list index.
    const renormalized = buildDynamicMapInfoCatalog(catalog.served, resources.mapsByName);
    expect(renormalized.normalization.idSpaceMismatched).toBe(false);
    expect(renormalized.normalization.remappedByName).toBe(catalog.normalization.remappedByName);
    expect(
      renormalized.entries.every((entry, i) => entry.servedMapId === catalog.entries[i]!.servedMapId)
    ).toBe(true);
  });

  test("resolves wire map IDs with catalog names for foreign-ID diagnostics", () => {
    const resources = loadClientResources();
    const localMonster15 = resources.mapsByName.get("monster15")!;

    expect(resolveDynamicMapId(resources, localMonster15.mapId)).toEqual({
      kind: "map",
      mapId: localMonster15.mapId,
      mapName: "Monster15",
    });
    expect(resolveDynamicMapId(resources, 0xffff)).toEqual({ kind: "random" });

    // Foreign catalog IDs are rejected but carry their fxdynmapinfo identity so the log
    // can say which map the client actually asked for.
    const foreign = resolveDynamicMapId(resources, 644);
    expect(foreign.kind).toBe("unknown");
    expect(foreign).toMatchObject({
      catalogEntryName: "Monster15",
      catalogRawMapId: 0x00030284,
    });

    // A raw full-width v34 (C->S 93 field1 form) diagnoses the same entry.
    const fullWidth = resolveDynamicMapId(resources, 0x00030284);
    expect(fullWidth).toMatchObject({ kind: "unknown", catalogEntryName: "Monster15" });

    // Out-of-range IDs that exist in the raw catalog still explain themselves.
    const firstInvalid = resources.mapList.length;
    const knownForeign = resolveDynamicMapId(resources, firstInvalid);
    if (knownForeign.kind === "unknown" && knownForeign.catalogEntryName !== null) {
      expect(knownForeign.catalogEntryName.length).toBeGreaterThan(0);
    }
  });
});

describe("fxstock.ini -> CUserItemMan catalog (S->C 197 UserItemsData)", () => {
  test("parses the served v22 fxstock body and derives one record per +104 key", () => {
    const resources = loadClientResources();
    const body = resources.ssdFiles.get("fxstock.ini")!.decompressed;
    const rows = parseFxStockCatalog(body);
    expect(rows.length).toBe(1461);

    const catalog = buildUserItemCatalog(rows);
    expect(catalog.length).toBe(1096);
    expect(new Set(catalog.map((r) => r.field0x08U32)).size).toBe(1096);
  });

  test("icon field derivation follows UserItem::sub_5971F6 type branches", () => {
    const resources = loadClientResources();
    const rows = parseFxStockCatalog(resources.ssdFiles.get("fxstock.ini")!.decompressed);
    const catalog = buildUserItemCatalog(rows);
    const byKey = new Map(catalog.map((r) => [r.field0x08U32, r]));

    // cat 2 ticket: path-is-name type -> icon = the fxstock +128 path verbatim
    const roomTicket = byKey.get(10005)!;
    expect(roomTicket.field0x14U8).toBe(2);
    expect(roomTicket.field0x20String).toBe("Item/RoomTicket");

    // Pure cat-5 keys (19..23) keep type 5; icon = "Item/LevelIcon00X" verbatim.
    const levelIcon = byKey.get(19)!;
    expect(levelIcon.field0x14U8).toBe(5);
    expect(levelIcon.field0x20String).toBe("Item/LevelIcon003");

    // Keys shared by a cat-11 set row and a cat-5 row resolve to the first row's type;
    // type 11 has no icon builder, so the shop draws each row's own +128 set icon.
    const sharedSetKey = byKey.get(16)!;
    expect(sharedSetKey.field0x14U8).toBe(11);

    // cat 9 premium ticket: empty-path type -> the shop falls back to the row's own +128
    const premium = byKey.get(10000)!;
    expect(premium.field0x14U8).toBe(9);
    expect(premium.field0x50U32).toBe(0);

    // cat 3 emoticon: +0x38 = set index from off_91C1C0, +0x50 forces the set-image fallback
    const specialEmoticon = byKey.get(20158)!;
    expect(specialEmoticon.field0x14U8).toBe(3);
    expect(specialEmoticon.field0x38U32).toBe(7); // Shop/EmotSpecial
    expect(specialEmoticon.field0x50U32).toBe(9999);

    // cat 18 ID decoration resolves "Icon/ItemIDdeco_C001" through the type-18 builder
    const idDeco = byKey.get(10011)!;
    expect(idDeco.field0x14U8).toBe(18);
    expect(idDeco.field0x38U32).toBe(1);

    // cat 11 set rows share few keys and keep type 11 (no builder -> per-row +128 icon)
    const setRows = catalog.filter((r) => r.field0x14U8 === 11);
    expect(setRows.length).toBe(4);
  });

  test("trims stray control bytes from path-is-name icon names", () => {
    const rows = parseFxStockCatalog(
      loadClientResources().ssdFiles.get("fxstock.ini")!.decompressed
    );
    const catalog = buildUserItemCatalog(rows);
    for (const record of catalog) {
      if (record.field0x14U8 === 2 || record.field0x14U8 === 5 || record.field0x14U8 === 15) {
        expect(record.field0x20String).not.toMatch(/[\x00-\x20]$/);
      }
    }
  });

  test("builds the S->C 197 body the client's sub_598BEC reads", () => {
    const resources = loadClientResources();
    const rows = parseFxStockCatalog(resources.ssdFiles.get("fxstock.ini")!.decompressed);
    const catalog = buildUserItemCatalog(rows);
    const packet = buildUserItemRecordsPacket(catalog);
    expect(packet.opcode).toBe(ServerOpcode.UserItemsData);
    // 2-byte opcode + u16 count + 1096 records of fixed-width fields and two strings.
    expect(packet.toPayload().length).toBe(36988);
  });
});
