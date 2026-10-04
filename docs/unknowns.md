# CrazyArcade (BnB TW v22) — Unknowns, Hypotheses & Confidence Log

## 1. Classification Legend
- **`Confirmed`**: Directly proven by client binary (`CA.exe`), IDA decompilation (`CA.exe.c`), `.rdata` virtual function tables, and/or decrypted client resource archives (`Fx.idx`/`Fx.idd`, `.ssd`, `.ini`).
- **`High-Confidence Inferred`**: Server-side formula or state transition not present in client code, but tightly constrained by client packet readers/writers and UI expectations.
- **`Needs Live Validation`**: External/backend behaviors (such as third-party billing gateways or server-only anti-cheat heuristics) that cannot be observed from the client binary alone.

---

## 2. Resolved Reverse-Engineering Items (`Confirmed`)

| ID | Topic | Resolution & Evidence Anchor |
|---|---|---|
| `RE-01` | **2-Byte Opcode vs 1-Byte Opcode** | **Confirmed 2-Byte (`u16`)**: `CSendPacketBase` (`0x00695D70`) writes `op` via `sub_695650` (`u16`), and all `OnPacket` handlers (`CLobbyStage::sub_4C86A2`, `CPrepareStage::sub_4DCF07`, `CGameStage::sub_4F672F`, `CShopStageNew::sub_53C550`, `CGameStage::sub_4ECF93`) read the opcode via `sub_697510` (`GetShort`), advancing `pkt[7]` from `0` to `2`. |
| `RE-02` | **Connect Hello `byte_924D10` Constraint** | **Confirmed**: `CReceivedPacketConnect::Decrypt` (`sub_696F60`) indexes `byte_924D10[256 * key + payload[0]]` (`16 x 256` table at VA `0x00924D10`, file offset `0x00524D10`), requiring initial `key` encoded in `frame[0]` to be in `0..15`. |
| `RE-03` | **`rxCounter` Double Step on Connect Hello** | **Confirmed**: Both `sub_699C50` (length phase) and `sub_699D60` (payload phase) execute `rxCounter += rxStep` (`+3`) during `deg == 0` Connect Hello, advancing `rxCounter` from `40 -> 43 -> 46` before the first `deg == 3` packet. |
| `RE-04` | **Map List Indexing (`CGameMapInfoList`) & Map CRC8** | **Confirmed**: `sub_4E8597` (`0x004E8597`) loads all 319 `"Map/*"` entries from `Fx.idx` in exact archive index order (`0..318`), parses the 5-byte header (`u16 LE tileSet, u8 maxPlayer, u8 maxTeam, u8 flag`), computes `crc8 = CCRC32::sub_668E80(0, buf, size) & 0xFF` (`sub_4E5845`), and `sub_4D9F8A` (`S->C 113`) validates `strncmp(mapName, CGameMapInfoList[mapId].name, strlen(mapName)) == 0`. |
| `RE-05` | **`COSmartStream` / `CISmartStream` Little-Endian Primitives & `sub_658610`** | **Confirmed**: While `CPacket` (`deg 0..3`) uses Big-Endian (`htons`/`htonl`), `COSmartStream`/`CISmartStream` (`sub_698B80`–`sub_6997B0`) writes/reads native x86 Little-Endian (`u16 LE`, `u32 LE`, `str`=`u32 LE len` + bytes). `sub_658610` (`0x00658610`) is Adler-32 with initial seed `0`; `"ssi1"` files (`sub_699410`) store `adler32Zero(container)` at offset `4..8`, while `CSmartStream::sub_6984B0` computes `adler32Zero(body)` for `C->S 0, 252, 294, 305`. |
| `RE-06` | **`CSendPacket` (`deg=2`) vs `CSendPacketUDP` (`deg=0`) & UDP Load Registration** | **Confirmed**: `CSendPacket` (`0x0057B5A4`) sets `deg=2` (XORed BE), whereas `CSendPacketUDP` (`0x0057B6FA`) sets `deg=0` (plain BE). During `CGameStage` loading, `sub_4ED400` (`0x004ED400`) sends a 36-byte UDP packet (`opcode = 1`) every 1s until the server replies with `S->C 136` (`sub_4EA206`) or `S->C 135` (`sub_4F2065`). |
| `RE-07` | **Exact `.rdata` Vtable Dispatch Targets (`CPrepareStage`, `CGameStage`, `CLobbyStage`)** | **Confirmed**: Extracted the `.rdata` vtables of `CPrepareStage` (`0x007A7C68`), `CGameStage` (`0x007A8FC8`), `CLobbyStage` (`0x007A6808`), and `CNormalLobbyStrategy` (`0x007A6D80`) directly from `CA.exe` to resolve every virtual `OnPacket` call (`*(*this + offset)`). |
| `RE-08` | **Level EXP Curve (`sub_4A49D5`)** | **Confirmed**: Extracted the exact piecewise formula in `sub_4A49D5` (`0x004A49D5`) for levels `1..400`. |
| `RE-09` | **All 12 `.ssd` & `.ini` Stream Schemas and Pre-v22 Disk Transcoding** | **Confirmed**: Traced all 12 `"ssi1"` / `CISmartStream` parsers in `CA.exe` (`sub_49DF97`, `sub_5CFE6C`, `sub_5D782C`, `sub_5D79AE`, `sub_5C89D7`, `sub_5D3D3F`, `sub_4DFE20`, `sub_5CA523`, `sub_588ED2`, `sub_594136`, `sub_5886A9`, `sub_5B9743`). Verified that `fxstock.ini` (32B -> 33B tail), `fxdynmapinfo.ssd` (16B -> 18B tail), and `esfn.ssd` (25B -> 21B) on disk are pre-v22 snapshots that the client upgrades via `C->S 276 -> S->C 193`, `C->S 338 -> S->C 207 -> C->S 282 -> S->C 205`, and `S->C 113`. All 12 streams parse with `remaining === 0`. |
| `RE-10` | **OLE Automation `DATE` (`VariantTime`) & Win32 `SYSTEMTIME` Wire Encoding** | **Confirmed**: `CUserInventoryMan::sub_594ECF`, `CShopDlg::sub_52DA5E`, and `CMarketSlotWnd::sub_50EE32` read `8B` `f64 LE` OLE `VariantTime` via `sub_697640(..., 8)` and convert it via `VariantTimeToSystemTime` (`sub_5BF9BA`). `CExchangeStage::sub_558142` and `sub_55D805` write/read `16B` Win32 `SYSTEMTIME` (`8 * u16 LE`) via `sub_695640(..., 16)` / `sub_697640(..., 16)` (`sub_5C7EAE`). |
| `RE-11` | **`CUserInventoryMan`, `CShopStageNew`, `CUserMarketStage`, `CExchangeStage`, `CSmsDlg` & `CCouple` Wire Schemas** | **Confirmed**: Traced all handlers in `CUserInventoryMan` (`sub_595F5D`, `sub_595FA9`, `sub_595FF8`, `sub_597611`, `sub_58DFE6`), `CShopStageNew` (`sub_53C550`, `sub_53885C`), `CShopDlg` (`sub_58EAEF`, `sub_541682`, `sub_58BFE0`), `CGachaponDlg` (`sub_5C23DB`), `CBasketDlg` (`sub_5C261E`, `sub_5C0289`), `CUserMarketStage`/`CMarketSlotWnd` (`sub_5756B8`, `sub_572FA4`, `sub_4BB408`, `sub_4BC642`), `CExchangeStage` (`sub_55C714`), `CSmsDlg` (`sub_484465`), and `CCouple` (`sub_5BBF91`). |
| `RE-12` | **`100%` `C->S` Opcode Coverage (`174/174`), `CRankMan`, `CMyInfoDlg` & Full `CGameStage` (`107..153`)** | **Confirmed**: Extracted and verified all 174 `C->S` opcodes sent anywhere in `CA.exe` (`CSendPacket` / `sub_57B68E`), all `CStage::OnPacket` (`sub_4BDBF5`) sub-dispatchers (`sub_5E3AC9`, `sub_52AEAE`, `sub_5B8A56`, `sub_5C279C`, `sub_5BC451`), `CRankMan` (`sub_4A4FBD`–`sub_4A527F` for `S->C 66, 69, 240, 256`), `CMyInfoDlg` (`S->C 71, 81, 220..222, 248`), and all 45 `CGameStage::sub_4F672F` (`0x004F672F`) in-game opcodes (`107..150, 153`). |

