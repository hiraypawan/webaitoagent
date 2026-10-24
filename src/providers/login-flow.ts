import fs from "node:fs";
import path from "node:path";
import { log } from "../core/logger.js";

/**
 * Login classification.
 *
 * MiMo accounts sign in with email + password **then a one-time code**. That
 * means a saved password can never complete a login on its own: the flow always
 * parks on a verification screen that a human has to finish. Everything here is
 * about detecting that precisely instead of guessing, and about not hammering
 * the provider with repeated password attempts (which is how accounts get
 * locked or captcha-gated).
 */

export type LoginState =
  | "signed_in"
  | "credentials_form"
  | "verification_required"
  | "blocked"
  | "unknown";

export interface LoginSignals {
  url?: string;
  hasChatInput: boolean;
  hasPasswordField: boolean;
  hasOtpField: boolean;
  /** Visible page text, truncated by the caller. */
  text: string;
}

const OTP_TEXT_PATTERNS = [
  /verification code/i,
  /verify your (email|identity|account)/i,
  /one[- ]time (code|password)/i,
  /enter the code/i,
  /code (was|has been) sent/i,
  /we sent a code/i,
  /two[- ]factor/i,
  /2fa/i,
  /authenticator/i,
  /验证码/,
  /短信验证/,
  /邮箱验证/,
];

const BLOCKED_TEXT_PATTERNS = [
  /too many (failed )?attempts/i,
  /account\b[^.]{0,30}\b(locked|suspended|disabled)/i,
  /try again (later|in \d+ (minutes|hours))/i,
  /captcha/i,
  /unusual activity/i,
  /suspicious (activity|login)/i,
  /账号.*(锁定|冻结)/,
  /操作频繁/,
];

const CREDENTIALS_TEXT_PATTERNS = [
  /sign in with (google|apple|email)/i,
  /forgot password/i,
  /remember me/i,
  /登录/,
];

export function classifyLoginPage(signals: LoginSignals): LoginState {
  if (signals.hasChatInput) return "signed_in";

  const text = signals.text ?? "";

  // Verification is checked before the password form: some flows keep the
  // password field mounted behind the OTP dialog.
  if (signals.hasOtpField || OTP_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "verification_required";
  }

  if (BLOCKED_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return "blocked";

  if (signals.hasPasswordField || CREDENTIALS_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "credentials_form";
  }

  return "unknown";
}

export const DEFAULT_OTP_SELECTORS = [
  "input[autocomplete='one-time-code']",
  "input[name*='code' i]",
  "input[id*='code' i]",
  "input[placeholder*='code' i]",
  "input[placeholder*='验证码']",
].join(",");

export function loginHint(state: LoginState, baseHint: string): string {
  switch (state) {
    case "verification_required":
      return (
        "The provider is asking for a one-time code. A saved password cannot finish this login. " +
        "Run `WEB login`, complete the code in the visible window, then retry. " +
        baseHint
      );
    case "credentials_form":
      return (
        "The saved browser profile is signed out. Run `WEB login` and sign in (email + password + one-time code). " +
        baseHint
      );
    case "blocked":
      return (
        "The provider is rate-limiting or challenging this login. Wait, then finish a login manually " +
        "with `WEB login` from the same machine/IP. " +
        baseHint
      );
    default:
      return `The provider session is not usable. Run \`WEB login\`. ${baseHint}`;
  }
}

export interface AttemptRecord {
  lastAttemptAt: number;
  lastFailureAt?: number;
  lastFailureReason?: string;
  successes: number;
}

/**
 * Guards credential submission.
 *
 * Rules: never attempt in the same process twice, and respect a cooldown across
 * restarts (persisted next to the profile). Repeated failed password logins are
 * exactly what triggers lockouts and captchas, so failing closed is correct.
 */
export class LoginAttemptGuard {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly file: string;
  private readonly cooldownMs: number;

  constructor(
    profileRoot: string,
    options: { cooldownMs?: number; now?: () => number } = {}
  ) {
    this.file = path.join(profileRoot, "login-state.json");
    this.cooldownMs = options.cooldownMs ?? 15 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  private now: () => number;

  canAttempt(providerId: string): { allowed: boolean; reason?: string; retryInMs?: number } {
    const record = this.attempts.get(providerId);
    // Only a *failure* starts the cooldown; a successful login clears it.
    if (!record?.lastFailureAt) return { allowed: true };

    const since = this.now() - record.lastFailureAt;
    if (since < this.cooldownMs) {
      const retryInMs = this.cooldownMs - since;
      return {
        allowed: false,
        reason: record.lastFailureReason ?? "recent failed attempt",
        retryInMs,
      };
    }
    return { allowed: true };
  }

  recordAttempt(providerId: string): void {
    const record = this.attempts.get(providerId) ?? { lastAttemptAt: 0, successes: 0 };
    record.lastAttemptAt = this.now();
    this.attempts.set(providerId, record);
    this.save();
  }

  recordFailure(providerId: string, reason: string): void {
    const record = this.attempts.get(providerId) ?? { lastAttemptAt: 0, successes: 0 };
    record.lastAttemptAt = this.now();
    record.lastFailureAt = this.now();
    record.lastFailureReason = reason;
    this.attempts.set(providerId, record);
    this.save();
  }

  recordSuccess(providerId: string): void {
    const record = this.attempts.get(providerId) ?? { lastAttemptAt: 0, successes: 0 };
    record.successes += 1;
    delete record.lastFailureAt;
    delete record.lastFailureReason;
    this.attempts.set(providerId, record);
    this.save();
  }

  record(providerId: string): AttemptRecord | undefined {
    return this.attempts.get(providerId);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, AttemptRecord>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value.lastAttemptAt === "number") this.attempts.set(key, value);
      }
    } catch (error) {
      log.debug(`[login] could not read ${this.file}: ${describe(error)}`);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify(Object.fromEntries(this.attempts), null, 2),
        { mode: 0o600 }
      );
      fs.chmodSync(this.file, 0o600);
    } catch (error) {
      log.debug(`[login] could not persist ${this.file}: ${describe(error)}`);
    }
  }
}

/**
 * Summarise cookie lifetime so `/status` can warn before a session dies rather
 * than after an agent run fails mid-task.
 */
export interface CookieSummary {
  cookies: number;
  sessionCookies: number;
  /** Earliest expiry among persistent cookies, ISO string. */
  expiresAt?: string;
  /** Days remaining for the soonest-expiring cookie. */
  daysRemaining?: number;
  hasAuthCookie: boolean;
}

export function summariseCookies(
  cookies: { name: string; expires: number; domain: string }[],
  authHints: string[],
  now = Date.now()
): CookieSummary {
  const persistent = cookies.filter((cookie) => cookie.expires > 0);
  const expiries = persistent.map((cookie) => cookie.expires * 1000).sort((a, b) => a - b);
  const soonest = expiries[0];
  const hasAuthCookie = cookies.some((cookie) =>
    authHints.some((hint) => cookie.name.toLowerCase().includes(hint.toLowerCase()))
  );

  return {
    cookies: cookies.length,
    sessionCookies: cookies.filter((cookie) => cookie.expires <= 0).length,
    ...(soonest ? { expiresAt: new Date(soonest).toISOString() } : {}),
    ...(soonest ? { daysRemaining: Math.max(0, Math.round((soonest - now) / 86_400_000)) } : {}),
    hasAuthCookie,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
