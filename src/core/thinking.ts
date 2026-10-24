/**
 * MiMo's web UI shows its chain-of-thought ("Thinking…") above the answer, and
 * that block lives inside the same prose container we scrape. Left alone, the
 * reasoning ends up in the assistant message — which then gets replayed as
 * history on the next turn, confusing the model ("some noise in the history")
 * and wasting context.
 *
 * Two layers:
 *  1. the DOM (preferred): reasoning elements are removed before reading text;
 *  2. this pure text pass: drops a leading "Thinking…" section when the UI put
 *     it in the same node and left a blank-line separator.
 */

/** Selectors for reasoning containers, tried in order. `i` = case-insensitive. */
export const DEFAULT_REASONING_SELECTORS = [
  "[class*='think' i]",
  "[class*='reason' i]",
  "[class*='cot' i]",
  "[class*='chain-of-thought' i]",
  "[data-thinking]",
  "[data-reasoning]",
  "[data-testid*='think' i]",
  "[data-testid*='reason' i]",
  "[aria-label*='thinking' i]",
  "[aria-label*='reasoning' i]",
  "details",
];

/** Selectors that indicate the page is still generating. */
export const DEFAULT_GENERATING_SELECTORS = [
  "[aria-busy='true']",
  "[data-generating='true']",
  "[data-streaming='true']",
  "button[aria-label*='stop' i]",
  "[class*='stop-generat' i]",
];

const HEADER = /^(?:>\s*)?(?:thinking(?:\.\.\.|…| process|\.)?|reasoning|思考中|思考过程|深度思考|已深度思考)\s*[:：]?\s*$/i;

/**
 * Remove a leading reasoning preamble.
 *
 * Handles the common merged shape: a `Thinking…` header, one reasoning
 * paragraph, a blank line, then the answer. When the DOM pass already removed
 * the reasoning there is no header and this is a no-op. If only reasoning is
 * left (no answer), the text is returned unchanged — an unanswered turn is
 * worse than a noisy one.
 */
export function stripThinkingPreamble(text: string): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/);

  // Allow a few blank lines before the header.
  let start = 0;
  while (start < lines.length && !lines[start]!.trim()) start++;
  if (start >= lines.length || !HEADER.test(lines[start]!.trim())) return text;

  // Split the remainder into blank-line separated sections.
  const sections: string[][] = [];
  let current: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim()) {
      current.push(lines[i]!);
    } else if (current.length > 0) {
      sections.push(current);
      current = [];
    }
  }
  if (current.length > 0) sections.push(current);

  if (sections.length === 0) return text;

  // Drop the reasoning paragraph(s) only when a substantial answer follows.
  // The check is length-relative so scripts that pack meaning into few
  // characters (Chinese) are not mistaken for "nothing left".
  const answer = sections
    .slice(1)
    .map((section) => section.join("\n"))
    .join("\n\n")
    .trim();
  const substantial = answer.length >= 20 || (answer.length > 0 && answer.length / text.length >= 0.15);
  if (!substantial) return text;
  return answer;
}

/** Parse a comma/newline separated selector list from the environment. */
export function parseSelectors(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Drop a leading `Thinking...` marker that got merged onto the same line as the
 * answer ("Thinking...The user wants a page"). Only the marker is removed — the
 * reasoning body cannot be separated safely from text, which is why the DOM pass
 * exists.
 */
export function stripInlineMarker(text: string): string {
  const match = /^\s*(?:>\s*)?(?:thinking|reasoning|思考中|思考过程)(\s*(?:\.\.\.|…|[:：]|[-–—]))?/i.exec(text);
  if (!match) return text;

  const marker = match[0];
  const punctuation = match[1];
  const rest = text.slice(marker.length);
  const cjkMarker = /[\u4e00-\u9fff]/.test(marker);

  // "Thinking caps on" is a sentence, not a marker: without punctuation the
  // marker must be followed by the end of the line or a non-letter. Chinese
  // markers ("思考中") are self-delimiting and are often glued to the text.
  if (!punctuation && !cjkMarker && /^\s*[\p{L}\p{N}]/u.test(rest)) return text;
  return /[\p{L}\p{N}]/u.test(rest) ? rest : text;
}

/** Remove reasoning from plain text using only the header rules (no DOM). */
export function cleanAnswer(text: string): string {
  // Block form first (it knows where the answer starts), then the merged form.
  return stripInlineMarker(stripThinkingPreamble(text)).trimEnd();
}
