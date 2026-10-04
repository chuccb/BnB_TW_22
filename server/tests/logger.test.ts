import { describe, expect, test } from "bun:test";
import {
  clearRecentLogs,
  formatLogEntry,
  getLogLevel,
  getRecentLogs,
  logger,
  setLogLevel,
  type LogEntry,
} from "../src/utils/logger.ts";

describe("human-readable server logs", () => {
  test("formats compact key-value details, summarizes nested data, and supports color", () => {
    const entry: LogEntry = {
      timestamp: "2026-10-05T02:03:04.567Z",
      level: "info",
      category: "ShopTrace",
      message: "Observed Shop-flow candidate packet: C->S 37 (RequestShopConnection)",
      data: {
        sessionId: 7,
        connectionKind: "game",
        remoteAddress: "127.0.0.1",
        remotePort: 51003,
        candidateRole: "initial-state candidate",
        serverOpcodes: ["261 (ShopConnectionPermission)", "48 (ShopServerEndpoint)"],
        parserDetails: { payloadBytes: 5, payloadContents: "omitted" },
        longNote: "x".repeat(150),
      },
    };

    const plain = formatLogEntry(entry);
    expect(plain).toContain("[2026-10-05T02:03:04.567Z] [INFO ] [ShopTrace]");
    expect(plain).toContain("sessionId=7");
    expect(plain).toContain("connectionKind=game");
    expect(plain).toContain('candidateRole="initial-state candidate"');
    expect(plain).toContain('serverOpcodes=["261 (ShopConnectionPermission)", "48 (ShopServerEndpoint)"]');
    expect(plain).toContain("parserDetails={2 fields}");
    expect(plain).toContain("…");
    expect(plain).not.toContain('"sessionId":');
    expect(plain).not.toContain("\u001b[");
    expect(
      plain
        .split("\n")
        .filter((line) => line.startsWith("  ·") || line.startsWith("    "))
        .every((line) => line.length <= 132)
    ).toBe(true);

    const colored = formatLogEntry(entry, { color: true });
    expect(colored).toContain("\u001b[32m[INFO ]\u001b[0m");
    expect(colored).toContain("\u001b[36m[ShopTrace]\u001b[0m");
  });

  test("keeps multiline lifecycle timelines aligned and lets console details be narrowed", () => {
    const entry: LogEntry = {
      timestamp: "2026-10-05T02:03:04.567Z",
      level: "info",
      category: "TCP",
      message: "GameServer TCP socket closed\nSession #3 · 127.0.0.1:51003 -> 0.0.0.0:9339\n  #01 +0ms C->S [decoded] 37 (RequestShopConnection) 5B @11 (Lobby)",
      data: {
        sessionId: 3,
        remoteAddress: "127.0.0.1",
        remotePort: 51003,
        internalCounter: 1234,
      },
    };

    const plain = formatLogEntry(entry);
    const lines = plain.split("\n");
    expect(lines[1]).toBe("  Session #3 · 127.0.0.1:51003 -> 0.0.0.0:9339");
    expect(lines[2]).toBe("    #01 +0ms C->S [decoded] 37 (RequestShopConnection) 5B @11 (Lobby)");
    expect(lines.at(-1)).toContain("internalCounter=1234");

    const concise = formatLogEntry(entry, { displayData: { sessionId: 3, remotePort: 51003 } });
    expect(concise).toContain("sessionId=3");
    expect(concise).toContain("remotePort=51003");
    expect(concise).not.toContain("internalCounter");
  });

  test("output-only detail filtering leaves complete structured entries in the recent-log ring", () => {
    const previousLevel = getLogLevel();
    const originalConsoleLog = console.log;
    let output = "";
    setLogLevel("info");
    clearRecentLogs();
    console.log = ((...args: unknown[]) => {
      output = args.map(String).join(" ");
    }) as typeof console.log;

    try {
      logger.info(
        "Login",
        "Authentication succeeded",
        { sessionId: 11, playerCount: 1, username: "private-test-name" },
        { displayData: { sessionId: 11, playerCount: 1 } }
      );

      expect(output).toContain("sessionId=11");
      expect(output).toContain("playerCount=1");
      expect(output).not.toContain("private-test-name");
      expect(getRecentLogs().at(-1)?.data).toEqual({
        sessionId: 11,
        playerCount: 1,
        username: "private-test-name",
      });
    } finally {
      console.log = originalConsoleLog;
      setLogLevel(previousLevel);
    }
  });
});
