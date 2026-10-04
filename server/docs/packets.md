# CrazyArcade (BnB TW v22) — Complete Packet Catalog

## 1. Wire Framing, Cryptography & Primitive Encoding (` Confirmed `)

### 1.1 TCP Socket State (`CPacketSocket`, `0x005D82E1`, `0x00699B10`)

Upon `connect()`, `CPacketSocket` initializes with:
- `deg = 0`, `key = 0`, `hasKey = 0`
- `c1 = 0x66`, `c2 = 0xC0`, `c3 = 0xE7`
- `rxCounter = 40`, `txCounter = 40`, `rxStep = 3`, `txStep = 3`

#### Sequence Byte (`frame[0]`)
- **First S->C frame (Connect Hello, `deg = 0`, `hasKey = 0`)**:
  - Client extracts initial `key` from `frame[0]` (`sub_699AB0`):
    `key = (u8)((frame[0] ^ (c1 + (u8)rxCounter)) - c3)`
  - Sets `hasKey = 1`.
  - `CReceivedPacketConnect` is handled by `CPacketSocket::sub_699D60`, which advances the S->C receive counter exactly once: `rxCounter += rxStep` (`40 -> 43`). The first subsequent S->C degree-3 packet uses 43, then advances to 46.
  - Because `sub_696F60` (`CReceivedPacketConnect::Decrypt`) indexes `byte_924D10[256 * key + payload[0]]` (`16 x 256` table at VA `0x00924D10`, file offset `0x00524D10`), initial `key` MUST be in `0..15` (e.g., `key = 1` -> `frame[0] = ((1 + 0xE7) ^ (0x66 + 40)) & 0xFF = 0x68`).
- **Subsequent S->C frames (`deg = 3`, `hasKey = 1`)**:
  - Client verifies `frame[0] == (u8)(((u8)key + c3) ^ (c1 + (u8)rxCounter))`
  - `rxCounter += rxStep` (`+3` per packet).
- **C->S frames (`deg = 2`)**:
  - Client writes `frame[0] = (u8)(((u8)key + c3) ^ (c2 + (u8)txCounter))`
  - `txCounter += txStep` (`+3` per packet).

#### Frame Layouts by Degree (`deg`)
1. **Degree 0 (`CReceivedPacketConnect`, S->C Connect Hello, `N + 3` bytes)**:
   - `frame[0]`: Sequence byte (encodes initial `key` in `0..15`)
   - `frame[1..2]`: `u16 BE` payload length `N` (unscrambled)
   - `frame[3..3+N-1]`: Connect Hello payload (`payload[0]` = `byte_924D10` inverse lookup of `plain[0]`)
2. **Degree 2 (`CSendPacket` at `0x0057B5A4`, C->S TCP packets, `N + 5` bytes)**:
   - `frame[0]`: Sequence byte
   - `frame[1]`: Random pad byte
   - `frame[2..3]`: `(N ^ 0xA569)` in Big-Endian (`u16 BE`)
   - `frame[4..4+N-1]`: Stream-cipher encrypted payload (`sub_695B00(txCounter, cipher, plain, N)`)
   - `frame[4+N]`: `CCRC8::Compute((u8)txCounter, plain, N)`
3. **Degree 3 (`CReceivedPacketBase`, S->C TCP packets, `N + 7` bytes)**:
   - `frame[0]`: Sequence byte
   - `frame[1]`: Random pad byte
   - `frame[2..5]`: `(N ^ 0x96CA5395)` in Big-Endian (`u32 BE`)
   - `frame[6..6+N-1]`: Stream-cipher encrypted payload (`sub_695B00(rxCounter, cipher, plain, N)`)
   - `frame[6+N]`: `CCRC8::Compute((u8)rxCounter, plain, N)`

#### Payload Stream Cipher (`sub_695B00` / `sub_695BA0`)
- Given `counter` (`txCounter` or `rxCounter` before the post-frame `+3` step) and plaintext `src[0..N-1]`:
  - `k = (counter ^ 0x53351D9C) >>> 0`
  - `words = Math.floor(N / 4)`
  - If `words > 0`:
    - `dstU32LE[0] = (k ^ srcU32LE[0]) >>> 0`
    - For `i = 1 .. words - 1`:
      - `k = (k - 0x63CAACE3) >>> 0` (decompilation: decimal `1674226915`; CA.exe immediate at `0x00695B46` / `0x00695BE7`)
      - `dstU32LE[i] = (k ^ srcU32LE[i] ^ srcU32LE[i - 1]) >>> 0`
    - `tailKey = srcU32LE[words - 1]`
  - Else (`words == 0`):
    - `tailKey = k`
  - Remaining `N % 4` tail bytes at `offset = words * 4`:
    - `dst[offset + b] = src[offset + b] ^ ((tailKey >>> (8 * b)) & 0xFF)`

---

### 1.2 Primitive Data Types (`0x006691A0`–`0x006694D0`, `0x00695630`–`0x00698350`)

| Primitive | Reader (`CReceivedPacketBase`) | Writer (`CSendPacket`) | Deg 1..3 Wire Encoding (`CSendPacket`) | Deg 0 Wire Encoding (`CSendPacketUDP`) |
|---|---|---|---|---|
| `u8` / `i8` | `sub_6974B0` | `sub_695630` | `val ^ 0x5A` (`1` byte) | Raw `u8` |
| `u16` / `i16` | `sub_697510` | `sub_695650` | `u16 BE` of `(val ^ 0xA569)` (`2` bytes) | `u16 BE` |
| `u32` / `i32` | `sub_697580` | `sub_695670` | `u32 BE` of `(val ^ 0x96CA5395)` (`4` bytes) | `u32 BE` |
| `u64` / `i64` | `sub_6975F0` | `sub_6956A0` | `u32 BE(hi32)` + `u32 BE(lo32 ^ 0x71B18589)` (`8` bytes) | `u32 BE(hi32)` + `u32 BE(lo32)` |
| `block(len)` | `sub_697640` | `sub_695640` | 4B chunks: `u32 BE(u32LE ^ 0x96CA5395)`; 2B chunk: `u16 BE(u16LE ^ 0xA569)`; 1B chunk: `b ^ 0x5A` | Raw `len` bytes |
| `str` | `sub_698270` | `sub_6956C0` | `u16(len)` + `block(len)` | `u16 BE(len)` + raw `len` bytes |
| `keyedStr` | `sub_698290` | `sub_6956E0` | `u16(len)` + `sub_669310(bytes, len, customKey)` | `u16 BE(len)` + raw `len` bytes |
| `VariantTime` (`DATE`) | `sub_697640(..., 8)` | `sub_695640(..., 8)` | `block(8)` containing `f64 LE` OLE Automation `DATE` (`unixMs / 86_400_000 + 25569.0`, permanent `> 2080-01-01`) | Raw `8` bytes (`f64 LE`) |
| `SYSTEMTIME` | `sub_697640(..., 16)` | `sub_695640(..., 16)` | `block(16)` containing `8 * u16 LE` (`wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds`) (`sub_5C7EAE`) | Raw `16` bytes (`8 * u16 LE`) |
| `stream` | `sub_697660` | `sub_695740` | `u32(len)` + `block(len)` containing `COSmartStream` | `u32 BE(len)` + raw `len` bytes |

- In the Taiwan region (`regionId = 8`), protocol `str` and SmartStream string data are CP950/Big5 ANSI bytes. The length fields count the encoded byte length; ASCII-only tests cannot detect a UTF-8-vs-CP950 mismatch.
- **Inside `COSmartStream` / `CISmartStream` (`0x006983F0`–`0x006997B0`)**:
  - Container header: `byte[0] = 0x18`, `byte[1..4] = u32 LE bodySize`, `byte[5] = mode` (`0` = raw, `1` = `u32 LE uncompressedLen` + zlib stream).
  - Internal stream primitives (`sub_698B80`–`sub_6997B0`) use **native x86 Little-Endian** (`u8`, `u16 LE`, `u32 LE`, `str` = `u32 LE len` + raw bytes). For Taiwan region 8, string bytes are CP950/Big5 ANSI; lengths count encoded bytes (not Unicode characters).
  - `CSmartStream::sub_6984B0` (`0x006984B0`) computes `sub_658610(0, body, bodySize)` (Adler-32 with initial seed `0` over `container[5..5+bodySize]`).
  - `"ssi1"` files (`sub_699410` at `0x00699410`) begin with `["ssi1" (4B)][u32 LE adler32Zero(container)][COSmartStream container]`.

---

## 2. Connect Hello & Pre-Login SSD/INI Sync (` Confirmed `)

