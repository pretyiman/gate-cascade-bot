const { randomUUID } = require('crypto');
const db = require('./db');
const gateClient = require('./gateClient');
const { computeLevels, computeSellTarget, selectNextLevel } = require('./cascadeMath');
const { decrypt } = require('./secretsCrypto');
const { withLock } = require('./lock');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Shared by createCascade (% based) and createCascadeFromLevels (manual
 * template) - both just need to compute a `levels` array differently, the
 * actual DB writes are identical either way.
 */
function insertCascadeAndLevels({
  userId,
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
  isManual,
  levels,
}) {
  const cascadeId = randomUUID();
  const ts = nowIso();
  const initialStatus = trigger_price != null ? 'pending_trigger' : 'active';

  const insertCascade = db.prepare(`
    INSERT INTO cascades (
      id, user_id, symbol, trigger_price, base_price, base_amount_usdt, price_step_pct,
      amount_step_pct, num_levels, take_profit_base_pct, take_profit_step_pct,
      poll_interval_seconds, status, is_manual, created_at, updated_at
    ) VALUES (@id, @user_id, @symbol, @trigger_price, @base_price, @base_amount_usdt, @price_step_pct,
      @amount_step_pct, @num_levels, @take_profit_base_pct, @take_profit_step_pct,
      @poll_interval_seconds, @status, @is_manual, @created_at, @updated_at)
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
      is_manual: isManual ? 1 : 0,
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

/**
 * Best-effort synchronous placement right after a cascade is created or
 * resumed - only for live, credentialed users (dry-run or no-key-configured
 * cascades just sit as freshly inserted/reverted and get picked up by the
 * normal reconciliation tick, exactly as before this existed). Never throws -
 * a failure here just means the fallback poll retries it, same as any other
 * tick-time failure already does.
 */
async function armCascadeSynchronously(userId, cascadeId, client) {
  if (!client || client.dryRun) return;

  try {
    await withLock(cascadeId, async () => {
      const cascade = getCascade(userId, cascadeId);
      if (!cascade || (cascade.status !== 'pending_trigger' && cascade.status !== 'active')) return;

      if (cascade.status === 'pending_trigger') {
        const level1 = cascade.levels.find((l) => l.level_index === 1);
        if (!level1 || level1.status !== 'pending') return;

        if (cascade.trigger_price != null) {
          const triggerOrder = await client.placeTriggerOrder({
            symbol: cascade.symbol,
            triggerPrice: cascade.trigger_price,
            buyPrice: level1.target_price,
            amountUsdt: level1.amount_usdt,
          });
          markTriggerArmed(level1, triggerOrder);
        } else {
          await placeNextLevel(cascade, cascade.levels, client);
        }
      } else {
        // Already active (level 1's trigger fired earlier, or there was never
        // one) - reuses the same skip-ahead placement tickCascade's poll uses,
        // which already no-ops if nothing is pending or something's resting.
        // This is also what lets resumeCascade re-place a later level
        // immediately after hold cancelled its resting order.
        await placeNextLevel(cascade, cascade.levels, client);
      }
    });
  } catch (err) {
    console.error(`[cascade ${cascadeId}] synchronous placement failed, will retry via reconciliation:`, err.message);
  }
}

async function createCascade(userId, config, client) {
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

  const cascadeId = insertCascadeAndLevels({
    userId,
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
    isManual: false,
    levels,
  });

  await armCascadeSynchronously(userId, cascadeId, client);
  return cascadeId;
}

/**
 * Manual template: each level's buy price, USDT amount, and exact sell price
 * are given directly - no % math. The absolute sell price is converted into
 * the same take_profit_pct the engine already stores, so tickCascade/etc. run
 * completely unchanged; this only affects how a cascade gets created.
 */
async function createCascadeFromLevels(userId, { symbol, trigger_price = null, levels: rawLevels }, client) {
  if (!Array.isArray(rawLevels) || rawLevels.length === 0) {
    throw new Error('At least one level is required');
  }

  const levels = rawLevels.map((l, idx) => {
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

  // Gate.io won't reject a buy price that's technically valid but wrong (e.g. a
  // misplaced decimal) - it just fills instantly at a bad price instead of
  // erroring. Catch that here for level 1, the one that actually executes first.
  const marketPrice = await gateClient.getPublicTicker(symbol);
  const ratio = levels[0].target_price / marketPrice;
  if (ratio < 0.2 || ratio > 3) {
    throw new Error(
      `Level 1 buy price (${levels[0].target_price}) looks far from ${symbol}'s current market price (${marketPrice}) - check for a misplaced decimal.`
    );
  }

  const cascadeId = insertCascadeAndLevels({
    userId,
    symbol,
    trigger_price,
    base_price: levels[0].target_price,
    base_amount_usdt: levels[0].amount_usdt,
    price_step_pct: 0,
    amount_step_pct: 0,
    num_levels: levels.length,
    take_profit_base_pct: levels[0].take_profit_pct,
    take_profit_step_pct: 0,
    poll_interval_seconds: 60,
    isManual: true,
    levels,
  });

  await armCascadeSynchronously(userId, cascadeId, client);
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
    SET status = 'placed', buy_order_id = ?, placed_at = ?, trigger_order_id = NULL
    WHERE id = ?
  `).run(order.id, nowIso(), level.id);
}

function markTriggerArmed(level, triggerOrder) {
  db.prepare(`
    UPDATE cascade_levels SET status = 'trigger_armed', trigger_order_id = ? WHERE id = ?
  `).run(triggerOrder.id, level.id);
}

/** Gate gave up on the native trigger (cancelled/expired/failed) - fall back to the normal pending path so placeNextLevel retries it. */
function markTriggerFailed(level, triggerStatus, reason) {
  db.prepare(`
    UPDATE cascade_levels SET status = 'pending', skip_reason = ?, trigger_order_id = NULL WHERE id = ?
  `).run(`trigger_${triggerStatus}${reason ? `: ${reason}` : ''}`, level.id);
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
 * Skip-ahead evaluate-and-place: finds the next 'pending' level and either
 * skips it (market already crashed past it) or places it, via the existing
 * cascadeMath.js selectNextLevel logic - unchanged. Only runs while no level
 * is currently resting unfilled (status 'placed' or 'trigger_armed'), so a
 * level is never placed before the previous one has actually filled.
 *
 * Called from two places: tickCascade's own tick (the reconciliation/fallback
 * path), and reactively the moment a fill event arrives (once the WS layer
 * lands) - reusing this exact function is what closes the fast-crash gap: a
 * fresh price check happens right before every single placement, so multiple
 * levels can never fire at once the way pre-registered chained triggers could.
 */
async function placeNextLevel(cascade, levels, client) {
  const pending = levels.filter((l) => l.status === 'pending');
  const currentlyResting = levels.some((l) => l.status === 'placed' || l.status === 'trigger_armed');
  if (pending.length === 0 || currentlyResting) return;

  const marketPrice = await client.getTicker(cascade.symbol);
  const { toPlace, toSkip } = selectNextLevel(pending, marketPrice);
  for (const level of toSkip) {
    markSkipped(level, marketPrice);
  }
  if (toPlace) {
    if (client.dryRun) {
      const order = await client.placeOrder({
        symbol: cascade.symbol,
        side: 'buy',
        price: toPlace.target_price,
        amountUsdt: toPlace.amount_usdt,
      });
      markPlaced(toPlace, order);
    } else {
      // Live: use Gate's native trigger here too, same as level 1's explicit
      // arm price, so this level's USDT doesn't get locked until price is
      // actually close. There's no user-declared arm price for this level, so
      // one is computed - see gateClient.js's computeReactiveTriggerPrice.
      const { pricePrecision } = await gateClient.getPairPrecision(cascade.symbol);
      const triggerPrice = gateClient.computeReactiveTriggerPrice(toPlace.target_price, pricePrecision);
      const triggerOrder = await client.placeTriggerOrder({
        symbol: cascade.symbol,
        triggerPrice,
        buyPrice: toPlace.target_price,
        amountUsdt: toPlace.amount_usdt,
      });
      markTriggerArmed(toPlace, triggerOrder);
    }
  }
}

/**
 * Polls one level's native trigger order and promotes/reverts it in place -
 * shared by level 1's cascade-entry arm and the generalized per-level check
 * below, both of which need the exact same finish/cancelled/still-waiting
 * handling. Mutates `level` in place so the caller sees the update immediately.
 */
async function pollLevelTrigger(level, client) {
  const triggerOrder = await client.getTriggerOrder(level.trigger_order_id);
  if (triggerOrder.status === 'finish') {
    const firedOrderId = String(triggerOrder.fired_order_id);
    markPlaced(level, { id: firedOrderId });
    level.status = 'placed';
    level.buy_order_id = firedOrderId;
    return 'finished';
  }
  if (['cancelled', 'expired', 'failed'].includes(triggerOrder.status)) {
    markTriggerFailed(level, triggerOrder.status, triggerOrder.reason);
    level.status = 'pending';
    return 'reverted';
  }
  return 'still_waiting';
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

  // 1. Cascade-entry trigger arm (level 1 only, user-declared trigger_price) -
  // two paths. Most cascades (dry-run, no key configured yet, or a live one
  // whose synchronous native-trigger attempt at creation time failed and fell
  // back) use the original REST-poll comparison, unchanged. A live cascade
  // whose level 1 is already 'trigger_armed' instead polls Gate's own native
  // price-triggered order - see cascadeEngine.js's createCascade/resumeCascade
  // for where that gets armed in the first place.
  if (cascade.status === 'pending_trigger') {
    const level1 = levels.find((l) => l.level_index === 1);

    if (level1 && level1.status === 'trigger_armed' && level1.trigger_order_id) {
      const result = await pollLevelTrigger(level1, client);
      if (result === 'finished') {
        touchCascade(cascade.id, { status: 'active' });
        cascade.status = 'active';
      } else if (result === 'reverted') {
        return; // reverted to pending - the next tick's placeNextLevel retries it normally
      } else {
        return; // still open/waiting on Gate.io, nothing else to do this tick
      }
    } else {
      const marketPrice = await client.getTicker(cascade.symbol);
      if (marketPrice <= cascade.trigger_price) {
        touchCascade(cascade.id, { status: 'active' });
        cascade.status = 'active';
      } else {
        return; // not armed yet, nothing else to do this tick
      }
    }
  }

  if (cascade.status !== 'active') return;

  // 1b. Any other level's reactive trigger (levels 2+, or level 1 when there
  // was no cascade-wide trigger_price to begin with) - each one is armed by
  // placeNextLevel below, one at a time, only after the previous level fills.
  const armedLevel = levels.find((l) => l.status === 'trigger_armed');
  if (armedLevel) {
    const result = await pollLevelTrigger(armedLevel, client);
    if (result === 'still_waiting') return; // nothing else to do this tick
    // 'finished' or 'reverted' both fall through to placeNextLevel below -
    // finished means the next level can now be considered; reverted means
    // this same one gets retried immediately with a fresh price check.
  }

  // 2. Poll placed buys for fills - done BEFORE placing the next level (unlike
  // the old pure-polling order) so that a single reactive wake-up chains
  // fill -> sell placed -> next level armed all in one pass, instead of
  // needing a second tick to notice the fill happened. Harmless for dry-run:
  // its getOrder never auto-transitions to filled on its own, so this loop
  // simply finds nothing there, same as before.
  const placedBuys = levels.filter((l) => l.status === 'placed');
  for (const level of placedBuys) {
    const order = await client.getOrder(level.buy_order_id, cascade.symbol);
    if (order.status === 'closed' || order.status === 'filled') {
      const filledPrice = parseFloat(order.price) || level.target_price;
      const filledAmount = parseFloat(order.amount) || level.amount_usdt / level.target_price;
      markFilled(level, filledPrice, filledAmount);
      level.status = 'filled';
      level.filled_price = filledPrice;
      level.filled_amount = filledAmount;

      const sellTargetPrice = computeSellTarget(filledPrice, level.take_profit_pct);
      const sellOrder = await client.placeOrder({
        symbol: cascade.symbol,
        side: 'sell',
        price: sellTargetPrice,
        amountBase: filledAmount,
      });
      markSellPlaced(level, sellOrder, sellTargetPrice);
      level.sell_status = 'placed';
      level.sell_order_id = sellOrder.id;
    }
  }

  // 2b. Safety net: any filled level that ended up without a resting take-profit
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
    level.sell_status = 'placed';
    level.sell_order_id = sellOrder.id;
  }

  // 3. Find next pending level + skip-ahead - sees this tick's fills too, so
  // the level that just filled no longer counts as "resting" and the next
  // one gets evaluated with a fresh price check right away.
  await placeNextLevel(cascade, levels, client);

  // 4. Poll placed sells for fills
  const placedSells = levels.filter((l) => l.status === 'filled' && l.sell_status === 'placed');
  for (const level of placedSells) {
    const order = await client.getOrder(level.sell_order_id, cascade.symbol);
    if (order.status === 'closed' || order.status === 'filled') {
      markSellFilled(level);
    }
  }

  // 5. Completion check
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
 * Thin wrapper for the WebSocket layer to call: "something happened for this
 * cascade, go re-check it now" - loads it fresh, builds its owner's client,
 * and ticks it under the lock. No business logic lives here or in gateWs.js;
 * this just reuses the exact same tickCascade the reconciliation poll uses.
 */
async function tickCascadeById(cascadeId) {
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId);
  if (!cascade || !['pending_trigger', 'active'].includes(cascade.status)) return;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(cascade.user_id);
  if (!user || !user.gate_api_key_encrypted || !user.gate_api_secret_encrypted) return;

  const apiKey = decrypt(user.gate_api_key_encrypted, `${user.id}:gate_api_key`);
  const apiSecret = decrypt(user.gate_api_secret_encrypted, `${user.id}:gate_api_secret`);
  const client = gateClient.createClient({
    apiKey,
    apiSecret,
    dryRun: isForceDryRun() || !!user.dry_run,
  });

  await withLock(cascadeId, () => tickCascade(cascade, client));
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
      await withLock(cascade.id, () => tickCascade(cascade, client));
    } catch (err) {
      console.error(`[cascade ${cascade.id}] tick error:`, err.message);
    }
  }
}

async function cancelCascade(userId, cascadeId, client) {
  const cascade = getCascade(userId, cascadeId);
  if (!cascade) return false;

  for (const level of cascade.levels) {
    if (level.status === 'trigger_armed' && level.trigger_order_id) {
      try {
        await client.cancelTriggerOrder(level.trigger_order_id);
      } catch (err) {
        console.error(`[cascade ${cascadeId}] failed to cancel trigger order ${level.trigger_order_id}:`, err.message);
      }
    } else if (level.status === 'placed' && level.buy_order_id) {
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

/**
 * Hold: for dry-run/no-key cascades this is the original bare status flip -
 * nothing was ever really resting on an exchange for those, so there's
 * nothing to cancel. For live, credentialed users it also cancels whatever's
 * actually live per level first (resting buy/sell via the exact same
 * cancelOrder call cancelLevelOrder uses, or an armed native trigger), so a
 * held cascade truly has nothing working in the background until resumed.
 */
async function holdCascade(userId, cascadeId, client) {
  const cascade = getCascade(userId, cascadeId);
  if (!cascade) return false;
  if (cascade.status !== 'active' && cascade.status !== 'pending_trigger') return false;

  if (client && !client.dryRun) {
    await withLock(cascadeId, async () => {
      for (const level of cascade.levels) {
        try {
          if (level.status === 'trigger_armed' && level.trigger_order_id) {
            await client.cancelTriggerOrder(level.trigger_order_id);
            db.prepare(`UPDATE cascade_levels SET status = 'pending', trigger_order_id = NULL WHERE id = ?`).run(level.id);
          } else if (level.status === 'placed' && level.buy_order_id) {
            await client.cancelOrder(level.buy_order_id, cascade.symbol);
            db.prepare(`
              UPDATE cascade_levels SET status = 'pending', buy_order_id = NULL, placed_at = NULL WHERE id = ?
            `).run(level.id);
          }
        } catch (err) {
          console.error(`[cascade ${cascadeId}] hold: failed to cancel buy-side order for level ${level.level_index}:`, err.message);
        }

        if (level.sell_status === 'placed' && level.sell_order_id) {
          try {
            await client.cancelOrder(level.sell_order_id, cascade.symbol);
            db.prepare(`
              UPDATE cascade_levels
              SET sell_status = 'none', sell_order_id = NULL, sell_target_price = NULL, sell_placed_at = NULL
              WHERE id = ?
            `).run(level.id);
          } catch (err) {
            console.error(`[cascade ${cascadeId}] hold: failed to cancel sell order for level ${level.level_index}:`, err.message);
          }
        }
      }
    });
  }

  touchCascade(cascadeId, { status: 'held', pre_hold_status: cascade.status });
  return true;
}

/**
 * Resume: flips status back as before. For live, credentialed users it also
 * immediately re-arms/re-places (same synchronous helper cascade creation
 * uses) instead of waiting for the next poll tick - dry-run/no-key cascades
 * keep relying purely on the poll, exactly as before this stage.
 */
async function resumeCascade(userId, cascadeId, client) {
  const cascade = getCascade(userId, cascadeId);
  if (!cascade) return false;
  if (cascade.status !== 'held') return false;

  touchCascade(cascadeId, { status: cascade.pre_hold_status || 'active', pre_hold_status: null });
  await armCascadeSynchronously(userId, cascadeId, client);
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
    if (level.status === 'trigger_armed' && level.trigger_order_id) {
      await client.cancelTriggerOrder(level.trigger_order_id);
      db.prepare(`
        UPDATE cascade_levels SET status = 'pending', trigger_order_id = NULL WHERE id = ?
      `).run(level.id);
      return { ok: true };
    }
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
  createCascadeFromLevels,
  getCascade,
  listCascades,
  tickCascade,
  tickCascadeById,
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
