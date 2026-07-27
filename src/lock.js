// Minimal per-key in-process async mutex. Sufficient because this app is a
// single Node process with a single-writer better-sqlite3 file - there is no
// multi-instance topology to coordinate across. Don't reach for DB-level
// locking unless that changes.
//
// Used to serialize the two things that can now call into tickCascade for the
// same cascade concurrently: a user's WebSocket event and the periodic
// reconciliation sweep.
const chains = new Map();

function withLock(key, fn) {
  const previous = chains.get(key) || Promise.resolve();
  const next = previous.then(fn, fn); // run fn once the previous holder settles, win or lose
  chains.set(key, next.catch(() => {})); // keep the chain alive even if fn rejected
  return next;
}

module.exports = { withLock };
