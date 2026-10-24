# Web Agents To

Turn a free web AI chat UI (Xiaomi **MiMo V2.6 Pro**) into a **local OpenAI-compatible API**, a CLI, an agentic coding loop, and a browser extension.

It runs a real Chromium session with Playwright against the provider's website, types your prompt into the chat box, scrapes the answer as it is written, and serves it back in the OpenAI wire format — so any OpenAI-compatible client can use it without an API key or per-token billing.

```
your app / CLI / extension
        │  OpenAI JSON
        ▼
Fastify  :8787   auth · CORS · SSE · validation
        ▼
BrowserChatProvider   prompt building · DOM scraping · retries · queueing
        ▼
Playwright persistent Chromium (saved login)
        ▼
aistudio.xiaomimimo.com  →  MiMo V2.6 Pro
```

> ⚠️ **Use responsibly.** Automating a consumer web UI is not the same as using a provider's API. It can break when the site changes, and it may violate the provider's terms. Only use accounts you own.

---

## Quick start

```bash
npm install
npx playwright install chromium   # one-time browser download
WEB setup                         # checks everything, writes opencode.json
WEB login                         # email + password + the one-time code
opencode                          # in your project folder
```

`WEB setup` is the friendly path: it verifies Node and the browser, starts the
server, tells you whether you are signed in, and writes a correct `opencode.json`
into the folder you run it from. Plain-English troubleshooting lives in
[`docs/HELP.md`](docs/HELP.md).

Requirements: **Node.js 20.3+**, and a Chromium that Playwright can drive.

<details>
<summary>Manual equivalent</summary>

```bash
cp .env.example .env   # optional, then edit
npm run dev            # API on http://127.0.0.1:8787
```
</details>

### 1. Sign in once

```bash
npm run login -- --provider=mimo
# or: WEB login
```

A **visible** browser opens. Sign in with your Xiaomi account — email + password,
then the **one-time code** they send you — and that is it: the window closes by
itself once the chat box appears (`LOGIN_TIMEOUT_MS`, default 5 min). The session
is stored in `~/.web-agents-to/profiles/mimo` and reused on every restart.

Logging in is deliberately a **manual, once-in-a-while** step:

- The one-time code means a saved password can never finish a login on its own;
  `MIMO_USER`/`MIMO_PASS` only pre-fill the form, and that pre-fill is rate
  limited (`LOGIN_COOLDOWN_MS`, default 15 min) because repeated failed password
  attempts are exactly what triggers lockouts.
- When the session dies, requests fail fast with a `login_required` error and an
  actionable hint instead of retrying forever.
- Check session health at any time: `WEB doctor` shows cookie lifetime,
  `WEB doctor --probe` loads the page and confirms you are really signed in.
- `WEB logout` closes the browser; delete `~/.web-agents-to/profiles/mimo` to
  forget the session entirely.

Set `HEADLESS=false` if you prefer to watch the automation work.

### 2. Chat

```bash
# one-shot
npm run cli -- "Explain closures in one paragraph"

# interactive
WEB repl

# agentic: the model can run commands and edit files
WEB agent "list the files here and summarise this project"
```

