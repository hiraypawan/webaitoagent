import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOpencodeConfig,
  describeSession,
  nextSteps,
  renderStep,
  writeOpencodeConfig,
} from "../src/cli/setup-support.js";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wat-setup-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildOpencodeConfig", () => {
  it("produces a config opencode can load", () => {
    const config = buildOpencodeConfig("http://127.0.0.1:8787", "secret", {
      model: "mimo-v2.6-pro",
    }) as any;

    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.equal(config.model, "web-agents-to/mimo-v2.6-pro");

    const provider = config.provider["web-agents-to"];
    assert.equal(provider.npm, "@ai-sdk/openai-compatible");
    assert.equal(provider.options.baseURL, "http://127.0.0.1:8787/v1");
    assert.equal(provider.options.apiKey, "secret");

    const model = provider.models["mimo-v2.6-pro"];
    assert.equal(model.tool_call, true, "tools stay disabled in opencode without this");
    assert.equal(model.reasoning, false);
    assert.ok(model.limit.context > 0);
  });

  it("does not double up the /v1 suffix", () => {
    const config = buildOpencodeConfig("http://127.0.0.1:8787/", "k") as any;
    assert.equal(config.provider["web-agents-to"].options.baseURL, "http://127.0.0.1:8787/v1");
  });
});

describe("writeOpencodeConfig", () => {
  it("writes the file and never clobbers an existing config", () => {
    const target = path.join(dir, "project");
    const config = buildOpencodeConfig("http://127.0.0.1:8787", "k");

    const first = writeOpencodeConfig(target, config);
    assert.equal(first.written, true);
    const file = path.join(target, "opencode.json");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, "web-agents-to/mimo-v2.6-pro");

    const second = writeOpencodeConfig(target, config);
    assert.equal(second.written, false);
    assert.match(second.reason ?? "", /already exists/);

    const forced = writeOpencodeConfig(target, config, { force: true });
    assert.equal(forced.written, true);
  });
});

describe("describeSession", () => {
  it("asks for a login when nothing is known", () => {
    const step = describeSession(undefined);
    assert.equal(step.state, "todo");
    assert.match(step.action ?? "", /WEB login/);
  });

  it("reports a healthy session with remaining days", () => {
    const step = describeSession({ checked: true, signedIn: true, cookies: { daysRemaining: 12 } });
    assert.equal(step.state, "ok");
    assert.match(step.detail, /12 more day/);
  });

  it("explains the one-time code instead of blaming the password", () => {
    const step = describeSession({ checked: true, needsLogin: true, loginState: "verification_required" });
    assert.equal(step.state, "todo");
    assert.match(step.detail, /one-time code/i);
  });

  it("tells the user to wait when sign-in is rate limited", () => {
    const step = describeSession({ checked: true, needsLogin: true, loginState: "blocked" });
    assert.match(step.action ?? "", /15 minutes/);
  });
});

describe("renderStep", () => {
  it("marks each state distinctly", () => {
    assert.match(renderStep({ title: "A", state: "ok", detail: "fine" }), /^\[ok\]/);
    assert.match(renderStep({ title: "B", state: "todo", detail: "later" }), /^\[  \]/);
    const broken = renderStep({ title: "C", state: "broken", detail: "bad", action: "fix it" });
    assert.match(broken, /^\[!!\]/);
    assert.match(broken, /-> fix it/);
  });
});

describe("nextSteps", () => {
  it("puts the login first when not signed in", () => {
    const steps = nextSteps(undefined);
    assert.match(steps[0] ?? "", /WEB login/);
    assert.ok(steps.some((step) => step.includes("opencode")));
  });

  it("skips the login hint when signed in", () => {
    const steps = nextSteps({ checked: true, signedIn: true });
    assert.ok(!steps.some((step) => step.startsWith("WEB login")));
  });
});

describe("blockers", () => {
  it("lists broken steps and blocking todos only", async () => {
    const { blockers } = await import("../src/cli/setup-support.js");
    const pending = blockers([
      { title: "Node", state: "ok", detail: "v22" },
      { title: "Browser", state: "todo", detail: "missing", action: "install", blocking: true },
      { title: "Sign-in", state: "todo", detail: "not signed in" },
      { title: "Server", state: "broken", detail: "down" },
    ]);
    assert.deepEqual(
      pending.map((step) => step.title),
      ["Browser", "Server"]
    );
  });
});
