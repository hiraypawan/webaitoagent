process.env.API_KEY = "stream-key";
process.env.HOST = "127.0.0.1";
process.env.LOG_LEVEL = "error";

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatChunk, ChatCompletionRequest, Provider } from "../src/core/types.js";
import { nowSeconds } from "../src/core/utils.js";

/** A provider that streams a fixed script, so the HTTP layer can be tested. */
class FakeProvider implements Provider {
  id = "fake";
  name = "Fake";
  models = [{ id: "fake-1", name: "Fake 1", owned_by: "test" }];
  calls: ChatCompletionRequest[] = [];
  chunks: string[];
  finish: "stop" | "tool_calls" = "stop";

  constructor(chunks: string[]) {
    this.chunks = chunks;
  }

  private frame(delta: Record<string, unknown>, finish: string | null = null): ChatChunk {
    return {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: nowSeconds(),
      model: "fake-1",
      choices: [{ index: 0, delta: delta as never, finish_reason: finish as never }],
    };
  }

  async *chat(request: ChatCompletionRequest): AsyncGenerator<ChatChunk> {
    this.calls.push(request);
    yield this.frame({ role: "assistant", content: "" });
    for (const chunk of this.chunks) yield this.frame({ content: chunk });
    yield this.frame({}, this.finish);
  }
}

const { createServer } = await import("../src/server/index.js");

const provider = new FakeProvider(["Hel", "lo"]);
const built = await createServer({ logger: false, providers: [provider] });
const app = built.app;
await app.ready();

after(async () => {
  await app.close();
});

const auth = { authorization: "Bearer stream-key" };

function payload(extra: Record<string, unknown> = {}) {
  return { model: "fake/fake-1", messages: [{ role: "user", content: "hi" }], ...extra };
}

async function sseFrames(body: string): Promise<Record<string, any>[]> {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, any>);
}

