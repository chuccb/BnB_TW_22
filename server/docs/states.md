# CrazyArcade (BnB TW v22) — State Machine Specification

## 1. Connection & Session Lifecycle (`CMultiServer` & `CPacketSocket`)

The Taiwan login path uses a bootstrap connection, a LoginServer connection, and a separate GameServer connection. The server must run both TCP listeners; returning the game endpoint on S->C 7 while only listening on 3838 is not sufficient.

```
[Bootstrap / LoginServer TCP 3838]
     │
     ▼
[deg=0, clientToServerCounter=40, serverToClientCounter=40, hasKey=0]
     │
     ├── S->C Connect Hello (deg 0, N+3 bytes)
     │   CPacketSocket::sub_699D60 increments S->C counter once: 40 -> 43
     │   CClientSocket::sub_5D86DD installs sessionKey, S->C deg=3 / C->S deg=2
     ├── C->S 0: dynamic-image cache context, csysstr/multisvr/filterstr cache values, optional multisvrn cache value
     ├── S->C 189, 2, 1, 53: ordered cache sync; client closes the bootstrap socket
     ▼
[LoginServer TCP 3838, new CPacketSocket]
     ├── Connect Hello, then C->S 2 / 11 / 31 login variant
     ├── S->C 4: account/player data + session token
     ├── C->S 9: request channel cache
     ├── S->C 10 + 12 + 11: CChannelCache, population values, messenger handoff
     ├── C->S 5: category + category-relative ordinal
     └── S->C 7: result=1 + category + ordinal + GameServer IPv4/TCP port
          client closes LoginServer socket and connects to the advertised endpoint
     ▼
[GameServer TCP 9339, new CPacketSocket]
     ├── Connect Hello; server-side stage starts at SelectServer (10)
     ├── C->S 6 (`sub_5D893D`; includes the S->C 4 token) authenticates the handoff
     ├── Server records Lobby (11) as pending; C->S 6 alone does not establish Lobby entry
     ├── S->C 13 (`LobbyStageTransition`; feature 22 adds `u8(0)`) requests StageId.Lobby (11)
     ├── S->C 75 (`u32(0)`) invokes `sub_4B94A6`, prompting C->S 83 and feature-32 empty C->S 338
     ├── C->S 83 is logged as a decoded client signal; it clears the pending transition and triggers Lobby sync
     ├── With Taiwan feature 32 disabled, the server sends S->C 207 after C->S 83; feature 32 enabled keeps C->S 338 -> S->C 207
     ├── Lobby `sub_4C86A2` uses S->C 207 to close the pending `LoadingChannelInfo` notice; the server write does not prove client receipt/dismissal
     ├── No S->C 9 on the Lobby handoff: generic `CStage` opcode 9 requests a Crash_CA.dmp chunk
     └── C->S 9 may repeat after reconnect; it is not a second LoginServer cache handoff
```

The default Taiwan peer ports are LoginServer TCP/UDP `3838/3839` and GameServer TCP/UDP `9339/9340`. `S->C 7` advertises `PUBLIC_IP` and the active GameServer TCP port.

**GameServer handoff gate (server-side reconstruction).** The server accepts C->S 6 only on a GameServer connection using the confirmed `sub_5D893D` layout. It requires one or two players, matching declared/player/slot counts, an already-selected channel, a nonzero token and authentication snapshot from the prior LoginServer session, and matching token and usernames for existing database users. A failed check is logged and rejected without entering Lobby or sending the Lobby transition; it never creates an account. The auth snapshot retains the issuing LoginServer session ID only for cross-connection log correlation; the token value is not written to logs or added to the wire protocol. The current handler does not itself close the TCP socket on rejection. These are defensive server rules covered by local tests, not evidence that the official client accepts the resulting transition.

**Server-side stage and UI evidence limits.** `ClientSession.stageId` is server bookkeeping, not a reading of the client's window: a new GameServer TCP session starts at `StageId.SelectServer` (10); a validated C->S 6 records Lobby (11) as pending while the server writes S->C 13/75; on this handoff path, decoding C->S 83 updates the modeled stage and clears that pending transition. The legacy C->S 12 lobby-handler branch also sets the server-side stage but does not mark C->S 83 as observed. C->S 83 is a client signal prompted by the S->C 75 handler, not proof that a local wait/modal dialog closed. The source-confirmed client clears the confirmed `LoadingChannelInfo` notice on S->C 207. With Taiwan feature 32 disabled, the server now writes that packet after C->S 83; this is a server write call, not client receipt, dispatch, or visible dismissal. No server-side stage field exposes the client's actual window or modal state. Close timelines mark C->S events as decoded and S->C events as socket-write calls, not client receipts.

