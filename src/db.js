const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cascade.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS cascades (
    id                      TEXT PRIMARY KEY,
    symbol                  TEXT NOT NULL,
    trigger_price           REAL,
    base_price              REAL NOT NULL,
    base_amount_usdt        REAL NOT NULL,
    price_step_pct          REAL NOT NULL,
    amount_step_pct         REAL NOT NULL,
    num_levels              INTEGER NOT NULL,
    take_profit_base_pct    REAL NOT NULL,
    take_profit_step_pct    REAL NOT NULL,
    poll_interval_seconds   INTEGER NOT NULL DEFAULT 60,
    status                  TEXT NOT NULL DEFAULT 'pending_trigger',
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cascade_levels (
    id                  TEXT PRIMARY KEY,
    cascade_id          TEXT NOT NULL REFERENCES cascades(id),
    level_index         INTEGER NOT NULL,
    target_price        REAL NOT NULL,
    amount_usdt         REAL NOT NULL,
    take_profit_pct     REAL NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    skip_reason         TEXT,
    market_price_at_skip REAL,
    buy_order_id        TEXT,
    filled_price        REAL,
    filled_amount       REAL,
    placed_at           TEXT,
    filled_at           TEXT,
    sell_order_id       TEXT,
    sell_status         TEXT NOT NULL DEFAULT 'none',
    sell_target_price   REAL,
    sell_placed_at      TEXT,
    sell_filled_at      TEXT,
    UNIQUE(cascade_id, level_index)
  );

  CREATE INDEX IF NOT EXISTS idx_cascade_levels_cascade_id ON cascade_levels(cascade_id);
  CREATE INDEX IF NOT EXISTS idx_cascades_status ON cascades(status);
`);

try {
  db.exec('ALTER TABLE cascades ADD COLUMN pre_hold_status TEXT');
} catch (err) {
  if (!/duplicate column name/.test(err.message)) throw err;
}

module.exports = db;