### 3. Or point any OpenAI client at it

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer web-agents-to"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer web-agents-to" \
  -d '{"model":"mimo/mimo-v2.6-pro","stream":true,
       "messages":[{"role":"user","content":"hi"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="web-agents-to")
stream = client.chat.completions.create(
    model="mimo/mimo-v2.6-pro",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

In Cline / Continue / opencode / LangChain, set the base URL to `http://127.0.0.1:8787/v1`, any API key matching `API_KEY`, and pick a model id from `/v1/models`.

---

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | no | Liveness, version, provider ids |
| `GET` | `/status` | yes | Browser/session/queue state per provider |
| `GET` | `/v1/models` | yes | Models in OpenAI `list` shape |
| `POST` | `/v1/chat/completions` | yes | Chat, `stream: true` or JSON |
| `POST` | `/auth/login` | yes | Opens a headed browser for sign-in |
| `GET` | `/auth/session` | yes | Cookie/session health (`?probe=1` verifies it live) |
| `POST` | `/auth/logout` | yes | Closes the provider browser |

Everything except `/health` requires `Authorization: Bearer $API_KEY`.

**Streaming** is real: the page is scraped every `STREAM_POLL_MS` and only the new suffix is emitted as a `chat.completion.chunk`, followed by a `finish_reason: "stop"` chunk and `data: [DONE]`.

**Tool calling.** Web UIs have no native function calling, so the server translates the text protocol

```
<tool_call name="bash">{"command":"ls"}</tool_call>
```

into OpenAI `tool_calls` when the request includes a `tools` array
(`NATIVE_TOOLS=true`). Prose streams immediately; a small hold-back buffer stops
a `<tool_call>` block from leaking into the answer. Call names are matched
against the request's tools (with aliases like `read_file`→`read`), arguments are
repaired and schema-checked, and calls that cannot be executed are dropped with a
note to the model instead of failing the step. Tool deltas carry `id`, `name`,
valid JSON `arguments` and an `index`, followed by a separate `finish_reason`
frame — the exact sequence opencode's parser requires.

---

## Use with opencode

opencode is the intended agent client: it edits your files and runs your build,
while this server supplies the model. Copy [`docs/opencode.json`](docs/opencode.json)
into your project as `opencode.json` (or `~/.config/opencode/opencode.json`):

```json
{
  "provider": {
    "web-agents-to": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "web-agents-to" },
      "models": { "mimo-v2.6-pro": { "name": "MiMo V2.6 Pro", "tool_call": true } }
    }
  },
  "model": "web-agents-to/mimo-v2.6-pro"
}
```

`tool_call: true` is what enables tools in opencode — without it the model is
treated as tool-less and never receives the tool list.

```bash
WEB doctor        # checks server/auth/models and prints the exact config to paste
WEB login         # sign in once
opencode          # in your project directory
```

Wire-level contract (tool-call deltas carry `id`/`name`/JSON `arguments`; text
streams before a single `finish_reason`; alias mapping, argument repair and
schema checks) plus a troubleshooting table live in
[`docs/OPENCODE.md`](docs/OPENCODE.md).

## CLI

`WEB` is the launcher (`npm link` to use it from anywhere):

| Command | Description |
|---|---|
| `WEB` | Agentic interactive session (auto-starts the server) |
| `WEB agent "task"` | Agent loop with local tools |
| `WEB agent "task" --yes --model=... --steps=8 --cwd=...` | Non-interactive agent |
| `WEB repl` | Plain interactive chat |
| `WEB chat "prompt"` | One-shot chat (`--json` for machine output) |
| `WEB start` | Server only |
| `WEB models` | List models |
| `WEB setup [--dir <project>]` | One-command first-time setup + writes `opencode.json` |
| `WEB doctor [--chat] [--probe]` | Diagnose API/auth/session and print the opencode config |
| `WEB login` / `WEB logout` | Manage the provider session |
| `WEB version` | Version |

### Tools

| Tool | Works without a shell |
|---|---|
| `read_file` · `write_file` · `append_file` · `replace_in_file` | yes |
| `list_dir` · `glob` · `grep` | yes |
| `make_dir` · `move_file` · `copy_file` · `delete_file` | yes |
| `bash` | uses the best shell available |

**Destructive actions ask for confirmation**; pass `--yes` (or `AGENT_AUTO_APPROVE=true`) for scripts. Tools are confined to the workspace root unless `AGENT_ALLOW_OUTSIDE=true`.

### Shells (Windows included)

`bash` used to hard-code `cmd.exe` on Windows, so `ls`, `grep`, `cat` and `&&`
chains failed with *"is not recognized"*. Now the shell is chosen per machine:

| Priority | Shell | Notes |
|---|---|---|
| 1 | **Git Bash** | `C:\Program Files\Git\bin\bash.exe` or `bash` on PATH |
| 2 | **PowerShell 7** (`pwsh`) | then Windows PowerShell 5 |
| 3 | **cmd.exe** | last resort |

On Linux/macOS it uses `$SHELL` (bash/zsh/sh). Force one with `AGENT_SHELL=bash|powershell|cmd|sh`, and per call with `{"command": "...", "shell": "powershell", "cwd": "src"}`.

Three safety nets:

1. **If the chosen shell is missing**, the command is retried with the next one instead of failing.
2. **If the shell does not know a command** (`'ls' is not recognized...`), simple commands — `ls`, `cat`, `echo`, `pwd`, `mkdir -p`, `rm -r`, `cp`, `mv`, `touch`, `head`, `tail`, `wc` — run in a built-in interpreter, and the result says so.
3. **For everything else** the model is told to use the dedicated tools above (or native `dir`/`Get-ChildItem` syntax) instead of guessing.

`WEB doctor` prints which shell was picked.

---

## Browser extension

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `extension/`.
2. Open the extension popup and set the local API URL, API key and model.
3. Open `aistudio.xiaomimimo.com` — a floating panel appears in the bottom-right (Ctrl/Cmd+Enter sends).

Settings are stored with `chrome.storage.local`; no credentials are baked into the extension.

---

## The two context limits

opencode decides when to compact a conversation; the browser bridge decides how
much it can physically type into MiMo's box. They are different numbers, and they
must not disagree:

| Number | Set by | Meaning |
|---|---|---|
| `limit.context` in `opencode.json` | generated by `WEB setup` from `MAX_PROMPT_CHARS` | when opencode summarises old turns |
| `MAX_PROMPT_CHARS` (default `120000`) | `.env` | hard cap the bridge will send |

`WEB setup` declares 90% of the real budget (120k chars → 27k tokens) so opencode
compacts *before* anything has to be cut.

**If trimming does happen anyway, the server fixes it itself.** No editing `.env`,
no `WEB setup --force`:

1. the budget grows by 25% (minimum +10k characters),
2. the new size is remembered in `~/.web-agents-to/context-budget.json`,
3. every `opencode.json` that `WEB setup` generated is rewritten with the new
   `limit.context`, so the next opencode start uses the bigger window,
4. growth stops at `MAX_PROMPT_CHARS_CEILING` (default 400 000), or when a larger
   size still gets trimmed — that means the site will not take more, and the log
   says so.

The trimmed prompt itself is still reported:

```
[mimo] history trimmed: dropped 48000 characters to fit the 120000-character browser budget
```

`GET /status` keeps the tally, so "the agent forgot what I said" is visible
instead of mysterious:

```json
"context": { "requests": 42, "trimmed": 3, "droppedChars": 91000,
             "lastTrimAt": "2026-10-24T09:12:03.114Z", "budgetChars": 120000 }
```

## Using MiMo from opencode

The server speaks the OpenAI wire format that opencode expects, including the parts
clients actually rely on:

| Feature | Behaviour |
|---|---|
| Model names | `mimo-v2.6-pro`, `mimo/mimo-v2.6-pro`, `web-agents-to/mimo-v2.6-pro` and any capitalisation all resolve |
| Tool calls | native `tool_calls` deltas, `finish_reason: "tool_calls"`, `tool_choice` incl. a forced tool |
| Tool-call markup | `<tool_call name="x">{...}</tool_call>`, Qwen/GLM `<function=x><parameter=k>v</parameter></function>`, unquoted attributes, `[TOOL_CALLS]`, OpenAI `tool_calls` arrays |
| Placeholder names | `name="…"`, `name="TOOL_NAME"` are ignored, and the model is told to use a real declared tool (never echoed a template) |
| `stop` | honoured, including sequences split across stream chunks |
| `max_tokens` / `max_completion_tokens` | honoured; `finish_reason: "length"` when it cuts |
| `response_format: {type:"json_object"}` | adds a "reply with bare JSON" instruction to the prompt |
| `stream_options.include_usage` | emits a usage frame |
| `temperature`, `top_p`, `seed`, penalties | accepted and ignored (the page has no such controls) |
| `n > 1` | rejected with a clear message (one answer per request) |
| Unknown fields | ignored rather than rejected, so client upgrades do not break the bridge |

## What gets read from the page

MiMo's answer box contains more than the answer. The bridge removes the rest:

- **`Thinking…` / `思考中`** — the chain of thought is removed before reading
  (DOM pass, selectors in `REASONING_SELECTORS` + defaults), with a text-level
  fallback. Otherwise the reasoning was replayed as history and the model saw
  "noise" it had said itself.
- **Busy banners** — `服务器繁忙，请稍后再试`, `Too Many Requests`, and the same
  text in the page title are treated as retryable, never as an answer.
- **"Still generating"** — a stop button / `aria-busy` keeps the reader waiting, so
  a pause between paragraphs is not mistaken for the end of the answer
  (`GENERATING_SELECTORS` to override). Idle detection is 20 polls (5 s) by
  default (`STREAM_IDLE_POLLS`).

## Configuration

Copy `.env.example` to `.env`. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Bind address |
| `API_KEY` | `web-agents-to` | Bearer token. **Change it.** |
| `CORS_ORIGINS` | – | Extra allowed origins (loopback + extensions always allowed) |
| `ALLOW_INSECURE` | `false` | Permit a non-loopback bind with the default key |
| `HEADLESS` | `true` | `false` shows the browser |
| `PROFILE_ROOT` | `~/.web-agents-to/profiles` | Login profiles |
| `SITE_OVERRIDES` | – | JSON patch for selectors when a site changes |
| `CHROMIUM_EXECUTABLE` | – | Use an existing Chromium binary instead of Playwright's download |
| `MIMO_USER` / `MIMO_PASS` | – | Optional form pre-fill (one-time code still needs you) |
| `LOGIN_TIMEOUT_MS` | `300000` | How long `WEB login` waits for you |
| `LOGIN_COOLDOWN_MS` | `900000` | Cooldown between automatic password attempts |
| `REQUEST_TIMEOUT_MS` | `180000` | Whole-request budget |
| `STREAM_POLL_MS` | `250` | DOM polling interval |
| `STREAM_IDLE_POLLS` | `6` | Unchanged polls that mean "done" |
| `STREAM_START_TIMEOUT_MS` | `75000` | Give up if no answer starts |
| `STREAM_MAX_WAIT_MS` | `180000` | Hard cap on one answer |
| `PROVIDER_RETRIES` | `3` | Retries for "server busy"/transient failures |
| `MAX_QUEUE` | `16` | Requests queued behind the active chat (then 429) |
| `NATIVE_TOOLS` | `true` | Translate `<tool_call>` into `tool_calls` |
| `AGENT_*` | – | Agent approvals, step limit, shell timeout, output cap |

### When the website changes

Selectors live in `src/providers/mimo.ts`. Patch them at runtime instead of editing code:

```json
// ~/.web-agents-to/providers/mimo.json  (or point SITE_OVERRIDES at a file)
{
  "inputSelectors": ["div[contenteditable='true']"],
  "responseSelectors": ["[data-testid='message-content']"]
}
```

Only the keys you provide are replaced; credentials can never be injected this way.

---

## Security

- The server binds to loopback and **refuses to start** on a public interface while the default API key is in use (override with `ALLOW_INSECURE=true`).
- All routes except `/health` require the bearer token, including `/auth/login`; comparisons are constant-time.
- CORS only allows loopback, configured origins and browser-extension schemes, so random websites cannot call your local API.
- Tools refuse paths outside the workspace root and require approval for shell commands and edits.
- Profiles contain live login cookies: treat `~/.web-agents-to` as a secret, and prefer a dedicated account.

> **Rotate your password if you used an earlier version of this repo.** A previous README contained a real account/password pair; that secret is still in git history. Remove any `.env` you committed and change the password.

To listen beyond loopback, set a strong `API_KEY` and put the server behind TLS (reverse proxy or tunnel) — the token travels in clear text over plain HTTP.

---

## Development

```bash
npm run typecheck   # strict tsc
npm test            # node:test via tsx (75 tests)
npm run build       # dist/
npm start           # run the built server
```

CI runs typecheck, tests and the build on Node 20 and 22 (see `.github/workflows/ci.yml`).

The browser suite (`test/browser-e2e.test.ts`) drives the real provider against
`test/fixtures/mock-chat.html`, a local stand-in for the provider UI. It needs a
Chromium binary and **skips itself** when none is available:

```bash
npx playwright install chromium          # or point at an existing binary
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium npm test
```

That suite covers the parts unit tests cannot: selector handling, incremental
DOM streaming, answer-baseline stripping (including single-bubble UIs),
conversation resets, busy-message detection and serialisation. An earlier audit
found three real defects through it; see [`docs/AUDIT.md`](docs/AUDIT.md).

## Project layout

| Path | Purpose |
|---|---|
| `src/server` | Fastify app: auth, CORS, SSE, validation, error mapping |
| `src/providers` | `SiteConfig` + `BrowserChatProvider` + MiMo adapter + overrides |
| `src/browser` | Lazy, persistent-context Chromium manager |
| `src/core` | Types, errors, prompt building, SSE, delta tracking, mutex, tool protocol |
| `src/cli` | API client, REPL, agent loop, local tools, login/logout |
| `extension` | Manifest V3 popup + floating panel |
| `test` | Unit + HTTP-level tests with an injected fake provider |
| `docs/ARCHITECTURE.md` | Design and data flow |
| `docs/OPENCODE.md` | opencode setup, wire contract, troubleshooting |
| `docs/AUDIT.md` | Audit findings, fixes and what could not be verified |
| `docs/HELP.md` | Plain-English troubleshooting ("if it breaks, do this") |
| `docs/PLAN.md` | Roadmap: official MiMo API, session replay, hardening |

## Known limitations

- **Scraping is fragile.** A UI redesign breaks selectors until you patch them (hence `SITE_OVERRIDES`).
- **Text streaming is simulated at the model level.** Deltas are incremental, but the model still generates inside a website; the first token arrives when the site renders it.
- **One conversation per provider at a time.** Requests are serialised; a second request waits (up to `MAX_QUEUE`) and then gets `429`.
- **Tool calls are a prompt protocol**, not the model's native function calling.
- **No parity with the OpenAI API** beyond chat completions/models (no embeddings, images, audio, fine-tuning).
