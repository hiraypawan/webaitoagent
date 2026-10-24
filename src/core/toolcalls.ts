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

/** Any `<tool_call ...>...</tool_call>` block, attributes or not. */
const TOOL_BLOCK = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi;
/** `<function=NAME>...</function>` or `<function name="NAME">...</function>` (Qwen/GLM style). */
const XML_FUNCTION = /<function(?:\s*=\s*|\s+name\s*=\s*)["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/function>/gi;
/** A bare `<function=NAME>` block, without a `<tool_call>` wrapper. */
const XML_FUNCTION_ANYWHERE = /<function(?:\s*=\s*|\s+name\s*=\s*)["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/function>/gi;
/** `<function=NAME>` whose closing tag the model forgot. */
const XML_FUNCTION_OPEN = /<function(?:\s*=\s*|\s+name\s*=\s*)["']?([\w.-]+)["']?\s*>([\s\S]*)$/i;
/** `<parameter=KEY>VALUE` with or without `name=` and with or without a closing tag. */
const XML_PARAMETER = /<parameter(?:\s+name\s*=\s*|\s*=\s*)["']?([\w.-]+)["']?\s*>([\s\S]*?)(?=<\/parameter>|<parameter(?:\s+name\s*=\s*|\s*=\s*)|<\/function|<\/tool_call|$)/gi;
/** Misral/Devstral style: `[TOOL_CALLS] [{...}]`. */
const TOOL_CALLS_TAG = /\[TOOL_CALLS\]\s*([\[{][\s\S]*?[\]}])(?=\s*$|\s*\n)/;
/** `name` inside an attribute string. */
const ATTR_NAME = /name\s*=\s*["']?([^"'>\s]+)/i;
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

/** Names models copy out of instructions instead of real tool names. */
const PLACEHOLDER_NAMES = new Set([
  "name",
  "tool",
  "tool_name",
  "toolname",
  "your_tool",
  "toolname_here",
  "function",
  "example",
]);

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

  const raws = collectRawCalls(closeUnterminatedToolBlock(text), options);

  const calls: ParsedToolCall[] = [];
  const dropped: ParsedToolCall[] = [];
  const seen = new Set<string>();

  for (const raw of raws) {
    const parsedBody = raw.args ? { name: raw.name, args: raw.args } : jsonToolCall(raw.body);
    const name = raw.name || parsedBody?.name || "";
    if (!name) {
      // Keep the block itself in the report: the next fix comes from seeing what
      // the model actually wrote.
      dropped.push({
        name: "(unknown)",
        args: {},
        raw: raw.raw,
        parseError: `unrecognised tool-call format: ${snippet(raw.raw)}`,
      });
      continue;
    }

    // `name="NAME"` inside an example is instruction text, not a call.
    if (PLACEHOLDER_NAMES.has(name.trim().toLowerCase())) continue;

    const resolved = resolveToolName(name, options);
    if (!resolved) {
      dropped.push({ name, args: {}, raw: raw.raw, parseError: `unknown tool "${name}"` });
      continue;
    }

    let args = raw.args ?? parsedBody?.args;
    if (!args) {
      const parsed = tryParseObject(raw.body);
      if (parsed) args = parsed;
    }
    if (!args) {
      // Models often write the single argument bare:
      // `<tool_call name="read">D:\project\README.md</tool_call>`. When the tool
      // declares exactly one parameter, that text can only be that parameter.
      const bare = raw.body.trim();
      // A body that starts with `{`/`[` is meant to be JSON. If it did not
      // parse, report it instead of turning the broken object into a path or
      // command string.
      if (bare && bare.length <= 4000 && !/[<>]/.test(bare) && !/^[\[{]/.test(bare)) {
        const schema = options.toolSchemas?.[resolved];
        const required = schema?.required ?? [];
        const properties = schema?.properties ?? [];
        const key =
          required.length === 1 ? required[0] : properties.length === 1 ? properties[0] : undefined;
        if (key) args = { [key]: bare };
      }
    }
    if (!args) {
      dropped.push({
        name: resolved,
        args: {},
        raw: raw.raw,
        parseError: `arguments were not valid JSON: ${snippet(raw.body)}`,
      });
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

interface RawCall {
  name: string;
  body: string;
  raw: string;
  /** Set when the format carried structured arguments already. */
  args?: Record<string, unknown>;
}

/** A short, single-line excerpt for error messages and logs. */
export function snippet(value: string, limit = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** `<parameter=key>value</parameter>` blocks to an object. */
function xmlParameters(body: string): Record<string, unknown> | undefined {
  const params: Record<string, unknown> = {};
  let found = false;
  XML_PARAMETER.lastIndex = 0;
  for (const match of body.matchAll(XML_PARAMETER)) {
    const key = match[1]!.trim();
    if (!key) continue;
    found = true;
    const raw = (match[2] ?? "").replace(/<\/?parameter[^>]*>/gi, "").trim();
    // Values may themselves be JSON (arrays, objects); keep them structured.
    const parsed = tryJson(raw);
    if (parsed === undefined) {
      params[key] = raw;
    } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      const keys = Object.keys(object);
      // MiMo sometimes nests the argument inside its own name, or uses an
      // alias (`path`) while the tool declares `filePath`:
      // <parameter=filePath>{"filePath":"D:\\project\\file.ts"}</parameter>
      const nestedKey =
        keys.length === 1 ? keys[0]! : Object.prototype.hasOwnProperty.call(object, key) ? key : "";
      const nested = nestedKey ? object[nestedKey] : undefined;
      params[key] =
        nested !== undefined && (nested === null || typeof nested !== "object")
          ? nested
          : parsed;
    } else {
      params[key] = parsed;
    }
  }
  XML_PARAMETER.lastIndex = 0;
  return found ? params : undefined;
}

/**
 * MiMo sometimes stops before `</tool_call>` (a slow DOM read or a cut-off
 * answer). Add the missing close so the normal block parser can still read the
 * call instead of reporting "the block was not closed".
 */
function closeUnterminatedToolBlock(text: string): string {
  const lower = text.toLowerCase();
  const lastOpen = lower.lastIndexOf("<tool_call");
  if (lastOpen === -1) return text;
  if (lower.lastIndexOf("</tool_call>") > lastOpen) return text;
  return `${text}</tool_call>`;
}

/**
 * Every tool-call shape we know about, in one pass.
 *
 * Models on the web are not consistent: MiMo, Qwen and GLM all emit slightly
 * different markup, and a single unknown shape used to poison a whole turn with
 * "no tool name". Anything unrecognised is reported with its own text.
 */
function collectRawCalls(text: string, options: ParseToolCallsOptions): RawCall[] {
  const raws: RawCall[] = [];
  const consumed: Array<[number, number]> = [];

  for (const match of text.matchAll(TOOL_BLOCK)) {
    const attrs = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    const raw = match[0];
    consumed.push([match.index ?? 0, (match.index ?? 0) + raw.length]);

    // Qwen/GLM: <tool_call><function=bash><parameter=command>ls</parameter></function></tool_call>
    const xml = XML_FUNCTION.exec(raw);
    XML_FUNCTION.lastIndex = 0;
    if (xml) {
      raws.push({
        name: xml[1]!.trim(),
        body: xml[2] ?? "",
        raw,
        args: xmlParameters(xml[2] ?? "") ?? {},
      });
      continue;
    }

    // Same shape, but the model forgot `</function>` and went straight to
    // `</tool_call>`. MiMo does this often; the parameters are still usable.
    const openXml = XML_FUNCTION_OPEN.exec(body);
    if (openXml && /<parameter\b/i.test(body)) {
      raws.push({
        name: openXml[1]!.trim(),
        body: openXml[2] ?? "",
        raw,
        args: xmlParameters(openXml[2] ?? "") ?? {},
      });
      continue;
    }

    const attrName = ATTR_NAME.exec(attrs)?.[1];
    const parsed = jsonToolCalls(body);
    if (parsed.length > 0) {
      for (const call of parsed) {
        if (attrName && !call.name) raws.push({ name: attrName, body, raw, args: call.args });
        else raws.push({ name: call.name || attrName || "", body, raw, args: call.args });
      }
      continue;
    }

    if (attrName) {
      // `<tool_call name="read"><parameter=path>...</parameter></tool_call>`
      const xmlArgs = xmlParameters(body);
      raws.push({ name: attrName, body, raw, ...(xmlArgs ? { args: xmlArgs } : {}) });
      continue;
    }

    // `<tool_call>read<parameter=path>...</parameter></tool_call>`
    const nameThenParams = /^([\w.-]+)\s*(?=<parameter\b)/i.exec(body);
    if (nameThenParams) {
      raws.push({
        name: nameThenParams[1]!.trim(),
        body,
        raw,
        args: xmlParameters(body) ?? {},
      });
      continue;
    }

    // A name followed by JSON, without keys around the name: bash {"command":"ls"}
    const bare = /^([\w.-]+)\s*[\n:,]?\s*([\[{][\s\S]*)$/.exec(body);
    if (bare) {
      raws.push({ name: bare[1]!, body: bare[2]!, raw });
      continue;
    }

    raws.push({ name: "", body, raw });
  }

  // A `<function=...>` block on its own (some models skip the wrapper).
  for (const match of text.matchAll(XML_FUNCTION_ANYWHERE)) {
    const at = match.index ?? 0;
    if (consumed.some(([from, to]) => at >= from && at < to)) continue;
    raws.push({
      name: match[1]!.trim(),
      body: match[2] ?? "",
      raw: match[0],
      args: xmlParameters(match[2] ?? "") ?? {},
    });
  }

  // Last resort: `<function=glob><parameter=pattern>**/*.ts` with every closing
  // tag missing. MiMo does this when it is cut off mid-call.
  if (raws.length === 0) {
    XML_FUNCTION_OPEN.lastIndex = 0;
    const open = XML_FUNCTION_OPEN.exec(text);
    if (open && /<parameter\b/i.test(open[2] ?? "")) {
      raws.push({
        name: open[1]!.trim(),
        body: open[2] ?? "",
        raw: open[0],
        args: xmlParameters(open[2] ?? "") ?? {},
      });
    }
  }

  // `[TOOL_CALLS] [...]`
  const tagged = TOOL_CALLS_TAG.exec(text);
  if (tagged) {
    for (const call of jsonToolCalls(tagged[1]!)) {
      raws.push({ name: call.name, body: JSON.stringify(call.args), raw: tagged[0], args: call.args });
    }
  }

  if (raws.length === 0) {
    for (const call of implicitCalls(text, options)) raws.push(call);
  }

  return raws;
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

  // The table above points at opencode's short names. The local WEB agent uses
  // the long ones (`read_file`, `replace_in_file`), so resolve the reverse too:
  // a model that writes `read` should still hit `read_file`.
  for (const [source, target] of Object.entries(aliases)) {
    if (target.toLowerCase() !== requested.toLowerCase()) continue;
    const match = allowed.find((tool) => tool.toLowerCase() === source.toLowerCase());
    if (match) return match;
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

  // A fenced block or the whole message that is just JSON (one call or many).
  for (const match of trimmed.matchAll(FENCED_BLOCK)) {
    for (const parsed of jsonToolCalls((match[1] ?? "").trim())) {
      found.push({ name: parsed.name, body: JSON.stringify(parsed.args), raw: match[0] });
    }
  }

  if (found.length === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    for (const parsed of jsonToolCalls(trimmed)) {
      found.push({ name: parsed.name, body: JSON.stringify(parsed.args), raw: trimmed });
    }
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

/** Like jsonToolCall, but returns every call in an array / tool_calls payload. */
export function jsonToolCalls(body: string): { name: string; args: Record<string, unknown> }[] {
  const value = tryJson(body);
  if (value === undefined) return [];

  const list = Array.isArray(value) ? value : [value];
  const out: { name: string; args: Record<string, unknown> }[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const object = entry as Record<string, unknown>;

    if (Array.isArray(object.tool_calls)) {
      for (const nested of object.tool_calls) {
        const parsed = jsonToolCalls(JSON.stringify(nested));
        out.push(...parsed);
      }
      continue;
    }

    const parsed = jsonToolCall(JSON.stringify(object));
    if (parsed) out.push(parsed);
  }

  return out;
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

/**
 * Escape backslashes inside JSON string literals that contain a Windows path.
 *
 * Models write `D:\project\file.ts` without doubling the separators, which is
 * invalid JSON (`\p`, `\A`, and even `\t` in `D:\temp`). The drive letter makes
 * the intent unambiguous, so only path-looking strings are rewritten; normal
 * `\n` escapes in prose are left alone.
 */
function escapeWindowsPaths(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => {
    const inner = literal.slice(1, -1);
    if (!/[A-Za-z]:\\|^\\\\/.test(inner)) return literal;

    let out = "";
    for (let i = 0; i < inner.length; i++) {
      const char = inner[i]!;
      if (char !== "\\") {
        out += char;
        continue;
      }
      const next = inner[i + 1];
      if (next === "\\" || next === '"') {
        // Already a valid escape; keep the pair as written.
        out += char + next;
        i++;
      } else {
        // A literal Windows separator (or a trailing backslash).
        out += "\\\\";
      }
    }
    return `"${out}"`;
  });
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

  // Windows paths (`D:\project\file.ts`) are not valid JSON until the
  // separators are doubled. Run after quote normalization so single-quoted
  // payloads are covered too.
  text = escapeWindowsPaths(text);

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

/** Remove tool-call blocks (any known markup) so clients only see prose. */
export function stripToolCalls(text: string): string {
  return text
    .replace(TOOL_BLOCK, "")
    .replace(XML_FUNCTION_ANYWHERE, "")
    .replace(/<tool_call\b[^>]*>[\s\S]*$/i, "")
    .replace(/\[TOOL_CALLS\][\s\S]*$/u, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function hasToolCalls(text: string): boolean {
  return /<tool_call[\s>]|<function\s*=|<function\s+name\s*=|\[TOOL_CALLS\]/i.test(text);
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
