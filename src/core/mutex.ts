import { QueueFullError, RequestAbortedError } from "./errors.js";
import { abortReason } from "./utils.js";

export type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A keyed async mutex.
 *
 * Every browser-backed provider drives ONE page, so concurrent chats would
 * type into the same input box and corrupt each other's conversation state.
 * This serialises work per provider key, bounds the waiting queue, and lets
 * queued callers bail out when their HTTP client disconnects.
 */
export class KeyedMutex {
  private readonly locked = new Set<string>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly active = new Map<string, number>();

  constructor(private readonly maxQueue = 16) {}

  isLocked(key: string): boolean {
    return this.locked.has(key);
  }

  stats(key: string): { active: number; waiting: number } {
    return {
      active: this.locked.has(key) ? 1 : 0,
      waiting: this.waiters.get(key)?.length ?? 0,
    };
  }

  acquire(key: string, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(new RequestAbortedError());

    if (!this.locked.has(key)) {
      this.locked.add(key);
      this.bumpActive(key, 1);
      return Promise.resolve(this.releaseFactory(key));
    }

    const queue = this.waiters.get(key) ?? [];
    if (queue.length >= this.maxQueue) {
      return Promise.reject(
        new QueueFullError(`provider "${key}" is busy (${queue.length} requests waiting)`)
      );
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          this.removeWaiter(key, waiter);
          reject(new RequestAbortedError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      queue.push(waiter);
      this.waiters.set(key, queue);
    });
  }

  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(key, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private removeWaiter(key: string, waiter: Waiter): void {
    const queue = this.waiters.get(key);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
    if (queue.length === 0) this.waiters.delete(key);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }

  private releaseFactory(key: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.waiters.get(key);
      const next = queue?.shift();
      if (!next) {
        this.waiters.delete(key);
        this.locked.delete(key);
        this.bumpActive(key, -1);
        return;
      }
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
      // Hand the lock straight to the next waiter.
      next.resolve(this.releaseFactory(key));
    };
  }

  private bumpActive(key: string, delta: number): void {
    const next = (this.active.get(key) ?? 0) + delta;
    if (next <= 0) this.active.delete(key);
    else this.active.set(key, next);
  }

  /** Reject every waiter (used on shutdown); active holders finish normally. */
  drain(error: Error = abortReason()): void {
    for (const [key, queue] of this.waiters) {
      for (const waiter of queue.splice(0)) {
        if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.reject(error);
      }
      this.waiters.delete(key);
    }
  }
}
