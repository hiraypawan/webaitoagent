process.env.API_KEY = "compat-key";
process.env.HOST = "127.0.0.1";
process.env.LOG_LEVEL = "error";
process.env.DATA_DIR = "/tmp/wat-compat-data";

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatChunk, ChatCompletionRequest, Provider } from "../src/core/types.js";
import { nowSeconds } from "../src/core/utils.js";

/** Replies with a scripted answer and records what the provider was asked. */
class ScriptedProvider implements Provider {
  id = "mimo";
  name = "MiMo";
  models = [
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", owned_by: "xiaomi" },
    { id: "mimo-v2.6", name: "MiMo V2.6", owned_by: "xiaomi" },
  ];
  calls: ChatCompletionRequest[] = [];
  answer: string[] = ["Hello"];

  async *chat(request: ChatCompletionRequest): AsyncGenerator<ChatChunk> {
    this.calls.push(request);
    const frame = (delta: Record<string, unknown>, finish: string | null = null): ChatChunk => ({
      id: "chatcmpl-compat",
      object: "chat.completion.chunk",
      created: nowSeconds(),
      model: request.model,
      choices: [{ index: 0, delta: delta as never, finish_reason: finish as never }],
    });
    yield frame({ role: "assistant", content: "" });
    for (const part of this.answer) yield frame({ content: part });
    yield frame({}, "stop");
  }
}

const { createServer, resolveModel } = await import("../src/server/index.js");
const { buildPrompt, buildContinuationPrompt } = await import("../src/core/prompt.js");

const provider = new ScriptedProvider();
const built = await createServer({ logger: false, providers: [provider] });
const app = built.app;
await app.ready();

after(async () => {
  await app.close();
});

const auth = { authorization: "Bearer compat-key" };
const body = (extra: Record<string, unknown> = {}) => ({
  model: "mimo-v2.6-pro",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

const post = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/chat/completions", headers: auth, payload });

function frames(raw: string): Record<string, any>[] {
  return raw
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)));
}

describe("model name tolerance", () => {
  const map = new Map([[provider.id, provider as Provider]]);

  it("accepts the bare model key opencode is configured with", () => {
    assert.equal(resolveModel("mimo-v2.6-pro", [provider], map).model, "mimo-v2.6-pro");
  });

  it("accepts a real provider prefix", () => {
    assert.equal(resolveModel("mimo/mimo-v2.6", [provider], map).model, "mimo-v2.6");
  });

  it("accepts the label from our generated config", () => {
    // opencode's provider id is `web-agents-to`; that is not a provider here.
    assert.equal(resolveModel("web-agents-to/mimo-v2.6-pro", [provider], map).model, "mimo-v2.6-pro");
  });

  it("accepts any case", () => {
    assert.equal(resolveModel("MiMo/MiMo-V2.6-Pro", [provider], map).model, "mimo-v2.6-pro");
  });

  it("still rejects an unknown model with a helpful message", () => {
    assert.throws(
      () => resolveModel("gpt-5", [provider], map),
      /unknown model "gpt-5".*mimo\/mimo-v2\.6-pro/s
    );
  });
});

describe("parameters the page cannot honour", () => {
  it("rejects n > 1 explicitly", async () => {
    const response = await post(body({ n: 2 }));
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /n > 1 is not supported/);
  });

  it("silently ignores temperature, top_p, seed and penalties", async () => {
    const response = await post(
      body({ temperature: 0.2, top_p: 0.9, seed: 7, presence_penalty: 0.1, frequency_penalty: 0.1 })
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().choices[0].message.content, "Hello");
  });

  it("accepts parallel_tool_calls", async () => {
    const response = await post(body({ parallel_tool_calls: true }));
    assert.equal(response.statusCode, 200);
  });
});

describe("stop and max_tokens", () => {
  it("honours stop in a non-streaming answer", async () => {
    provider.answer = ["alpha", " beta", "\n\nHuman:", " ignored"];
    const response = await post(body({ stop: "\n\nHuman:" }));
    assert.equal(response.json().choices[0].message.content, "alpha beta");
    assert.equal(response.json().choices[0].finish_reason, "stop");
  });

  it("honours stop while streaming", async () => {
    provider.answer = ["alpha", "STOP", " beta"];
    const response = await post(body({ stream: true, stop: ["STOP"] }));
    const text = frames(response.body)
      .map((frame) => frame.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.equal(text, "alpha");
  });

  it("reports finish_reason length when the token budget ends the answer", async () => {
    provider.answer = ["a".repeat(100)];
    const response = await post(body({ max_tokens: 5 }));
    const choice = response.json().choices[0];
    assert.equal(choice.finish_reason, "length");
    assert.equal(choice.message.content.length, 20);
  });

  it("ends a stream with finish_reason length too", async () => {
    provider.answer = ["b".repeat(100)];
    const response = await post(body({ stream: true, max_completion_tokens: 5 }));
    const parsed = frames(response.body);
    const last = parsed.at(-1)!;
    assert.equal(last.choices[0].finish_reason, "length");
  });
});

describe("structured output", () => {
  it("asks the model for bare JSON", async () => {
    provider.answer = ['{"ok":true}'];
    await post(body({ response_format: { type: "json_object" } }));
    const prompt = provider.calls.at(-1)!;
    assert.equal(prompt.response_format?.type, "json_object");
    assert.ok(prompt, "provider received the request");
  });

  it("adds the JSON instruction to both prompt builders", () => {
    const fresh = buildPrompt([{ role: "user", content: "list files" }], { jsonMode: true });
    assert.match(fresh, /valid JSON object/);

    const continuation = buildContinuationPrompt(
      [
        { role: "user", content: "list files" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "again" },
      ],
      { jsonMode: true }
    );
    assert.match(continuation, /valid JSON object/);
  });
});

describe("discovery endpoints", () => {
  it("lists models with a context length clients can trust", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    const data = response.json().data;
    assert.ok(data.length >= 2);
    for (const model of data) {
      assert.ok(model.context_length > 0);
      assert.equal(model.object, "model");
    }
  });

  it("reports the effective budget and whether it grew", async () => {
    const response = await app.inject({ method: "GET", url: "/status", headers: auth });
    const context = response.json().context;
    assert.ok(context.budgetChars > 0);
    assert.ok(context.configuredChars > 0);
    assert.ok(context.ceilingChars >= context.configuredChars);
    assert.equal(typeof context.autoGrown, "boolean");
  });
});
