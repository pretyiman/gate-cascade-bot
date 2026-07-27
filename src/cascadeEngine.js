const { randomUUID } = require('crypto');
const db = require('./db');
const gateClient = require('./gateClient');
const { computeLevels, computeSellTarget, selectNextLevel } = require('./cascadeMath');
const { decrypt } = require('./secretsCrypto');

function nowIso() {
  return new Date().toISOString();
}

function createCascade(userId, config) {
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
      id, user_id, symbol, trigger_price, base_price, base_amount_usdt, price_step_pct,
      amount_step_pct, num_levels, take_profit_base_pct, take_profit_step_pct,
      poll_interval_seconds, status, created_at, updated_at
    ) VALUES (@id, @user_id, @symbol, @trigger_price, @base_price, @base_amount_usdt, @price_step_pct,
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
      user_id: userId,
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

function getCascade(userId, cascadeId) {
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ? AND user_id = ?').get(cascadeId, userId);
  if (!cascade) return null;
  const levels = db
    .prepare('SELECT * FROM cascade_levels WHERE cascade_id = ? ORDER BY level_index ASC')
    .all(cascadeId);
  return { ...cascade, levels };
}

function listCascades(userId) {
  return db.prepare('SELECT * FROM cascades WHERE user_id = ? ORDER BY created_at DESC').all(userId);
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
 * `client` is that cascade's owner's Gate.io client (already bound to their
 * decrypted credentials and dry-run mode) - this function has no notion of users.
 */
async function tickCascade(cascade, client) {
  const levels = db
    .prepare('SELECT * FROM cascade_levels WHERE cascade_id = ? ORDER BY level_index ASC')
    .all(cascade.id);

  // 1. Trigger arm
  if (cascade.status === 'pending_trigger') {
    const marketPrice = await client.getTicker(cascade.symbol);
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
    const marketPrice = await client.getTicker(cascade.symbol);
    const { toPlace, toSkip } = selectNextLevel(pending, marketPrice);
    for (const level of toSkip) {
      markSkipped(level, marketPrice);
    }
    if (toPlace) {
      const order = await client.placeOrder({
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
    const order = await client.getOrder(level.buy_order_id, cascade.symbol);
    if (order.status === 'closed' || order.status === 'filled') {
      const filledPrice = parseFloat(order.price) || level.target_price;
      const filledAmount = parseFloat(order.amount) || level.amount_usdt / level.target_price;
      markFilled(level, filledPrice, filledAmount);

      const sellTargetPrice = computeSellTarget(filledPrice, level.take_profit_pct);
      const sellOrder = await client.placeOrder({
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
    const sellOrder = await client.placeOrder({
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
    const order = await client.getOrder(level.sell_order_id, cascade.symbol);
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

function isForceDryRun() {
  return String(process.env.FORCE_DRY_RUN || 'false').toLowerCase() === 'true';
}

/**
 * Ticks every tenant's active cascades in one pass. Each row's client is built
 * (decrypting that user's credentials) INSIDE the per-cascade try/catch, so one
 * user's bad/missing credentials can't take down every other tenant's tick.
 */
async function tickAllActive() {
  const cascades = db
    .prepare(
      `SELECT cascades.*, users.gate_api_key_encrypted, users.gate_api_secret_encrypted, users.dry_run AS user_dry_run
       FROM cascades JOIN users ON users.id = cascades.user_id
       WHERE cascades.status IN ('pending_trigger', 'active')`
    )
    .all();

  const forceDryRun = isForceDryRun();

  for (const cascade of cascades) {
    try {
      if (!cascade.gate_api_key_encrypted || !cascade.gate_api_secret_encrypted) {
        console.log(`[cascade ${cascade.id}] skipped - owner hasn't configured a Gate.io API key yet`);
        continue;
      }
      const apiKey = decrypt(cascade.gate_api_key_encrypted, `${cascade.user_id}:gate_api_key`);
      const apiSecret = decrypt(cascade.gate_api_secret_encrypted, `${cascade.user_id}:gate_api_secret`);
      const client = gateClient.createClient({
        apiKey,
        apiSecret,
        dryRun: forceDryRun || !!cascade.user_dry_run,
      });
      await tickCascade(cascade, client);
    } catch (err) {
      console.error(`[cascade ${cascade.id}] tick error:`, err.message);
    }
  }
}

async function cancelCascade(userId, cascadeId, client) {
  const cascade = getCascade(userId, cascadeId);
  if (!cascade) return false;

  for (const level of cascade.levels) {
    if (level.status === 'placed' && level.buy_order_id) {
      try {
        await client.cancelOrder(level.buy_order_id, cascade.symbol);
      } catch (err) {
        console.error(`[cascade ${cascadeId}] failed to cancel buy order ${level.buy_order_id}:`, err.message);
      }
    }
    if (level.sell_status === 'placed' && level.sell_order_id) {
      try {
        await client.cancelOrder(level.sell_order_id, cascade.symbol);
      } catch (err) {
        console.error(`[cascade ${cascadeId}] failed to cancel sell order ${level.sell_order_id}:`, err.message);
      }
    }
  }

  touchCascade(cascadeId, { status: 'cancelled' });
  return true;
}

function holdCascade(userId, cascadeId) {
  const cascade = getCascade(userId, cascadeId);
  if (!cascade) return false;
  if (cascade.status !== 'active' && cascade.status !== 'pending_trigger') return false;

  touchCascade(cascadeId, { status: 'held', pre_hold_status: cascade.status });
  return true;
}

function resumeCascade(userId, cascadeId) {
  const cascade = getCascade(userId, cascadeId);
  if (!cascade) return false;
  if (cascade.status !== 'held') return false;

  touchCascade(cascadeId, { status: cascade.pre_hold_status || 'active', pre_hold_status: null });
  return true;
}

function findLevel(userId, cascadeId, levelId) {
  return db
    .prepare(
      `SELECT cascade_levels.* FROM cascade_levels
       JOIN cascades ON cascades.id = cascade_levels.cascade_id
       WHERE cascade_levels.id = ? AND cascade_levels.cascade_id = ? AND cascades.user_id = ?`
    )
    .get(levelId, cascadeId, userId);
}

/**
 * Cancel a single level's currently-resting order (buy or sell side) without
 * touching the rest of the cascade. The buy side reverts to 'pending' so the
 * normal skip-ahead logic re-evaluates and re-places it on the next tick; the
 * sell side reverts to 'none' so the safety-net re-placement picks it back up.
 */
async function cancelLevelOrder(userId, cascadeId, levelId, side, client) {
  const level = findLevel(userId, cascadeId, levelId);
  if (!level) return { ok: false, error: 'Level not found' };
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ? AND user_id = ?').get(cascadeId, userId);

  if (side === 'buy') {
    if (level.status !== 'placed' || !level.buy_order_id) {
      return { ok: false, error: 'No resting buy order to cancel' };
    }
    await client.cancelOrder(level.buy_order_id, cascade.symbol);
    db.prepare(`
      UPDATE cascade_levels SET status = 'pending', buy_order_id = NULL, placed_at = NULL WHERE id = ?
    `).run(level.id);
    return { ok: true };
  }

  if (side === 'sell') {
    if (level.sell_status !== 'placed' || !level.sell_order_id) {
      return { ok: false, error: 'No resting sell order to cancel' };
    }
    await client.cancelOrder(level.sell_order_id, cascade.symbol);
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
function editPendingLevel(userId, cascadeId, levelId, { target_price, amount_usdt, take_profit_pct }) {
  const level = findLevel(userId, cascadeId, levelId);
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
async function editPlacedLevel(userId, cascadeId, levelId, { target_price, amount_usdt }, client) {
  const level = findLevel(userId, cascadeId, levelId);
  if (!level) return { ok: false, error: 'Level not found' };
  if (level.status !== 'placed') {
    return { ok: false, error: 'Level does not have a resting buy order' };
  }
  if (!(target_price > 0) || !(amount_usdt > 0)) {
    return { ok: false, error: 'target_price and amount_usdt must be positive numbers' };
  }
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ? AND user_id = ?').get(cascadeId, userId);

  await client.cancelOrder(level.buy_order_id, cascade.symbol);
  const order = await client.placeOrder({
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
async function editSellPrice(userId, cascadeId, levelId, { sell_target_price }, client) {
  const level = findLevel(userId, cascadeId, levelId);
  if (!level) return { ok: false, error: 'Level not found' };
  if (level.sell_status !== 'placed') {
    return { ok: false, error: 'Level does not have a resting sell order' };
  }
  if (!(sell_target_price > 0)) {
    return { ok: false, error: 'sell_target_price must be a positive number' };
  }
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ? AND user_id = ?').get(cascadeId, userId);

  await client.cancelOrder(level.sell_order_id, cascade.symbol);
  const order = await client.placeOrder({
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

async function deleteCascade(userId, cascadeId, client) {
  const cascade = getCascade(userId, cascadeId);
  if (!cascade) return false;

  if (['active', 'pending_trigger', 'held'].includes(cascade.status)) {
    await cancelCascade(userId, cascadeId, client);
  }

  db.prepare('DELETE FROM cascade_levels WHERE cascade_id = ?').run(cascadeId);
  db.prepare('DELETE FROM cascades WHERE id = ? AND user_id = ?').run(cascadeId, userId);
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
