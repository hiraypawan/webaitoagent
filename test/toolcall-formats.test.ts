import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exampleCall,
  hasToolCalls,
  hasUnclosedToolCall,
  isPlaceholderName,
  parseToolCallsDetailed,
  stripToolCalls,
} from "../src/core/toolcalls.js";

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

const opencodeOptions = {
  allowedTools: ["bash", "read", "write", "edit", "list", "glob", "grep"],
  toolSchemas: {
    read: { required: ["filePath"], properties: ["filePath", "offset", "limit"] },
    bash: { required: ["command"], properties: ["command", "shell", "cwd"] },
    glob: { required: ["pattern"], properties: ["pattern", "path"] },
  },
};

describe("MiMo's real markup", () => {
  it("parses <function=read> with no </function>", () => {
    const text =
      '<tool_call><function=read><parameter=path>D:\\AgentsAI\\WEB AGENTS TO\\README.md</parameter></tool_call>';
    const { calls, dropped } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(dropped.length, 0, JSON.stringify(dropped));
    assert.equal(calls[0]!.name, "read");
    assert.equal(calls[0]!.args.filePath, "D:\\AgentsAI\\WEB AGENTS TO\\README.md");
  });

  it("parses a tool name attribute with <parameter> children", () => {
    const text = '<tool_call name=read><parameter=path>D:\\project\\src\\index.ts</parameter></tool_call>';
    const { calls, dropped } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(dropped.length, 0, JSON.stringify(dropped));
    assert.equal(calls[0]!.args.filePath, "D:\\project\\src\\index.ts");
  });

  it("parses <parameter name=\"...\"> children", () => {
    const text = '<tool_call name="bash"><parameter name="command">npm test</parameter></tool_call>';
    const { calls } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(calls[0]!.name, "bash");
    assert.equal(calls[0]!.args.command, "npm test");
  });

  it("parses a name followed by <parameter> without the function tag", () => {
    const text = '<tool_call>read<parameter=path>README.md</parameter></tool_call>';
    const { calls } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(calls[0]!.args.filePath, "README.md");
  });

  it("recovers a <tool_call> whose closing tag was cut off", () => {
    const text = '<tool_call name="read"><parameter=path>README.md';
    const { calls, dropped } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(dropped.length, 0, JSON.stringify(dropped));
    assert.equal(calls[0]!.name, "read");
    assert.equal(calls[0]!.args.filePath, "README.md");
  });

  it("uses the only declared parameter for a bare argument", () => {
    const text = '<tool_call name="read">D:\\AgentsAI\\WEB AGENTS TO\\package.json</tool_call>';
    const { calls } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(calls[0]!.args.filePath, "D:\\AgentsAI\\WEB AGENTS TO\\package.json");
  });

  it("maps opencode's short tool name onto the agent's long name", () => {
    const local = {
      allowedTools: ["bash", "read_file", "write_file", "replace_in_file"],
      toolSchemas: {
        read_file: { required: ["path"], properties: ["path", "offset", "limit"] },
      },
    };
    const { calls, dropped } = parseToolCallsDetailed(
      '<tool_call name="read">{"path":"README.md"}</tool_call>',
      local
    );
    assert.equal(dropped.length, 0, JSON.stringify(dropped));
    assert.equal(calls[0]!.name, "read_file");
    assert.equal(calls[0]!.args.path, "README.md");
  });

  it("repairs unescaped Windows paths in JSON arguments", () => {
    const text = String.raw`<tool_call name="read">{"filePath": "D:\AgentsAI\WEB AGENTS TO\package.json"}</tool_call>`;
    const { calls, dropped } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(dropped.length, 0, JSON.stringify(dropped));
    assert.equal(calls[0]!.name, "read");
    assert.equal(calls[0]!.args.filePath, String.raw`D:\AgentsAI\WEB AGENTS TO\package.json`);
  });

  it("unwraps a parameter whose value repeats its own name", () => {
    const text = String.raw`<tool_call><function=read><parameter=filePath>{"filePath": "D:\AgentsAI\WEB AGENTS TO\package.json"}</parameter></tool_call>`;
    const { calls, dropped } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(dropped.length, 0, JSON.stringify(dropped));
    assert.equal(calls[0]!.args.filePath, String.raw`D:\AgentsAI\WEB AGENTS TO\package.json`);
  });

  it("recovers a call whose closing tags were cut off", () => {
    const text = "<function=glob><parameter=pattern>**/*.ts";
    const { calls } = parseToolCallsDetailed(text, opencodeOptions);
    assert.equal(calls[0]!.name, "glob");
    assert.equal(calls[0]!.args.pattern, "**/*.ts");
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
    assert.equal(
      stripToolCalls('Here you go.\n<tool_call name="read">README.md'),
      "Here you go."
    );
    assert.ok(hasToolCalls(text));
    assert.ok(hasToolCalls("<function=bash><parameter=command>ls</parameter></function>"));
  });
});

