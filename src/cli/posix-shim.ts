import fs from "node:fs";
import path from "node:path";
import { truncateEnd } from "../core/utils.js";
import { looksLikeMissingCommand } from "./shell.js";

/**
 * A tiny POSIX command interpreter, used when the machine's shell is cmd.exe
 * (or PowerShell) and the model asked for `ls`, `cat`, `mkdir -p` and friends.
 *
 * This is the "something alternative if it fails" part: when a command is not
 * recognised by the shell, we run the handful of simple commands ourselves in
 * Node instead of handing the model a dead end. Anything complex (pipes,
 * redirects, globs) is deliberately not handled — better an honest error than a
 * half-working imitation.
 */

export interface ShimResult {
  handled: boolean;
  output: string;
  exitCode: number;
}

const UNSUPPORTED = /(^|[^|])\||>>|>|<|\$\(|`|\*|\?|\bthen\b|\bfi\b|\bdo\b|\bdone\b/;

interface Token {
  value: string;
}

/** Split a command line into simple commands, honouring quotes. */
export function splitChain(command: string): string[] | undefined {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || (char === "&" && command[i + 1] === "&")) {
      parts.push(current.trim());
      current = "";
      if (char === "&") i++;
      continue;
    }
    current += char;
  }
  if (quote) return undefined;
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

function tokenize(part: string): Token[] | undefined {
  const tokens: Token[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const char of part) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push({ value: current });
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) return undefined;
  if (started) tokens.push({ value: current });
  return tokens;
}

const SUPPORTED = new Set([
  "pwd",
  "echo",
  "cat",
  "ls",
  "mkdir",
  "rmdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "head",
  "tail",
  "wc",
]);

function classify(command: string): { supported: boolean; first?: string } {
  const chain = splitChain(command);
  if (!chain || chain.length === 0) return { supported: false };
  for (const part of chain) {
    const tokens = tokenize(part);
    if (!tokens || tokens.length === 0) return { supported: false };
    if (!SUPPORTED.has(tokens[0]!.value)) return { supported: false, first: tokens[0]!.value };
    if (UNSUPPORTED.test(part)) return { supported: false, first: tokens[0]!.value };
  }
  return { supported: true, first: tokenize(chain[0]!)![0]!.value };
}

/** True when we know how to run this command without a real shell. */
export function canShim(command: string): boolean {
  return classify(command).supported;
}

/** The command name that made us give up, for the error message. */
export function unsupportedCommand(command: string): string | undefined {
  return classify(command).first;
}

export function runPosixShim(
  command: string,
  cwd: string,
  options: { maxOutputChars?: number } = {}
): ShimResult {
  const maxOutputChars = options.maxOutputChars ?? 20_000;
  const chain = splitChain(command);
  if (!chain || chain.length === 0) return { handled: false, output: "", exitCode: 1 };

  let output = "";
  for (const part of chain) {
    const result = runOne(part, cwd);
    if (result === undefined) return { handled: false, output, exitCode: 1 };
    output += result.output;
    if (result.exitCode !== 0) {
      return { handled: true, output: truncateEnd(output.trim(), maxOutputChars), exitCode: result.exitCode };
    }
  }
  return { handled: true, output: truncateEnd(output.trim() || "(no output)", maxOutputChars), exitCode: 0 };
}

function safeResolve(cwd: string, target: string): string {
  return path.resolve(cwd, target);
}

function stripFlags(args: string[], allowed: string): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1 && !arg.includes("/")) {
      for (const char of arg.slice(1)) if (allowed.includes(char)) flags.add(char);
    } else if (arg === "--") {
      continue;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function runOne(part: string, cwd: string): { output: string; exitCode: number } | undefined {
  const tokens = tokenize(part);
  if (!tokens || tokens.length === 0) return { output: "", exitCode: 0 };
  const [head, ...args] = tokens.map((token) => token.value);
  const command = head!.toLowerCase();

  try {
    switch (command) {
      case "pwd":
        return { output: `${cwd}\n`, exitCode: 0 };

      case "echo": {
        const newline = !args.includes("-n");
        const text = args.filter((arg) => arg !== "-n").join(" ");
        return { output: newline ? `${text}\n` : text, exitCode: 0 };
      }

      case "cat": {
        const files = args.filter((arg) => !arg.startsWith("-"));
        if (files.length === 0) return { output: "", exitCode: 1 };
        const parts = files.map((file) => fs.readFileSync(safeResolve(cwd, file), "utf8"));
        return { output: parts.join(""), exitCode: 0 };
      }

      case "ls": {
        const { flags, rest } = stripFlags(args, "la");
        const targets = rest.length > 0 ? rest : ["."];
        const lines: string[] = [];
        for (const target of targets) {
          const full = safeResolve(cwd, target);
          const stat = fs.statSync(full);
          if (!stat.isDirectory()) {
            lines.push(flags.has("l") ? longLine(target, stat) : target);
            continue;
          }
          const entries = fs.readdirSync(full, { withFileTypes: true });
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!flags.has("a") && entry.name.startsWith(".")) continue;
            if (flags.has("l")) {
              const entryStat = fs.statSync(path.join(full, entry.name));
              lines.push(longLine(entry.isDirectory() ? `${entry.name}/` : entry.name, entryStat));
            } else {
              lines.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
            }
          }
        }
        return { output: lines.length > 0 ? `${lines.join("\n")}\n` : "", exitCode: 0 };
      }

      case "mkdir": {
        const { flags, rest } = stripFlags(args, "p");
        if (rest.length === 0) return { output: "mkdir: missing operand\n", exitCode: 1 };
        for (const dir of rest) {
          const full = safeResolve(cwd, dir);
          if (fs.existsSync(full) && !flags.has("p")) {
            return { output: `mkdir: ${dir}: File exists\n`, exitCode: 1 };
          }
          fs.mkdirSync(full, { recursive: flags.has("p") });
        }
        return { output: "", exitCode: 0 };
      }

      case "rmdir":
      case "rm": {
        const { flags, rest } = stripFlags(args, "rRf");
        if (rest.length === 0) return { output: `rm: missing operand\n`, exitCode: 1 };
        for (const target of rest) {
          const full = safeResolve(cwd, target);
          if (!fs.existsSync(full)) {
            if (flags.has("f")) continue;
            return { output: `rm: ${target}: No such file or directory\n`, exitCode: 1 };
          }
          const recursive = command === "rmdir" || flags.has("r") || flags.has("R");
          fs.rmSync(full, { recursive, force: flags.has("f") });
        }
        return { output: "", exitCode: 0 };
      }

      case "cp":
      case "mv": {
        const { flags, rest } = stripFlags(args, "rR");
        if (rest.length < 2) return { output: `${command}: missing operand\n`, exitCode: 1 };
        const target = rest[rest.length - 1]!;
        for (const source of rest.slice(0, -1)) {
          const from = safeResolve(cwd, source);
          const to = safeResolve(cwd, target);
          const recursive = flags.has("r") || flags.has("R");
          if (fs.statSync(from).isDirectory() && !recursive) {
            return { output: `${command}: ${source} is a directory (use -r)\n`, exitCode: 1 };
          }
          if (command === "cp") fs.cpSync(from, to, { recursive });
          else fs.renameSync(from, to);
        }
        return { output: "", exitCode: 0 };
      }

      case "touch": {
        const now = new Date();
        for (const file of args.filter((arg) => !arg.startsWith("-"))) {
          const full = safeResolve(cwd, file);
          if (fs.existsSync(full)) fs.utimesSync(full, now, now);
          else {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, "");
          }
        }
        return { output: "", exitCode: 0 };
      }

      case "head":
      case "tail": {
        let count = 10;
        const files: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]!;
          if (arg === "-n") {
            count = Number(args[++i] ?? 10);
          } else if (/^-\d+$/.test(arg)) {
            count = Number(arg.slice(1));
          } else if (!arg.startsWith("-")) {
            files.push(arg);
          }
        }
        const text = files.length > 0 ? files.map((file) => fs.readFileSync(safeResolve(cwd, file), "utf8")).join("") : "";
        const lines = text.split(/\r?\n/);
        if (lines[lines.length - 1] === "") lines.pop();
        const slice = command === "head" ? lines.slice(0, count) : lines.slice(-count);
        return { output: `${slice.join("\n")}\n`, exitCode: 0 };
      }

      case "wc": {
        const files = args.filter((arg) => !arg.startsWith("-"));
        const text = files.length > 0 ? files.map((file) => fs.readFileSync(safeResolve(cwd, file), "utf8")).join("") : "";
        const lines = text === "" ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
        return { output: `${String(lines).padStart(8)}\n`, exitCode: 0 };
      }

      default:
        return undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: `${command}: ${message}\n`, exitCode: 1 };
  }
}

export function longLine(name: string, stat: fs.Stats): string {
  const type = stat.isDirectory() ? "d" : "-";
  return `${type}${String(stat.size).padStart(8)}  ${name}`;
}

/** Message shown when neither the shell nor the shim could run the command. */
export function fallbackHint(command: string, shellLabel: string): string {
  const name = command.trim().split(/\s+/)[0] ?? command;
  return (
    `'${name}' is not available in ${shellLabel} and is not one of the built-in shims. ` +
    "Use the dedicated tools instead (list_dir, glob, grep, read_file, write_file, replace_in_file, " +
    "move_file, copy_file, delete_file, make_dir, append_file), or use " +
    (shellLabel === "cmd.exe"
      ? "Windows syntax (dir, type, copy, del, mkdir) or PowerShell (Get-ChildItem, Get-Content)."
      : "syntax this shell understands.") +
    " Installing Git Bash makes Unix commands work."
  );
}

export { looksLikeMissingCommand };
