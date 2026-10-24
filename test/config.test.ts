import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config, isInsecureExposure, isLoopbackHost } from "../src/config/index.js";

describe("isLoopbackHost", () => {
  it("accepts loopback spellings only", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", " 127.0.0.1 "]) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    for (const host of ["0.0.0.0", "192.168.1.5", "example.com", ""]) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });
});

describe("isInsecureExposure", () => {
  const base = { ...config };

  it("is safe on loopback even with the default key", () => {
    assert.equal(isInsecureExposure({ ...base, host: "127.0.0.1", usingDefaultApiKey: true }), false);
  });

  it("flags a public bind with the default key", () => {
    assert.equal(isInsecureExposure({ ...base, host: "0.0.0.0", usingDefaultApiKey: true }), true);
    assert.equal(isInsecureExposure({ ...base, host: "0.0.0.0", usingDefaultApiKey: false, apiKey: "" }), true);
  });

  it("allows a public bind with a custom key", () => {
    assert.equal(
      isInsecureExposure({ ...base, host: "0.0.0.0", usingDefaultApiKey: false, apiKey: "s3cret" }),
      false
    );
  });
});

describe("config defaults", () => {
  it("sane defaults", () => {
    assert.ok(config.port > 0);
    assert.ok(config.streamPollMs >= 50);
    assert.ok(config.streamIdlePolls >= 1);
    assert.ok(config.maxQueue >= 0);
    assert.ok(config.providerRetries >= 1);
  });
});
