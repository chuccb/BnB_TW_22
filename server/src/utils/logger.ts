import {
  ClientOpcode,
  ClientUdpOpcode,
  ReconstructedUdpInputOpcode,
  ServerOpcode,
  ServerUdpOpcode,
  StageId,
} from "../protocol/opcodes.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogEntry {
  timestamp: string;
  level: Exclude<LogLevel, "silent">;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogOutputOptions {
  /** Limit human-readable console details without removing fields from the in-memory log. */
  displayData?: Record<string, unknown>;
}

export interface FormatLogEntryOptions extends LogOutputOptions {
  /** Explicit color setting, mainly useful for formatter callers and tests. */
  color?: boolean;
}

interface OpcodeNameIndex {
  /** First declaration for a numeric value is its context-free fallback label. */
  primary: Map<number, string>;
  /** All declarations, in source order, so debug logs can expose overloaded aliases. */
  all: Map<number, string[]>;
}

function makeOpcodeNameIndex(table: object): OpcodeNameIndex {
  const primary = new Map<number, string>();
  const all = new Map<number, string[]>();
  for (const [name, value] of Object.entries(table)) {
    if (typeof value !== "number") continue;
    const aliases = all.get(value) ?? [];
    aliases.push(name);
    all.set(value, aliases);
    if (!primary.has(value)) primary.set(value, name);
  }
  return { primary, all };
}

function getOpcodeAliases(index: OpcodeNameIndex, opcode: number): string[] {
  return index.all.get(opcode)?.slice(1) ?? [];
}

const CLIENT_OPCODE_NAMES = makeOpcodeNameIndex(ClientOpcode);
const SERVER_OPCODE_NAMES = makeOpcodeNameIndex(ServerOpcode);
const CLIENT_UDP_OPCODE_NAMES = makeOpcodeNameIndex(ClientUdpOpcode);
const SERVER_UDP_OPCODE_NAMES = makeOpcodeNameIndex(ServerUdpOpcode);
const RECONSTRUCTED_UDP_INPUT_OPCODE_NAMES = makeOpcodeNameIndex(ReconstructedUdpInputOpcode);
const STAGE_ID_NAMES = makeOpcodeNameIndex(StageId);

// Prefer a narrower label only when the server-side session stage identifies a
// source-backed route. Otherwise keep the neutral first-declared label.
const SERVER_OPCODE_STAGE_LABELS: ReadonlyMap<number, ReadonlyMap<number, string>> = new Map<
  number,
  ReadonlyMap<number, string>
>([
  [
    StageId.Login,
    new Map<number, string>([
      [ServerOpcode.LoginResult, "LoginResult"],
      [ServerOpcode.MessengerHandoff, "MessengerHandoff"],
    ]),
  ],
  [
    StageId.SelectServer,
    new Map<number, string>([
      [ServerOpcode.ChannelSelectResult, "ChannelSelectResult"],
      [ServerOpcode.LobbyStageTransition, "LobbyStageTransition"],
    ]),
  ],
  [
    StageId.Lobby,
    new Map<number, string>([
      [ServerOpcode.LobbyStageRoute32, "LobbyStageRoute32"],
      [ServerOpcode.RankingTop3, "RankingTop3"],
    ]),
  ],
  [
    StageId.Prepare,
    new Map<number, string>([[ServerOpcode.QuickSlotEquipSync, "QuickSlotEquipSync"]]),
  ],
  [
    StageId.Game,
    new Map<number, string>([[ServerOpcode.BomberTrapped, "BomberTrapped"]]),
  ],
  [
    StageId.Shop,
    new Map<number, string>([
      [ServerOpcode.ShopInitAndStage14, "ShopInitAndStage14"],
      [ServerOpcode.ShopConfigCrc224, "ShopConfigCrc224"],
      [ServerOpcode.ShopSaleModifiers, "ShopSaleModifiers"],
      [ServerOpcode.ShopPurchaseDetail, "ShopPurchaseDetail"],
    ]),
  ],
]);

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
} as const;

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
  // Normal runs show lifecycle milestones and Shop-flow candidates. Use debug for every
  // decoded packet, framing diagnostics, and bounded TCP-byte previews.
  return isTestEnv ? "silent" : "info";
}

let currentLogLevel: LogLevel = detectDefaultLogLevel();
const recentLogs: LogEntry[] = [];
const MAX_RECENT_LOGS = 500;
const MAX_LOG_LINE_WIDTH = 132;
const MAX_LOG_VALUE_LENGTH = 112;

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
  const name = CLIENT_OPCODE_NAMES.primary.get(opcode);
  return name ? `${opcode} (${name})` : `${opcode} (UnknownClientOpcode)`;
}

export function getClientOpcodeAliases(opcode: number): string[] {
  return getOpcodeAliases(CLIENT_OPCODE_NAMES, opcode);
}

function getServerOpcodeLabelName(opcode: number, stageId?: number): string | undefined {
  const stageName =
    stageId === undefined ? undefined : SERVER_OPCODE_STAGE_LABELS.get(stageId)?.get(opcode);
  const knownNames = SERVER_OPCODE_NAMES.all.get(opcode);
  if (stageName && knownNames?.includes(stageName)) return stageName;
  return SERVER_OPCODE_NAMES.primary.get(opcode);
}

export function formatServerOpcode(opcode: number, stageId?: number): string {
  const name = getServerOpcodeLabelName(opcode, stageId);
  return name ? `${opcode} (${name})` : `${opcode} (UnknownServerOpcode)`;
}

export function getServerOpcodeAliases(opcode: number, stageId?: number): string[] {
  const labelName = getServerOpcodeLabelName(opcode, stageId);
  return (SERVER_OPCODE_NAMES.all.get(opcode) ?? []).filter((name) => name !== labelName);
}

export function formatClientUdpOpcode(opcode: number): string {
  const name = CLIENT_UDP_OPCODE_NAMES.primary.get(opcode);
  return name ? `${opcode} (${name})` : `${opcode} (UnknownClientUdpOpcode)`;
}

export function formatServerUdpOpcode(opcode: number): string {
  const name = SERVER_UDP_OPCODE_NAMES.primary.get(opcode);
  return name ? `${opcode} (${name})` : `${opcode} (UnknownServerUdpOpcode)`;
}

export function formatReconstructedUdpInputOpcode(opcode: number): string {
  const name = RECONSTRUCTED_UDP_INPUT_OPCODE_NAMES.primary.get(opcode);
  return name ? `${opcode} (${name})` : `${opcode} (UnknownReconstructedUdpInputOpcode)`;
}

export function formatStageId(stageId: number): string {
  const name = STAGE_ID_NAMES.primary.get(stageId);
  return name ? `${stageId} (${name})` : `${stageId}`;
}

export function formatU32Hex(val: number): string {
  return `0x${(val >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

export function formatU8Hex(val: number): string {
  return `0x${(val & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
}

function colorize(text: string, colorCode: string, enabled: boolean): string {
  return enabled ? `${colorCode}${text}${ANSI.reset}` : text;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function truncateLogValue(value: string): string {
  return truncateText(value, MAX_LOG_VALUE_LENGTH);
}

function formatLogValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    const clipped = truncateLogValue(value);
    return clipped.length === 0 || /\s/.test(clipped) ? JSON.stringify(clipped) : clipped;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const primitiveItems = value.every(
      (item) => item === null || ["string", "number", "boolean", "bigint"].includes(typeof item)
    );
    if (primitiveItems && value.length <= 5) {
      return truncateLogValue(`[${value.map(formatLogValue).join(", ")}]`);
    }
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value).length} fields}`;
  }
  return truncateLogValue(String(value));
}

function formatDetailLines(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const fields = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      truncateText(`${key}=${formatLogValue(value)}`, MAX_LOG_LINE_WIDTH - 8)
    );
  if (fields.length === 0) return [];

  const lines: string[] = [];
  let line = "  ·";
  for (const field of fields) {
    const candidate = `${line} ${field}`;
    if (candidate.length > MAX_LOG_LINE_WIDTH && line !== "  ·") {
      lines.push(line);
      line = `    ${field}`;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines;
}

/** Format one log entry for a terminal or plain-text log file. */
export function formatLogEntry(
  entry: LogEntry,
  options: FormatLogEntryOptions = {}
): string {
  const color = options.color ?? false;
  const timestamp = colorize(`[${entry.timestamp}]`, ANSI.dim, color);
  const levelLabel = `[${entry.level.toUpperCase().padEnd(5)}]`;
  const levelColor =
    entry.level === "debug"
      ? ANSI.gray
      : entry.level === "info"
        ? ANSI.green
        : entry.level === "warn"
          ? ANSI.yellow
          : ANSI.red;
  const header = [
    timestamp,
    colorize(levelLabel, levelColor, color),
    colorize(`[${entry.category}]`, ANSI.cyan, color),
  ].join(" ");

  const messageLines = entry.message.split("\n");
  const lines = [`${header} ${messageLines[0] ?? ""}`];
  for (const messageLine of messageLines.slice(1)) {
    lines.push(`  ${messageLine}`);
  }

  const displayData = options.displayData ?? entry.data;
  lines.push(...formatDetailLines(displayData));
  return lines.join("\n");
}

function shouldUseColor(stream: NodeJS.WriteStream): boolean {
  const configured = (process.env.BNB_LOG_COLOR ?? "").trim().toLowerCase();
  if (["always", "true", "1"].includes(configured)) return true;
  if (["never", "false", "0"].includes(configured)) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
  return Boolean(stream.isTTY);
}

function writeLog(
  level: Exclude<LogLevel, "silent">,
  category: string,
  message: string,
  data?: Record<string, unknown>,
  outputOptions: LogOutputOptions = {}
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

  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  const rendered = formatLogEntry(entry, {
    color: shouldUseColor(stream),
    ...(outputOptions.displayData !== undefined
      ? { displayData: outputOptions.displayData }
      : {}),
  });
  if (level === "error") {
    console.error(rendered);
  } else if (level === "warn") {
    console.warn(rendered);
  } else {
    console.log(rendered);
  }
}

export const logger = {
  debug(
    category: string,
    message: string,
    data?: Record<string, unknown>,
    outputOptions?: LogOutputOptions
  ): void {
    writeLog("debug", category, message, data, outputOptions);
  },
  info(
    category: string,
    message: string,
    data?: Record<string, unknown>,
    outputOptions?: LogOutputOptions
  ): void {
    writeLog("info", category, message, data, outputOptions);
  },
  warn(
    category: string,
    message: string,
    data?: Record<string, unknown>,
    outputOptions?: LogOutputOptions
  ): void {
    writeLog("warn", category, message, data, outputOptions);
  },
  error(
    category: string,
    message: string,
    data?: Record<string, unknown>,
    outputOptions?: LogOutputOptions
  ): void {
    writeLog("error", category, message, data, outputOptions);
  },
};
