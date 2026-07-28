// Dev verification tool for the backtest engine, before any HTTP route
// exists for it. %-based config only (manual-template backtests are
// exercised via the API/UI once those land). Run locally:
//   node scripts/run-backtest.js <email> <symbol> <interval> <fromISO> <toISO> <base_price> <base_amount_usdt> <price_step_pct> <amount_step_pct> <num_levels> <take_profit_base_pct> <take_profit_step_pct> [trigger_price] [fee_pct]
require('dotenv').config();
const db = require('../src/db');
const { normalizeSymbol } = require('../src/symbol');
const { runBacktest } = require('../src/backtestEngine');

const [
  ,
  ,
  email,
  symbolRaw,
  interval,
  fromIso,
  toIso,
  base_price,
  base_amount_usdt,
  price_step_pct,
  amount_step_pct,
  num_levels,
  take_profit_base_pct,
  take_profit_step_pct,
  trigger_price,
  fee_pct,
] = process.argv;

if (!take_profit_step_pct) {
  console.error(
    'Usage: node scripts/run-backtest.js <email> <symbol> <interval> <fromISO> <toISO> <base_price> <base_amount_usdt> <price_step_pct> <amount_step_pct> <num_levels> <take_profit_base_pct> <take_profit_step_pct> [trigger_price] [fee_pct]'
  );
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No user found with email ${email}`);
  process.exit(1);
}

runBacktest(user.id, {
  symbol: normalizeSymbol(symbolRaw),
  interval,
  from_time: Math.floor(new Date(fromIso).getTime() / 1000),
  to_time: Math.floor(new Date(toIso).getTime() / 1000),
  is_manual: false,
  base_price: Number(base_price),
  base_amount_usdt: Number(base_amount_usdt),
  price_step_pct: Number(price_step_pct),
  amount_step_pct: Number(amount_step_pct),
  num_levels: Number(num_levels),
  take_profit_base_pct: Number(take_profit_base_pct),
  take_profit_step_pct: Number(take_profit_step_pct),
  trigger_price: trigger_price ? Number(trigger_price) : null,
  fee_pct: fee_pct ? Number(fee_pct) : 0.2,
})
  .then((result) => {
    console.log(`\nSaved backtest ${result.id}`);
    console.log('Summary:', result.results.summary);
    console.log('\nPer-level results:');
    for (const level of result.results.levels) {
      console.log(
        `  L${level.level_index}: buy@${level.target_price} status=${level.status}` +
          (level.fill_time ? ` filled@${new Date(level.fill_time * 1000).toISOString()}` : '') +
          ` | sell_status=${level.sell_status}` +
          (level.sell_time ? ` sold@${new Date(level.sell_time * 1000).toISOString()} price=${level.sell_price}` : '') +
          (level.pnl_usdt != null ? ` pnl=${level.pnl_usdt.toFixed(4)}` : '')
      );
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('Backtest failed:', err.message);
    process.exit(1);
  });
