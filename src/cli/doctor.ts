import { parseArgs } from "node:util";
import { apiKey, baseUrl, chat, ensureServer, listModels } from "./client.js";

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
    options: { chat: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  }).values;

  if (values.help) {
    console.log("Usage: WEB doctor [--chat]\n\nChecks the local API and prints the opencode config.");
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
        fix: /login|sign in|401/i.test(message)
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