**Dynamic-map sync, Client write, and restart loader.** On the Taiwan feature-32-disabled Lobby path, the server writes S->C 207 after the decoded C->S 83 signal. The Client compares its local `fxdynmapinfo.ssd` body checksum and can send empty C->S 282 when the file is missing or mismatched. For S->C 205, `sub_4DFE20` parses the v22 record schema and compares `sub_6984B0`'s checksum with the expected value; mismatch sends C->S 282 and returns failure. Only success reaches `sub_4E0131`'s file-write/reload branch. Its `COSmartStream` constructor at `0x00698790` copies the decompressed v22 payload and zeros the output encoded-container length/valid flag. `sub_6989C0` therefore calls `sub_6985C0` to serialize that payload (compressing when beneficial) and writes `ssi1 + Adler32(full generated container) + generated container`. The separate `sub_698800` COSmartStream copy path can reuse a marked-valid encoded container, but `sub_4E0131` does not call it. A successful Lobby cache write is already v22 (18B record tail). The former server startup loader mistakenly treated this v22 body as the tracked legacy 16B-tail input and widened it a second time; loading a format-valid Client `ssi1` v22 fixture reproduced the failure mechanism. The loader now distinguishes the exact v22 and pre-v22 schemas, preserves v22 data, upgrades only validated legacy data, and fails explicitly on malformed input. Tests cover both disk versions and checksum/schema errors. The actual user-generated Windows file is not available in this checkout; the flow test still injects C->S 282 manually and does not run the official Client's click/checksum/write path.

---

## 2. Client Stage Transitions (`CMainWnd::sub_5AAE44`, `CStage::sub_4BB82A`, `sub_4B8D42`)

```
┌──────────────────┐
│  0: CTitleStage  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐  C->S 2 / 31 (Login) ┌─────────────────────────┐
│  1: CLoginStage  ├─────────────────────►│  S->C 4 (Login Result)  │
└──────────────────┘                      │  C->S 9 (Channel Req)   │
                                          │  S->C 10 (Channel List) │
                                          │  S->C 12 (Populations)  │
                                          │  S->C 11 (Enter Stage)  │
                                          └────────────┬────────────┘
                                                       │
                                                       ▼
                                          ┌─────────────────────────┐
                                          │ 10: CSelectServerStage  │◄──────────────────┐
                                          └────────────┬────────────┘                   │
                                                       │ C->S 5 (u8 category, u32 ordinal)│
                                                       │ S->C 7 (result=1, Game IP/port) │
                                                       │ [Reconnect to GameServer TCP]  │
                                                       │ C->S 6 -> S->C 13, then 75     │
                                                       ▼                                │
┌──────────────────┐  Shop flow (details below)       ┌─────────────────────┐  C->S 13 (Back)│
│ 14: CShopStageNew│◄───────────────────────────►│   11: CLobbyStage   ├────────────────┘  C->S 13 (ReturnToChannelSelect)
│ 20: CUserMarket  │  local C->S 318 -> S->C 262/265 │  (S->C 194,196,250) │
└──────────────────┘                             └────┬───────────▲────┘
                                                      │           │
                          C->S 75 / 79 (Create Room)  │           │ C->S 78 (Leave Room; Lobby is local)
                          C->S 76 (Join Room)         │           │ S->C 103 (to remaining room members)
                          C->S 77 / 81 (Quick Join)   │           │ C->S 91 kick -> S->C 103 (target + room)
                          S->C 79 / 80 + S->C 102     ▼           │
                                                 ┌────────────────┴────┐
                                                 │  12: CPrepareStage  │
                                                 │  17: CChattingStage │
                                                 │  18: CExchangeStage │
                                                 │  19: CPracticeStage │
                                                 └────┬───────────▲────┘
                                                      │           │
                          C->S 86 (Ready -> S->C 104) │           │ S->C 153 (u8(0), mapTheme)
                          C->S 93 (Start Game)        │           │ (After Match Ends / C->S 117)
                          S->C 112 + S->C 113         ▼           │
                                                 ┌────────────────┴────┐
                                                 │   13: CGameStage    │
                                                 │  UDP op 1 / TCP 113 │
                                                 │  S->C 136 + S->C 135│
                                                 │  TCP 107..149 / UDP │
                                                 │  S->C 148 (Result)  │
                                                 └─────────────────────┘
```

