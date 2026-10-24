# Web Agents To

Bridge free web AI models (Xiaomi MiMo Studio, etc.) to a local OpenAI-compatible API,
CLI, and browser extension.

## Quick start

```bash
npm install
npm run dev
```

Server runs on http://127.0.0.1:8787

### Login to a provider (MiMo)

```bash
# start server first, then:
npm run login -- --provider=mimo
```

A headed browser opens. Log in with your Xiaomi account, then close the window.
The session (cookies) is persisted under ~/.web-agents-to/profiles/mimo.

You can also set MIMO_USER / MIMO_PASS in .env for automatic login attempts.

### Use the CLI

```bash
npm run cli -- "Hello, who are you?" --model=mimo/mimo-v2.6-pro
```

### Agentic coding (tool use)

```bash
WEB agent "list the files in this directory and summarize the project"
WEB agent "read README.md and suggest improvements"
```

The agent runs a loop: MiMo decides which tools to call (bash, read_file, write_file, list_dir), the tool runs locally, results feed back to MiMo, repeat until done. This gives you an agentic coding assistant on the free MiMo flagship model.

### OpenAI-compatible API

```bash
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer web-agents-to"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer web-agents-to" \
  -d '{"model":"mimo/mimo-v2.6-pro","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

### Browser extension

Load the `extension/` folder as an unpacked extension in Chrome/Edge.

## Configuration (.env)

```
PORT=8787
HOST=127.0.0.1
HEADLESS=true
API_KEY=web-agents-to
MIMO_USER=
MIMO_PASS=
```

## Notes

- This automates the public web UI of providers; it is not an official API.
- Respect each provider's Terms of Service. Free tiers may have rate limits.
- Selectors are best-effort; if a site changes its UI, update src/providers/*.ts.

## Architecture

- src/core: shared types
- src/browser: Playwright persistent-context manager
- src/providers: site adapters (MiMo, Mock)
- src/server: Fastify OpenAI-compatible server
- src/cli: CLI client + login helper
- extension: Chrome extension (Manifest V3)
EOF