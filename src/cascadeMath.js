// Pure math for the cascade: level pricing/sizing and skip-ahead selection.
// No I/O here on purpose - keeps this trivially unit-testable.

/**
 * Compute all levels for a cascade config.
 * Price compounds downward from base_price by price_step_pct each level.
 * Amount compounds upward from base_amount_usdt by amount_step_pct each level.
 * Take-profit % ladders up additively: base + (i-1)*step.
 *
 * @param {object} config
 * @param {number} config.base_price
 * @param {number} config.base_amount_usdt
 * @param {number} config.price_step_pct   e.g. 0.5 -> each level is 0.5% below the previous
 * @param {number} config.amount_step_pct  e.g. 20  -> each level's USDT size is 20% more than the previous
 * @param {number} config.num_levels
 * @param {number} config.take_profit_base_pct  e.g. 5 -> level 1 sells at +5%
 * @param {number} config.take_profit_step_pct  e.g. 1 -> level 2 sells at +6%, level 3 at +7%, ...
 * @returns {Array<{level_index:number, target_price:number, amount_usdt:number, take_profit_pct:number}>}
 */
function computeLevels(config) {
  const {
    base_price,
    base_amount_usdt,
    price_step_pct,
    amount_step_pct,
    num_levels,
    take_profit_base_pct,
    take_profit_step_pct,
  } = config;

  if (!(base_price > 0)) throw new Error('base_price must be > 0');
  if (!(base_amount_usdt > 0)) throw new Error('base_amount_usdt must be > 0');
  if (!(Number.isInteger(num_levels) && num_levels >= 1)) {
    throw new Error('num_levels must be a positive integer');
  }
  if (price_step_pct < 0 || price_step_pct >= 100) {
    throw new Error('price_step_pct must be in [0, 100)');
  }

  const levels = [];
  for (let i = 1; i <= num_levels; i++) {
    const target_price = base_price * Math.pow(1 - price_step_pct / 100, i - 1);
    const amount_usdt = base_amount_usdt * Math.pow(1 + amount_step_pct / 100, i - 1);
    const take_profit_pct = take_profit_base_pct + (i - 1) * take_profit_step_pct;
    levels.push({ level_index: i, target_price, amount_usdt, take_profit_pct });
  }
  return levels;
}

/**
 * Given the take-profit % for a specific level and the actual fill price of its buy,
 * compute the price at which the matching sell should be placed.
 */
function computeSellTarget(filledPrice, takeProfitPct) {
  if (!(filledPrice > 0)) throw new Error('filledPrice must be > 0');
  return filledPrice * (1 + takeProfitPct / 100);
}

/**
 * Decide which pending level (if any) should be placed next, given the current market price.
 *
 * A buy limit order only "rests" (waits for the dip) if its target_price is below the
 * current market price. If target_price >= marketPrice, placing it would fill instantly -
 * skip it and try the next deeper level. If every remaining level would instant-fill,
 * place the deepest one anyway rather than leaving that tranche permanently undeployed.
 *
 * @param {Array<{level_index:number, target_price:number, status:string}>} pendingLevelsAsc
 *   Levels with status === 'pending', sorted ascending by level_index.
 * @param {number} marketPrice
 * @returns {{ toPlace: object|null, toSkip: object[] }}
 *   toPlace: the level that should be placed now (or null if no pending levels remain).
 *   toSkip: levels that should be marked 'skipped' because the market already passed them.
 */
function selectNextLevel(pendingLevelsAsc, marketPrice) {
  if (pendingLevelsAsc.length === 0) {
    return { toPlace: null, toSkip: [] };
  }

  const toSkip = [];
  for (let idx = 0; idx < pendingLevelsAsc.length; idx++) {
    const level = pendingLevelsAsc[idx];
    const isLast = idx === pendingLevelsAsc.length - 1;
    const wouldInstantFill = level.target_price >= marketPrice;

    if (wouldInstantFill && !isLast) {
      toSkip.push(level);
      continue;
    }
    // Either it would rest properly, or it's the last remaining level
    // (place it anyway so the tranche isn't left undeployed).
    return { toPlace: level, toSkip };
  }

  // Unreachable, but keeps the function total.
  return { toPlace: null, toSkip };
}

/**
 * Manual template conversion: each level's exact buy price, USDT amount, and
 * sell price -> the same {level_index, target_price, amount_usdt,
 * take_profit_pct} shape computeLevels produces, so every consumer (the live
 * engine, the backtester) works off one uniform level shape regardless of how
 * the cascade was configured. Pure - no market-price sanity check here, that
 * stays in cascadeEngine.js since it requires a live ticker call.
 */
