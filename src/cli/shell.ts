import fs from "node:fs";
import path from "node:path";

/**
 * Shell resolution.
 *
 * The agent used to hard-code `cmd.exe` on Windows, so every Unix-style command
 * (`ls`, `grep`, `cat`, `&&` chains) failed with "is not recognized". We now pick
 * the best shell that actually exists on the machine, preferring bash (Git Bash,
 * WSL, MSYS) over PowerShell and keeping cmd.exe as the last resort.
 */

export type ShellKind = "bash" | "sh" | "powershell" | "cmd";

export interface ShellChoice {
  kind: ShellKind;
  /** Executable to spawn. */
  file: string;
  /** Prefix arguments; the command itself goes last. */
  prefix: string[];
  /** Human-readable name shown in errors. */
  label: string;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}

/** Argument prefix per shell kind. */
export function shellPrefix(kind: ShellKind): string[] {
  switch (kind) {
    case "powershell":
      return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
    case "cmd":
      return ["/d", "/s", "/c"];
    case "bash":
      // No login shell: `-l` pulls in profile scripts that slow startup and can
      // print banners into the captured output.
      return ["-c"];
    default:
      return ["-c"];
  }
}

export function shellChoice(kind: ShellKind, file: string, label?: string): ShellChoice {
  return { kind, file, prefix: shellPrefix(kind), label: label ?? labelFor(kind) };
}

function labelFor(kind: ShellKind): string {
  switch (kind) {
    case "bash":
      return "bash";
    case "powershell":
      return "PowerShell";
    case "cmd":
      return "cmd.exe";
    default:
      return "sh";
  }
}

/** Find an executable on PATH (plus `.exe` on Windows). */
export function which(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists?: (f: string) => boolean,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const check = exists ?? ((file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

  const isWindows = platform === "win32" || env.OS === "Windows_NT";
  const names = isWindows && !/\.(exe|cmd|bat)$/i.test(name) ? [`${name}.exe`, name] : [name];
  const joiner = isWindows ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(isWindows ? ";" : path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const candidate of names) {
      const full = joiner.join(dir, candidate);
      if (check(full)) return full;
    }
  }
  return undefined;
}

const WINDOWS_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Windows\\System32\\bash.exe", // WSL
];

/**
 * Resolve the shell to use. `AGENT_SHELL` (or `WEB_SHELL`) can force one:
 * `bash`, `powershell`, `pwsh`, `cmd`, `sh`.
 */
export function detectShell(options: DetectOptions = {}): ShellChoice {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((file: string) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });

  const forced = (env.AGENT_SHELL ?? env.WEB_SHELL ?? "").trim().toLowerCase();
  if (forced) {
    const hit = shellForcedName(forced, platform, env, exists);
    if (hit) return hit;
  }

  if (platform !== "win32") {
    const preferred = env.SHELL?.trim();
    if (preferred && /(^|\/)(bash|zsh|sh)$/.test(preferred) && exists(preferred)) {
      return shellChoice(path.basename(preferred) === "bash" ? "bash" : "sh", preferred);
    }
    if (exists("/bin/bash")) return shellChoice("bash", "/bin/bash");
    return shellChoice("sh", "/bin/sh");
  }

  // Windows: a real bash is by far the best experience for the model.
  for (const candidate of WINDOWS_BASH_PATHS) {
    if (exists(candidate)) return shellChoice("bash", candidate, "Git Bash");
  }
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const gitBash = path.win32.join(programFiles, "Git", "bin", "bash.exe");
  if (exists(gitBash)) return shellChoice("bash", gitBash, "Git Bash");

  const bashOnPath = which("bash", env, exists, platform);
  if (bashOnPath) return shellChoice("bash", bashOnPath, "bash (PATH)");

  const pwsh = which("pwsh", env, exists, platform);
  if (pwsh) return shellChoice("powershell", pwsh, "PowerShell 7");

  // MSI installs normally add pwsh to PATH, but a portable copy may not be there.
  const pwshInstall = path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (exists(pwshInstall)) return shellChoice("powershell", pwshInstall, "PowerShell 7");

  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const legacy = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (exists(legacy)) return shellChoice("powershell", legacy, "Windows PowerShell");

  return shellChoice("cmd", env.ComSpec ?? env.COMSPEC ?? "cmd.exe");
}

function shellForcedName(
  forced: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean
): ShellChoice | undefined {
  if (forced === "cmd") {
    return shellChoice("cmd", env.ComSpec ?? env.COMSPEC ?? "cmd.exe");
  }
  if (forced === "powershell" || forced === "pwsh") {
    const hit =
      which("pwsh", env, exists, platform) ?? which("powershell", env, exists, platform);
    if (hit) return shellChoice("powershell", hit);
    if (platform === "win32") {
      const legacy = path.win32.join(
        env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      if (exists(legacy)) return shellChoice("powershell", legacy);
    }
    return undefined;
  }
  if (forced === "sh") {
    return shellChoice("sh", env.SHELL ?? "/bin/sh");
  }
  if (forced === "bash") {
    if (platform !== "win32") return shellChoice("bash", exists("/bin/bash") ? "/bin/bash" : "/bin/sh");
    for (const candidate of WINDOWS_BASH_PATHS) {
      if (exists(candidate)) return shellChoice("bash", candidate, "Git Bash");
    }
    const onPath = which("bash", env, exists, platform);
    return onPath ? shellChoice("bash", onPath, "bash (PATH)") : undefined;
  }
  return undefined;
}

/** Every shell that exists here, in preference order; used for retries. */
export function shellFallbacks(options: DetectOptions = {}): ShellChoice[] {
  const primary = detectShell(options);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const out: ShellChoice[] = [primary];

  const add = (choice: ShellChoice | undefined) => {
    if (choice && !out.some((existing) => existing.file === choice.file)) out.push(choice);
  };

  if (platform === "win32") {
    const pwsh = which("pwsh", env, undefined, platform) ?? which("powershell", env, undefined, platform);
    if (pwsh) add(shellChoice("powershell", pwsh));
    add(shellChoice("cmd", env.ComSpec ?? env.COMSPEC ?? "cmd.exe"));
  } else if (primary.kind !== "sh") {
    add(shellChoice("sh", "/bin/sh"));
  }
  return out;
}

/** True when a shell reported a missing command rather than a real failure. */
export function looksLikeMissingCommand(output: string): boolean {
  return /is not recognized as an internal or external command|command not found|The term '[^']*' is not recognized|不是内部或外部命令|cannot find the path/i.test(
    output
  );
}
