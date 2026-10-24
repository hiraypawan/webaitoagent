process.env.LOG_LEVEL = "error";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlaywrightBrowserManager } from "../src/browser/manager.js";
import { BrowserChatProvider, type SiteConfig } from "../src/providers/base.js";
import type { ChatChunk, ChatMessage } from "../src/core/types.js";

/**
 * Drives the REAL provider (Playwright + DOM scraping) against a local mock of
 * the provider UI. This is the part unit tests cannot cover: selectors, the
 * streaming loop, baseline stripping and conversation handling.
 *
 * Skipped automatically when no Chromium is available (e.g. CI without
 * `npx playwright install chromium`).
 */
const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mock-chat.html"
);

const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? (fs.existsSync("/tmp/chromium") ? "/tmp/chromium" : undefined);

let server: http.Server;
let port = 0;
let manager: PlaywrightBrowserManager;
let provider: BrowserChatProvider;
let profileRoot: string;
let available = false;

const site: SiteConfig = {
  id: "mock",
  name: "Mock AI Studio",
  baseUrl: "",
  chatUrls: [],
  newChatSelectors: ["#new-chat"],
  inputSelectors: ["textarea", "#prompt"],
  submitSelectors: ["#send"],
  responseSelectors: [".markdown-prose"],
  models: [{ id: "mock-1", name: "Mock", owned_by: "test" }],
  loginHint: "n/a",
  busyPatterns: ["服务器繁忙"],
};

function page(): string {
  return `http://127.0.0.1:${port}/`;
}

before(async () => {
  const html = fs.readFileSync(fixture);
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;

  profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wat-profile-"));
  manager = new PlaywrightBrowserManager({
    userDataRoot: profileRoot,
    headless: true,
    executablePath,
  });

  provider = new BrowserChatProvider(
    { ...site, baseUrl: page(), chatUrls: [page()] },
    manager,
    { streamPollMs: 60, streamIdlePolls: 4, retries: 1, requestTimeoutMs: 30_000 }
  );

  try {
    await manager.context("mock");
    available = true;
  } catch {
    available = false;
  }
});

after(async () => {
  await manager?.close().catch(() => {});
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (profileRoot) fs.rmSync(profileRoot, { recursive: true, force: true });
});

async function collect(messages: ChatMessage[]): Promise<{ chunks: ChatChunk[]; text: string }> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of provider.chat({
    model: "mock-1",
    messages,
  })) {
    chunks.push(chunk);
  }
  const text = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join("");
  return { chunks, text };
}

async function hooks(): Promise<{ received: string[]; newChats: number; turns: number }> {
  const browser = await manager.context("mock");
  const target = browser.pages().find((candidate) => candidate.url().startsWith(page()));
  if (!target) throw new Error("mock page not open");
  return target.evaluate(() => ({
    received: (window as unknown as { __received: string[] }).__received,
    newChats: (window as unknown as { __newChats: number }).__newChats,
    turns: (window as unknown as { __turns: number }).__turns,
  }));
}

