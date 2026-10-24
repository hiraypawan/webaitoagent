import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config/index.js";
import { PlaywrightBrowserManager } from "../browser/manager.js";
import { createProviders } from "../providers/registry.js";
import { RequestAbortedError, ValidationError, toErrorBody } from "../core/errors.js";
import { encodeSSE, encodeSSEError, SSE_DONE } from "../core/sse.js";
import { estimateTokens } from "../core/utils.js";
import { parseToolCalls, stripToolCalls, toOpenAIToolCalls } from "../core/toolcalls.js";
import { countPromptTokens } from "../core/prompt.js";
import { VERSION } from "../core/version.js";
import type { ChatCompletionRequest, ChatMessage, Provider } from "../core/types.js";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
});

const chatRequestSchema = z.object({
  model: z.string().min(1).optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  top_p: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  user: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
});

const loginSchema = z.object({ provider: z.string().min(1).optional() }).optional();

export interface ServerOptions {
  logger?: boolean | object;
  headless?: boolean;
  /** Inject providers (used by tests and embedders). Defaults to the registry. */
  providers?: Provider[];
  /** Skip creating a browser manager when providers don't need one. */
  browser?: PlaywrightBrowserManager;
}

export interface BuiltServer {
  app: FastifyInstance;
  providers: Provider[];
  browser: PlaywrightBrowserManager;
}

/** origin allow-list: loopback, browser extensions, plus CORS_ORIGINS. */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // curl, SDKs, server-to-server
  if (config.corsOrigins.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }
  } catch {
    return false;
  }
  return /^(chrome|moz|safari-web)-extension:\/\//.test(origin);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearerToken(header: unknown): string {
  return String(header ?? "").replace(/^Bearer\s+/i, "").trim();
}

export async function createServer(options: ServerOptions = {}): Promise<BuiltServer> {
  const app = Fastify({
    logger: (options.logger ?? { level: config.logLevel }) as never,
    bodyLimit: config.requestBodyLimitBytes,
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 86_400,
  });

  const bm =
    options.browser ??
    new PlaywrightBrowserManager({
      userDataRoot: config.profileRoot,
      headless: options.headless ?? config.headless,
      userAgent: config.userAgent,
    });
  const providers = options.providers ?? createProviders(bm);
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const defaultModel = `${providers[0]!.id}/${providers[0]!.models[0]!.id}`;

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Preflight requests never carry credentials; @fastify/cors answers them.
    if (request.method === "OPTIONS") return;
    const path = request.url.split("?")[0]!;
    if (path === "/health") return;
    if (isAuthorized(request.headers.authorization)) return;
    await reply.code(401).send({
      error: { message: "invalid api key", type: "invalid_request_error", code: "invalid_api_key" },
    });
  });

  app.get("/health", async () => ({
    ok: true,
    name: "web-agents-to",
    version: VERSION,
    uptime_s: Math.round(process.uptime()),
    providers: providers.map((provider) => provider.id),
  }));

  app.get("/status", async () => ({
    ok: true,
    version: VERSION,
    headless: options.headless ?? config.headless,
    providers: await Promise.all(providers.map((provider) => provider.status?.())),
  }));

  app.get("/v1/models", async () => {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: "list",
      data: providers.flatMap((provider) =>
        provider.models.map((model) => ({
          id: `${provider.id}/${model.id}`,
          object: "model",
          created,
          owned_by: model.owned_by,
          provider: provider.id,
        }))
      ),
    };
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
          .join("; ")
      );
    }

    const body = parsed.data as ChatCompletionRequest;
    const requestedModel = body.model ?? defaultModel;
    const { provider, model } = resolveModel(requestedModel, providers, providerMap);
    const chatRequest: ChatCompletionRequest = { ...body, model };

    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort(new RequestAbortedError());
    });

    if (body.stream) {
      await streamCompletion(reply, provider, chatRequest, requestedModel, abort.signal);
      return;
    }

    return collectCompletion(provider, chatRequest, requestedModel, abort.signal);
  });

  const loginInFlight = new Set<string>();
  app.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError("provider must be a string");
    const providerId = parsed.data?.provider ?? providers[0]!.id;
    const provider = providerMap.get(providerId);
    if (!provider?.login) {
      throw new ValidationError(`provider "${providerId}" does not support login`);
    }
    if (loginInFlight.has(providerId)) {
      return reply.code(409).send({
        error: {
          message: `a login window for ${providerId} is already open`,
          type: "invalid_request_error",
          code: "login_in_progress",
        },
      });
    }

    loginInFlight.add(providerId);
    void provider
      .login(true)
      .catch((error) => request.log.error(error))
      .finally(() => loginInFlight.delete(providerId));

    return reply.code(202).send({
      ok: true,
      provider: providerId,
      message: `Opened a browser for ${providerId}. Sign in, then close the window.`,
    });
  });

  app.post("/auth/logout", async (request) => {
    const parsed = loginSchema.safeParse(request.body ?? {});
    const providerId = parsed.success ? parsed.data?.provider ?? providers[0]!.id : providers[0]!.id;
    const provider = providerMap.get(providerId);
    if (!provider?.close) throw new ValidationError(`provider "${providerId}" not found`);
    await provider.close();
    return { ok: true, provider: providerId };
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({
      error: {
        message: `no route for ${request.method} ${request.url.split("?")[0]}`,
        type: "invalid_request_error",
        code: "not_found",
      },
    })
  );

  app.setErrorHandler(async (error, request, reply) => {
    const { statusCode, body } = toErrorBody(error);
    if (statusCode >= 500) request.log.error(error);
    else request.log.warn(`${statusCode} ${body.error.message}`);
    return reply.code(statusCode).send(body);
  });

  app.addHook("onClose", async () => {
    await bm.close();
  });

  return { app, providers, browser: bm };
}

