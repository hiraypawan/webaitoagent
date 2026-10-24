/**
 * Signals that come from the page chrome rather than the answer.
 *
 * MiMo reports overload in a banner and sometimes only in the tab title
 * ("服务器繁忙，请稍后再试"). Watching the title catches the case where the
 * answer box stays empty, which otherwise looks like a slow model.
 */

export const BUSY_PATTERNS = [
  "服务器繁忙",
  "服务繁忙",
  "系统繁忙",
  "当前人数过多",
  "请稍后再试",
  "server is busy",
  "server busy",
  "too many requests",
  "rate limit",
  "try again later",
];

/** Short text that means "retry", never a long answer mentioning it in passing. */
export function looksBusy(text: string | undefined, patterns: string[] = BUSY_PATTERNS): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 300) return false;
  const lower = trimmed.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}
