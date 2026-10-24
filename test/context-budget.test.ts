import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextBudget } from "../src/core/context-budget.js";
import { buildOpencodeConfig, writeOpencodeConfig } from "../src/cli/setup-support.js";
import { knownOpencodeConfigs, registerOpencodeConfig } from "../src/core/opencode-configs.js";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wat-budget-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const stateFile = () => path.join(dir, `state-${Math.random().toString(36).slice(2)}.json`);

describe("automatic budget growth", () => {
  it("grows on a trim instead of asking the user to edit .env", () => {
    const budget = new ContextBudget({ configuredChars: 120_000, stateFile: stateFile() });
    assert.equal(budget.chars(), 120_000);

    const growth = budget.onTrim(50_000);
    assert.equal(growth.grown, true);
    assert.equal(growth.from, 120_000);
    assert.ok(budget.chars() > 120_000);
    assert.equal(budget.status().growthSteps, 1);
  });

  it("never exceeds the ceiling", () => {
    const budget = new ContextBudget({
      configuredChars: 100_000,
      ceilingChars: 140_000,
      stateFile: stateFile(),
    });
    for (let i = 0; i < 20; i++) {
      budget.onTrim(1_000);
      budget.onSuccess(); // the larger size worked, so growth may continue
    }
    assert.ok(budget.chars() <= 140_000);
    assert.equal(budget.status().ceilingChars, 140_000);
  });

  it("stops growing when the site keeps rejecting the larger size", () => {
    const budget = new ContextBudget({ configuredChars: 100_000, stateFile: stateFile() });
    assert.equal(budget.onTrim(1_000).grown, true);
    // Trimming again at the new size means the growth did not help: stop.
    assert.equal(budget.onTrim(1_000).grown, false);
    assert.equal(budget.onTrim(1_000).grown, false);
    assert.equal(budget.status().growthSteps, 1);
  });

  it("resets the counter after a successful request at the new size", () => {
    const budget = new ContextBudget({ configuredChars: 100_000, stateFile: stateFile() });
    budget.onTrim(1_000);
    const grown = budget.chars();
    budget.onSuccess();
    assert.equal(budget.status().trimsAtSize, 0);
    assert.equal(budget.chars(), grown, "success does not shrink the budget");
  });

  it("remembers the learned size across restarts", () => {
    const file = stateFile();
    const first = new ContextBudget({ configuredChars: 120_000, stateFile: file });
    first.onTrim(10_000);
    const learned = first.chars();

    const second = new ContextBudget({ configuredChars: 120_000, stateFile: file });
    assert.equal(second.chars(), learned);
    assert.equal(second.status().growthSteps, 1);
  });

  it("a raised MAX_PROMPT_CHARS wins over the learned value", () => {
    const file = stateFile();
    const first = new ContextBudget({ configuredChars: 100_000, stateFile: file });
    first.onTrim(1_000);

    const second = new ContextBudget({ configuredChars: 500_000, ceilingChars: 600_000, stateFile: file });
    assert.equal(second.chars(), 500_000);
  });

  it("persists the file with owner-only permissions", () => {
    const file = stateFile();
    new ContextBudget({ configuredChars: 100_000, stateFile: file }).onTrim(1_000);
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe("keeping opencode.json in sync", () => {
  it("rewrites limit.context in the configs it generated", () => {
    const project = path.join(dir, "sync-project");
    const written = writeOpencodeConfig(
      project,
      buildOpencodeConfig("http://127.0.0.1:8787", "key", { maxPromptChars: 120_000 })
    );
    assert.equal(written.written, true);

    const dataRoot = path.join(dir, "data");
    registerOpencodeConfig(written.path, dataRoot);
    assert.deepEqual(knownOpencodeConfigs(dataRoot), [written.path]);

    const budget = new ContextBudget({
      configuredChars: 120_000,
      stateFile: path.join(dataRoot, "context-budget.json"),
      configPaths: () => knownOpencodeConfigs(dataRoot),
    });
    const growth = budget.onTrim(90_000);

    assert.deepEqual(growth.updatedConfigs, [written.path]);
    const config = JSON.parse(fs.readFileSync(written.path, "utf8"));
    const limit = config.provider["web-agents-to"].models["mimo-v2.6-pro"].limit.context;
    assert.equal(limit, Math.floor((budget.chars() * 0.9) / 4));
    assert.ok(limit > 27_000, "the client is told about the bigger window");
  });

  it("leaves configs it did not write alone", () => {
    const foreign = path.join(dir, "foreign", "opencode.json");
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, JSON.stringify({ provider: { other: {} } }, null, 2));

    const dataRoot = path.join(dir, "data-foreign");
    registerOpencodeConfig(foreign, dataRoot);
    const budget = new ContextBudget({
      configuredChars: 100_000,
      stateFile: path.join(dataRoot, "context-budget.json"),
      configPaths: () => knownOpencodeConfigs(dataRoot),
    });
    const growth = budget.onTrim(5_000);
    assert.deepEqual(growth.updatedConfigs, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(foreign, "utf8")), { provider: { other: {} } });
  });

  it("survives a config that was deleted or corrupted", () => {
    const dataRoot = path.join(dir, "data-broken");
    const broken = path.join(dir, "broken", "opencode.json");
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, "{not json");
    registerOpencodeConfig(broken, dataRoot);
    registerOpencodeConfig(path.join(dir, "gone", "opencode.json"), dataRoot);

    const budget = new ContextBudget({
      configuredChars: 100_000,
      stateFile: path.join(dataRoot, "context-budget.json"),
      configPaths: () => knownOpencodeConfigs(dataRoot),
    });
    assert.doesNotThrow(() => budget.onTrim(1_000));
    assert.deepEqual(budget.status().growthSteps, 1);
  });
});
