import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildContinuationPrompt } from "../src/core/prompt.js";
import { contextStats, recordTrim, resetContextStats } from "../src/core/context-stats.js";
import { contextTokensFor } from "../src/cli/setup-support.js";
import type { ChatMessage } from "../src/core/types.js";

afterEach(() => resetContextStats());

const bigHistory = (chars: number): ChatMessage[] => [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: "x".repeat(chars) },
];

describe("prompt budget", () => {
  it("reports how much was dropped instead of hiding it", () => {
    let seen: { dropped: number; max: number } | undefined;
    const prompt = buildPrompt(bigHistory(50_000), {
      maxChars: 10_000,
      onTrim: (info) => {
        seen = info;
      },
    });

    assert.ok(seen, "the trim must be reported");
    assert.equal(seen!.max, 10_000);
    assert.ok(seen!.dropped > 40_000);
    assert.ok(prompt.length <= 10_100, "prompt stays within the budget");
    assert.match(prompt, /characters omitted/);
  });

  it("stays quiet when the request fits", () => {
    let called = false;
    const prompt = buildPrompt([{ role: "user", content: "hello" }], {
      maxChars: 10_000,
      onTrim: () => {
        called = true;
      },
    });
    assert.equal(called, false);
    assert.match(prompt, /hello/);
  });

  it("reports trimming on continuation turns too", () => {
    let dropped = 0;
    buildContinuationPrompt(bigHistory(40_000), {
      maxChars: 5_000,
      onTrim: (info) => {
        dropped = info.dropped;
      },
    });
    assert.ok(dropped > 0);
  });
});

describe("context stats", () => {
  it("counts trims and the characters lost", () => {
    recordTrim(1_000);
    recordTrim(2_500);
    const stats = contextStats(120_000);
    assert.equal(stats.trimmed, 2);
    assert.equal(stats.droppedChars, 3_500);
    assert.ok(stats.lastTrimAt);
    assert.equal(stats.budgetChars, 120_000);
  });

  it("resets between runs", () => {
    recordTrim(10);
    resetContextStats();
    assert.equal(contextStats(1).trimmed, 0);
  });
});

describe("declared context window", () => {
  it("is derived from, and smaller than, the real character budget", () => {
    const tokens = contextTokensFor(120_000);
    assert.equal(tokens, 27_000);
    assert.ok(tokens * 4 < 120_000, "opencode must compact before the bridge trims");
  });

  it("falls back safely on nonsense input", () => {
    assert.equal(contextTokensFor(0), 27_000);
    assert.equal(contextTokensFor(Number.NaN), 27_000);
    assert.ok(contextTokensFor(1_000) >= 2_000);
  });
});
