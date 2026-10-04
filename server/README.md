# Crazy Arcade / BnB TW v22 server

Runnable server implementation for the Taiwan region client (`regionId = 8`, CP950, client version 22). The server loads the original client-side evidence from the repository root; client binaries and assets are deliberately not copied into this directory.

## Run and verify

From this directory:

```sh
bun install
bun run start
```

```sh
bun run check
```

The server uses Bun TCP/UDP sockets, `bun:sqlite`, and CP950 text encoding. It starts a LoginServer and a separate GameServer so the client can perform the verified `LoginServer -> CSelectServerStage -> GameServer` TCP handoff.

## Logs and Shop-click diagnostics

The default `info` level keeps routine cache-sync and request-decoding details quiet. It retains listener/session lifecycle summaries and high-level handoff events. When the server decodes a packet on the statically evidenced Shop connection path, it emits a `ShopTrace` line with the timestamp, session ID, LoginServer/GameServer connection kind, remote endpoint, local port, stage, opcode, and payload length. These are **Shop-flow candidates**, not proof that a UI click reached its callback or caused a send. The TCP close summary includes a bounded per-session packet timeline; `S->C` rows mean socket write calls, not verified Client receipt.

For every decoded packet and framing/byte-preview diagnostics, run:

```sh
BNB_LOG_LEVEL=debug bun run start
```

Known login credentials, session-handoff tokens, Shop connection credentials, Nexon Pass/coupon codes, and Nexon Club credential packet previews are redacted. Other debug previews may still contain client data; review before sharing logs. Colors are automatic only on a TTY. Set `BNB_LOG_COLOR=never` to disable them or `BNB_LOG_COLOR=always` to force them. `NO_COLOR=1` disables automatic color.

If a click produces no `ShopTrace` event, that establishes only that no listed candidate reached the server dispatcher in the observed interval. Check every TCP session (including the separate GameServer/redirect connection) and use debug or Client-side socket tracing to look for other packets; server logs cannot prove that the Client did or did not invoke its local packet writer.

## Official-client mapping

The implementation keeps the observed client names alongside readable TypeScript names:

- `CPacketSocket` framing and cryptography — `src/protocol/framing.ts`, `cipher.ts`, `crc.ts`, and `primitives.ts`.
- Taiwan `CISmartStream` / `COSmartStream` and CP950 — `src/protocol/stream.ts`, `textEncoding.ts`.
- `CMultiServer` (`multisvr.ssd`) — `src/resources/archive.ts` plus `handlers/authHandler.ts`.
- `CChannelCache` / `CChannelInfo` (`channel2_001.ssd`) — `src/protocol/channelCache.ts` and `handlers/channelHandler.ts`.
- `CLoginStage` / `CSelectServerStage` / `CLobbyStage` / `CPrepareStage` / `CGameStage` / `CShopStageNew` — stage-specific packet handlers and the central dispatcher.

`channel2_001.ssd` is supplied dynamically by the server in this client flow; it is not present as a standalone file in the checked-in client directory. The four default channel records are therefore clearly identified as structurally valid reconstruction defaults, not claimed to be a recovered official production channel list.

## Configuration

| Environment variable | Default | Purpose |
|---|---:|---|
| `HOST` | `0.0.0.0` | Local bind address for TCP and UDP listeners |
| `PUBLIC_IP` | `127.0.0.1` | IPv4 advertised to the client for server handoffs |
| `TCP_PORT` | `3838` | LoginServer TCP |
| `UDP_PORT` | `3839` | LoginServer UDP (`TCP_PORT + 1` by default) |
| `GAME_TCP_PORT` | `9339` | GameServer TCP |
| `GAME_UDP_PORT` | `9340` | GameServer UDP (`GAME_TCP_PORT + 1` by default) |
| `MESSENGER_PORT` | `8339` | Messenger handoff port |
| `DB_PATH` | `server/bnb_tw22.db` | SQLite database path |
| `BNB_LOG_LEVEL` | `info` outside tests | `info` shows lifecycle/handler summaries; set `debug` for per-frame crypto/framing details |

Connection-close summaries print a bounded, multi-line TCP timeline (one event per line) with sequence, elapsed time, direction, opcode, server-side stage, and plaintext packet size (including opcode; ConnectHello data for the initial handshake). C->S entries are marked `[decoded]` after frame validation/decryption and opcode extraction; this does not mean the handler accepted the payload. S->C entries are marked `[write-call]` when the server calls `socket.write`, not when the client acknowledges or parses those bytes. The close summary shows the current/pending stage and whether C->S 83 was observed, while explicitly noting that the client's modal/window state is not observable. The LoginServer session ID that issued an auth snapshot is carried into GameServer logs for correlation; the auth token and packet bodies are never logged. Older events are omitted once the 48-event timeline bound is reached, with the omission count retained. `BNB_LOG_LEVEL=debug` retains the detailed per-frame diagnostics.

`CLIENT_ROOT` may be supplied if the original client artifacts are not next to this repository's `server/` directory.

## Layout

- `src/config/` — region flags, official endpoint defaults, and paths to client artifacts.
- `src/db/` — strict SQLite persistence and prepared statements.
- `src/handlers/` — authentication, server/channel selection, lobby, room, game, shop, and common handlers.
- `src/network/` — separate LoginServer/GameServer TCP listeners and their UDP sockets.
- `src/protocol/` — named opcodes, CP950 strings, `CChannelCache` schema, SmartStream, framing, and crypto.
- `src/resources/` — `.idx` / `.idd`, map/attribute data, `.ssd` / `.ini` readers and synthesized server caches.
- `src/state/` — sessions, handoff snapshots, channel records, rooms, and runtime state.
- `src/utils/logger.ts` — structured symbolic logs and the in-memory recent-log ring buffer.
- `tests/` — protocol, client-resource, channel metadata, LoginServer/GameServer handoff, and gameplay-flow checks.
- `docs/` — evidence, packet catalog, client stages, coverage, and confidence/unknowns.
