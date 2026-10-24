process.env.API_KEY = "oc-key";
process.env.HOST = "127.0.0.1";
process.env.LOG_LEVEL = "error";

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatChunk, ChatCompletionRequest, Provider } from "../src/core/types.js";
import { nowSeconds } from "../src/core/utils.js";

/**
 * Mimics what opencode sends: a big tool list, stream: true, and answers that
 * contain tool-call blocks. The assertions below mirror the checks in
 * @ai-sdk/openai-compatible and opencode's own chat parser.
 */
class ScriptedProvider implements Provider {
  id = "fake";
  name = "Fake";
  models = [{ id: "fake-1", name: "Fake 1", owned_by: "test" }];
  lastRequest?: ChatCompletionRequest;

  constructor(private readonly script: string[]) {}

  async *chat(request: ChatCompletionRequest): AsyncGenerator<ChatChunk> {
    this.lastRequest = request;
    for (const piece of this.script) {
      yield {
        id: "chatcmpl-scripted",
        object: "chat.completion.chunk",
        created: nowSeconds(),
        model: "fake-1",
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      };
    }
    yield {
      id: "chatcmpl-scripted",
      object: "chat.completion.chunk",
      created: nowSeconds(),
      model: "fake-1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }
}

const { createServer } = await import("../src/server/index.js");

const provider = new ScriptedProvider(["Hel", "lo"]);
const built = await createServer({ logger: false, providers: [provider] });
const app = built.app;
await app.ready();
after(async () => {
  await app.close();
});

const auth = { authorization: "Bearer oc-key" };

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
    },
  },
];

function payload(extra: Record<string, unknown> = {}) {
  return {
    model: "fake/fake-1",
    messages: [{ role: "user", content: "list files" }],
    tools: TOOLS,
    stream: true,
    ...extra,
  };
}

interface Frame {
  choices?: {
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Record<string, number>;
}

async function run(body: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: body,
  });
  assert.equal(response.statusCode, 200);
  const frames = response.body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)) as Frame);
  return { body: response.body, frames };
}

/** The invariants opencode's parser enforces. */
function assertOpenCodeContract(frames: Frame[]) {
  assert.ok(frames.length > 0, "expected at least one frame");

  const finishIndex = frames.findIndex((frame) => frame.choices?.[0]?.finish_reason);
  assert.notEqual(finishIndex, -1, "stream must contain a finish_reason");

  // "OpenAI Chat received content after the finish reason"
  for (const frame of frames.slice(finishIndex + 1)) {
    const delta = frame.choices?.[0]?.delta;
    if (!delta) continue;
    assert.equal(delta.content ?? null, null, "content must not follow the finish reason");
    assert.equal(delta.tool_calls ?? undefined, undefined, "tool calls must not follow the finish reason");
  }

  for (const frame of frames) {
    for (const toolCall of frame.choices?.[0]?.delta?.tool_calls ?? []) {
      // "OpenAI Chat tool call delta is missing id or name"
      assert.ok(toolCall.id, "tool call delta needs an id");
      assert.ok(toolCall.function?.name, "tool call delta needs a name");
      assert.equal(typeof toolCall.function?.arguments, "string");
      assert.doesNotThrow(
        () => JSON.parse(toolCall.function!.arguments!),
        "tool call arguments must be valid JSON"
      );
      assert.equal(typeof toolCall.index, "number");
    }
  }
}

