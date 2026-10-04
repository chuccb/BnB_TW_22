import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(MODULE_DIRECTORY, "../..");
const CLIENT_RESOURCE_ROOT = existsSync(resolve(SERVER_ROOT, "CA.exe"))
  ? SERVER_ROOT
  : resolve(SERVER_ROOT, "..");
const DEFAULT_LOGIN_TCP_PORT = Number(process.env.TCP_PORT ?? 3838);
const DEFAULT_LOGIN_UDP_PORT = Number(process.env.UDP_PORT ?? DEFAULT_LOGIN_TCP_PORT + 1);
const DEFAULT_GAME_TCP_PORT = Number(process.env.GAME_TCP_PORT ?? 9339);
const DEFAULT_GAME_UDP_PORT = Number(process.env.GAME_UDP_PORT ?? DEFAULT_GAME_TCP_PORT + 1);

export interface ServerConfig {
  host: string;
  publicIp: string;
  tcpPort: number;
  udpPort: number;
  gameTcpPort: number;
  gameUdpPort: number;
  messengerPort: number;
  clientVersion: number;
  minClientVersion: number;
  regionId: number;
  noticeUrl: string;
  dbPath: string;
  repoRoot: string;
  enabledFeatures: Set<number>;
}

/**
 * Taiwan region feature flags from sub_5CEA88 (0x005CEA88) when dword_92AC84 == 8
 */
export const TW_ENABLED_FEATURES = new Set<number>([
  0, 1, 2, 7, 9, 10, 11, 14, 15, 16, 17, 19, 20, 21, 22, 24, 29, 30, 31, 33, 34, 35,
]);

export function isFeatureEnabledTW(featureId: number): boolean {
  return TW_ENABLED_FEATURES.has(featureId);
}

export const DEFAULT_CONFIG: ServerConfig = {
  host: process.env.HOST ?? "0.0.0.0",
  publicIp: process.env.PUBLIC_IP ?? "127.0.0.1",
  // LoginServer default TCP port = 3838 (sub_5D6839 at 0x005D6839).
  tcpPort: DEFAULT_LOGIN_TCP_PORT,
  // LoginServer UDP defaults to TCP + 1 (3839 at the official Taiwan defaults).
  udpPort: DEFAULT_LOGIN_UDP_PORT,
  // GameServer defaults: TCP 9339 and UDP TCP + 1 = 9340.
  gameTcpPort: DEFAULT_GAME_TCP_PORT,
  gameUdpPort: DEFAULT_GAME_UDP_PORT,
  messengerPort: Number(process.env.MESSENGER_PORT ?? 8339),
  clientVersion: 22,
  minClientVersion: 22,
  regionId: 8, // Taiwan (tw)
  noticeUrl: "http://tw.beanfun.com/bnb/notice.htm",
  dbPath: process.env.DB_PATH ?? resolve(SERVER_ROOT, "bnb_tw22.db"),
  repoRoot: process.env.CLIENT_ROOT ?? CLIENT_RESOURCE_ROOT,
  enabledFeatures: TW_ENABLED_FEATURES,
};

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const tcpPort = overrides.tcpPort ?? DEFAULT_CONFIG.tcpPort;
  const udpPort = overrides.udpPort ?? (overrides.tcpPort !== undefined ? tcpPort + 1 : DEFAULT_CONFIG.udpPort);
  const gameTcpPort = overrides.gameTcpPort ?? DEFAULT_CONFIG.gameTcpPort;
  const gameUdpPort =
    overrides.gameUdpPort ??
    (overrides.gameTcpPort !== undefined ? gameTcpPort + 1 : DEFAULT_CONFIG.gameUdpPort);
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    tcpPort,
    udpPort,
    gameTcpPort,
    gameUdpPort,
  };
}
