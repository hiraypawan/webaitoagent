#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const cmd = args[0];

function run(script, extra = []) {
  const child = spawn("node", ["--import", "tsx", path.join(root, script), ...extra], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (!cmd || cmd === "agent" || cmd === "code" || cmd === "repl") {
  // Default interactive mode = agentic (with tool loop)
  run("src/cli/agent.ts", cmd === "agent" || cmd === "code" ? args.slice(1) : args);
} else if (cmd === "chat") {
  run("src/cli/index.ts", args.slice(1));
} else if (cmd === "start" || cmd === "serve" || cmd === "server") {
  console.log("Starting Web Agents To server...");
  run("src/server/main.ts");
} else if (cmd === "cli") {
  run("src/cli/index.ts", args.slice(1));
} else if (cmd === "login") {
  run("src/cli/login.ts", args.slice(1));
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`WEB - Web Agents To

Usage:
  WEB                  Agentic interactive chat (auto-starts server, uses tools)
  WEB agent <task>     Agentic coding with local bash/read/write tools
  WEB chat <prompt>    Simple one-shot chat (no tools)
  WEB start            Start the API server only
  WEB login            Open browser to log in to a provider (MiMo)
  WEB help             Show this help
`);
} else {
  // treat unknown as one-shot prompt
  run("src/cli/index.ts", args);
}
