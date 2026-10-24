process.env.API_KEY = "test-key";
process.env.HOST = "127.0.0.1";
process.env.LOG_LEVEL = "error";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const { createServer } = await import("../src/server/index.js");
const built = await createServer({ logger: false });
const app = built.app;

const auth = { authorization: "Bearer test-key" };

before(async () => {
  await app.ready();
});

after(async () => {
  await app.close();
});

describe("health & auth", () => {
  it("serves /health without a key", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.providers, ["mimo"]);
  });

  it("rejects API calls without a key", async () => {
    for (const url of ["/v1/models", "/status"]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 401, url);
      assert.equal(response.json().error.code, "invalid_api_key");
    }
  });

  it("rejects a wrong key", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(response.statusCode, 401);
  });

  it("protects the login endpoint", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/login", payload: {} });
    assert.equal(response.statusCode, 401);
  });

  it("does not launch a browser just to answer status", async () => {
    const response = await app.inject({ method: "GET", url: "/status", headers: auth });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.providers[0].browser.launched, false);
    assert.deepEqual(body.providers[0].queue, { active: 0, waiting: 0 });
  });
});

describe("models", () => {
  it("lists provider-prefixed ids", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.object, "list");
    const ids = body.data.map((model: { id: string }) => model.id);
    assert.ok(ids.includes("mimo/mimo-v2.6-pro"));
    assert.ok(ids.includes("mimo/mimo-v2.6"));
  });
});

describe("chat validation", () => {
  it("rejects an empty body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {},
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_request");
  });

  it("rejects unknown models", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "nope/nope", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /unknown model/);
  });

  it("rejects malformed messages", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { messages: [{ role: "wizard", content: "hi" }] },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /messages/);
  });
});

describe("routing & cors", () => {
  it("returns an OpenAI-style 404", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/nope", headers: auth });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "not_found");
  });

  it("allows loopback and extension origins", async () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:5173", "chrome-extension://abc"]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { ...auth, origin },
      });
      assert.equal(response.headers["access-control-allow-origin"], origin, origin);
    }
  });

  it("answers CORS preflight without a key", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/chat/completions",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.ok([200, 204].includes(response.statusCode), String(response.statusCode));
    assert.equal(response.headers["access-control-allow-origin"], "http://localhost:3000");
  });

  it("does not allow arbitrary website origins", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { ...auth, origin: "https://evil.example" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });
});