| Opcode | Dir | Handler | Exact Payload Schema (After Opcode) | Effects & Notes |
|---|---|---|---|---|
| *(Connect Hello)* | S->C | `CClientSocket::sub_5D86DD` (`0x005D86DD`) | *(Deg 0, no opcode)* `u8` flag(`0`), `i16` minVer(`22`), `i16` curVer(`22`), `u32` sessionKey, `str` noticeUrl, `u8` extraFlag(`0`) | `payload[0]` encoded via `byte_924D10[256 * initKey + plain[0]]`. Upgrades socket to `deg = 3` (Rx) / `deg = 2` (Tx) with `key = sessionKey`. |
| `0` (`0x0000`) | C->S | `CFxApp::sub_5A1E40` (`0x005A1E40`) | `u32` dynamic-image cache context (`dword_92AAF8[2]`; constructor `sub_49DDAB` initializes it to `0`), `u32` system-string cache value (`dword_929D68 + 88`), `u32` multisvr cache value (`dword_92D9EC + 108`; zero unless a local `multisvr.ssd` is loaded, otherwise its Adler-32), `u32` filter-string cache value (`sub_5C8224(dword_974D94)`), optional `u32` multisvrn cache Adler-32 (`dword_92D9EC + 112`) when `sub_5CDBF2(4)` is true | In this server flow, ConnectHello `extraFlag=0` leaves the first context value at its zero sentinel; `0x084341A5` is the repository file's on-disk `fxdynimginfo.ssd` Adler-32, not the first field's unconditional value. The repository has no standalone client `multisvr.ssd`, so its server-synthesized checksum is not evidence of the user's installed client checksum. |
| `189` (`0x00BD`) | S->C | `CFxApp::sub_5A11A6` -> `sub_49E093` (`0x0049E093`) | `u8` hasStream (`0` = valid; `1` = `stream` of `fxdynimginfo.ssd` parsed by `sub_49DF97`) | Step 1 of pre-login `.ssd` sync (`fxdynimginfo.ssd`). |
| `2` (`0x0002`) | S->C | `CFxApp::sub_5A1328` -> `sub_5D00B9` (`0x005D00B9`) | `u8` hasStream (`0` = valid; `1` = `stream` of `csysstr.ssd` parsed by `sub_5CFE6C`) | Step 2 of pre-login `.ssd` sync (`csysstr.ssd`). |
| `1` (`0x0001`) | S->C | `CFxApp::sub_5A14B1` -> `sub_5D7E8E` (`0x005D7E8E`) | `u8` hasMultiSvr (`0` or `1`+`stream` of `multisvr.ssd` parsed by `sub_5D782C`), *(if region requires it)* `u8` hasMultiSvrn (`0` or `1`+`stream` of `multisvrn.ssd` parsed by `sub_5D79AE`) | Step 3 of pre-login `.ssd` sync. The server preserves a client-edited `multisvr.ssd` when its CRC is a non-sentinel custom value (`> 0xFFFF`, not `0xFFFFFFFF`), rather than overwriting the address the user intentionally configured. |
| `53` (`0x0035`) | S->C | `CFxApp::sub_5A164F` + `sub_5C8BE3` (`0x005C8BE3`) | `u8` hasFilterStream (`0` or `1`+`stream` of `filterstr.ssd` parsed by `sub_5C89D7`), `u8` extraCount (`0`, or `count * [u32, str]`) | Step 4 of pre-login `.ssd` sync (`filterstr.ssd`); completes pre-login check. |
| `252` (`0x00FC`) | C->S | `CFxApp::sub_5A1DF3` | `u32` crcPackageMap (`0xDCEC1A37`) | Checks `packagemap.ini` (`S->C 157`: `u8(0)`). |
| `267` (`0x010B`) | C->S | `CFxApp` | *(empty)* | Requests notice URL (`S->C 163`: `str noticeUrl`). |
| `294` (`0x0126`) | C->S | `CFxApp` | `u32` crcStringTable (`0x6683B836`) | Checks `stringtable.ini` (`S->C 179`: `u8(0)`). |
| `305` (`0x0131`) | C->S | `CFxApp` | `u32` crcFxStock (`0xB5C71DB3`) | Checks `fxstock.ini` (`S->C 188`: `u8(0)`). |

---

## 3. Login, Registration & Channel Selection (` Confirmed `)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `16` (`0x0010`) | C->S | `COnePageIDStage::sub_514F8F` | `str` username | Checks account ID availability (`S->C 59`: `u8(0)` = available). |
| `17` (`0x0011`) | C->S | `CAgreementStage::sub_47E73D` | *(empty)* | Accepts user agreement (`S->C 9`: `u32(9)` -> `COnePageIDStage`). |
| `18` (`0x0012`) | C->S | `COnePageIDStage::sub_516FA7` | `str` username, `str` password, ... | Registers new account (`S->C 61`: `u8(0)` = success). |
| `2` (`0x0002`) | C->S | `CNetworkFacade::sub_5D8BD8` (`0x005D8BD8`) | `u8` playerCount (`1` or `2`), per player: `keyedStr(username, 0x11223344)`, `keyedStr(password, 0x44332211)`, followed by `block(16)` MAC/hash, `u32` clientFlag | Standard 1P/2P login (`S->C 4`). |
| `11` (`0x000B`) | S->C | `CLoginStage::sub_567B0F` (`0x00567B0F`) | `str` messengerIp, `u16` messengerPort, `u16` loginTcpPort, `u16` loginUdpPort, *(if feat 17: `u8(0)`)*, `u16` urlCount(`0`), `u16` trailingWord(`0`) | Completes `CWaitForLoginDlg` and transitions client to Stage `10` (`CSelectServerStage`). |
| `31` (`0x001F`) | C->S | `CNetworkFacade::sub_5D8494` (`0x005D8494`) | `u8` mode, `str` tokenOrId, `u8` subMode, ... | Beanfun / SSO token login (`S->C 4`). |
| `4` (`0x0004`) | S->C | `CLoginStage::sub_567461` (`0x00567461`) | `u8` errCode (`0`=Success), `u16` worldId, `u8` playerCount (`1` or `2`), per player: `u32` lucci, `u32` wins, `u32` losses, `u32` sessionToken, `str` username, `u8` gender, `u32` isReg(`1`), `str` nickname, `u32` exp, `u8` post-exp field A (current server value `user.level`; client stores separately via `sub_561F62`, semantic mapping unconfirmed), `u16` client level (current server value `user.level`; parsed via `sub_5ED30E`, returned by `sub_5ED43B` and used by the channel-level gate), `u8` post-exp field B (reader calls `sub_5ED2DC`; semantic label unconfirmed), `u8` f43F, `u8` f459, `u32` v425, `u16` v272; then `u8[4]`(`0`), `u16`(`0`), `u8`(`0`), *(if TW feature 9: `u32(0)`)* | Populates `CNetworkFacade` local player slots and triggers `C->S 9` post-login channel request. |
| `9` (`0x0009`) | C->S | `CLoginStage` / `CStage::sub_4B94A6` | `u32` channel-cache CRC | On the LoginServer while stage is `Login`, requests `S->C 10`, `S->C 12`, then `S->C 11`. After the GameServer reconnect, the Lobby-stage repeat is not a second channel/login handoff. |
| `10` (`0x000A`) | S->C | `CStage::sub_4BDBF5` -> `CChannelCache::sub_5D3E91` / `sub_5D3D3F` (`0x005D3D3F`) | `u8` hasStream(`1`), `CISmartStream`: `u16` count; each row `str name`, `u16 maxUsers`, `u8 badgeId`, `u8 rawCategoryCode`, `u16 channelFlags`, `u8 restrictionFlags`, `u8 tabIndex`, `u8 minGrade`, `u8 maxGrade`, `u16 minLevel`, `u16 maxLevel` | Populates `CChannelInfo` records. `sub_56AC55` displays rows with tabIndex equal to the selected tab and category getter `sub_5D4071` equal to 10. Raw category 18 is normalized to 10 by that getter. `channel2_001.ssd` is dynamically server-supplied; it is not a standalone file in this checkout. |
| `12` (`0x000C`) | S->C | `CChannelInfo::sub_5D4139` / `sub_565E9A` | `u16` channelCount, then `u16[channelCount]` current-user counts | Updates `sub_56AAA0` population values; `sub_56AAB6` reads the separate `maxUsers` field from S->C 10. |
| `11` (`0x000B`) | S->C | `CLoginStage::sub_567B0F` (`0x00567B0F`) | `str` messengerIp, `u16` messengerPort, `u16` loginTcpPort, `u16` loginUdpPort, *(if feat 17: `u8(0)`)*, `u16` urlCount(`0`), `u16` trailingWord(`0`) | Completes `CWaitForLoginDlg` and transitions client to Stage `10` (`CSelectServerStage`). |
| `5` (`0x0005`) | C->S | `CSelectServerStage::sub_56AF39` | `u8` normalized category (`sub_5D4071`, normally 10), `u32` category-relative ordinal (`sub_5D40F5`; counts preceding entries with the same normalized category) | Selects a `CChannelInfo` row from the channel cache. It is not a channel capacity or absolute row ID. |
| `7` (`0x0007`) | S->C | `CSelectServerStage::sub_56C0C8` (`0x0056C0C8`) | `u8` result (`0` = `ErrCannotConnect`, `1` = success), `u8` normalized category, `u32` category-relative ordinal, `u32` GameServer IPv4, `u16` GameServer TCP port | Success is **1**, not 0. The client closes the LoginServer socket, connects to the advertised GameServer endpoint, then sends C->S 6. |
| `6` (`0x0006`) | C->S | `sub_5D8879` / `sub_5D893D` / `sub_5D8A3F` | `u8` localPlayerCount, per player: `str` username, `u32` sessionToken, `[u32 isRegisteredFlag]`; `[u8 targetMode, u32 a2, u32 a3]` | Authenticates the session on the GameServer. For the Lobby target, the supported response is `S->C 33` followed by `S->C 75`; do not send `S->C 9` as a Lobby transition because the client's select-server fallback treats it as a crash-dump offset request. The separate targetMode=14 path remains stage-specific and unverified. |
| `33` (`0x0021`) | S->C | `CSelectServerStage::sub_56A9DA` -> `CStage::sub_4B96B1` | *(if TW feat 22: `u8(0)`)* | Transitions client to Stage `11` (`CLobbyStage`). |
| `75` (`0x004B`) | S->C | `CStage::sub_4B94A6` (`0x004B94A6`) | `u32` questConfigCount (`0`) | Triggers client to send `C->S 83` (Enter Lobby) and `C->S 338`. |
| `8` (`0x0008`) | C->S | `sub_5D06FA` (S->C 9 chunk reply) / `sub_5D137C` (metadata) | `u8` transferFlag, `u32` byteCount, if flag=`1` then `block(byteCount)` | `Crash_CA.dmp` upload metadata/chunk. Flag `1` carries bytes read from the local file at the offset requested by `S->C 9`; flag `0` is emitted by `sub_5D137C` without a block. This is not a channel-cache request. |
| `9` (`0x0009`) | S->C | Generic `CStage::sub_4BDBF5` -> `sub_4B8D42` | `u32` `Crash_CA.dmp` file offset | Requests a dump chunk, prompting `C->S 8`. Opcode `9` is stage-overloaded; it is not a generic transition in this handler. |

