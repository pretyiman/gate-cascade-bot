const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE_NAME = 'session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour - shorter, a reset implies more urgency

const SCRYPT_OPTS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = (stored || '').split(':');
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);

  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expiresAt
  );
  return { token, expiresAt };
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

function invalidateUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/**
 * One mechanism backs both "invite to set an initial password" and "reset a
 * forgotten one" - a single-use, expiring token tied to a user. The caller
 * (a CLI script) decides the TTL and hands the resulting link to the user
 * through whatever channel they want; there's no email sending involved.
 */
function createPasswordSetToken(userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO password_set_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expiresAt
  );
  return { token, expiresAt };
}

/** Validity check without consuming - used to decide whether to show the form at all. */
function peekPasswordSetToken(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT user_id FROM password_set_tokens WHERE token = ? AND expires_at >= ?')
    .get(token, new Date().toISOString());
  return row ? row.user_id : null;
}

/** Validates and deletes the token in one step - each link only ever works once. */
function consumePasswordSetToken(token) {
  const row = db
    .prepare('SELECT user_id FROM password_set_tokens WHERE token = ? AND expires_at >= ?')
    .get(token, new Date().toISOString());
  if (!row) return null;
  db.prepare('DELETE FROM password_set_tokens WHERE token = ?').run(token);
  return row.user_id;
}

function cleanupExpiredPasswordSetTokens() {
  db.prepare('DELETE FROM password_set_tokens WHERE expires_at < ?').run(new Date().toISOString());
}

/**
 * Shared by scripts/create-invite.js and the admin "Invite user" UI action -
 * one implementation so both stay in sync. Creates the account with an
 * unusable placeholder password and an invite token; throws if the email is
 * already taken.
 */
function inviteUser(email, { isAdmin = false } = {}) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    throw new Error(`A user with email ${email} already exists`);
  }

  const id = crypto.randomUUID();
  const placeholderHash = hashPassword(crypto.randomBytes(32).toString('hex'));
  db.prepare(`
    INSERT INTO users (id, email, password_hash, dry_run, is_admin, created_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(id, email, placeholderHash, isAdmin ? 1 : 0, new Date().toISOString());

  const { token, expiresAt } = createPasswordSetToken(id, INVITE_TTL_MS);
  return { userId: id, token, expiresAt };
}

/** Shared by scripts/create-reset-link.js and the admin "Send reset link" UI action. */
function createResetLinkForEmail(email) {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    throw new Error(`No user found with email ${email}`);
  }
  const { token, expiresAt } = createPasswordSetToken(user.id, RESET_TTL_MS);
  return { userId: user.id, token, expiresAt };
}

function getUserForToken(token) {
  if (!token) return null;
  return db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ? AND sessions.expires_at >= ?`
    )
    .get(token, new Date().toISOString());
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.COOKIE_SECURE || 'true').toLowerCase() === 'true',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[SESSION_COOKIE_NAME];
  const user = getUserForToken(token);
  if (!user) {
    if (req.accepts(['html', 'json']) === 'html') {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  next();
}

/** Mount after requireAuth. Non-admins get 403 - never 404, this isn't about hiding existence. */
function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Simple in-memory login rate limiter - fine for a single Node process.
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

function checkLoginRateLimit(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (Date.now() > entry.resetAt) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: entry.count < MAX_ATTEMPTS };
}

function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: Date.now() + LOCKOUT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearLoginRateLimit(ip) {
  loginAttempts.delete(ip);
}

function loginPageHtml(errorMessage) {
  const errorHtml = errorMessage
    ? `<div style="background:#fee2e2;color:#dc2626;padding:0.6rem 0.9rem;border-radius:6px;margin-bottom:1rem;font-size:0.9rem;">${errorMessage}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Log in - Gate Cascade Bot</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f7f8fa; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  form { background:#fff; border:1px solid #e2e5ea; border-radius:8px; padding:2rem; width:320px; }
  h1 { font-size:1.1rem; margin:0 0 1.25rem; }
  label { display:block; font-size:0.8rem; color:#6b7280; margin-bottom:0.3rem; }
  input { width:100%; box-sizing:border-box; padding:0.5rem 0.6rem; border:1px solid #e2e5ea; border-radius:6px; margin-bottom:1rem; font:inherit; }
  button { width:100%; padding:0.55rem; border:none; border-radius:6px; background:#2563eb; color:#fff; font:inherit; font-weight:600; cursor:pointer; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>Gate Cascade Bot</h1>
    ${errorHtml}
    <label>Email</label>
    <input type="email" name="email" required autofocus />
    <label>Password</label>
    <input type="password" name="password" required />
    <button type="submit">Log in</button>
  </form>
</body>
</html>`;
}

function setPasswordPageHtml({ token, title, errorMessage }) {
  const errorHtml = errorMessage
    ? `<div style="background:#fee2e2;color:#dc2626;padding:0.6rem 0.9rem;border-radius:6px;margin-bottom:1rem;font-size:0.9rem;">${errorMessage}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} - Gate Cascade Bot</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f7f8fa; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  form { background:#fff; border:1px solid #e2e5ea; border-radius:8px; padding:2rem; width:320px; }
  h1 { font-size:1.1rem; margin:0 0 1.25rem; }
  label { display:block; font-size:0.8rem; color:#6b7280; margin-bottom:0.3rem; }
  input { width:100%; box-sizing:border-box; padding:0.5rem 0.6rem; border:1px solid #e2e5ea; border-radius:6px; margin-bottom:1rem; font:inherit; }
  button { width:100%; padding:0.55rem; border:none; border-radius:6px; background:#2563eb; color:#fff; font:inherit; font-weight:600; cursor:pointer; }
</style>
</head>
<body>
  <form method="POST" action="/set-password">
    <h1>${title}</h1>
    ${errorHtml}
    <input type="hidden" name="token" value="${token}" />
    <label>New password</label>
    <input type="password" name="password" required autofocus minlength="8" />
    <label>Confirm password</label>
    <input type="password" name="confirm_password" required minlength="8" />
    <button type="submit">Set password</button>
  </form>
</body>
</html>`;
}

function invalidLinkPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Link expired - Gate Cascade Bot</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f7f8fa; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  div { background:#fff; border:1px solid #e2e5ea; border-radius:8px; padding:2rem; width:320px; text-align:center; }
</style>
</head>
<body>
  <div>
    <h1 style="font-size:1.1rem;">This link is invalid or has expired</h1>
    <p style="color:#6b7280;font-size:0.9rem;">Ask for a new invite/reset link.</p>
  </div>
</body>
</html>`;
}

module.exports = {
  SESSION_COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  cleanupExpiredSessions,
  invalidateUserSessions,
  createPasswordSetToken,
  peekPasswordSetToken,
  consumePasswordSetToken,
  cleanupExpiredPasswordSetTokens,
  inviteUser,
  createResetLinkForEmail,
  getUserForToken,
  cookieOptions,
  requireAuth,
  requireAdmin,
  checkLoginRateLimit,
  recordFailedLogin,
  clearLoginRateLimit,
  loginPageHtml,
  setPasswordPageHtml,
  invalidLinkPageHtml,
};
