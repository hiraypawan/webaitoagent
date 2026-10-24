import readline from "node:readline";
import { parseArgs } from "node:util";
import { chat, ensureServer, listModels } from "./client.js";
import { createToolRunner, TOOL_DEFINITIONS } from "./tools.js";
import { parseToolCalls, stripToolCalls } from "../core/toolcalls.js";
import type { ChatMessage, OpenAITool, OpenAIToolCall } from "../core/types.js";

interface AgentOptions {
  model: string;
  steps: number;
  yes: boolean;
  root: string;
}

const jsonTypes: Record<string, string> = { string: "string", number: "number" };

function toOpenAITools(): OpenAITool[] {
  return TOOL_DEFINITIONS.map((tool) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, description] of Object.entries(tool.params)) {
      const optional = description.includes("optional");
      properties[name] = { type: jsonTypes[description.split(" ")[0]!] ?? "string", description };
      if (!optional) required.push(name);
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: { type: "object", properties, required },
      },
    };
  });
}

function systemPrompt(root: string): string {
  const platform = `${process.platform} (${process.arch})`;
  return [
    "You are a coding assistant running locally with access to the user's filesystem and shell.",
    `Workspace root: ${root}`,
    `Platform: ${platform}`,
    "",
    "TOOLS:",
    ...TOOL_DEFINITIONS.map(
      (tool) => `- ${tool.name}: ${tool.description} Params: ${JSON.stringify(tool.params)}`
    ),
    "",
    "HOW TO CALL A TOOL:",
    'Output exactly one block: <tool_call name="TOOL_NAME">{"param": "value"}</tool_call>',
    "Then STOP and wait for the tool result. Do not invent results.",
    "",
    "RULES:",
    "- One tool call per reply.",
    "- Paths are relative to the workspace root; prefer reading before rewriting.",
    "- Prefer replace_in_file over write_file for small edits.",
    "- When you have the final answer, reply normally without any tool_call block.",
    "- Be concise; explain what you changed.",
  ].join("\n");
}

function confirmFactory(): {
  confirm: (question: string) => Promise<boolean>;
  /** Returns true when the line was an answer to a pending confirmation. */
  handleLine: (line: string) => boolean;
} {
  let pending: ((answer: string) => void) | null = null;

  return {
    confirm: async (question: string) => {
      if (!process.stdin.isTTY) {
        console.error(`\n[approval required] ${question.trim()}\nRun with --yes to auto-approve in scripts.`);
        return false;
      }
      process.stdout.write(`\n${question} `);
      const answer = await new Promise<string>((resolve) => {
        pending = resolve;
      });
      return /^y(es)?$/i.test(answer.trim());
    },
    handleLine: (line: string) => {
      if (!pending) return false;
      const resolve = pending;
      pending = null;
      resolve(line);
      return true;
    },
  };
}

function nativeCallsToText(calls: OpenAIToolCall[]): string {
  return calls
    .map(
      (call) => `<tool_call name="${call.function.name}">${call.function.arguments}</tool_call>`
    )
    .join("\n");
}

