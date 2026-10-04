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
     ├── Connect Hello, then C->S 6 with the S->C 4 session token
     ├── S->C 33 + 75: Lobby stage handoff (`33` enters Stage 11; `75` prompts C->S 83)
     ├── No S->C 9 on the Lobby handoff: generic `CStage` opcode 9 requests a Crash_CA.dmp chunk
     └── C->S 9 may repeat after reconnect; it is not a second LoginServer cache handoff
```

The default Taiwan peer ports are LoginServer TCP/UDP `3838/3839` and GameServer TCP/UDP `9339/9340`. `S->C 7` advertises `PUBLIC_IP` and the active GameServer TCP port.

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
                                                       │ C->S 6 token -> S->C 33, 75     │
                                                       ▼                                │
┌──────────────────┐  C->S 37/38 -> S->C 261/16  ┌─────────────────────┐  C->S 13 (Back)│
│ 14: CShopStageNew│◄───────────────────────────►│   11: CLobbyStage   ├────────────────┘
│ 20: CUserMarket  │  C->S 318/320 -> S->C 262   │  (S->C 194,196,250) │
└──────────────────┘                             └────┬───────────▲────┘
                                                      │           │
                          C->S 75 / 79 (Create Room)  │           │ C->S 78 (Leave Room)
                          C->S 76 (Join Room)         │           │ current server S->C 9 (separate fix pending)
                          C->S 77 / 81 (Quick Join)   │           │ S->C 103 (To Room)
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

**Opcode 9 scope.** The GameServer Lobby handoff no longer sends S->C 9: in the `CSelectServerStage` fallback, opcode 9 is the `Crash_CA.dmp` file-offset request described in `packets.md`. Other uses of the shared `ServerOpcode.StageTransition` constant (including the existing room-leave response) are not changed by this fix and need separate, stage-specific regression coverage before the shared name or behavior is revised.

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