**Channel-level warning path.** In `CA.exe.c`, `CSelectServerStage::sub_56AF39` compares the selected channel's `minLevel` (`sub_56AB66`) against the value returned by `sub_5ED43B`; when the client level is below the minimum, it looks up `UpperLevelOnly`. The LoginResult parser reads the preceding `u8` through `sub_561F62` into a separate field, then reads the `u16` through `sub_5ED30E`, which is the value later returned by `sub_5ED43B`. The local `csysstr.ssd` entry `UpperLevelOnly` is exactly `選擇的頻道只能%d級以上才能進入`. The server must therefore serialize `user.level` in this `u16`; the neighboring `u8` mapping and any LoginResult location for `rankFlag` remain unconfirmed. `channel2_001.ssd` is not present as production channel data in this checkout; the four `DEFAULT_C_CHANNELS` rows are fallback data with `minLevel: 1`, which this fix deliberately leaves unchanged.

**GameServer handoff trace finding.** The supplied trace's 16,007-byte C->S 8 frame has the client dump-chunk shape: 2-byte opcode + 1-byte flag + 4-byte count + 16,000 data bytes. It follows the server's S->C 9 carrying `u32(11)`, which `CSelectServerStage` passes to `CStage::sub_4BDBF5`; `sub_4B8D42` reads `11` as a `Crash_CA.dmp` file offset and calls `sub_5D06FA`. The server then misroutes C->S 8 to its channel-cache handler, causing the first four upload-header bytes to be logged as a CRC. The Lobby handoff no longer emits S->C 9; the trace's later S->C 75 / C->S 83 sequence is consistent with Lobby entry. This confirms a server protocol defect. The warning text is also resource-confirmed: `csysstr.ssd` key `FailedToConnSvr` maps to `因您的連線不穩定，請重新登入`; `CFailedToConnSvrDlg::sub_569F7C` loads it, and `sub_56A765` displays that dialog when `sub_56C0C8` receives result `2` from the `CWaitForConnSvrDlg` modal. `CWaitForConnSvrDlg::sub_56E4E1` computes elapsed time from the dialog's start tick at byte offset `980` and compares it with the configured `u16` timeout at byte offset `976`; once elapsed time is greater, it calls the dialog's virtual `+152` method with result `2`. `CDialogWnd::sub_6A0D70` stores that modal result at byte offset `136`, and `sub_56C0C8` displays the warning when the modal returns `2`. This confirms timeout as one route to the dialog, but does not prove it caused the observed warning; `sub_56E4CC` can also set result `2`, and the supplied trace does not identify which route occurred or correlate the warning to Lobby initialization. The server's S->C encode and C->S decode framing logs now carry session ID, connection kind, stage, direction, opcode, sequence counter, and frame/payload sizes; outbound payload contents are omitted. A fresh client trace or modal call stack is still required to distinguish timeout/connection-state failure from client rejection of Lobby initialization.

**Post-fix reproduction (2026-10-04 11:18, supplied server log).** Login session 2 selected normalized category 10, ordinal 1, advertised `127.0.0.1:9339`, and disconnected as expected after the handoff. Its C->S 9 at `11:18:41.669` is the expected LoginServer `RequestChannelList`, not the old S->C 9 transition. The C->S 8 at `11:18:41.698` is a separate flag-0 metadata-only Crash_CA.dmp packet on the LoginServer; it has no dump block and is not the old S->C 9-triggered C->S 8 chunk. Game session 3 connected to that endpoint; C->S 6 had `tokenFound: true` in the same process and `targetMode: 1`. The server sent S->C 33 and 75, received C->S 83, then logged S->C 89, 186, 194, 196, 268, and 250 with payload lengths (including the 2-byte opcode) `7, 10, 31, 51, 7, 6`. These lengths match the current packet builders and client parser read shapes; in particular, opcode 268 is `u8 playerCount + i32 expansionCount`, not a `u16` count. Opcode 186's two-u32 read shape matches, but the client passes the second value through a `char` parameter, so the server's `user.lucci` value's meaning remains unconfirmed. No S->C 9 was sent and no framing/dispatch error was logged. The GameServer socket closed at `11:18:43.864`, 133 ms after acceptance and 27 ms after the last outbound frame was logged. This run confirms the LoginServer-to-GameServer route and handoff token state; it does not establish that the client accepted every Lobby-init packet or which event produced modal result 2. Because both listeners and the matching token are observed in the same process, this run does not support a LoginServer/GameServer deployment mismatch. The close timing and client-side `CWaitForConnSvrDlg` result still require client evidence.

---

## 4. Base Stage & Chat Packets (`CStage`, `CChatStage`, `CPacketDispatcher`) (` Confirmed `)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `20` (`0x0014`) | S->C / C->S | `CPacketDispatcher::sub_5D7CA5` (`0x005D7CA5`) | `u32` clientTick, `u32` seq | TCP ping/pong keepalive. |
| `16` (`0x0010`) | C->S | `CChatStage::sub_4AD598` (`0x004AD598`) | `str` message | Normal stage chat (`S->C 21`). |
| `21` (`0x0015`) | S->C | `CChatStage::sub_4B070C` / `CGameStage::sub_4F4D49` | `str` formattedChat (`"sender : message"`), `u8` colorFlag (`0`) | Displays normal chat in chat box & speech bubble. |
| `20` (`0x0014`) | C->S | `CChatStage::sub_4AD598` (`0x004AD598`) | `str` targetUsername, `str` message | Sends whisper (`S->C 23` to target, `S->C 24` to sender). |
| `23` (`0x0017`) | S->C | `CChatStage::sub_4A8727` / `CGameStage::sub_4F4F4B` | `str` formattedWhisper (`"sender : message"`) | Displays incoming whisper. |
| `24` (`0x0018`) | S->C | `CChatStage::sub_4AE106` (`0x004AE106`) | `u8` deliveredFlag (`1` = delivered; `0` = NotInSameChannel + `str` targetUsername) | Whisper delivery confirmation. |
| `97` (`0x0061`) | C->S | `CChatStage::sub_4AD598` (`0x004AD598`) | `str` message | Team chat (`S->C 114` in `CPrepareStage`). |
| `70` (`0x0046`) | C->S | `CChatStage::sub_4ABBDE` (`0x004ABBDE`) | `u8` subOp (`0`), `str` targetUsername | Queries user profile (`/who`, replies with `S->C 81` & `S->C 70`). |
| `81` (`0x0051`) | S->C | `CStage::sub_4BCDFF` (`0x004BCDFF`) | `str` username, `u32` lv, `u32` exp, `u32` wins, `u32` draws, `u32` losses, `u32` rank, `u8` gender, `str` guildName, `u8` guildMark, `u8` localIdx, `u16` itemCount, `itemCount * u32 itemCode`, `str` comment | Displays user profile info. |
| `338` (`0x0152`) | C->S | `CStage::sub_4B94A6` (`0x004B94A6`) | `u8` flag (`0`) | Post-stage-sync notification (`S->C 207`). |
| `207` (`0x00CF`) | S->C | `CStage::sub_4BCABF` (`0x004BCABF`) | `u8` flag, `u32` fxdynmapinfoChecksum (`0x79476A94`, passed to `sub_4E0207`), `u8` macroFlag, `u16` v9757A0, `u32` v9757A4, `u8` extraCount | If `fxdynmapinfoChecksum` differs from client's local `fxdynmapinfo.ssd`, client sends `C->S 282` (`sub_4DD5D3`). |
| `282` (`0x011A`) | C->S | `sub_4DD5D3` (`0x004DD5D3`) | *(empty)* | Requests updated `fxdynmapinfo.ssd` stream (`S->C 205`). |
| `205` (`0x00CD`) | S->C | `CStage::sub_4E0131` -> `sub_4DFE20` (`0x004DFE20`) | `stream` (`fxdynmapinfo.ssd` `CISmartStream`: `871` entries with 18B v22 tail) | Updates client's `fxdynmapinfo.ssd` on disk and reloads dynamic map table (`remaining === 0`). |

---

