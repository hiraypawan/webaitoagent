# If something breaks, do this

Plain English. No jargon. Pick the symptom you see.

---

## First: is it alive?

```bash
WEB doctor
```

Green `[PASS]` on every line means the plumbing is fine. Anything marked `FAIL`
prints a `fix:` line underneath — type exactly that.

---

## "It says login_required", or "one-time code"

Your MiMo sign-in has expired. This is normal; it happens every so often.

```bash
WEB login
```

A browser window opens. Type your email, your password, and then the code MiMo
sends you. **You do not have to close the window** — it closes itself when the
chat box appears (give it up to 5 minutes).

Then confirm it worked:

```bash
WEB doctor --probe
```

That one actually opens the site and checks. If it says `signed in`, you're done.

> A password alone can never finish this login. MiMo always asks for the code, so
> signing in is always something a person does. Nothing is broken.

---

## opencode shows a model but it never uses tools / never edits files

Almost always the config. Run:

```bash
WEB setup
```

It writes the right `opencode.json` for you. The critical line is `"tool_call": true`
— without it opencode thinks the model cannot use tools and never sends them.

If your project already had an `opencode.json`, it will not be overwritten:

```bash
WEB setup --force
```

---

## "connection refused" / opencode cannot reach the model

The little local server is not running. Start it and leave that window open:

```bash
npm run dev
```

Then in a **second** window use `opencode` as usual.

---

## "401 invalid api key"

The key in `opencode.json` and the key in your `.env` must match.

- Look in `.env` for `API_KEY=...`
- Look in `opencode.json` for `"apiKey": "..."`
- They must be identical. Easiest fix: delete `opencode.json` and run `WEB setup`
  again — it copies the current key for you.

---

## "unknown model"

The model name is wrong. See the real list:

```bash
WEB models
```

Copy one of those into opencode, e.g. `mimo-v2.6-pro`.

---

## It works, then stops mid-task, or answers look cut off

Two usual causes.

1. **The session died.** `WEB doctor --probe`, then `WEB login` if needed.
2. **The conversation got too long** for MiMo's web chat box. Check with:

   ```bash
   WEB status
   ```

   If `context.trimmed` is going up, history is being dropped. Start a fresh chat
   (`/new`), work in smaller steps, or raise `MAX_PROMPT_CHARS` in `.env` and run
   `WEB setup --force` again so opencode is told the bigger window too.

---

## "429 queue_full" or everything feels stuck

Only one conversation can run at a time, because it is one browser tab.

- Don't run two opencode windows against it at once.
- Close other agents (Cline, Cursor, etc.) pointing at the same server.

---

## It is very slow (minutes per step)

Expected. The model is being typed into a website and the answer is read back off
the screen. A step is usually 20–90 seconds.

To make it less painful:

- Ask for smaller chunks ("fix this one test" instead of "refactor the project").
- Keep `"limit": { "context": 30000, "output": 8000 }` in `opencode.json`.

---

## "Automatic sign-in paused" / it keeps skipping login

Working as intended. The tool stops trying your saved password after a failed
attempt, because repeated wrong attempts can lock your account. Wait ~15 minutes
(`LOGIN_COOLDOWN_MS`), then:

```bash
WEB login
```

---

## I broke something and want to start clean

```bash
WEB logout
```

Then remove the saved session folder and sign in again:

- Windows: `%USERPROFILE%\.web-agents-to`
- macOS/Linux: `~/.web-agents-to`

```bash
WEB login
```

---

## Nothing helps

```bash
WEB doctor --probe
WEB doctor --chat
```

`--chat` sends one real message and checks that a tool call comes back. Copy the
whole output somewhere — it says exactly which step failed, which is what a
developer (or an AI assistant) needs to fix it.

---

## What is safe to share

Safe: the output of `WEB doctor`, error messages, your `opencode.json` **after
removing the `apiKey` line**.

Never share: your MiMo password, your one-time codes, or the contents of
`~/.web-agents-to` (it holds your live login cookies).
