import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config/index.js";
import { registerOpencodeConfig } from "../core/opencode-configs.js";
import { baseUrl, ensureServer, health, listModels } from "./client.js";
import {
  buildOpencodeConfig,
  describeSession,
  nextSteps,
  renderStep,
  writeOpencodeConfig,
  blockers,
  type SessionSummary,
  type StepResult,
} from "./setup-support.js";

/**
 * `WEB setup` — one command, no jargon.
 *
 * Checks the machine, starts the server, reports sign-in state and writes the
 * opencode config. It never asks for a password: MiMo logins need a one-time
 * code, so the actual sign-in stays a manual, guided step.
 */
async function main(): Promise<void> {
  const values = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      force: { type: "boolean" },
      "no-write": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  }).values;

  if (values.help) {
    console.log(
      [
        "Usage: WEB setup [--dir <project>] [--force] [--no-write]",
        "",
        "Runs the one-time checks, starts the server, reports whether you are",
        "signed in to MiMo, and writes opencode.json into a project folder.",
        "",
        "  --dir <project>  where to write opencode.json (default: current folder)",
        "  --force          overwrite an existing opencode.json",
        "  --no-write       only print the config",
      ].join("\n")
    );
    return;
  }

  const steps: StepResult[] = [];
  console.log("web-agents-to setup\n");

  // 1. Node
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = (major ?? 0) > 20 || ((major ?? 0) === 20 && (minor ?? 0) >= 3);
  steps.push({
    title: "Node.js",
    state: nodeOk ? "ok" : "broken",
    detail: process.version,
    action: nodeOk ? undefined : "install Node.js 20.3 or newer from nodejs.org",
  });

  // 2. Browser for Playwright
  const browser = findBrowser();
  steps.push({
    title: "Browser",
    state: browser ? "ok" : "todo",
    detail: browser ?? "not found (a browser is needed to drive the MiMo website)",
    action: browser ? undefined : "npx playwright install chromium",
    blocking: !browser,
  });

  // 3. Server
  const serverUp = await ensureServer({ quiet: true });
  let session: SessionSummary | undefined;
  let models: { id: string }[] = [];

  steps.push({
    title: "Local server",
    state: serverUp ? "ok" : "broken",
    detail: serverUp ? baseUrl() : "could not start",
    action: serverUp ? undefined : "npm run dev   (then run this again)",
  });

  if (serverUp) {
    try {
      await health();
      models = await listModels();
      steps.push({
        title: "Models",
        state: models.length > 0 ? "ok" : "broken",
        detail: models.map((model) => model.id).join(", ") || "none",
      });
    } catch (error) {
      steps.push({
        title: "Models",
        state: "broken",
        detail: error instanceof Error ? error.message : String(error),
        action: "check API_KEY in .env matches the one opencode will use",
      });
    }

    session = await fetchSession();
    steps.push(describeSession(session));
  }

  for (const step of steps) console.log(renderStep(step));

  // 4. opencode config
  const targetDir = path.resolve(values.dir ?? process.cwd());
  const opencodeConfig = buildOpencodeConfig(undefined, undefined, {
    maxPromptChars: config.maxPromptChars,
  });

  if (values["no-write"]) {
    console.log("\nopencode config (save as opencode.json in your project):\n");
    console.log(JSON.stringify(opencodeConfig, null, 2));
  } else {
    const result = writeOpencodeConfig(targetDir, opencodeConfig, { force: values.force });
    let step: StepResult;
    if (result.written) {
      // Remember the file so a runtime budget change updates limit.context here.
      registerOpencodeConfig(result.path, config.dataRoot);
      step = { title: "opencode config", state: "ok", detail: result.path };
    } else {
      step = {
        title: "opencode config",
        state: "todo",
        detail: `${result.reason ?? "not written"} — ${result.path}`,
        action: "re-run with --force to replace it",
      };
    }
    console.log(renderStep(step));
  }

  console.log("\nNext:");
  for (const line of nextSteps(session)) console.log(`  ${line}`);

  const pending = blockers(steps);
  if (pending.length > 0) {
    console.log(`\n${pending.length} thing(s) must be fixed before opencode will work:`);
    for (const step of pending) {
      console.log(`  - ${step.title}: ${step.detail}`);
      if (step.action) console.log(`    -> ${step.action}`);
    }
    process.exitCode = 1;
  } else if (!session?.signedIn) {
    console.log("\nEverything is installed. The only thing left is signing in to MiMo.");
  } else {
    console.log("\nAll set — open opencode in your project folder and ask it to do something.");
  }
}

async function fetchSession(): Promise<SessionSummary | undefined> {
  try {
    const response = await fetch(`${baseUrl()}/auth/session`, {
      headers: { Authorization: `Bearer ${process.env.API_KEY ?? ""}` },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { session?: SessionSummary };
    return body.session;
  } catch {
    return undefined;
  }
}

/** Best-effort browser detection; Playwright downloads live in the cache dir. */
function findBrowser(): string | undefined {
  if (process.env.CHROMIUM_EXECUTABLE && fs.existsSync(process.env.CHROMIUM_EXECUTABLE)) {
    return process.env.CHROMIUM_EXECUTABLE;
  }
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root).filter((entry) => entry.startsWith("chromium"));
    if (entries.length > 0) return path.join(root, entries[0]!);
  }
  return undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