## 5. `CLobbyStage` (Stage 11) Packet Catalog (`0x004C86A2`) (` Confirmed `)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `83` (`0x0053`) | C->S | `CStage::sub_4B94A6` | *(empty)* | Enters Lobby; server replies with `S->C 89` (Exp), `S->C 186` (Lucci), and `S->C 82` (Room list). |
| `67` (`0x0043`) | C->S | `CLobbyStage::sub_4C266D` / `sub_4C50C4` | `u16` roomIndex, `u32` roomKey | Requests Room Detail Info (`S->C 83`). |
| `75` / `79` | C->S | `sub_4CD379`, `sub_4CAC9F`, `sub_4C070B` | `str` roomName, `[str password]`, `u8` isPrivate, `u8` localCnt, `localCnt * u8 charId`, `u8` gameMode, `u32` mapTheme | Creates a new room (`S->C 79` + `S->C 102` full snapshot -> Stage `12`). |
| `76` (`0x004C`) | C->S | `CLobbyStage::sub_4C4D93` (`0x004C4D93`) | `u16` roomNumber, `u32` roomKey, `str` password (or `u8(0)`), `u8` localCnt, `localCnt * u8 charId` | Joins existing room (`S->C 80` + `S->C 102` -> Stage `12`). |
| `77` / `81` | C->S | `CLobbyStage::sub_4C83BA` / `sub_4CCCE2` | `u8` localCnt, `localCnt * u8 charId`, `u8` preferMode | Quick Join room (`S->C 81` `sub_4C4635` -> `C->S 76`). |
| `80` (`0x0050`) | C->S | `sub_4A496F` | `u16` roomIndex | Scrolls room list / requests room detail (`S->C 83`). |
| `82` (`0x0052`) | C->S | `sub_536E2E` | `u16` roomNumber, `u32` chiefKey | Returns to room from Shop (`S->C 80` + `S->C 102`). |
| `79` (`0x004F`) | S->C | `CLobbyStage::sub_4C244A` (`0x004C244A`) | `u8` errCode (`0`=Success), `u16` roomNumber, `u32` chiefSlotNetId, `u8` gameMode, `u8` mapOpt, `u8` extraMode | Create Room response; transitions client to Stage `12` (`CPrepareStage`). |
| `80` (`0x0050`) | S->C | `CLobbyStage::sub_4C24D3` (`0x004C24D3`) | `u8` errCode (`0`=Success, `1`=WrongPwd, `2`=CantJoin), `u8` extraMode, `str` roomTitle, `u16` roomNum, `u16` mapIdx, `u8` gameMode, `u8` mapTheme, `u32` chiefSlotNetId, 8 slots (`isEmpty=1` + `block(3)` OR `isEmpty=0, u32 netId, CUser, u32 flags, block(3), u8 couple(0xFF), str guild, u32 mark, CSlotAccessory`), `u8` obs(`0`), `u32` trail(`0`) | Join Room response; transitions client to Stage `12` (`CPrepareStage`). |
| `81` (`0x0051`) | S->C | `CLobbyStage::sub_4C4635` (`0x004C4635`) | `u8` errCode (`0`=Found; `2..6`=Error), `u16` roomNumber, `u32` roomKey, `u8` mapTheme | Quick Join target room response -> transitions client to Stage `12` (`CPrepareStage`). |
| `82` (`0x0052`) | S->C | `CLobbyStage::sub_4C1E57` -> `sub_4C1B1B` (`0x004C1B1B`) | `u16` roomIdx, `u32` roomKey, `str` name, `u8` curPlayers, `u8` maxPlayers, `u8` isPlaying, `u16` mapId, `u8` mode, `u8` subMode, `u8` hasPwd, `u32` mapCategory, `u8` mapTheme | Adds/sets room entry in Lobby room list (`CGameSessionSlot` `0x004C30BD`). |
| `83` (`0x0053`) | S->C | `CNormalLobbyStrategy::sub_4CD139` (`0x004CD139`) | `u8` validFlag (`1`), 8 slots (`u8 occupied`, if `1`: `u8 charId, str username, u16 lv, u8 netbar, u8 couple`), `u32` mapId | Room Detail Info dialog. |
| `84` (`0x0054`) | S->C | `CLobbyStage::sub_4C1E90` -> `sub_4C1C0A` (`0x004C1C0A`) | `u16` roomIdx, `u32` roomKey, `str` name, `u8` curPlayers, `u8` maxPlayers, `u8` mode, `u8` subMode, `u8` hasPwd, `u32` mapCategory, `u8` mapTheme | Compact Lobby room list entry (waiting room with random map `255`). |
| `85` (`0x0055`) | S->C | `CLobbyStage::sub_4C1F02` -> `sub_4C32E4` (`0x004C32E4`) | `u16` roomIdx, `u32` roomKey, `u8` mask (`0x01`=`u8 isPlaying`, `0x02`=`u16 mapId, u32 mapCat`, `0x04`=`u8 mode`, `0x08`=`u8 subMode`, `0x10`=`str name`, `0x20`=`u8 cur`, `0x40`=`u8 theme`, `0x80`=`str name, u8 cur, u8 hasPwd, u8 max`) | Incremental Lobby room slot update. |
| `86` (`0x0056`) | S->C | `CLobbyStage::sub_4C1EC9` (`0x004C1EC9`) | `u16` roomIdx, `u32` roomKey | Removes room slot from Lobby room list. |

---

## 6. `CPrepareStage` (Stage 12) Packet Catalog (`0x004DCF07`) (` Confirmed `)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `84` (`0x0054`) | C->S | `sub_4D688D` | `str` roomName, `str` password, `u8` maxPlayers, `u8` gameMode | Chief updates room settings (`S->C 93`). |
| `86` (`0x0056`) | C->S | `sub_4D5B2F` (`0x004D5B2F`) | `u8` readyState, `u32` mapPackChecksum | Toggles player Ready state (`S->C 104`). |
| `87` (`0x0057`) | C->S | `sub_4D1E59` (`0x004D1E59`) | `u16` mapId, `u32` mapKey | Chief selects map (`S->C 109`). |
| `88` (`0x0058`) | C->S | `sub_4D2A67` (`0x004D2A67`) | `u8` `((localPlayerIdx << 4) \| (teamColor & 0x0F))` | Selects team color (`S->C 105` + `S->C 104`). |
| `89` (`0x0059`) | C->S | `sub_4D2AFD` (`0x004D2AFD`) | `u8` localPlayerIdx, `u8` charId (`0..10`, `12`=Random) | Selects character (`S->C 106` + `S->C 104`). |
| `90` (`0x005A`) | C->S | `sub_4D2BB8` (`0x004D2BB8`) | `u8` `((slotIdx << 4) \| (openState & 0x0F))` | Chief opens/closes slot (`S->C 107` + `S->C 104`). |
| `91` (`0x005B`) | C->S | `sub_4DA92C` (`0x004DA92C`) | `u32` targetSlotNetId, `u8` kickFlag | Chief kicks/bans player. The current server emits S->C 103 + S->C 9 to the kicked player; the Prepare-stage opcode-9 fallback treats that value as a dump offset, so this separate response path still needs correction. |
| `92` (`0x005C`) | C->S | `sub_4D555E` (`0x004D555E`) | `u32` targetSlotNetId, `u8` voteFlag | Ban vote response (`S->C 111`). |
| `93` (`0x005D`) | C->S | `sub_4D5DB1` + `sub_4DF2EC` (`0x004D5DB1`) | `[str mapFolderName, u8 resolvedMapIdx]` (or empty) | Chief clicks Start Game (`S->C 112` + `S->C 113`). |
| `94` (`0x005E`) | C->S | `sub_4DB16C` case 25 | `str` newPassword | `/pwd` command changes room password (`S->C 231` + `S->C 93`). |
| `95` (`0x005F`) | C->S | `sub_4B1A3A` (`0x004B1A3A`) | `u8` slotIdx, `u8` quickIdx, `u8` flag, `u16` itemType | Equips quick-slot item (`S->C 115`). |
| `96` (`0x0060`) | C->S | `sub_4D0627` (`0x004D0627`) | `u8` slotIdx, `u8` delta | Practice mode handicap (`S->C 108`). |
| `78` (`0x004E`) | C->S | `sub_5AA580` (`0x005AA580`) | *(empty)* | Leaves room. The current server emits S->C 9 (`u32(11)`) + S->C 103, but `CPrepareStage` falls through to the generic dump-offset handler for S->C 9; this room-leave response is a separate known defect, not evidence for the Lobby handoff. |
| `93` (`0x005D`) | S->C | `sub_4D4BA2` (`0x004D4BA2`) | `str` roomName, `str` password, `u8` maxPlayers, `u8` gameMode | Room settings updated. |
| `102` (`0x0066`) | S->C | `CSetPlayerOnPreparePacket::sub_4DC866` (`0x004DC866`) | `u8` slotIdx, `u32` slotNetId, `CUser`, `block(3)` `[flags, charId, team]`, `u8` ready, `str` guild, `u32` mark, `CSlotAccessory`, `u8` joinType, `u8` couple(`0xFF`) | Sets player in room slot `slotIdx`. |
| `103` (`0x0067`) | S->C | `CSessionStage::sub_4B789B` + `CPrepareStage::sub_4D4154` (`0x004D4154`) | `u8` slotIdx, `u32` newChiefSlotNetId, `u8` bannedByLeaderFlag, `u16` unused(`0`), `u8` newChiefSlotIdx (`j[779]`) | Removes player from slot `slotIdx` and updates room chief (`9` bytes). |
| `104` (`0x0068`) | S->C | `sub_4D88F9` (`0x004D88F9`) | `u8` slotIdx, `block(3)` `[flags, charId, team]`, `u8` extraFlag | Updates slot state flags, character, and team. |
| `105` (`0x0069`) | S->C | `sub_4D2A0C` (`0x004D2A0C`) | `u8` `((slotIdx << 4) \| (teamColor & 0x0F))` | Team color change notification. |
| `106` (`0x006A`) | S->C | `sub_4D2A98` (`0x004D2A98`) | `u8` slotIdx, `u8` charId | Character selection change notification. |
| `107` (`0x006B`) | S->C | `sub_4D2B54` (`0x004D2B54`) | `u8` `((slotIdx << 4) \| (openState & 0x0F))` | Slot open/close notification. |
| `108` (`0x006C`) | S->C | `sub_4D05C1` (`0x004D05C1`) | `u8` slotIdx, `u8` delta | Practice handicap notification. |
| `109` (`0x006D`) | S->C | `sub_4D1DBB` (`0x004D1DBB`) | `u16` mapId, `u32` mapKey | Map selection change notification. |
| `112` (`0x0070`) | S->C | `sub_4D4D61` (`0x004D4D61`) | `u8` startFailReason (`0` = ok) | Start Game check result. |
| `113` (`0x0071`) | S->C | `sub_4D9F8A` / `sub_4DA000` (`0x004D9F8A`) | `u32` randomSeed, `u16` mapId, `str` mapFolderName (`CGameMapInfoList[mapId]`), `u32` modeSubParam, `u8` gameMode, `u8` gameSubMode, `u8` activePlayerCount, per active player: `u8` slotIdx, `u8` spawnIdx, `u8` charId, `u8` team, `u8` pad, `u32` userParam; `u8` hasEsfnStream (`0` or `1`+`stream` of `esfn.ssd` parsed by `sub_5CA523`) | Transitions client from Stage `12` (`CPrepareStage`) to Stage `13` (`CGameStage`)! |
| `114` (`0x0072`) | S->C | `sub_4DD1F5` (`0x004DD1F5`) | `u8` slotIdx, `str` message | Room team chat message & bubble. |
| `115` (`0x0073`) | S->C | `sub_4D2190` (`0x004D2190`) | `u8` slotIdx, `u8` quickIdx, `u8` a3, `u8` flag, `u16` itemType, `u16` count | Quick-slot item equip update. |
| `231` (`0x00E7`) | S->C | `sub_4D3FD6` (`0x004D3FD6`) | `u8` successFlag (`1` = PwdChangedSuccess) | Room password change result. |

