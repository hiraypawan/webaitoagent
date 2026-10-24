import type { PlaywrightBrowserManager } from "../browser/manager.js";
import type { Provider } from "../core/types.js";
import { config } from "../config/index.js";
import { log } from "../core/logger.js";
import { createMimoProvider } from "./mimo.js";

export type ProviderFactory = (bm: PlaywrightBrowserManager) => Provider;

/**
 * Adding a provider = one `SiteConfig` + one factory registration here. The
 * rest of the stack (server, CLIs, extension) is provider-agnostic.
 */
const factories: Record<string, ProviderFactory> = {
  mimo: createMimoProvider,
};

export function registerProvider(id: string, factory: ProviderFactory): void {
  factories[id] = factory;
}

export function providerIds(): string[] {
  return Object.keys(factories);
}

export function createProviders(bm: PlaywrightBrowserManager): Provider[] {
  const requested = config.providerIds;
  const ids = requested.length ? requested.filter((id) => id in factories) : Object.keys(factories);
  if (requested.length && ids.length !== requested.length) {
    const unknown = requested.filter((id) => !(id in factories));
    log.warn(`Unknown provider(s) in PROVIDERS: ${unknown.join(", ")}`);
  }
  if (ids.length === 0) {
    throw new Error(`No providers enabled. Available: ${Object.keys(factories).join(", ")}`);
  }
  return ids.map((id) => factories[id]!(bm));
}
