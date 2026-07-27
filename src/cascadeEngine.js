const { randomUUID } = require('crypto');
const db = require('./db');
const gateClient = require('./gateClient');
const { computeLevels, computeSellTarget, selectNextLevel } = require('./cascadeMath');

function nowIso() {
  return new Date().toISOString();
}

function createCascade(config) {
  const {
    symbol,
    trigger_price = null,
    base_price,
    base_amount_usdt,
    price_step_pct,
    amount_step_pct,
    num_levels,
    take_profit_base_pct,
    take_profit_step_pct,
    poll_interval_seconds = 60,
  } = config;

  const levels = computeLevels({
    base_price,
    base_amount_usdt,
    price_step_pct,
    amount_step_pct,
    num_levels,
    take_profit_base_pct,
    take_profit_step_pct,
  });

  const cascadeId = randomUUID();
  const ts = nowIso();
  const initialStatus = trigger_price != null ? 'pending_trigger' : 'active';

  const insertCascade = db.prepare(`
    INSERT INTO cascades (
      id, symbol, trigger_price, base_price, base_amount_usdt, price_step_pct,
      amount_step_pct, num_levels, take_profit_base_pct, take_profit_step_pct,
      poll_interval_seconds, status, created_at, updated_at
    ) VALUES (@id, @symbol, @trigger_price, @base_price, @base_amount_usdt, @price_step_pct,
      @amount_step_pct, @num_levels, @take_profit_base_pct, @take_profit_step_pct,
      @poll_interval_seconds, @status, @created_at, @updated_at)
  `);

  const insertLevel = db.prepare(`
    INSERT INTO cascade_levels (
      id, cascade_id, level_index, target_price, amount_usdt, take_profit_pct, status
    ) VALUES (@id, @cascade_id, @level_index, @target_price, @amount_usdt, @take_profit_pct, 'pending')
  `);

  const insertAll = db.transaction(() => {
    insertCascade.run({
      id: cascadeId,
      symbol,
      trigger_price,
      base_price,
      base_amount_usdt,
      price_step_pct,
      amount_step_pct,
      num_levels,
      take_profit_base_pct,
      take_profit_step_pct,
      poll_interval_seconds,
      status: initialStatus,
      created_at: ts,
      updated_at: ts,
    });
    for (const level of levels) {
      insertLevel.run({
        id: randomUUID(),
        cascade_id: cascadeId,
        level_index: level.level_index,
        target_price: level.target_price,
        amount_usdt: level.amount_usdt,
        take_profit_pct: level.take_profit_pct,
      });
    }
  });
  insertAll();

  return cascadeId;
}

function getCascade(cascadeId) {
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId);
  if (!cascade) return null;
  const levels = db
    .prepare('SELECT * FROM cascade_levels WHERE cascade_id = ? ORDER BY level_index ASC')
    .all(cascadeId);
  return { ...cascade, levels };
}

function listCascades() {
  return db.prepare('SELECT * FROM cascades ORDER BY created_at DESC').all();
}

function markSkipped(level, marketPrice) {
  db.prepare(`
    UPDATE cascade_levels
    SET status = 'skipped', skip_reason = ?, market_price_at_skip = ?
    WHERE id = ?
  `).run('market_price_already_below_target', marketPrice, level.id);
}

function markPlaced(level, order) {
  db.prepare(`
    UPDATE cascade_levels
    SET status = 'placed', buy_order_id = ?, placed_at = ?
    WHERE id = ?
  `).run(order.id, nowIso(), level.id);
}

function markFilled(level, filledPrice, filledAmount) {
  db.prepare(`
    UPDATE cascade_levels
    SET status = 'filled', filled_price = ?, filled_amount = ?, filled_at = ?
    WHERE id = ?
  `).run(filledPrice, filledAmount, nowIso(), level.id);
}