describe("streaming completions", () => {
  it("emits incremental SSE deltas and a terminator", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({ stream: true }),
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] as string, /text\/event-stream/);
    assert.match(response.body, /data: \[DONE\]/);

    const frames = await sseFrames(response.body);
    const text = frames
      .map((frame) => frame.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.equal(text, "Hello");
    assert.equal(frames[0]!.choices[0].delta.role, "assistant");
    assert.equal(frames.at(-1)!.choices[0].finish_reason, "stop");
    assert.equal(frames.at(-1)!.model, "fake/fake-1");
  });

  it("includes a usage frame when asked", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({ stream: true, stream_options: { include_usage: true } }),
    });
    const frames = await sseFrames(response.body);
    const usage = frames.at(-1)!.usage;
    assert.ok(usage.prompt_tokens > 0);
    assert.ok(usage.total_tokens >= usage.prompt_tokens);
    assert.deepEqual(frames.at(-1)!.choices, []);
  });

  it("turns Qwen/GLM XML into native tool_calls too", async () => {
    provider.chunks = [
      '<tool_call>\n<function=bash>\n<parameter=command>dir</parameter>\n</function>\n</tool_call>',
    ];
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({
        stream: true,
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
      }),
    });

    const parsed = await sseFrames(response.body);
    const call = parsed.find((frame) => frame.choices?.[0]?.delta?.tool_calls)?.choices[0].delta
      .tool_calls[0];
    assert.ok(call, "expected a tool_calls frame");
    assert.equal(call.function.name, "bash");
    assert.deepEqual(JSON.parse(call.function.arguments), { command: "dir" });
  });

  it("turns MiMo's <function=read> markup (no </function>) into tool_calls", async () => {
    provider.chunks = [
      String.raw`<tool_call><function=read><parameter=path>D:\AgentsAI\WEB AGENTS TO\README.md</parameter></tool_call>`,
    ];
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              parameters: {
                type: "object",
                properties: { filePath: { type: "string" } },
                required: ["filePath"],
              },
            },
          },
        ],
      }),
    });

    const frames = await sseFrames(response.body);
    const call = frames.find((frame) => frame.choices?.[0]?.delta?.tool_calls)?.choices[0].delta
      .tool_calls[0];
    assert.ok(call, "expected a tool_calls frame");
    assert.equal(call.function.name, "read");
    assert.deepEqual(JSON.parse(call.function.arguments), {
      filePath: String.raw`D:\AgentsAI\WEB AGENTS TO\README.md`,
    });
    assert.equal(frames.at(-1)!.choices[0].finish_reason, "tool_calls");

    const leaked = frames.map((frame) => frame.choices?.[0]?.delta?.content ?? "").join("");
    assert.doesNotMatch(leaked, /<tool_call|<parameter/);
    provider.chunks = ["Hel", "lo"];
  });

  it("turns <tool_call name=read> with <parameter> children into tool_calls", async () => {
    provider.chunks = [
      String.raw`<tool_call name=read><parameter=path>D:\AgentsAI\WEB AGENTS TO\package.json</parameter></tool_call>`,
    ];
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              parameters: {
                type: "object",
                properties: { filePath: { type: "string" } },
                required: ["filePath"],
              },
            },
          },
        ],
      }),
    });

    const frames = await sseFrames(response.body);
    const call = frames.find((frame) => frame.choices?.[0]?.delta?.tool_calls)?.choices[0].delta
      .tool_calls[0];
    assert.ok(call, "expected a tool_calls frame");
    assert.equal(call.function.name, "read");
    assert.deepEqual(JSON.parse(call.function.arguments), {
      filePath: String.raw`D:\AgentsAI\WEB AGENTS TO\package.json`,
    });
    provider.chunks = ["Hel", "lo"];
  });

  it("explains an unreadable tool block instead of answering with the failure", async () => {
    provider.chunks = ["<tool_call>\nI will list the files now.\n</tool_call>"];
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({
        stream: true,
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
      }),
    });

    const text = (await sseFrames(response.body))
      .map((frame) => frame.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.match(text, /could not be read/);
    assert.match(text, /I will list the files now/, "the model is shown what it wrote");
    assert.match(text, /<tool_call name="bash">/, "and the exact accepted shape");
  });

  it("converts text tool calls into native tool_calls when tools are supplied", async () => {
    provider.chunks = ['<tool_call name="bash">{"command":"ls"}</tool_call>'];
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({
        stream: true,
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
      }),
    });

    const frames = await sseFrames(response.body);
    const toolFrame = frames.find((frame) => frame.choices?.[0]?.delta?.tool_calls);
    assert.ok(toolFrame, "expected a tool_calls frame");
    const call = toolFrame.choices[0].delta.tool_calls[0];
    assert.equal(call.index, 0);
    assert.match(call.id, /^call_/);
    assert.equal(call.function.name, "bash");
    assert.deepEqual(JSON.parse(call.function.arguments), { command: "ls" });
    assert.equal(frames.at(-1)!.choices[0].finish_reason, "tool_calls");
    provider.chunks = ["Hel", "lo"];
  });
});

describe("non-streaming completions", () => {
  it("returns an OpenAI completion object with usage", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload(),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "fake/fake-1");
    assert.equal(body.choices[0].message.content, "Hello");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.ok(body.usage.total_tokens > 0);
  });

  it("returns native tool_calls and a null content", async () => {
    provider.chunks = ['<tool_call name="bash">{"command":"pwd"}</tool_call>'];
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({ tools: [{ type: "function", function: { name: "bash" } }] }),
    });
    const body = response.json();
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.content, null);
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "bash");
    provider.chunks = ["Hel", "lo"];
  });

  it("maps a bare MiMo argument onto the only declared parameter", async () => {
    provider.chunks = [
      String.raw`<tool_call name="read">D:\AgentsAI\WEB AGENTS TO\package.json</tool_call>`,
    ];
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload({
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              parameters: {
                type: "object",
                properties: { filePath: { type: "string" } },
                required: ["filePath"],
              },
            },
          },
        ],
      }),
    });
    const body = response.json();
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "read");
    assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), {
      filePath: String.raw`D:\AgentsAI\WEB AGENTS TO\package.json`,
    });
    provider.chunks = ["Hel", "lo"];
  });

  it("reports provider failures as OpenAI-style errors", async () => {
    const failing: Provider = {
      id: "fake",
      name: "Fake",
      models: provider.models,
      async *chat() {
        throw new Error("browser exploded");
        // eslint-disable-next-line no-unreachable
        yield {} as ChatChunk;
      },
    };
    const broken = await createServer({ logger: false, providers: [failing] });
    await broken.app.ready();
    const response = await broken.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: payload(),
    });
    assert.equal(response.statusCode, 500);
    assert.match(response.json().error.message, /browser exploded/);
    await broken.app.close();
  });
});
