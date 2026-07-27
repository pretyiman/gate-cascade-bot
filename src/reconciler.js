// Periodic sweep that keeps WebSocket connections in sync with reality: opens
// one for every user who currently has a live (non-dry-run, keyed) cascade,
// closes any that no longer qualify. Completely inert when ENABLE_GATE_WS is
// off (the default) - native trigger orders + the existing REST reconciliation
// poll (src/scheduler.js, untouched) already work fully without this.
const db = require('./db');

function isEnabled() {
  return String(process.env.ENABLE_GATE_WS || 'false').toLowerCase() === 'true';
}

function isForceDryRun() {
  return String(process.env.FORCE_DRY_RUN || 'false').toLowerCase() === 'true';
}

function eligibleUserIds() {
  if (isForceDryRun()) return [];
  return db
    .prepare(
      `SELECT DISTINCT users.id FROM cascades
       JOIN users ON users.id = cascades.user_id
       WHERE cascades.status IN ('pending_trigger', 'active')
         AND users.dry_run = 0
         AND users.gate_api_key_encrypted IS NOT NULL
         AND users.gate_api_secret_encrypted IS NOT NULL`
    )
    .all()
    .map((r) => r.id);
}

async function reconcileConnections() {
  if (!isEnabled()) return;
  // Lazy require to keep gateWs.js's ws/crypto setup out of any code path
  // that never actually uses it (ENABLE_GATE_WS=false, the default).
  const gateWs = require('./gateWs');
  gateWs.reconcileConnections(eligibleUserIds());
}

/** Runs once immediately (this doubles as the startup scan - no separate code path needed) then on its own interval. */
function startReconciler({ intervalSeconds = 15 } = {}) {
  if (!isEnabled()) {
    console.log('ENABLE_GATE_WS is off - WebSocket connection reconciler not started (native trigger orders + REST polling remain fully active).');
    return null;
  }

  reconcileConnections().catch((err) => console.error('[reconciler] error:', err.message));
  const handle = setInterval(() => {
    reconcileConnections().catch((err) => console.error('[reconciler] error:', err.message));
  }, intervalSeconds * 1000);
  console.log(`[reconciler] WebSocket connection sweep started: every ${intervalSeconds}s`);
  return handle;
}

module.exports = { reconcileConnections, startReconciler, eligibleUserIds };
