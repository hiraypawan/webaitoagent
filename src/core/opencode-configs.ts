import fs from "node:fs";
import path from "node:path";

/**
 * The opencode.json files this tool wrote, so the server can keep their
 * declared context window in sync with the budget it learns at runtime.
 *
 * Only paths we generated are ever touched — a hand-written config is left alone.
 */

const FILE = "opencode-configs.json";

export function registerOpencodeConfig(file: string, dataRoot: string): void {
  const target = path.resolve(file);
  const known = knownOpencodeConfigs(dataRoot);
  if (known.includes(target)) return;
  known.push(target);
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, FILE), `${JSON.stringify(known, null, 2)}\n`, "utf8");
  } catch {
    // Non-fatal: the config simply will not be auto-updated.
  }
}

export function knownOpencodeConfigs(dataRoot: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, FILE), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}
