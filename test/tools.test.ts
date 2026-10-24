import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRunner } from "../src/cli/tools.js";

let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wat-tools-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runner(overrides: Partial<Parameters<typeof createToolRunner>[0]> = {}) {
  return createToolRunner({ root, autoApprove: true, confirm: async () => true, ...overrides });
}

describe("tool runner", () => {
  it("writes, reads and lists files", async () => {
    const tools = runner();
    assert.match(await tools.execute("write_file", { path: "sub/a.txt", content: "one\ntwo\nthree" }), /Wrote/);

    const read = await tools.execute("read_file", { path: "sub/a.txt", offset: 2, limit: 1 });
    assert.match(read, /two/);
    assert.doesNotMatch(read, /three/);

    const listed = await tools.execute("list_dir", { path: "sub" });
    assert.match(listed, /\[file\] a\.txt/);
  });

  it("replaces a unique occurrence only", async () => {
    const tools = runner();
    await tools.execute("write_file", { path: "b.txt", content: "alpha beta gamma" });

    assert.match(await tools.execute("replace_in_file", { path: "b.txt", old: "beta", new: "BETA" }), /Updated/);
    assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "alpha BETA gamma");

    const missing = await tools.execute("replace_in_file", { path: "b.txt", old: "nope", new: "x" });
    assert.match(missing, /not found/);

    await tools.execute("write_file", { path: "c.txt", content: "aa aa" });
    const ambiguous = await tools.execute("replace_in_file", { path: "c.txt", old: "aa", new: "b" });
    assert.match(ambiguous, /appears 2 times/);
  });

  it("refuses paths outside the workspace", async () => {
    const tools = runner();
    const result = await tools.execute("read_file", { path: "../../etc/passwd" });
    assert.match(result, /outside the workspace/);
  });

  it("allows outside paths only when explicitly enabled", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wat-outside-"));
    const file = path.join(outside, "note.txt");
    fs.writeFileSync(file, "outside content");

    const blocked = await runner().execute("read_file", { path: file });
    assert.match(blocked, /outside the workspace/);

    const allowed = await runner({ allowOutside: true }).execute("read_file", { path: file });
    assert.match(allowed, /outside content/);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("enforces the confirmation callback", async () => {
    const tools = runner({ autoApprove: false, confirm: async () => false });
    const result = await tools.execute("write_file", { path: "denied.txt", content: "x" });
    assert.match(result, /user denied/);
    assert.equal(fs.existsSync(path.join(root, "denied.txt")), false);
  });

  it("reports unknown tools and bad input", async () => {
    const tools = runner();
    assert.match(await tools.execute("nope", {}), /Unknown tool/);
    assert.match(await tools.execute("read_file", { path: "missing.txt" }), /ENOENT|no such file/i);
    assert.match(await tools.execute("write_file", { path: "x.txt" }), /content.*string|Wrote/);
  });

  it("runs shell commands in the workspace root", async () => {
    const tools = runner();
    const result = await tools.execute("bash", { command: "echo hello-from-shell" });
    assert.match(result, /hello-from-shell/);
  });

  it("rejects a shell command when approval is denied", async () => {
    const tools = runner({ autoApprove: false, confirm: async () => false });
    assert.match(await tools.execute("bash", { command: "echo nope" }), /user denied/);
  });
});

describe("shell handling", () => {
  it("runs a command through an explicitly requested shell", async () => {
    const tools = runner();
    const out = await tools.execute("bash", { command: "echo hello", shell: "sh" });
    assert.match(out, /hello/);
  });

  it("falls back to a working shell when the requested one cannot start", async () => {
    const tools = runner();
    // cmd.exe does not exist on Linux/macOS: this must recover, not fail.
    const out = await tools.execute("bash", { command: "echo recovered", shell: "cmd" });
    assert.match(out, /recovered/);
  });

  it("respects cwd", async () => {
    const tools = runner();
    await tools.execute("make_dir", { path: "sub/dir" });
    const out = await tools.execute("bash", { command: "pwd", cwd: "sub/dir" });
    assert.match(out, /sub[/\\]dir/);
  });

  it("rejects an unknown shell name", async () => {
    const tools = runner();
    const out = await tools.execute("bash", { command: "echo hi", shell: "fish" });
    assert.match(out, /unknown shell/);
  });
});

