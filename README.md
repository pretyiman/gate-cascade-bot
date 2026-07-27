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

```
npm install
cp .env.example .env   # then fill in GATE_API_KEY / GATE_API_SECRET
npm run dev
```

Leave `DRY_RUN=true` (the default) while testing - `placeOrder`/`cancelOrder` just log
what they would send and fabricate fake order ids, so nothing ever hits Gate.io. Flip to
`DRY_RUN=false` only once you've verified a config's behavior and are ready to trade with
real funds - start with a very small `base_amount_usdt`.

**If you're coming from the old n8n workflow (`gatekeeper.json`): rotate your Gate.io API
keys before using this project.** That workflow had live keys hardcoded in plaintext in
several nodes; treat those as compromised.

## API

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
    "take_profit_step_pct": 1,
    "poll_interval_seconds": 60
  }
  ```
- `GET /cascades` - list all cascades.
- `GET /cascades/:id` - one cascade with all its levels (prices, amounts, status, order ids, fills).
- `POST /cascades/:id/cancel` - cancel a cascade and any resting orders.

The scheduler (`src/scheduler.js`) polls every active cascade every
`DEFAULT_POLL_INTERVAL_SECONDS` (default 60s) to arm triggers, place/skip levels, and
check for fills.

## Data

SQLite file at `DB_PATH` (default `./data/cascade.db`). Inspect it directly with:

```
sqlite3 data/cascade.db "select level_index, target_price, amount_usdt, take_profit_pct, status, sell_status from cascade_levels;"
```

## Scaling toward a hosted/multi-tenant version later

This is intentionally a single-tenant, single-process local tool for now. To grow it
into a hosted SaaS later:
- Swap `better-sqlite3` for a Postgres driver - the schema and queries in `src/db.js` /
  `src/cascadeEngine.js` are plain SQL and port over with minimal changes.
- Add a `user_id` column to `cascades` and scope all queries/API routes by it.
- Store each user's Gate.io API key/secret encrypted per-tenant instead of one shared `.env`.
- Add authentication to the Express API in `src/api.js`.
- The `Dockerfile` already containerizes the app; put it behind a real process
  manager/orchestrator when running multiple tenants.

## Tests

```
npm test
```

Runs `test/cascadeMath.test.js`, covering level/take-profit computation and the
skip-ahead level-selection logic (including the "market already crashed past two
levels" and "even the last level would instant-fill" cases).
