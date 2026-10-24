import type { OpenAITool, OpenAIToolCall } from "./types.js";
import { newId } from "./utils.js";

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
  /** Present when the arguments could not be parsed or repaired. */
  parseError?: string;
  /** Present when the name was mapped onto a different declared tool. */
  renamedFrom?: string;
}

export interface ParseToolCallsOptions {
  /** Tool names declared in the request; anything else is rejected. */
  allowedTools?: string[];
  /** JSON schema per tool, used to sanity-check and normalise parameters. */
  toolSchemas?: Record<string, { required?: string[]; properties?: string[] } | undefined>;
  /** Extra name mappings, e.g. `{ shell: "bash" }`. */
  aliases?: Record<string, string>;
}

export interface ToolCallParseResult {
  calls: ParsedToolCall[];
  /** Calls that were recognised but cannot be executed safely. */
  dropped: ParsedToolCall[];
}

/** `<tool_call name="x">{...}</tool_call>` */
const NAMED_BLOCK = /<tool_call\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)<\/tool_call>/gi;
/** `<tool_call>{"name":"x","arguments":{...}}</tool_call>` */
const GENERIC_BLOCK = /<tool_call\s*>\s*([\s\S]*?)<\/tool_call>/gi;
/** Fenced JSON blocks, optionally annotated as a tool call. */
const FENCED_BLOCK = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/gi;
/** `bash({"command":"ls"})` */
const CALL_LIKE = /^([a-zA-Z_][\w.-]*)\s*\(\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*\)$/;
const FENCE_LINE = /^```[a-zA-Z_]*$/;

/**
 * Names models reach for when they have seen other agent frameworks.
 * Only applied when the mapped tool actually exists in the request.
 */
const DEFAULT_ALIASES: Record<string, string> = {
  read_file: "read",
  readfile: "read",
  read_text_file: "read",
  open_file: "read",
  write_file: "write",
  writefile: "write",
  create_file: "write",
  edit_file: "edit",
  replace_in_file: "edit",
  apply_patch: "edit",
  modify_file: "edit",
  list_dir: "list",
  listdir: "list",
  list_files: "list",
  ls: "list",
  shell: "bash",
  run_command: "bash",
  exec: "bash",
  execute: "bash",
  command: "bash",
  cmd: "bash",
  search: "grep",
  grep_search: "grep",
  find: "glob",
  glob_search: "glob",
  fetch: "webfetch",
  web_fetch: "webfetch",
};

const PARAM_ALIASES: Record<string, string[]> = {
  command: ["cmd", "script", "shell_command", "command_line"],
  filePath: ["file_path", "filepath", "path", "filename", "file"],
  path: ["file_path", "filepath", "filePath", "dir", "directory"],
  content: ["text", "contents", "body", "data", "file_content"],
  oldString: ["old_string", "old", "search", "find", "target"],
  newString: ["new_string", "new", "replace", "replacement", "with"],
  pattern: ["query", "search", "regex", "term"],
  description: ["desc", "summary"],
};

/** Extract tool calls from a web model's plain answer. */
export function parseToolCalls(text: string, options: ParseToolCallsOptions = {}): ParsedToolCall[] {
  return parseToolCallsDetailed(text, options).calls;
}

/**
 * Full parse: returns executable calls plus the ones that were recognised but
 * dropped (unknown tool, unparseable arguments, missing required field).
 *
 * Dropping is deliberate. A tool call with garbage arguments makes the agent
 * harness fail the whole step; letting the model retry from the text is safer.
 */
export function parseToolCallsDetailed(
  text: string,
  options: ParseToolCallsOptions = {}
): ToolCallParseResult {
  if (!text) return { calls: [], dropped: [] };

  const raws: { name: string; body: string; raw: string }[] = [];

  for (const match of text.matchAll(NAMED_BLOCK)) {
    raws.push({ name: match[1]!, body: (match[2] ?? "").trim(), raw: match[0] });
  }

  for (const match of text.matchAll(GENERIC_BLOCK)) {
    const body = (match[1] ?? "").trim();
    const parsed = jsonToolCall(body);
    if (parsed) raws.push({ name: parsed.name, body: JSON.stringify(parsed.args), raw: match[0] });
    else raws.push({ name: "", body, raw: match[0] });
  }

  if (raws.length === 0) {
    for (const call of implicitCalls(text, options)) raws.push(call);
  }

  const calls: ParsedToolCall[] = [];
  const dropped: ParsedToolCall[] = [];
  const seen = new Set<string>();

  for (const raw of raws) {
    const parsedBody = jsonToolCall(raw.body);
    const name = raw.name || parsedBody?.name || "";
    if (!name) {
      dropped.push({ name: "(unknown)", args: {}, raw: raw.raw, parseError: "no tool name" });
      continue;
    }

    const resolved = resolveToolName(name, options);
    if (!resolved) {
      dropped.push({ name, args: {}, raw: raw.raw, parseError: `unknown tool "${name}"` });
      continue;
    }

    let args = parsedBody?.args;
    if (!args) {
      const parsed = tryParseObject(raw.body);
      if (parsed) args = parsed;
    }
    if (!args) {
      dropped.push({ name: resolved, args: {}, raw: raw.raw, parseError: "arguments were not valid JSON" });
      continue;
    }

    args = coerceArgs(resolved, args, options);

    const missing = missingRequired(resolved, args, options);
    if (missing.length > 0) {
      dropped.push({
        name: resolved,
        args,
        raw: raw.raw,
        parseError: `missing required parameter(s): ${missing.join(", ")}`,
      });
      continue;
    }

    // Never emit the same call twice in one turn; harnesses run them serially.
    const signature = `${resolved}:${stableStringify(args)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

    calls.push({
      name: resolved,
      args,
      raw: raw.raw,
      ...(resolved !== name ? { renamedFrom: name } : {}),
    });
    if (calls.length >= 16) break;
  }

  return { calls, dropped };
}

