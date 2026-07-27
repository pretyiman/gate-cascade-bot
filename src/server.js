require('dotenv').config();

const { buildApp } = require('./api');
const { startScheduler } = require('./scheduler');
const { startReconciler } = require('./reconciler');
const { cleanupExpiredSessions, cleanupExpiredPasswordSetTokens } = require('./auth');

const PORT = process.env.PORT || 3000;
const DEFAULT_POLL_INTERVAL_SECONDS = Number(process.env.DEFAULT_POLL_INTERVAL_SECONDS || 30);

cleanupExpiredSessions();
cleanupExpiredPasswordSetTokens();

if (String(process.env.FORCE_DRY_RUN || 'false').toLowerCase() === 'true') {
  console.log('FORCE_DRY_RUN is on - every user is forced into dry-run regardless of their own setting.');
}

const app = buildApp();
app.listen(PORT, () => {
  console.log(`gate-cascade-bot listening on port ${PORT}`);
});

startScheduler({ intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS });
startReconciler();
