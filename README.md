# CrazyArcade (BnB Taiwan v22) — Faithful Client-to-Server Reconstruction

A byte-accurate, end-to-end server implementation for the **CrazyArcade (爆爆王 / 泡泡堂) Taiwan v22** client (`CA.exe`), reverse-engineered directly from the IDA Pro / Hex-Rays decompilation (`CA.exe.c`), the PE32 `.rdata` virtual function tables of `CA.exe`, and the client resource archives (`Fx.idx`/`Fx.idd`, `CharTE.idx`/`CharTE.idd`, `EmoTE.idx`/`EmoTE.idd`, `*.ssd`, `*.ini`).

---

## Architecture & Highlights

- **Runtime & Modern Stack**: TypeScript (`ESNext`) + [Bun](https://bun.sh) (`Bun.listen` TCP + `Bun.udpSocket` UDP + `Bun.deflateSync` / `Bun.inflateSync` + `bun:sqlite` SQLite persistence with `strict: true`, WAL pragmas, `RETURNING *` queries, and Explicit Resource Management `using` / `await using` via `[Symbol.dispose]()` / `[Symbol.asyncDispose]()`).
- **Default Ports (`CA.exe` Confirmed)**:
  - **Login / Unified Server TCP**: `3838` (`sub_5D6839`: `n3838 = 3838`)
  - **UDP Peer / Relay Port**: `3839` (`tcpPort + 1`, `CLoginStage::sub_565CC6`)
  - **GameServer Default TCP**: `9339` (`sub_5A9E45` / `sub_5D8B10`)
  - **Messenger Default Port**: `8339` (`S->C 11` `sub_567B0F`)
- **Wire Protocol & Cryptography (`0x00668DE0`–`0x0069A120`)**:
  - **CRC**: `CCRC32` (`sub_668E80`, MSB-first poly `0x04C11DB7`), `CCRC8` (`sub_668F90`, MSB-first poly `0x07`), and `sub_658610` (`0x00658610`, Adler-32 with initial seed `0`).
  - **Degree `0` (`CSendPacketUDP` `0x0057B6FA` & Connect Hello)**: Unscrambled Big-Endian primitives; Connect Hello first byte substituted via the 4,096-byte `byte_924D10` table extracted from `CA.exe` (`0x00524D10`).
  - **Degree `2` (C->S TCP, `N+5` bytes) & Degree `3` (S->C TCP, `N+7` bytes)**: Sequence byte (`c1=0x66, c2=0xC0, c3=0xE7, counter=40, step=3`), XORed BE primitives (`u8^0x5A`, `u16^0xA569`, `u32^0x96CA5395`, `u64` hi32 BE + lo32`^0x71B18589`, `block` scrambler `sub_6692F0`, `keyedStr` `sub_6956E0`, `8B f64 LE` OLE `VariantTime` `sub_697640`, `16B` Win32 `SYSTEMTIME` `sub_5C7EAE`), chained 32-bit stream cipher (`sub_695B00`/`sub_695BA0`), and trailing `CCRC8`.
  - **`COSmartStream` / `CISmartStream` (`0x006983F0`–`0x006997B0`)**: `[0x18][u32 LE bodySize][mode (0=raw, 1=zlib)]` container with **Little-Endian** internal primitives (`u8`, `u16 LE`, `u32 LE`, `str` = `u32 LE len` + bytes) and `"ssi1"` (`sub_699410`) Adler-32 seed-0 verification.
  - **UDP `MTUDPPeer` (`0x005EBFA0`)**: `[u8 L = 1 + innerLen][inner (deg 0)][u8 CRC8(0, frame[0..L-1])]`, supporting 6B server keepalive (`opcode 0` -> `1B opcode 4`), 36B game load registration (`sub_4ED400` `opcode 1` -> `S->C 136` + `S->C 135`), and P2P/relay gameplay inner opcodes `0..4` (`CGameStage::sub_4ECF93`).
- **Client Resource Decryption & All 12 `.ssd` / `.ini` Streams (`src/resources/archive.ts`)**:
  - Decrypts `Fx.idx` (`3,948` entries, seed `0x719CAB30`), `CharTE.idx` (`3,046` entries), and `EmoTE.idx` (`3,005` entries, seed `0x05B201FC`) (`sub_673110` / `sub_6731A0`).
  - Parses all `319` `"Map/*"` entries in exact `Fx.idx` order (`CGameMapInfoList::sub_4E8597`) with 5-byte headers and map CRC8 (`sub_4E5845`), plus `Attr/MapGroup` (`PraticeMapGroup`, `LadderMapGroup`, `ReBirthMapGroup`) and `XML/init`.
  - Parses `Attr/BomberAttr` (`11` characters) and `Attr/ItemAttr` (items & rides).
  - Loads, synthesizes, and transcodes all **12 `"ssi1"` `.ssd` and `.ini` streams** (`fxdynimginfo.ssd`, `csysstr.ssd`, `multisvr.ssd`, `multisvrn.ssd`, `filterstr.ssd`, `channel2_001.ssd`, `fxdynmapinfo.ssd`, `esfn.ssd`, `fxstock.ini`, `stringtable.ini`, `packagemap.ini`, `qmarksfn.ssd`), verified with `remaining === 0` against every `CA.exe` v22 parser.
- **Complete Stage & Subsystem Implementation (`100%` of all `174/174` `C->S` Opcodes in `CA.exe`)**:
  - **Pre-Login, Auth, Registration, E-Key & Channel Select**: `CLoginStage` (`Stage 1`), `CAgreementStage` (`Stage 8`), `COnePageIDStage` (`Stage 9`), `CSelectServerStage` (`Stage 10`), `CNCPasswordDlg` (`C->S 46`), `CEKeyDlg` (`C->S 32, 33`).
  - **Lobby, Room, Exchange & Full Match Gameplay (`CGameStage` `107..153`)**: `CLobbyStage` (`Stage 11`), `CPrepareStage` (`Stage 12`), `CGameStage` (`Stage 13`, all 45 in-game opcodes `107..150, 153` including bombs, items, push/throw/remote bombs, revival/ghost, NPC/Boss AI, `CSyncGameObjectMan` `S->C 175..177`, UDP relay fallback `C->S 149 -> S->C 125`), `CChattingStage` (`Stage 17`), `CExchangeStage` (`Stage 18`), `CPrepareStagePractice` (`Stage 19`).
  - **Inventory, Shop, Gachapon, Basket & UserMarket**: `CUserInventoryMan` (`S->C 63, 188, 194, 196, 197, 203, 268`), `CShopStageNew` (`Stage 14`, `CShopDlg`, `CShopGiftSendDlg`, `CShopCouponDlg`, `CShopTextDlg`, `CGachaponDlg` `S->C 255/257`, `CBasketDlg` `S->C 258/259/260`), and `CUserMarketStage` (`Stage 20`, `CMarketSlotWnd`, `CChangeLucciDlg`, `S->C 262, 265, 269..280`).
  - **Ranking, Profile, Quests, Social & Persistent Features**: `CRankMan` (`C->S 64, 296, 311` -> `S->C 66, 69, 240, 256` via `sub_4A4FBD`), `CMyInfoDlg` & `CQuestWnd` (`C->S 44, 65..70, 289..293, 302` -> `S->C 34, 70, 71, 81, 220..222, 248`), `CSmsDlg` (`297..300` -> `242..246`), `CCouple` (`250, 304..306` -> `251..254`).

---

## Project Layout

```text
├── docs/
│   ├── evidence.md      # Binary, archive, vtable, .ssd/.ini & function address evidence map
│   ├── packets.md       # Complete C->S and S->C packet catalog with byte schemas
│   ├── states.md        # Socket, stage, room & match state machine specifications
│   ├── coverage.md      # Client-to-server subsystem & opcode coverage matrix
│   └── unknowns.md      # Confirmed resolutions, inferred formulas & external notes
├── src/
│   ├── config/          # Server ports (3838/3839) & Taiwan region feature flags
│   ├── protocol/        # Typed opcodes, CRC32/CRC8/Adler32Zero, cipher, primitives, SmartStream, TCP/UDP framing
│   ├── resources/       # Fx.idx/Fx.idd decrypter, .i16 parser, CGameMapInfoList & all 12 .ssd/.ini streams
│   ├── db/              # bun:sqlite persistence & exact Lv 1..400 EXP curve (sub_4A49D5)
│   ├── state/           # WorldState, ClientSession, GameRoom, RoomSlot, ChannelInfo
│   ├── handlers/        # Stage packet handlers (Auth, Channel, Lobby, Room, Game, Shop, Common)
│   ├── network/         # CrazyArcadeServer (Bun TCP & UDP listeners, Disposable / AsyncDisposable)
│   └── index.ts         # CLI entrypoint
└── tests/
    ├── protocol.test.ts # Unit tests for CRC, cipher, byte_924D10, primitives, SmartStream & framing
    ├── resources.test.ts# Archive decryption, 319 maps, BomberAttr, ItemAttr & all 12 .ssd/.ini stream tests
    └── flow.test.ts     # Full 2-player E2E stage/match/UDP/shop/stream loop & live TCP/UDP socket test
```

---

## Quick Start

### 1. Run the Server
```bash
bun start
```
By default, the server listens on TCP `0.0.0.0:3838` and UDP `0.0.0.0:3839` and stores data in `bnb_tw22.db`.

### 2. Run the Automated Test Suite & Typecheck
```bash
bun test
bun run typecheck
```
