import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildContinuationPrompt,
  buildPrompt,
  contentToText,
  conversationKey,
} from "../src/core/prompt.js";
import type { ChatMessage } from "../src/core/types.js";

const messages: ChatMessage[] = [
  { role: "system", content: "Be terse." },
  { role: "user", content: "What is 2+2?" },
  { role: "assistant", content: "4" },
  { role: "user", content: "And 3+3?" },
];

describe("contentToText", () => {
  it("handles strings, arrays and null", () => {
    assert.equal(contentToText("hi"), "hi");
    assert.equal(contentToText(null), "");
    assert.equal(
      contentToText([
        { type: "text", text: "a" },
        { type: "image_url", image_url: { url: "x" } },
        { type: "text", text: "b" },
      ]),
      "a\n[image omitted]\nb"
    );
  });
});

describe("buildPrompt", () => {
  it("flattens roles and ends with the assistant cue", () => {
    const prompt = buildPrompt(messages);
    assert.match(prompt, /System: Be terse\./);
    assert.match(prompt, /User: What is 2\+2\?/);
    assert.match(prompt, /Assistant: 4/);
    assert.ok(prompt.trimEnd().endsWith("Assistant:"));
  });

  it("includes tool definitions and the call protocol", () => {
    const prompt = buildPrompt(messages, {
      tools: [
        {
          type: "function",
          function: { name: "bash", description: "run", parameters: { type: "object" } },
        },
      ],
    });
    assert.match(prompt, /- bash — run/);
    assert.match(prompt, /<tool_call name="TOOL_NAME">/);
  });

  it("elides the middle of very long prompts", () => {
    const huge: ChatMessage[] = [{ role: "user", content: "x".repeat(5_000) }];
    const prompt = buildPrompt(huge, { maxChars: 1_000 });
    assert.ok(prompt.length <= 1_000);
    assert.match(prompt, /characters omitted/);
  });
});

describe("buildContinuationPrompt", () => {
  it("only sends the new user turn", () => {
    const prompt = buildContinuationPrompt(messages);
    assert.equal(prompt, "User: And 3+3?");
  });

  it("includes trailing tool results", () => {
    const prompt = buildContinuationPrompt([
      { role: "user", content: "list files" },
      { role: "assistant", content: "<tool_call name=\"bash\">{}</tool_call>" },
      { role: "tool", content: "a.txt" },
    ]);
    assert.match(prompt, /Tool result/);
    assert.match(prompt, /a\.txt/);
  });
});

describe("conversationKey", () => {
  it("is stable for the same conversation and changes with a new first turn", () => {
    const a = conversationKey([{ role: "user", content: "one" }]);
    const b = conversationKey([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
    const c = conversationKey([{ role: "user", content: "different" }]);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