function normalizeManualLevels(rawLevels) {
  if (!Array.isArray(rawLevels) || rawLevels.length === 0) {
    throw new Error('At least one level is required');
  }

  return rawLevels.map((l, idx) => {
    const target_price = Number(l.target_price);
    const amount_usdt = Number(l.amount_usdt);
    const sell_price = Number(l.sell_price);
    if (!(target_price > 0) || !(amount_usdt > 0) || !(sell_price > 0)) {
      throw new Error(`Level ${idx + 1}: buy price, amount, and sell price must all be positive numbers`);
    }
    if (sell_price <= target_price) {
      throw new Error(`Level ${idx + 1}: sell price (${sell_price}) must be higher than the buy price (${target_price})`);
    }
    const take_profit_pct = (sell_price / target_price - 1) * 100;
    return { level_index: idx + 1, target_price, amount_usdt, take_profit_pct };
  });
}

/**
 * Replays a cascade config against historical candles (ascending by time,
 * each {time, open, high, low, close, volume}) using the exact same
 * selectNextLevel skip-ahead logic the live dry-run/poll path uses - so a
 * backtest result reflects the same decision-making the real engine makes,
 * not a separate approximation of it.
 *
 * Decision-price rule: every selectNextLevel call uses the exact price at the
 * crossing event that triggered this decision, never an OHLC aggregate like
 * close (which would leak look-ahead information a live poll wouldn't have
 * had at that instant):
 *   - no triggerPrice: first candle's `open` is the initial market price.
 *   - triggerPrice set: arms on the first candle where low <= triggerPrice,
 *     using triggerPrice itself as the decision price.
 *   - after a level's BUY fills (not its sell - verified against the live
 *     placeNextLevel/tickCascade code: `currentlyResting` only checks
 *     buy-side status, and the next level's fresh price check happens in the
 *     same tick right after fill-detection with zero dependency on whether
 *     that level's sell has filled): the fill candle's `low` is the decision
 *     price for evaluating the next level (not just target_price - low is
 *     the deepest CONFIRMED price for that timeframe, so a single fast-crash
 *     candle can still correctly trigger skip-ahead of multiple levels, the
 *     same way a live reactive re-check could legitimately see price had
 *     already moved further by the time it ran). A level's take-profit sell
 *     runs on its own independent track and never gates the next level's
 *     evaluation.
 *
 * Fill rules: a resting buy fills on the first candle (from selection onward)
 * where low <= target_price, always recorded at target_price (even in the
 * forced/instant-fill case - a documented conservative simplification, real
 * fills there would be marginally better). Its take-profit sell fills on the
 * first candle *after* the buy-fill candle where high >= sell_target_price -
 * same-candle buy+sell is deliberately disallowed, since OHLC data can't tell
 * you the intra-candle order of touches, and the live engine always has a
 * real gap between fill-detection and sell-placement anyway. The next
 * level's own buy-fill search also starts the candle after this one filled,
 * for the same reason.
 *
 * Fees are applied per Gate.io's actual convention - deducted from what's
 * *received*, not what's spent: buy qty = (amount_usdt/target_price) *
 * (1-feePct/100); sell proceeds = qty * sell_price * (1-feePct/100). This is
 * a flat rate that doesn't distinguish maker/taker fills - a documented
 * limitation, not an oversight.
 *
 * @param {object} params
 * @param {Array<{level_index:number, target_price:number, amount_usdt:number, take_profit_pct:number}>} params.levels
 * @param {Array<{time:number, open:number, high:number, low:number, close:number}>} params.candles
 * @param {number} [params.feePct=0.2]
 * @param {number|null} [params.triggerPrice=null]
 * @returns {object} { armed, armedAt, levels: [...], summary: {...} }
 */
