import "dotenv/config";

/** Kept for backwards compatibility with the README/extension defaults. */
export const DEFAULT_API_KEY = "web-agents-to";

function str(name: string, fallback = ""): string {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function optionalStr(name: string): string | undefined {
  const value = str(name);
  return value === "" ? undefined : value;
}

function int(name: string, fallback: number, min = 0): number {
  const raw = str(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function list(name: string): string[] {
  return str(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const host = str("HOST", "127.0.0.1");
const apiKey = str("API_KEY", DEFAULT_API_KEY);

export const config = {
  // Server
  port: int("PORT", 8787, 1),
  host,
  logLevel: str("LOG_LEVEL", "info"),
  apiKey,
  /** True while the well-known development key is still in use. */
  usingDefaultApiKey: apiKey === DEFAULT_API_KEY,
  /** Comma-separated extra CORS origins; loopback + extensions always allowed. */
  corsOrigins: list("CORS_ORIGINS"),
  /** Allow binding to a non-loopback host with a default/empty API key. */
  allowInsecure: bool("ALLOW_INSECURE", false),
  requestBodyLimitBytes: int("REQUEST_BODY_LIMIT_BYTES", 10 * 1024 * 1024, 1024),
  /** Comma-separated provider ids to enable; empty = all registered. */
  providerIds: list("PROVIDERS"),

  // Browser
  headless: bool("HEADLESS", true),
  profileRoot: optionalStr("PROFILE_ROOT"),
  userAgent: str(
    "USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  ),
  /** Optional JSON patch for provider selectors/URLs (survives UI redesigns). */
  siteOverridesPath: optionalStr("SITE_OVERRIDES"),
  /** Use an already-installed Chromium instead of Playwright's download. */
  chromiumExecutable: optionalStr("CHROMIUM_EXECUTABLE"),
  mimoUser: optionalStr("MIMO_USER"),
  mimoPass: optionalStr("MIMO_PASS"),

  // Provider behaviour
  requestTimeoutMs: int("REQUEST_TIMEOUT_MS", 180_000, 1_000),
  streamPollMs: int("STREAM_POLL_MS", 250, 50),
  streamIdlePolls: int("STREAM_IDLE_POLLS", 6, 1),
  streamMaxWaitMs: int("STREAM_MAX_WAIT_MS", 180_000, 1_000),
  streamStartTimeoutMs: int("STREAM_START_TIMEOUT_MS", 45_000, 1_000),
  providerRetries: int("PROVIDER_RETRIES", 3, 1),
  providerRetryDelayMs: int("PROVIDER_RETRY_DELAY_MS", 2_000, 0),
  maxQueue: int("MAX_QUEUE", 16, 0),
  maxPromptChars: int("MAX_PROMPT_CHARS", 120_000, 1_000),
  /** Let the server translate `<tool_call>` blocks into native `tool_calls`. */
  nativeTools: bool("NATIVE_TOOLS", true),

  // Agent CLI
  agentAutoApprove: bool("AGENT_AUTO_APPROVE", false),
  agentMaxSteps: int("AGENT_MAX_STEPS", 12, 1),
  agentBashTimeoutMs: int("AGENT_BASH_TIMEOUT_MS", 60_000, 1_000),
  agentAllowOutside: bool("AGENT_ALLOW_OUTSIDE", false),
  agentMaxOutputChars: int("AGENT_MAX_OUTPUT_CHARS", 20_000, 500),
};

export type Config = typeof config;

export function isLoopbackHost(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  return (
    normalised === "127.0.0.1" ||
    normalised === "::1" ||
    normalised === "localhost" ||
    normalised === "0:0:0:0:0:0:0:1"
  );
}

/**
 * A server exposed beyond loopback with the shipped default key (or no key at
 * all) is effectively an open proxy to someone's logged-in AI account.
 */
export function isInsecureExposure(value: typeof config = config): boolean {
  if (isLoopbackHost(value.host)) return false;
  return value.usingDefaultApiKey || value.apiKey === "";
}
