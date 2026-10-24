# Architecture

`web-agents-to` is a local bridge: it presents a web chat UI as an OpenAI-compatible
HTTP service. This document describes how a request flows, why the pieces exist,
and where the design is fragile.

## 1. Request lifecycle

```
client ──POST /v1/chat/completions──▶ Fastify
                                        │ onRequest hook: bearer token
                                        │ zod validation
                                        │ resolve "provider/model"
                                        ▼
                                 KeyedMutex (per provider)
                                        │ one chat at a time
                                        ▼
                              BrowserChatProvider.chat()
                    ┌───────────────────┼────────────────────┐
                    ▼                   ▼                    ▼
             conversation key      type into page       scrape loop
             (new vs continue)     (fill/insertText)    (every 250 ms)
                                                        │ DeltaTracker
                                                        ▼
                                                  AsyncGenerator<chunk>
                                        │
                                        ▼
                              SSE frames + [DONE]
```

Non-streaming requests collect the same generator into one JSON object, so both
paths share all provider behaviour (retries, queueing, error mapping).

## 2. Modules

| Module | Responsibility |
|---|---|
| `src/core/types.ts` | OpenAI-compatible wire types, provider contract |
| `src/core/errors.ts` | `AppError` hierarchy + mapping to OpenAI error bodies |
| `src/core/prompt.ts` | Flatten chat history into a prompt; detect a new conversation |
| `src/core/stream.ts` | Strip the previous answer; turn DOM snapshots into deltas |
| `src/core/mutex.ts` | Keyed queue with bounded waiting and abort support |
| `src/core/sse.ts` | Encode/decode SSE frames across chunk boundaries |
| `src/core/toolcalls.ts` | Parse `<tool_call>` blocks; convert to native tool calls |
| `src/browser/manager.ts` | Lazy persistent Chromium profiles, one per provider |
| `src/providers/base.ts` | The scraping provider: locate input, submit, poll, emit |
| `src/providers/mimo.ts` | MiMo site configuration |
| `src/providers/overrides.ts` | Validated JSON patches for selectors/URLs |
| `src/providers/registry.ts` | Provider factories; one-line registration for new sites |
| `src/server/index.ts` | Routes, auth, CORS, validation, SSE writer |
| `src/cli/*` | Client, REPL, agent loop, local tools, login/logout |

## 3. Streaming algorithm

The provider never sees a token stream — it sees a DOM node whose text grows.
Each poll produces a *snapshot*. `DeltaTracker` converts snapshots into an
append-only stream:

1. If the snapshot extends what was already sent, emit the suffix.
2. If the snapshot is shorter (the page is mid re-render), emit nothing.
3. If the page rewrote earlier characters (markdown re-layout), mark divergence
   and stay quiet until the text catches up; `flush()` sends the remaining tail
   when the answer is final.
4. The loop stops after `STREAM_IDLE_POLLS` unchanged snapshots, or at
   `STREAM_MAX_WAIT_MS`.

The first answer in a bubble is detected by counting response nodes before and
after submitting. If the count does not change, the earlier answer is stripped
by prefix (`stripBaseline`), which is what allows a second turn in the same
conversation.

## 4. Conversation handling

OpenAI clients resend the full history every turn; the website already has it.
Sending everything again would make the model answer its own prior messages, so:

- `conversationKey(messages)` = hash(system prompt + first user turn).
- Same key and a growing message count → `buildContinuationPrompt`, which sends
  only the trailing user/tool messages.
- New key (or a shorter history, e.g. `/clear`) → click "new conversation" and
  flatten the whole history with roles into one prompt.

## 5. Concurrency

One page, one conversation: concurrent chats would type over each other. A
`KeyedMutex` (key = provider id) serialises requests; waiters are bounded by
`MAX_QUEUE` (default 16) and rejected with `429 queue_full`. A waiting request
is cancelled immediately when its HTTP client disconnects, using the abort
signal from `reply.raw.on("close")`.

## 6. Error mapping

| Condition | Error | HTTP |
|---|---|---|
| No chat input / signed out | `LoginRequiredError` (with login hint) | 401 |
| Site says "server busy" | `ServerBusyError` → retried | 503 |
| No answer after start timeout | `ProviderError` + selector hint | 504 |
| Chromium missing | `ProviderError` + `npx playwright install chromium` | 503 |
| Queue full | `QueueFullError` | 429 |
| Bad body / unknown model | `ValidationError` | 400 |
| Client disconnected | `RequestAbortedError` | *stream closed* |

Errors inside a stream are written as an SSE `error` frame followed by `[DONE]`,
so clients never hang on a half-open connection.

## 7. Startup behaviour

Providers are constructed at boot but **do not launch Chromium**. The browser
starts on the first chat (or login), which keeps `/health` cheap and lets the
server start on machines without Playwright browsers installed. The manager
serialises launches per provider because two Chromium processes cannot share
one profile directory.

## 8. Extending to another provider

1. Add `src/providers/<site>.ts` exporting a `SiteConfig` (URLs, selectors,
   models, login hints, busy patterns) and a factory.
2. Register the factory in `src/providers/registry.ts`.
3. `PROVIDERS=<site>` to enable it.

Everything else — server, CLIs, extension, streaming, tool translation — is
provider-agnostic because `BrowserChatProvider` is data-driven.

## 9. Threats and limits

- **The API is a proxy to a logged-in account.** Bearer auth, loopback binding
  and a startup refusal for insecure public binds are the guardrails.
- **Profiles are credentials.** `~/.web-agents-to/profiles/*` holds live cookies.
- **Scraping is inherently brittle**; overrides exist to avoid a release when
  selectors move.
- **Not API parity**: only chat completions and model listing are implemented.
