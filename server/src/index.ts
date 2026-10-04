import { CrazyArcadeServer } from "./network/server.ts";

export { CrazyArcadeServer } from "./network/server.ts";
export { WorldState, ClientSession } from "./state/worldState.ts";
export { loadConfig, DEFAULT_CONFIG, TW_ENABLED_FEATURES } from "./config/index.ts";
export { ClientOpcode, ServerOpcode, UdpOpcode, StageId } from "./protocol/opcodes.ts";

if (import.meta.main) {
  const server = new CrazyArcadeServer();
  const ports = await server.start();
  console.log(
    `[Crazy Arcade / BnB TW v22] LoginServer TCP ${server.config.host}:${ports.tcpPort} / UDP ${server.config.host}:${ports.udpPort}`
  );
  console.log(
    `[Crazy Arcade / BnB TW v22] GameServer TCP ${server.config.host}:${ports.gameTcpPort} / UDP ${server.config.host}:${ports.gameUdpPort}`
  );
  console.log(
    `[Crazy Arcade / BnB TW v22] Loaded ${server.state.resources.bomberAttrs.length} bomber characters, ${server.state.resources.itemAttrs.length} items, ${server.state.resources.mapList.length} maps, ${server.state.resources.ssdFiles.size} SSD/INI aliases.`
  );
}
