# Using web-agents-to with opencode

opencode is the intended client: it owns your files, shell and build; this server
only supplies the model through an OpenAI-compatible endpoint.

```
opencode ──tools──► your project (read/edit/bash/build)
    │
    └──/v1/chat/completions──► web-agents-to ──► MiMo web UI (Chromium)
```

Run `WEB doctor` and copy the generated config. Everything below is what it
prints, explained.

## 1. Start the server

```bash
npm run dev          # http://127.0.0.1:8787
WEB login            # sign in once (visible browser, then close it)
npm run doctor       # verifies health, auth, models, and prints your config
```

## 2. Configure opencode

Create `opencode.json` in your project (or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "web-agents-to": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Web Agents To",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "web-agents-to"
      },
      "models": {
        "mimo-v2.6-pro": {
          "name": "MiMo V2.6 Pro",
          "tool_call": true,
          "reasoning": false,
          "attachment": false,
          "temperature": false,
          "limit": { "context": 30000, "output": 8000 }
        }
      }
    }
  },
  "model": "web-agents-to/mimo-v2.6-pro"
}
```

Why each line matters:

| Field | Why |
|---|---|
| `baseURL` | **Must end in `/v1`.** opencode appends `/chat/completions`. |
| `apiKey` | Ignored upstream, but must match `API_KEY` in `.env`. |
| `tool_call: true` | The capability switch. Without it opencode treats the model as tool-less and never sends `tools` — this is the "opencode disables tools" symptom. |
| `reasoning: false` | The web UI exposes no reasoning channel. |
| `attachment: false` | No image/file upload support. |
| `temperature: false` | Sampling can't be forwarded to a chat box. |
| `limit` | Keeps opencode's own context compaction sane; the real ceiling is `MAX_PROMPT_CHARS` on the server. |

Newer opencode builds expose the same switch as `capabilities: { "tools": true }`.
If your build ignores `tool_call`, add that object as well — unknown keys are ignored.

```json
"mimo-v2.6-pro": { "name": "MiMo V2.6 Pro", "capabilities": { "tools": true } }
```

## 3. Run

```bash
opencode                       # uses the model from config
opencode --model web-agents-to/mimo-v2.6-pro
```

Ask for something concrete: *"list the files in src/ and explain the server
entrypoint"*. Approve the first few tool calls and watch them land in your
project.

## 4. What the server guarantees

opencode's parser is strict. The server implements its contract exactly:

| Contract | Implementation |
|---|---|
| Tool call deltas need `id`, `function.name`, JSON `arguments`, numeric `index` | one complete delta per call, ids are unique per call |
| No content may follow a `finish_reason` | text deltas → tool deltas → separate `finish_reason` frame |
| Unknown tool names fail the step | names are matched against the request's `tools`, common aliases (`read_file`→`read`, `shell`→`bash`) are mapped |
| Invalid JSON arguments fail the step | arguments are repaired (single quotes, trailing commas, unquoted keys, fences) and validated |
| Missing required parameters fail the step | required fields are checked against each tool's schema; unusable calls are dropped |
| A dropped call must not kill the run | the model receives a short note instead, so it can retry |
| Streams need a terminator | `: ping` heartbeat every 15 s, then `finish_reason`, then `[DONE]` |

Text is streamed as it appears, with a small hold-back buffer so a
`<tool_call>` block is never leaked into the visible answer.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| opencode shows **no tools** / never calls them | Model capability off | Set `tool_call: true` (and/or `capabilities.tools`) for the model |
| `404` / `Not Found` on chat | `baseURL` missing `/v1` | `http://127.0.0.1:8787/v1` |
| `401 invalid api key` | `apiKey` ≠ server `API_KEY` | Make them match, or clear `API_KEY` in `.env` |
| `unknown model` | Model id typo | Use an id from `WEB models` (`mimo/mimo-v2.6-pro` or the bare `mimo-v2.6-pro`) |
| `login_required` | Not signed in to the provider | `WEB login`, sign in, close the window |
| "tool call failed" on a specific tool | Arguments did not fit the schema | Usually retryable; the model gets a note and tries again |
| Turns take 60–120 s | The model runs in a browser | Lower `limit.output`, ask for smaller steps |
| Second opencode window hangs / both stall | One conversation per provider | Run one agent at a time; `MAX_QUEUE` only queues, it doesn't add parallelism |
| Empty replies after working earlier | MI UI changed or session expired | `WEB logout && WEB login`; if the UI changed, patch selectors via `SITE_OVERRIDES` |
| `429 queue_full` | Too many concurrent requests | Wait, or raise `MAX_QUEUE` |

## 6. Limits to keep in mind

- **Serialised**: one chat at a time per provider. opencode subagents and
  parallel tool calls queue behind each other.
- **Text-protocol tools**: the model is *asked* to emit `<tool_call>` blocks and
  the server translates them. It is not native function calling, so expect the
  occasional malformed call (which is now dropped with a retry note rather than
  failing the step).
- **Context**: history is flattened into the provider's textarea and capped by
  `MAX_PROMPT_CHARS` (~30k tokens by default). Long sessions get compacted by
  opencode; keep `limit.context` aligned with that cap.
- **No images, audio or structured output.**
- **Terms of service**: you are automating a consumer web UI. Use an account you
  are comfortable risking.
