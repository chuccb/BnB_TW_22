# CrazyArcade (BnB TW v22) — State Machine Specification

## 1. Connection & Session Lifecycle (`CMultiServer` & `CPacketSocket`)

```
[TCP Connect to 3838]
     │
     ▼
[deg=0, rxCounter=40, txCounter=40, hasKey=0]
     │
     ├── S->C Connect Hello (deg 0, N+3 bytes, frame[0] encodes initKey in 0..15)
     │   (CClientSocket::sub_5D86DD validates minVer<=22<=curVer, sets deg=3 Rx / deg=2 Tx, key=sessionKey)
     ▼
[Authenticated Framing: C->S deg 2 (N+5 bytes), S->C deg 3 (N+7 bytes), rxCounter=46, txCounter=40]
     │
     ├── (If First Login Socket Connect: dword_92CB98 == 0)
     │     └── C->S 0 (5x SSD Adler32Zero hashes via CSmartStream::sub_6984B0)
     │           ├── S->C 189 (csysstr.ssd)
     │           ├── S->C 2   (filterstr.ssd)
     │           ├── S->C 1   (fxdynmapinfo.ssd)
     │           └── S->C 53  (fxdynimginfo.ssd + esfn.ssd) ──► dword_92CB98 = 1
     ▼
[Post-Connect Callback Invoked]
     ├── Login Socket: sends C->S 2 / C->S 11 / C->S 31 (Login)
     ├── Game/Channel Socket: sends C->S 6 (Handoff Auth)
     └── Shop Socket: sends C->S 38 (Shop Auth)
```

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
                                                       │ C->S 5 (Select Channel)        │
                                                       │ S->C 7 (IP, Port, Token)       │
                                                       │ [Reconnect / Handoff C->S 6]   │
                                                       │ S->C 33, S->C 9(11), S->C 75   │
                                                       ▼                                │
┌──────────────────┐  C->S 37/38 -> S->C 261/16  ┌─────────────────────┐  C->S 13 (Back)│
│ 14: CShopStageNew│◄───────────────────────────►│   11: CLobbyStage   ├────────────────┘
│ 20: CUserMarket  │  C->S 318/320 -> S->C 262   │  (S->C 194,196,250) │
└──────────────────┘                             └────┬───────────▲────┘
                                                      │           │
                          C->S 75 / 79 (Create Room)  │           │ C->S 78 (Leave Room)
                          C->S 76 (Join Room)         │           │ S->C 9 (u32(11))
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
   - Once all active players in the room have loaded, the server broadcasts `S->C 135` (`sub_4F2065`) containing the match seed, timer duration (`180,000ms`), hurry-up time (`120s`), sudden death time (`150s`), 30 FPS flag (`1`), UDP relay address/port, local primary slot, and the 3 UDP endpoints `(ip, port)` for each of the 10 slots (`0..9`).
   - During gameplay:
     - Bomber movement, actions, pets, and sync objects are exchanged via UDP (`MTUDPPeer` plain BE inner opcodes `0..4`, or TCP fallback `C->S 149` -> `S->C 125`).
     - Bomb placement (`C->S 107` -> `S->C 138`), bomb kick/throw (`C->S 109` -> `S->C 137`), hazard trigger (`C->S 108` -> `S->C 139`), box push (`C->S 110` -> `S->C 140`), item pickup (`C->S 111` -> `S->C 141`), tile destroy (`C->S 112` -> `S->C 142`), item spawns (`C->S 127` -> `S->C 149`, `C->S 131` -> `S->C 151`), and bomber trap/rescue/death (`C->S 113` `subType 2..5` -> `S->C 144`) are synchronized over TCP.
3. **Match Completion (`GAME_OVER` -> `RETURN_TO_ROOM`)**:
   - When only one team/player remains alive (or `C->S 114` stage clear arrives), the server computes rewards (EXP, level-up via `sub_4A49D5`, Lucci, Win/Lose/Draw records), persists them to SQLite, and broadcasts `S->C 148` (`sub_4F2F8B` + `CGOGameResult::sub_455957`).
   - The server then sends `S->C 153` (`sub_4F2D1A`: `[u8(0), u8(mapTheme)]`), returning players to `CPrepareStage` (`Stage 12`).
