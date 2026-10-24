import { createHash, randomUUID } from "node:crypto";

/** Short random id with a readable prefix, e.g. `chatcmpl-1a2b3c`. */
export function newId(prefix: string, separator = "-"): string {
  return `${prefix}${separator}${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortReason(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("request aborted");
  err.name = "AbortError";
  return err;
}

/** Very rough token estimate (good enough for reports, not for billing). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function hashString(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/**
 * Keep the head and tail of a long string, replacing the middle with a note.
 * Used to avoid blowing up the web model's input box with huge histories.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, Math.floor((maxChars - 64) / 2));
  const omitted = text.length - keep * 2;
  return `${text.slice(0, keep)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(-keep)}`;
}

export function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated ${text.length - maxChars} characters ...]`;
}

export function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError";
}