function simulateCascadeBacktest({ levels, candles, feePct = 0.2, triggerPrice = null }) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      armed: false,
      armedAt: null,
      levels: levels.map((l) => ({ ...l, status: 'pending', sell_status: 'none' })),
      summary: {
        outcome: 'no_data',
        armed: false,
        totalInvestedUsdt: 0,
        realizedPnlUsdt: 0,
        unrealizedPnlUsdt: 0,
        roiPct: 0,
        fillsCount: 0,
        skipsCount: 0,
      },
    };
  }

  const results = levels.map((l) => ({
    ...l,
    status: 'pending',
    sell_status: 'none',
    fill_price: null,
    fill_time: null,
    sell_price: null,
    sell_time: null,
    pnl_usdt: null,
    skip_reason: null,
  }));

  let armed = false;
  let armedAt = null;
  let armIndex = 0; // candle index the cascade becomes active from

  if (triggerPrice == null) {
    armed = true;
    armedAt = { time: candles[0].time, price: candles[0].open };
    armIndex = 0;
  } else {
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].low <= triggerPrice) {
        armed = true;
        armedAt = { time: candles[i].time, price: triggerPrice };
        armIndex = i;
        break;
      }
    }
  }

  if (!armed) {
    return {
      armed: false,
      armedAt: null,
      levels: results,
      summary: {
        outcome: 'never_armed',
        armed: false,
        totalInvestedUsdt: 0,
        realizedPnlUsdt: 0,
        unrealizedPnlUsdt: 0,
        roiPct: 0,
        fillsCount: 0,
        skipsCount: 0,
      },
    };
  }

  let decisionPrice = armedAt.price;
  let searchFrom = armIndex;
  let totalInvestedUsdt = 0;
  let realizedPnlUsdt = 0;
  let unrealizedPnlUsdt = 0;
  let fillsCount = 0;
  let skipsCount = 0;

  while (true) {
    const pending = results.filter((l) => l.status === 'pending');
    if (pending.length === 0) break;

    const { toPlace, toSkip } = selectNextLevel(pending, decisionPrice);
    for (const skipped of toSkip) {
      const level = results.find((l) => l.level_index === skipped.level_index);
      level.status = 'skipped';
      level.skip_reason = 'market_price_already_below_target';
      skipsCount += 1;
    }
    if (!toPlace) break;

    const level = results.find((l) => l.level_index === toPlace.level_index);

    // Find the buy-fill candle: first candle (from searchFrom onward) whose low reaches target_price.
    let buyFillIdx = -1;
    for (let i = searchFrom; i < candles.length; i++) {
      if (candles[i].low <= level.target_price) {
        buyFillIdx = i;
        break;
      }
    }

    if (buyFillIdx === -1) {
      // Never fills within the available data - stays pending.
      break;
    }

    level.status = 'filled';
    level.fill_price = level.target_price;
    level.fill_time = candles[buyFillIdx].time;
    fillsCount += 1;
    totalInvestedUsdt += level.amount_usdt;

    // The take-profit sell runs on its own independent track - it does NOT
    // gate whether the next level gets evaluated (mirrors the live engine:
    // placeNextLevel's `currentlyResting` check only looks at buy-side
    // status, and it fetches a fresh price immediately in the same tick
    // right after fill-detection, with no dependency on the sell at all).
    const sellTargetPrice = computeSellTarget(level.fill_price, level.take_profit_pct);
    const qty = (level.amount_usdt / level.fill_price) * (1 - feePct / 100);

    // Sell can only fill starting the candle AFTER the buy-fill candle (no same-candle round trips).
    let sellFillIdx = -1;
    for (let i = buyFillIdx + 1; i < candles.length; i++) {
      if (candles[i].high >= sellTargetPrice) {
        sellFillIdx = i;
        break;
      }
    }

    if (sellFillIdx === -1) {
      // Still open at the end of the data window - mark-to-market at the last candle's close.
      level.sell_status = 'none';
      const lastClose = candles[candles.length - 1].close;
      const proceedsAtClose = qty * lastClose * (1 - feePct / 100);
      unrealizedPnlUsdt += proceedsAtClose - level.amount_usdt;
    } else {
      level.sell_status = 'filled';
      level.sell_price = sellTargetPrice;
      level.sell_time = candles[sellFillIdx].time;
      const proceeds = qty * sellTargetPrice * (1 - feePct / 100);
      level.pnl_usdt = proceeds - level.amount_usdt;
      realizedPnlUsdt += level.pnl_usdt;
    }

    // Next level's evaluation is gated on THIS level's BUY fill, not its
    // sell. Decision price = this fill candle's `low`, not just target_price:
    // target_price only proves price reached AT LEAST that depth, while the
    // candle's low is the deepest CONFIRMED price for that same timeframe -
    // the most information-rich value available without look-ahead. This
    // matters for skip-ahead: since each level's target is always below the
    // previous one's by construction, using target_price alone as the next
    // decision price would mean skip-ahead could only ever trigger at arm
    // time, never from a fast-crash candle reaching multiple levels' targets
    // in one bar. Same-candle re-evaluation is still disallowed for
    // consistency with the same-candle-buy-sell rule - the next level's own
    // buy-fill search starts the candle after this one filled, even though
    // its target may already be confirmed crossed by this candle's low.
    decisionPrice = candles[buyFillIdx].low;
    searchFrom = buyFillIdx + 1;
  }

  const roiPct = totalInvestedUsdt > 0 ? (realizedPnlUsdt / totalInvestedUsdt) * 100 : 0;

  return {
    armed: true,
    armedAt,
    levels: results,
    summary: {
      outcome: 'completed',
      armed: true,
      totalInvestedUsdt,
      realizedPnlUsdt,
      unrealizedPnlUsdt,
      roiPct,
      fillsCount,
      skipsCount,
    },
  };
}

module.exports = {
  computeLevels,
  computeSellTarget,
  selectNextLevel,
  normalizeManualLevels,
  simulateCascadeBacktest,
};
