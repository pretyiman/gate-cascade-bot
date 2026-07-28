# gate-cascade-bot

A Gate.io spot cascade DCA bot. Instead of placing every buy level at once (which
freezes USDT for all of them immediately), this places **one buy level at a time** -
the next level is only submitted once the previous one fills. Each filled level gets
its own independent take-profit sell, with the profit % laddering up per level. Cascades
can be configured with simple % step-downs, or with an exact per-level manual template,
and either can be backtested against real historical Gate.io prices before risking funds.

## Strategy

You configure one "cascade" per pair, either with % based steps or an exact manual
template.

**% based:**

- `base_price` / `base_amount_usdt` - level 1's limit buy price and USDT size.
- `price_step_pct` - each subsequent level is this % below the previous level's price.
- `amount_step_pct` - each subsequent level's USDT size is this % larger than the previous.
- `num_levels` - how many levels total (not fixed).
- `take_profit_base_pct` / `take_profit_step_pct` - level 1 sells at `+take_profit_base_pct%`
  profit; each deeper level's take-profit % increases by `take_profit_step_pct` (e.g. base=5,
  step=1 -> level 1 sells at +5%, level 2 at +6%, level 3 at +7%, ...).
- `trigger_price` (optional) - the cascade stays armed-but-inactive until market price
  reaches this, then level 1 goes live.

**Manual template:** the same underlying levels, but each one's buy price, USDT amount,
and exact sell price are typed in directly instead of computed from % steps - useful when
you want full control over an unevenly-spaced ladder. See "Manual template creation" below.
Both forms are equally supported everywhere (creation, hold/resume, editing, backtesting) -
neither is a lesser feature bolted onto the other.

**Skip-ahead safeguard:** before placing the next level, the engine checks the current
market price. If that level's target price is already at/above the market (meaning
placing it would fill instantly rather than rest and wait for the dip), it's skipped and
the next deeper level is tried instead - unless it's the last level, in which case it's
placed anyway so that tranche of capital doesn't sit undeployed forever. **At most one
level is ever resting/armed at a time** - this is the core safety property that keeps a
fast crash from deploying your whole ladder's capital at once.

## Real-time execution

Two complementary mechanisms keep a cascade moving, in order of preference:

1. **Native trigger orders.** Level 1 arms one of Gate.io's own price-triggered
   conditional orders at creation time (for live, credentialed users) - your USDT stays
   unlocked until price is genuinely close, since Gate's own servers watch the market
   instead of this bot polling for it. Every level after that is armed the same way,
   reactively, one at a time, right after the previous level's fill - never all
   pre-registered up front, which is what preserves the one-at-a-time safety property
   above even during a fast multi-level crash.
2. **A background poll** (`src/scheduler.js`, every `DEFAULT_POLL_INTERVAL_SECONDS`,
   default 30s) is the always-on safety net - it arms triggers, places/skips levels, and
   checks for fills exactly as before, so nothing depends on the optional pieces below to
   function correctly.

Optionally, a **per-user WebSocket connection** (`src/gateWs.js`, behind the
`ENABLE_GATE_WS` env flag, default off) wakes a cascade the instant a fill happens instead
of waiting for the next poll - purely a latency optimization on top of the poll, not a
replacement for it. Dry-run accounts (and anyone with `FORCE_DRY_RUN=true`) never use any
of this - they're always driven by the plain poll, unchanged, which is also how this
entire project has been tested throughout its development.

## Manual template creation

Click **+ Manual Template** (next to **+ New Cascade** in the cascade list - only one of
the two forms is ever open at a time) and fill in each level's exact buy price, USDT
amount, and sell price directly. Sell price must be higher than buy price. Level 1's buy
price is also sanity-checked against the pair's live market price and rejected if it's
implausibly far off (e.g. a misplaced decimal, like `0.7256` instead of `0.07256`) - Gate.io
itself won't catch this, since a technically-valid-but-wrong limit price just fills
instantly at a bad price instead of erroring.

## Backtesting

Open **Backtest** (next to Admin/Settings) to replay a proposed cascade - % based or
manual template, your choice - against real historical Gate.io candles before risking any
capital. Pick a pair, candle interval, and a custom date range, and it simulates fills
using the *exact same* skip-ahead/take-profit logic the live engine uses (not a separate
approximation), so results reflect real behavior. Every run is saved so you can build up a
history and compare parameter tweaks, and can be deleted from the list or its detail view.

A few things worth knowing about how the simulation works:

- **Fees**: the `Fee %` field is charged on both the buy and sell leg of every trade
  (deducted from what you *receive*, matching how Gate.io's real fees work) - set it to 0
  to see the frictionless ceiling of a strategy, or a realistic value (Gate's typical spot
  fee is ~0.2%, the default) to see expected real returns.
- **Interval and range are capped together**: a request is rejected if the date range
  would need more than 6000 candles at the chosen interval (e.g. a 7-day range needs a
  coarser interval than 1-minute) - shorten the range or pick a coarser interval.
- **A level's own buy and sell never fill on the same candle** - OHLC data can't prove
  which happened first within one candle, and the live engine always has a real gap
  between detecting a fill and placing the take-profit sell anyway, so this is a
  deliberately conservative simplification, not a bug if you see a one-candle delay.
- It's normal for one level's sell and a *different* level's buy to land on the same
  candle/timestamp - those are two independent orders, not the same round trip.

## TradingView chart

Admins see a live TradingView chart plus a trending-coins sidebar at the top of the
list/detail views (hidden on Settings/Admin/Backtest, since it's a market-glance tool, not
relevant there). Search any pair or click a trending coin to switch the chart.

## Setup

The app is multi-tenant: each user logs in and provides their own Gate.io API key/secret
via the Settings screen (encrypted at rest) instead of one shared key in `.env`. Accounts
are invite-only - there's no public signup form and the operator never sets or sees
anyone's real password; instead you generate a single-use link and send it to them however
you want (no email integration involved). Settings also has a **Test** button that makes
one real, read-only wallet-balance call to verify a key actually works, regardless of your
dry-run setting.

```
npm install
cp .env.example .env
# generate ENCRYPTION_KEY and paste it into .env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node scripts/create-invite.js you@example.com --admin
npm run dev
```

That prints a link (`/set-password?token=...`, valid 7 days, single-use) - open it to set
your own password, which logs you straight in. Then open **Settings**, paste your Gate.io
API key/secret (Spot trading permission required), click **Test** to confirm it works, and
leave **Dry Run** on while testing - `placeOrder`/`cancelOrder`/trigger-order calls just log
what they would send and fabricate fake order ids, so nothing ever hits Gate.io. Turn Dry
Run off per-account only once you've verified a config's behavior and are ready to trade
with real funds - start with a very small `base_amount_usdt`. `FORCE_DRY_RUN=true` in
`.env` overrides every account back to dry-run regardless of their own setting, as an
operator-level kill switch. `ENABLE_GATE_WS=true` turns on the optional per-user WebSocket
fill-notification layer described above - leave it off unless you've read `src/gateWs.js`'s
file header (it's built and tested but not yet verified against a real live connection).

### Inviting others / resetting a forgotten password

The `--admin` flag above matters: only admins can invite people or generate reset links,
either from the terminal or from the in-app **Admin** panel (visible only to admins, next
to Backtest/Settings/Logout) - useful once the app is hosted somewhere without terminal
access. Either way it's the same underlying single-use link, just generated from a
different place:

- Terminal: `node scripts/create-invite.js someone@example.com` (add `--admin` to make
  them an admin too), or `node scripts/create-reset-link.js someone@example.com` for an
  existing user who forgot their password (invalidates their existing sessions once used).
- In-app: log in as an admin, open **Admin**, use the "Invite new user" form or click
  "Send reset link" next to an existing user in the table. The generated link is shown
  in a copyable box - you still send it to them yourself (email, WhatsApp, etc.), there's
  no automatic email sending.
- `node scripts/make-admin.js someone@example.com` promotes an existing user to admin.

If you're sharing the app via ngrok, set `APP_BASE_URL` in `.env` to your ngrok URL first
so the generated links are ones the recipient can actually open (not `localhost`).

**If you're coming from the old n8n workflow (`gatekeeper.json`): rotate your Gate.io API
keys before using this project.** That workflow had live keys hardcoded in plaintext in
several nodes; treat those as compromised.

## API

All routes below require being logged in (session cookie set by `POST /login`) except
`GET /login`, `POST /login`, `POST /logout`, and `GET`/`POST /set-password`. Every cascade
and backtest is scoped to the logged-in user - you only ever see and act on your own.

- `POST /login` - form body `email`/`password`; sets a session cookie and redirects to `/`.
- `POST /logout` - clears the session.
- `GET /set-password?token=...` / `POST /set-password` - the invite/reset-link landing
  page; validates the single-use token, lets the user set a password, auto-logs them in.
- `GET /settings` / `POST /settings` - read/update your Gate.io API key+secret (write-only
  after saving - never re-displayed, only "configured, ending in XXXX") and your personal
  dry-run toggle.
- `POST /settings/test` - verify an API key actually works via one real, read-only wallet
  balance call (uses the key in the request body if provided, otherwise your saved one).
- `GET /admin/users` / `POST /admin/invite` / `POST /admin/reset-link` - admin-only
  (403 for everyone else); list users, invite a new one, or generate a reset link for an
  existing one. Same underlying logic as the CLI scripts.
- `POST /cascades` - create a % based cascade. Body:
  ```json
  {
    "symbol": "DOGE_USDT",
    "trigger_price": 0.07225,
    "base_price": 0.07220,
    "base_amount_usdt": 10,
    "price_step_pct": 0.5,
    "amount_step_pct": 20,
    "num_levels": 5,
    "take_profit_base_pct": 5,
    "take_profit_step_pct": 1
  }
  ```
- `POST /cascades/template` - create a manual-template cascade. Body:
  ```json
  {
    "symbol": "DOGE_USDT",
    "trigger_price": 0.07225,
    "levels": [
      { "target_price": 0.07220, "amount_usdt": 10, "sell_price": 0.07580 }
    ]
  }
  ```
- `GET /cascades` - list your cascades.
- `GET /cascades/:id` - one cascade with all its levels (prices, amounts, status, order ids, fills).
- `POST /cascades/:id/cancel` - cancel a cascade and any resting orders/armed triggers.
- `POST /cascades/:id/hold` / `POST /cascades/:id/resume` - pause/resume without cancelling;
  for live users this actually cancels whatever's live on hold and re-arms it on resume,
  rather than waiting for the next poll tick.
- `DELETE /cascades/:id` - cancel any resting orders/armed triggers, then delete permanently.
- `POST /cascades/:id/levels/:levelId/cancel` - cancel just one level's resting order or
  armed trigger (body `{"side": "buy"|"sell"}`); the buy side reverts to pending for
  re-evaluation, the sell side gets a fresh take-profit sell placed automatically on the
  next tick.
- `PATCH /cascades/:id/levels/:levelId` - edit one level's price/amount (pending levels:
  direct edit; resting buy: cancels and replaces at the new price/amount; resting sell:
  body `{"sell_target_price": ...}` cancels and replaces at the new price).
- `POST /backtests` - run and save a backtest (body shape mirrors `/cascades` or
  `/cascades/template` above, plus `interval`, `from_time`/`to_time` as unix seconds,
  `fee_pct`, and `is_manual`). Returns the full result including per-level fills/skips.
- `GET /backtests` - list your saved backtests (summary fields only).
- `GET /backtests/:id` - one backtest's full detail (config + per-level results + summary).
- `DELETE /backtests/:id` - delete a saved backtest.

## Data

SQLite file at `DB_PATH` (default `./data/cascade.db`). Inspect it directly with:

```
sqlite3 data/cascade.db "select level_index, target_price, amount_usdt, take_profit_pct, status, sell_status from cascade_levels;"
```

Backtests are stored in their own `backtests` table - `config`/`results` as JSON (a
backtest is an immutable, write-once report, not a live stateful entity), plus a handful
of summary columns (`roi_pct`, `fills_count`, etc.) hoisted out for a fast list view.

## Multi-tenant auth

Accounts (`src/auth.js`, invite-only via `scripts/create-invite.js` and
`scripts/create-reset-link.js` - single-use links, no operator-known passwords, no email
integration), sessions (opaque token in an httpOnly cookie, checked against a `sessions`
table), every cascade and backtest scoped by `user_id`, and each user's Gate.io API
key/secret encrypted at rest (`src/secretsCrypto.js`, AES-256-GCM, keyed by
`ENCRYPTION_KEY`) rather than one shared key in `.env`. Still single-process/SQLite by
design - this is built for "you + a handful of invited users," not public-signup scale.
If that changes later:
- Swap `better-sqlite3` for a Postgres driver - the schema and queries in `src/db.js` /
  `src/cascadeEngine.js` / `src/backtestEngine.js` are plain SQL and port over with
  minimal changes.
- Add a public signup flow (currently deliberately absent - CLI-only account creation).
- The `Dockerfile` already containerizes the app; put it behind a real process
  manager/orchestrator when running at real scale.

## Tests

```
npm test
```

Runs `test/cascadeMath.test.js` (level/take-profit computation, skip-ahead level
selection, manual-template normalization, and the full backtest simulation engine -
crash/skip-ahead, same-candle-deferral, fee math, trigger-never-reached, still-open-at-
window-end) and `test/gateClient.test.js` (candlestick field-order parsing, verified
against a real captured Gate.io response, plus the interval whitelist).

See `CLAUDE.md` for architecture-level context, design-decision rationale, and testing
conventions - useful background before making non-trivial changes.
