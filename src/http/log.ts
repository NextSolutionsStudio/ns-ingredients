// JSON-lines logger. Request logs carry route templates and key prefixes — never bodies, query
// strings or profiles (a profile can be health data under GDPR art. 9).
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
}

export function jsonLogger(
  min: Level = "info",
  sink: (line: string) => void = (l) => console.log(l),
): Logger {
  return {
    log(level, msg, fields = {}) {
      if (ORDER[level] < ORDER[min]) return;
      sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
    },
  };
}

/** Collects lines in memory — tests assert on what would have been logged. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, ...jsonLogger("debug", (l) => lines.push(l)) };
}
