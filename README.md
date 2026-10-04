# Crazy Arcade / BnB Taiwan v22 reconstruction

This repository contains the original Taiwan client artifacts and a separate TypeScript + Bun server reconstruction.

## Repository layout

- `CA.exe`, `CA.exe.c`, `.idx` / `.idd`, `.ssd`, `.ini`, `CATW.ini`, and `extracted/` — client binaries, decompilation, and evidence-bearing resources. These remain at the repository root so the server can load them without copying large proprietary assets.
- `CrazyArcade_Client_to_Server_Faithful_Reconstruction.md` — the reconstruction requirements and research constraints.
- `server/` — all runnable server code, SQLite persistence, tests, lockfile, and the supporting packet/state/evidence documentation. See [`server/README.md`](server/README.md).

## Quick start

```sh
cd server
bun install
bun run start
```

Run the automated checks from `server/`:

```sh
bun run check
```

By default, the Taiwan v22 endpoints are:

| Service | TCP | UDP |
|---|---:|---:|
| LoginServer | 3838 | 3839 |
| GameServer | 9339 | 9340 |
| Messenger handoff | 8339 | — |

Set `PUBLIC_IP` to the IPv4 address that the client can reach. Set `HOST` to the local bind address (normally `0.0.0.0`); these are intentionally different settings. Logs can be filtered with `BNB_LOG_LEVEL=debug|info|warn|error|silent`.