function markSellPlaced(level, order, sellTargetPrice) {
  db.prepare(`
    UPDATE cascade_levels
    SET sell_status = 'placed', sell_order_id = ?, sell_target_price = ?, sell_placed_at = ?
    WHERE id = ?
  `).run(order.id, sellTargetPrice, nowIso(), level.id);
}

function markSellFilled(level) {
  db.prepare(`
    UPDATE cascade_levels
    SET sell_status = 'filled', sell_filled_at = ?
    WHERE id = ?
  `).run(nowIso(), level.id);
}

function touchCascade(cascadeId, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE cascades SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...fields,
    updated_at: nowIso(),
    id: cascadeId,
  });
}

function isCascadeDone(levels) {
  return levels.every(
    (l) =>
      l.status === 'skipped' ||
      l.status === 'cancelled' ||
      (l.status === 'filled' && l.sell_status === 'filled')
  );
}

/**
 * One tick of work for a single cascade: arm trigger, skip-ahead/place next buy,
 * poll open buys for fills (placing take-profit sells on fill), poll open sells for fills.
 */
async function tickCascade(cascade) {
  const levels = db
    .prepare('SELECT * FROM cascade_levels WHERE cascade_id = ? ORDER BY level_index ASC')
    .all(cascade.id);

  // 1. Trigger arm
  if (cascade.status === 'pending_trigger') {
    const marketPrice = await gateClient.getTicker(cascade.symbol);
    if (marketPrice <= cascade.trigger_price) {
      touchCascade(cascade.id, { status: 'active' });
      cascade.status = 'active';
    } else {
      return; // not armed yet, nothing else to do this tick
    }
  }

  if (cascade.status !== 'active') return;

  // 2 & 3. Find next pending level + skip-ahead - but only while no level is
  // currently resting unfilled, otherwise this would place level N+1 before
  // level N has actually bought anything (defeats the whole point of a cascade).
  const pending = levels.filter((l) => l.status === 'pending');
  const currentlyResting = levels.some((l) => l.status === 'placed');
  if (pending.length > 0 && !currentlyResting) {
    const marketPrice = await gateClient.getTicker(cascade.symbol);
    const { toPlace, toSkip } = selectNextLevel(pending, marketPrice);
    for (const level of toSkip) {
      markSkipped(level, marketPrice);
    }
    if (toPlace) {
      const order = await gateClient.placeOrder({
        symbol: cascade.symbol,
        side: 'buy',
        price: toPlace.target_price,
        amountUsdt: toPlace.amount_usdt,
      });
      markPlaced(toPlace, order);
    }
  }

  // 5. Poll placed buys for fills
  const placedBuys = levels.filter((l) => l.status === 'placed');
  for (const level of placedBuys) {
    const order = await gateClient.getOrder(level.buy_order_id, cascade.symbol);
    if (order.status === 'closed' || order.status === 'filled') {
      const filledPrice = parseFloat(order.price) || level.target_price;
      const filledAmount = parseFloat(order.amount) || level.amount_usdt / level.target_price;
      markFilled(level, filledPrice, filledAmount);

      const sellTargetPrice = computeSellTarget(filledPrice, level.take_profit_pct);
      const sellOrder = await gateClient.placeOrder({
        symbol: cascade.symbol,
        side: 'sell',
        price: sellTargetPrice,
        amountBase: filledAmount,
      });
      markSellPlaced(level, sellOrder, sellTargetPrice);
    }
  }

  // 5b. Safety net: any filled level that ended up without a resting take-profit
  // sell (e.g. its sell was just manually cancelled) gets one placed fresh.
  const needsSell = levels.filter((l) => l.status === 'filled' && l.sell_status === 'none');
  for (const level of needsSell) {
    const sellTargetPrice = computeSellTarget(level.filled_price, level.take_profit_pct);
    const sellOrder = await gateClient.placeOrder({
      symbol: cascade.symbol,
      side: 'sell',
      price: sellTargetPrice,
      amountBase: level.filled_amount,
    });
    markSellPlaced(level, sellOrder, sellTargetPrice);
  }

  // 6. Poll placed sells for fills
  const placedSells = levels.filter((l) => l.status === 'filled' && l.sell_status === 'placed');
  for (const level of placedSells) {
    const order = await gateClient.getOrder(level.sell_order_id, cascade.symbol);
    if (order.status === 'closed' || order.status === 'filled') {
      markSellFilled(level);
    }
  }

  // 7. Completion check
  const refreshedLevels = db
    .prepare('SELECT * FROM cascade_levels WHERE cascade_id = ? ORDER BY level_index ASC')
    .all(cascade.id);
  if (isCascadeDone(refreshedLevels)) {
    touchCascade(cascade.id, { status: 'completed' });
  }
}

