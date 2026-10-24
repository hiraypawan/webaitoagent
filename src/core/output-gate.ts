/**
 * Enforces the OpenAI parameters the web chat box cannot enforce itself.
 *
 * `stop` and `max_tokens` are client-side contract: opencode (and any SDK) may
 * rely on them to terminate a turn. The page has no idea about them, so the
 * bridge applies them to the text it emits — holding back just enough
 * characters that a stop sequence can never leak across a chunk boundary.
 */

export interface OutputGateOptions {
  /** String or list of strings; generation ends *before* the first match. */
  stop?: string | string[];
  /** Token budget; converted to characters with the usual 4:1 estimate. */
  maxTokens?: number;
}

export interface OutputGate {
  /** Feed a delta; returns the text that may be sent now. */
  push(text: string): string;
  /** Flush whatever is still held back. Call once the model finished. */
  finish(): string;
  /** True once a stop sequence or the token budget ended the output. */
  readonly done: boolean;
  /** Why it ended, if it ended early. */
  readonly reason: "stop" | "length" | null;
}

const CHARS_PER_TOKEN = 4;

export function createOutputGate(options: OutputGateOptions = {}): OutputGate {
  const stops = (Array.isArray(options.stop) ? options.stop : options.stop ? [options.stop] : []).filter(
    (value) => typeof value === "string" && value.length > 0
  );
  const holdBack = stops.length > 0 ? Math.max(...stops.map((value) => value.length)) - 1 : 0;
  const maxChars = options.maxTokens && options.maxTokens > 0 ? options.maxTokens * CHARS_PER_TOKEN : Infinity;

  let pending = "";
  let emitted = 0;
  let done = false;
  let reason: "stop" | "length" | null = null;

  const emit = (text: string): string => {
    if (!text || done) return "";
    const room = maxChars - emitted;
    if (text.length >= room) {
      const slice = text.slice(0, Math.max(0, room));
      emitted += slice.length;
      done = true;
      reason = "length";
      return slice;
    }
    emitted += text.length;
    return text;
  };

  return {
    push(text: string): string {
      if (done || !text) return "";
      pending += text;

      for (const stop of stops) {
        const index = pending.indexOf(stop);
        if (index >= 0) {
          const before = pending.slice(0, index);
          pending = "";
          const out = emit(before);
          done = true;
          reason = "stop";
          return out;
        }
      }

      const safe = holdBack > 0 ? pending.slice(0, Math.max(0, pending.length - holdBack)) : pending;
      pending = pending.slice(safe.length);
      const out = emit(safe);
      if (done) pending = "";
      return out;
    },

    finish(): string {
      if (done) {
        pending = "";
        return "";
      }
      const out = emit(pending);
      pending = "";
      return out;
    },

    get done() {
      return done;
    },

    get reason() {
      return reason;
    },
  };
}

/** Normalise `stop` / `max_tokens` style fields from a request body. */
export function gateOptions(body: {
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
}): OutputGateOptions {
  return {
    stop: body.stop,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
  };
}
