import readline from "node:readline";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const API_KEY = process.env.API_KEY || "web-agents-to";

const TOOLS = [
  { name: "bash", description: "Run a shell command (PowerShell on Windows). Returns stdout+stderr.", params: { command: "string" } },
  { name: "read_file", description: "Read a file's contents.", params: { path: "string" } },
  { name: "write_file", description: "Write content to a file (creates parent dirs).", params: { path: "string", content: "string" } },
  { name: "list_dir", description: "List files in a directory.", params: { path: "string" } },
];

const SYSTEM_PROMPT = `You are a coding assistant with access to tools. You can read files, write files, list directories, and run shell commands.

AVAILABLE TOOLS:
${TOOLS.map((t) => `- ${t.name}: ${t.description} Params: ${JSON.stringify(t.params)}`).join("\n")}

HOW TO CALL A TOOL:
When you need to use a tool, output EXACTLY this format (one tool call per block):
<tool_call name="TOOL_NAME">
{"param": "value"}
</tool_call>

After you output a tool call, STOP and wait for the tool result. Do NOT guess the result.

RULES:
- Only call one tool at a time.
- After receiving a tool result, continue your reasoning.
- When you have the final answer, respond normally WITHOUT any tool_call tags.
- Use Windows PowerShell commands (dir, type, etc.) since this is Windows.
- Be concise and helpful.`;

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { Authorization: "Bearer " + API_KEY } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: d }));
    }).on("error", reject);
  });
}

async function ensureServer(): Promise<boolean> {
  try {
    const r = await httpGet(BASE + "/health");
    if (r.status === 200) return true;
  } catch {}
  console.log("Starting server...");
  const child = spawn("node", ["--import", "tsx", path.join(root, "src/server/main.ts")], {
    cwd: root, stdio: "ignore", detached: true, env: { ...process.env },
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await httpGet(BASE + "/health");
      if (r.status === 200) { console.log("Server ready.\n"); return true; }
    } catch {}
  }
  console.error("Server failed to start.");
  return false;
}

async function chat(model: string, messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) { console.error("API error:", await res.text()); return ""; }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const c = j.choices?.[0]?.delta?.content;
        if (c) { process.stdout.write(c); full += c; }
      } catch {}
    }
  }
  process.stdout.write("\n");
  return full;
}

function executeTool(name: string, args: any): string {
  try {
    if (name === "bash") {
      const out = execSync(args.command, { encoding: "utf-8", timeout: 30000, cwd: process.cwd(), shell: "powershell.exe" });
      return out || "(no output)";
    }
    if (name === "read_file") {
      return fs.readFileSync(args.path, "utf-8");
    }
    if (name === "write_file") {
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      fs.writeFileSync(args.path, args.content, "utf-8");
      return `File written: ${args.path}`;
    }
    if (name === "list_dir") {
      const entries = fs.readdirSync(args.path, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? "[dir] " : "[file] ") + e.name).join("\n");
    }
    return `Unknown tool: ${name}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function parseToolCalls(text: string): { name: string; args: any }[] {
  const calls: { name: string; args: any }[] = [];
  const regex = /<tool_call\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    try {
      const args = JSON.parse(m[2].trim());
      calls.push({ name: m[1], args });
    } catch {
      // try to parse as key=value
      calls.push({ name: m[1], args: {} });
    }
  }
  return calls;
}

async function agentLoop(model: string, userTask: string, maxSteps = 10) {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userTask },
  ];

  for (let step = 0; step < maxSteps; step++) {
    console.log(`\n--- Step ${step + 1} ---`);
    process.stdout.write("Assistant> ");
    const reply = await chat(model, messages);
    messages.push({ role: "assistant", content: reply });

    const toolCalls = parseToolCalls(reply);
    if (toolCalls.length === 0) {
      // No tool calls - final answer
      console.log("\n[Agent finished]");
      return;
    }

    // Execute each tool
    for (const tc of toolCalls) {
      console.log(`\n[Tool: ${tc.name}] ${JSON.stringify(tc.args)}`);
      const result = executeTool(tc.name, tc.args);
      console.log(`[Result] ${result.slice(0, 500)}${result.length > 500 ? "..." : ""}`);
      messages.push({ role: "user", content: `Tool result for ${tc.name}:\n${result}` });
    }
  }
  console.log("\n[Agent reached max steps]");
}

async function main() {
  const ok = await ensureServer();
  if (!ok) process.exit(1);

  const args = process.argv.slice(2);
  const model = args.find((a) => a.startsWith("--model="))?.split("=")[1] || "mimo/mimo-v2.6-pro";
  const task = args.filter((a) => !a.startsWith("--")).join(" ");

  if (!task) {
    // Interactive mode
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "Agent> " });
    console.log("MiMo Agent - Interactive (tools: bash, read_file, write_file, list_dir)");
    console.log("Type a task, or 'exit' to quit.\n");
    rl.prompt();
    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) { rl.prompt(); return; }
      if (input === "exit" || input === "quit") { rl.close(); return; }
      await agentLoop(model, input);
      console.log("");
      rl.prompt();
    });
    rl.on("close", () => { console.log("Bye."); process.exit(0); });
  } else {
    await agentLoop(model, task);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });