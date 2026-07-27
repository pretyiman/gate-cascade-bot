const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cascade.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                          TEXT PRIMARY KEY,
    email                       TEXT NOT NULL UNIQUE,
    password_hash               TEXT NOT NULL,
    gate_api_key_encrypted      TEXT,
    gate_api_secret_encrypted   TEXT,
    gate_api_key_last4          TEXT,
    dry_run                     INTEGER NOT NULL DEFAULT 1,
    created_at                  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    expires_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS password_set_tokens (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    expires_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_password_set_tokens_user_id ON password_set_tokens(user_id);

  CREATE TABLE IF NOT EXISTS cascades (
    id                      TEXT PRIMARY KEY,
    user_id                 TEXT NOT NULL REFERENCES users(id),
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
    pre_hold_status         TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_cascades_user_id ON cascades(user_id);
`);

try {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column name/.test(err.message)) throw err;
}

try {
  db.exec('ALTER TABLE cascades ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column name/.test(err.message)) throw err;
}

try {
  db.exec('ALTER TABLE cascade_levels ADD COLUMN trigger_order_id TEXT');
} catch (err) {
  if (!/duplicate column name/.test(err.message)) throw err;
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_cascade_levels_buy_order_id ON cascade_levels(buy_order_id);
  CREATE INDEX IF NOT EXISTS idx_cascade_levels_sell_order_id ON cascade_levels(sell_order_id);
  CREATE INDEX IF NOT EXISTS idx_cascade_levels_trigger_order_id ON cascade_levels(trigger_order_id);
`);

module.exports = db;
