import { commonPrefixLength } from "./utils.js";

/**
 * Remove the previously rendered answer from a page's text.
 *
 * The MiMo UI appends to the same bubble when a conversation continues, so the
 * scraped text still contains the earlier reply. Only strip when the text
 * really starts with the baseline — otherwise we would eat real content.
 */
export function stripBaseline(text: string, baseline: string): string {
  if (!text) return "";
  if (!baseline) return text;
  if (text === baseline) return "";
  if (text.startsWith(baseline)) return text.slice(baseline.length).replace(/^[\r\n]+/, "");
  return text;
}

/**
 * Converts successive snapshots of a growing DOM answer into incremental
 * deltas, which is what makes `stream: true` behave like real streaming
 * instead of one giant chunk at the very end.
 *
 * OpenAI deltas are append-only, so we only ever emit a suffix. If the page
 * re-renders and the text diverges (e.g. markdown is re-laid-out), we stay
 * quiet until the text extends what was already sent; `flush()` reconciles at
 * the end when possible.
 */
export class DeltaTracker {
  private emitted = "";
  private diverged = false;

  get text(): string {
    return this.emitted;
  }

  get hasEmitted(): boolean {
    return this.emitted.length > 0;
  }

  get hasDiverged(): boolean {
    return this.diverged;
  }

  reset(): void {
    this.emitted = "";
    this.diverged = false;
  }

  /** Returns the new suffix to send, or "" when there is nothing new. */
  push(fullText: string): string {
    if (!fullText) return "";
    if (fullText === this.emitted) return "";

    if (fullText.startsWith(this.emitted)) {
      const delta = fullText.slice(this.emitted.length);
      this.emitted = fullText;
      this.diverged = false;
      return delta;
    }

    if (this.emitted.startsWith(fullText)) return "";

    const shared = commonPrefixLength(this.emitted, fullText);
    if (shared === this.emitted.length) {
      const delta = fullText.slice(this.emitted.length);
      this.emitted = fullText;
      return delta;
    }

    // The page rewrote earlier text. Never retract; wait for it to catch up.
    this.diverged = true;
    return "";
  }

  /** Emit whatever tail is still missing once the answer is final. */
  flush(finalText?: string): string {
    const text = finalText?.trim() ? finalText : this.emitted;
    if (!text || text === this.emitted) return "";
    if (!this.emitted) {
      this.emitted = text;
      return text;
    }
    if (text.startsWith(this.emitted)) {
      const delta = text.slice(this.emitted.length);
      this.emitted = text;
      return delta;
    }
    if (this.emitted.startsWith(text)) return "";
    // Last resort: send the tail beyond the common prefix so the client at
    // least receives the end of the answer instead of a truncated response.
    const shared = commonPrefixLength(this.emitted, text);
    if (shared < text.length) {
      const delta = text.slice(shared);
      this.emitted = text;
      return delta;
    }
    return "";
  }
}
