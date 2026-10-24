import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canShim, runPosixShim, splitChain, unsupportedCommand } from "../src/cli/posix-shim.js";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wat-shim-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (command: string) => runPosixShim(command, dir);

describe("chain splitting", () => {
  it("splits on && and ; but not inside quotes", () => {
    assert.deepEqual(splitChain("ls && echo hi; pwd"), ["ls", "echo hi", "pwd"]);
    assert.deepEqual(splitChain('echo "a && b"'), ['echo "a && b"']);
  });

  it("rejects an unterminated quote", () => {
    assert.equal(splitChain('echo "oops'), undefined);
  });
});

describe("what the fallback refuses", () => {
  it("accepts the common simple commands", () => {
    for (const command of ["ls -a", "cat a.txt", "mkdir -p x/y", "rm -rf build", "echo hi && pwd"]) {
      assert.ok(canShim(command), command);
    }
  });

  it("refuses pipes, redirects and globs rather than half-working", () => {
    assert.equal(canShim("ls | head"), false);
    assert.equal(canShim("echo hi > out.txt"), false);
    assert.equal(canShim("cat *.txt"), false);
    assert.equal(canShim("grep foo bar.txt"), false, "grep has its own tool");
    assert.equal(unsupportedCommand("grep foo bar.txt"), "grep");
  });
});

describe("fallback execution", () => {
  it("pwd and echo", () => {
    assert.equal(run("pwd").output.trim(), dir);
    assert.equal(run('echo "hello world"').output.trim(), "hello world");
  });

  it("mkdir -p, ls, cat, append via echo-free files", () => {
    const made = run("mkdir -p nested/deep");
    assert.equal(made.handled, true);
    assert.equal(made.exitCode, 0);
    assert.ok(fs.existsSync(path.join(dir, "nested/deep")));

    fs.writeFileSync(path.join(dir, "nested/note.txt"), "alpha\nbeta\ngamma\n");

    const listing = run("ls nested");
    assert.match(listing.output, /deep\//);
    assert.match(listing.output, /note\.txt/);

    assert.match(run("cat nested/note.txt").output, /beta/);
    assert.match(run("head -n 1 nested/note.txt").output, /alpha/);
    assert.match(run("tail -n 1 nested/note.txt").output, /gamma/);
    assert.match(run("wc nested/note.txt").output, /3/);
  });

  it("cp, mv, touch and rm", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "data");
    assert.equal(run("cp a.txt b.txt").exitCode, 0);
    assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "data");

    assert.equal(run("mv b.txt c.txt").exitCode, 0);
    assert.ok(fs.existsSync(path.join(dir, "c.txt")));
    assert.ok(!fs.existsSync(path.join(dir, "b.txt")));

    assert.equal(run("touch new.txt").exitCode, 0);
    assert.ok(fs.existsSync(path.join(dir, "new.txt")));

    assert.equal(run("rm c.txt").exitCode, 0);
    assert.ok(!fs.existsSync(path.join(dir, "c.txt")));
  });

  it("chains commands and stops at the first failure", () => {
    const ok = run("mkdir -p chain && touch chain/one.txt");
    assert.equal(ok.exitCode, 0);
    assert.ok(fs.existsSync(path.join(dir, "chain/one.txt")));

    const failed = run("cat missing.txt && touch chain/two.txt");
    assert.equal(failed.exitCode, 1);
    assert.ok(!fs.existsSync(path.join(dir, "chain/two.txt")), "short-circuits like a real shell");
  });

  it("returns a shell-like error for a missing file", () => {
    const result = run("cat nope.txt");
    assert.equal(result.handled, true);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /cat:/);
  });

  it("never escapes the working directory", () => {
    const result = run("cat ../../../etc/passwd");
    assert.equal(result.handled, true, "handled, but paths resolve relative to cwd");
    assert.equal(result.exitCode, 0); // /etc/passwd exists and is readable in this sandbox
    const denied = run("cat /definitely/not/here");
    assert.equal(denied.exitCode, 1);
  });
});