**Opcode namespaces and transition evidence.** The flow above distinguishes `ClientOpcode`, `ServerOpcode`, and `StageId`: C->S 13 is `ReturnToChannelSelect`, S->C 13 is `LobbyStageTransition` in the SelectServer root-vtable view, and `StageId.Game` is 13 while `StageId.Lobby` is 11. S->C 33 is not the Lobby transition; in the SelectServer root-vtable view it reaches `CStage::sub_4B8D5F` (dynamic-I16 parsing). The Lobby handoff sends S->C 13 before S->C 75. The S->C-13 handler is gated by `CSelectServerStage` state `this+5163 == 2`, which the successful S->C-7 branch sets after calling `sub_5D893D` to send C->S 6. `sub_4B96B1` reads one byte when Taiwan feature 22 is enabled, then calls `sub_5AAA5C` with StageId 11.

**Static stage-switch chain.** `sub_5AAA5C` updates manager bookkeeping from the old StageId and writes 11 at manager offset `+16`. The `CMainSystem` vtable at `.rdata` VA `0x007C1B20` has slot `+12` -> `sub_5AA3F4`, which compares that requested ID with `CMainWnd+180`. In the app loop (`CFxApp::sub_5A2133` -> `sub_5A9EA7`), a mismatch invokes `sub_5AEF3F` with the `CMainWnd*` and requested ID. Its StageId 11 branch tears down the active object, constructs `CLobbyStage` (or `CLobbyStageGuild` when `sub_59DBD9() == 77`), then calls the new object's virtual slot `+160`. The network packet-drain loop `sub_5AD7DE` stops dispatching on the old object once manager and window StageIds differ, so following S->C 75 is left for dispatch after the main-loop stage switch. This traces the static client transition path; it does not substitute for a live trace proving the official client received S->C 13 and completed the stage initialization.

**UserMarket permission, fee echo, and stage entry are distinct.** The Client consumes S->C 262 as a one-byte connection permission, not as the StageId 20 transition. Its S->C 265 handler copies the fee/configuration fields into C->S 320; the S->C 269 success branch is the Client path that requests StageId.UserMarket. This server's C->S 318 -> S->C 262/265 -> C->S 320 -> S->C 269 sequence is local reconstruction policy, not a production-server trace.


**Lobby Shop-control dispatch is statically established; the leading no-packet hypothesis is a false Client-side readiness gate (runtime value unobserved).** The top-bar Shop control is configured in `sub_469642` with `GlobalUI/BtShop`, the `Shop Button` descriptor, and command value `2`. `CCtrlWnd::sub_6A0FE0` copies descriptor `a2[19]` into control offset `+124`; `sub_4781C6` reads that field; and `CCtrlButton::sub_6A5610` passes it to the parent `CDialogWnd` vtable slot `+120`. In the `CGlobalButtonDlg` vtable that slot is `sub_46AE9B`, whose command `2` calls `sub_4BAACB(-1)`. The popup-menu Shop control is a separate `CCtrlButtonWithText`: `sub_46A3C0` configures its `Shop Button` descriptor with value `0`; it inherits the same click handler, and the parent vtable slot `+120` resolves to `CGlobalButtonMenuDlg::sub_46AF7A`, whose command `0` calls the same helper. This mapping is established by the data flow and vtables, not by resource labels alone. The `Fx.idx`-extracted `GlobalUI/BtShop.i16` and `Fx.idd` `GoToShop` translation (`LangID 1028`: `前往商店`) corroborate the control identity. `MyItem`, `MyInfo`, and `UserMarket` are separate controls; their mappings are outside this evidence.

The `-1` passed to `sub_4BAACB` is **not** an unconditional early return. The helper first applies a `sub_43827E(n0xB + 380)` state predicate and rejects StageId `13` or `18`; for argument `-1`, it calls `sub_4B9956(1)`. Although `CA.exe.c` declares that helper `void`, the machine code returns a meaningful EAX value and `sub_4BAACB` immediately tests and stores it. In Lobby StageId `11`, one local user yields index `0`; two local users open `CSelectUserDlg` and a result `>= 4` yields `result - 4` (cancel/other results yield `-1`); zero or other counts yield `-1`. A negative result takes the local `sub_437FB8(j + 1998, 14)` path and returns without constructing a packet. A nonnegative result passes the StageId-12-only gate (not applicable in Lobby) and reaches `sub_529AFB(dword_92E6F4, 2, a3)`.

