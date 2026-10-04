import { resolve } from "path";

export interface ServerConfig {
  host: string;
  publicIp: string;
  tcpPort: number;
  udpPort: number;
  gameTcpPort: number;
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
  // LoginServer default TCP port = 3838 (sub_5D6839 at 0x005D6839: n3838 = 3838)
  tcpPort: Number(process.env.TCP_PORT ?? 3838),
  // LoginServer / GameServer default UDP port = tcpPort + 1 = 3839 (CLoginStage::sub_565CC6 at 0x00565CC6)
  udpPort: Number(process.env.UDP_PORT ?? 3839),
  // GameServer default TCP port = 9339 (sub_5A9E45 at 0x005A9E45)
  gameTcpPort: Number(process.env.GAME_TCP_PORT ?? 9339),
  messengerPort: Number(process.env.MESSENGER_PORT ?? 8339),
  clientVersion: 22,
  minClientVersion: 22,
  regionId: 8, // Taiwan (tw)
  noticeUrl: "http://tw.beanfun.com/bnb/notice.htm",
  dbPath: process.env.DB_PATH ?? resolve(process.cwd(), "bnb_tw22.db"),
  repoRoot: process.cwd(),
  enabledFeatures: TW_ENABLED_FEATURES,
};

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const tcpPort = overrides.tcpPort ?? DEFAULT_CONFIG.tcpPort;
  const udpPort = overrides.udpPort ?? (overrides.tcpPort !== undefined ? tcpPort + 1 : DEFAULT_CONFIG.udpPort);
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    tcpPort,
    udpPort,
  };
}
