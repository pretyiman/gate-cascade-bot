# CLAUDE.md

Durable project context for any AI agent session working on this repo. Read this
before making architectural changes. This file records constraints and decisions
that should outlive any single conversation - it is committed to git specifically
so a paused/resumed development session (or a different agent entirely) doesn't
drift from what's already been decided. Update it whenever a durable decision is
made; day-to-day task state belongs in the conversation, not here.

For the strategy explanation, setup instructions, and API reference, see `README.md`.
This file is architecture/constraints-focused, not a feature list.

## Hard constraints - do not violate without the user explicitly re-confirming

1. **Never alter the %-based cascade creation path when adding new features.**
   Every feature added since it was built (manual template creation, native
   triggers/WebSocket, backtesting) has been strictly additive - a parallel code
   path that reuses the same pure math (`cascadeMath.js`), never a modification
   to it. If a change would touch `computeLevels`/`selectNextLevel`'s existing
   behavior, stop and confirm with the user first.
2. **DRY_RUN (and `FORCE_DRY_RUN`) must always remain a fully faithful
   simulation.** No live API calls, no synchronous eager placement, no native
   trigger/WebSocket behavior for dry-run users - dry-run is how this entire
   project has been tested throughout its development, verified stage-by-stage
   after every change. `buildClientForUser(user)` returning a non-null client
   does NOT mean live - check `client.dryRun` separately; `client === null`
   only means no API key is configured yet.
3. **Never reuse a real Gate.io API key, or flip `ENABLE_GATE_WS` on, without
   the user explicitly asking again in that specific moment.** Real-money/live-
   account verification is always manual and user-initiated - never automate,
   schedule, or proactively suggest running it.
4. Never commit `.env` (already gitignored - keep it that way).
5. Prefer new commits over amending; never force-push; never skip git hooks.

## Architecture map (`src/`)

- **`db.js`** - SQLite schema. Migrations are non-destructive `ALTER TABLE ...
  ADD COLUMN` wrapped in try/catch on "duplicate column name" errors. New
  *tables* are appended as new `db.exec` blocks at the bottom of the file, not
  edited into the original `CREATE TABLE` template literals - keeps diffs
  reviewable and matches how this file has actually evolved.
- **`symbol.js`** - `normalizeSymbol()`, the single source of truth for
  pair-string normalization (bare ticker / any separator / any case -> `BASE_USDT`).
- **`gateClient.js`** - all Gate.io REST calls. `createClient({apiKey, apiSecret,
  dryRun})` factory - every method has a dry-run branch that fabricates a
  response and never touches the network. Also exports module-level public
  (no-auth) helpers: `getPublicTicker`, `getPairPrecision` (cached),
  `getCandlesticks` (paginated OHLC, see gotchas below), `computeReactiveTriggerPrice`.
- **`cascadeMath.js`** - *all* pure, dependency-free math and simulation logic.
  `computeLevels`, `computeSellTarget`, `selectNextLevel` (skip-ahead),
  `normalizeManualLevels`, `simulateCascadeBacktest`. Anything that can be
  expressed as pure math belongs here, not in `cascadeEngine.js` - it's what
  keeps this project's core logic unit-testable without mocking I/O. If you add
  new business logic, ask first whether it can live here.
- **`cascadeEngine.js`** - the live engine: `createCascade`/`createCascadeFromLevels`,
  `tickCascade` (one poll/reactive-wake pass), `placeNextLevel` (skip-ahead
  placement, shared by the poll path and the reactive WS path), `armCascadeSynchronously`
  (best-effort eager placement at creation/resume - live users only, gated on
  `client && !client.dryRun`), hold/resume/cancel/delete, per-level edit/cancel.
- **`lock.js`** - `withLock(key, fn)`, an in-memory per-cascade-id async mutex.
  Prevents the WebSocket reactive path and the poll timer from ticking the same
  cascade concurrently. The deployment is single-process/single-writer by
  design (confirmed, not assumed) - don't build DB-level advisory locking
  unless that topology actually changes.
- **`gateWs.js` / `reconciler.js`** - per-user WebSocket connection manager +
  periodic eligibility sweep, entirely behind `ENABLE_GATE_WS` (default off).
  The inert-when-off guarantee lives *inside* `gateWs.js`'s `isEligible()`, not
  just in `reconciler.js`'s sweep - so any caller (including `api.js`'s eager
  `ensureUserConnection` calls after cascade creation/resume/settings changes)
  is safe regardless of which code path reaches it.
- **`backtestEngine.js`** - orchestration over `cascadeMath.js`'s
  `simulateCascadeBacktest` + `gateClient.js`'s `getCandlesticks`; persists to
  the `backtests` table (hybrid schema: JSON blobs for `config`/`results`,
  plus hoisted summary columns so the list view needs no per-row JSON parsing).
- **`auth.js` / `secretsCrypto.js`** - invite-only accounts via single-use
  expiring tokens (operator never sees/sets real passwords), Gate.io API
  keys encrypted at rest (AES-256-GCM, keyed by `ENCRYPTION_KEY`).
- **`api.js`** - Express routes. `app.use(requireAuth)` is applied once;
  everything registered after that line is automatically session-protected.
- **`scheduler.js`** - the always-on poll timer (`tickAllActive`, currently
  30s). Never removed even after the native-trigger/WebSocket work landed -
  it is always the safety net, not a legacy path to delete.
- **`public/*.html` / `app.js` / `styles.css`** - no framework, no build step.
  View-switching pattern: each top-level view (list/detail/settings/admin/
  backtest/backtest-detail) is a `<section>`, shown via a `show*()` function
  that hides every *other* section (and the TradingView chart panel) before
  loading its own data. When adding a new top-level view, update every
  existing `show*()` function to hide it too, or it'll leak into other views.

