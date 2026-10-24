import fs from "node:fs";
import path from "node:path";
import { baseUrl, apiKey } from "./client.js";

/**
 * Pieces of the setup wizard that are pure enough to test.
 *
 * `WEB setup` is aimed at someone who does not want to read the README: it
 * checks the machine, starts the server, explains sign-in, and writes the
 * opencode config into a project folder.
 */

export interface SessionSummary {
  checked?: boolean;
  signedIn?: boolean;
  needsLogin?: boolean;
  loginState?: string;
  cookies?: { cookies?: number; daysRemaining?: number; hasAuthCookie?: boolean };
  lastAutoLogin?: { at: string; reason: string } | null;
}

export type StepState = "ok" | "todo" | "broken";

export interface StepResult {
  title: string;
  state: StepState;
  detail: string;
  /** What the user should type, if anything. */
  action?: string;
  /** True when the task cannot work until this step is done. */
  blocking?: boolean;
}

export interface OpencodeModelOptions {
  providerId?: string;
  model?: string;
  name?: string;
}

/**
 * Build the opencode config. Model keys are the bare id (`mimo-v2.6-pro`):
 * the server resolves provider prefixes, and opencode keys models by the id it
 * shows in its picker.
 */
export function buildOpencodeConfig(
  base = baseUrl(),
  key = apiKey(),
  options: OpencodeModelOptions = {}
): Record<string, unknown> {
  const providerId = options.providerId ?? "web-agents-to";
  const model = options.model ?? "mimo-v2.6-pro";

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: options.name ?? "Web Agents To",
        options: { baseURL: `${base.replace(/\/$/, "")}/v1`, apiKey: key },
        models: {
          [model]: {
            name: model,
            // Without this opencode treats the model as tool-less and never
            // sends the tool list at all.
            tool_call: true,
            reasoning: false,
            attachment: false,
            temperature: false,
            limit: { context: 30000, output: 8000 },
          },
        },
      },
    },
    model: `${providerId}/${model}`,
  };
}

export interface WriteResult {
  path: string;
  written: boolean;
  reason?: string;
}

/** Write opencode.json without silently clobbering an existing one. */
export function writeOpencodeConfig(
  targetDir: string,
  config: Record<string, unknown>,
  options: { force?: boolean } = {}
): WriteResult {
  const file = path.join(targetDir, "opencode.json");
  if (fs.existsSync(file) && !options.force) {
    return { path: file, written: false, reason: "a config already exists (use --force to replace it)" };
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { path: file, written: true };
}

/** Turn the raw session response into a plain-language status. */
export function describeSession(session: SessionSummary | undefined): StepResult {
  const title = "Sign-in";

  if (!session || (!session.checked && !session.signedIn && !session.loginState)) {
    return {
      title,
      state: "todo",
      detail: "not checked yet",
      action: "WEB login   (then: WEB doctor --probe)",
    };
  }

  if (session.signedIn) {
    const days = session.cookies?.daysRemaining;
    return {
      title,
      state: "ok",
      detail:
        "signed in" +
        (days !== undefined ? `, browser session valid for about ${days} more day(s)` : ""),
    };
  }

  if (session.loginState === "verification_required") {
    return {
      title,
      state: "todo",
      detail: "MiMo is waiting for a one-time code (this always needs a person)",
      action: "WEB login   then enter the code in the window that opens",
    };
  }

  if (session.loginState === "blocked") {
    return {
      title,
      state: "todo",
      detail: "MiMo is temporarily refusing sign-ins (rate limit or verification)",
      action: "wait ~15 minutes, then: WEB login",
    };
  }

  if (session.lastAutoLogin) {
    return {
      title,
      state: "todo",
      detail: `automatic sign-in paused (${session.lastAutoLogin.reason})`,
      action: "WEB login",
    };
  }

  return { title, state: "todo", detail: "not signed in", action: "WEB login" };
}

/** Human-readable banner for the wizard. */
export function renderStep(step: StepResult): string {
  const icon = step.state === "ok" ? "[ok]" : step.state === "broken" ? "[!!]" : "[  ]";
  const lines = [`${icon} ${step.title}: ${step.detail}`];
  if (step.action) lines.push(`     -> ${step.action}`);
  return lines.join("\n");
}

/** Everything that must be fixed before `opencode` can work. */
export function blockers(steps: StepResult[]): StepResult[] {
  return steps.filter((step) => step.state === "broken" || (step.state === "todo" && step.blocking));
}

export function nextSteps(session: SessionSummary | undefined): string[] {
  const steps: string[] = [];
  if (!session?.signedIn) steps.push("WEB login                 sign in to MiMo (one-time code)");
  steps.push("WEB doctor --probe        confirm the sign-in actually works");
  steps.push("opencode                  start the coding agent in your project folder");
  steps.push("WEB doctor                if something stops working");
  return steps;
}