**S->C 19 readiness update; runtime value/receipt remain unobserved.** The mapped Shop helper's first predicate is `sub_43827E(n0xB + 380)`; false returns before the user-selection path and before any C->S packet object is constructed. The `CUserDynamicInfo+380` value is a 12-byte encoded/check-validated wrapper, not a raw bool. Its constructor initializes logical zero via `sub_4409E5(ArgList+95, 0)`; the direct logical set-to-one found is the end of `sub_5ED779` via `sub_437FB8(this+95, 1)`, after a leading `u8 count` and per-user records. In this `CA.exe`, the `%55` counter branch in `sub_43827E` calls `sub_437FB8` at `0x00438319` with its just-decoded 32-bit value; `sub_437FB8` re-encodes that value and may copy/reallocate the 12-byte backing on its own `%111` branch, not logically reset it. The parallel `sub_437EEF` helper has the same copy/re-encoding behavior and is called by separate accessor `sub_438168`, not by `sub_43827E` in this binary. On checksum failure, the installed `psub_5AA2F5` callback sets separate `CMainSystem+108=1` (initialized to `0` by its constructor); it does not write `+380`. The recovered Shop submission boundary `sub_5AA68F` instead tests `CMainSystem+228` and uses the current socket pointer at `+104`, with no direct `+108` read; any other/indirect transport effect remains unknown. Five direct App-global readers were found: `sub_4BAACB`, `sub_4BAC7B`, `sub_468FCA`, `sub_4BC193`, and `sub_4BC236`; only `sub_4BAACB` is the verified Shop helper. `sub_468DF5` reads its own object's `this+380`, and `sub_5C67F6` reads `this+408*i+380`, so those equal offsets are not aliases. `sub_5EDC1A` destroys the wrapper only at App teardown. No other direct logical writer/reset or object-sized copy to the global member was found. In S->C 19's user records, the `u16` stored at `+20+12*i` by `sub_5ED30E` and read by `sub_5ED43B` is the level; the separate byte written by `sub_561F62` at `+164+12*i` is not that gate value.

The field belongs to the App-global `CUserDynamicInfo`, not a Stage/session object. WinMain calls `CFxApp::sub_5A4AAB` before the event loop; it calls `sub_5A36C0`, which allocates `0x264` bytes and constructs the global object if null. After the event loop, `CFxApp::sub_5A214D` calls its destructor, whose `sub_5EDC1A` destroys the wrapper and clears the global pointer. Stage switching in `sub_5AEF3F` does not reconstruct it, and no LoginResult/handoff/Stage reset of `+380` was found. LoginServer S->C 4's `sub_566E08` updates user/profile fields and calls `sub_5ED931` to clear the collection at `+188`; it does not call `sub_5ED779` or reset `+380`. Another parser (`sub_5B2878 -> sub_5B21B5`) updates the dynamic-info count and user fields without touching `+380` or calling the readiness setter. After S->C 19 parsing, `sub_4BA3BA` may set the separate settings-object field `n0xB_1+9` when `sub_5ED6AA(n0xB, 7)` is nonzero; `sub_565E29` can reset that separate field to zero. Neither operation resets `CUserDynamicInfo+380`. Thus, if the stage-fallback S->C 19 parser sets the gate during Login, the traced LoginResult and Stage-switch paths do not undo it; this is static data-flow, not a live-memory observation.