## Key design decisions (why, not just what)

1. **Native trigger orders: only level 1 arms one at cascade creation; every
   level after that is placed reactively** (one at a time, triggered by a fill
   event or the poll), each doing its own fresh price check via the exact same
   `selectNextLevel` skip-ahead logic. This is deliberate: pre-registering
   multiple native triggers up front would let Gate.io fire several of them
   near-simultaneously on a fast crash, defeating the entire point of a
   cascade ("ladder capital, don't deploy it all at once" - the README's own
   opening line). **The invariant "at most one level is ever resting/armed at
   a time" is load-bearing and must never be violated by future changes** -
   it's what makes the crash-safety property structural rather than incidental.
2. **Levels 2+ also use a native trigger, not a plain resting order**, once
   armed reactively - a computed buffer (0.02% above the buy price, rounded to
   the pair's real Gate.io precision, guaranteed at least one exchange tick of
   separation after rounding) keeps USDT unlocked until price is genuinely
   close, mirroring the same benefit level 1's explicit `trigger_price` gets.
3. **Backtest decision-price rule**: every `selectNextLevel` call inside
   `simulateCascadeBacktest` uses the exact price at the crossing event that
   triggered it, never an OHLC aggregate like `close` (that would leak
   look-ahead information a live poll wouldn't have had). Arm-time uses
   `trigger_price` itself, or the first candle's `open` if there's no trigger.
   After a level's **buy** fills (verified against the live `tickCascade`/
   `placeNextLevel` code - the next level's evaluation is gated purely on
   buy-side status, with zero dependency on whether that level's sell has
   filled), the fill candle's **`low`** - not just `target_price` - is the
   decision price for the next level, so a single fast-crash candle can still
   correctly trigger skip-ahead across multiple levels.
4. **Same-candle buy+sell is disallowed in the backtester** - a level's own
   take-profit sell can only fill starting the candle *after* its buy fill,
   since OHLC data can't prove intra-candle event order, and the live engine
   always has a real gap between fill-detection and sell-placement anyway.
5. **Gate.io's `/spot/candlesticks` rejects the whole request (400) if
   `from`→`to` implies more than 1000 points**, even with `limit` explicitly
   set - `getCandlesticks`'s pagination bounds each page's own `to`, not just
   an advancing `from` cursor (with an off-by-one: span must be
   `(1000-1)*intervalSeconds`, since an inclusive range of exactly 1000
   intervals yields 1001 points).
6. **Multi-tenant from the ground up**: one deployment, N invited users, each
   with their own encrypted Gate.io key and independent `dry_run` flag. Don't
   conflate "no client" (`buildClientForUser` returned `null`, no key
   configured) with "dry-run" (`client.dryRun === true`, key configured but
   simulating) - they gate different things throughout the codebase.

## Testing conventions

- `npm test` runs `test/cascadeMath.test.js` and `test/gateClient.test.js`
  (plain Node `assert`, no framework). Every pure function addition gets unit
  tests here, including edge cases discovered while writing them (e.g. the
  fast-crash skip-ahead bug and the Gate.io pagination off-by-one were both
  caught this way, not by inspection).
- No frontend test framework - UI changes are verified with a throwaway
  headless Chrome + raw CDP WebSocket script: launch `chrome.exe --headless=new
  --remote-debugging-port=<port> --user-data-dir=<isolated tmp dir>`, script
  drives it via `Page.navigate`/`Runtime.evaluate`/`Page.captureScreenshot`,
  then both the script and the isolated Chrome instance are deleted afterward.
  **Never `taskkill /IM chrome.exe`** - it kills the user's real browser
  windows too (this happened once). Always resolve the exact PID first via
  `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object
  { $_.CommandLine -like '*<your unique profile dir>*' }`, then
  `taskkill /PID <pid> /T /F` on that specific tree only.
- Every DB migration is verified by restarting the app and checking for
  migration errors, then `PRAGMA table_info(<table>)` to confirm the schema.
- Every stage of a multi-stage feature is verified in isolation (syntax check,
  unit tests, then a real HTTP/CLI/browser check) before moving to the next
  stage - don't batch verification to the end of a feature.

## Status / decisions already made against alternatives

- **Copy-trading** (auto-replicating an admin's cascade to followers) was
  proposed, then explicitly shelved by the user in favor of the manual-template
  feature. Not built, not currently planned - don't resurrect without the user
  raising it again.
- **Merging with freqtrade was considered and rejected.** freqtrade's
  one-averaged-entry-price-per-trade model and lack of native-trigger-order
  support don't fit this bot's per-level-independent-take-profit design -
  adopting it would mean reimplementing this project's own ledger inside
  freqtrade's strategy callbacks while losing the multi-tenant web UI. Running
  both bots side-by-side on one server is fine (independent processes); merging
  the strategy logic is not planned.
- **`ENABLE_GATE_WS` (per-user WebSocket layer) is built and unit/mock-tested
  but NOT yet verified against a real live Gate.io connection** - flagged in
  `gateWs.js`'s own file header. Don't flip it on, or claim it works live,
  without the user explicitly initiating that test with real credentials.
- **Cascade backtesting is complete**: native candle fetch with pagination,
  pure simulation reusing the live engine's own math, saved history with a
  list/detail/delete UI. See `git log` for the exact commit and this file's
  design-decisions section above for the modeling assumptions.

## Where to find more

`git log --oneline` then `git show <hash>` for the full detail behind any
historical decision - commit messages in this repo are deliberately
descriptive, not terse. This file records durable architecture/constraints
only; anything that changes per-conversation (current task, in-progress work,
what to do next) belongs in the conversation, not here.
