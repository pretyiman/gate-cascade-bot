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

module.exports = { computeLevels, computeSellTarget, selectNextLevel };
