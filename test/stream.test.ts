import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeltaTracker, stripBaseline } from "../src/core/stream.js";

describe("stripBaseline", () => {
  it("removes the previous answer from a growing bubble", () => {
    assert.equal(stripBaseline("old answernew text", "old answer"), "new text");
    assert.equal(stripBaseline("old answer", "old answer"), "");
  });

  it("keeps unrelated text untouched", () => {
    assert.equal(stripBaseline("fresh answer", "old answer"), "fresh answer");
    assert.equal(stripBaseline("anything", ""), "anything");
  });
});

describe("DeltaTracker", () => {
  it("emits only the growing suffix", () => {
    const tracker = new DeltaTracker();
    assert.equal(tracker.push(""), "");
    assert.equal(tracker.push("Hel"), "Hel");
    assert.equal(tracker.push("Hello"), "lo");
    assert.equal(tracker.push("Hello"), "");
    assert.equal(tracker.push("Hello world"), " world");
    assert.equal(tracker.text, "Hello world");
  });

  it("does not repeat text when the page truncates temporarily", () => {
    const tracker = new DeltaTracker();
    tracker.push("Hello world");
    assert.equal(tracker.push("Hello"), "");
    assert.equal(tracker.push("Hello world!"), "!");
  });

  it("keeps streaming when markdown re-renders into a prefix extension", () => {
    const tracker = new DeltaTracker();
    tracker.push("**bold");
    assert.equal(tracker.push("**bold text"), " text");
    assert.equal(tracker.hasDiverged, false);
  });

  it("stays quiet on divergence and flushes the tail", () => {
    const tracker = new DeltaTracker();
    tracker.push("abc");
    assert.equal(tracker.push("abX"), "");
    assert.equal(tracker.hasDiverged, true);
    assert.equal(tracker.flush("abXyz"), "Xyz");
  });

  it("flushes everything when nothing was emitted", () => {
    const tracker = new DeltaTracker();
    assert.equal(tracker.flush("complete answer"), "complete answer");
    assert.equal(tracker.flush("complete answer"), "");
  });
});
