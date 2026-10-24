import type { Provider, ProviderModel, ChatCompletionRequest, ChatChunk } from "../core/types.js";

export class MockProvider implements Provider {
  id = "mock";
  name = "Mock (testing)";
  models: ProviderModel[] = [{ id: "mock-gpt", name: "Mock GPT", owned_by: "mock" }];

  async init() {}
  async *chat(req: ChatCompletionRequest): AsyncGenerator<ChatChunk> {
    const id = "chatcmpl-mock";
    const created = Math.floor(Date.now() / 1000);
    const model = req.model;
    const last = req.messages[req.messages.length - 1];
    const content = typeof last.content === "string" ? last.content : "hi";
    const reply = `Echo: ${content}`;
    for (const ch of reply) {
      yield { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: ch }, finish_reason: null }] };
      await new Promise((r) => setTimeout(r, 10));
    }
    yield { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  }
}