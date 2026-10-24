#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

const HELP = `WEB — web-agents-to

Usage:
  WEB                     Agentic interactive chat (local tools, auto-starts server)
  WEB agent [task]        Agentic coding: bash/read/write/edit tools
  WEB repl                Interactive chat (no tools)
  WEB chat <prompt>       One-shot chat
  WEB start               Start the API server only
  WEB models              List available models
  WEB login               Open a browser to sign in to the provider
  WEB logout              Close the provider browser session
  WEB help                Show this help
  WEB version             Show the version

Options for agent/chat:
  --model=<id>            e.g. mimo/mimo-v2.6-pro
  --yes                   Auto-approve tool actions (agent only)
  --steps=<n>             Agent step limit (default 12)`;

/** Use tsx in a dev checkout, fall back to the compiled build otherwise. */
function resolveScript(script) {
  const src = path.join(root, script);
  if (fs.existsSync(path.join(root, "node_modules", "tsx"))) {
    return { file: src, prefix: ["--import", "tsx"] };
  }
  const dist = path.join(root, script.replace(/^src[\\/]/, "dist/").replace(/\.ts$/, ".js"));
  if (fs.existsSync(dist)) return { file: dist, prefix: [] };
  console.error("tsx is not installed and no build was found. Run: npm install && npm run build");
  process.exit(1);
}

function run(script, scriptArgs = []) {
  const resolved = resolveScript(script);
  const child = spawn(process.execPath, [...resolved.prefix, resolved.file, ...scriptArgs], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("error", (error) => {
    console.error(`Failed to start ${script}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
}

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

switch (command) {
  case "agent":
  case "code":
    run("src/cli/agent.ts", rest);
    break;
  case "repl":
    run("src/cli/repl.ts", rest);
    break;
  case "chat":
  case "cli":
    run("src/cli/index.ts", rest);
    break;
  case "start":
  case "serve":
  case "server":
    console.log("Starting web-agents-to server...");
    run("src/server/main.ts", rest);
    break;
  case "login":
    run("src/cli/login.ts", rest);
    break;
  case "logout":
    run("src/cli/logout.ts", rest);
    break;
  case "models":
    run("src/cli/models.ts", rest);
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(version());
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  case undefined:
    run("src/cli/agent.ts");
    break;
  default:
    // Anything else is treated as a one-shot prompt.
    run("src/cli/index.ts", args);
    break;
}
