import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasToolCalls,
  parseToolCalls,
  parseToolCallsDetailed,
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

  it("drops calls whose arguments cannot be parsed", () => {
    const result = parseToolCallsDetailed('<tool_call name="bash">{oops}</tool_call>');
    assert.equal(result.calls.length, 0);
    assert.equal(result.dropped.length, 1);
    assert.match(result.dropped[0]!.parseError ?? "", /valid JSON/);
    assert.deepEqual(parseToolCalls('<tool_call name="bash">{oops}</tool_call>'), []);
  });

  it("repairs the usual JSON mistakes", () => {
    const calls = parseToolCalls(
      "<tool_call name=\"bash\">{'command': 'ls -la',}</tool_call>"
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, { command: "ls -la" });

    const unquoted = parseToolCalls('<tool_call name="bash">{command: "pwd"}</tool_call>');
    assert.deepEqual(unquoted[0]!.args, { command: "pwd" });
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

describe("placeholder tool names", () => {
  it("ignores the example syntax copied out of instructions", () => {
    const text =
      'Call one with <tool_call name="NAME">{"param":"value"}</tool_call> and stop.';
    const result = parseToolCallsDetailed(text, { allowedTools: ["bash", "read"] });
    assert.equal(result.calls.length, 0);
    assert.equal(result.dropped.length, 0, "an example must not be reported as a failed call");
  });

  it("still reports genuinely unknown tools", () => {
    const result = parseToolCallsDetailed('<tool_call name="delete_all">{}</tool_call>', {
      allowedTools: ["bash"],
    });
    assert.equal(result.calls.length, 0);
    assert.equal(result.dropped.length, 1);
    assert.match(result.dropped[0]!.parseError ?? "", /unknown tool/);
  });
});