---

## 7. `CGameStage` (Stage 13) TCP & UDP Packet Catalog (`0x004F672F`, `0x004ECF93`) (` Confirmed `)

### 7.1 `CGameStage` TCP Packets (`CGameStage::sub_4F672F`)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `125` (`0x007D`) | S->C | `CGameStage` case `125` -> `CUDPPeerManBase::sub_5ECBF0` (`0x005ECBF0`) | `u8 peerIdx` (`0..11`) | Marks the indexed client peer for TCP fallback. |
| `136` (`0x0088`) | S->C | `sub_4EA206` (`0x004EA206`) | `u8` slotIdx | Marks `*(this + slotIdx + 16024) = 1`; stops client's 1-second UDP load-registration retry timer (`sub_4ED400`). |
| `135` (`0x0087`) | S->C | `sub_4F2065` (`0x004F2065`) | `u32` startSeed, `u32` durationMs, `u32` hurryUpSec, `u32` suddenDeathSec, `u32` extraParam, `u8` is30Fps(`1`), `u32` relayIp, `u16` relayPort, `u8` localPrimarySlot, then for 10 slots (`0..9`): `u8` isPresent *(if `!= 0`: `3` x `(u32 ip, u16 port)`)* | Starts the match countdown and UDP peer setup. Advertise the GameServer UDP endpoint as the relay; see §7.2 for endpoint provenance and the inferred third peer candidate. |
| `107` (`0x006B`) | C->S | `sub_4F18D8` (`0x004F18D8`) | `u8` slotIdx, `u8` y, `u8` x, `u8` power, ... | Places water bomb (`S->C 138` `sub_4F2771`). |
| `138` (`0x008A`) | S->C | `sub_4F2771` (`0x004F2771`) | Bomb placement broadcast | Spawns water bomb on map. |
| `108` (`0x006C`) | C->S | `sub_4EA480` (`0x004EA480`) | `u8` hazardId, `u8` dir, ... | Triggers map hazard (`S->C 139` `sub_4EA00B`). |
| `109` (`0x006D`) | C->S | `sub_4ED73A` (`0x004ED73A`) | `u8` slotIdx, `u8` dir, ... | Kicks/throws bomb (`S->C 137` `sub_4ED640`). |
| `110` (`0x006E`) | C->S | `sub_4EE2BB` (`0x004EE2BB`) | `u8` subType(`2`), `u8` slotIdx, `u8` srcY, `u8` srcX, `u8` destY, `u8` destX | Pushes movable box (`S->C 140` `sub_4EC806`). |
| `111` (`0x006F`) | C->S | `sub_4F1A2E` (`0x004F1A2E`) | `u8` slotIdx, `u8` itemNetId, `u8` y, `u8` x, `u8` itemType | Picks up map item (`S->C 141` `sub_4ECAAA`). |
| `112` (`0x0070`) | C->S | `sub_4F1956` (`0x004F1956`) | `u8` slotIdx, `u8` y, `u8` x | Destroys map tile/item (`S->C 142` `sub_4EB01C`). |
| `113` (`0x0071`) | C->S | `sub_4EA4EE` (`0x004EA4EE`) | `u8` `((subType << 4) \| (slotIdx & 0x0F))`, `u16` x, `u16` y, ... (`subType 2`=trapped, `3`=rescued, `4`=killed, `5`=timeout) | Bomber state transition (`S->C 144` `sub_4F267E`). |
| `144` (`0x0090`) | S->C | `sub_4F267E` (`0x004F267E`) | `u8` `((subType << 4) \| (slotIdx & 0x0F))`, `u16` x, `u16` y, ... | Broadcasts bomber trap/rescue/death state transition. |
| `114` (`0x0072`) | C->S | `sub_4EC3FD` (`0x004EC3FD`) | `u8` winningTeamOrFlag | Stage clear / match finish (`S->C 148` + `S->C 153`). |
| `120` (`0x0078`) | C->S | `sub_4EB054` (`0x004EB054`) | `u8` slotIdx, `u8` itemType, ... | Uses active item (`S->C 145` `sub_4EE73C`). |
| `127` (`0x007F`) | C->S | `sub_4F1525` (`0x004F1525`) | `u8` count, per item: `u8` itemType, `u8` y, `u8` x | Spawns items from destroyed blocks (`S->C 149` `sub_4F24A6`). |
| `131` (`0x0083`) | C->S | `sub_4F17A1` (`0x004F17A1`) | `u16` x, `u16` y, `u8` count, ... | Spawns boss/multi items (`S->C 151` `sub_4EA106`). |
| `134` (`0x0086`) | C->S | `sub_4EC9BE` (`0x004EC9BE`) | `u8` slotIdx, `u8` quickIdx | Consumes quick-slot item (`S->C 146` `sub_4F3356`). |
| `142` (`0x008E`) | C->S | `sub_4EB1E7` (`0x004EB1E7`) | `u8` slotIdx, ... | Mounts/rides vehicle (`S->C 181` `sub_4ECBD8`). |
| `149` (`0x0095`) | C->S | `CUDPPeerMan::sub_57BEF6` (`0x0057BEF6`) | Exactly `u8 peerIdx` (`0..11`) | Requests that the indexed UDP peer use TCP fallback; the client also marks it locally. The reconstruction relays this index via `S->C 125`. |
| `148` (`0x0094`) | S->C | `sub_4F2F8B` (`0x004F2F8B`) + `CGOGameResult::sub_455957` | `u8` isNormalFinish, `u8` flag1, `u8` resultType(`0`), `u8` isDraw, `u8` pad, then 8 slots (`0`=empty; `1`=human: `u32` netId, `u8` outcome, `u8` kills, `u8` saves, `u8` f8, `u32` expDelta, `u8` char, `u32` totalExp, `u16` winsDelta, `u16` lossesDelta, `u16` rankFlag, `u8` f24, *(if TW feat 9: `u8` f25)*, `u16` bonusExp, `u16` dblExp, `u32` totalLucci), then per occupied slot: `u8` niceAward(`0`) | Displays Win/Lose/Draw scoreboard and updates player EXP, level, and Lucci. |
| `153` (`0x0099`) | S->C | `sub_4F2D1A` (`0x004F2D1A`) | `u8` nextStageType (`0` -> Stage `12` `CPrepareStage`, `3` -> Stage `19` `CPracticeStage`), `u8` mapTheme | Transitions client from `CGameStage` (`13`) back to `CPrepareStage` (`12`)! |

### 7.2 UDP Framing, Load Registration & Gameplay (`MTUDPPeer`, `CUDPPeerMan`, `CGameStage::sub_4ECF93`)

- **Outer Frame (`MTUDPPeer` at `0x005EBFA0`)**:
  `[u8 L = 1 + innerLen][innerPayload (deg 0 plain BE)][u8 CRC8(0, frame[0..L-1])]`.
- **UDP server keepalive (reconstructed; no production server capture)**:
  - The current client payload model is `6B` `[u16 BE(0), u32 BE(userId)]`. The checked-in `CA.exe.c` does not contain the previously attributed `sub_57BEAE` / `sub_57BDCE` bodies, so the sender cadence is unknown.
  - The reconstruction replies with a `1B` inner payload `[u8(4)]`; confirm the production server's reply and timing with a live capture.
- **Game Load Registration (`sub_4ED400` at `0x004ED400`)**:
  - Client sends `36B` inner payload every 1s during `CGameStage` loading:
    `[u16 BE(1), u32 BE(userId), u16 BE(roomId), u32 BE(roomGameKey), u32 BE(ip0), u16 BE(port0), u32 BE(ip1), u16 BE(port1), u32 BE(mapCrc8), 4B(p0Attrs), 4B(p1Attrs)]`.
  - `sub_5EBBD6` obtains at most two local IPv4 addresses via `gethostname` / `gethostbyname`; `sub_4ED400` pairs each non-zero address with the client's UDP listening port and leaves missing candidates as `0.0.0.0:0`. The reconstruction preserves those two client-supplied candidates verbatim.
  - `sub_4F2065` consumes three `(ip, port)` candidates per peer slot. Because the client registration packet supplies only two, this server reconstruction fills candidate three from the UDP datagram's observed source IPv4 address/port. This is a high-confidence inference from the client schemas, not a captured production response; validate NAT traversal against a live network. Missing or unsupported IPv4 routes remain `0.0.0.0:0` rather than being replaced with loopback; the client's `sub_693B50` returns no peer for a zero IP or port.
  - The `S->C 135` relay endpoint is the configured GameServer UDP address (`PUBLIC_IP` plus `GAME_UDP_PORT`); it must not use the local bind address `HOST` unless that address is reachable by the client.
  - Server replies over TCP with `S->C 136` (`[u8 slotIdx]`) and, once all occupied slots in the room are loaded, broadcasts `S->C 135` (`sub_4F2065`).
- **P2P / Relay Gameplay Packets (`CUDPPeer` `0x0057B482` -> `CGameStage::sub_4ECF93` `0x004ECF93`)**:
  - `CUDPPeerClient::sub_5EC195` emits a 3B peer probe `[u8(0), u8(0), u8(localPeerIdx)]`; companion `sub_5EC1FF` emits `[u8(0), u8(1), u8(localPeerIdx)]`. The receiver's `CUDPPeerManBase::sub_5EC943` routes type `0` by the second byte and does not consume the third byte on that path.
  - The reconstructed GameServer answers the observed `[0, 0, peerIdx]` probe with `[0, 1, peerIdx]`; this server-side response is not independently confirmed against a production server.
  - Peer gameplay data: `[u8(1), u8(localPeerIdx), u16 BE(innerOpcode), ...]`; `sub_5ECA87` fans out and `sub_5ECB1E` targets one peer. The receiver's `sub_5EC943` removes the first two bytes before dispatching the inner gameplay packet:
    - `innerOpcode 0` (`sub_4EC1AC`, 8B): `[u16(0), u8 slot, u16 x, u16 y, u8 state]`
    - `innerOpcode 1` (`sub_4EA765`, 13B): `[u16(1), u8 a, u8 b, u16 c, u8 d, u16 e, u16 f, u16 g]`
    - `innerOpcode 2` (`sub_4EA278`, 9B): `[u16(2), u8 a, u16 b, u16 c, u16 d]`
    - `innerOpcode 3` (`sub_4ECA69`, 26B): `[u16(3), u8 a, u16 b, 21B block]`
    - `innerOpcode 4` (`CNetSyncMan::sub_4F98CE`): `[u16(4), u32 syncObjId, ...]`

