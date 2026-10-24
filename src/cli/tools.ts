import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { truncateEnd } from "../core/utils.js";
import { canShim, fallbackHint, looksLikeMissingCommand, runPosixShim } from "./posix-shim.js";
import { detectShell, shellFallbacks, type ShellChoice } from "./shell.js";

export interface ToolDefinition {
  name: string;
  description: string;
  params: Record<string, string>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "bash",
    description:
      "Run a shell command in the workspace and return stdout + stderr. The shell is picked " +
      "automatically (bash if installed, otherwise PowerShell, then cmd.exe); pass `shell` to " +
      "force one. If the shell does not know a simple command like ls/cat/mkdir/rm, it is run " +
      "natively as a fallback.",
    params: {
      command: "string",
      shell: "string (optional: bash | powershell | cmd | sh)",
      cwd: "string (optional, directory inside the workspace)",
    },
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
  {
    name: "glob",
    description: "Find files by pattern, e.g. `src/**/*.ts`. No shell needed.",
    params: {
      pattern: "string",
      path: "string (optional, directory to search, defaults to workspace root)",
      limit: "number (optional, max results, default 200)",
    },
  },
  {
    name: "grep",
    description:
      "Search file contents, returning `path:line: text`. No shell needed, so it works on every OS.",
    params: {
      pattern: "string (regular expression)",
      path: "string (optional, file or directory, defaults to workspace root)",
      include: "string (optional glob filter, e.g. *.ts)",
      ignore_case: "boolean (optional)",
      limit: "number (optional, max matches, default 200)",
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory.",
    params: { from: "string", to: "string" },
  },
  {
    name: "copy_file",
    description: "Copy a file or directory (recursively).",
    params: { from: "string", to: "string" },
  },
  {
    name: "delete_file",
    description: "Delete a file, or a directory with all of its contents. Requires approval.",
    params: { path: "string" },
  },
  {
    name: "make_dir",
    description: "Create a directory, including any missing parents.",
    params: { path: "string" },
  },
  {
    name: "append_file",
    description: "Append text to the end of a file, creating it if missing.",
    params: { path: "string", content: "string" },
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


const DEFAULT_IGNORES = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", "__pycache__"]);

/** Recursively list files, skipping heavy/build directories. */
export function walkFiles(
  start: string,
  options: { limit?: number; ignore?: Set<string>; maxDepth?: number } = {}
): string[] {
  const limit = options.limit ?? 20_000;
  const ignore = options.ignore ?? DEFAULT_IGNORES;
  const maxDepth = options.maxDepth ?? 12;
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];

  while (stack.length > 0 && out.length < limit) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name) || depth >= maxDepth) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        out.push(full);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/** Convert a glob (`**`, `*`, `?`, `{a,b}`) into a regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const normalised = pattern.replace(/\\/g, "/");
  let out = "^";
  for (let i = 0; i < normalised.length; i++) {
    const char = normalised[i]!;
    if (char === "*") {
      if (normalised[i + 1] === "*") {
        i++;
        if (normalised[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "{") {
      const end = normalised.indexOf("}", i);
      if (end > i) {
        const options = normalised.slice(i + 1, end).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&"));
        out += `(?:${options.join("|")})`;
        i = end;
        continue;
      }
    }
    out += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`, "i");
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

  function resolveShell(requested?: string): ShellChoice {
    const wanted = (requested ?? "").trim().toLowerCase();
    if (!wanted) return detectShell();
    if (wanted === "bash" || wanted === "powershell" || wanted === "pwsh" || wanted === "cmd" || wanted === "sh") {
      return detectShell({ env: { ...process.env, AGENT_SHELL: wanted } });
    }
    throw new Error(`unknown shell '${requested}' (use bash, powershell, cmd or sh)`);
  }

  function spawnShell(shell: ShellChoice, command: string, dir: string): Promise<{
    output: string;
    exitCode: number;
    spawnError?: string;
  }> {
    return new Promise((resolve) => {
      let output = "";
      let done = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (exitCode: number, spawnError?: string) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve({ output, exitCode, spawnError });
      };

      let child;
      try {
        child = spawn(shell.file, [...shell.prefix, command], {
          cwd: dir,
          env: { ...process.env, AGENT: "web-agents-to" },
          windowsHide: true,
        });
      } catch (error) {
        finish(1, error instanceof Error ? error.message : String(error));
        return;
      }

      timer = setTimeout(() => {
        child.kill("SIGKILL");
        output += `\n[command timed out after ${bashTimeoutMs}ms]`;
        finish(124);
      }, bashTimeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (data: Buffer) => {
        if (output.length < maxOutputChars * 2) output += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        if (output.length < maxOutputChars * 2) output += data.toString();
      });
      child.on("error", (error) => finish(1, error.message));
      child.on("close", (code) => finish(code ?? 0));
    });
  }

  async function runBash(
    command: string,
    requestedShell?: string,
    requestedCwd?: string
  ): Promise<string> {
    if (!command.trim()) throw new Error("command is required");
    const dir = requestedCwd ? resolvePath(requestedCwd) : root;
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`${dir} is not a directory`);
    }
    await approve("shell command", command);

    let shell = resolveShell(requestedShell);
    let result = await spawnShell(shell, command, dir);

    // The chosen executable vanished (or a forced shell was not installed):
    // retry with the other shells that do exist instead of failing outright.
    if (result.spawnError) {
      for (const fallback of shellFallbacks()) {
        if (fallback.file === shell.file) continue;
        const retry = await spawnShell(fallback, command, dir);
        if (!retry.spawnError) {
          shell = fallback;
          result = retry;
          break;
        }
      }
      if (result.spawnError) {
        throw new Error(`could not start a shell: ${result.spawnError}`);
      }
    }

    const body = result.output.trim();
    const missing = looksLikeMissingCommand(result.output);

    if (missing && canShim(command)) {
      const shim = runPosixShim(command, dir, { maxOutputChars });
      if (shim.handled) {
        return truncateEnd(
          `${shim.output}${shim.exitCode !== 0 ? `\n[exit code ${shim.exitCode}]` : ""}\n` +
            `[built-in equivalent used: ${shell.label} does not know '${command.trim().split(/\s+/)[0]}']`,
          maxOutputChars
        );
      }
    }

    if (result.exitCode !== 0) {
      const extra = missing ? `\n${fallbackHint(command, shell.label)}` : "";
      return truncateEnd(
        `${body || "(no output)"}\n[exit code ${result.exitCode} · shell: ${shell.label}]${extra}`,
        maxOutputChars
      );
    }

    return truncateEnd(body || "(no output)", maxOutputChars);
  }

  async function execute(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "bash":
          return await runBash(
            strArg(args, "command"),
            strArg(args, "shell") || undefined,
            strArg(args, "cwd") || undefined
          );

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

        case "glob": {
          const pattern = strArg(args, "pattern");
          if (!pattern) throw new Error("pattern is required");
          const start = resolvePath(strArg(args, "path", "."));
          const limit = Math.max(1, numArg(args, "limit") ?? 200);
          const regex = globToRegExp(pattern);
          const files = walkFiles(start, { limit: 20_000 });
          const matches = files
            .map((file) => path.relative(start, file).split(path.sep).join("/"))
            .filter((rel) => regex.test(rel))
            .slice(0, limit);
          if (matches.length === 0) return `No files matched ${pattern}`;
          return truncateEnd(matches.join("\n"), maxOutputChars);
        }

        case "grep": {
          const pattern = strArg(args, "pattern");
          if (!pattern) throw new Error("pattern is required");
          const ignoreCase = Boolean(args.ignore_case);
          let regex: RegExp;
          try {
            regex = new RegExp(pattern, ignoreCase ? "i" : "");
          } catch {
            regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
          }
          const target = resolvePath(strArg(args, "path", "."));
          const limit = Math.max(1, numArg(args, "limit") ?? 200);
          const includeRaw = strArg(args, "include");
          const include = includeRaw ? globToRegExp(includeRaw.includes("/") ? includeRaw : `**/${includeRaw}`) : undefined;

          const files = fs.statSync(target).isDirectory()
            ? walkFiles(target, { limit: 20_000 }).filter((file) =>
                include ? include.test(path.relative(target, file).split(path.sep).join("/")) : true
              )
            : [target];

          const hits: string[] = [];
          for (const file of files) {
            if (hits.length >= limit) break;
            let text: string;
            try {
              if (fs.statSync(file).size > MAX_READ_BYTES) continue;
              text = fs.readFileSync(file, "utf8");
            } catch {
              continue;
            }
            if (text.includes("\u0000")) continue;
            const lines = text.split(/\r?\n/);
            for (let index = 0; index < lines.length && hits.length < limit; index++) {
              const line = lines[index]!;
              if (line.length > 2_000) continue;
              if (regex.test(line)) {
                const shown = path.relative(root, file).split(path.sep).join("/") || file;
                hits.push(`${shown}:${index + 1}: ${truncateEnd(line.trim(), 300)}`);
              }
            }
          }
          if (hits.length === 0) return `No matches for ${pattern}`;
          return truncateEnd(`${hits.join("\n")}${hits.length >= limit ? `\n[stopped at ${limit} matches]` : ""}`, maxOutputChars);
        }

        case "move_file": {
          const from = resolvePath(strArg(args, "from"));
          const to = resolvePath(strArg(args, "to"));
          if (!fs.existsSync(from)) throw new Error(`${from} does not exist`);
          await approve("move", `${from} -> ${to}`);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(from, to);
          return `Moved ${from} -> ${to}`;
        }

        case "copy_file": {
          const from = resolvePath(strArg(args, "from"));
          const to = resolvePath(strArg(args, "to"));
          if (!fs.existsSync(from)) throw new Error(`${from} does not exist`);
          await approve("copy", `${from} -> ${to}`);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.cpSync(from, to, { recursive: true });
          return `Copied ${from} -> ${to}`;
        }

        case "delete_file": {
          const target = resolvePath(strArg(args, "path"));
          if (!fs.existsSync(target)) throw new Error(`${target} does not exist`);
          if (target === root) throw new Error("refusing to delete the workspace root");
          await approve("delete", target);
          fs.rmSync(target, { recursive: true, force: true });
          return `Deleted ${target}`;
        }

        case "make_dir": {
          const dir = resolvePath(strArg(args, "path"));
          fs.mkdirSync(dir, { recursive: true });
          return `Created ${dir}`;
        }

        case "append_file": {
          const file = resolvePath(strArg(args, "path"));
          if (typeof args.content !== "string") throw new Error("content must be a string");
          const content = args.content;
          await approve("append to file", file);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFileSync(file, content, "utf8");
          return `Appended ${content.length} bytes to ${file}`;
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