describe("filesystem tools", () => {
  it("glob finds files by pattern", async () => {
    const tools = runner();
    await tools.execute("write_file", { path: "src/deep/one.ts", content: "x" });
    await tools.execute("write_file", { path: "src/two.js", content: "x" });
    const ts = await tools.execute("glob", { pattern: "**/*.ts" });
    assert.match(ts, /src\/deep\/one\.ts/);
    assert.doesNotMatch(ts, /two\.js/);
    assert.match(await tools.execute("glob", { pattern: "**/*.ts", path: "src/deep" }), /one\.ts/);
  });

  it("grep searches contents with a regex and a file filter", async () => {
    const tools = runner();
    await tools.execute("write_file", { path: "src/a.ts", content: "const answer = 42;\n" });
    await tools.execute("write_file", { path: "src/b.md", content: "answer: forty two\n" });

    const hits = await tools.execute("grep", { pattern: "answer\\s*=", path: "src" });
    assert.match(hits, /src\/a\.ts:1/);
    assert.doesNotMatch(hits, /b\.md/);

    const filtered = await tools.execute("grep", { pattern: "answer", path: "src", include: "*.md" });
    assert.match(filtered, /b\.md/);
    assert.doesNotMatch(filtered, /a\.ts/);

    const insensitive = await tools.execute("grep", { pattern: "ANSWER", path: "src", ignore_case: true });
    assert.match(insensitive, /a\.ts/);

    assert.match(await tools.execute("grep", { pattern: "nothing-here", path: "src" }), /No matches/);
  });

  it("moves, copies, appends, deletes and makes directories", async () => {
    const tools = runner();
    await tools.execute("write_file", { path: "work/original.txt", content: "first" });
    assert.match(await tools.execute("append_file", { path: "work/original.txt", content: "-second" }), /Appended/);
    assert.match(fs.readFileSync(path.join(root, "work/original.txt"), "utf8"), /first-second/);

    assert.match(await tools.execute("copy_file", { from: "work/original.txt", to: "work/copy.txt" }), /Copied/);
    assert.ok(fs.existsSync(path.join(root, "work/copy.txt")));

    assert.match(await tools.execute("move_file", { from: "work/copy.txt", to: "work/moved/copy.txt" }), /Moved/);
    assert.ok(fs.existsSync(path.join(root, "work/moved/copy.txt")));

    assert.match(await tools.execute("delete_file", { path: "work/moved" }), /Deleted/);
    assert.ok(!fs.existsSync(path.join(root, "work/moved")));

    assert.match(await tools.execute("make_dir", { path: "fresh/nested" }), /Created/);
    assert.ok(fs.existsSync(path.join(root, "fresh/nested")));
  });

  it("refuses to delete the workspace root", async () => {
    const tools = runner();
    const out = await tools.execute("delete_file", { path: "." });
    assert.match(out, /refusing to delete the workspace root/);
  });

  it("lists all available tools to the model", async () => {
    const tools = runner();
    const unknown = await tools.execute("nope", {});
    for (const name of [
      "bash",
      "glob",
      "grep",
      "read_file",
      "write_file",
      "replace_in_file",
      "list_dir",
      "move_file",
      "copy_file",
      "delete_file",
      "make_dir",
      "append_file",
    ]) {
      assert.match(unknown, new RegExp(name));
      assert.ok(tools.definitions.some((tool) => tool.name === name), name);
    }
  });
});

describe("windows cmd fallback (simulated)", () => {
  it("interprets `ls` itself when cmd.exe rejects it", async () => {
    const fakeCmd = path.join(root, "fake-cmd.sh");
    fs.writeFileSync(
      fakeCmd,
      '#!/bin/sh\necho "\'ls\' is not recognized as an internal or external command" >&2\nexit 1\n',
      { mode: 0o755 }
    );
    const saved = process.env.AGENT_SHELL;
    const savedComSpec = process.env.ComSpec;
    process.env.AGENT_SHELL = "cmd";
    process.env.ComSpec = fakeCmd;
    try {
      const tools = runner();
      await tools.execute("make_dir", { path: "win-sim" });
      const out = await tools.execute("bash", { command: "ls" });
      assert.match(out, /win-sim/, "the built-in interpreter listed the directory");
      assert.match(out, /built-in equivalent used/, "and the model is told why");
    } finally {
      if (saved === undefined) delete process.env.AGENT_SHELL;
      else process.env.AGENT_SHELL = saved;
      if (savedComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = savedComSpec;
      fs.rmSync(fakeCmd, { force: true });
    }
  });
});
