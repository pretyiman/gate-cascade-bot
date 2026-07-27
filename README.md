# gate-cascade-bot

A Gate.io spot cascade DCA bot. Instead of placing every buy level at once (which
freezes USDT for all of them immediately), this places **one buy level at a time** -
the next level is only submitted once the previous one fills. Each filled level gets
its own independent take-profit sell, with the profit % laddering up per level.

## Strategy

You configure one "cascade" per pair:

- `base_price` / `base_amount_usdt` - level 1's limit buy price and USDT size.
- `price_step_pct` - each subsequent level is this % below the previous level's price.
- `amount_step_pct` - each subsequent level's USDT size is this % larger than the previous.
- `num_levels` - how many levels total (not fixed).
- `take_profit_base_pct` / `take_profit_step_pct` - level 1 sells at `+take_profit_base_pct%`
  profit; each deeper level's take-profit % increases by `take_profit_step_pct` (e.g. base=5,
  step=1 -> level 1 sells at +5%, level 2 at +6%, level 3 at +7%, ...).
- `trigger_price` (optional) - the cascade stays armed-but-inactive until market price
  reaches this, then level 1 goes live.

**Skip-ahead safeguard:** before placing the next level, the engine checks the current
market price. If that level's target price is already at/above the market (meaning
placing it would fill instantly rather than rest and wait for the dip), it's skipped and
the next deeper level is tried instead - unless it's the last level, in which case it's
placed anyway so that tranche of capital doesn't sit undeployed forever.

## Setup

The app is now multi-tenant: each user logs in and provides their own Gate.io API
key/secret via the Settings screen (encrypted at rest) instead of one shared key in
`.env`. Accounts are invite-only - there's no public signup form and the operator never
sets or sees anyone's real password; instead you generate a single-use link and send it
to them however you want (no email integration involved).

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
API key/secret (Spot trading permission required), and leave **Dry Run** on while testing -
`placeOrder`/`cancelOrder` just log what they would send and fabricate fake order ids, so
nothing ever hits Gate.io. Turn Dry Run off per-account only once you've verified a
config's behavior and are ready to trade with real funds - start with a very small
`base_amount_usdt`. `FORCE_DRY_RUN=true` in `.env` overrides every account back to dry-run
regardless of their own setting, as an operator-level kill switch.

### Inviting others / resetting a forgotten password

The `--admin` flag above matters: only admins can invite people or generate reset links,
either from the terminal or from the in-app **Admin** panel (visible only to admins, next
to Settings/Logout) - useful once the app is hosted somewhere without terminal access.
Either way it's the same underlying single-use link, just generated from a different
place:

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
is scoped to the logged-in user - you only ever see and act on your own.

- `POST /login` - form body `email`/`password`; sets a session cookie and redirects to `/`.
- `POST /logout` - clears the session.
- `GET /set-password?token=...` / `POST /set-password` - the invite/reset-link landing
  page; validates the single-use token, lets the user set a password, auto-logs them in.
- `GET /settings` / `POST /settings` - read/update your Gate.io API key+secret (write-only
  after saving - never re-displayed, only "configured, ending in XXXX") and your personal
  dry-run toggle.
- `GET /admin/users` / `POST /admin/invite` / `POST /admin/reset-link` - admin-only
  (403 for everyone else); list users, invite a new one, or generate a reset link for an
  existing one. Same underlying logic as the CLI scripts.
- `POST /cascades` - create a cascade. Body:
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
- `GET /cascades` - list your cascades.
- `GET /cascades/:id` - one cascade with all its levels (prices, amounts, status, order ids, fills).
- `POST /cascades/:id/cancel` - cancel a cascade and any resting orders.
- `POST /cascades/:id/hold` / `POST /cascades/:id/resume` - pause/resume without cancelling.
- `DELETE /cascades/:id` - cancel any resting orders, then delete permanently.
- `POST /cascades/:id/levels/:levelId/cancel` - cancel just one level's resting order
  (body `{"side": "buy"|"sell"}`); the buy side reverts to pending for re-evaluation, the
  sell side gets a fresh take-profit sell placed automatically on the next tick.
- `PATCH /cascades/:id/levels/:levelId` - edit one level's price/amount (pending levels:
  direct edit; resting buy: cancels and replaces at the new price/amount; resting sell:
  body `{"sell_target_price": ...}` cancels and replaces at the new price).

The scheduler (`src/scheduler.js`) polls every active cascade every
`DEFAULT_POLL_INTERVAL_SECONDS` (default 60s) to arm triggers, place/skip levels, and
check for fills.

## Data

SQLite file at `DB_PATH` (default `./data/cascade.db`). Inspect it directly with:

```
sqlite3 data/cascade.db "select level_index, target_price, amount_usdt, take_profit_pct, status, sell_status from cascade_levels;"
```

## Multi-tenant auth

Done: accounts (`src/auth.js`, invite-only via `scripts/create-invite.js` and
`scripts/create-reset-link.js` - single-use links, no operator-known passwords, no email
integration), sessions (opaque token in an httpOnly cookie, checked against a `sessions`
table), every cascade
scoped by `user_id`, and each user's Gate.io API key/secret encrypted at rest
(`src/secretsCrypto.js`, AES-256-GCM, keyed by `ENCRYPTION_KEY`) rather than one shared
key in `.env`. Still single-process/SQLite by design - this is built for "you + a
handful of invited users," not public-signup scale. If that changes later:
- Swap `better-sqlite3` for a Postgres driver - the schema and queries in `src/db.js` /
  `src/cascadeEngine.js` are plain SQL and port over with minimal changes.
- Add a public signup flow (currently deliberately absent - CLI-only account creation).
- The `Dockerfile` already containerizes the app; put it behind a real process
  manager/orchestrator when running at real scale.

## Tests

```
npm test
```

Runs `test/cascadeMath.test.js`, covering level/take-profit computation and the
skip-ahead level-selection logic (including the "market already crashed past two
levels" and "even the last level would instant-fill" cases).