---

## 8. `CUserInventoryMan`, `CShopConnectionMan`, `CShopStageNew` (Stage 14) & `CUserMarketStage` (Stage 20) (` Confirmed `)

### 8.1 `CUserInventoryMan` (`dword_929D78`) & `CShopStageNew` (`0x00529CC1`, `0x0053C550`, `0x00595F5D`)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `37` / `316` | C->S | `CShopConnectionMan::sub_529AFB` (`0x00529AFB`) | `u8` fromStage(`11`), `u32` flag(`0`) | Requests shop connection (`S->C 261`: `u8(1)`, `S->C 48`: `u8(1), str ip, u16 port`). |
| `38` (`0x0026`) | C->S | `CShopConnectionMan::sub_529D8E` (`0x00529D8E`) | `u8` mode, `u8` localCnt, per player: `str` id, `u32` key; `u8` shopType, `u32` coupleInfo | Authenticates shop connection (`S->C 16` `sub_4BB82A`, `S->C 9`: `u32(14)`, `S->C 194`, `S->C 196`). |
| `16` (`0x0010`) | S->C | `CStage::sub_4BB82A` (`0x004BB82A`) | `u8` localIdx, `u8` flag2, `u32` cash, `u32` lucci, `u32` fxstockCrc (`0x48572A63`, `sub_594353`), `u32` stringtableCrc (`0x6683B836`, `sub_59449A`), `u32` packagemapCrc (`0xDCEC1A37`, `sub_5943FB`), `str` noticeUrl, *(if feat 23: `u8` hasQmark + `qmarksfn.ssd` `sub_5B988A`)*, `u32` bannerCount (`0`, `sub_5935DC`) | Initializes shop catalog checksums and transitions client to Stage `14` (`CShopStageNew`). |
| `269` (`0x010D`) | C->S | `CShopStageNew::sub_536555` (`0x00536555`) / `sub_589DB9` | `u8` mode (`1` = enter shop, `0` = query cash balance) | Replies with `S->C 198` (cash balance) and, when `mode == 1`, `S->C 208`, `S->C 194`, `S->C 196`, `S->C 203`. |
| `186` (`0x00BA`) | S->C | `CStage::sub_4BDBF5` -> `sub_4B93FD` -> `sub_5ED36F` | `u32` playerIdx, `u32` value (passed to a `char` parameter) | Corresponds to C->S 303 (`QueryAvatarLucciSync`); the client's exact stored-field semantics/width are not confirmed. This server currently supplies `user.lucci`; no production capture validates that value. |
| `194` (`0x00C2`) | S->C | `CStage::sub_4BC9CC` -> `CUserInventoryMan::sub_595F5D` (`0x00595F5D`) | `u8` playerCount, per player (`sub_595005`): `i32` count, `count *` (`sub_594ECF`: `u32` stockId, `u8` slotCategory, `u32` qty, `str` customText, `8B f64 LE` VariantTime, `u32` remainUnits, `u8` marketStatus) | Full inventory synchronization on login/lobby/shop entry (`dword_929D78`). |
| `188` (`0x00BC`) | S->C | `CStage::sub_4BAFE1` -> `CUserInventoryMan::sub_595FA9` (`0x00595FA9`) | Same schema as `S->C 194` (`sub_595005` + `sub_594ECF`) | Incremental inventory refresh after buying/equipping/using items. |
| `196` (`0x00C4`) | S->C | `CStage::sub_4BCA1A` -> `CUserInventoryMan::sub_595FF8` (`0x00595FF8`) | `u8` playerCount, per player (`sub_594F54` + `sub_594F84`): `8` slots * (`u32` stockId, `str` customText) | Synchronizes the 8 equipped avatar/accessory slots per local player. |
| `197` (`0x00C5`) | S->C | `CStage::sub_4BBA8F` (`0x004BBA8F`) | `u8` playerCount, per player: `u8` count, `count * u32` activeItemCode | Synchronizes active consumable/effect items. |
| `268` (`0x010C`) | S->C | `CStage::sub_4B9E20` -> `sub_5832DB` (`0x005832DB`) | `u8` playerCount, per player: `i32` expansionCount, `expansionCount * [u32 a, u32 b, u32 c]` | Synchronizes inventory expansion data. `sub_5832DB` reads the count with `sub_697580` (`u32`); zero expansion count is a 4-byte field. |
| `208` (`0x00D0`) | S->C | `CShopStageNew::sub_53660B` (`0x0053660B`) | `u8` status (`1`), `u32` fxstockCrc, `u32` stringtableCrc, `u32` packagemapCrc, `str` noticeUrl, *(if feat 23: `u8` hasQmark)*, `u32` bannerCount (`0`) | Shop configuration / catalog sync inside `CShopStageNew`. |
| `276` (`0x0114`) | C->S | `sub_594353` (`0x00594353`) | *(empty)* | Requests `fxstock.ini` stream (`S->C 193`). |
| `193` (`0x00C1`) | S->C | `CStage::sub_4B95B0` -> `sub_593FF6` -> `sub_588ED2` | `stream` (`fxstock.ini` `CISmartStream`: `1,461` entries with 33B v22 tail) | Updates client's `fxstock.ini` on disk and reloads shop stock catalog (`remaining === 0`). |
| `278` (`0x0116`) | C->S | `sub_59449A` (`0x0059449A`) | `[u8 localIdx]` | Requests `stringtable.ini` stream (`S->C 200`). |
| `200` (`0x00C8`) | S->C | `CStage::sub_4B95F7` -> `sub_594136` (`0x00594136`) | `stream` (`stringtable.ini` `CISmartStream`: `114` entries) | Updates client's `stringtable.ini` on disk and reloads localized shop strings (`remaining === 0`). |
| `281` (`0x0119`) | C->S | `sub_5943FB` (`0x005943FB`) | *(empty)* | Requests `packagemap.ini` stream (`S->C 210`). |
| `210` (`0x00D2`) | S->C | `CStage::sub_4B966A` -> `sub_59426D` -> `sub_5886A9` | `stream` (`packagemap.ini` `CISmartStream`: `988` entries) | Updates client's `packagemap.ini` on disk and reloads package map (`remaining === 0`). |
| `270` / `309` | C->S | `sub_58EAEF` -> `sub_58B130` (`0x0058B130`) / `sub_58B871` | `[if 309: str nexonPass]`, `u32` packageId, `u32` price, `u16` couponType, `u8` currencyType (`1`=Cash, `2`=Lucci) | Purchases shop item (`S->C 199` `sub_58EBFE`: `u8(0)` + `8B VariantTime`, plus `S->C 188`, `S->C 198`, `S->C 190`). |
| `271` (`0x010F`) | C->S | `CUserInventoryMan::sub_58013E` (`0x0058013E`) | `u8` playerIdx, `u32` stockId | Deletes expired/unwanted inventory item (`S->C 202`: `u8(2), u32(1)` `sub_547038`). |
| `273` (`0x0111`) | C->S | `CUserInventoryMan::sub_5816F4` (`0x005816F4`) | `u8` mode, `u8` playerIdx, `u8` count, `count * (u8 slotCat, u32 stockId, [if mode!=1: str text])` (also supports compact `subOp 0..3`) | Synchronizes equipped items (`S->C 196`) or executes compact shop action. |
| `274` (`0x0112`) | C->S | `CShopDlg::sub_541682` (`0x00541682`) | `u8` playerIdx, `u8` slotIdx (`0..7`), `u32` stockId, `str` customText | Equips single avatar slot + custom text (`S->C 196` + `S->C 188`). |
| `275` (`0x0113`) | C->S | `CShopTextDlg::sub_48ED44` (`0x0048ED44`) | `u8` playerIdx, `u32` count, `count * (u32 stockId, str customText)` | Batch updates custom text on speech-bubble/balloon items (`S->C 188` + `S->C 196`). |
| `277` (`0x0115`) | C->S | `sub_589D78` (`0x00589D78`) | `u8` mode | Billing / gift verification check (`S->C 201` `sub_58C8EA`). |
| `279` (`0x0117`) | C->S | `CShopGiftSendDlg::sub_52C5A2` (`0x0052C5A2`) | `u32` packageId, `str` receiverName, `str` title, `str` message, `u8` flag | Sends gift (`S->C 199` to sender + `S->C 203` `sub_53AF19` to receiver). |
| `203` (`0x00CB`) | S->C | `CShopStageNew::sub_53AF19` (`0x0053AF19`) | `u32` sentCount, `sentCount * (...)`, `u32` recvCount, `recvCount * (u8 idx, u32 id, u32 pkgId, u8 status, 8B vtime, str sender, str msg)` | Synchronizes sent and received gift lists. |
| `280` (`0x0118`) | C->S | `CShopCouponDlg::sub_492CD9` (`0x00492CD9`) | `str` couponCode, `str` targetUsername | Redeems shop coupon (`S->C 204` `sub_53A6F1`: `u8 res(1|15), u32 count, 8B vtime, count*(u32 id, u32 cnt, u32 days, u32 unk)`). |
| `283` (`0x011B`) | C->S | `CShopDlg::sub_58BFE0` (`0x0058BFE0`) | `u32` stockId, `u32` slotIdx | Resells item for Lucci (`S->C 212` `sub_546D3F`: `u8(0), str name, u32 stockId, u32(0), u32 refundLucci`). |
| `285` (`0x011D`) | C->S | `CShopStageNew::sub_536DB3` / `sub_5B76C2` | `u8` mode (`0` = leave shop -> `S->C 99`; `>0` = identify `?` item -> `S->C 214` `sub_5396F0`) | Leaves shop or identifies mystery `?` item. |
| `307` (`0x0133`) | C->S | `CGachaponDlg::sub_5C3330` (`0x005C3330`) | `u32` couponStockId | Rolls Gachapon machine (`S->C 255` `sub_5C23DB`: `u8(1), u32 couponId, str name, stream, u32 count`). |
| `313` / `314` | C->S | `CBasketDlg::sub_5C0C05` / `sub_5BFA5C` | *(empty)* | Queries Basket items (`S->C 259` `sub_5C261E`) and Basket coupon counts (`S->C 260` `sub_5C0289`). |
| `98` (`0x0062`) | C->S | `CShopConnectionMan::sub_52A04E` (`0x0052A04E`) | `u8` inShopFlag (`1` = enter shop from room; `0` = return to room) | Sets `slot.inShop` (`0x08` bit in `S->C 104`), sends `S->C 16` + `198` or `S->C 99`. |
| `99` (`0x0063`) | S->C | `CShopConnectionMan::sub_529EB2` (`0x00529EB2`) | `u16` targetStageId (`11` = Lobby, `12` = Prepare) | Triggers `C->S 82` (return to room) or `C->S 78` (return to lobby). |

