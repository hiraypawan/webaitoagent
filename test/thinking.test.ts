import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REASONING_SELECTORS,
  cleanAnswer,
  parseSelectors,
  stripThinkingPreamble,
} from "../src/core/thinking.js";

describe("reasoning in the captured text", () => {
  it("drops an English 'Thinking...' preamble", () => {
    const text = [
      "Thinking...",
      "",
      "The user said hi. There has been some noise in the history. Keep it simple.",
      "",
      "Hello! What would you like to work on?",
    ].join("\n");
    assert.equal(cleanAnswer(text), "Hello! What would you like to work on?");
  });

  it("drops a Chinese reasoning preamble", () => {
    const text = "思考中\n\n用户询问项目结构，先看看目录。\n\n这是一个 Node 项目。";
    assert.equal(cleanAnswer(text), "这是一个 Node 项目。");
  });

  it("keeps ordinary answers untouched", () => {
    const text = "Here is the summary of the project.\n\nIt is a Node app.";
    assert.equal(cleanAnswer(text), text);
  });

  it("never returns an empty answer", () => {
    // Only reasoning, nothing else: better to show it than to answer nothing.
    const text = "Thinking...\n\nI should ask a clarifying question.";
    assert.equal(stripThinkingPreamble(text), text);
  });

  it("is not fooled by the word thinking mid-sentence", () => {
    const text = "I am thinking about the design.\n\nTwo options exist.";
    assert.equal(stripThinkingPreamble(text), text);
  });
});

describe("selector configuration", () => {
  it("ships defaults that look like real UIs", () => {
    assert.ok(DEFAULT_REASONING_SELECTORS.length >= 4);
    assert.ok(DEFAULT_REASONING_SELECTORS.some((selector) => /think/i.test(selector)));
  });

  it("parses the environment override", () => {
    assert.deepEqual(parseSelectors(".thought, [data-cot]"), [".thought", "[data-cot]"]);
    assert.equal(parseSelectors(undefined), undefined);
    assert.equal(parseSelectors("  "), undefined);
  });
});