async function runAgentLoop(
  task: string,
  options: AgentOptions,
  confirm: (question: string) => Promise<boolean>
): Promise<void> {
  const tools = toOpenAITools();
  const runner = createToolRunner({
    root: options.root,
    autoApprove: options.yes,
    confirm,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(runner.root) },
    { role: "user", content: task },
  ];
  const seen = new Map<string, number>();

  for (let step = 1; step <= options.steps; step++) {
    console.log(`\n--- Step ${step}/${options.steps} ---`);
    process.stdout.write("Assistant> ");

    let result;
    try {
      result = await chat({
        model: options.model,
        messages,
        tools,
        onDelta: (text) => process.stdout.write(text),
      });
    } catch (error) {
      console.error(`\n[error] ${error instanceof Error ? error.message : error}`);
      return;
    }
    console.log("");

    const calls = result.toolCalls.length
      ? parseToolCalls(nativeCallsToText(result.toolCalls))
      : parseToolCalls(result.content);

    if (calls.length === 0) {
      const answer = stripToolCalls(result.content);
      if (answer && !result.toolCalls.length) {
        // Streamed above already; only show a cleaned version if it differed.
        if (answer !== result.content.trim()) console.log(answer);
      }
      console.log("[agent finished]");
      return;
    }

    const assistantText = stripToolCalls(result.content) || result.toolCalls.map((call) => call.function.name).join(", ");
    messages.push({ role: "assistant", content: assistantText || "(tool call)" });

    for (const call of calls) {
      const signature = `${call.name}:${JSON.stringify(call.args)}`;
      const count = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, count);
      if (count > 2) {
        console.log(`\n[agent stopped: repeated tool call ${call.name} ${count} times]`);
        return;
      }

      console.log(`\n[${call.name}] ${JSON.stringify(call.args)}`);
      const output = await runner.execute(call.name, call.args);
      console.log(`[result] ${output.slice(0, 700)}${output.length > 700 ? "..." : ""}`);
      messages.push({ role: "user", content: `Tool result for ${call.name}:\n${output}` });
    }
  }

  console.log(`\n[agent reached the ${options.steps}-step limit]`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.toString().trim();
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        model: { type: "string" },
        steps: { type: "string" },
        yes: { type: "boolean", short: "y" },
        cwd: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (parsed.values.help) {
    printHelp();
    return;
  }

  if (!(await ensureServer())) process.exit(1);

  const options: AgentOptions = {
    model: parsed.values.model ?? process.env.MODEL ?? "mimo/mimo-v2.6-pro",
    steps: Math.max(1, Number.parseInt(parsed.values.steps ?? "12", 10) || 12),
    yes: parsed.values.yes ?? false,
    root: parsed.values.cwd ?? process.cwd(),
  };

  if (!options.yes) {
    console.log("Tip: destructive tools ask for confirmation. Use --yes to auto-approve.\n");
  }

  const confirm = confirmFactory();
  const task = parsed.positionals.join(" ").trim() || (await readStdin());

  if (task) {
    await runAgentLoop(task, options, confirm.confirm);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error("No task provided. Usage: WEB agent <task>");
    process.exitCode = 1;
    return;
  }

  try {
    await listModels();
  } catch {
    // model list is advisory only
  }

  console.log("web-agents-to agent — local tools: " + TOOL_DEFINITIONS.map((tool) => tool.name).join(", "));
  console.log("Commands: /model <id>, /steps <n>, /help, /exit\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "Agent> " });
  rl.prompt();

  let busy = false;
  rl.on("line", async (line) => {
    // A pending tool approval consumes the line before any command handling.
    if (confirm.handleLine(line)) {
      if (!busy) rl.prompt();
      return;
    }
    const input = line.trim();
    if (busy) return;
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "exit" || input === "quit" || input === "/exit") {
      rl.close();
      return;
    }
    if (input === "/help") {
      console.log("Commands: /model <id>, /steps <n>, /help, /exit");
      rl.prompt();
      return;
    }
    if (input.startsWith("/model ")) {
      options.model = input.slice(7).trim();
      console.log(`Model set to ${options.model}`);
      rl.prompt();
      return;
    }
    if (input.startsWith("/steps ")) {
      options.steps = Math.max(1, Number.parseInt(input.slice(7), 10) || options.steps);
      console.log(`Step limit set to ${options.steps}`);
      rl.prompt();
      return;
    }
    if (input.startsWith("/")) {
      console.log("Unknown command. Try /help");
      rl.prompt();
      return;
    }

    busy = true;
    try {
      await runAgentLoop(input, options, confirm.confirm);
    } finally {
      busy = false;
      console.log("");
      rl.prompt();
    }
  });

  rl.on("close", () => {
    console.log("\nBye.");
    process.exit(0);
  });
}

function printHelp(): void {
  console.log(`WEB agent — agentic coding with local tools

Usage:
  WEB agent [task] [--model=<id>] [--steps=<n>] [--yes] [--cwd=<dir>]

Options:
  --model   Model id (default mimo/mimo-v2.6-pro)
  --steps   Maximum agent steps (default 12)
  --yes     Auto-approve shell commands and file edits (needed in scripts)
  --cwd     Workspace root for the tools (default: current directory)

Without a task it starts an interactive session. Piped stdin is used as the task.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
