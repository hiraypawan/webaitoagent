import { chromium, type BrowserContext } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export interface BrowserManagerOptions {
  userDataRoot?: string;
  headless?: boolean;
}

export class PlaywrightBrowserManager {
  private contexts = new Map<string, BrowserContext>();
  private opts: Required<BrowserManagerOptions>;

  constructor(opts: BrowserManagerOptions = {}) {
    this.opts = {
      userDataRoot: opts.userDataRoot ?? path.join(os.homedir(), ".web-agents-to", "profiles"),
      headless: opts.headless ?? true,
    };
  }

  async context(providerId: string): Promise<BrowserContext> {
    const existing = this.contexts.get(providerId);
    if (existing) {
      try {
        const p = await existing.newPage();
        await p.close();
        return existing;
      } catch {
        try { await existing.close(); } catch {}
        this.contexts.delete(providerId);
      }
    }
    const dir = path.join(this.opts.userDataRoot, providerId);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, {
      headless: this.opts.headless,
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    ctx.on("close", () => this.contexts.delete(providerId));
    this.contexts.set(providerId, ctx);
    return ctx;
  }

  async openHeaded(providerId: string): Promise<BrowserContext> {
    // close existing headless context first
    const existing = this.contexts.get(providerId);
    if (existing) {
      await existing.close().catch(() => {});
      this.contexts.delete(providerId);
    }
    const dir = path.join(this.opts.userDataRoot, providerId);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
    });
    this.contexts.set(providerId, ctx);
    return ctx;
  }

  async close(): Promise<void> {
    for (const c of this.contexts.values()) await c.close().catch(() => {});
    this.contexts.clear();
  }
}