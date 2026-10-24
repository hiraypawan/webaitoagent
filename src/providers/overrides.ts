import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { config } from "../config/index.js";
import { log } from "../core/logger.js";
import type { SiteConfig } from "./base.js";

/**
 * Scraping selectors break whenever the provider redesigns its UI. Instead of
 * shipping a new release every time, the selectors can be patched with JSON:
 *
 *   SITE_OVERRIDES=/path/to/overrides.json
 *   ~/.web-agents-to/providers/mimo.json
 *
 * The file may be a patch for this provider, or a map of provider id → patch.
 */
const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  owned_by: z.string().min(1),
});

export const siteConfigPatchSchema = z
  .object({
    name: z.string().min(1),
    baseUrl: z.string().min(1),
    chatUrls: z.array(z.string().min(1)).min(1),
    inputSelectors: z.array(z.string().min(1)).min(1),
    submitSelectors: z.array(z.string().min(1)),
    responseSelectors: z.array(z.string().min(1)).min(1),
    newChatSelectors: z.array(z.string().min(1)),
    loginUrl: z.string().min(1),
    usernameSelector: z.string().min(1),
    passwordSelector: z.string().min(1),
    loginButtonSelector: z.string().min(1),
    loginHint: z.string().min(1),
    busyPatterns: z.array(z.string().min(1)),
    models: z.array(modelSchema).min(1),
  })
  .partial();

export type SiteConfigPatch = z.infer<typeof siteConfigPatchSchema>;

export function resolveOverridesPath(providerId: string): string | undefined {
  if (config.siteOverridesPath) return config.siteOverridesPath;
  const candidate = path.join(os.homedir(), ".web-agents-to", "providers", `${providerId}.json`);
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function loadSiteOverride(providerId: string): SiteConfigPatch | undefined {
  const file = resolveOverridesPath(providerId);
  if (!file) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    log.warn(`[overrides] could not read ${file}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }

  const candidate =
    raw && typeof raw === "object" && providerId in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>)[providerId]
      : raw;

  const parsed = siteConfigPatchSchema.safeParse(candidate);
  if (!parsed.success) {
    log.warn(`[overrides] invalid patch in ${file}: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
    return undefined;
  }
  log.info(`[overrides] applied ${Object.keys(parsed.data).length} override(s) for ${providerId}`);
  return parsed.data;
}

export function applySiteOverride(base: SiteConfig, patch?: SiteConfigPatch): SiteConfig {
  if (!patch) return base;
  const merged: SiteConfig = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // Never let an override file inject credentials.
    if (key === "credentials") continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.credentials = base.credentials;
  return merged;
}
