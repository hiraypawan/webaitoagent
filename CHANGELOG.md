# Changelog

## 1.5.0

Two things are now automatic: growing the prompt budget, and keeping opencode in
sync with it.

### Changed
- **Automatic budget growth.** When a request has to drop history, the server
  raises the browser budget by 25% (min +10k characters), persists the learned
  size in `~/.web-agents-to/context-budget.json`, and rewrites `limit.context` in
  every `opencode.json` that `WEB setup` generated. No more editing
  `MAX_PROMPT_CHARS` and re-running `WEB setup --force`.
  - Bounded by the new `MAX_PROMPT_CHARS_CEILING` (default 400 000).
  - Growth stops once a larger size still gets trimmed — the site will not take
    more — and the log says so instead of looping.
  - `/status.context` reports `configuredChars`, `ceilingChars`, `growthSteps`
    and `autoGrown`; `/v1/models` advertises the effective `context_length`;
    `WEB doctor` shows the budget row.

### Added (opencode compatibility)
- Model-name tolerance: bare ids, `provider/model`, our config label
  (`web-agents-to/mimo-v2.6-pro`), and any capitalisation all resolve.
- `stop` and `max_tokens`/`max_completion_tokens` are honoured, including stop
  sequences split across stream chunks; `finish_reason: "length"` when cut.
- `response_format: {type: "json_object"}` adds a bare-JSON instruction to both
  prompt builders.
- `parallel_tool_calls`, `seed`, penalties and `reasoning_effort` are accepted
  and ignored; `n > 1` is rejected with a clear message.
- 34 new tests: budget growth/ceiling/persistence/config-sync, stop and token
  limits, model aliases, and the compatibility surface end to end.

## 1.4.0

More tools, and a `bash` tool that no longer dies on Windows.

### Fixed
- `bash` hard-coded `cmd.exe` on Windows, so every Unix-style command failed with
  *"is not recognized as an internal or external command"*. The shell is now
  detected: Git Bash → PowerShell 7 → Windows PowerShell → cmd.exe (and `$SHELL`
  on Linux/macOS). `AGENT_SHELL` forces one; each call may pass `shell` and `cwd`.
- If the chosen shell cannot start, the command is retried with the next shell.
- If the shell does not know the command, a built-in interpreter runs the simple
  cases (`ls`, `cat`, `echo`, `pwd`, `mkdir -p`, `rm -r`, `cp`, `mv`, `touch`,
  `head`, `tail`, `wc`, including `&&`/`;` chains) and says that it did.
- Failures now name the shell used and point at the dedicated tools.

### Added
- Tools: `glob`, `grep`, `move_file`, `copy_file`, `delete_file`, `make_dir`,
  `append_file` — all implemented in Node, so they behave identically on Windows,
  macOS and Linux and never depend on a shell.
- `WEB doctor` reports the detected shell and how to improve it.
- 42 new tests: shell detection (Git Bash/PowerShell/cmd/`$SHELL`, forced and
  missing shells), the fallback interpreter, and every new tool.

## 1.3.2

Made the two context limits agree, and stopped history from disappearing silently.

opencode compacts a conversation based on the context size it is told about. The
browser bridge has its own hard character budget. When the declared size was
larger than the budget, the bridge quietly cut the middle out of the prompt and
opencode never knew to compact first.

### Changed
- `WEB setup` now derives the declared `limit.context` **from** `MAX_PROMPT_CHARS`
  with 10% headroom, so opencode compacts *before* the bridge would need to trim
  (120k chars → 27k tokens, instead of a hard-coded 30k).
- `/v1/models` advertises `context_length` for clients that size themselves from
  it.

### Added
- Trimming is now reported, never silent: one warning per trimmed request
  (`history trimmed: dropped N characters`) plus counters in `/status`
  (`context.trimmed`, `context.droppedChars`, `context.lastTrimAt`).
