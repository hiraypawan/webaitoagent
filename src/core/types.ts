import type { Browser, BrowserContext, Page } from "playwright";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  user?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message?: { role: "assistant"; content: string };
  delta?: { role?: "assistant"; content?: string };
  finish_reason: "stop" | "length" | "error" | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion" | "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export type ChatChunk = ChatCompletionResponse;

export interface ProviderModel {
  id: string;
  name: string;
  owned_by: string;
}

export interface Provider {
  id: string;
  name: string;
  models: ProviderModel[];
  /** Ensure browser session ready; may open headed browser for login. */
  init(ctx: BrowserContext): Promise<void>;
  /** Send a chat and yield streamed chunks (OpenAI shape). */
  chat(req: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk>;
  /** Optional manual login flow. */
  login?(headed: boolean): Promise<void>;
}

export interface BrowserManager {
  context(providerId: string): Promise<BrowserContext>;
  close(): Promise<void>;
}