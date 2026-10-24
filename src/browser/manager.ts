import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { KeyedMutex } from "../core/mutex.js";
import { ProviderError } from "../core/errors.js";
import type { BrowserStatus } from "../core/types.js";
import { log } from "../core/logger.js";

export interface BrowserManagerOptions {
  userDataRoot?: string;
  headless?: boolean;
  userAgent?: string;
  /** Path to a Chromium binary (containers, CI, Lambda-style images). */
  executablePath?: string;
}

/**
 * Owns one persistent Chromium profile per provider.
 *
 * Profiles are created lazily: asking for `/health` must not spin up a browser.
 * Creation is serialised per provider because two launches against the same
 * profile directory would fail (Chromium takes a lock on it).
 */
export class PlaywrightBrowserManager {
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly headed = new Set<string>();
  private readonly launchLocks = new KeyedMutex(4);
  private readonly opts: Required<BrowserManagerOptions>;

  constructor(opts: BrowserManagerOptions = {}) {
    this.opts = {
      userDataRoot:
        opts.userDataRoot && opts.userDataRoot.trim()
          ? opts.userDataRoot
          : path.join(os.homedir(), ".web-agents-to", "profiles"),
      headless: opts.headless ?? true,
      userAgent:
        opts.userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      executablePath: opts.executablePath ?? "",
    };
  }

  profileDir(providerId: string): string {
    return path.join(this.opts.userDataRoot, providerId);
  }

  async context(providerId: string): Promise<BrowserContext> {
    return this.launchLocks.run(providerId, async () => {
      const existing = this.contexts.get(providerId);
      if (existing && (await this.isAlive(existing))) return existing;
      if (existing) {
        log.warn(`[browser] context for ${providerId} died, relaunching`);
        await existing.close().catch(() => {});
        this.contexts.delete(providerId);
        this.headed.delete(providerId);
      }
      return this.launch(providerId, this.opts.headless);
    });
  }

  /** Reuse the active tab when possible so the site keeps its conversation. */
  async page(providerId: string): Promise<Page> {
    const ctx = await this.context(providerId);
    const open = ctx.pages().filter((page) => !page.isClosed());
    const existing = open[open.length - 1];
    if (existing) {
      await existing.bringToFront().catch(() => {});
      return existing;
    }
    return ctx.newPage();
  }

  /** Open a visible browser for manual login; closes the headless one first. */
  async openHeaded(providerId: string): Promise<BrowserContext> {
    return this.launchLocks.run(providerId, async () => {
      const existing = this.contexts.get(providerId);
      if (existing) {
        await existing.close().catch(() => {});
        this.contexts.delete(providerId);
        this.headed.delete(providerId);
      }
      return this.launch(providerId, false);
    });
  }

  isHeaded(providerId: string): boolean {
    return this.headed.has(providerId);
  }

  /** Non-launching status snapshot, safe to call from HTTP handlers. */
  status(providerId: string): BrowserStatus {
    const ctx = this.contexts.get(providerId);
    return {
      launched: Boolean(ctx),
      headed: this.headed.has(providerId),
      pages: ctx ? ctx.pages().filter((page) => !page.isClosed()).length : 0,
    };
  }

  async closeProvider(providerId: string): Promise<void> {
    const ctx = this.contexts.get(providerId);
    this.contexts.delete(providerId);
    this.headed.delete(providerId);
    if (ctx) await ctx.close().catch(() => {});
  }

  async close(): Promise<void> {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    this.headed.clear();
    for (const ctx of contexts) await ctx.close().catch(() => {});
  }

  private async launch(providerId: string, headless: boolean): Promise<BrowserContext> {
    const dir = this.profileDir(providerId);
    fs.mkdirSync(dir, { recursive: true });

    try {
      const ctx = await chromium.launchPersistentContext(dir, {
        headless,
        viewport: headless ? { width: 1366, height: 900 } : { width: 1280, height: 800 },
        userAgent: this.opts.userAgent,
        ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {}),
        locale: "en-US",
        args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
      });
      ctx.on("close", () => {
        this.contexts.delete(providerId);
        this.headed.delete(providerId);
      });
      this.contexts.set(providerId, ctx);
      if (headless) this.headed.delete(providerId);
      else this.headed.add(providerId);
      log.debug(`[browser] launched ${providerId} (headless=${headless})`);
      return ctx;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingBrowser = /Executable doesn't exist|playwright install/i.test(message);
      throw new ProviderError(
        `failed to launch Chromium for "${providerId}": ${message}`,
        503,
        missingBrowser
          ? "Install the browser once with: npx playwright install chromium"
          : "Another process may already be using this profile directory."
      );
    }
  }

  private async isAlive(ctx: BrowserContext): Promise<boolean> {
    try {
      const browser = ctx.browser();
      if (browser && !browser.isConnected()) return false;
      await ctx.pages();
      return true;
    } catch {
      return false;
    }
  }
}