describe("browser provider against a mock chat UI", () => {
  it("streams an answer incrementally instead of one blob", async (t) => {
    if (!available) return t.skip("no chromium available");

    const { chunks, text } = await collect([{ role: "user", content: "hello there" }]);
    const contentChunks = chunks.filter((chunk) => chunk.choices[0]?.delta?.content);

    // The mock echoes the prompt, which is flattened with role prefixes.
    assert.ok(text.includes("You said: User: hello there"), `unexpected answer: ${text}`);
    assert.ok(contentChunks.length > 1, `expected incremental deltas, got ${contentChunks.length}`);
    assert.equal(contentChunks[0]!.choices[0]!.delta.role, "assistant");

    const finish = chunks.at(-1)!.choices[0]!;
    assert.equal(finish.finish_reason, "stop");
    assert.equal(finish.delta?.content ?? undefined, undefined);
  });

  it("preserves a tool_call block so the server layer can translate it", async (t) => {
    if (!available) return t.skip("no chromium available");

    const { text } = await collect([{ role: "user", content: "TOOLTEST please" }]);
    assert.match(text, /<tool_call name="bash">\{"command": "ls -la"\}<\/tool_call>/);
  });

  it("continues the same conversation without resetting it", async (t) => {
    if (!available) return t.skip("no chromium available");

    const first = await collect([{ role: "user", content: "ECHO: first" }]);
    assert.match(first.text, /ECHO: first/);

    const before = await hooks();
    const second = await collect([
      { role: "user", content: "ECHO: first" },
      { role: "assistant", content: first.text },
      { role: "user", content: "ECHO: second" },
    ]);
    const afterSecond = await hooks();

    assert.match(second.text, /ECHO: second/);
    assert.doesNotMatch(second.text, /ECHO: first/, "previous answer leaked into the new one");
    assert.equal(afterSecond.newChats, before.newChats, "must not start a new conversation");
    // Only the new turn is typed when the page already holds the history.
    assert.equal(afterSecond.received.at(-1)!.trim(), "User: ECHO: second");
  });

  it("starts a new conversation when the history changes", async (t) => {
    if (!available) return t.skip("no chromium available");

    const before = await hooks();
    const { text } = await collect([{ role: "user", content: "ECHO: brand new topic" }]);
    const afterNew = await hooks();

    assert.match(text, /ECHO: brand new topic/);
    assert.equal(afterNew.newChats, before.newChats + 1);
    assert.match(afterNew.received.at(-1)!, /System|User: ECHO: brand new topic/);
  });

  it("strips the previous answer when the site reuses one bubble", async (t) => {
    if (!available) return t.skip("no chromium available");

    // A second provider whose page renders every turn into the same bubble.
    const reuse = new BrowserChatProvider(
      {
        ...site,
        id: "mock-reuse",
        baseUrl: `${page()}?reuse=1`,
        chatUrls: [`${page()}?reuse=1`],
      },
      manager,
      { streamPollMs: 60, streamIdlePolls: 4, retries: 1, requestTimeoutMs: 30_000 }
    );

    const run = async (messages: ChatMessage[]) => {
      let text = "";
      for await (const chunk of reuse.chat({ model: "mock-1", messages })) {
        text += chunk.choices[0]?.delta?.content ?? "";
      }
      return text;
    };

    const first = await run([{ role: "user", content: "ECHO: alpha" }]);
    assert.match(first, /ECHO: alpha/);

    const second = await run([
      { role: "user", content: "ECHO: alpha" },
      { role: "assistant", content: first },
      { role: "user", content: "ECHO: beta" },
    ]);
    assert.match(second, /ECHO: beta/);
    assert.doesNotMatch(second, /ECHO: alpha/, "baseline was not stripped from the shared bubble");

    await reuse.close();
  });

  it("streams a long answer completely, without dropping the tail", async (t) => {
    if (!available) return t.skip("no chromium available");

    const { text } = await collect([{ role: "user", content: "LONG please" }]);
    assert.ok(text.startsWith("BEGIN "), `missing head of the answer: ${text.slice(0, 60)}`);
    assert.ok(text.trimEnd().endsWith("END"), "missing tail of the answer");
    assert.ok(text.includes("x".repeat(200)), "answer was truncated");
  });

  it("surfaces a busy notice as a provider error", async (t) => {
    if (!available) return t.skip("no chromium available");

    await assert.rejects(
      collect([{ role: "user", content: "BUSY now" }]),
      /busy|繁忙/i
    );
  });

  it("serialises concurrent chats on one page", async (t) => {
    if (!available) return t.skip("no chromium available");

    const [a, b] = await Promise.all([
      collect([{ role: "user", content: "ECHO: alpha" }]),
      collect([{ role: "user", content: "ECHO: beta" }]),
    ]);

    assert.match(a.text, /ECHO: alpha/);
    assert.match(b.text, /ECHO: beta/);
    assert.doesNotMatch(a.text, /beta/);
    assert.doesNotMatch(b.text, /alpha/);
  });
});
