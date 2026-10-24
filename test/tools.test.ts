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