---

## 3. Server-Side Formulas & Heuristics (`High-Confidence Inferred`)

| ID | Subsystem | Client Constraint | Server Reconstruction Choice | Confidence |
|---|---|---|---|---|
| `INF-01` | **Match EXP & Lucci Reward Amounts (`CGameStage::sub_4F2F8B`)** | Client reads `u32 expDelta`, `u32 totalExp`, `u32 totalLucci` (`S->C 148` `CGOGameResult::sub_455957`) and levels `1..400` via `sub_4A49D5`. | Awards configurable EXP (`50 + kills*10` win, `10 + kills*5` loss, `15` draw) and Lucci (`100 + kills*20` win, `25` loss, `20` draw) and advances level via `sub_4A49D5`. | `High-Confidence Inferred` |
| `INF-02` | **Block Drop RNG (`CGameStage::sub_4F1525` / `S->C 149`)** | Client reads `Attr/Map` tile item counts and sends `C->S 127`/`131` with item IDs sampled from `CGameContext`, expecting `S->C 149` (`sub_4F24A6`) / `S->C 151` (`sub_4EA106`) to broadcast spawned items with item type IDs matching `CItemAttrMan`. | Server validates and broadcasts requested item spawns from `C->S 127`/`131` into `S->C 149`/`151` using the exact item type IDs from `Attr/ItemAttr`. | `High-Confidence Inferred` |
| `INF-03` | **Unified vs Split Port Topology (`CMultiServer`)** | `S->C 7` (Channel handoff) and `S->C 48` (Shop handoff) provide `(ip, port, token)` and the client connects a socket and sends `C->S 6` or `C->S 38`. | Server supports both single-port unified handoff (`3838` TCP / `3839` UDP) and configurable multi-port deployment. | `Confirmed` (Client-compatible) |

---

## 4. Items Needing Live / External Validation (`Needs Live Validation`)

| ID | Feature | Notes |
|---|---|---|
| `EXT-01` | **Gash / Cash Web Top-Up (`sub_5CEA88` / Web Dialogs)** | Taiwan client launches external browser URLs for Gash point top-up; our server persists `cash` directly in SQLite (`users.cash`) with configurable initial balance. |
| `EXT-02` | **External Messenger Server (`CMessenger`, port `8339`)** | `S->C 11` (`sub_567B0F`) provides the messenger IP and port (`8339`); in-game and lobby chat/whisper (`CChatStage::sub_4B0A63`) operate directly over the main game TCP connection. |
