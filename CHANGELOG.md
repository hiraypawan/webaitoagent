# Changelog

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
