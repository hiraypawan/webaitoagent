import { config } from "../config/index.js";

type Level = "error" | "warn" | "info" | "debug";

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function threshold(): number {
  const level = config.logLevel.toLowerCase() as Level;
  return ORDER[level] ?? ORDER.info;
}

function emit(level: Level, args: unknown[]): void {
  if (ORDER[level] > threshold()) return;
  const prefix = level === "info" ? "" : `${level.toUpperCase()} `;
  if (level === "error") console.error(prefix, ...args);
  else if (level === "warn") console.warn(prefix, ...args);
  else if (level === "debug") console.debug(prefix, ...args);
  else console.log(...args);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
