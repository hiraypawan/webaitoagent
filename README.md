# Web Agents To

Bridge free web AI flagship models (Xiaomi MiMo V2.6 Pro, etc.) to a local OpenAI-compatible API, CLI, and browser extension.

## Quick start

```bash
npm install
npm run dev
```

Server runs on http://127.0.0.1:8787

### Login to MiMo

```bash
npm run login -- --provider=mimo
```

A browser opens for Xiaomi account login. Close it when done — session saved to `~/.web-agents-to/profiles/mimo`.

Or set `.env`:
```
MIMO_USER=justcheck008@gmail.com
MIMO_PASS=Nawap@098
```

### CLI chat

```bash
npm run cli -- "Hello, who are you?" --model=mimo/mimo-v2.6-pro
```

### Interactive chat

```bash
WEB
```

Type prompts and get streamed responses from MiMo V2.6 Pro.

### Agentic CLI (tools)

`WEB` runs an agent loop with local tools: `bash`, `read_file`, `write_file`, `list_dir`.

```bash
WEB
Agent> list the files here and summarize this project

WEB agent "read README.md and suggest improvements"
```

The model emits `<tool_call name="...">`, the CLI executes it locally, feeds the result back, and repeats until done. This gives you a local coding agent on the free web model.

### OpenAI-compatible API

```bash
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer web-agents-to"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer web-agents-to" \
  -d '{"model":"mimo/mimo-v2.6-pro","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

### Browser extension

Load `extension/` folder as unpacked extension in Chrome/Edge.

## Configuration (.env)

```
PORT=8787
HOST=127.0.0.1
HEADLESS=true
API_KEY=web-agents-to
MIMO_USER=
MIMO_PASS=
```

## Architecture

- src/core: shared types
- src/browser: Playwright persistent-context manager (reuses session, no new page per request)
- src/providers: MiMo adapter with retry logic
- src/server: Fastify OpenAI-compatible server
- src/cli: CLI client + interactive REPL
- extension: Chrome extension (Manifest V3)
- bin/web.js: `WEB` launcher command
