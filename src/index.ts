import { CrazyArcadeServer } from "./network/server.ts";

export { CrazyArcadeServer } from "./network/server.ts";
export { WorldState, ClientSession } from "./state/worldState.ts";
export { loadConfig, DEFAULT_CONFIG, TW_ENABLED_FEATURES } from "./config/index.ts";
export { ClientOpcode, ServerOpcode, UdpOpcode, StageId } from "./protocol/opcodes.ts";

if (import.meta.main) {
  const server = new CrazyArcadeServer();
  const { tcpPort, udpPort } = await server.start();
  console.log(
    `[BnB TW v22 Server] Listening on TCP ${server.config.host}:${tcpPort} | UDP ${server.config.host}:${udpPort}`
  );
  console.log(
    `[BnB TW v22 Server] Loaded ${server.state.resources.bomberAttrs.length} bomber characters, ${server.state.resources.itemAttrs.length} items, ${server.state.resources.mapList.length} maps, ${server.state.resources.ssdFiles.size} SSD/INI aliases.`
  );
}
