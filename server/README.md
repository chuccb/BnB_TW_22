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
| `BNB_LOG_LEVEL` | `debug` outside tests | Structured logger threshold |

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
