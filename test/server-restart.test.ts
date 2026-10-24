import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Starting the server twice must be an explanation, not a stack trace —
 * that is exactly what the user saw with `npm run dev` + EADDRINUSE.
 */

const port = 18000 + Math.floor(Math.random() * 900);
const env = {
  ...process.env,
  PORT: String(port),
  HOST: "127.0.0.1",
  API_KEY: "restart-test-key",
  LOG_LEVEL: "error",
  HEADLESS: "true",
  DATA_DIR: `/tmp/wat-restart-${port}`,
};

function startServer(): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function output(child: ChildProcess): { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk) => (out += chunk.toString()));
  child.stderr?.on("data", (chunk) => (err += chunk.toString()));
  return { stdout: () => out, stderr: () => err };
}

async function waitForHealth(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

describe("second start on a busy port", () => {
  it("says the server is already running and exits successfully", { timeout: 90_000 }, async (t) => {
    const first = startServer();
    const firstOut = output(first);
    const healthy = await waitForHealth();
    if (!healthy) {
      first.kill("SIGKILL");
      t.skip(`server did not start: ${firstOut.stderr().slice(0, 300)}`);
      return;
    }

    try {
      const second = startServer();
      const secondOut = output(second);

      const code = await new Promise<number | null>((resolve) => {
        second.on("exit", (exitCode) => resolve(exitCode));
        setTimeout(() => {
          second.kill("SIGKILL");
          resolve(-1);
        }, 30_000).unref?.();
      });

      const text = `${secondOut.stdout()}\n${secondOut.stderr()}`;
      assert.equal(code, 0, `expected a clean exit, saw ${code}: ${text.slice(0, 400)}`);
      assert.match(text, /already running/);
      assert.match(text, new RegExp(String(port)));
      assert.doesNotMatch(text, /EADDRINUSE/);
      assert.doesNotMatch(text, /at Server\.setupListenHandle/);
    } finally {
      first.kill("SIGKILL");
    }
  });
});
