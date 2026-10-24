import type { Browser, BrowserContext, Page } from "playwright";
import type { Provider, ProviderModel, ChatCompletionRequest, ChatChunk } from "../core/types.js";
import { PlaywrightBrowserManager } from "../browser/manager.js";

export interface SiteConfig {
  id: string;
  name: string;
  baseUrl: string;
  chatUrls: string[];
  inputSelectors: string[];
  submitSelectors: string[];
  responseSelectors: string[];
  newChatSelectors?: string[];
  models: ProviderModel[];
  loginHint: string;
  loginUrl?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  loginButtonSelector?: string;
  credentials?: { user?: string; pass?: string };
}

export class BrowserChatProvider implements Provider {
  id: string;
  name: string;
  models: ProviderModel[];
  private cfg: SiteConfig;
  private bm: PlaywrightBrowserManager;
  private page: Page | null = null;
  private lastMessageCount = 0;
  private lastFirstMessage = "";

  constructor(cfg: SiteConfig, bm: PlaywrightBrowserManager) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.name = cfg.name;
    this.models = cfg.models;
    this.bm = bm;
  }

  async init(ctx: BrowserContext): Promise<void> {}

  async login(headed: boolean): Promise<void> {
    const ctx = headed
      ? await this.bm.openHeaded(this.id)
      : await this.bm.context(this.id);
    const page = await ctx.newPage();
    await page.goto(this.cfg.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    console.log(`\n[login] Opened ${this.cfg.baseUrl}. Log in manually, then close the browser window.\n`);
    await new Promise<void>((resolve) => {
      ctx.on("close", () => resolve());
      page.on("close", () => resolve());
    });
    console.log("[login] Profile saved.");
  }

  private async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.bringToFront();
        return this.page;
      } catch {}
    }
    const ctx = await this.bm.context(this.id);
    this.page = await ctx.newPage();
    return this.page;
  }

  private async openChatPage(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await this.bm.context(this.id);
    const page = await this.getPage();
    if (await this.findInput(page)) {
      return { ctx, page };
    }
    for (const url of this.cfg.chatUrls) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      } catch {}
      await page.waitForTimeout(2000);
      for (const txt of ["Accept All", "Accept cookies", "Accept"]) {
        const b = page.locator("button", { hasText: txt }).first();
        if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(500); break; }
      }
      if (await this.findInput(page)) return { ctx, page };
    }
    await page.goto(this.cfg.baseUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (await this.findInput(page)) return { ctx, page };

    if (this.cfg.credentials?.user && this.cfg.credentials?.pass && this.cfg.loginUrl) {
      try {
        await page.goto(this.cfg.loginUrl, { waitUntil: "networkidle", timeout: 45000 });
        await page.waitForTimeout(2000);
        const u = page.locator(this.cfg.usernameSelector ?? "input[name='account']").first();
        const p = page.locator(this.cfg.passwordSelector ?? "input[name='password']").first();
        await u.fill(this.cfg.credentials.user);
        await p.fill(this.cfg.credentials.pass);
        const cb = page.locator("input[type='checkbox']").first();
        if (await cb.isVisible().catch(() => false)) await cb.check().catch(() => {});
        const cookieBtn = page.locator("button:has-text('Accept cookies')").first();
        if (await cookieBtn.isVisible().catch(() => false)) await cookieBtn.click().catch(() => {});
        const btn = page.locator(this.cfg.loginButtonSelector ?? "button:has-text('Sign in')").first();
        await btn.click();
        await page.waitForTimeout(5000);
        const agreeBtn = page.locator("button:has-text('Agree')").first();
        if (await agreeBtn.isVisible().catch(() => false)) {
          await agreeBtn.click().catch(() => {});
          await page.waitForTimeout(5000);
        }
      } catch (e) {
        console.error("auto-login failed", e);
      }
      for (const url of this.cfg.chatUrls) {
        try { await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }); } catch {}
        await page.waitForTimeout(2000);
        if (await this.findInput(page)) return { ctx, page };
      }
    }

    if (!(await this.findInput(page))) {
      throw new Error(
        `LOGIN_REQUIRED: No chat input found for ${this.id}. Run login first. Hint: ${this.cfg.loginHint}`
      );
    }
    return { ctx, page };
  }

  private async findInput(page: Page): Promise<any> {
    for (const sel of this.cfg.inputSelectors) {
      const loc = page.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
    return null;
  }

  private async findSubmit(page: Page): Promise<any> {
    for (const sel of this.cfg.submitSelectors) {
      const loc = page.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
    return null;
  }

  async *chat(req: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk> {
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[chat] retry ${attempt}/${MAX_RETRIES - 1} after server busy...`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
      try {
        const gen = this._chatOnce(req, signal);
        const chunks: ChatChunk[] = [];
        let busy = false;
        for await (const c of gen) {
          chunks.push(c);
          const txt = (c as any)?.choices?.[0]?.delta?.content ?? "";
          if (txt.includes("服务器繁忙")) busy = true;
        }
        if (busy) {
          throw new Error("SERVER_BUSY: MiMo server busy, please try again later");
        }
        for (const c of chunks) yield c;
        return;
      } catch (e: any) {
        lastError = e;
        if (!String(e?.message).includes("SERVER_BUSY") && !String(e?.message).includes("繁忙")) {
          throw e;
        }
      }
    }
    throw lastError ?? new Error("SERVER_BUSY: MiMo server busy after retries");
  }

  private async *_chatOnce(req: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk> {
    const { page } = await this.openChatPage();
    const id = "chatcmpl-" + Math.random().toString(36).slice(2);
    const created = Math.floor(Date.now() / 1000);
    const model = req.model;

    // detect if this is a new conversation
    const firstMsg = req.messages.length > 0 ? String(req.messages[0].content).slice(0, 100) : "";
    const isNewConv = req.messages.length < this.lastMessageCount || firstMsg !== this.lastFirstMessage;

    // start a fresh conversation if needed
    if (isNewConv) {
      for (const sel of this.cfg.newChatSelectors ?? []) {
        const b = page.locator(sel).first();
        if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(2000); break; }
      }
    }

    // Build prompt
    let prompt: string;
    // Include tool definitions if present (for agentic clients like opencode)
    const tools = (req as any).tools;
    const toolDesc = tools ? "\n\nAvailable tools:\n" + JSON.stringify(tools).slice(0, 2000) : "";

    if (isNewConv || req.messages.length <= 1) {
      prompt = req.messages
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : (m.content as any[]).map((c) => c.text ?? "").join("");
          if (m.role === "user") return `User: ${content}`;
          if (m.role === "assistant") return `Assistant: ${content}`;
          if (m.role === "system") return `System: ${content}`;
          if (m.role === "tool") return `Tool result: ${content}`;
          return `${m.role}: ${content}`;
        })
        .join("\n") + toolDesc + "\nAssistant:";
    } else {
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      const content = lastUser ? (typeof lastUser.content === "string" ? lastUser.content : (lastUser.content as any[]).map((c) => c.text ?? "").join("")) : "";
      prompt = content + toolDesc;
    }

    // track conversation state
    this.lastMessageCount = req.messages.length;
    this.lastFirstMessage = firstMsg;

    const input = await this.findInput(page);
    if (!input) {
      throw new Error(`LOGIN_REQUIRED: no input for ${this.id}`);
    }
    await input.click().catch(() => {});
    await input.fill(prompt).catch(async () => {
      await input.type(prompt, { delay: 5 });
    });

    // capture baseline response text
    const baselineCount = await page.locator(this.cfg.responseSelectors[0]).count().catch(() => 0);
    const baseline = await this.readResponseText(page);

    // submit
    const submit = await this.findSubmit(page);
    if (submit) {
      await submit.click().catch(() => {});
    } else {
      await input.press("Enter").catch(() => {});
    }

    // poll until the answer stabilizes, then emit it once
    let lastText = baseline;
    let stableCount = 0;
    const maxWait = 120000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (signal?.aborted) break;
      await page.waitForTimeout(400);
      const current = await this.readResponseText(page);
      const currentCount = await page.locator(this.cfg.responseSelectors[0]).count().catch(() => 0);
      if (current && current !== lastText) {
        lastText = current;
        stableCount = 0;
      } else if (current) {
        stableCount++;
        if (stableCount >= 4 && lastText && lastText !== baseline) break;
        if (stableCount >= 4 && currentCount > baselineCount) break;
      }
    }

    const finalCount = await page.locator(this.cfg.responseSelectors[0]).count().catch(() => 0);
    const finalText = await this.readResponseText(page) || lastText;
    let toEmit = finalText;
    if (finalCount <= baselineCount && baseline && finalText.startsWith(baseline)) {
      toEmit = finalText.slice(baseline.length).trim();
    }
    if (toEmit) {
      yield {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: toEmit }, finish_reason: null }],
      };
    }

    yield {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }

  private async readResponseText(page: Page): Promise<string> {
    for (const sel of this.cfg.responseSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count();
        if (count > 0) {
          for (let i = count - 1; i >= 0; i--) {
            const t = (await loc.nth(i).innerText().catch(() => "")).trim();
            if (t) return t;
          }
        }
      } catch {}
    }
    return "";
  }
}