function resolveToolName(name: string, options: ParseToolCallsOptions): string | undefined {
  const allowed = options.allowedTools;
  const aliases = { ...DEFAULT_ALIASES, ...(options.aliases ?? {}) };
  const requested = name.trim();

  if (!allowed || allowed.length === 0) return requested;

  const exact = allowed.find((tool) => tool === requested);
  if (exact) return exact;

  const insensitive = allowed.find((tool) => tool.toLowerCase() === requested.toLowerCase());
  if (insensitive) return insensitive;

  const alias = aliases[requested] ?? aliases[requested.toLowerCase()];
  if (alias) {
    const target = allowed.find((tool) => tool.toLowerCase() === alias.toLowerCase());
    if (target) return target;
  }

  return undefined;
}

function coerceArgs(
  tool: string,
  args: Record<string, unknown>,
  options: ParseToolCallsOptions
): Record<string, unknown> {
  const schema = options.toolSchemas?.[tool];
  const required = schema?.required ?? [];
  const properties = schema?.properties ?? [];
  const result: Record<string, unknown> = { ...args };

  for (const key of required) {
    if (result[key] !== undefined) continue;
    for (const candidate of PARAM_ALIASES[key] ?? []) {
      if (result[candidate] !== undefined) {
        result[key] = result[candidate];
        // Drop the alias when the tool does not declare it, so the harness does
        // not receive unknown parameters.
        if (properties.length > 0 && !properties.includes(candidate)) delete result[candidate];
        break;
      }
    }
  }

  // `arguments` sometimes arrives as a nested JSON string.
  if (typeof result.arguments === "string" && required.length > 0) {
    const nested = tryParseObject(result.arguments as string);
    if (nested) Object.assign(result, nested);
    delete result.arguments;
  }

  return result;
}

