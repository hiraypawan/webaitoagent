/**
 * How often the browser bridge had to drop history.
 *
 * opencode decides when to compact from the context size it is told about; the
 * bridge has its own hard character budget. When those disagree the bridge used
 * to elide silently. These counters make it visible (and `/status` reports them).
 */
export interface ContextStats {
  /** Requests served since start. */
  requests: number;
  /** Requests where history had to be dropped. */
  trimmed: number;
  /** Total characters dropped. */
  droppedChars: number;
  /** The current hard budget, in characters. */
  budgetChars: number;
  /** ISO timestamp of the last elision, if any. */
  lastTrimAt: string | null;
}

/**
 * Context window to declare to clients, derived from the bridge's real budget.
 *
 * Compaction must happen *before* the bridge is forced to trim, so the declared
 * window is 90% of what we can physically send (about 4 characters per token).
 */
export function contextTokensFor(maxPromptChars: number): number {
  const chars = Number.isFinite(maxPromptChars) && maxPromptChars > 0 ? maxPromptChars : 120_000;
  return Math.max(2_000, Math.floor((chars * 0.9) / 4));
}

let stats: Omit<ContextStats, "budgetChars"> = {
  requests: 0,
  trimmed: 0,
  droppedChars: 0,
  lastTrimAt: null,
};

export function recordRequest(): void {
  stats.requests++;
}

export function recordTrim(dropped: number): void {
  stats.trimmed++;
  stats.droppedChars += dropped;
  stats.lastTrimAt = new Date().toISOString();
}

export function contextStats(budgetChars: number): ContextStats {
  return { ...stats, budgetChars };
}

/** Test helper. */
export function resetContextStats(): void {
  stats = { requests: 0, trimmed: 0, droppedChars: 0, lastTrimAt: null };
}
