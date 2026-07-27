require('dotenv').config();

const { buildApp } = require('./api');
const { startScheduler } = require('./scheduler');
const gateClient = require('./gateClient');

const PORT = process.env.PORT || 3000;
const DEFAULT_POLL_INTERVAL_SECONDS = Number(process.env.DEFAULT_POLL_INTERVAL_SECONDS || 60);

if (gateClient.DRY_RUN) {
  console.log('Running in DRY_RUN mode - no real orders will be sent to Gate.io.');
} else {
  console.log('LIVE mode - orders WILL be sent to Gate.io with real funds. Make sure this is intended.');
}

const app = buildApp();
app.listen(PORT, () => {
  console.log(`gate-cascade-bot listening on port ${PORT}`);
});

startScheduler({ intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS });
