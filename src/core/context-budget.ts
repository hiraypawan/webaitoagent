import fs from "node:fs";
import path from "node:path";

/**
 * Self-tuning prompt budget.
 *
 * The bridge has a hard character budget (how much it will type into the web
 * chat box). If a request exceeds it, history gets trimmed — which previously
 * required the user to edit `MAX_PROMPT_CHARS`, re-run `WEB setup --force`, and
 * hope opencode picked the new number up.
 *
 * Now the server grows the budget itself when trimming happens, remembers the
 * new value across restarts, and rewrites the `limit.context` of every
 * opencode.json it generated. No manual step.
 */

export interface BudgetState {
  /** Characters we are currently willing to send. */
  budgetChars: number;
  /** The value from MAX_PROMPT_CHARS. */
  configuredChars: number;
  /** Never exceed this, even after repeated growth. */
  ceilingChars: number;
  /** How many times the budget has grown automatically. */
  growthSteps: number;
  /** Requests trimmed at the current size, used to stop growing pointlessly. */
  trimsAtSize: number;
  updatedAt: string | null;
}

export interface BudgetOptions {
  configuredChars: number;
  ceilingChars?: number;
  /** Where to persist the learned size. Omit for in-memory (tests). */
  stateFile?: string;
  /** opencode.json files to keep in sync. */
  configPaths?: () => string[];
}

const GROWTH_FACTOR = 1.25;
const MIN_GROWTH = 10_000;

export class ContextBudget {
  private state: BudgetState;
  private readonly stateFile?: string;
  private readonly configPaths: () => string[];
  /** Paths rewritten by the last growth, for logging. */
  lastUpdatedConfigs: string[] = [];
  /**
   * Whether a request has since succeeded without trimming at the current size.
   * A growth is only worth repeating if the previous one actually helped.
   */
  private growthHelped = true;

  constructor(options: BudgetOptions) {
    this.stateFile = options.stateFile;
    this.configPaths = options.configPaths ?? (() => []);
    const ceiling = Math.max(options.configuredChars, options.ceilingChars ?? 400_000);
    this.state = {
      budgetChars: options.configuredChars,
      configuredChars: options.configuredChars,
      ceilingChars: ceiling,
      growthSteps: 0,
      trimsAtSize: 0,
      updatedAt: null,
    };
    this.load();
    // A lowered MAX_PROMPT_CHARS wins over a previously learned value.
    if (this.state.configuredChars !== options.configuredChars) {
      this.state.configuredChars = options.configuredChars;
      this.state.budgetChars = Math.max(this.state.budgetChars, options.configuredChars);
      this.state.ceilingChars = ceiling;
    }
  }

  /** Current effective budget, in characters. */
  chars(): number {
    return this.state.budgetChars;
  }

  status(): BudgetState {
    return { ...this.state };
  }

  /**
   * Called after a prompt was trimmed. Grows the budget when there is room and
   * growth is still helping; returns what changed so the caller can log it.
   */
  onTrim(dropped: number): { grown: boolean; from: number; to: number; updatedConfigs: string[] } {
    this.state.trimsAtSize += 1;
    const from = this.state.budgetChars;

    const worthGrowing =
      this.growthHelped && this.state.budgetChars < this.state.ceilingChars && dropped > 0;

    if (!worthGrowing) {
      this.save();
      return { grown: false, from, to: from, updatedConfigs: [] };
    }

    const target = Math.min(
      this.state.ceilingChars,
      Math.max(this.state.budgetChars + MIN_GROWTH, Math.ceil(this.state.budgetChars * GROWTH_FACTOR))
    );
    if (target <= this.state.budgetChars) {
      this.save();
      return { grown: false, from, to: from, updatedConfigs: [] };
    }

    this.state.budgetChars = target;
    this.state.growthSteps += 1;
    this.state.trimsAtSize = 0;
    this.growthHelped = false;
    this.state.updatedAt = new Date().toISOString();
    const updatedConfigs = this.syncConfigs();
    this.save();
    return { grown: true, from, to: target, updatedConfigs };
  }

  /** A request of the current size succeeded: the budget is proven, so reset. */
  onSuccess(): void {
    const changed = this.state.trimsAtSize !== 0 || !this.growthHelped;
    this.state.trimsAtSize = 0;
    this.growthHelped = true;
    if (changed) this.save();
  }

  /**
   * Rewrite `limit.context` in generated opencode configs so the client learns
   * the new window at its next start without the user running anything.
   */
  private syncConfigs(): string[] {
    const tokens = Math.max(2_000, Math.floor((this.state.budgetChars * 0.9) / 4));
    const updated: string[] = [];

    for (const file of this.configPaths()) {
      try {
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, "utf8");
        const config = JSON.parse(raw) as Record<string, any>;
        const provider = config?.provider?.["web-agents-to"];
        const models = provider?.models;
        if (!models || typeof models !== "object") continue;

        let changed = false;
        for (const model of Object.values<Record<string, any>>(models)) {
          if (!model || typeof model !== "object") continue;
          model.limit = { ...(model.limit ?? {}), context: tokens };
          changed = true;
        }
        if (!changed) continue;
        fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        updated.push(file);
      } catch {
        // A hand-edited or unreadable config is not our business.
      }
    }

    this.lastUpdatedConfigs = updated;
    return updated;
  }

  private load(): void {
    if (!this.stateFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<BudgetState>;
      const learned = Number(raw.budgetChars);
      if (Number.isFinite(learned) && learned > 0) {
        this.state.budgetChars = Math.min(Math.max(learned, this.state.configuredChars), this.state.ceilingChars);
        this.state.growthSteps = Number(raw.growthSteps ?? 0) || 0;
        this.state.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
      }
    } catch {
      // First run: nothing learned yet.
    }
  }

  private save(): void {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Persisting is a convenience; never fail a request over it.
    }
  }
}
