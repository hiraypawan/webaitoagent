import path from "node:path";
import { config } from "../config/index.js";
import { ContextBudget } from "./context-budget.js";
import { knownOpencodeConfigs } from "./opencode-configs.js";

/**
 * One budget instance per process, backed by the user-data directory so the
 * size it learns survives restarts.
 */
let shared: ContextBudget | undefined;

export function contextBudget(dataRoot: string): ContextBudget {
  if (!shared) {
    shared = new ContextBudget({
      configuredChars: config.maxPromptChars,
      ceilingChars: config.maxPromptCharsCeiling,
      stateFile: path.join(dataRoot, "context-budget.json"),
      configPaths: () => knownOpencodeConfigs(dataRoot),
    });
  }
  return shared;
}

export function resetContextBudget(): void {
  shared = undefined;
}