function missingRequired(
  tool: string,
  args: Record<string, unknown>,
  options: ParseToolCallsOptions
): string[] {
  const required = options.toolSchemas?.[tool]?.required ?? [];
  return required.filter((key) => args[key] === undefined || args[key] === null);
}

function implicitCalls(
  text: string,
  options: ParseToolCallsOptions
): { name: string; body: string; raw: string }[] {
  const trimmed = text.trim();
  const found: { name: string; body: string; raw: string }[] = [];

  // A fenced block or the whole message that is just one JSON object.
  for (const match of trimmed.matchAll(FENCED_BLOCK)) {
    const parsed = jsonToolCall((match[1] ?? "").trim());
    if (parsed) found.push({ name: parsed.name, body: JSON.stringify(parsed.args), raw: match[0] });
  }

  if (found.length === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    const parsed = jsonToolCall(trimmed);
    if (parsed) found.push({ name: parsed.name, body: JSON.stringify(parsed.args), raw: trimmed });
  }

  // `bash({...})`
  if (found.length === 0) {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 3) {
      for (const line of lines) {
        const match = CALL_LIKE.exec(line.replace(FENCE_LINE, "").trim());
        if (!match) continue;
        const args = tryParseObject(match[2]!);
        if (args) found.push({ name: match[1]!, body: JSON.stringify(args), raw: line });
      }
    }
  }

  // Without tags we are guessing: only keep names the client actually declared,
  // so an ordinary JSON answer is never mistaken for a tool call.
  const allowed = options.allowedTools;
  if (!allowed || allowed.length === 0) return found;
  return found.filter((call) => resolveToolName(call.name, options) !== undefined);
}

/**
 * Normalise the many JSON shapes models emit for a tool call:
 * `{name, arguments}`, `{tool, parameters}`, `{tool_name, input}`,
 * `{function: {name, arguments}}`, and an OpenAI `tool_calls` array.
 */
function jsonToolCall(body: string): { name: string; args: Record<string, unknown> } | undefined {
  const value = tryJson(body);
  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    const first = value[0];
    return first && typeof first === "object"
      ? jsonToolCall(JSON.stringify(first))
      : undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  const object = value as Record<string, unknown>;

  if (Array.isArray(object.tool_calls) && object.tool_calls.length > 0) {
    return jsonToolCall(JSON.stringify(object.tool_calls[0]));
  }

  if (object.function && typeof object.function === "object") {
    const fn = object.function as Record<string, unknown>;
    const name = firstString(fn.name, object.name);
    if (!name) return undefined;
    return { name, args: argsOf(fn.arguments ?? fn.parameters ?? fn.input ?? fn.args) };
  }

  const name = firstString(
    object.name,
    object.tool,
    object.tool_name,
    object.toolName,
    object.function_name,
    object.functionName
  );
  if (!name) return undefined;

  const args = argsOf(
    object.arguments ?? object.parameters ?? object.input ?? object.args ?? object.params ?? object.body
  );
  return { name, args };
}

function argsOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") return tryParseObject(value) ?? {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function tryJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to repair
  }
  try {
    return JSON.parse(repairJson(trimmed));
  } catch {
    // unrepairable: callers treat this as "no JSON here"
    return undefined;
  }
}

function tryParseObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = tryJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // unrepairable
  }
  return undefined;
}