/** Backwards-compatible helper used by scripts and tests. */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  return (await createServer(options)).app;
}

function isAuthorized(header: unknown): boolean {
  return safeEqual(bearerToken(header), config.apiKey);
}

export function resolveModel(
  requested: string,
  providers: Provider[],
  providerMap: Map<string, Provider>
): { provider: Provider; model: string } {
  const [maybeProvider, ...rest] = requested.split("/");
  const provider = providerMap.get(maybeProvider!);
  if (provider) {
    const modelId = rest.join("/");
    if (!modelId) return { provider, model: provider.models[0]!.id };
    return { provider, model: modelId };
  }

  const byModel = providers.find((candidate) => candidate.models.some((model) => model.id === requested));
  if (byModel) return { provider: byModel, model: requested };

  throw new ValidationError(
    `unknown model "${requested}". Try one of: ${providers
      .flatMap((candidate) => candidate.models.map((model) => `${candidate.id}/${model.id}`))
      .join(", ")}`
  );
}

async function streamCompletion(
  reply: FastifyReply,
  provider: Provider,
  request: ChatCompletionRequest,
  requestedModel: string,
  signal: AbortSignal
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": web-agents-to stream\n\n");

  const includeUsage = request.stream_options?.include_usage === true;
  const wantTools = Boolean(config.nativeTools && request.tools?.length);
  let streamed = "";

  try {
    if (wantTools) {
      // Tool calls only exist once the whole block was generated, so buffer.
      let text = "";
      let meta = { id: "", created: 0 };
      for await (const chunk of provider.chat(request, signal)) {
        meta = { id: chunk.id, created: chunk.created };
        text += chunk.choices[0]?.delta?.content ?? "";
      }
      streamed = text;
      const calls = parseToolCalls(text);
      if (calls.length > 0) {
        reply.raw.write(
          encodeSSE({
            id: meta.id,
            object: "chat.completion.chunk",
            created: meta.created,
            model: requestedModel,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: null, tool_calls: toNativeDeltas(calls) },
                finish_reason: "tool_calls",
              },
            ],
          })
        );
      } else {
        reply.raw.write(
          encodeSSE({
            id: meta.id,
            object: "chat.completion.chunk",
            created: meta.created,
            model: requestedModel,
            choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
          })
        );
        reply.raw.write(
          encodeSSE({
            id: meta.id,
            object: "chat.completion.chunk",
            created: meta.created,
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })
        );
      }
    } else {
      for await (const chunk of provider.chat(request, signal)) {
        streamed += chunk.choices[0]?.delta?.content ?? "";
        reply.raw.write(encodeSSE({ ...chunk, model: requestedModel }));
      }
    }

    if (includeUsage) {
      const promptTokens = countPromptTokens(request.messages as ChatMessage[]);
      const completionTokens = estimateTokens(streamed);
      reply.raw.write(
        encodeSSE({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        })
      );
    }
  } catch (error) {
    const { body } = toErrorBody(error);
    if (!reply.raw.writableEnded) {
      reply.raw.write(encodeSSEError(body.error.message, body.error.hint));
    }
  } finally {
    if (!reply.raw.writableEnded) {
      reply.raw.write(SSE_DONE);
      reply.raw.end();
    }
  }
}

function toNativeDeltas(calls: ReturnType<typeof parseToolCalls>) {
  return toOpenAIToolCalls(calls).map((call, index) => ({
    index,
    id: call.id,
    type: call.type,
    function: call.function,
  }));
}

async function collectCompletion(
  provider: Provider,
  request: ChatCompletionRequest,
  requestedModel: string,
  signal: AbortSignal
) {
  let content = "";
  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);

  for await (const chunk of provider.chat(request, signal)) {
    id = chunk.id;
    created = chunk.created;
    content += chunk.choices[0]?.delta?.content ?? "";
  }

  const toolCalls = config.nativeTools && request.tools?.length ? parseToolCalls(content) : [];
  const promptTokens = countPromptTokens(request.messages as ChatMessage[]);

  if (toolCalls.length > 0) {
    const prose = stripToolCalls(content);
    const completionTokens = estimateTokens(content);
    return {
      id,
      object: "chat.completion" as const,
      created,
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: prose || null,
            tool_calls: toOpenAIToolCalls(toolCalls),
          },
          finish_reason: "tool_calls" as const,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  const completionTokens = estimateTokens(content);
  return {
    id,
    object: "chat.completion" as const,
    created,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content },
        finish_reason: "stop" as const,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}
