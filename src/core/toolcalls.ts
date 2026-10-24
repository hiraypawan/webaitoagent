import type { OpenAIToolCall } from "./types.js";
import { newId } from "./utils.js";

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
  /** Present when the model produced invalid JSON inside the block. */
  parseError?: string;
}

/** `<tool_call name="x">{...}</tool_call>` */
const NAMED_BLOCK = /<tool_call\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/tool_call>/gi;
/** `<tool_call>{"name":"x","arguments":{...}}</tool_call>` */
const GENERIC_BLOCK = /<tool_call\s*>\s*([\s\S]*?)\s*<\/tool_call>/gi;

/**
 * Extract tool calls from a web model's plain-text answer.
 * Web UIs cannot do native function calling, so agents use this text protocol.
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  if (!text || !text.includes("<tool_call")) return [];
  const calls: ParsedToolCall[] = [];

  for (const match of text.matchAll(NAMED_BLOCK)) {
    const name = match[1]!;
    const body = (match[2] ?? "").trim();
    calls.push({ name, ...parseArgs(body), raw: match[0] });
  }

  for (const match of text.matchAll(GENERIC_BLOCK)) {
    const body = (match[1] ?? "").trim();
    const parsed = parseArgs(body);
    const name = typeof parsed.args.name === "string" ? parsed.args.name : "";
    if (!name) continue;
    const args = normaliseArgs(parsed.args);
    calls.push({
      name,
      args,
      raw: match[0],
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    });
  }

  return calls;
}

function normaliseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { name: _name, arguments: inner, ...rest } = args;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  if (typeof inner === "string") {
    const parsed = tryParseObject(inner);
    if (parsed) return parsed;
  }
  return rest;
}

function parseArgs(body: string): { args: Record<string, unknown>; parseError?: string } {
  const parsed = tryParseObject(body);
  if (parsed) return { args: parsed };
  return { args: {}, parseError: "tool arguments were not valid JSON" };
}

function tryParseObject(value: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Remove tool-call blocks so clients only see the prose answer. */
export function stripToolCalls(text: string): string {
  return text
    .replace(NAMED_BLOCK, "")
    .replace(GENERIC_BLOCK, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasToolCalls(text: string): boolean {
  return /<tool_call[\s>]/i.test(text);
}

/** Convert parsed text-protocol calls into OpenAI `tool_calls`. */
export function toOpenAIToolCalls(calls: ParsedToolCall[]): OpenAIToolCall[] {
  return calls.map((call) => ({
    id: newId("call", "_"),
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.args ?? {}),
    },
  }));
}
