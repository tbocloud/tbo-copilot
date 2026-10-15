import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

const SECRET_KEY = /(key|secret|token|authorization|password)/i;
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Replaces the values of secret-looking keys, at any depth. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) && typeof item === "string" ? "[redacted]" : redact(item, depth + 1);
  }
  return out;
}

/** NDJSON lines on stderr, mirrored to `<logsDir>/worker.log`. */
export function createLogger(options: { logsDir?: string; minLevel?: LogLevel; stderr?: boolean } = {}): Logger {
  const min = ORDER[options.minLevel ?? "info"];
  let file: string | undefined;
  if (options.logsDir) {
    mkdirSync(options.logsDir, { recursive: true, mode: 0o700 });
    file = join(options.logsDir, "worker.log");
  }
  return (level, message, data) => {
    if (ORDER[level] < min) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...(data ? { data: redact(data) } : {}) });
    if (options.stderr !== false) process.stderr.write(line + "\n");
    if (file) {
      try {
        appendFileSync(file, line + "\n", { mode: 0o600 });
      } catch {
        // a full disk must not stop the worker
      }
    }
  };
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = () => undefined;