/** Fix the usual model-authored JSON mistakes. */
export function repairJson(input: string): string {
  let text = input.trim();
  text = text.replace(/^```[a-zA-Z_]*\s*/u, "").replace(/```$/u, "").trim();

  // Keep only the outermost object/array.
  const firstBrace = text.search(/[[{]/);
  if (firstBrace > 0) text = text.slice(firstBrace);
  const lastBrace = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (lastBrace !== -1 && lastBrace < text.length - 1) text = text.slice(0, lastBrace + 1);

  text = text
    .replace(/\/\/[^\n\r]*/gu, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//gu, "") // block comments
    .replace(/,\s*([}\]])/gu, "$1") // trailing commas
    .replace(/[\u201c\u201d]/gu, '"') // smart quotes
    .replace(/[\u2018\u2019]/gu, "'");

  // Single-quoted strings: only safe when the payload uses no double quotes.
  if (!text.includes('"') && text.includes("'")) text = text.replace(/'/g, '"');

  // Unquoted keys: {"a":1} style fallout, e.g. {a: 1}
  text = text.replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/gu, '$1"$2"$3');

  // Balance braces/brackets.
  const open = (text.match(/{/g) ?? []).length - (text.match(/}/g) ?? []).length;
  const openSquare = (text.match(/\[/g) ?? []).length - (text.match(/]/g) ?? []).length;
  if (open > 0) text += "}".repeat(open);
  if (openSquare > 0) text += "]".repeat(openSquare);

  return text;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/** Remove tool-call blocks so clients only see the prose answer. */
export function stripToolCalls(text: string): string {
  return text
    .replace(NAMED_BLOCK, "")
    .replace(GENERIC_BLOCK, "")
    .replace(/\n{3,}/gu, "\n\n")
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

export interface ToolSchemaSummary {
  required?: string[];
  properties?: string[];
}

export function toolSchemasFromTools(tools?: OpenAITool[]): Record<string, ToolSchemaSummary> {
  const schemas: Record<string, ToolSchemaSummary> = {};
  for (const tool of tools ?? []) {
    const fn = tool?.function;
    if (!fn?.name) continue;
    const parameters = fn.parameters as
      | { required?: unknown; properties?: unknown }
      | undefined;
    const required = Array.isArray(parameters?.required)
      ? parameters!.required.filter((item): item is string => typeof item === "string")
      : [];
    const properties =
      parameters?.properties && typeof parameters.properties === "object"
        ? Object.keys(parameters.properties as Record<string, unknown>)
        : [];
    schemas[fn.name] = { required, properties };
  }
  return schemas;
}

export function toolNamesFromTools(tools?: OpenAITool[]): string[] {
  return (tools ?? [])
    .map((tool) => tool?.function?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Filters streamed text so a `<tool_call>` block is never leaked into the
 * visible answer, while ordinary prose still streams immediately.
 *
 * Only a trailing fragment that could still become `<tool_call` is held back,
 * so latency stays at a few characters instead of a whole answer.
 */
export class ToolCallSuppressor {
  private pending = "";
  private seen = "";

  /** Accumulated text including tool blocks (used for final parsing). */
  get fullText(): string {
    return this.seen;
  }

  push(delta: string): string {
    if (!delta) return "";
    this.seen += delta;
    this.pending += delta;

    let out = "";
    while (true) {
      const start = this.pending.search(/<tool_call[\s>]/i);
      if (start === -1) break;
      const close = this.pending.indexOf("</tool_call>", start);
      if (close === -1) {
        out += this.pending.slice(0, start);
        this.pending = this.pending.slice(start);
        return out;
      }
      out += this.pending.slice(0, start);
      this.pending = this.pending.slice(close + "</tool_call>".length);
    }

    const lastOpen = this.pending.lastIndexOf("<");
    if (lastOpen !== -1 && isPartialToolTag(this.pending.slice(lastOpen))) {
      out += this.pending.slice(0, lastOpen);
      this.pending = this.pending.slice(lastOpen);
      return out;
    }

    out += this.pending;
    this.pending = "";
    return out;
  }

  /** Whatever is safe to show once the answer is complete. */
  finish(): string {
    const rest = this.pending;
    this.pending = "";
    // An unterminated `<tool_call` is a truncated call, not prose.
    if (/^<tool_call/i.test(rest.trimStart())) return "";
    return rest;
  }
}

function isPartialToolTag(fragment: string): boolean {
  const tag = "<tool_call";
  const lower = fragment.toLowerCase();
  if (lower.length >= tag.length) return false;
  return tag.startsWith(lower);
}
