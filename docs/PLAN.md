# Plan — what to take from the Chat2API landscape (MiMo-only)

Status: **plan only, nothing implemented.** Scope stays exactly one target:
**MiMo V2.6 Pro** for opencode. No multi-provider bazaar.

---

## 1. Verdict in one line

Use that write-up as a **prior-art checklist and a source of three techniques** —
not as an architecture template. Our repo is already past it on the parts that
matter (it has no browser automation at all), and one item in it ("official MiMo
API") changes the strategy more than everything else combined.

---

## 2. Fact-check of the message

| Claim | Verdict | Reality |
|---|---|---|
| "Chat2API / Web-to-API is an established ecosystem" | **True** | `xiaoY233/Chat2API` (1.7k ★, TS) and `Amm1rr/WebAI-to-API` (1.4k ★, Python) are active. |
| "People already proxy MiMo" | **True** | Chat2API lists **Mimo — auth: Cookie + OAuth**, models V2.5-Pro/V2.5/Flash. We are not first, and not even first for MiMo. |
| "MiMo has an official OpenAI-compatible platform at `api.xiaomimimo.com/v1`" | **True** | Confirmed: `platform.xiaomimimo.com`, `https://api.xiaomimimo.com/v1`, model id `mimo-v2.6-pro`. It also exposes an **Anthropic-compatible** endpoint (`/anthropic`). |
| "…giving developers direct access" (implying free) | **Misleading** | The platform is **pay-as-you-go** (~$0.435 in / $0.87 out per 1M for V2.6 Pro) with trial credits for new accounts. "Free" applies to the **Studio web chat** we already scrape, and to **V2.6-Flash** (not Pro) on OpenCode Zen, time-limited and with data used for training. |
| "No real tool-calling support — must be prompted" | **True for web UIs** | That is exactly what we built. But the **official API has native function calling**, which we currently cannot use at all. |
| "Session expiry, WAFs, context clipping are the failure points" | **True** | Matches what our audit found. Good checklist. |
| Their suggested techniques (CDP attach, token refresh, session chaining, prompt tools) | **Mostly right** | We already do session chaining + prompt tools; we do **not** do CDP attach or token refresh. |

One more thing the message missed, and it is the strongest argument for the
official route: it is **Anthropic-compatible too**, so Claude Code could use it
later without any proxy of ours.

---

## 3. Where we actually stand vs. their list

| Capability | Chat2API / WebAI-to-API | Us today |
|---|---|---|
| OpenAI-compatible `/v1` | yes | **yes** |
| SSE streaming | yes | **yes** (incremental DOM deltas) |
| Prompt-engineered tool calling | yes ("universal") | **yes**, plus alias mapping, JSON repair, schema validation, tag suppression |
| Multi-provider | yes | no — **on purpose** |
| Model mapping / multi-account | yes | no — single MiMo account, on purpose |
| Session persistence | cookie/JWT + refresh | **persistent Chromium profile** |
| Re-auth on expiry | OAuth refresh tokens | ❌ throws `login_required`, you re-login manually |
| Calls the site's **internal web API** with the session | **yes** (their primary path) | ❌ DOM scraping only |
| Attach to your real browser (CDP) | partial | ❌ |
| Context overflow handling | rolling threads / summarise | ⚠️ silent middle-truncation |
| Official API support | n/a | ❌ |

The two rows that matter most are **internal-API replay** and **official API**.

---

## 4. The three tiers, and what I recommend

```
T1  Official API      api.xiaomimimo.com/v1        paid, native tools, 1M ctx, /anthropic
T2  Site internal API same login, replay the       free, real SSE, fast, no DOM
    (session replay)  site's own chat request
T3  DOM automation    what we have today           free, fragile, simulated stream
```

### Recommendation

**Ship T1 as an optional provider. Then try T2 as the fast path, keeping T3 as
the always-working fallback.**

Why T1 first, even though you asked for free:
- It is the only path with **native tool calling, real streaming, a 1M context
  window and no ban risk** — i.e. it deletes almost every caveat in our README.
- It is genuinely cheap: a heavy agent day (~300k in / ~60k out) is roughly
  **$0.18**. That is not "buying an API tier", it is less than a coffee per month.
- It is a small change *because of our existing design*: `Provider` is already an
  interface; a `MimoApiProvider` is one file + config + doctor check. The payoff
  of the abstraction we already paid for.
- It unblocks Claude Code later via `/anthropic` (no new proxy to write).

Why T2 second: Chat2API's whole advantage is that it does not scrape the DOM —
it authenticates once and then talks to the backend the site itself uses. We are
one step away from that: **the same Playwright context that holds the session can
record the site's real chat request** (URL, headers, body, streaming format), and
then replay it. Gain: real token streaming, ~10× lower latency, no selectors, no
typing, survives UI redesigns. Risk: the request may be signed/encrypted, and it
is still ToS-grey — so it must be feature-flagged with automatic fallback to T3.

T3 stays: it is the only thing that works when they change the private API and
you do not want to maintain a reverse-engineering effort that week.

---

## 5. Phased roadmap

### P0 — Official MiMo API provider (highest value, lowest risk)
- `src/providers/mimo-api.ts`: `fetch` against `${MIMO_API_BASE}/chat/completions`,
  pass `tools`/`tool_choice` **through untouched**, stream the upstream SSE
  mapped 1:1, surface `usage` verbatim.
- Add a `passthrough` capability flag to `Provider` so the server **skips**
  `ToolCallSuppressor` / `parseToolCalls` / prompt injection for this provider
  (they would double-process native tool calls).
- Config: `MIMO_API_KEY`, `MIMO_API_BASE` (default `https://api.xiaomimimo.com/v1`),
  `PROVIDERS=mimo,mimo-api`.
- `WEB doctor` gains an "official API" section (key present, models listed, one
  real tool call).
- Effort: **1 session** (~250 lines + tests). Acceptance: opencode issues a task,
  MiMo returns a native `tool_calls` delta, bash executes, two steps complete,
  `usage` reported.

### P1 — Session-backed API replay (T2, the interesting one)
- In the existing profile page, capture one real chat request via
  `page.on("request")` / `context.route`; store shape in
  `~/.web-agents-to/providers/mimo-api-capture.json`.
- Replay from the same context (`context.request`) so cookies/CSRF are valid;
  parse the upstream stream into deltas.
- Feature flag `MIMO_TRANSPORT=dom|replay|auto`, default `auto` = try replay,
  fall back to DOM on any 4xx/schema mismatch.
- Effort: **1–2 sessions**, uncertain by nature. Acceptance: identical output to
  T3 in a side-by-side test, lower latency, and a clean automatic fallback when
  the capture is stale.

### P2 — Reliability that the prior art does better
- **Re-auth instead of throwing**: on `login_required`, optionally open a headed
  window (or reuse CDP-attached Chrome) and retry once; `/status` reports
  `needs_login`.
- **CDP attach**: `CHROME_CDP_URL=http://127.0.0.1:9222` to drive your everyday
  Chrome — no browser download, real fingerprints, your existing login.
- **Context management**: replace silent middle-truncation with rolling new
  conversations + a summarise-and-continue turn; expose the real cap in
  `/status` so opencode compacts before we truncate.
- Effort: **1 session**.

### P3 — Docs & polish
- Update `docs/OPENCODE.md` with the three transport options and a decision
  table; `docs/AUDIT.md` refresh; README "which route should I use".

---

## 6. Explicitly **not** doing (and why)

| Rejected | Reason |
|---|---|
| Captcha solvers (2Captcha, slider bots) | Arms race, cost, ToS violation, and single-account scope makes it pointless. |
| `puppeteer-extra-plugin-stealth` | Fragile and actively hostile to the provider; a real-session profile or CDP attach is honest and more reliable. |
| Multi-account token pools / rotation | The thing that gets accounts and IPs banned. Out of scope. |
| Electron desktop app, provider marketplace, model mapping zoo | Directly against "focus on MiMo V2.6 Pro only". |
| Chasing every provider in that list | Each one is a maintenance liability; one target, done well. |

---

## 7. Decisions (answered 2026-10-24)

**1. Official API: NO.** The owner wants web-chat-only; no key, no billing.
→ **P0 is dropped.** Keep `docs/PLAN.md` P0 as a documented escape hatch only.

**2. MiMo login is email + password + a one-time code.** → Implemented in 1.3.0:
OTP detection, fail-fast hints, `WEB login` that waits for the code and closes
itself, a persisted attempt guard, and `/auth/session` + `WEB doctor --probe` so
a dead session is visible before an agent run. Auto-login can only pre-fill and
is rate limited; it can never complete a login, and it no longer retries.

**3. ToS risk on session replay: not answered.** P1 stays blocked until it is.

Consequence: with P0 removed, **P1 (replaying the site's own chat endpoint with
the saved session) is the only remaining way to get real token streaming and to
stop depending on DOM selectors.** Everything else is hardening.

## 8. Original decision list (for the record)

1. **Do you want the official API route at all** (paid, ~$0.18 for a heavy day,
   but native tool calling + 1M context + no bans)? If yes, P0 is the next thing
   I build. If no, everything stays T3 and we only harden it.
2. **Is your MiMo account a Xiaomi password account or Google SSO?** It decides
   whether auto re-auth can ever work headlessly (Google SSO will always need a
   visible window).
3. **Accept ToS risk on T2?** Replaying the site's private API is still their
   terms' grey zone; T1 is the clean route.

---

## 8. What to run before any of this

On a machine with internet (this environment can only reach npm/PyPI/GitHub):

```bash
npm run dev
HEADLESS=false WEB login      # confirm the profile + selectors still work
WEB doctor --chat             # one real tool call, end to end
```

If that passes, T3 is healthy today and P0/P1 are pure upside. If it fails, the
selector/transport work moves ahead of everything else.
