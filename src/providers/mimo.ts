import { BrowserChatProvider, type SiteConfig } from "./base.js";
import type { PlaywrightBrowserManager } from "../browser/manager.js";
import type { ProviderModel } from "../core/types.js";
import { config } from "../config/index.js";

const models: ProviderModel[] = [
  { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", owned_by: "xiaomi" },
  { id: "mimo-v2.6", name: "MiMo V2.6", owned_by: "xiaomi" },
];

const cfg: SiteConfig = {
  id: "mimo",
  name: "Xiaomi MiMo Studio",
  baseUrl: "https://aistudio.xiaomimimo.com/",
  chatUrls: [
    "https://aistudio.xiaomimimo.com/#/ultra",
    "https://aistudio.xiaomimimo.com/#/c",
  ],
  newChatSelectors: [
    "button[aria-label='New conversation']",
  ],
  inputSelectors: [
    "textarea",
  ],
  submitSelectors: [],
  responseSelectors: [
    "[class*='markdown-prose']",
    "[class*='markdown-blocks']",
  ],
  models,
  loginHint:
    "Open the login flow with: npm run login -- --provider=mimo, then log in (use 'Sign in with Google' if your account is a Gmail). Auto-login via MIMO_USER/MIMO_PASS only works for Xiaomi password accounts, not Google SSO.",
  loginUrl: "https://account.xiaomi.com/fe/service/login/password?sid=xiaomichatbot",
  usernameSelector: "input[name='account']",
  passwordSelector: "input[name='password']",
  loginButtonSelector: "button:has-text('Sign in')",
  credentials: { user: config.mimoUser, pass: config.mimoPass },
};

export function createMimoProvider(bm: PlaywrightBrowserManager) {
  return new BrowserChatProvider(cfg, bm);
}