async function tickAllActive() {
  const cascades = db
    .prepare(`SELECT * FROM cascades WHERE status IN ('pending_trigger', 'active')`)
    .all();
  for (const cascade of cascades) {
    try {
      await tickCascade(cascade);
    } catch (err) {
      console.error(`[cascade ${cascade.id}] tick error:`, err.message);
    }
  }
}

async function cancelCascade(cascadeId) {
  const cascade = getCascade(cascadeId);
  if (!cascade) return false;

  for (const level of cascade.levels) {
    if (level.status === 'placed' && level.buy_order_id) {
      try {
        await gateClient.cancelOrder(level.buy_order_id, cascade.symbol);
      } catch (err) {
        console.error(`[cascade ${cascadeId}] failed to cancel buy order ${level.buy_order_id}:`, err.message);
      }
    }
    if (level.sell_status === 'placed' && level.sell_order_id) {
      try {
        await gateClient.cancelOrder(level.sell_order_id, cascade.symbol);
      } catch (err) {
        console.error(`[cascade ${cascadeId}] failed to cancel sell order ${level.sell_order_id}:`, err.message);
      }
    }
  }

  touchCascade(cascadeId, { status: 'cancelled' });
  return true;
}

function holdCascade(cascadeId) {
  const cascade = getCascade(cascadeId);
  if (!cascade) return false;
  if (cascade.status !== 'active' && cascade.status !== 'pending_trigger') return false;

  touchCascade(cascadeId, { status: 'held', pre_hold_status: cascade.status });
  return true;
}

function resumeCascade(cascadeId) {
  const cascade = getCascade(cascadeId);
  if (!cascade) return false;
  if (cascade.status !== 'held') return false;

  touchCascade(cascadeId, { status: cascade.pre_hold_status || 'active', pre_hold_status: null });
  return true;
}

function findLevel(cascadeId, levelId) {
  return db
    .prepare('SELECT * FROM cascade_levels WHERE id = ? AND cascade_id = ?')
    .get(levelId, cascadeId);
}

/**
 * Cancel a single level's currently-resting order (buy or sell side) without
 * touching the rest of the cascade. The buy side reverts to 'pending' so the
 * normal skip-ahead logic re-evaluates and re-places it on the next tick; the
 * sell side reverts to 'none' so the safety-net re-placement picks it back up.
 */
async function cancelLevelOrder(cascadeId, levelId, side) {
  const level = findLevel(cascadeId, levelId);
  if (!level) return { ok: false, error: 'Level not found' };
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId);

  if (side === 'buy') {
    if (level.status !== 'placed' || !level.buy_order_id) {
      return { ok: false, error: 'No resting buy order to cancel' };
    }
    await gateClient.cancelOrder(level.buy_order_id, cascade.symbol);
    db.prepare(`
      UPDATE cascade_levels SET status = 'pending', buy_order_id = NULL, placed_at = NULL WHERE id = ?
    `).run(level.id);
    return { ok: true };
  }

  if (side === 'sell') {
    if (level.sell_status !== 'placed' || !level.sell_order_id) {
      return { ok: false, error: 'No resting sell order to cancel' };
    }
    await gateClient.cancelOrder(level.sell_order_id, cascade.symbol);
    db.prepare(`
      UPDATE cascade_levels
      SET sell_status = 'none', sell_order_id = NULL, sell_target_price = NULL, sell_placed_at = NULL
      WHERE id = ?
    `).run(level.id);
    return { ok: true };
  }

  return { ok: false, error: "side must be 'buy' or 'sell'" };
}

