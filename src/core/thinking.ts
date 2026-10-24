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
  "[data-thinking]",
  "[data-reasoning]",
  "[aria-label*='thinking' i]",
  "[aria-label*='reasoning' i]",
  "details",
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

/** Remove reasoning from plain text using only the header rule (no DOM). */
export function cleanAnswer(text: string): string {
  return stripThinkingPreamble(text).trimEnd();
}
