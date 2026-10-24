import { BUSY_PATTERNS } from "../core/page-signals.js";
import { BrowserChatProvider, type SiteConfig } from "./base.js";
import type { PlaywrightBrowserManager } from "../browser/manager.js";
import type { ProviderModel } from "../core/types.js";
import { config } from "../config/index.js";
import { applySiteOverride, loadSiteOverride } from "./overrides.js";

const models: ProviderModel[] = [
  { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", owned_by: "xiaomi" },
  { id: "mimo-v2.6", name: "MiMo V2.6", owned_by: "xiaomi" },
];

const baseCfg: SiteConfig = {
  id: "mimo",
  name: "Xiaomi MiMo Studio",
  baseUrl: "https://aistudio.xiaomimimo.com/",
  chatUrls: ["https://aistudio.xiaomimimo.com/#/ultra", "https://aistudio.xiaomimimo.com/#/c"],
  newChatSelectors: ["button[aria-label='New conversation']"],
  inputSelectors: ["textarea"],
  submitSelectors: [],
  responseSelectors: ["[class*='markdown-prose']", "[class*='markdown-blocks']"],
  models,
  loginHint:
    "Run `npm run login -- --provider=mimo` (or `WEB login`) and sign in manually. " +
    "Google SSO always needs the browser; MIMO_USER/MIMO_PASS only works for Xiaomi password accounts. " +
    "If the UI changed, patch the selectors with SITE_OVERRIDES.",
  loginUrl: "https://account.xiaomi.com/fe/service/login/password?sid=xiaomichatbot",
  usernameSelector: "input[name='account']",
  passwordSelector: "input[name='password']",
  loginButtonSelector: "button:has-text('Sign in')",
  credentials: { user: config.mimoUser, pass: config.mimoPass },
  busyPatterns: BUSY_PATTERNS,
};

export function mimoSiteConfig(): SiteConfig {
  return applySiteOverride(baseCfg, loadSiteOverride(baseCfg.id));
}

export function createMimoProvider(bm: PlaywrightBrowserManager): BrowserChatProvider {
  return new BrowserChatProvider(mimoSiteConfig(), bm);
}
