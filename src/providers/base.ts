import type { Locator, Page } from "playwright";
import type {
  ChatChunk,
  ChatCompletionRequest,
  Provider,
  ProviderModel,
  ProviderStatus,
  SessionStatus,
} from "../core/types.js";
import type { PlaywrightBrowserManager } from "../browser/manager.js";
import { config } from "../config/index.js";
import { log } from "../core/logger.js";
import { KeyedMutex } from "../core/mutex.js";
import {
  LoginRequiredError,
  ProviderError,
  RequestAbortedError,
  ServerBusyError,
} from "../core/errors.js";
import {
  buildContinuationPrompt,
  buildPrompt,
  conversationKey,
} from "../core/prompt.js";
import { contextBudget } from "../core/budget.js";
import { looksBusy } from "../core/page-signals.js";
import { cleanAnswer, DEFAULT_REASONING_SELECTORS, parseSelectors } from "../core/thinking.js";
import { recordRequest, recordTrim } from "../core/context-stats.js";
import { DeltaTracker, stripBaseline } from "../core/stream.js";
import { newId, nowSeconds, sleep } from "../core/utils.js";
import {
  classifyLoginPage,
  DEFAULT_OTP_SELECTORS,
  LoginAttemptGuard,
  loginHint,
  summariseCookies,
  type LoginState,
} from "./login-flow.js";

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
  /** Inputs that mean "a one-time code is being requested". */
  otpSelectors?: string;
  /** Substrings that mean "the site is rate limiting us" (safe to retry). */
  busyPatterns?: string[];
  /** Containers holding the model's reasoning, removed before reading text. */
  reasoningSelectors?: string[];
  credentials?: { user?: string; pass?: string };
}

export interface BrowserChatProviderOptions {
  requestTimeoutMs?: number;
  streamPollMs?: number;
  streamIdlePolls?: number;
  streamMaxWaitMs?: number;
  streamStartTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  maxPromptChars?: number;
  maxQueue?: number;
}

const DEFAULT_BUSY_PATTERNS = [
  "服务器繁忙",
  "服务繁忙",
  "server is busy",
  "system is busy",
  "too many requests",
  "please try again later",
];

/**
 * Drives a provider's web chat UI through Playwright and exposes it as an
 * OpenAI-style streaming provider.
 *
 * Answers are scraped from the DOM. They are emitted as *incremental* deltas as
 * the text grows, rather than one blob at the end, so `stream: true` behaves
 * like a real completion stream.
 */
export class BrowserChatProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly models: ProviderModel[];

  private readonly cfg: SiteConfig;
  private readonly bm: PlaywrightBrowserManager;
  private readonly opts: Required<BrowserChatProviderOptions>;
  private readonly mutex: KeyedMutex;

  private page: Page | null = null;
  private lastConversationKey = "";
  private lastMessageCount = 0;
  private readonly busyPatterns: string[];
  private loginGuard: LoginAttemptGuard | null = null;
  private lastLoginState: LoginState = "unknown";

  constructor(cfg: SiteConfig, bm: PlaywrightBrowserManager, opts: BrowserChatProviderOptions = {}) {
    this.cfg = cfg;
    this.bm = bm;
    this.id = cfg.id;
    this.name = cfg.name;
    this.models = cfg.models;
    this.busyPatterns = cfg.busyPatterns?.length ? cfg.busyPatterns : DEFAULT_BUSY_PATTERNS;
    this.opts = {
      requestTimeoutMs: opts.requestTimeoutMs ?? config.requestTimeoutMs,
      streamPollMs: opts.streamPollMs ?? config.streamPollMs,
      streamIdlePolls: opts.streamIdlePolls ?? config.streamIdlePolls,
      streamMaxWaitMs: opts.streamMaxWaitMs ?? config.streamMaxWaitMs,
      streamStartTimeoutMs: opts.streamStartTimeoutMs ?? config.streamStartTimeoutMs,
      retries: Math.max(1, opts.retries ?? config.providerRetries),
      retryDelayMs: opts.retryDelayMs ?? config.providerRetryDelayMs,
      maxPromptChars: opts.maxPromptChars ?? config.maxPromptChars,
      maxQueue: opts.maxQueue ?? config.maxQueue,
    };
    this.mutex = new KeyedMutex(this.opts.maxQueue);
  }

  /** Nothing to do: the browser starts on first use, not at boot. */
  async init(): Promise<void> {}

  status(): ProviderStatus {
    return {
      id: this.id,
      name: this.name,
      models: this.models,
      browser: this.bm.status(this.id),
      queue: this.mutex.stats(this.id),
    };
  }

  /** Cheap, non-launching report: cookies + why the last auto-login stopped. */
  async session(): Promise<SessionStatus> {
    const cookies = await this.bm.cookies(this.id);
    const launched = this.bm.status(this.id).launched;
    const record = this.guard().record(this.id);

    return {
      checked: launched && cookies.length > 0,
      ...(launched && cookies.length > 0
        ? { cookies: summariseCookies(cookies, ["pass", "token", "session", "service", "ticket", "userId"]) }
        : {}),
      loginState: this.lastLoginState,
      lastAutoLogin:
        record?.lastFailureAt && record.lastFailureReason
          ? { at: new Date(record.lastFailureAt).toISOString(), reason: record.lastFailureReason }
          : null,
    };
  }

  /**
   * Actively load the chat page to prove the session works. Opt-in because it
   * starts a browser and may show an OTP prompt.
   */
  async probeSession(): Promise<SessionStatus> {
    const page = await this.getPage();
    await this.goto(page, this.cfg.chatUrls[0] ?? this.cfg.baseUrl);
    const state = await this.detectLoginState(page);
    this.lastLoginState = state;

    const cookies = await this.bm.cookies(this.id);
    const record = this.guard().record(this.id);

    return {
      checked: true,
      signedIn: state === "signed_in",
      needsLogin: state !== "signed_in",
      loginState: state,
      url: page.url(),
      cookies: summariseCookies(cookies, ["pass", "token", "session", "service", "ticket", "userId"]),
      lastAutoLogin:
        record?.lastFailureAt && record.lastFailureReason
          ? { at: new Date(record.lastFailureAt).toISOString(), reason: record.lastFailureReason }
          : null,
    };
  }

  async close(): Promise<void> {
    this.page = null;
    await this.bm.closeProvider(this.id);
  }

  private guard(): LoginAttemptGuard {
    if (!this.loginGuard) {
      this.loginGuard = new LoginAttemptGuard(this.bm.dataRoot(), {
        cooldownMs: config.loginCooldownMs,
      });
    }
    return this.loginGuard;
  }

  /** Read the page and decide which stage of the login flow it is at. */
  private async detectLoginState(page: Page): Promise<LoginState> {
    const hasChatInput = Boolean(await this.findInput(page));
    const hasPasswordField = await page
      .locator(this.cfg.passwordSelector ?? "input[type='password']")
      .first()
      .isVisible()
      .catch(() => false);
    const hasOtpField = await page
      .locator(this.cfg.otpSelectors ?? DEFAULT_OTP_SELECTORS)
      .first()
      .isVisible()
      .catch(() => false);
    const text = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "")
      .then((value) => value.slice(0, 4_000));

    return classifyLoginPage({
      url: page.url(),
      hasChatInput,
      hasPasswordField,
      hasOtpField,
      text,
    });
  }

  async login(headed = true): Promise<void> {
    const ctx = headed ? await this.bm.openHeaded(this.id) : await this.bm.context(this.id);
    const page = ctx.pages().find((candidate) => !candidate.isClosed()) ?? (await ctx.newPage());
    await page.goto(this.cfg.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

    if (!headed) {
      log.warn("[login] HEADLESS=true: a visible window is required to sign in.");
      return;
    }

    log.info(
      [
        "",
        `[login] A browser window is open at ${this.cfg.baseUrl}.`,
        "[login] Sign in with your email + password, then enter the one-time code.",
        "[login] The window closes by itself once the chat box is available.",
        "",
      ].join("\n")
    );

    const deadline = Date.now() + config.loginTimeoutMs;
    let state: LoginState = "unknown";

    while (Date.now() < deadline) {
      if (ctx.pages().length === 0 || page.isClosed()) {
        log.warn("[login] window closed before sign-in completed");
        break;
      }
      state = await this.detectLoginState(page);
      this.lastLoginState = state;
      if (state === "signed_in") break;
      if (state === "verification_required") {
        log.info("[login] waiting for the one-time code to be entered...");
      }
      await page.waitForTimeout(2_000);
    }

    if (state === "signed_in") {
      this.guard().recordSuccess(this.id);
      this.lastLoginState = "signed_in";
      // Give the browser a moment to flush cookies to the profile on disk.
      await page.waitForTimeout(1_500);
      this.page = null;
      this.lastConversationKey = "";
      log.info("[login] signed in; the session is saved and will be reused.");
      // Release the profile so the server can relaunch it headless.
      await this.bm.closeProvider(this.id);
      return;
    }

    this.guard().recordFailure(this.id, state);
    this.page = null;
    throw new LoginRequiredError(`sign-in did not complete (${state})`, loginHint(state, this.cfg.loginHint));
  }

  async *chat(req: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new ProviderError(`${this.id} took longer than ${this.opts.requestTimeoutMs}ms`, 504));
    }, this.opts.requestTimeoutMs);
    timer.unref?.();

    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

    try {
      let emitted = false;
      for (let attempt = 1; attempt <= this.opts.retries; attempt++) {
        const release = await this.mutex.acquire(this.id, combined);
        try {
          for await (const chunk of this.streamOnce(req, combined)) {
            // Only real content counts as delivered: an unfinished stream can
            // still be retried safely.
            if (chunk.choices[0]?.delta?.content) emitted = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (combined.aborted) throw this.abortError(combined, signal, timeout.signal);
          // A partially delivered answer cannot be retried without duplication.
          if (emitted) {
            log.error(`[${this.id}] stream failed after partial output: ${describe(error)}`);
            return;
          }
          if (attempt >= this.opts.retries || !this.isRetryable(error)) throw error;

          const delay = this.opts.retryDelayMs * attempt + Math.floor(Math.random() * 250);
          log.warn(
            `[${this.id}] attempt ${attempt}/${this.opts.retries} failed (${describe(error)}); retrying in ${delay}ms`
          );
          // Do not hold the provider lock while backing off.
          release();
          await sleep(delay, combined);
          this.lastConversationKey = "";
          this.page = null;
        } finally {
          release();
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async *streamOnce(
    req: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatChunk> {
    const page = await this.openChatPage(signal);
    const id = newId("chatcmpl");
    const created = nowSeconds();
    const model = req.model;

    const key = conversationKey(req.messages);
    const isNewConversation = key !== this.lastConversationKey || req.messages.length < this.lastMessageCount;
    if (isNewConversation) await this.startNewChat(page);

    recordRequest();
    const budget = contextBudget(this.bm.dataRoot());
    const promptOptions = {
      tools: req.tools,
      toolChoice: req.tool_choice,
      jsonMode: req.response_format?.type === "json_object",
      maxChars: budget.chars(),
      onTrim: (info: { dropped: number; max: number }) => {
        recordTrim(info.dropped);
        const growth = budget.onTrim(info.dropped);
        if (growth.grown) {
          log.warn(
            `[${this.id}] history trimmed: dropped ${info.dropped} characters. ` +
              `Raised the browser budget from ${growth.from} to ${growth.to} characters automatically.`
          );
          for (const file of growth.updatedConfigs) {
            log.warn(
              `[${this.id}] updated ${file} (limit.context) — restart opencode to pick up the larger window`
            );
          }
        } else {
          log.warn(
            `[${this.id}] history trimmed: dropped ${info.dropped} characters ` +
              `to fit the ${info.max}-character browser budget (automatic growth paused; ` +
              `raise MAX_PROMPT_CHARS if answers keep losing context)`
          );
        }
      },
    };
    const prompt = isNewConversation
      ? buildPrompt(req.messages, promptOptions)
      : buildContinuationPrompt(req.messages, promptOptions);

    if (!prompt.trim()) throw new ProviderError("the request produced an empty prompt", 400);

    const input = await this.findInput(page);
    if (!input) throw new LoginRequiredError(`no chat input found for ${this.id}`, this.cfg.loginHint);

    await this.typeInto(page, input, prompt, signal);

    const baseline = await this.readResponseText(page);
    const baselineCount = await this.countResponses(page);

    await this.submit(page, input);
    signal?.throwIfAborted();

    this.lastConversationKey = key;
    this.lastMessageCount = req.messages.length;

    const tracker = new DeltaTracker();
    let firstChunk = true;
    const startedAt = Date.now();
    let lastCandidate = "";
    let stablePolls = 0;
    let newBubble = false;

    while (true) {
      if (signal?.aborted) break;

      if (Date.now() - startedAt > this.opts.streamMaxWaitMs) {
        if (!tracker.hasEmitted) {
          throw new ProviderError(`${this.id} did not answer within ${this.opts.streamMaxWaitMs}ms`, 504);
        }
        break;
      }

      await sleep(this.opts.streamPollMs, signal);

      const count = await this.countResponses(page);
      if (count > baselineCount) newBubble = true;
      const raw = await this.readResponseText(page);
      const candidate = newBubble ? raw : stripBaseline(raw, baseline);

      // Rate-limit / busy messages must retry instead of being shown as answers.
      if (!tracker.hasEmitted && this.isBusy(candidate)) {
        throw new ServerBusyError(`${this.id} reported: ${candidate.slice(0, 120)}`);
      }

      // Nothing in the answer box yet: the page title often carries the banner
      // ("server busy, try again later"), which is far better than waiting out
      // the full timeout.
      if (!tracker.hasEmitted && !candidate.trim()) {
        const title = await page.title().catch(() => "");
        if (this.isBusy(title)) {
          throw new ServerBusyError(`${this.id} page reports: ${title.trim().slice(0, 120)}`);
        }
      }

      if (candidate === lastCandidate) {
        stablePolls++;
      } else {
        stablePolls = 0;
        lastCandidate = candidate;
      }

      const delta = tracker.push(candidate);
      if (delta) {
        // Attach the role to the first content delta so nothing is sent before
        // the answer actually starts (retries must not duplicate frames).
        yield this.makeChunk(
          id,
          created,
          model,
          firstChunk ? { role: "assistant", content: delta } : { content: delta }
        );
        firstChunk = false;
      }

      if (tracker.hasEmitted && stablePolls >= this.opts.streamIdlePolls) break;

      const idleWithoutAnswer = Date.now() - startedAt > this.opts.streamStartTimeoutMs;
      if (!tracker.hasEmitted && stablePolls >= this.opts.streamIdlePolls && idleWithoutAnswer) {
        throw new ProviderError(
          `${this.id} accepted the prompt but produced no answer`,
          504,
          "The site may have changed. Update the selectors via SITE_OVERRIDES or log in again."
        );
      }
    }

    const finalRaw = await this.readResponseText(page).catch(() => "");
    const finalCandidate = newBubble ? finalRaw : stripBaseline(finalRaw, baseline);
    const tail = tracker.flush(finalCandidate);
    if (tail) {
      yield this.makeChunk(
        id,
        created,
        model,
        firstChunk ? { role: "assistant", content: tail } : { content: tail }
      );
      firstChunk = false;
    }

    if (tracker.hasDiverged) {
      log.warn(`[${this.id}] answer was re-rendered mid-stream; output may be incomplete`);
    }

    // The request completed at the current budget: growth is allowed again.
    budget.onSuccess();

    yield this.makeChunk(id, created, model, {}, "stop");
  }

  private makeChunk(
    id: string,
    created: number,
    model: string,
    delta: { role?: "assistant"; content?: string },
    finish: ChatChunk["choices"][number]["finish_reason"] = null
  ): ChatChunk {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
  }

  private async openChatPage(signal?: AbortSignal): Promise<Page> {
    const page = await this.getPage();
    if (await this.findInput(page)) return page;

    // Visit each candidate once. Bail out as soon as the page is obviously a
    // login/verification screen: reloading it cannot produce a chat box, and a
    // signed-out request should fail fast instead of eating the timeout.
    const urls = [...new Set([...this.cfg.chatUrls, this.cfg.baseUrl].filter(Boolean))];
    let state: LoginState = "unknown";

    for (const url of urls) {
      signal?.throwIfAborted();
      await this.goto(page, url);
      if (await this.findInput(page)) return page;

      state = await this.detectLoginState(page);
      this.lastLoginState = state;
      if (state === "verification_required" || state === "blocked" || state === "credentials_form") {
        break;
      }
    }

    // A one-time-code or lockout screen cannot be passed by automation.
    if (state === "verification_required" || state === "blocked") {
      throw new LoginRequiredError(
        `not signed in to ${this.id} (${state} at ${page.url()})`,
        loginHint(state, this.cfg.loginHint)
      );
    }

    const canAutoLogin = Boolean(
      this.cfg.credentials?.user && this.cfg.credentials?.pass && this.cfg.loginUrl
    );
    if (state !== "signed_in" && canAutoLogin) {
      const after = await this.autoLogin(page);
      if (after === "verification_required" || after === "blocked") {
        throw new LoginRequiredError(
          `not signed in to ${this.id} (${after} at ${page.url()})`,
          loginHint(after, this.cfg.loginHint)
        );
      }
      if (after === "signed_in") {
        for (const url of urls) {
          await this.goto(page, url);
          if (await this.findInput(page)) return page;
        }
      }
    }

    const finalState = await this.detectLoginState(page);
    this.lastLoginState = finalState;
    if (finalState !== "signed_in") {
      throw new LoginRequiredError(
        `not signed in to ${this.id} (${finalState} at ${page.url()})`,
        loginHint(finalState, this.cfg.loginHint)
      );
    }
    return page;
  }

  private async goto(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await this.waitForInput(page);
    await this.dismissCookieBanner(page);
  }

  private async waitForInput(page: Page, timeoutMs = 6_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.findInput(page)) return true;
      await page.waitForTimeout(400);
    } while (Date.now() < deadline);
    return false;
  }

  private async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await this.bm.page(this.id);
    return this.page;
  }

  /**
   * Optional email+password pre-fill. It can never finish a login on its own:
   * the provider asks for a one-time code afterwards, which needs a human.
   *
   * The guard is the important part — repeated failed password submissions are
   * what trigger lockouts and captchas, so this runs at most once per cooldown
   * and gives up immediately when it detects the verification screen.
   */
  private async autoLogin(page: Page): Promise<LoginState> {
    const user = this.cfg.credentials?.user;
    const pass = this.cfg.credentials?.pass;
    if (!user || !pass || !this.cfg.loginUrl) return "unknown";

    const guard = this.guard();
    const permission = guard.canAttempt(this.id);
    if (!permission.allowed) {
      const minutes = Math.ceil((permission.retryInMs ?? 0) / 60_000);
      log.warn(
        `[${this.id}] skipping automatic login (${permission.reason}); next attempt allowed in ~${minutes} min`
      );
      return this.lastLoginState;
    }

    log.info(`[${this.id}] attempting password pre-fill for ${redact(user)}`);
    guard.recordAttempt(this.id);

    try {
      await page.goto(this.cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2_000);

      const userInput = page.locator(this.cfg.usernameSelector ?? "input[name='account']").first();
      const passInput = page.locator(this.cfg.passwordSelector ?? "input[name='password']").first();
      await userInput.fill(user, { timeout: 15_000 });
      await passInput.fill(pass, { timeout: 15_000 });

      const consent = page.locator("input[type='checkbox']").first();
      if (await consent.isVisible().catch(() => false)) await consent.check().catch(() => {});

      const cookieButton = page.locator("button:has-text('Accept cookies')").first();
      if (await cookieButton.isVisible().catch(() => false)) await cookieButton.click().catch(() => {});

      const button = page.locator(this.cfg.loginButtonSelector ?? "button:has-text('Sign in')").first();
      await button.click({ timeout: 15_000 });
      await page.waitForTimeout(4_000);

      const agree = page.locator("button:has-text('Agree')").first();
      if (await agree.isVisible().catch(() => false)) {
        await agree.click().catch(() => {});
        await page.waitForTimeout(3_000);
      }

      const state = await this.detectLoginState(page);
      this.lastLoginState = state;

      if (state === "signed_in") {
        guard.recordSuccess(this.id);
        log.info(`[${this.id}] automatic login succeeded`);
        return state;
      }

      guard.recordFailure(this.id, state);
      if (state === "verification_required") {
        log.warn(
          `[${this.id}] a one-time code is required; finish the login once with \`WEB login\`. ` +
            "Automatic login is paused to avoid lockouts."
        );
      } else {
        log.warn(`[${this.id}] automatic login stopped at state "${state}"`);
      }
      return state;
    } catch (error) {
      guard.recordFailure(this.id, "error");
      log.warn(`[${this.id}] automatic login failed: ${describe(error)}`);
      return this.lastLoginState;
    }
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    for (const label of ["Accept All", "Accept cookies", "Accept", "Agree"]) {
      const button = page.locator("button", { hasText: label }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
        await page.waitForTimeout(400);
        return;
      }
    }
  }

  private async startNewChat(page: Page): Promise<void> {
    this.lastConversationKey = "";
    this.lastMessageCount = 0;
    for (const selector of this.cfg.newChatSelectors ?? []) {
      const button = page.locator(selector).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
        await page.waitForTimeout(1_000);
        return;
      }
    }
    log.debug(`[${this.id}] no new-conversation button matched; continuing current chat`);
  }

  private async findInput(page: Page): Promise<Locator | null> {
    for (const selector of this.cfg.inputSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const element = locator.nth(i);
        if (await element.isVisible().catch(() => false)) return element;
      }
    }
    return null;
  }

  private async findSubmit(page: Page): Promise<Locator | null> {
    for (const selector of this.cfg.submitSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const element = locator.nth(i);
        if ((await element.isVisible().catch(() => false)) && (await element.isEnabled().catch(() => false))) {
          return element;
        }
      }
    }
    return null;
  }

  private async typeInto(
    page: Page,
    input: Locator,
    prompt: string,
    signal?: AbortSignal
  ): Promise<void> {
    await input.click({ timeout: 15_000 }).catch(() => {});
    signal?.throwIfAborted();

    try {
      await input.fill(prompt, { timeout: 30_000 });
    } catch {
      // Rich-text editors reject fill(); focus and insert the text instead.
      await input.click({ timeout: 15_000 }).catch(() => {});
      await page.keyboard.insertText(prompt);
    }

    const typed = await input.inputValue().catch(() => prompt);
    if (typed.trim().length === 0) {
      throw new ProviderError(
        `could not type into the ${this.id} chat box`,
        502,
        "The input selector probably changed. Patch it with SITE_OVERRIDES."
      );
    }
    await page.waitForTimeout(300);
  }

  private async submit(page: Page, input: Locator): Promise<void> {
    const button = await this.findSubmit(page);
    if (button) {
      await button.click({ timeout: 15_000 });
      return;
    }

    await input.press("Enter");
    await page.waitForTimeout(500);

    // Only click a send button if Enter did NOT send: the input still holds
    // the text. Clicking unconditionally would post a second, empty message.
    const stillFilled = (await input.inputValue().catch(() => "")).trim().length > 0;
    if (!stillFilled) return;

    const fallback = await this.findSubmit(page);
    if (fallback) {
      await fallback.click({ timeout: 5_000 }).catch(() => {});
      return;
    }
    if (await this.findInput(page)) {
      await input.press("Enter").catch(() => {});
    }
  }

  private async countResponses(page: Page): Promise<number> {
    let total = 0;
    for (const selector of this.cfg.responseSelectors) {
      total += await page.locator(selector).count().catch(() => 0);
    }
    return total;
  }

  private reasoningSelectors(): string[] {
    return (
      parseSelectors(config.reasoningSelectors) ??
      this.cfg.reasoningSelectors ??
      DEFAULT_REASONING_SELECTORS
    );
  }

  /**
   * Read the newest answer, with the model's reasoning removed.
   *
   * The DOM pass is the reliable one: MiMo (like most Chinese web UIs) renders
   * the chain of thought in its own element inside the same prose container.
   */
  private async readResponseText(page: Page): Promise<string> {
    const selectors = this.reasoningSelectors();

    for (const selector of this.cfg.responseSelectors) {
      try {
        const locator = page.locator(selector);
        const count = await locator.count();
        for (let i = count - 1; i >= 0; i--) {
          const withoutReasoning = await locator
            .nth(i)
            .evaluate((node: Element, drop: string[]) => {
              const clone = node.cloneNode(true) as HTMLElement;
              for (const dropSelector of drop) {
                try {
                  for (const found of Array.from(clone.querySelectorAll(dropSelector))) {
                    found.remove();
                  }
                } catch {
                  // an unsupported selector must not break reading
                }
              }
              const html = clone as HTMLElement;
              return (html.innerText ?? html.textContent ?? "").trimEnd();
            }, selectors)
            .catch(() => undefined);

          const text = (withoutReasoning ?? (await locator.nth(i).innerText().catch(() => ""))).trimEnd();
          const cleaned = cleanAnswer(text);
          if (cleaned.trim()) return cleaned;
        }
      } catch {
        // selector not present on this page state
      }
    }
    return "";
  }

  private isBusy(text: string): boolean {
    return looksBusy(text, this.busyPatterns);
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof ServerBusyError) return true;
    if (error instanceof ProviderError) return error.statusCode >= 500;
    const message = describe(error);
    return /net::|ECONNRESET|ECONNREFUSED|socket hang up|Target (page|closed)|browser has been closed|Timeout/i.test(
      message
    );
  }

  private abortError(
    combined: AbortSignal,
    caller?: AbortSignal,
    timeout?: AbortSignal
  ): Error {
    if (timeout?.aborted && timeout.reason instanceof Error) return timeout.reason;
    if (caller?.aborted) {
      const reason = caller.reason;
      return reason instanceof Error ? reason : new RequestAbortedError();
    }
    const reason = combined.reason;
    return reason instanceof Error ? reason : new RequestAbortedError();
  }
}

/** Keep logs useful without printing a full email address. */
function redact(value: string): string {
  const [local, domain] = value.split("@");
  if (!domain) return "***";
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
