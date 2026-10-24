import { parseArgs } from "node:util";
import { apiKey, baseUrl, chat, ensureServer, listModels } from "./client.js";
import { detectShell } from "./shell.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const checks: Check[] = [];

function record(check: Check): void {
  checks.push(check);
  const mark = check.ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  if (!check.ok && check.fix) console.log(`       fix: ${check.fix}`);
}

async function main(): Promise<void> {
  const values = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      chat: { type: "boolean" },
      probe: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  }).values;

  if (values.help) {
    console.log(
      [
        "Usage: WEB doctor [--chat] [--probe]",
        "",
        "  --chat   send one real request that must produce a tool call",
        "  --probe  actively load the provider page to verify the saved session",
        "           (starts the browser; may be slow)",
        "",
        "Prints a check summary and a ready-to-paste opencode config.",
      ].join("\n")
    );
    return;
  }

  console.log("web-agents-to doctor\n");

  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  record({
    name: "Node.js version",
    ok: major > 20 || (major === 20 && minor >= 3),
    detail: process.version,
    fix: "Upgrade to Node.js 20.3 or newer.",
  });

  const shell = detectShell();
  record({
    name: "Shell for the coding agent",
    ok: shell.kind === "bash",
    detail:
      shell.kind === "bash"
        ? `${shell.label} (${shell.file})`
        : `${shell.label} — Unix commands like ls, cat, grep are worked around automatically`,
    fix:
      shell.kind === "bash"
        ? undefined
        : "Install Git for Windows (git-scm.com) for full bash, or ignore this: the agent uses built-in equivalents.",
  });

  const up = await ensureServer({ quiet: true });
  record({
    name: "API server",
    ok: up,
    detail: up ? baseUrl() : "not reachable",
    fix: up ? undefined : "Run `npm run dev` and try again.",
  });
  if (!up) return summary();

  let models: { id: string }[] = [];
  try {
    models = await listModels();
    record({ name: "Authentication", ok: true, detail: `key accepted (${mask(apiKey())})` });
  } catch (error) {
    record({
      name: "Authentication",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: "Set API_KEY in .env to the same value opencode uses.",
    });
  }

  record({
    name: "Model list",
    ok: models.length > 0,
    detail: models.map((model) => model.id).join(", ") || "empty",
    fix: models.length === 0 ? "Check PROVIDERS in .env." : undefined,
  });

  let status: { providers?: { id: string; browser?: { launched: boolean; headed: boolean } }[] } = {};
  try {
    const response = await fetch(baseUrl() + "/status", {
      headers: { Authorization: `Bearer ${apiKey()}` },
    });
    if (response.ok) status = (await response.json()) as typeof status;
  } catch {
    // status is optional
  }
  const browserState = status.providers?.[0]?.browser;
  record({
    name: "Browser session",
    ok: true,
    detail: browserState?.launched
      ? `running${browserState.headed ? " (visible)" : " (headless)"}`
      : "not started yet — starts on the first request",
  });

  // Session health. Read-only unless --probe is passed: MiMo signs in with a
  // one-time code, so logging in is always a manual step.
  try {
    const url = `${baseUrl()}/auth/session${values.probe ? "?probe=1" : ""}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey()}` } });
    const body = (await response.json()) as {
      session?: {
        checked?: boolean;
        signedIn?: boolean;
        needsLogin?: boolean;
        loginState?: string;
        cookies?: { cookies?: number; daysRemaining?: number; hasAuthCookie?: boolean };
        lastAutoLogin?: { at: string; reason: string } | null;
      };
    };
    const session = body.session ?? {};

    if (values.probe) {
      record({
        name: "Session (probed)",
        ok: session.signedIn === true,
        detail: session.signedIn
          ? `signed in${session.cookies?.daysRemaining !== undefined ? `, cookie expires in ~${session.cookies.daysRemaining}d` : ""}`
          : `not usable (${session.loginState ?? "unknown"})`,
        fix: session.signedIn ? undefined : "Run `WEB login` and complete the one-time code.",
      });
    } else {
      const days = session.cookies?.daysRemaining;
      record({
        name: "Session",
        ok: true,
        detail: session.checked
          ? `${session.cookies?.cookies ?? 0} cookie(s)${session.cookies?.hasAuthCookie ? ", auth cookie present" : ""}` +
            (days !== undefined ? `, expires in ~${days}d` : "")
          : "not inspected yet — run `WEB login`, or `WEB doctor --probe` to verify",
      });
    }

    if (session.lastAutoLogin) {
      record({
        name: "Automatic login",
        ok: false,
        detail: `paused after ${session.lastAutoLogin.reason} at ${session.lastAutoLogin.at}`,
        fix: "Expected when the provider asks for a one-time code. Finish a login with `WEB login`.",
      });
    }
  } catch (error) {
    record({
      name: "Session",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (values.chat) {
    const model = models[0]?.id ?? "mimo/mimo-v2.6-pro";
    console.log(`\nSending a tool-enabled test request to ${model} (this uses the model once)...`);
    try {
      const result = await chat({
        model,
        messages: [
          {
            role: "user",
            content:
              'Use the bash tool to list files. Reply with a single block: <tool_call name="bash">{"command":"ls"}</tool_call>',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
        ],
      });
      record({
        name: "Tool call end to end",
        ok: result.toolCalls.length > 0,
        detail:
          result.toolCalls.length > 0
            ? `${result.toolCalls[0]!.function.name}(${result.toolCalls[0]!.function.arguments})`
            : `no tool call; model replied: ${result.content.slice(0, 120)}`,
        fix:
          result.toolCalls.length === 0
            ? "Model ignored the protocol. Retry, or use a more explicit prompt/model."
            : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({
        name: "Tool call end to end",
        ok: false,
        detail: message,
        fix: /one-time code|verification/i.test(message)
          ? "The provider wants a one-time code: run `WEB login` and complete it there."
          : /login|sign in|401/i.test(message)
            ? "Run `WEB login` to sign in to the provider first."
            : "Check the server log for the provider error.",
      });
    }
  }

  printOpencodeConfig(models[0]?.id);
  summary();
}

function mask(key: string): string {
  if (key.length <= 6) return "***";
  return `${key.slice(0, 3)}***${key.slice(-2)}`;
}

function printOpencodeConfig(firstModel?: string): void {
  const providerId = "web-agents-to";
  const model = (firstModel ?? "mimo/mimo-v2.6-pro").split("/").pop()!;
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Web Agents To",
        options: { baseURL: `${baseUrl()}/v1`, apiKey: apiKey() },
        models: {
          [model]: {
            name: model,
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

  console.log("\nopencode config (put in ./opencode.json or ~/.config/opencode/opencode.json):\n");
  console.log(JSON.stringify(config, null, 2));
  console.log(
    "\nStart with: opencode --model " +
      `${providerId}/${model}` +
      "\nIf opencode shows no tools, make sure `tool_call: true` is set on the model."
  );
}

function summary(): void {
  const failed = checks.filter((check) => !check.ok);
  console.log("");
  if (failed.length === 0) {
    console.log(`All ${checks.length} checks passed.`);
    return;
  }
  console.log(`${failed.length} of ${checks.length} checks failed:`);
  for (const check of failed) console.log(`  - ${check.name}: ${check.detail}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
