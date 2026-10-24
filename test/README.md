# Tests

```bash
npm test          # unit tests (node:test via tsx)
npm run typecheck # strict TypeScript check
```

Unit tests cover the pure layers: prompt building, SSE parsing, answer-diffing,
the keyed mutex and the tool-call protocol. The browser providers need a real
Playwright session and are exercised manually with `WEB login` + `WEB chat`.
