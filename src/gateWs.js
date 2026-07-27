// Per-user WebSocket connection manager. One connection per LIVE user (not a
// single global connection) - Gate.io's private channels are account-scoped,
// and each tenant trades on their own key. Carries no business logic: every
// message this receives just looks up which cascade it belongs to and calls
// cascadeEngine's tickCascadeById, which re-runs the exact same tickCascade
// the reconciliation poll already uses.
//
// NOT YET VERIFIED against a real live connection - the exact WS envelope for
// spot.priceorders in particular is the least-confirmed part of this whole
// design (per the plan). This is why ENABLE_GATE_WS defaults off and why
// every message is logged: the first real enablement should be watched
// closely against one real account before being trusted.
const crypto = require('crypto');
const WebSocket = require('ws');
const db = require('./db');
const { decrypt } = require('./secretsCrypto');

const WS_URL = 'wss://api.gateio.ws/ws/v4/';
const WATCHDOG_INTERVAL_MS = 10 * 1000;
const STALE_AFTER_MS = 30 * 1000; // laptop sleep/wifi drop often doesn't fire a clean 'close'
const MAX_BACKOFF_MS = 30 * 1000;

// userId -> { ws, connecting, loggedIn, reconnectAttempts, lastMessageAt, watchdogTimer, torndown }
const connections = new Map();

function isForceDryRun() {
  return String(process.env.FORCE_DRY_RUN || 'false').toLowerCase() === 'true';
}

function isGateWsEnabled() {
  return String(process.env.ENABLE_GATE_WS || 'false').toLowerCase() === 'true';
}

function signChannel(channel, event, timestamp, apiSecret) {
  const message = `channel=${channel}&event=${event}&time=${timestamp}`;
  return crypto.createHmac('sha512', apiSecret).update(message).digest('hex');
}

// Checked here, not just in reconciler.js's sweep, so this module is fully
// inert regardless of caller (including api.js's eager ensureUserConnection
// calls after cascade creation/resume) whenever ENABLE_GATE_WS is off.
function isEligible(user) {
  return !!(
    isGateWsEnabled() &&
    user &&
    !isForceDryRun() &&
    !user.dry_run &&
    user.gate_api_key_encrypted &&
    user.gate_api_secret_encrypted
  );
}

/** Every distinct pair this user currently has a non-terminal cascade in - what the connection needs to be subscribed to. */
function activeSymbolsForUser(userId) {
  return db
    .prepare(`SELECT DISTINCT symbol FROM cascades WHERE user_id = ? AND status IN ('pending_trigger', 'active')`)
    .all(userId)
    .map((r) => r.symbol);
}

/**
 * Idempotent: no-ops if not (or no longer) eligible. If already connected and
 * logged in, just refreshes the subscription list (covers a new cascade for a
 * pair the connection wasn't watching yet). Otherwise opens a fresh connection.
 */
async function ensureUserConnection(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  if (!isEligible(user)) {
    teardown(userId);
    return;
  }

  const existing = connections.get(userId);
  if (existing && existing.ws && existing.loggedIn) {
    resubscribe(userId, existing);
    return;
  }
  if (existing && (existing.ws || existing.connecting)) return; // still connecting/logging in

  const state = {
    ws: null,
    connecting: true,
    loggedIn: false,
    reconnectAttempts: 0,
    lastMessageAt: Date.now(),
    torndown: false,
  };
  connections.set(userId, state);
  openConnection(userId, state);
}

/** Deliberate teardown - no reconnect will follow (state removed before 'close' fires). */
function teardown(userId) {
  const state = connections.get(userId);
  if (!state) return;
  state.torndown = true;
  if (state.watchdogTimer) clearInterval(state.watchdogTimer);
  connections.delete(userId);
  if (state.ws) {
    try {
      state.ws.terminate();
    } catch (err) {
      // already closed, fine
    }
  }
}

/** Called by reconciler.js's periodic sweep: open/refresh connections for the given users, close everyone else's. */
function reconcileConnections(eligibleUserIds) {
  const eligibleSet = new Set(eligibleUserIds);

  for (const userId of [...connections.keys()]) {
    if (!eligibleSet.has(userId)) teardown(userId);
  }
  for (const userId of eligibleUserIds) {
    ensureUserConnection(userId);
  }
}

