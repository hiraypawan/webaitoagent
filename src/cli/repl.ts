import readline from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const API_KEY = process.env.API_KEY || "web-agents-to";

function httpGet(url: string) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { Authorization: "Bearer " + API_KEY } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", reject);
  });
}

async function ensureServer() {
  try {
    const r: any = await httpGet(BASE + "/health");
    if (r.status === 200) return true;
  } catch {}
  console.log("Starting Web Agents To server...");
  const child = spawn("node", ["--import", "tsx", path.join(root, "src/server/main.ts")], {
    cwd: root, stdio: "ignore", detached: true, env: { ...process.env },
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r: any = await httpGet(BASE + "/health");
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
  if (!res.ok) { console.error(await res.text()); return ""; }
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

async function main() {
  const ok = await ensureServer();
  if (!ok) process.exit(1);

  let model = "mimo/mimo-v2.6-pro";
  const history: { role: string; content: string }[] = [];

  console.log("Web Agents To - Interactive CLI");
  console.log("Model: " + model);
  console.log("Commands: /model <id>, /models, /clear, /exit");
  console.log("--------------------------------------------------");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "You> " });
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === "/exit" || input === "/quit") { rl.close(); return; }
    if (input === "/clear") { history.length = 0; console.log("History cleared."); rl.prompt(); return; }
    if (input === "/models") {
      try {
        const r = await fetch(BASE + "/v1/models", { headers: { Authorization: "Bearer " + API_KEY } });
        const j = await r.json();
        console.log(j.data.map((m: any) => m.id).join("\n"));
      } catch (e: any) { console.error(e?.message ?? e); }
      rl.prompt();
      return;
    }
    if (input.startsWith("/model ")) {
      model = input.slice(7).trim();
      console.log("Model set to " + model);
      rl.prompt();
      return;
    }
    if (input.startsWith("/")) {
      console.log("Unknown command. Try /help");
      rl.prompt();
      return;
    }

    history.push({ role: "user", content: input });
    process.stdout.write("Assistant> ");
    const reply = await chat(model, history);
    history.push({ role: "assistant", content: reply });
    rl.prompt();
  });

  rl.on("close", () => { console.log("\nBye."); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });