const { randomUUID } = require('crypto');
const db = require('./db');
const gateClient = require('./gateClient');
const { computeLevels, normalizeManualLevels, simulateCascadeBacktest } = require('./cascadeMath');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Runs a backtest, persists it, and returns the saved row (config/results
 * JSON-parsed). `symbol` must already be normalized by the caller (api.js
 * does this for every other route via src/symbol.js - kept consistent here
 * rather than normalizing twice).
 */
async function runBacktest(userId, config) {
  const {
    symbol,
    interval,
    from_time,
    to_time,
    fee_pct = 0.2,
    trigger_price = null,
    is_manual = false,
    base_price,
    base_amount_usdt,
    price_step_pct,
    amount_step_pct,
    num_levels,
    take_profit_base_pct,
    take_profit_step_pct,
    levels: rawLevels,
  } = config;

  if (!symbol) throw new Error('Pair is required');
  if (!gateClient.INTERVAL_SECONDS[interval]) {
    throw new Error(`Unsupported interval "${interval}" - must be one of ${Object.keys(gateClient.INTERVAL_SECONDS).join(', ')}`);
  }
  if (!Number.isFinite(from_time) || !Number.isFinite(to_time) || from_time >= to_time) {
    throw new Error('from_time must be a valid timestamp before to_time');
  }
  if (!(fee_pct >= 0 && fee_pct <= 2)) {
    throw new Error('fee_pct must be between 0 and 2');
  }

  const intervalSeconds = gateClient.INTERVAL_SECONDS[interval];
  const candleCount = Math.ceil((to_time - from_time) / intervalSeconds);
  if (candleCount > gateClient.MAX_CANDLES_PER_BACKTEST) {
    throw new Error(
      `Requested range is too large (~${candleCount} candles) - shorten the range or pick a coarser interval (max ${gateClient.MAX_CANDLES_PER_BACKTEST})`
    );
  }

  const levels = is_manual
    ? normalizeManualLevels(rawLevels)
    : computeLevels({
        base_price,
        base_amount_usdt,
        price_step_pct,
        amount_step_pct,
        num_levels,
        take_profit_base_pct,
        take_profit_step_pct,
      });

  const candles = await gateClient.getCandlesticks({ symbol, interval, from: from_time, to: to_time });
  if (candles.length === 0) {
    throw new Error(`No market data for ${symbol} in that range - check the pair and dates are correct`);
  }

  const simResult = simulateCascadeBacktest({ levels, candles, feePct: fee_pct, triggerPrice: trigger_price });

  const id = randomUUID();
  const configToStore = is_manual
    ? { trigger_price, levels: rawLevels }
    : {
        trigger_price,
        base_price,
        base_amount_usdt,
        price_step_pct,
        amount_step_pct,
        num_levels,
        take_profit_base_pct,
        take_profit_step_pct,
      };

  db.prepare(
    `INSERT INTO backtests (
      id, user_id, symbol, interval, from_time, to_time, fee_pct, is_manual,
      config, results, roi_pct, realized_pnl_usdt, total_invested_usdt,
      fills_count, skips_count, armed, outcome, created_at
    ) VALUES (@id, @user_id, @symbol, @interval, @from_time, @to_time, @fee_pct, @is_manual,
      @config, @results, @roi_pct, @realized_pnl_usdt, @total_invested_usdt,
      @fills_count, @skips_count, @armed, @outcome, @created_at)`
  ).run({
    id,
    user_id: userId,
    symbol,
    interval,
    from_time,
    to_time,
    fee_pct,
    is_manual: is_manual ? 1 : 0,
    config: JSON.stringify(configToStore),
    results: JSON.stringify(simResult),
    roi_pct: simResult.summary.roiPct,
    realized_pnl_usdt: simResult.summary.realizedPnlUsdt,
    total_invested_usdt: simResult.summary.totalInvestedUsdt,
    fills_count: simResult.summary.fillsCount,
    skips_count: simResult.summary.skipsCount,
    armed: simResult.armed ? 1 : 0,
    outcome: simResult.summary.outcome,
    created_at: nowIso(),
  });

  return getBacktest(userId, id);
}

/** Flat list, hoisted summary columns only - no JSON parsing needed to render it. */
function listBacktests(userId) {
  return db
    .prepare(
      `SELECT id, symbol, interval, from_time, to_time, fee_pct, is_manual,
              roi_pct, realized_pnl_usdt, total_invested_usdt, fills_count,
              skips_count, armed, outcome, created_at
       FROM backtests WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(userId);
}

function getBacktest(userId, id) {
  const row = db.prepare('SELECT * FROM backtests WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  return {
    ...row,
    config: JSON.parse(row.config),
    results: JSON.parse(row.results),
  };
}

function deleteBacktest(userId, id) {
  const result = db.prepare('DELETE FROM backtests WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

module.exports = { runBacktest, listBacktests, getBacktest, deleteBacktest };