`CMainWnd::sub_5AF822` checks the general-server typed registry and then the GameServer typed registry before falling back to the current stage root slot `+0xB8` (slot 46). Opcode-19 entries `0x009758B4`/`0x0092E75C` are in the PE `.data` virtual-only zero-fill tail; no creator or write for either was recovered. App startup `sub_5A4AAB -> sub_5A47A8` constructs separate general/GameServer dispatcher objects; their pointer globals are distinct from the fixed typed-creator slots. The GameServer 70 creator pointer is written to `0x0092E828` by `sub_4B9F03` in the `CStage` constructor chain (`sub_4BD806 -> sub_4BD786 -> sub_4BD52F -> sub_4BA48B`); Stage teardown unregisters the callback and destroys the embedded creator, but does not clear that slot. Opcode 183 is written to `0x0092E9EC` by `sub_509A92` in a `CTimebombComponent` handler embedded at `this+12`; its component teardown unregisters and destroys that creator without clearing the slot. Slot 70/183 live pointers and validity after teardown were not instrumented. On an opcode-19 registry miss, ordinary Login root vptr `0x007BE424` (slot 46 -> `sub_569420`) and China Login root `0x007BDFEC` (slot 46 -> `sub_5654E8`) both forward unhandled opcode 19 to `CStage::sub_4BDBF5` with the same root pointer. That base case calls root slot 55 (`+0xDC`) -> `sub_4BA3BA` in both Login variants, as well as in `CStage` (`0x007B3624`), `CChatStage` (`0x007B27AC`), `CSelectServerStage` (`0x007BE7B4`) and `CLobbyStage` (`0x007B409C`). Lobby reaches the base case through `sub_4C86A2` -> `sub_4B0A63`; SelectServer's `sub_56D2FB` also forwards unhandled packets. The `0x004B8D5C` `ret 4` is the `+0xDC` entry of the Login **secondary** vtable (`0x007BE410`, subobject at `this+172`), not the root object that `CMainWnd` dispatches. The earlier claim that Login receipt is a no-op and the resulting stage-timing-window hypothesis are withdrawn; on the recovered stage-root fallback, S->C 19 can establish readiness while Login is active. Actual registry contents and this Client session's packet dispatch remain unknown.

By contrast, typed S->C GameServer 70 (`PUserInfoResult`) dispatches via `sub_4B92F3` to the Lobby embedded-handler secondary vtable (`0x007B4084`) slot `+0x0C` -> `sub_4C128B`. That delegate first calls main LobbyStage slot `+0xFC` (`sub_4C1201(this, 0)`, setting separate `CLobbyStage+6180=0`), then calls `sub_4A6379 -> sub_4BBCA8`; it does not reach `sub_4BA3BA`/`sub_5ED779`. `sub_4BBCA8` may call `sub_4BAACB(-1)` after a profile-modal result 4 outside stage 14, but the helper still gates on `CUserDynamicInfo+380` and does not set it. S->C 70 therefore cannot substitute for S->C 19; it remains distinct from C->S `ClientOpcode.QueryUserInfo` 70.

The current server's handoff/Lobby bootstrap sends S->C 13/75 and, after C->S 83, S->C 89/186/194/196/268/250/207—not S->C 19. Its S->C 70 sends are profile-query replies. This missing S->C 19 send path, combined with the Client's constructor-zero and no known per-Stage reset, is a strong conditional candidate for a false gate and no Client-originated Shop packet. It is not proof of the reported Client's runtime `+380` value, receipt/dispatch, or exact click path. `PUserInfoResult::sub_4368BF` and the local S->C 70 builder both begin with a `u32`, but their full schema remains unreconciled. S->C 207 and periodic C->S 14 do not write `+380`. No payload or send timing has been changed.

