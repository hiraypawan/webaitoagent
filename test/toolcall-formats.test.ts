import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasToolCalls, parseToolCallsDetailed, stripToolCalls } from "../src/core/toolcalls.js";

const tools = ["bash", "read_file", "write_file", "list_dir", "glob", "grep", "edit"];
const options = { allowedTools: tools };

describe("the format we ask for", () => {
  it("parses <tool_call name=\"bash\">{...}</tool_call>", () => {
    const { calls, dropped } = parseToolCallsDetailed(
      '<tool_call name="bash">{"command": "dir"}</tool_call>',
      options
    );
    assert.equal(dropped.length, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, { command: "dir" });
  });
});

describe("other markup the same models emit", () => {
  it("parses the Qwen/GLM XML form with <parameter> tags", () => {
    const text = `<tool_call>
<function=bash>
<parameter=command>
dir /b
</parameter>
</function>
</tool_call>`;
    const { calls, dropped } = parseToolCallsDetailed(text, options);
    assert.equal(dropped.length, 0, JSON.stringify(dropped));
    assert.equal(calls[0]!.name, "bash");
    assert.equal(calls[0]!.args.command, "dir /b");
  });

  it("parses the XML form without the <tool_call> wrapper", () => {
    const text = `<function=read_file>
<parameter=path>README.md</parameter>
</function>`;
    const { calls } = parseToolCallsDetailed(text, options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args.path, "README.md");
  });

  it("parses an unquoted attribute name", () => {
    const { calls } = parseToolCallsDetailed('<tool_call name=bash>{"command":"ls"}</tool_call>', options);
    assert.equal(calls[0]!.name, "bash");
  });

  it("parses a name line followed by JSON", () => {
    const { calls } = parseToolCallsDetailed(`<tool_call>\nbash\n{"command": "ls -la"}\n</tool_call>`, options);
    assert.equal(calls[0]!.name, "bash");
    assert.equal(calls[0]!.args.command, "ls -la");
  });

  it("parses every call in a JSON array", () => {
    const text = `<tool_call>[{"name":"bash","arguments":{"command":"a"}},{"name":"list_dir","arguments":{"path":"."}}]</tool_call>`;
    const { calls } = parseToolCallsDetailed(text, options);
    assert.deepEqual(
      calls.map((call) => call.name),
      ["bash", "list_dir"]
    );
  });

  it("parses an OpenAI-style tool_calls payload", () => {
    const text = JSON.stringify({
      tool_calls: [
        { function: { name: "bash", arguments: '{"command":"echo hi"}' } },
        { function: { name: "glob", arguments: '{"pattern":"**/*.ts"}' } },
      ],
    });
    const { calls } = parseToolCallsDetailed(text, options);
    assert.deepEqual(
      calls.map((call) => call.name),
      ["bash", "glob"]
    );
    assert.equal(calls[1]!.args.pattern, "**/*.ts");
  });

  it("parses the [TOOL_CALLS] marker", () => {
    const text = `[TOOL_CALLS] [{"name": "bash", "arguments": {"command": "pwd"}}]`;
    const { calls } = parseToolCallsDetailed(text, options);
    assert.equal(calls[0]!.name, "bash");
  });

  it("maps a differently-named shell tool onto bash", () => {
    const { calls } = parseToolCallsDetailed('<tool_call name="run_command">{"command":"ls"}</tool_call>', options);
    assert.equal(calls[0]!.name, "bash");
    assert.equal(calls[0]!.renamedFrom, "run_command");
  });
});

describe("when the block really is unreadable", () => {
  it("reports the offending text instead of a bare (unknown)", () => {
    const text = `<tool_call>
I will now list the files.
</tool_call>`;
    const { calls, dropped } = parseToolCallsDetailed(text, options);
    assert.equal(calls.length, 0);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0]!.parseError ?? "", /unrecognised tool-call format/);
    assert.match(dropped[0]!.parseError ?? "", /I will now list the files/);
  });

  it("does not invent a call from ordinary prose", () => {
    const { calls, dropped } = parseToolCallsDetailed(
      "Sure, I had a look at the project. It is a small Node app.",
      options
    );
    assert.equal(calls.length, 0);
    assert.equal(dropped.length, 0);
  });

  it("keeps prose when stripping markup", () => {
    const text = `Here you go.
<tool_call name="bash">{"command":"dir"}</tool_call>`;
    assert.equal(stripToolCalls(text), "Here you go.");
    assert.ok(hasToolCalls(text));
    assert.ok(hasToolCalls("<function=bash><parameter=command>ls</parameter></function>"));
  });
});
