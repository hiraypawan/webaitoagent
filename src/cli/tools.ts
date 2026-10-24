import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { truncateEnd } from "../core/utils.js";

export interface ToolDefinition {
  name: string;
  description: string;
  params: Record<string, string>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command in the workspace and return stdout + stderr.",
    params: { command: "string" },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file.",
    params: { path: "string", offset: "number (optional, 1-based line)", limit: "number (optional, lines)" },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file (parent directories are created).",
    params: { path: "string", content: "string" },
  },
  {
    name: "replace_in_file",
    description: "Replace exactly one occurrence of `old` with `new` in a file.",
    params: { path: "string", old: "string", new: "string" },
  },
  {
    name: "list_dir",
    description: "List files and directories.",
    params: { path: "string (optional, defaults to workspace root)" },
  },
];

export interface ToolRunnerOptions {
  root: string;
  /** Auto-approve destructive actions (bash/replace_in_file). */
  autoApprove?: boolean;
  /** Allow paths outside the workspace root. */
  allowOutside?: boolean;
  bashTimeoutMs?: number;
  maxOutputChars?: number;
  confirm?: (question: string) => Promise<boolean>;
}

export interface ToolRunner {
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  definitions: ToolDefinition[];
  root: string;
}

const MAX_READ_BYTES = 2 * 1024 * 1024;

function strArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function createToolRunner(options: ToolRunnerOptions): ToolRunner {
  const root = path.resolve(options.root);
  const autoApprove = options.autoApprove ?? config.agentAutoApprove;
  const allowOutside = options.allowOutside ?? config.agentAllowOutside;
  const bashTimeoutMs = options.bashTimeoutMs ?? config.agentBashTimeoutMs;
  const maxOutputChars = options.maxOutputChars ?? config.agentMaxOutputChars;
  const confirm = options.confirm ?? (async () => false);

  function resolvePath(input: string): string {
    if (!input || input.trim() === "") throw new Error("path is required");
    const resolved = path.resolve(root, input);
    if (!allowOutside) {
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          `refusing to touch ${resolved}: outside the workspace (${root}). ` +
            "Set AGENT_ALLOW_OUTSIDE=true to allow this."
        );
      }
    }
    return resolved;
  }

  async function approve(action: string, detail: string): Promise<void> {
    if (autoApprove) return;
    const allowed = await confirm(`Allow ${action}?\n${truncateEnd(detail, 600)}\n[y/N] `);
    if (!allowed) throw new Error(`user denied ${action}`);
  }

  async function runBash(command: string): Promise<string> {
    if (!command.trim()) throw new Error("command is required");
    await approve("shell command", command);

    const isWindows = process.platform === "win32";
    const file = isWindows ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];

    return new Promise<string>((resolve) => {
      const child = spawn(file, shellArgs, {
        cwd: root,
        env: { ...process.env, AGENT: "web-agents-to" },
        windowsHide: true,
      });

      let output = "";
      let done = false;
      const finish = (suffix = "") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(truncateEnd(`${output}${suffix}`.trim() || "(no output)", maxOutputChars));
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(`\n[command timed out after ${bashTimeoutMs}ms]`);
      }, bashTimeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (data: Buffer) => {
        if (output.length < maxOutputChars * 2) output += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        if (output.length < maxOutputChars * 2) output += data.toString();
      });
      child.on("error", (error) => finish(`\n[failed to start: ${error.message}]`));
      child.on("close", (exitCode) => finish(exitCode ? `\n[exit code ${exitCode}]` : ""));
    });
  }

  async function execute(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "bash":
          return await runBash(strArg(args, "command"));

        case "read_file": {
          const file = resolvePath(strArg(args, "path"));
          const stat = fs.statSync(file);
          if (!stat.isFile()) throw new Error(`${file} is not a file`);
          if (stat.size > MAX_READ_BYTES) throw new Error(`${file} is too large (${stat.size} bytes)`);
          const text = fs.readFileSync(file, "utf8");
          if (text.includes("\u0000")) throw new Error(`${file} looks binary`);

          const offset = Math.max(1, numArg(args, "offset") ?? 1);
          const limit = Math.max(1, numArg(args, "limit") ?? 2_000);
          const lines = text.split(/\r?\n/);
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          const header =
            offset > 1 || offset - 1 + limit < lines.length
              ? `[lines ${offset}-${offset - 1 + slice.length} of ${lines.length}]\n`
              : "";
          return truncateEnd(header + slice.join("\n"), maxOutputChars);
        }

        case "write_file": {
          const file = resolvePath(strArg(args, "path"));
          if (typeof args.content !== "string") throw new Error("content must be a string");
          const content = args.content;
          await approve("write file", file);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, content, "utf8");
          return `Wrote ${content.length} bytes to ${file}`;
        }

        case "replace_in_file": {
          const file = resolvePath(strArg(args, "path"));
          const oldText = strArg(args, "old");
          const newText = strArg(args, "new");
          if (!oldText) throw new Error("old is required");
          if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);

          const source = fs.readFileSync(file, "utf8");
          const occurrences = source.split(oldText).length - 1;
          if (occurrences === 0) throw new Error("old text was not found");
          if (occurrences > 1) throw new Error(`old text appears ${occurrences} times; be more specific`);

          await approve("edit file", `${file}\n- ${truncateEnd(oldText, 300)}\n+ ${truncateEnd(newText, 300)}`);
          fs.writeFileSync(file, source.replace(oldText, newText), "utf8");
          return `Updated ${file}`;
        }

        case "list_dir": {
          const dir = resolvePath(strArg(args, "path", "."));
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          if (entries.length === 0) return "(empty directory)";
          return truncateEnd(
            entries
              .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
              .map((entry) => (entry.isDirectory() ? `[dir]  ${entry.name}` : `[file] ${entry.name}`))
              .join("\n"),
            maxOutputChars
          );
        }

        default:
          return `Unknown tool: ${name}. Available: ${TOOL_DEFINITIONS.map((tool) => tool.name).join(", ")}`;
      }
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return { execute, definitions: TOOL_DEFINITIONS, root };
}
