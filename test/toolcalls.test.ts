import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasToolCalls,
  parseToolCalls,
  stripToolCalls,
  toOpenAIToolCalls,
} from "../src/core/toolcalls.js";

describe("parseToolCalls", () => {
  it("parses the named block format", () => {
    const calls = parseToolCalls('Sure.\n<tool_call name="bash">{"command":"ls -la"}</tool_call>');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "bash");
    assert.deepEqual(calls[0]!.args, { command: "ls -la" });
    assert.equal(calls[0]!.parseError, undefined);
  });

  it("parses the generic block format", () => {
    const calls = parseToolCalls(
      '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "read_file");
    assert.deepEqual(calls[0]!.args, { path: "a.txt" });
  });

  it("parses multiple calls and tolerates surrounding whitespace", () => {
    const calls = parseToolCalls(
      '<tool_call name="a">{"x":1}</tool_call>\n<tool_call name="b">{ "y": 2 }</tool_call>'
    );
    assert.deepEqual(
      calls.map((call) => call.name),
      ["a", "b"]
    );
    assert.deepEqual(calls[1]!.args, { y: 2 });
  });

  it("flags invalid JSON instead of throwing", () => {
    const calls = parseToolCalls('<tool_call name="bash">{oops}</tool_call>');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.parseError ?? "", /not valid JSON/);
  });

  it("returns nothing for prose", () => {
    assert.deepEqual(parseToolCalls("just an answer"), []);
    assert.equal(hasToolCalls("just an answer"), false);
    assert.equal(hasToolCalls('<tool_call name="x">'), true);
  });
});

describe("stripToolCalls", () => {
  it("keeps the prose only", () => {
    const text = 'Let me look.\n<tool_call name="bash">{"command":"ls"}</tool_call>\nDone.';
    assert.equal(stripToolCalls(text), "Let me look.\n\nDone.");
  });
});

describe("toOpenAIToolCalls", () => {
  it("produces the OpenAI shape with unique ids", () => {
    const calls = toOpenAIToolCalls(parseToolCalls('<tool_call name="bash">{"command":"ls"}</tool_call>'));
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.id, /^call_/);
    assert.equal(calls[0]!.type, "function");
    assert.equal(calls[0]!.function.name, "bash");
    assert.deepEqual(JSON.parse(calls[0]!.function.arguments), { command: "ls" });
  });
});
