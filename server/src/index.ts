import { CrazyArcadeServer } from "./network/server.ts";
import { logger } from "./utils/logger.ts";

export { CrazyArcadeServer } from "./network/server.ts";
export { WorldState, ClientSession } from "./state/worldState.ts";
export { loadConfig, DEFAULT_CONFIG, TW_ENABLED_FEATURES } from "./config/index.ts";
export { ClientOpcode, ServerOpcode, UdpOpcode, StageId } from "./protocol/opcodes.ts";

if (import.meta.main) {
  const server = new CrazyArcadeServer();
  await server.start();
  logger.info("Startup", "Client resource catalog loaded", {
    regionId: server.config.regionId,
    clientVersion: server.config.clientVersion,
    bomberCharacters: server.state.resources.bomberAttrs.length,
    items: server.state.resources.itemAttrs.length,
    maps: server.state.resources.mapList.length,
    ssdIniAliases: server.state.resources.ssdFiles.size,
  });
}
