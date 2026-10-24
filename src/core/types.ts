/**
 * Shared types. The request/response shapes intentionally mirror the OpenAI
 * chat-completions API so existing SDKs can talk to this server unchanged.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

/** Accepts content shapes produced by other OpenAI-compatible clients. */
export type ContentPart =
  | TextContentPart
  | ImageContentPart
  | { type: string; text?: string; image_url?: { url: string } };

export type MessageContent = string | ContentPart[] | null;

export interface ChatMessage {
  role: Role;
  content: MessageContent;
  name?: string;
  tool_call_id?: string;
}

export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
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
  tools?: OpenAITool[];
  tool_choice?: unknown;
  stream_options?: { include_usage?: boolean };
  /** Unknown fields from callers are preserved, never forwarded blindly to the site. */
  [key: string]: unknown;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "error" | null;

export interface ChatCompletionChoice {
  index: number;
  message?: AssistantMessage;
  delta?: Partial<AssistantMessage> & { role?: "assistant" };
  finish_reason: FinishReason;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion" | "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
}

export type ChatChunk = ChatCompletionResponse;

export interface ProviderModel {
  id: string;
  name: string;
  owned_by: string;
}

export interface BrowserStatus {
  launched: boolean;
  headed: boolean;
  pages: number;
}

export interface QueueStatus {
  active: number;
  waiting: number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  models: ProviderModel[];
  browser: BrowserStatus;
  queue: QueueStatus;
}

export interface Provider {
  id: string;
  name: string;
  models: ProviderModel[];
  /** Optional warm-up hook; must not launch a browser unless it needs to. */
  init?(): Promise<void>;
  /** Send a chat and yield streamed chunks (OpenAI shape). */
  chat(req: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk>;
  /** Optional manual login flow (opens a headed browser). */
  login?(headed: boolean): Promise<void>;
  status?(): ProviderStatus | Promise<ProviderStatus>;
  close?(): Promise<void>;
}