Once reached, `sub_529AFB` constructs one of three C->S packet objects: opcode `316` with `u8 a3` (caller-supplied; meaning not established) when `dword_929D6C + 228 != 0`, submitted by `CSendPacket::sub_57B757` -> `sub_5D842A`; opcode `269` with `u8(0)` through `sub_589DB9` -> `sub_5AA68F` on the `dword_929D6C` connection-manager path when its nested connection-state predicate passes; otherwise opcode `37` with `u8(11), u32(0)` (the values' field meanings are not established), again through `CSendPacket::sub_57B757` -> `sub_5D842A`. Thus C->S 269 does not use the same submission path as 37/316. These are statically reachable packet-submission calls, not proof of bytes reaching a socket or of server receipt. The reconstruction dispatches these opcodes to `handleShopPacket` (`37`/`316` currently produce S->C `261`/`48`; `269` currently produces S->C `198`, with further sync for mode `1`). The current 261-then-48 response ordering is local reconstruction policy, not an official-server trace.

**Conditional Shop follow-on packets and connection.** The click's initial writer need not be the last Client packet. `CShopConnectionMan::sub_529E8D` consumes S->C 48; when the endpoint is valid it calls `sub_5AA410`, which allocates a `CClientSocket` and begins a connection to the supplied host/port. Follow-on traffic can therefore use a separate TCP connection rather than the existing GameServer session. `sub_529D8E` builds C->S 38 and submits it through `sub_5AA68F` on the connection-manager path; when `this+8 == 2`, it also constructs an empty C->S 318 and submits it through `CSendPacket::sub_57B757`. `sub_5AA68F` queues only when its queue flag is set or sends when an active socket is ready; otherwise it returns `0`, so constructing C->S 38 does not prove wire transmission. Both the permission-success branch in `sub_52A129` (before its C->S 38 call) and the successful endpoint-connect branch in `sub_529E8D` set the manager's pending `this+12` state to `0`. Consequently, response ordering and socket readiness matter: the local server currently writes S->C 261 then 48, but this order is not validated against a production exchange, and the Client code alone does not prove C->S 38 reaches the new endpoint. On a successful one-byte permission result, `sub_52A129` may additionally emit C->S 98 `[u8(1)]` if `sub_4B8EE9` passes. `sub_529D8E` also has a separate caller after S->C 41, so C->S 38 is not exclusive to the initial Lobby click. After Stage 14 initialization, C->S 276/278/281 may request `.ini` streams if the corresponding checksums differ. These are conditional static paths; they do not prove any particular click took them.

For this reconstruction only, `buildShopRedirectPacket48` advertises `PUBLIC_IP:TCP_PORT` (`state.config.tcpPort`, default `3838` / LoginServer), not the default GameServer port `9339`. If the Client follows that local redirect, a new connection can appear as another LoginServer session. This endpoint choice does not establish the official production Shop endpoint. The S->C 48 packet's intervening u32 is read and discarded by the Client handler; the local builder currently fills it with `sessionKey`, but its wire meaning is unconfirmed.

Keep other Lobby toolbar paths separate: `CGlobalButtonDlg::sub_46AE9B` command `5` calls the active-stage vtable slot `+260` with `(-1, 1, -1)`, and command `8` calls `sub_4BAC7B(-1)`; `CGlobalButtonMenuDlg::sub_46AF7A` command `2` calls slot `+260` with `(0, 1, -1)`, and command `4` calls `sub_4BAC7B(-1)`. `sub_4BAC7B(-1)` has its own local-user/stage gates and can emit C->S `323` `[u8, u8]`; `CStage::sub_4BC236` has a separate local-user gate and can write empty C->S `302` then C->S `66` `[str username, u8(1), u8 localIdx]` outside Stage 14. Neither path is evidence for the mapped Shop control. No official-client click-time trace is available to show which runtime gates passed, whether a selection dialog was completed, or whether any submission reached a socket. A missing server C->S decoded row does not prove the Client never called its writer, and S->C write-call logs do not prove Client receipt or processing. Do not describe this as a server receiving a click packet and failing to reply.


**C->S 6 variants.** `sub_5D893D` is the confirmed post-S->C-7 SelectServer handoff writer and includes a per-player field97 u32, an opaque byte from `CNetworkFacade+8`, and two trailing u32s. `sub_5D8A3F` and `sub_5D8879` emit different shapes. At a traced `sub_5D8A3F` caller the final byte is the current StageId; it is not interchangeable with the `sub_5D893D` byte and neither should be treated as a destination based solely on its numeric value. The server implements the confirmed `sub_5D893D` variant; other C->S-6 variants remain stage-specific/unhandled pending evidence.

**Opcode 9 scope.** The GameServer Lobby handoff does not send S->C 9: in the `CSelectServerStage` and generic `CStage` fallback paths, opcode 9 is the `Crash_CA.dmp` file-offset request described in `packets.md`, not a stage transition. The server no longer sends it for C->S 78 (the Client changes to Lobby locally) or C->S 91 (the kicked Client receives S->C 103). These source-backed Client paths have local regression coverage; official-server timing and broadcast policy remain unverified (EXT-11). Keep opcode 9 stage-specific. In this build the outgoing-side symbol is `ServerOpcode.CrashDumpChunkRequest`; no generic `StageTransition` alias is used, and the Client dispatch path—not the number/name—determines its meaning.

---

## 3. Room & Match State Machine (`CSession`, `CPrepareStage`, `CGameStage`)

### 3.1 Room Slot States (`CPrepareStage`)
- Each room has 8 player slots (`0..7`) and 2 observer slots (`8..9`).
- Slot state is a 3-byte descriptor `[stateFlags, charByte, teamByte]`:
  - `stateFlags`:
    - `bit 0` (`0x01`): Slot Open (`1` = open, `0` = closed by chief)
    - `bit 1` (`0x02`): Occupied / Active flag
    - `bits 2..4` (`0x1C`): `0x00` = Waiting/Unready, `0x04` = Ready, `0x1C` = In Shop/Away
  - `charByte` (`& 0x3F`): Selected character ID (`0..10` = specific character from `Attr/BomberAttr`, `12` = Random).
  - `teamByte` (`& 0x1F`): Selected team (`0..7`).
- **Start Preconditions (`C->S 93`, `sub_4D5DB1` + `sub_4DF2EC`)**:
  - Sender must be Room Chief (`j[92] == senderSlotNetId`).
  - All occupied non-chief human slots must have `(stateFlags & 0x1C) == 0x04` (Ready).
  - If preconditions fail, server sends `S->C 112` with non-zero error code; if satisfied, server sends `S->C 112` (`u8(0)`) and broadcasts `S->C 113` (`sub_4D9F8A`) to all players in the room.

### 3.2 In-Game Lifecycle (`CGameStage`)
1. **Loading (`WAITING_FOR_LOAD`)**:
   - Upon entering `CGameStage` (`Stage 13`), each client loads the map (`CGameMapInfoList[mapId]`), initializes `CGameContext` and `CNetSyncMan`, and sends the 36-byte UDP load-registration packet (`sub_4ED400`, `opcode = 1`: `[u16(1), u32(userId), u16(roomId), u32(roomGameKey), u32(ip0), u16(port0), u32(ip1), u16(port1), u32(mapCrc8), 4B(p0Attrs), 4B(p1Attrs)]`) every 1 second until acknowledged.
   - Server acknowledges each loaded slot over TCP with `S->C 136` (`sub_4EA206`: `[u8 slotIdx]`).
2. **Countdown & Active Match (`PLAYING`)**:
   - Once all active players in the room have loaded, the server broadcasts `S->C 135` (`sub_4F2065`) containing the match seed, timer duration (`180,000ms`), hurry-up time (`120s`), sudden death time (`150s`), 30 FPS flag (`1`), GameServer UDP relay address (`PUBLIC_IP`) and port (`GAME_UDP_PORT`), local primary slot, and three UDP peer candidates `(ip, port)` for each occupied slot (`0..7`). The first two candidates come from the client's UDP registration; the third is reconstructed from the UDP packet's observed source endpoint (high-confidence inferred). Unavailable candidates stay `0.0.0.0:0`, never fabricated loopback endpoints; NAT traversal still needs live validation.
   - During gameplay:
     - Bomber movement, actions, pets, and sync objects are exchanged via UDP (`MTUDPPeer`; peer data uses `[u8(1), u8(localPeerIdx)] + payload`). The client requests TCP fallback with `C->S 149` (`CUDPPeerMan::sub_57BEF6`, exactly `[u8 peerIdx]`); the GameServer relays that index in `S->C 125`. The client-side wire format is confirmed in `CA.exe.c`; the server's room-broadcast policy remains a reconstruction.
     - Bomb placement (`C->S 107` -> `S->C 138`), bomb kick/throw (`C->S 109` -> `S->C 137`), hazard trigger (`C->S 108` -> `S->C 139`), box push (`C->S 110` -> `S->C 140`), item pickup (`C->S 111` -> `S->C 141`), tile destroy (`C->S 112` -> `S->C 142`), item spawns (`C->S 127` -> `S->C 149`, `C->S 131` -> `S->C 151`), and bomber trap/rescue/death (`C->S 113` `subType 2..5` -> `S->C 144`) are synchronized over TCP.
3. **Match Completion (`GAME_OVER` -> `RETURN_TO_ROOM`)**:
   - When only one team/player remains alive (or `C->S 114` stage clear arrives), the server computes rewards (EXP, level-up via `sub_4A49D5`, Lucci, Win/Lose/Draw records), persists them to SQLite, and broadcasts `S->C 148` (`sub_4F2F8B` + `CGOGameResult::sub_455957`).
   - The server then sends `S->C 153` (`sub_4F2D1A`: `[u8(0), u8(mapTheme)]`), returning players to `CPrepareStage` (`Stage 12`).
