import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyLoginPage,
  LoginAttemptGuard,
  loginHint,
  summariseCookies,
} from "../src/providers/login-flow.js";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wat-login-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = { hasChatInput: false, hasPasswordField: false, hasOtpField: false, text: "" };

describe("classifyLoginPage", () => {
  it("reports signed_in when the chat box exists", () => {
    assert.equal(classifyLoginPage({ ...base, hasChatInput: true }), "signed_in");
    // Even with a login dialog rendered behind it.
    assert.equal(
      classifyLoginPage({ ...base, hasChatInput: true, hasPasswordField: true }),
      "signed_in"
    );
  });

  it("detects the one-time-code step", () => {
    assert.equal(classifyLoginPage({ ...base, hasOtpField: true }), "verification_required");
    for (const text of [
      "Enter the verification code we sent to your email",
      "We sent a code to j***@gmail.com",
      "Two-factor authentication required",
      "请输入验证码",
    ]) {
      assert.equal(classifyLoginPage({ ...base, text }), "verification_required", text);
    }
  });

  it("prefers verification over the password form when both are present", () => {
    assert.equal(
      classifyLoginPage({ ...base, hasPasswordField: true, hasOtpField: true }),
      "verification_required"
    );
  });

  it("detects the credentials form", () => {
    assert.equal(classifyLoginPage({ ...base, hasPasswordField: true }), "credentials_form");
    assert.equal(classifyLoginPage({ ...base, text: "Forgot password?" }), "credentials_form");
  });

  it("detects lockouts and challenges", () => {
    for (const text of [
      "Too many failed attempts. Try again in 15 minutes.",
      "Your account is temporarily locked",
      "Please complete the captcha",
      "操作频繁，请稍后再试",
    ]) {
      assert.equal(classifyLoginPage({ ...base, text }), "blocked", text);
    }
  });

  it("falls back to unknown", () => {
    assert.equal(classifyLoginPage(base), "unknown");
  });
});

describe("loginHint", () => {
  it("explains that a one-time code needs a human", () => {
    const hint = loginHint("verification_required", "(base)");
    assert.match(hint, /one-time code/i);
    assert.match(hint, /WEB login/);
    assert.match(hint, /\(base\)/);
  });

  it("mentions waiting when rate-limited", () => {
    assert.match(loginHint("blocked", ""), /rate-limiting|Wait/i);
  });
});

describe("LoginAttemptGuard", () => {
  it("allows the first attempt and blocks the next one", () => {
    const guard = new LoginAttemptGuard(dir, { cooldownMs: 60_000 });
    assert.equal(guard.canAttempt("mimo").allowed, true);
    guard.recordAttempt("mimo");
    guard.recordFailure("mimo", "verification_required");

    const blocked = guard.canAttempt("mimo");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "verification_required");
    assert.ok((blocked.retryInMs ?? 0) > 0);
  });

  it("allows a retry after the cooldown expires", () => {
    let now = 1_000_000;
    const guard = new LoginAttemptGuard(dir, { cooldownMs: 60_000, now: () => now });
    guard.recordAttempt("late");
    guard.recordFailure("late", "verification_required");
    assert.equal(guard.canAttempt("late").allowed, false);

    now += 61_000;
    assert.equal(guard.canAttempt("late").allowed, true);
  });

  it("clears the block after a success", () => {
    const guard = new LoginAttemptGuard(dir, { cooldownMs: 60_000 });
    guard.recordFailure("reset", "error");
    assert.equal(guard.canAttempt("reset").allowed, false);
    guard.recordSuccess("reset");
    assert.equal(guard.canAttempt("reset").allowed, true);
  });

  it("persists across instances so restarts do not retry", () => {
    const first = new LoginAttemptGuard(dir, { cooldownMs: 600_000 });
    first.recordFailure("persisted", "verification_required");

    const second = new LoginAttemptGuard(dir, { cooldownMs: 600_000 });
    const result = second.canAttempt("persisted");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "verification_required");
  });

  it("writes the state file with owner-only permissions", { skip: process.platform === "win32" }, () => {
    const guard = new LoginAttemptGuard(dir, { cooldownMs: 1_000 });
    guard.recordFailure("perms", "blocked");
    const file = path.join(dir, "login-state.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // The password itself is never written here.
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /pass|password/i);
  });
});

describe("summariseCookies", () => {
  const now = Date.parse("2026-10-24T00:00:00Z");

  it("reports the soonest expiry in days", () => {
    const summary = summariseCookies(
      [
        { name: "serviceToken", expires: Math.floor((now + 3 * 86_400_000) / 1000), domain: "x" },
        { name: "other", expires: Math.floor((now + 30 * 86_400_000) / 1000), domain: "x" },
        { name: "sessionOnly", expires: -1, domain: "x" },
      ],
      ["token"],
      now
    );
    assert.equal(summary.cookies, 3);
    assert.equal(summary.sessionCookies, 1);
    assert.equal(summary.daysRemaining, 3);
    assert.equal(summary.hasAuthCookie, true);
  });

  it("handles session-only cookies", () => {
    const summary = summariseCookies([{ name: "sid", expires: -1, domain: "x" }], ["sid"], now);
    assert.equal(summary.sessionCookies, 1);
    assert.equal(summary.expiresAt, undefined);
    assert.equal(summary.hasAuthCookie, true);
  });
});