function openConnection(userId, state) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!isEligible(user)) {
    connections.delete(userId);
    return;
  }

  const apiKey = decrypt(user.gate_api_key_encrypted, `${userId}:gate_api_key`);
  const apiSecret = decrypt(user.gate_api_secret_encrypted, `${userId}:gate_api_secret`);

  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  state.connecting = false;
  state.loggedIn = false;
  state.lastMessageAt = Date.now();

  ws.on('open', () => {
    console.log(`[gateWs] user ${userId}: connected, logging in`);
    const timestamp = Math.floor(Date.now() / 1000);
    ws.send(
      JSON.stringify({
        time: timestamp,
        channel: 'spot.login',
        event: 'api_key',
        auth: {
          method: 'api_key',
          KEY: apiKey,
          SIGN: signChannel('spot.login', 'api_key', timestamp, apiSecret),
        },
      })
    );
  });

  ws.on('message', (raw) => {
    state.lastMessageAt = Date.now();
    handleMessage(userId, state, raw);
  });

  ws.on('close', () => {
    if (state.watchdogTimer) clearInterval(state.watchdogTimer);
    if (state.torndown) return; // deliberate teardown, no reconnect
    scheduleReconnect(userId, state);
  });

  ws.on('error', (err) => {
    console.error(`[gateWs] user ${userId}: socket error:`, err.message);
  });

  state.watchdogTimer = setInterval(() => {
    if (Date.now() - state.lastMessageAt > STALE_AFTER_MS) {
      console.log(`[gateWs] user ${userId}: no messages for ${STALE_AFTER_MS}ms, forcing reconnect`);
      try {
        ws.terminate();
      } catch (err) {
        // ignore
      }
    }
  }, WATCHDOG_INTERVAL_MS);
}

function scheduleReconnect(userId, state) {
  const attempt = (state.reconnectAttempts || 0) + 1;
  const backoff = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = backoff * (0.8 + Math.random() * 0.4);

  state.ws = null;
  state.connecting = true;
  state.loggedIn = false;
  state.reconnectAttempts = attempt;

  setTimeout(() => {
    if (!connections.has(userId) || state.torndown) return;
    console.log(`[gateWs] user ${userId}: reconnecting (attempt ${attempt})`);
    openConnection(userId, state);
  }, jitter);
}

/** Sends the CURRENT full set of active pairs every time - safe whether Gate's subscribe is additive or replace-based. */
function resubscribe(userId, state) {
  const symbols = activeSymbolsForUser(userId);
  if (symbols.length === 0) return;
  subscribe(state.ws, 'spot.usertrades', symbols);
  subscribe(state.ws, 'spot.priceorders', symbols);
}

function subscribe(ws, channel, payload) {
  ws.send(
    JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel,
      event: 'subscribe',
      payload,
    })
  );
}

function handleMessage(userId, state, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    return;
  }

  // Logged unconditionally for now - this is the least-confirmed part of the
  // whole design (see file header). Once verified against a real account this
  // can be trimmed to just error/unexpected cases.
  console.log(`[gateWs] user ${userId}: recv`, JSON.stringify(msg));

  if (msg.channel === 'spot.login') {
    if (msg.error) {
      console.error(`[gateWs] user ${userId}: login failed:`, msg.error.message || msg.error);
      return;
    }
    state.loggedIn = true;
    resubscribe(userId, state);
    return;
  }

  if (msg.event !== 'update' || !msg.result) return;

  const results = Array.isArray(msg.result) ? msg.result : [msg.result];

  if (msg.channel === 'spot.usertrades' || msg.channel === 'spot.usertrades_v2') {
    for (const trade of results) {
      wakeCascadeForOrder(trade.order_id);
    }
  } else if (msg.channel === 'spot.priceorders') {
    for (const priceOrder of results) {
      wakeCascadeForTriggerOrder(priceOrder.id);
    }
  }
}

function wakeCascadeForOrder(orderId) {
  if (!orderId) return;
  const level = db
    .prepare('SELECT cascade_id FROM cascade_levels WHERE buy_order_id = ? OR sell_order_id = ?')
    .get(String(orderId), String(orderId));
  if (!level) return;

  // Lazy require: cascadeEngine.js has no reason to depend on gateWs.js, so
  // this avoids any circular-require fragility between the two files.
  const { tickCascadeById } = require('./cascadeEngine');
  tickCascadeById(level.cascade_id).catch((err) =>
    console.error(`[gateWs] tick error for cascade ${level.cascade_id}:`, err.message)
  );
}

function wakeCascadeForTriggerOrder(triggerOrderId) {
  if (!triggerOrderId) return;
  const level = db.prepare('SELECT cascade_id FROM cascade_levels WHERE trigger_order_id = ?').get(String(triggerOrderId));
  if (!level) return;

  const { tickCascadeById } = require('./cascadeEngine');
  tickCascadeById(level.cascade_id).catch((err) =>
    console.error(`[gateWs] tick error for cascade ${level.cascade_id}:`, err.message)
  );
}

module.exports = { ensureUserConnection, reconcileConnections, teardown };