- 7 tests covering the budget callback, the stats, and the derived context size.

## 1.3.1

Made usable without reading the whole README.

### Added
- **`WEB setup`** — one command that checks Node and the browser, starts the
  server, reports sign-in state in plain language, and writes a correct
  `opencode.json` (with `tool_call: true`) into the current or `--dir` folder.
  Never overwrites an existing config unless `--force`; `--no-write` just prints it.
- **`docs/HELP.md`** — plain-English troubleshooting: symptom, what it means,
  what to type. Covers expired sessions, OTP, "opencode never uses tools",
  401/404/unknown-model, slow steps, queue limits and how to start clean.
- 10 tests for the setup pieces (config shape, no-clobber writing, session
  wording, step rendering).

### Changed
- README quick start now leads with `WEB setup`.
- `docs/PLAN.md`: session replay (P1) is declined — the current page-driven
  approach stays, and hardening is the priority.


## 1.3.0

Login/session handling for the real MiMo flow (**email + password + one-time
code**), plus the audit fixes from 1.2.1.

### Added
- **OTP-aware login detection** (`src/providers/login-flow.ts`): distinguishes
  `signed_in`, `credentials_form`, `verification_required` and `blocked`
  (lockout/captcha) from page content, in English and Chinese.
- **`WEB login` now waits for the sign-in to finish** and closes the browser
  itself once the chat box appears (`LOGIN_TIMEOUT_MS`), instead of asking you to
  close the window and hoping.
- **Login attempt guard**: at most one automatic password submission per
  cooldown (`LOGIN_COOLDOWN_MS`, persisted in `~/.web-agents-to/login-state.json`,
  mode 0600). Stops the automation from triggering lockouts/captchas.
- **`GET /auth/session`** (+ `?probe=1`) and `WEB doctor --probe`: cookie count,
  soonest expiry in days, auth-cookie presence, last abandoned auto-login.
- `/status` includes a session summary; it still never launches a browser.

### Fixed
- Signed-out requests **fail fast** with an actionable hint (`one-time code`,
  lockout, or "run WEB login") instead of crawling every URL twice and burning
  the request timeout.
- Auto-login no longer re-submits credentials on every failed request.
- Email addresses are redacted in logs.


## 1.2.1

Audit pass, verified with a real browser.

### Fixed
- **Double-send risk**: after pressing Enter, a visible send button was clicked
  unconditionally, which posts a second (empty) message on sites where Enter
  already submits. The fallback now only fires when the input still has text.
- **`networkidle` navigation** was used for every page load. Provider SPAs keep
  sockets open, so it never settled and each attempt burned the 45 s timeout.
  Navigation now waits for DOM + the chat input, with cookie handling.
- **Continuation prompts re-sent the full tool spec** on every agent step,
  consuming a large slice of context. Follow-ups now send a one-line reminder;
  schemas are sent once per conversation.
- **Placeholder names** copied from the instructions (`name="NAME"`, `TOOL`, …)
  were parsed as failed tool calls; they are now ignored silently.
- **CLI auto-start** assumed `tsx`; it now falls back to `dist/server/main.js`.

### Added
- `CHROMIUM_EXECUTABLE` / `BrowserManagerOptions.executablePath` for containers
  and CI images that ship their own Chromium.
- Real-browser test suite (`test/browser-e2e.test.ts`) against
  `test/fixtures/mock-chat.html`, covering incremental streaming, tool-block
  preservation, continuation vs. new conversation, single-bubble UIs, long
  answers, busy notices and serialisation. Skips when no browser is available.
- `docs/AUDIT.md`: findings, verification evidence and unverified areas.

## 1.2.0

opencode compatibility and a much stricter tool-call layer.

### Fixed
- **Tool calls now match opencode's parser exactly**: one delta per call with
  `id`, `type`, `function.name`, valid JSON `arguments` and a numeric `index`,
  followed by a **separate** `finish_reason: "tool_calls"` frame. Content is
  never sent after a finish reason.
