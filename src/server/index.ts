import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { config } from "../config/index.js";
import { contextBudget } from "../core/budget.js";
import { contextStats, contextTokensFor } from "../core/context-stats.js";
import { createOutputGate, gateOptions } from "../core/output-gate.js";
import { PlaywrightBrowserManager } from "../browser/manager.js";
import { createProviders } from "../providers/registry.js";
import { RequestAbortedError, ValidationError, toErrorBody } from "../core/errors.js";
import { encodeSSE, encodeSSEError, SSE_DONE } from "../core/sse.js";
import { estimateTokens, newId } from "../core/utils.js";
import {
  parseToolCallsDetailed,
  stripToolCalls,
  toOpenAIToolCalls,
  ToolCallSuppressor,
  toolNamesFromTools,
  toolSchemasFromTools,
  type ParsedToolCall,
} from "../core/toolcalls.js";
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
  parallel_tool_calls: z.boolean().optional(),
  response_format: z
    .object({ type: z.string().optional(), json_schema: z.unknown().optional() })
    .optional(),
  n: z.number().int().optional(),
  seed: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  reasoning_effort: z.string().optional(),
});

/** Parameters the page cannot honour; accepted so clients never error on them. */
const IGNORED_FIELDS = ["temperature", "top_p", "seed", "presence_penalty", "frequency_penalty", "reasoning_effort"] as const;

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
      userDataRoot: config.profileRoot ?? path.join(config.dataRoot, "profiles"),
      headless: options.headless ?? config.headless,
      userAgent: config.userAgent,
      executablePath: config.chromiumExecutable,
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
    context: await (async () => {
      const budget = contextBudget(bm.dataRoot());
      const learned = budget.status();
      return {
        ...contextStats(budget.chars()),
        configuredChars: learned.configuredChars,
        ceilingChars: learned.ceilingChars,
        growthSteps: learned.growthSteps,
        autoGrown: learned.budgetChars > learned.configuredChars,
      };
    })(),
    headless: options.headless ?? config.headless,
    providers: await Promise.all(
      providers.map(async (provider) => ({
        ...(provider.status?.() ?? {}),
        session: await Promise.resolve(provider.session?.()).catch(() => undefined),
      }))
    ),
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
          // Some clients size their own context window from this.
          context_length: contextTokensFor(contextBudget(bm.dataRoot()).chars()),
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
    if (body.n !== undefined && body.n !== 1) {
      throw new ValidationError("n > 1 is not supported: the web chat produces one answer per request");
    }

    const ignored = IGNORED_FIELDS.filter((field) => body[field] !== undefined);
    if (ignored.length > 0) {
      request.log.debug(`ignoring parameters the web chat cannot honour: ${ignored.join(", ")}`);
    }

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

  /**
   * Session health. Without `probe` this never starts a browser — it reports
   * cookie lifetime and whether the last automatic login was abandoned.
   */
  app.get("/auth/session", async (request) => {
    const query = request.query as { provider?: string; probe?: string };
    const provider = providerMap.get(query.provider ?? providers[0]!.id);
    if (!provider) throw new ValidationError(`provider "${query.provider}" not found`);

    const wantProbe = query.probe === "1" || query.probe === "true";
    if (wantProbe) {
      if (!provider.probeSession) throw new ValidationError("provider does not support probing");
      return { ok: true, provider: provider.id, probe: true, session: await provider.probeSession() };
    }

    return {
      ok: true,
      provider: provider.id,
      probe: false,
      session: (await provider.session?.()) ?? { checked: false },
    };
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

/**
 * Resolve whatever the client sent into a provider + model id.
 *
 * Clients are inconsistent: opencode may send the configured key
 * (`mimo-v2.6-pro`), a provider-prefixed id (`mimo/mimo-v2.6-pro`), the label
 * from our generated config (`web-agents-to/mimo-v2.6-pro`) or a different
 * case. All of those must work, or the model looks broken from opencode.
 */
export function resolveModel(
  requested: string,
  providers: Provider[],
  providerMap: Map<string, Provider>
): { provider: Provider; model: string } {
  const raw = requested.trim();
  const all = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model: model.id }))
  );

  // A provider we know, optionally followed by a model.
  const [head, ...rest] = raw.split("/");
  const knownProvider = providerMap.get(head!) ?? providerMap.get(head!.toLowerCase());
  const restId = rest.join("/");
  if (knownProvider) {
    if (!restId) return { provider: knownProvider, model: knownProvider.models[0]!.id };
    const match =
      knownProvider.models.find((model) => model.id === restId) ??
      knownProvider.models.find((model) => model.id.toLowerCase() === restId.toLowerCase());
    return { provider: knownProvider, model: match?.id ?? restId };
  }

  // Exact model id.
  const exact = all.find((entry) => entry.model === raw);
  if (exact) return exact;

  // Provider label we generated (e.g. `web-agents-to`) or any unknown prefix:
  // fall back to matching the model part.
  if (restId) {
    const bySuffix = all.find((entry) => entry.model === restId);
    if (bySuffix) return bySuffix;
  }

  // Case-insensitive, with or without a prefix.
  const lower = raw.toLowerCase();
  const insensitive =
    all.find((entry) => entry.model.toLowerCase() === lower) ??
    all.find((entry) => `${entry.provider.id}/${entry.model}`.toLowerCase() === lower) ??
    all.find((entry) => restId && entry.model.toLowerCase() === restId.toLowerCase());
  if (insensitive) return insensitive;

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
  const toolsEnabled = Boolean(config.nativeTools && request.tools?.length);
  const allowedTools = toolNamesFromTools(request.tools);
  const toolSchemas = toolSchemasFromTools(request.tools);

  const gate = createOutputGate(gateOptions(request));
  let streamed = "";
  let id = newId("chatcmpl");
  let created = Math.floor(Date.now() / 1000);
  let roleSent = false;

  // Long generation steps must not look like a dead socket to the client.
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
  }, 15_000);
  heartbeat.unref?.();

  const writeText = (text: string) => {
    if (!text) return;
    streamed += text;
    reply.raw.write(
      encodeSSE({
        id,
        object: "chat.completion.chunk",
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            delta: roleSent ? { content: text } : { role: "assistant", content: text },
            finish_reason: null,
          },
        ],
      })
    );
    roleSent = true;
  };

  const writeFinish = (reason: "stop" | "tool_calls" | "length") => {
    // A dedicated finish frame: clients (and opencode's parser) reject any
    // content delta that arrives after a finish_reason.
    reply.raw.write(
      encodeSSE({
        id,
        object: "chat.completion.chunk",
        created,
        model: requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
      })
    );
  };

  try {
    const suppressor = toolsEnabled ? new ToolCallSuppressor() : undefined;

    for await (const chunk of provider.chat(request, signal)) {
      id = chunk.id || id;
      created = chunk.created || created;
      const delta = chunk.choices[0]?.delta?.content;
      if (!delta) continue;

      if (!suppressor) {
        const out = gate.push(delta);
        if (out) writeText(out);
        if (gate.done) break;
        continue;
      }

      const emitted = gate.push(suppressor.push(delta));
      writeText(emitted);
      if (gate.done) break;
    }

    const tail = gate.finish();
    if (tail) writeText(tail);

    if (!suppressor) {
      // Plain text path: deltas above, terminator here.
      writeFinish(gate.reason === "length" ? "length" : "stop");
    } else {
      writeText(suppressor.finish());

      const { calls, dropped } = parseToolCallsDetailed(suppressor.fullText, {
        allowedTools,
        toolSchemas,
      });

      if (calls.length > 0) {
        for (const [index, call] of calls.entries()) {
          reply.raw.write(
            encodeSSE({
              id,
              object: "chat.completion.chunk",
              created,
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [toToolCallDelta(call, index)] },
                  finish_reason: null,
                },
              ],
            })
          );
        }
        writeFinish("tool_calls");
      } else {
        if (dropped.length > 0) {
          writeText(toolDropNote(dropped));
        } else if (/<tool_call[\s>]/i.test(suppressor.fullText)) {
          // Truncated block: no closing tag, so nothing can be executed.
          writeText(
            "\n[tool call was incomplete — the block was not closed. Reply again with one complete block.]"
          );
        }
        writeFinish(gate.reason === "length" ? "length" : "stop");
      }
    }

    if (includeUsage) {
      const promptTokens = countPromptTokens(request.messages as ChatMessage[]);
      const completionTokens = estimateTokens(streamed);
      reply.raw.write(
        encodeSSE({
          id,
          object: "chat.completion.chunk",
          created,
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
    clearInterval(heartbeat);
    if (!reply.raw.writableEnded) {
      reply.raw.write(SSE_DONE);
      reply.raw.end();
    }
  }
}

/** One OpenAI tool-call delta. `id`/`type`/`name` must be complete per call. */
function toToolCallDelta(call: ParsedToolCall, index: number) {
  return {
    index,
    id: newId("call", "_"),
    type: "function" as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.args ?? {}),
    },
  };
}