### 8.2 `CUserMarketStage` (Stage 20) & `CMarketSlotWnd` (`0x005756B8`, `0x00572FA4`)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `318` (`0x013E`) | C->S | `CShopConnectionMan::sub_52A129` (`0x0052A129`) | `[u8 localIdx]` | Requests UserMarket entry (`S->C 262`: `u8(1)` `sub_52A1D2` -> Stage `20`). |
| `320` (`0x0140`) | C->S | `CShopConnectionMan::sub_52A216` (`0x0052A216`) | `u8` mode, `u8` localCnt, per player: `str` id, `u32` key; `u8` flag, `u32` param | Authenticates UserMarket connection (`S->C 269`: `u8(1)` `sub_52A2C6`) or searches listings (`S->C 272`). |
| `324` (`0x0144`) | C->S | `CUserMarketStage::sub_575645` (`0x00575645`) | `u8` mode (`0` = enter market -> `S->C 270, 271, 280, 272`) | Initializes `CUserMarketStage`: `S->C 270` (`u32 maxLucci`), `S->C 271` (`u32 marketLucci`), `S->C 280` (`sub_571A0A` tradeable items), `S->C 272` (`sub_57282A` listings). |
| `321` (`0x0141`) | C->S | `CUserMarketStage::sub_56AFCA` / `sub_573B91` | `u8` mode (`1` = leave -> `S->C 99`; `0` = query balance -> `S->C 271`) | Leaves UserMarket or refreshes Market Lucci balance. |
| `325` (`0x0145`) | C->S | `CMarketSlotWnd::sub_5713E3` / `sub_574BD5` | `u8` subMode (`0` = search `[u8 tab, str query, u16 page]` -> `S->C 272`; `1` = my sales -> `S->C 275` `sub_572AC5`) | Searches active market listings (`S->C 272` `sub_57282A`) or queries seller's own listings (`S->C 275`). |
| `326` (`0x0146`) | C->S | `CMarketSlotWnd::sub_5710C3` (`0x005710C3`) | `u32` stockId, `u32` price (or `u8(1)` leave) | Registers item for sale on UserMarket (`S->C 273` `sub_56EE29`: `[u16(0), u32 stockId]`, plus `S->C 272` & `S->C 275`). |
| `327` (`0x0147`) | C->S | `CMarketSlotWnd::sub_571130` (`0x00571130`) | `u32` listingId | Cancels market listing (`S->C 274` `sub_56F04F`: `[u16(0), u32 stockId]`). |
| `328` (`0x0148`) | C->S | `CUserMarketStage::sub_57560A` (`0x0057560A`) | `[u8 localIdx]` | Queries sold/expired market notifications (`S->C 278` `sub_539A17`, `S->C 279` `sub_539C8B`, `S->C 275`). |
| `329` (`0x0149`) | C->S | `CChangeLucciDlg::sub_575DF9` (`0x00575DF9`) | `u8` direction (`1` = Game->Market, `0` = Market->Game), `u32` amount | Transfers Lucci between Game and Market (`S->C 276` `sub_56F8C4`: `[u16(0), u32 userLucci, u32 marketLucci]`). |
| `330` (`0x014A`) | C->S | `CMarketSlotWnd::sub_5712FF` (`0x005712FF`) | `u32` listingId | Purchases market listing (`S->C 277` `sub_56FB09`: `[u16(0), u32 stockId, u32 remainMarketLucci, 8B f64 LE vtime]`). |

---

## 9. `CExchangeStage` (Stage 18) & `CSyncGameObjectMan` (`0x0055C714`, `0x0057B430`) (` Confirmed `)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `101` (`0x0065`) | C->S | `CExchangeStage::sub_55B5B0` (`0x0055B5B0`) | `str` password | Verifies player password to unlock exchange (`S->C 130`: `u8(1)`, `S->C 126`: `u8(2), u8(1), str username`). |
| `100` (`0x0064`) | C->S | `CExchangeStage::sub_558142` (`0x00558142`) | `u8` state (`3` = offer items: `u32` lucci, `u8` count, `count * [u32 stockId, 16B SYSTEMTIME]`; `5` = confirm trade) | Updates exchange trade offer (`S->C 128` + `S->C 126`) or finalizes trade (`S->C 129`). |
| `126` (`0x007E`) | S->C | `CExchangeStage::sub_55C14B` (`0x0055C14B`) | `u8` state (`1..5`), `u8` statusMsgCode, `[str arg]` | Updates exchange lock state & status message (`sub_558918`, `sub_559DCC`). |
| `127` (`0x007F`) | S->C | `CExchangeStage::sub_559DCC` (`0x00559DCC`) | `u8` statusMsgCode (`1..16`), `[str arg]` | Displays exchange status / error notice. |
| `128` (`0x0080`) | S->C | `CExchangeStage::sub_5578FF` (`0x005578FF`) | `u8` sideIdx (`0..1`), `u32` lucci, `u8` count, `count * [u32 stockId, 16B SYSTEMTIME]` (`sub_55D805`) | Updates exchange trade container items (`CStockContainer`). |
| `129` (`0x0081`) | S->C | `CExchangeStage::sub_55AA90` (`0x0055AA90`) | `slotCount * CSlotAccessoryPacket` | Refreshes slot accessories after exchange. |
| `130` (`0x0082`) | S->C | `CExchangeStage::sub_55B611` (`0x0055B611`) | `u8` ssnMatchFlag (`1` = ok, `0` = SSNMismatched) | Exchange verification result. |
| `175` (`0x00AF`) | S->C | `CSyncGameObjectMan::sub_57B430` (`0x0057B430`) | `u16` objId, `u8` subType, `u16` objClassId, `block(20)` initData | Spawns synchronized NPC/Monster/Boss game object. |
| `176` (`0x00B0`) | S->C | `CSyncGameObjectMan::sub_57B430` (`0x0057B430`) | `u16` objId, `u8` state | Updates or destroys synchronized game object. |
| `177` (`0x00B1`) | S->C | `CSyncGameObjectMan::sub_57B430` (`0x0057B430`) | `u16` objId, `u32` param | Synchronized game object action parameter. |

---

## 10. `CSmsDlg` (Offline Mailbox) & `CCouple` (Couple Ring) (`0x0047F58F`, `0x005BBF91`) (` Confirmed `)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `297` (`0x0129`) | C->S | `CSmsDlg::sub_4810F3` (`0x004810F3`) | `str` senderName, `str` receiverName, `str` message | Sends SMS message (`S->C 242` `sub_4838E8`: `u8(10)`=Success, `11`=WrongID, `12`=Self; plus `S->C 246` `u8(1)` to online receiver). |
| `298` (`0x012A`) | C->S | `CSmsDlg::sub_47F58F` / `sub_5E415C` (`0x0047F58F`) | `str` username, `u8` mode (`0` = list -> `S->C 243`; `1` = unread check -> `S->C 246`) | Queries SMS inbox list (`S->C 243`) or checks for unread mail (`S->C 246`). |
| `243` (`0x00F3`) | S->C | `CSmsDlg::sub_484465` (`0x00484465`) | `u8` status (`15`), `u8` count (`<=20`), `count * [u32 id, str sender, str msg, u16 month, u16 day, u16 hour, u16 min, u8 isRead]` | Populates `CSmsDlg` message list. |
| `299` (`0x012B`) | C->S | `CSmsDlg::sub_47FDCB` (`0x0047FDCB`) | `str` username, `u32` msgId | Deletes single SMS message (`S->C 244` `sub_47F653`: `u8(1)`). |
| `300` (`0x012C`) | C->S | `CSmsDlg::sub_47F5F7` (`0x0047F5F7`) | `str` username | Deletes all SMS messages (`S->C 245` `sub_47F66A`: `u8(1)`). |
| `250` (`0x00FA`) | S->C | `CCouple::sub_5BBF91` (`0x005BBF91`) | `u8` playerCount, per player: `u8` state (`0`=single, `1`=coupled + `u8` grade + `str` partnerName), `[if feat 30: u16 anniversaryDays]` | Synchronizes Couple Ring relationship status (`dword_929D88`). |
| `304` (`0x0130`) | C->S | `CCouple::sub_5BA82D` (`0x005BA82D`) | `u8` playerIdx, `str` partnerName, `str` message | Proposes couple ring (`S->C 252` `u8(2)` to proposer + `S->C 251` `sub_5BAA90` to partner). |
| `305` (`0x0131`) | C->S | `CCouple::sub_5B9FD6` (`0x005B9FD6`) | `u8` playerIdx, `u8` accept (`1` = accept, `0` = reject) | Accepts/rejects couple proposal (`S->C 253` `sub_5BBD3E` status `12` on accept; `S->C 252` status `14` on reject). |
| `306` (`0x0132`) | C->S | `CCouple::sub_5BA899` (`0x005BA899`) | `u8` playerIdx | Breaks up couple relationship (`S->C 254` `sub_5BC155`: `u8 playerIdx`). |

