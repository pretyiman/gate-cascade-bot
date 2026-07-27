const { tickAllActive } = require('./cascadeEngine');

// A single shared tick loop keeps this simple: it re-checks every active cascade
// each run. Per-cascade poll_interval_seconds is stored for future use if cascades
// ever need independent cadences; for now one interval drives all of them.
// A plain setInterval is used rather than a cron library since this is fixed-cadence
// polling, not calendar scheduling - no need for the extra dependency/expression syntax.
function startScheduler({ intervalSeconds = 60 } = {}) {
  const handle = setInterval(() => {
    tickAllActive().catch((err) => console.error('tickAllActive error:', err));
  }, intervalSeconds * 1000);
  console.log(`Scheduler started: ticking every ${intervalSeconds}s`);
  return handle;
}

module.exports = { startScheduler };
