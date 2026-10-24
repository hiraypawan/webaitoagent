import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeyedMutex } from "../src/core/mutex.js";
import { QueueFullError, RequestAbortedError } from "../src/core/errors.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("KeyedMutex", () => {
  it("serialises work per key", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const a = mutex.run("mimo", async () => {
      events.push("a-start");
      await tick(20);
      events.push("a-end");
    });
    const b = mutex.run("mimo", async () => {
      events.push("b-start");
      await tick(1);
      events.push("b-end");
    });

    await Promise.all([a, b]);
    assert.deepEqual(events, ["a-start", "a-end", "b-start", "b-end"]);
  });

  it("does not block different keys", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    await Promise.all([
      mutex.run("one", async () => {
        await tick(20);
        events.push("one");
      }),
      mutex.run("two", async () => {
        events.push("two");
      }),
    ]);
    assert.deepEqual(events, ["two", "one"]);
  });

  it("rejects when the queue is full", async () => {
    const mutex = new KeyedMutex(1);
    const release = await mutex.acquire("k");
    const waiting = mutex.acquire("k");
    await assert.rejects(mutex.acquire("k"), QueueFullError);
    release();
    await waiting.then((done) => done());
    assert.equal(mutex.isLocked("k"), false);
  });

  it("reports queue stats", async () => {
    const mutex = new KeyedMutex();
    const release = await mutex.acquire("k");
    const waiting = mutex.acquire("k");
    assert.deepEqual(mutex.stats("k"), { active: 1, waiting: 1 });
    release();
    await waiting;
    assert.deepEqual(mutex.stats("k"), { active: 1, waiting: 0 });
  });

  it("lets a queued caller abort while waiting", async () => {
    const mutex = new KeyedMutex();
    const release = await mutex.acquire("k");
    const controller = new AbortController();
    const waiting = mutex.acquire("k", controller.signal);
    controller.abort();
    await assert.rejects(waiting, RequestAbortedError);
    assert.deepEqual(mutex.stats("k"), { active: 1, waiting: 0 });
    release();
  });

  it("releases exactly once", async () => {
    const mutex = new KeyedMutex();
    const release = await mutex.acquire("k");
    release();
    release();
    const again = await mutex.acquire("k");
    assert.equal(mutex.isLocked("k"), true);
    again();
  });

  it("drains queued waiters", async () => {
    const mutex = new KeyedMutex();
    const release = await mutex.acquire("k");
    const waiting = mutex.acquire("k");
    mutex.drain(new Error("shutting down"));
    await assert.rejects(waiting, /shutting down/);
    release();
  });
});