/**
 * Surface a rejected tool call to the model instead of failing the whole step.
 *
 * The message shows the offending text and the exact shape we accept: a model
 * that used the wrong markup can only fix it if it is told what it wrote.
 */
function toolDropNote(dropped: ParsedToolCall[]): string {
  const details = dropped
    .slice(0, 2)
    .map((call) => `${call.name}: ${call.parseError ?? "invalid tool call"}`)
    .join("; ");
  const example = dropped[0]?.name && dropped[0].name !== "(unknown)" ? dropped[0].name : "bash";
  return (
    `\n[tool call could not be read — ${details}.\n` +
    `Send it again in exactly this form, one block, nothing else:\n` +
    `<tool_call name="${example}">{"command": "dir"}</tool_call>]`
  );
}

async function collectCompletion(
  provider: Provider,
  request: ChatCompletionRequest,
  requestedModel: string,
  signal: AbortSignal
) {
  let content = "";
  let id = newId("chatcmpl");
  let created = Math.floor(Date.now() / 1000);

  for await (const chunk of provider.chat(request, signal)) {
    id = chunk.id || id;
    created = chunk.created || created;
    content += chunk.choices[0]?.delta?.content ?? "";
  }

  const toolsEnabled = Boolean(config.nativeTools && request.tools?.length);
  const { calls, dropped } = toolsEnabled
    ? parseToolCallsDetailed(content, {
        allowedTools: toolNamesFromTools(request.tools),
        toolSchemas: toolSchemasFromTools(request.tools),
      })
    : { calls: [], dropped: [] };

  const gate = createOutputGate(gateOptions(request));
  const gatedText = `${gate.push(content)}${gate.finish()}`;
  const finishReason: "stop" | "length" = gate.reason === "length" ? "length" : "stop";

  const promptTokens = countPromptTokens(request.messages as ChatMessage[]);
  const usage = (text: string) => {
    const completionTokens = estimateTokens(text);
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  };

  if (calls.length > 0) {
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
            content: stripToolCalls(gatedText) || null,
            tool_calls: toOpenAIToolCalls(calls),
          },
          finish_reason: "tool_calls" as const,
        },
      ],
      usage: usage(content),
    };
  }

  const prose =
    dropped.length > 0 ? `${stripToolCalls(gatedText)}${toolDropNote(dropped)}` : gatedText;
  return {
    id,
    object: "chat.completion" as const,
    created,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: prose },
        finish_reason: finishReason,
      },
    ],
    usage: usage(prose),
  };
}