---

## 11. `CRankMan` (Ranking), `CMyInfoDlg` (Profile), `CQuestWnd`, & Extended `CGameStage` (`107..153`) (` Confirmed `)

### 11.1 `CRankMan` (`0x004A4FBD` – `0x004A527F`) & `CMyInfoDlg` / `CQuestWnd` (`0x004B9DB6`)

| Opcode | Dir | Handler | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `64` (`0x0040`) | C->S | `sub_4A48F2` (`0x004A48F2`) | `u16` startRank | Requests paginated ranking page (`S->C 69` / `S->C 66`). |
| `69` / `66` | S->C | `sub_4A5114` / `sub_4A51B5` (`0x004A5114`) | `u16` startRank, `u8` count, `count * sub_4A4FBD` (`u32` rank, `u32` exp, `u32` level, `i32` rankChange, `str` username, `str` guildName) | Populates ranking list page (`CRankMan`). |
| `296` (`0x0128`) | C->S | `sub_4A49D8` (`0x004A49D8`) | *(empty)* | Requests top-3 leaderboard (`S->C 240`). |
| `240` (`0x00F0`) | S->C | `sub_4A522B` (`0x004A522B`) | `u8` count (`<= 3`), `count * sub_4A4FBD` | Populates top-3 leaderboard podium (`CRankMan`). |
| `311` (`0x0137`) | C->S | `sub_4A4A0F` (`0x004A4A0F`) | *(empty)* | Requests local players' character ranks (`S->C 256`). |
| `256` (`0x0100`) | S->C | `CStage::sub_4B96F3` -> `sub_4A527F` (`0x004A527F`) | Per local player (`0..playerCount-1`): `u8` hasRank (`1`), `[if hasRank: sub_4A4FBD, u32 rankDelta, u8 tier]` | Displays local player's own rank summary. |
| `66` (`0x0042`) | C->S | `CStage::sub_4BC236` (`0x004BC236`) | `str` username, `u8` flag (`1`), `u8` localIdx | Requests user profile modal (`S->C 81`, `S->C 248`, `S->C 71`, `S->C 220..222`). |
| `71` (`0x0047`) | S->C | `sub_5403BB` / `sub_54D47F` (`0x005403BB`) | `u8` found (`1`), `str` username, `u8` gender, `u32` level, `str` guild, `u16` age, `str` memo | Populates user profile detail dialog (`CMyInfoDlg`). |
| `44` (`0x002C`) | C->S | `CQuestWnd::sub_551AE2` (`0x00551AE2`) | `u8` action, `u32` questId | Queries or updates quest state (`S->C 248`). |
| `248` (`0x00F8`) | S->C | `CStage::sub_4B9DB6` -> `sub_5C649C` (`0x005C649C`) | `u8` playerIdx, `u32` questMask, `i32` count (`0`), `count * 28B` | Synchronizes active quests and slot unlock states. |
| `40` (`0x0028`) | C->S | `sub_4A29A1` (`0x004A29A1`) | `u8` mode (`0`) | Queries macro list (`S->C 50` `sub_4A27CB`). |
| `32` / `33` | C->S | `CEKeyDlg::sub_55FB0B` / `sub_561394` | `str` token / challenge | PlaySafe / E-Key security token verification (`S->C 4` / `S->C 34`). |
| `34` / `35` / `36` | C->S | `sub_49A5CA` / `sub_49AB07` / `sub_49B6E4` | `str` userId, `[str password, ...]` | Checks ID availability (`S->C 59`), submits registration (`S->C 61`), or verifies identity (`S->C 34`). |
| `46` (`0x002E`) | C->S | `CNCPasswordDlg::sub_495C32` (`0x00495C32`) | `str` oldPass, `str` newPass, `str` confirmPass | Updates account password in SQLite (`S->C 34`: `u8(0)`). |

### 11.2 Extended `CGameStage::sub_4F672F` (`0x004F672F`) In-Game Opcodes (`115..153`)

| Opcode | Dir | Handler / Sender | Exact Payload Schema | Effects & Notes |
|---:|---|---|---|---|
| `115` / `116` | C->S | `CGONpcAttackMon::sub_5193D8` / `sub_518C5B` | `u16` npcObjId, `u16` damageOrState | Monster/Boss AI damage & state sync (`S->C 149` / `S->C 176`). |
| `118` (`0x0076`) | C->S | `sub_4EA367` / `sub_4EA3CD` (`0x004EA367`) | `u8` bomberIdx, `u8` flag, `u8` x, `u8` y, `u8` type, `u8` extra | Triggers special tile/bomber action (`S->C 154` `sub_4ECD11`: `u8 x, u8 y, u8 (bomberIdx<<4)|type`). |
| `119` (`0x0077`) | C->S | `sub_522107` / `sub_522252` (`0x00522107`) | `u8` bossSubOp, `bytes...` | Boss AI action broadcast (`S->C 149`). |
| `121` (`0x0079`) | C->S | `sub_44B969` (`0x0044B969`) | `u8` flagsAndBomberIdx, `u8` x, `u8` y | Pushes bomb along tile line (`S->C 146` `sub_4EEB75`). |
| `122` (`0x007A`) | C->S | `sub_44E435` (`0x0044E435`) | `u8` slotIdx, `str` message | In-game speech bubble chat (`S->C 21` `sub_4F4D49`: `str formatted, u8(0)`). |
| `123` (`0x007B`) | C->S | `sub_44B72D` (`0x0044B72D`) | `u8` x, `u8` y, `u8` `(bomberIdx<<4)|dir` | Throws bomb (`S->C 180` `sub_4EAC86`: `u8 bombId, u8 bomberIdx, u8 x, u8 y`). |
| `125` (`0x007D`) | C->S | `sub_4EE3DF` (`0x004EE3DF`) | `u8` bomberIdx, `u8` a3, `u8` slotIdx, `u8` a4 | Revives bomber or transitions to ghost (`S->C 156` `sub_4ECDDB` / `157` / `158`). |
| `126` (`0x007E`) | C->S | `sub_4EC3FD` (`0x004EC3FD`) | *(empty)* | Match draw timeout -> `finishMatch(null)` (`S->C 148` + `S->C 153`). |
| `128` (`0x0080`) | C->S | `sub_44F405` (`0x0044F405`) | `u8` bomberIdx, `u8` x, `u8` y | Picks up map item / clears tile (`S->C 142` `sub_4EB01C`). |
| `129` / `130` | C->S | `sub_4F588D` / `sub_4F574C` | `u8(1)` | Round sync ack (`129`) and stage transition ack (`130`). |
| `132` (`0x0084`) | C->S | `sub_4F1690` (`0x004F1690`) | `u8` count, `u16` a5, `u16` a4, `u8` a2, `u16` a9, `count * (u8 x, u8 y)` | Batch tile destruction & item spawn (`S->C 151` `sub_4F24A6`). |
| `133` (`0x0085`) | C->S | `sub_50CD79` (`0x0050CD79`) | `u8` randSeed, `u32` x, `u32` y, `tiles...` | Boss skill target tile effect (`S->C 149`). |
| `135` (`0x0087`) | C->S | `sub_4EA946` (`0x004EA946`) | `5 * u32` perfMetrics | Reports client frame/network performance metrics. |
| `136` / `137` | C->S | `sub_578D1F` / `sub_579F03` (`0x00578D1F`) | `u16` objId, `20B state` / `u32 val` | Updates (`S->C 176`) or removes (`S->C 177`) `CSyncGameObjectMan` object. |
| `138` / `139` / `140` | C->S | `sub_4E9A13` / `sub_4FB3B2` / `sub_4FB7C9` | Tile coords / script state | Bomb chain tile check (`138`), map script sync (`139`), map script tick (`140`). |
| `141` (`0x008D`) | C->S | `sub_58587E` (`0x0058587E`) | `u8` bomberIdx, `u8` bombId, `u8` flag | Triggers remote control bomb (`S->C 141` `sub_4ECAAA`). |
| `143` (`0x008F`) | C->S | `sub_587966` (`0x00587966`) | `str` data, `u8` id, `u8` flag | Custom game object state sync (`S->C 149`). |
| `144` (`0x0090`) | C->S | `sub_508B55` (`0x00508B55`) | `u8` bomberIdx, `[u16 x, u16 y]` | Notifies player trapped in water balloon (`S->C 165` `sub_4EAC12`: `u8 bomberIdx, u16 x, u16 y`). |
| `145` (`0x0091`) | C->S | `sub_4EA141` (`0x004EA141`) | `u8(1)` | Replies to `S->C 182` in-game alive check. |
| `146` / `147` / `148` | C->S | `sub_509789` / `sub_57BEF4` / `sub_4EAB99` | Hazard / RTT / desync info | Sudden death hazard (`146`), UDP peer RTT report (`147`), game desync report (`148`). |
| `149` (`0x0095`) | C->S | `CUDPPeerMan::sub_57BEF6` (`0x0057BEF6`) | Exactly `u8 peerIdx` (`0..11`) | Requests TCP fallback for the indexed UDP peer; the GameServer reconstruction relays the index via `S->C 125` (`CUDPPeerManBase::sub_5ECBF0`). |
| `150` (`0x0096`) | C->S | `sub_4D18B3` (`0x004D18B3`) | *(empty)* | Exits practice match -> `S->C 153` (`Stage 12`). |
| `153` (`0x0099`) | C->S | `sub_50E781` (`0x0050E781`) | `u8` bomberIdx, `u8` itemSlot, `u8` itemType | Uses active game item (`S->C 145` `sub_4EA9CC`). |
