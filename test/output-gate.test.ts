import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOutputGate, gateOptions } from "../src/core/output-gate.js";

describe("stop sequences", () => {
  it("ends output before the sequence", () => {
    const gate = createOutputGate({ stop: "\n\nHuman:" });
    let out = "";
    for (const chunk of ["Hello", " there", "\n\nHuman:", " should not appear"]) {
      out += gate.push(chunk);
    }
    assert.equal(out, "Hello there\n\nHuman:".slice(0, "Hello there".length));
    assert.equal(gate.done, true);
    assert.equal(gate.reason, "stop");
    assert.equal(gate.finish(), "");
  });

  it("catches a sequence split across chunks", () => {
    const gate = createOutputGate({ stop: ["STOP"] });
    let out = "";
    for (const chunk of ["abc", "S", "TO", "Pxyz"]) out += gate.push(chunk);
    out += gate.finish();
    assert.equal(out, "abc");
    assert.equal(gate.reason, "stop");
  });

  it("supports several sequences and the earliest wins", () => {
    const gate = createOutputGate({ stop: ["</answer>", "###"] });
    let out = gate.push("one two ### three");
    out += gate.finish();
    assert.equal(out, "one two ");
    assert.equal(gate.reason, "stop");
  });

  it("flushes held-back text when nothing matched", () => {
    const gate = createOutputGate({ stop: ["NOPE"] });
    const out = gate.push("short") + gate.finish();
    assert.equal(out, "short");
    assert.equal(gate.done, false);
    assert.equal(gate.reason, null);
  });
});

describe("max_tokens", () => {
  it("stops at the token budget", () => {
    const gate = createOutputGate({ maxTokens: 5 }); // ~20 characters
    let out = "";
    for (let i = 0; i < 10; i++) out += gate.push("abcdefghij");
    out += gate.finish();
    assert.equal(out.length, 20);
    assert.equal(gate.done, true);
    assert.equal(gate.reason, "length");
  });

  it("passes everything through when unset", () => {
    const gate = createOutputGate({});
    const text = "x".repeat(5000);
    assert.equal(gate.push(text) + gate.finish(), text);
  });
});

describe("gateOptions", () => {
  it("prefers max_completion_tokens over max_tokens", () => {
    assert.equal(gateOptions({ max_tokens: 10, max_completion_tokens: 20 }).maxTokens, 20);
    assert.equal(gateOptions({ max_tokens: 10 }).maxTokens, 10);
    assert.equal(gateOptions({}).maxTokens, undefined);
  });

  it("normalises a single stop string", () => {
    const gate = createOutputGate(gateOptions({ stop: "END" }));
    assert.equal(gate.push("abcENDdef") + gate.finish(), "abc");
  });
});
