import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, isLoopbackHost } from "../config/index.js";
import { iterateSSEData, parseSSEData } from "../core/sse.js";
import type { ChatMessage, OpenAITool, OpenAIToolCall, ProviderModel } from "../core/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function baseUrl(): string {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  const host = isLoopbackHost(config.host) ? config.host : "127.0.0.1";
  return `http://${host}:${config.port}`;
}

export function apiKey(): string {
  return process.env.API_KEY ?? config.apiKey;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request(pathname: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(baseUrl() + pathname, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code: string | undefined;
    let hint: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string; hint?: string };
      };
      message = body.error?.message ?? message;
      code = body.error?.code;
      hint = body.error?.hint;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, response.status, code, hint);
  }

  return response;
}

export async function health(): Promise<{ ok: boolean; version?: string }> {
  const response = await fetch(baseUrl() + "/health");
  if (!response.ok) throw new ApiError("server unhealthy", response.status);
  return (await response.json()) as { ok: boolean; version?: string };
}

export async function listModels(): Promise<ProviderModel[]> {
  const response = await request("/v1/models");
  const body = (await response.json()) as {
    data: { id: string; owned_by: string; provider?: string }[];
  };
  return body.data.map((model) => ({
    id: model.id,
    name: model.id,
    owned_by: model.owned_by,
  }));
}

export async function login(provider = "mimo"): Promise<string> {
  const response = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
  const body = (await response.json()) as { message?: string };
  return body.message ?? "login window opened";
}

export async function logout(provider = "mimo"): Promise<string> {
  const response = await request("/auth/logout", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
  const body = (await response.json()) as { ok?: boolean };
  return body.ok ? `Closed the ${provider} browser session.` : "no session closed";
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: OpenAITool[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface ChatResult {
  content: string;
  toolCalls: OpenAIToolCall[];
  finishReason: string | null;
}

/** Stream a chat completion and assemble the full answer. */
export async function chat(options: ChatOptions): Promise<ChatResult> {
  const response = await request("/v1/chat/completions", {
    method: "POST",
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
      ...(options.tools?.length ? { tools: options.tools } : {}),
    }),
  });

  if (!response.body) throw new ApiError("the server returned an empty stream", 500);

  let content = "";
  const toolCalls: OpenAIToolCall[] = [];
  let finishReason: string | null = null;

  for await (const data of iterateSSEData(response.body as unknown as AsyncIterable<Uint8Array>)) {
    const payload = parseSSEData(data) as
      | {
          error?: { message?: string };
          choices?: {
            delta?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
            finish_reason?: string | null;
          }[];
        }
      | undefined;
    if (!payload) continue;
    if (payload.error?.message) throw new ApiError(payload.error.message, 502);

    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta?.content;
    if (delta) {
      content += delta;
      options.onDelta?.(delta);
    }
    if (choice.delta?.tool_calls?.length) toolCalls.push(...choice.delta.tool_calls);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  return { content, toolCalls, finishReason };
}

/**
 * Start the API server in the background when it is not running yet.
 * Returns true when a healthy server is reachable.
 */
export async function ensureServer(options: { quiet?: boolean } = {}): Promise<boolean> {
  try {
    await health();
    return true;
  } catch {
    // fall through to spawn
  }

  if (!options.quiet) console.log("Starting web-agents-to server...");

  // Prefer the TypeScript entrypoint in a dev checkout, fall back to the
  // compiled build when the CLI is installed without dev dependencies.
  const tsxEntry = path.join(root, "src", "server", "main.ts");
  const distEntry = path.join(root, "dist", "server", "main.js");
  const hasTsx = fs.existsSync(path.join(root, "node_modules", "tsx"));
  const args = hasTsx && fs.existsSync(tsxEntry) ? ["--import", "tsx", tsxEntry] : [distEntry];

  if (!hasTsx && !fs.existsSync(distEntry)) {
    console.error("No server entrypoint found. Run `npm run build` (or `npm install` in a dev checkout).");
    return false;
  }

  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
  });
  child.on("error", () => {});
  child.unref();

  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await health();
      if (!options.quiet) console.log("Server ready.\n");
      return true;
    } catch {
      // keep waiting
    }
  }

  console.error(`Server did not become healthy at ${baseUrl()}. Start it manually with: npm run dev`);
  return false;
}