- **Text streams immediately even when tools are enabled.** A hold-back buffer
  suppresses partial `<tool_call>` tags instead of buffering the whole answer.
- **Missing finish_reason in the plain-text path** (caused "stream ended without
  a finish reason") — every stream now terminates explicitly.
- **Wire heartbeat** (`: ping` every 15 s) so long browser generations don't look
  like a dead connection.
- **Tool names are validated** against the request's `tools`, with alias mapping
  (`read_file`→`read`, `shell`→`bash`, …).
- **Arguments are repaired** (single quotes, trailing commas, comments,
  unquoted keys, fences, OpenAI/mistral/`tool_calls` shapes) and checked against
  each tool's `required` fields; unexecutable calls are dropped and reported to
  the model instead of failing the agent step.
- `tool_choice: "required"` is forwarded into the prompt.
- `max_completion_tokens` and `parallel_tool_calls` are accepted from clients.

### Added
- `WEB doctor [--chat]`: verifies Node, server, auth, models, browser state and
  end-to-end tool calling, then prints a ready-to-paste `opencode.json`.
- `docs/OPENCODE.md` (setup, config rationale, wire contract, troubleshooting
  table) and `docs/opencode.json` example.
- 10 new tests that assert the opencode/AI-SDK stream contract, including a
  proof run against `@ai-sdk/openai-compatible` + `ai` v7 in development.

## 1.1.0

Correctness and security pass over the original prototype.

### Security
- Removed a real account email/password pair from the README. **Rotate that
  password**: it remains in git history.
- `/auth/login` and `/auth/logout` now require the API key; login is limited to
  one in-flight window per provider.
- Bearer tokens are compared in constant time; every route except `/health` is
  protected.
- CORS is restricted to loopback, browser-extension schemes and `CORS_ORIGINS`
  instead of `origin: true`.
- The server refuses to bind a non-loopback interface while the shipped default
  API key is in use (`ALLOW_INSECURE=true` to override), and warns otherwise.
- The agent's file tools are confined to the workspace root; shell commands,
  writes and edits require interactive approval unless `--yes`/`AGENT_AUTO_APPROVE`.
- The extension no longer hardcodes the base URL or key (stored in
  `chrome.storage.local`) and its inline popup script (MV3 CSP violation) is gone.

### Fixed
- **Real incremental streaming**: answers are emitted as deltas while the page
  renders, instead of one blob after the whole generation finished.
- **Concurrency**: per-provider mutex with a bounded queue; parallel clients no
  longer type over each other. Waiting requests abort when the client leaves.
- **Conversation state** is keyed by system prompt + first user turn, so
  switching conversations no longer reuses the previous one.
- **Retries** only repeat requests that produced no output; busy detection reads
  provider-specific patterns and no longer leaks "服务器繁忙" to clients.
- **Request validation** with zod; malformed bodies and unknown models return
  OpenAI-shaped 400s instead of 500s.
- **Lazy browser startup**: `/health` and `/status` no longer launch Chromium.
- Tool protocol supports both `<tool_call name=…>` and generic blocks, reports
  invalid JSON, and can be converted to native OpenAI `tool_calls`.
- The agent is cross-platform (it hardcoded PowerShell on every OS), gained
  `replace_in_file`, step/loop guards and output caps.
- `WEB repl` actually starts the REPL; `WEB models`, `WEB logout`, `WEB version`
  added. Removed dead/unused code paths.

### Added
- `GET /status` with browser/session/queue details.
- `SITE_OVERRIDES` JSON patches for selectors when a provider redesigns.
- `.env` reference with every option, README, `docs/ARCHITECTURE.md`.
- 65 unit and HTTP-level tests (`node:test`), a strict typecheck script and a
  GitHub Actions workflow (Node 20/22).
- Package metadata, `engines`, and `npm run typecheck/test/clean` scripts.