describe("placeholders are never executed or repeated back", () => {
  const withTools = {
    allowedTools: ["bash", "write_file"],
    toolSchemas: {
      bash: { required: ["command"] },
      write_file: { required: ["path", "content"] },
    },
  };

  it("ignores the template names we used to print", () => {
    for (const name of ["…", "...", "TOOL_NAME", "tool_name", "YOUR_TOOL", "<tool_name>", "name"]) {
      const { calls, dropped } = parseToolCallsDetailed(
        `<tool_call name="${name}">{"command":"dir"}</tool_call>`,
        withTools
      );
      const result = parseToolCallsDetailed(
        `<tool_call name="${name}">{"command":"dir"}</tool_call>`,
        withTools
      );
      assert.equal(result.calls.length, 0, name);
      assert.equal(result.dropped.length, 0, `${name} must not be reported as unknown`);
      assert.equal(result.placeholders, 1, `${name} is counted as a placeholder`);
    }
  });

  it("still reports a genuine unknown name", () => {
    const { dropped } = parseToolCallsDetailed(
      '<tool_call name="delete_everything">{"command":"dir"}</tool_call>',
      withTools
    );
    assert.equal(dropped.length, 1);
    assert.match(dropped[0]!.parseError ?? "", /unknown tool "delete_everything"/);
  });

  it("builds an example from a real declared tool", () => {
    const example = exampleCall(
      [
        { type: "function", function: { name: "write_file", parameters: { type: "object", required: ["path", "content"] } } },
      ],
      "…"
    );
    assert.equal(example?.name, "write_file");
    assert.deepEqual(Object.keys(example!.arguments).sort(), ["content", "path"]);
  });

  it("prefers bash for the example when it is available", () => {
    const example = exampleCall([
      { type: "function", function: { name: "glob", parameters: { type: "object", required: ["pattern"] } } },
      { type: "function", function: { name: "bash", parameters: { type: "object", required: ["command"] } } },
    ]);
    assert.equal(example?.name, "bash");
    assert.deepEqual(example?.arguments, { command: "dir" });
  });

  it("returns nothing when no tools were declared", () => {
    assert.equal(exampleCall(undefined), undefined);
  });
});

describe("isPlaceholderName", () => {
  it("accepts real tool names", () => {
    for (const name of ["bash", "write_file", "read_file", "grep"]) {
      assert.equal(isPlaceholderName(name), false, name);
    }
  });

  it("rejects templates", () => {
    for (const name of ["…", "...", "TOOL_NAME", "<tool_name>", "your_tool", "name:", "TOOL"]) {
      assert.equal(isPlaceholderName(name), true, name);
    }
  });
});

describe("unclosed blocks", () => {
  it("detects a genuine truncation", () => {
    assert.equal(hasUnclosedToolCall('<tool_call name="bash">{"command":"ls"'), true);
  });

  it("is not fooled by a closed block that was filtered as a placeholder", () => {
    assert.equal(hasUnclosedToolCall('<tool_call name="…">{"command":"dir"}</tool_call>'), false);
  });

  it("is false for prose", () => {
    assert.equal(hasUnclosedToolCall("all done"), false);
  });
});