describe("opencode tool-call contract", () => {
  it("streams text immediately, then tool calls, then a separate finish frame", async () => {
    const scripted = new ScriptedProvider([
      "Checking the directory.",
      '\n<tool_call name="bash">',
      '{"command": "ls -la"}',
      "</tool_call>",
    ]);
    const local = await createServer({ logger: false, providers: [scripted] });
    await local.app.ready();

    const response = await local.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload(),
    });
    const frames = response.body
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
      .map((f) => JSON.parse(f.slice(6)) as Frame);

    assertOpenCodeContract(frames);

    const text = frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("");
    assert.equal(text.trim(), "Checking the directory.");
    assert.ok(!text.includes("<tool_call"), "tool block must never leak into content");

    const calls = frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.function!.name, "bash");
    assert.deepEqual(JSON.parse(calls[0]!.function!.arguments!), { command: "ls -la" });
    assert.equal(calls[0]!.index, 0);

    const last = frames.at(-1)!;
    assert.equal(last.choices![0]!.finish_reason, "tool_calls");
    await local.app.close();
  });

  it("emits one delta per parallel call with unique ids and indexes", async () => {
    const scripted = new ScriptedProvider([
      '<tool_call name="bash">{"command":"ls"}</tool_call>\n',
      '<tool_call name="read">{"filePath":"README.md"}</tool_call>',
    ]);
    const local = await createServer({ logger: false, providers: [scripted] });
    await local.app.ready();

    const response = await local.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload(),
    });
    const frames = (response.body as string)
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
      .map((f) => JSON.parse(f.slice(6)) as Frame);

    assertOpenCodeContract(frames);
    const calls = frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.index), [0, 1]);
    assert.equal(new Set(calls.map((c) => c.id)).size, 2);
    assert.deepEqual(calls.map((c) => c.function!.name), ["bash", "read"]);
    await local.app.close();
  });

  it("maps aliases onto declared tools", async () => {
    const scripted = new ScriptedProvider(['<tool_call name="read_file">{"path":"a.txt"}</tool_call>']);
    const local = await createServer({ logger: false, providers: [scripted] });
    await local.app.ready();

    const response = await local.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload(),
    });
    const calls = (response.body as string)
      .split("\n\n")
      .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
      .flatMap((f) => (JSON.parse(f.slice(6)) as Frame).choices?.[0]?.delta?.tool_calls ?? []);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.function!.name, "read");
    assert.deepEqual(JSON.parse(calls[0]!.function!.arguments!), { filePath: "a.txt" });
    await local.app.close();
  });

  it("never fails the stream for an unknown tool or bad JSON", async () => {
    const scripted = new ScriptedProvider([
      '<tool_call name="delete_everything">{"path":"/"}</tool_call>',
      '<tool_call name="bash">{oops}</tool_call>',
    ]);
    const local = await createServer({ logger: false, providers: [scripted] });
    await local.app.ready();

    const response = await local.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload(),
    });
    const frames = (response.body as string)
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
      .map((f) => JSON.parse(f.slice(6)) as Frame);

    assertOpenCodeContract(frames);
    assert.equal(frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []).length, 0);
    assert.equal(frames.at(-1)!.choices![0]!.finish_reason, "stop");

    const text = frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("");
    assert.match(text, /tool call could not be read/);
    assert.match(text, /delete_everything/, "the rejected name is reported");
    assert.match(text, /arguments were not valid JSON/, "the broken JSON is reported");
    await local.app.close();
  });

  it("keeps prose streaming when the answer has no tool call", async () => {
    const { frames } = await run(payload());
    assertOpenCodeContract(frames);
    const text = frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("");
    assert.equal(text, "Hello");
    assert.equal(frames.at(-1)!.choices![0]!.finish_reason, "stop");
  });

  it("sends a finish reason even without tools", async () => {
    const { frames } = await run({
      model: "fake/fake-1",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assertOpenCodeContract(frames);
    assert.equal(frames.at(-1)!.choices![0]!.finish_reason, "stop");
  });

  it("passes tool_choice and the tool list through to the provider prompt", async () => {
    await run(payload({ tool_choice: "required" }));
    const sent = provider.lastRequest!;
    assert.deepEqual(sent.tool_choice, "required");
    assert.equal(sent.tools?.length, 2);
  });

  it("accepts max_completion_tokens and parallel_tool_calls from the client", async () => {
    const { frames } = await run(
      payload({ max_completion_tokens: 512, parallel_tool_calls: true })
    );
    assertOpenCodeContract(frames);
  });
});

describe("opencode non-streaming tool calls", () => {
  it("returns parsed tool_calls with valid JSON", async () => {
    const scripted = new ScriptedProvider(['<tool_call name="bash">{"command":"pwd"}</tool_call>']);
    const local = await createServer({ logger: false, providers: [scripted] });
    await local.app.ready();

    const response = await local.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { ...payload({ stream: false }) },
    });
    const body = response.json();
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.content, null);
    const call = body.choices[0].message.tool_calls[0];
    assert.match(call.id, /^call_/);
    assert.equal(call.function.name, "bash");
    assert.deepEqual(JSON.parse(call.function.arguments), { command: "pwd" });
    await local.app.close();
  });
});

describe("guessing tool calls from plain JSON", () => {
  it("ignores JSON that does not name a declared tool", async () => {
    const scripted = new ScriptedProvider(['{"name":"some_user","age":42}']);
    const local = await createServer({ logger: false, providers: [scripted] });
    await local.app.ready();

    const response = await local.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload(),
    });
    const text = (response.body as string)
      .split("\n\n")
      .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
      .map((f) => (JSON.parse(f.slice(6)) as Frame).choices?.[0]?.delta?.content ?? "")
      .join("");

    assert.match(text, /some_user/);
    assert.doesNotMatch(text, /tool call ignored/);
    await local.app.close();
  });

  it("accepts a fenced tool call with a declared tool", async () => {
    const scripted = new ScriptedProvider(['```json\n{"name":"bash","arguments":{"command":"pwd"}}\n```']);
    const local = await createServer({ logger: false, providers: [scripted] });
    await local.app.ready();

    const response = await local.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload(),
    });
    const calls = (response.body as string)
      .split("\n\n")
      .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
      .flatMap((f) => (JSON.parse(f.slice(6)) as Frame).choices?.[0]?.delta?.tool_calls ?? []);

    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0]!.function!.arguments!), { command: "pwd" });
    await local.app.close();
  });
});
