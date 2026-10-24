import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "../config/index.js";
import { PlaywrightBrowserManager } from "../browser/manager.js";
import { createMimoProvider } from "../providers/mimo.js";
import { MockProvider } from "../providers/mock.js";
import type { Provider } from "../core/types.js";

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  const bm = new PlaywrightBrowserManager({ userDataRoot: config.profileRoot, headless: config.headless });
  const providers: Provider[] = [createMimoProvider(bm), new MockProvider()];
  const providerMap = new Map(providers.map((p) => [p.id, p]));

  // init providers
  for (const p of providers) {
    try { await p.init(await bm.context(p.id).catch(() => null as any)); } catch {}
  }

  const auth = (req: any, reply: any) => {
    if (!config.apiKey) return true;
    const h = req.headers["authorization"] ?? "";
    const token = String(h).replace(/^Bearer\s+/i, "");
    if (token !== config.apiKey) {
      reply.code(401).send({ error: { message: "invalid api key" } });
      return false;
    }
    return true;
  };

  app.get("/health", async () => ({ ok: true, providers: providers.map((p) => p.id) }));

  app.get("/v1/models", async (req, reply) => {
    if (!auth(req, reply)) return;
    const data = providers.flatMap((p) =>
      p.models.map((m) => ({ id: `${p.id}/${m.id}`, object: "model", created: 0, owned_by: m.owned_by }))
    );
    return { object: "list", data };
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    if (!auth(req, reply)) return;
    const body = req.body as any;
    const modelStr: string = body.model ?? "mock/mock-gpt";
    const [providerId, ...rest] = modelStr.split("/");
    const modelId = rest.join("/") || modelStr;
    const provider = providerMap.get(providerId) ?? providers.find((p) => p.models.some((m) => m.id === modelStr));
    if (!provider) {
      reply.code(400).send({ error: { message: `unknown provider/model: ${modelStr}` } });
      return;
    }
    const resolvedModel = provider.models.some((m) => m.id === modelId) ? modelId : provider.models[0]?.id ?? modelId;
    const request = { ...body, model: resolvedModel };

    const stream = Boolean(body.stream);
    if (stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      try {
        for await (const chunk of provider.chat(request, (req as any).raw?.signal)) {
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        reply.raw.write("data: [DONE]\n\n");
      } catch (e: any) {
        reply.raw.write(`data: ${JSON.stringify({ error: { message: e?.message ?? String(e) } })}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
      }
      reply.raw.end();
      return;
    }

    // non-streaming: collect
    let content = "";
    try {
      for await (const chunk of provider.chat(request)) {
        const c = chunk.choices?.[0]?.delta?.content;
        if (c) content += c;
      }
    } catch (e: any) {
      reply.code(500).send({ error: { message: e?.message ?? String(e) } });
      return;
    }
    return {
      id: "chatcmpl-" + Math.random().toString(36).slice(2),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelStr,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    };
  });

  // login endpoint: opens headed browser
  app.post("/auth/login", async (req, reply) => {
    const body = req.body as any;
    const pid = body?.provider ?? "mimo";
    const provider = providerMap.get(pid);
    if (!provider || !provider.login) {
      reply.code(400).send({ error: { message: "provider not found or no login" } });
      return;
    }
    // run in background
    provider.login(true).catch((e) => app.log.error(e));
    return { ok: true, message: `Opened browser for ${pid}. Log in, then close the window.` };
  });

  app.addHook("onClose", async () => {
    await bm.close();
  });

  return app;
}