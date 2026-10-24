# Audit — 2026-10-24

Scope: full static review of the codebase plus dynamic verification with a real
browser. **The real MiMo site could not be reached from the audit environment**
(only npm/PyPI/GitHub egress), so the provider was verified against a local
mock of its UI and the wire layer against opencode's actual SDK. See
[What was not verified](#what-was-not-verified).

## Summary

| Area | Result |
|---|---|
| Type check (`tsc`, also `--noUnusedLocals`) | clean |
| Tests | **87 passing** (77 unit/HTTP + 8 real-browser + 2 new parsing) |
| Build | clean |
| Real-browser end-to-end (Playwright → DOM → SSE → AI SDK) | tool call executed, 2 steps |
| Blocking defects found | 3 |
| Non-blocking issues fixed | 5 |
| Open risks (accepted) | 4 |

## Defects found and fixed

### 1. Double-send risk when Enter submits (High)

`submit()` pressed Enter, then — if a send button was visible — clicked it too.
On any site where Enter already sends, that posts a **second, empty message**
and can make the provider return an error or a spurious reply.

Fix: after Enter, re-read the input; only click a fallback button (or press
Enter again) when the text is still there.

### 2. `networkidle` navigation on SPA pages (High)

Every page load waited for `networkidle`. Provider SPAs keep websockets and
pollers open, so `networkidle` never fires; each attempt burned the full 45 s
timeout before falling through. First request of every session was slow and the
login path could time out entirely.

Fix: `domcontentloaded` + poll for the input selector (20 s budget), then
dismiss the cookie banner. Removed the leftover `networkidle` waits in
auto-login too.

### 3. Continuation prompts re-sent the whole tool spec (Medium)

In an agent loop every follow-up request repeated the complete tool schemas plus
the calling instructions. With opencode that is easily 10–20k characters **per
step**, crowding out real context and re-reading instructions to the model.

Fix: continuations now carry a one-line reminder (tool names + call syntax);
full schemas are only sent with the first turn of a conversation. Verified: the
second step's prompt dropped from the full block to
`Tools (unchanged): bash. Call one with …`.

### 4. Placeholder names parsed as tool calls (Low)

The prompt's own example — `<tool_call name="NAME">…` — could be echoed by the
model and was then reported to it as a failed call, which invited pointless
retries.

Fix: `NAME`, `TOOL`, `TOOL_NAME`, `YOUR_TOOL`, `FUNCTION`, `EXAMPLE` are ignored
silently. Genuinely unknown names are still reported.

### 5. CLI could not start a built server (Low)

`ensureServer()` always spawned `node --import tsx …`, which fails where dev
dependencies are absent (a `npm start` / packaged install).

Fix: use tsx when present, otherwise `dist/server/main.js`, with a clear error if
neither exists.

## Verified behaviour (real Chromium 153 against a mock provider UI)

1. **Incremental streaming** — an answer produces multiple content deltas, not
   one blob; role is attached to the first content delta; finish frame is
   content-free and last.
2. **Tool block preserved** — `<tool_call name="bash">{"command": "ls -la"}</tool_call>`
   survives the scrape intact for the server layer to translate.
3. **Continuation** — a second turn sends only the new turn to the page, does
   **not** click "new conversation", and does not re-emit the previous answer.
4. **New conversation** — a changed history triggers exactly one "new
   conversation" click and sends the flattened history with role prefixes.
5. **Shared-bubble rendering** — when a site writes every answer into the same
   growing bubble, the previous answer is stripped from the delta stream.
6. **Long answers** — a 400+ character answer streams completely; head and tail
   both present, nothing truncated.
7. **Busy notice** — `服务器繁忙` is raised as a provider error (and retried by
   the provider), not shown to the user as an answer.
8. **Concurrency** — two simultaneous chats on one page are serialised; each
   answer contains only its own prompt.

Full-stack run (`AI SDK client → server → Playwright → mock DOM → SSE → tool
execution`):

```
EV text-delta "Let me check the directory.\n"
EV tool-call  ["bash",{"command":"ls -la"}]
EV finish     "tool-calls"
steps: 2   executed: ["ls -la"]
```

## Wire format (checked against `@ai-sdk/openai-compatible` 3.0.77 + `ai` 7.0.152)

```
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Let me check the directory.\n"},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_…","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls -la\"}"}}]},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
data: [DONE]
```

Satisfies the parser's rules: no content after a finish reason, every tool delta
carries `id`/`name`, arguments are valid JSON, indexes are sequential.

## Non-functional checks

- **Security**: `/health` is the only unauthenticated route; `/auth/*` is
  authenticated; tokens compared with `timingSafeEqual`; CORS limited to
  loopback/extensions/config; non-loopback bind with the default key refuses to
  start; agent tools confined to the workspace root with explicit approval.
- **Secrets**: `grep` for the previously leaked credential finds nothing in the
  tree; `.env`, profiles and local state are git-ignored.
- **Dependencies**: 6 runtime deps, no known advisories at install time; no
  postinstall scripts.
- **Startup**: browser launch is lazy — `/health` and `/status` start no
  Chromium.

## What was not verified

| Not verified | Why | Impact |
|---|---|---|
| Actual MiMo login | `aistudio.xiaomimimo.com`, `account.xiaomi.com` and `accounts.google.com` are unreachable from this environment | Session reuse, cookie handling and the Google-SSO flow are untested end-to-end |
| MiMo's real DOM/selectors | Same reason | Selectors may have drifted; `SITE_OVERRIDES` exists for exactly this |
| MiMo's tool-calling quality | Needs a live session | The protocol is prompt-based, so expect occasional malformed calls (now self-correcting) |
| Response latency/limits | Needs a live session | Timeouts are configurable; defaults are conservative |

**Nothing in this audit proves the MiMo side works today.** It proves the
bridge, the streaming, the tool translation and the agent loop are correct
against a faithful mock — that is the part that was broken and is now tested.

## Recommendations before relying on it

1. Run `WEB doctor --chat` on a machine that can reach the provider — it checks
   login, selectors and an end-to-end tool call in one shot.
2. Keep `API_KEY` unique and `HOST=127.0.0.1`.
3. Set `HEADLESS=false` for the first real run so you can watch what the
   automation does; failures are much easier to diagnose.
4. If the UI changed, patch `inputSelectors`/`responseSelectors` via
   `SITE_OVERRIDES` instead of editing code.
5. Treat the account as disposable: automating a consumer UI is outside the
   provider's terms.
