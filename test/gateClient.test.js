const assert = require('assert');
const { parseCandlestick, INTERVAL_SECONDS } = require('../src/gateClient');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('parseCandlestick: field order matches a real captured Gate.io response', () => {
  // Captured live from GET /api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1h&limit=2
  const raw = ['1785214800', '14474763.07019200', '63454.4', '63619.3', '63323.4', '63345.6', '227.95474100', 'true'];
  const candle = parseCandlestick(raw);
  assert.strictEqual(candle.time, 1785214800);
  assert.strictEqual(candle.close, 63454.4);
  assert.strictEqual(candle.high, 63619.3);
  assert.strictEqual(candle.low, 63323.4);
  assert.strictEqual(candle.open, 63345.6);
});

test('INTERVAL_SECONDS: whitelist maps to correct second counts', () => {
  assert.strictEqual(INTERVAL_SECONDS['1m'], 60);
  assert.strictEqual(INTERVAL_SECONDS['5m'], 300);
  assert.strictEqual(INTERVAL_SECONDS['15m'], 900);
  assert.strictEqual(INTERVAL_SECONDS['1h'], 3600);
  assert.strictEqual(INTERVAL_SECONDS['4h'], 14400);
  assert.strictEqual(INTERVAL_SECONDS['1d'], 86400);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error('Some tests failed.');
}
