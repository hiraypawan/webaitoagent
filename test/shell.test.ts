import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectShell,
  looksLikeMissingCommand,
  shellFallbacks,
  shellPrefix,
  which,
} from "../src/cli/shell.js";

const win = (existing: string[], env: NodeJS.ProcessEnv = {}) => ({
  platform: "win32" as const,
  env: { PATH: "", ...env },
  exists: (file: string) => existing.includes(file),
});

describe("shell detection on Windows", () => {
  it("prefers Git Bash when it is installed", () => {
    const choice = detectShell(win(["C:\\Program Files\\Git\\bin\\bash.exe"]));
    assert.equal(choice.kind, "bash");
    assert.equal(choice.label, "Git Bash");
    assert.deepEqual(choice.prefix, ["-c"]);
  });

  it("uses PowerShell 7 next", () => {
    const choice = detectShell(win(["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]));
    assert.equal(choice.kind, "powershell");
    assert.equal(choice.label, "PowerShell 7");
    assert.deepEqual(choice.prefix, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("falls back to Windows PowerShell", () => {
    const choice = detectShell(
      win(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"])
    );
    assert.equal(choice.kind, "powershell");
    assert.equal(choice.label, "Windows PowerShell");
  });

  it("uses cmd.exe only as a last resort", () => {
    const choice = detectShell(win([], { ComSpec: "C:\\Windows\\system32\\cmd.exe" }));
    assert.equal(choice.kind, "cmd");
    assert.equal(choice.file, "C:\\Windows\\system32\\cmd.exe");
    assert.deepEqual(choice.prefix, ["/d", "/s", "/c"]);
  });

  it("honours AGENT_SHELL over detection", () => {
    const choice = detectShell(
      win(["C:\\Program Files\\Git\\bin\\bash.exe"], { AGENT_SHELL: "cmd", ComSpec: "cmd.exe" })
    );
    assert.equal(choice.kind, "cmd");
  });

  it("ignores an unavailable forced shell", () => {
    const choice = detectShell(win(["C:\\Program Files\\Git\\bin\\bash.exe"], { AGENT_SHELL: "pwsh" }));
    assert.equal(choice.kind, "bash", "still works instead of failing");
  });
});

describe("shell detection elsewhere", () => {
  it("uses the user's SHELL", () => {
    const choice = detectShell({
      platform: "linux",
      env: { SHELL: "/bin/zsh" },
      exists: (file: string) => file === "/bin/zsh",
    });
    assert.equal(choice.kind, "sh");
    assert.equal(choice.file, "/bin/zsh");
  });

  it("defaults to /bin/sh when nothing is known", () => {
    const choice = detectShell({ platform: "linux", env: {}, exists: () => false });
    assert.equal(choice.file, "/bin/sh");
    assert.deepEqual(choice.prefix, ["-c"]);
  });
});

describe("fallback order", () => {
  it("offers the other Windows shells in preference order", () => {
    const labels = shellFallbacks(win(["C:\\Program Files\\Git\\bin\\bash.exe"], { ComSpec: "cmd.exe" })).map(
      (shell) => shell.kind
    );
    assert.equal(labels[0], "bash");
    assert.ok(labels.includes("cmd"));
  });
});

describe("missing-command detection", () => {
  it("recognises cmd.exe, PowerShell, POSIX and Chinese messages", () => {
    assert.ok(looksLikeMissingCommand("'ls' is not recognized as an internal or external command"));
    assert.ok(looksLikeMissingCommand("The term 'grep' is not recognized as the name of a cmdlet"));
    assert.ok(looksLikeMissingCommand("sh: 1: ls: command not found"));
    assert.ok(looksLikeMissingCommand("'ls' 不是内部或外部命令，也不是可运行的程序"));
  });

  it("does not treat a real failure as a missing command", () => {
    assert.equal(looksLikeMissingCommand("Error: 3 tests failed"), false);
    assert.equal(looksLikeMissingCommand(""), false);
  });
});

describe("which", () => {
  it("finds executables on PATH", () => {
    const env = { PATH: ["/usr/bin", "/opt/bin"].join(":") };
    const found = which("node", env, (file) => file === "/opt/bin/node");
    assert.equal(found, "/opt/bin/node");
  });

  it("returns undefined when absent", () => {
    assert.equal(which("nope", { PATH: "/usr/bin" }, () => false), undefined);
  });
});

describe("shell prefixes", () => {
  it("keeps each shell's own syntax", () => {
    assert.deepEqual(shellPrefix("cmd"), ["/d", "/s", "/c"]);
    assert.deepEqual(shellPrefix("sh"), ["-c"]);
    assert.deepEqual(shellPrefix("bash"), ["-c"]);
  });
});
