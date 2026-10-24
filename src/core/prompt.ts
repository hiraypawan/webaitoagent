import type { ChatMessage, MessageContent, OpenAITool } from "./types.js";
import { hashString, truncateMiddle } from "./utils.js";

export interface BuildPromptOptions {
  tools?: OpenAITool[];
  /** OpenAI `tool_choice`: "none" | "auto" | "required" | {function:{name}} */
  toolChoice?: unknown;
  /** Hard cap on prompt size; the middle is elided when exceeded. */
  maxChars?: number;
  /** Extra instructions appended on top of the system prompt. */
  systemAppend?: string;
  /** Ask for a bare JSON object (OpenAI `response_format: {type:"json_object"}`). */
  jsonMode?: boolean;
  /** Called when the mobile-friendly character budget forced an elision. */
  onTrim?: (info: { dropped: number; max: number }) => void;
}

/** Apply the character budget and report (never hide) what was dropped. */
function applyLimit(text: string, maxChars: number, onTrim?: BuildPromptOptions["onTrim"]): string {
  if (text.length <= maxChars) return text;
  onTrim?.({ dropped: text.length - maxChars, max: maxChars });
  return truncateMiddle(text, maxChars);
}

/** Flatten any OpenAI content shape into plain text. */
export function contentToText(content: MessageContent): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      if ((part as { image_url?: unknown }).image_url) return "[image omitted]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function roleLine(message: ChatMessage): string {
  const text = contentToText(message.content);
  const name = message.name ? ` (${message.name})` : "";
  switch (message.role) {
    case "system":
      return `System: ${text}`;
    case "assistant":
      return `Assistant: ${text}`;
    case "tool":
      return `Tool result${name}:\n${text}`;
    case "user":
    default:
      return `User: ${text}`;
  }
}

export function formatToolsForPrompt(tools?: OpenAITool[], toolChoice?: unknown): string {
  if (!tools?.length) return "";

  const names: string[] = [];
  const specs = tools
    .map((tool) => {
      const fn = tool?.function;
      if (!fn?.name) return "";
      names.push(fn.name);
      const description = fn.description ? ` — ${fn.description.replace(/\s+/g, " ").trim()}` : "";
      const params = fn.parameters ? `\n  parameters: ${JSON.stringify(fn.parameters)}` : "";
      return `- ${fn.name}${description}${params}`;
    })
    .filter(Boolean)
    .join("\n");

  if (!specs) return "";

  const choice = toolChoiceText(toolChoice, names[0]);

  return [
    "",
    "=== TOOLS ===",
    "You are running inside an agent harness that executes tools for you.",
    "Call a tool whenever it would give you real information or change files —",
    "do not guess file contents, command output, or project structure.",
    "",
    "Available tools:",
    specs,
    "",
    "TO CALL A TOOL, reply with exactly one block and nothing else:",
    '<tool_call name="TOOL_NAME">{"parameter": "value"}</tool_call>',
    "",
    "Example:",
    '<tool_call name="bash">{"command": "ls -la"}</tool_call>',
    "",
    "Tool-call rules:",
    `- Use only these names: ${names.join(", ")}. Never invent a tool name.`,
    "- The JSON must be valid, use double quotes, and include every required parameter.",
    "- One tool call per reply. Stop after the block; the result comes back to you.",
    "- Do not wrap the block in markdown fences and do not explain it.",
    "- When the task is complete, answer in plain text with no tool_call block.",
    choice,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Continuations only need a reminder: the full spec is already in the
 * conversation the site is holding. Re-sending schemas every agent step wastes
 * a large slice of the context window and re-reads the instructions to the
 * model on every turn.
 */
export function formatToolReminder(tools?: OpenAITool[], toolChoice?: unknown): string {
  if (!tools?.length) return "";
  const names = tools.map((tool) => tool?.function?.name).filter(Boolean);
  if (names.length === 0) return "";
  const choice = toolChoiceText(toolChoice, names[0]);
  return [
    "",
    `Tools (unchanged): ${names.join(", ")}. Call one with ` +
      '<tool_call name="NAME">{"param":"value"}</tool_call> and stop; otherwise answer in plain text.',
    ...(choice ? [choice] : []),
  ].join("\n");
}

function toolChoiceText(toolChoice: unknown, firstTool?: string): string {
  if (toolChoice === "required" || (typeof toolChoice === "object" && toolChoice !== null && "function" in toolChoice)) {
    const named =
      typeof toolChoice === "object" && toolChoice !== null
        ? (toolChoice as { function?: { name?: string } }).function?.name
        : undefined;
    return `- You MUST call a tool in this reply${named ? ` (use "${named}")` : firstTool ? ` (e.g. "${firstTool}")` : ""}.`;
  }
  if (toolChoice === "none") return "- Tools are disabled for this reply; answer in plain text.";
  return "";
}

/**
 * Build the prompt for a fresh conversation: the whole history is flattened,
 * because the web UI has no idea what OpenAI message roles are.
 */
const JSON_INSTRUCTION =
  "- Reply with one valid JSON object and nothing else: no prose, no markdown fences.";

export function buildPrompt(messages: ChatMessage[], opts: BuildPromptOptions = {}): string {
  const maxChars = opts.maxChars ?? 120_000;
  const lines = messages.map(roleLine).filter((line) => line.trim().length > 0);
  if (opts.systemAppend?.trim()) lines.unshift(`System: ${opts.systemAppend.trim()}`);

  const tools = formatToolsForPrompt(opts.tools, opts.toolChoice);
  const body = lines.join("\n");
  const json = opts.jsonMode ? `\n${JSON_INSTRUCTION}` : "";
  const prompt = `${body}${tools}${json}\nAssistant:`;
  return applyLimit(prompt, maxChars, opts.onTrim);
}

/**
 * Prompt for a follow-up turn in an existing browser conversation: the site
 * already holds the history, so only the new user turn (or trailing tool
 * results) needs to be sent. Sending the whole history again would make the
 * model answer its own earlier replies.
 */
export function buildContinuationPrompt(
  messages: ChatMessage[],
  opts: BuildPromptOptions = {}
): string {
  const maxChars = opts.maxChars ?? 120_000;
  const tools = formatToolReminder(opts.tools, opts.toolChoice);

  const trailing: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant") break;
    if (message.role === "system") continue;
    trailing.unshift(message);
  }

  let prompt: string;
  if (trailing.length === 0) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    prompt = lastUser ? contentToText(lastUser.content) : "";
  } else {
    prompt = trailing.map(roleLine).join("\n");
  }

  const json = opts.jsonMode ? `\n${JSON_INSTRUCTION}` : "";
  return applyLimit(`${prompt}${tools}${json}`, maxChars, opts.onTrim);
}

/**
 * Identity of a conversation: system prompt + first user turn. When this
 * changes we must click "new conversation" instead of continuing the page.
 */
export function conversationKey(messages: ChatMessage[]): string {
  const system = messages.find((m) => m.role === "system");
  const firstUser = messages.find((m) => m.role === "user");
  return hashString(`${contentToText(system?.content ?? "")}\u0000${contentToText(firstUser?.content ?? "")}`);
}

export function countPromptTokens(messages: ChatMessage[]): number {
  return Math.max(1, Math.ceil(buildPrompt(messages).length / 4));
}
