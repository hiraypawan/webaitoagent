import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUSY_PATTERNS, looksBusy } from "../src/core/page-signals.js";

describe("busy detection", () => {
  it("recognises the Chinese overload banner", () => {
    assert.ok(looksBusy("服务器繁忙，请稍后再试"));
    assert.ok(looksBusy("系统繁忙"));
  });

  it("recognises English variants", () => {
    assert.ok(looksBusy("Server is busy, please try again later"));
    assert.ok(looksBusy("429 Too Many Requests"));
  });

  it("ignores a long answer that merely mentions retrying", () => {
    const answer = `Here is the patch. ${"x".repeat(320)} you can try again later if it fails.`;
    assert.equal(looksBusy(answer), false);
  });

  it("ignores empty and normal text", () => {
    assert.equal(looksBusy(""), false);
    assert.equal(looksBusy(undefined), false);
    assert.equal(looksBusy("MiMo V2.6 Pro"), false);
  });

  it("covers the notices MiMo actually shows", () => {
    for (const needed of ["服务器繁忙", "请稍后再试", "too many requests"]) {
      assert.ok(BUSY_PATTERNS.includes(needed), needed);
    }
  });
});