/** Directly edit a not-yet-placed level - no exchange interaction needed. */
function editPendingLevel(cascadeId, levelId, { target_price, amount_usdt, take_profit_pct }) {
  const level = findLevel(cascadeId, levelId);
  if (!level) return { ok: false, error: 'Level not found' };
  if (level.status !== 'pending') {
    return { ok: false, error: 'Level is not pending - it already has a resting order' };
  }
  if (!(target_price > 0) || !(amount_usdt > 0)) {
    return { ok: false, error: 'target_price and amount_usdt must be positive numbers' };
  }

  db.prepare(`
    UPDATE cascade_levels SET target_price = ?, amount_usdt = ?, take_profit_pct = ? WHERE id = ?
  `).run(target_price, amount_usdt, take_profit_pct, level.id);
  return { ok: true };
}

/** Edit a resting buy order: cancel the old one and place a new one at the new price/amount. */
async function editPlacedLevel(cascadeId, levelId, { target_price, amount_usdt }) {
  const level = findLevel(cascadeId, levelId);
  if (!level) return { ok: false, error: 'Level not found' };
  if (level.status !== 'placed') {
    return { ok: false, error: 'Level does not have a resting buy order' };
  }
  if (!(target_price > 0) || !(amount_usdt > 0)) {
    return { ok: false, error: 'target_price and amount_usdt must be positive numbers' };
  }
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId);

  await gateClient.cancelOrder(level.buy_order_id, cascade.symbol);
  const order = await gateClient.placeOrder({
    symbol: cascade.symbol,
    side: 'buy',
    price: target_price,
    amountUsdt: amount_usdt,
  });
  db.prepare(`
    UPDATE cascade_levels
    SET target_price = ?, amount_usdt = ?, buy_order_id = ?, placed_at = ?
    WHERE id = ?
  `).run(target_price, amount_usdt, order.id, nowIso(), level.id);
  return { ok: true };
}

/** Edit a resting take-profit sell's price: cancel the old one, place a new one at the same quantity. */
async function editSellPrice(cascadeId, levelId, { sell_target_price }) {
  const level = findLevel(cascadeId, levelId);
  if (!level) return { ok: false, error: 'Level not found' };
  if (level.sell_status !== 'placed') {
    return { ok: false, error: 'Level does not have a resting sell order' };
  }
  if (!(sell_target_price > 0)) {
    return { ok: false, error: 'sell_target_price must be a positive number' };
  }
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId);

  await gateClient.cancelOrder(level.sell_order_id, cascade.symbol);
  const order = await gateClient.placeOrder({
    symbol: cascade.symbol,
    side: 'sell',
    price: sell_target_price,
    amountBase: level.filled_amount,
  });
  db.prepare(`
    UPDATE cascade_levels SET sell_target_price = ?, sell_order_id = ?, sell_placed_at = ? WHERE id = ?
  `).run(sell_target_price, order.id, nowIso(), level.id);
  return { ok: true };
}

async function deleteCascade(cascadeId) {
  const cascade = getCascade(cascadeId);
  if (!cascade) return false;

  if (['active', 'pending_trigger', 'held'].includes(cascade.status)) {
    await cancelCascade(cascadeId);
  }

  db.prepare('DELETE FROM cascade_levels WHERE cascade_id = ?').run(cascadeId);
  db.prepare('DELETE FROM cascades WHERE id = ?').run(cascadeId);
  return true;
}

module.exports = {
  createCascade,
  getCascade,
  listCascades,
  tickCascade,
  tickAllActive,
  cancelCascade,
  holdCascade,
  resumeCascade,
  deleteCascade,
  cancelLevelOrder,
  editPendingLevel,
  editPlacedLevel,
  editSellPrice,
};
