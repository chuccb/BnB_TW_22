import { ClientOpcode, ServerOpcode, StageId, UdpOpcode } from "../protocol/opcodes.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogEntry {
  timestamp: string;
  level: Exclude<LogLevel, "silent">;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

function makeOpcodeNameMap(table: object): Map<number, string> {
  const names = new Map<number, string>();
  for (const [name, value] of Object.entries(table)) {
    if (typeof value !== "number") continue;
    // Keep the first name for aliased opcode numbers; it is the primary protocol label.
    if (!names.has(value)) names.set(value, name);
  }
  return names;
}

const CLIENT_OPCODE_NAMES = makeOpcodeNameMap(ClientOpcode);
const SERVER_OPCODE_NAMES = makeOpcodeNameMap(ServerOpcode);
const UDP_OPCODE_NAMES = makeOpcodeNameMap(UdpOpcode);
const STAGE_ID_NAMES = makeOpcodeNameMap(StageId);

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function detectDefaultLogLevel(): LogLevel {
  const envLevel = (process.env.BNB_LOG_LEVEL ?? "").trim().toLowerCase();
  if (
    envLevel === "debug" ||
    envLevel === "info" ||
    envLevel === "warn" ||
    envLevel === "error" ||
    envLevel === "silent"
  ) {
    return envLevel;
  }
  const isTestEnv =
    process.env.NODE_ENV === "test" ||
    process.argv.some((arg) => arg.includes("test") || arg.endsWith(".test.ts"));
  // Normal runs show lifecycle summaries and handler outcomes. Enable the packet-level
  // framing diagnostics explicitly with BNB_LOG_LEVEL=debug when needed.
  return isTestEnv ? "silent" : "info";
}

let currentLogLevel: LogLevel = detectDefaultLogLevel();
const recentLogs: LogEntry[] = [];
const MAX_RECENT_LOGS = 500;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

export function getRecentLogs(): readonly LogEntry[] {
  return recentLogs;
}

export function clearRecentLogs(): void {
  recentLogs.length = 0;
}

export function formatHexPreview(bytes: Uint8Array, maxBytes: number = 32): string {
  const slice = bytes.subarray(0, maxBytes);
  const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > maxBytes ? `${hex} ... (${bytes.length}B total)` : `${hex} (${bytes.length}B)`;
}

export function formatClientOpcode(opcode: number): string {
  const name = CLIENT_OPCODE_NAMES.get(opcode);
  return name ? `${opcode} (${name})` : `${opcode} (UnknownClientOpcode)`;
}

export function formatServerOpcode(opcode: number): string {
  const name = SERVER_OPCODE_NAMES.get(opcode);
  return name ? `${opcode} (${name})` : `${opcode} (UnknownServerOpcode)`;
}

export function formatUdpOpcode(opcode: number): string {
  const name = UDP_OPCODE_NAMES.get(opcode);
  return name ? `${opcode} (${name})` : `${opcode} (UnknownUdpOpcode)`;
}

export function formatStageId(stageId: number): string {
  const name = STAGE_ID_NAMES.get(stageId);
  return name ? `${stageId} (${name})` : `${stageId}`;
}

export function formatU32Hex(val: number): string {
  return `0x${(val >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

export function formatU8Hex(val: number): string {
  return `0x${(val & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
}

function writeLog(
  level: Exclude<LogLevel, "silent">,
  category: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    ...(data ? { data } : {}),
  };
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift();
  }

  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLogLevel]) {
    return;
  }

  const tag = `[${entry.timestamp}] [${level.toUpperCase().padEnd(5)}] [${category}]`;
  const messageLines = message.split("\n");
  const renderedMessage = messageLines
    .map((line, index) => (index === 0 ? `${tag} ${line}` : `  ${line}`))
    .join("\n");
  const details = data
    ? `${messageLines.length > 1 ? "\n  " : " "}${JSON.stringify(data)}`
    : "";
  if (level === "error") {
    console.error(`${renderedMessage}${details}`);
  } else if (level === "warn") {
    console.warn(`${renderedMessage}${details}`);
  } else {
    console.log(`${renderedMessage}${details}`);
  }
}

export const logger = {
  debug(category: string, message: string, data?: Record<string, unknown>): void {
    writeLog("debug", category, message, data);
  },
  info(category: string, message: string, data?: Record<string, unknown>): void {
    writeLog("info", category, message, data);
  },
  warn(category: string, message: string, data?: Record<string, unknown>): void {
    writeLog("warn", category, message, data);
  },
  error(category: string, message: string, data?: Record<string, unknown>): void {
    writeLog("error", category, message, data);
  },
};
