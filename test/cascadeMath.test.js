const assert = require('assert');
const {
  computeLevels,
  computeSellTarget,
  selectNextLevel,
  normalizeManualLevels,
  simulateCascadeBacktest,
} = require('../src/cascadeMath');

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

test('computeLevels: prices step down, amounts step up, take-profit ladders up', () => {
  const levels = computeLevels({
    base_price: 0.0722,
    base_amount_usdt: 10,
    price_step_pct: 0.5,
    amount_step_pct: 20,
    num_levels: 4,
    take_profit_base_pct: 5,
    take_profit_step_pct: 1,
  });

  assert.strictEqual(levels.length, 4);

  assert.ok(Math.abs(levels[0].target_price - 0.0722) < 1e-9);
  assert.ok(Math.abs(levels[1].target_price - 0.0722 * 0.995) < 1e-9);
  assert.ok(Math.abs(levels[2].target_price - 0.0722 * 0.995 ** 2) < 1e-9);
  assert.ok(levels[3].target_price < levels[2].target_price);

  assert.ok(Math.abs(levels[0].amount_usdt - 10) < 1e-9);
  assert.ok(Math.abs(levels[1].amount_usdt - 12) < 1e-9);
  assert.ok(Math.abs(levels[2].amount_usdt - 14.4) < 1e-9);

  assert.strictEqual(levels[0].take_profit_pct, 5);
  assert.strictEqual(levels[1].take_profit_pct, 6);
  assert.strictEqual(levels[2].take_profit_pct, 7);
  assert.strictEqual(levels[3].take_profit_pct, 8);
});

test('computeLevels: rejects invalid input', () => {
  assert.throws(() => computeLevels({ base_price: 0, base_amount_usdt: 10, price_step_pct: 1, amount_step_pct: 1, num_levels: 1, take_profit_base_pct: 1, take_profit_step_pct: 1 }));
  assert.throws(() => computeLevels({ base_price: 1, base_amount_usdt: 10, price_step_pct: 1, amount_step_pct: 1, num_levels: 0, take_profit_base_pct: 1, take_profit_step_pct: 1 }));
});

test('computeSellTarget: applies profit pct to fill price', () => {
  assert.ok(Math.abs(computeSellTarget(0.0722, 5) - 0.075810) < 1e-6);
  assert.ok(Math.abs(computeSellTarget(0.1, 10) - 0.11) < 1e-9);
});

test('selectNextLevel: places level that would rest (target below market)', () => {
  const pending = [
    { level_index: 1, target_price: 0.0722, status: 'pending' },
    { level_index: 2, target_price: 0.0718, status: 'pending' },
    { level_index: 3, target_price: 0.0714, status: 'pending' },
  ];
  // market is above level 1's target -> level 1 would rest normally
  const { toPlace, toSkip } = selectNextLevel(pending, 0.073);
  assert.strictEqual(toPlace.level_index, 1);
  assert.strictEqual(toSkip.length, 0);
});

test('selectNextLevel: skips levels the market already crashed past', () => {
  const pending = [
    { level_index: 2, target_price: 0.0718, status: 'pending' },
    { level_index: 3, target_price: 0.0714, status: 'pending' },
    { level_index: 4, target_price: 0.0710, status: 'pending' },
  ];
  // market crashed to 0.0712 - level 2 (0.0718) and level 3 (0.0714) would instant-fill,
  // level 4 (0.0710) is still below market so it will actually rest.
  const { toPlace, toSkip } = selectNextLevel(pending, 0.0712);
  assert.strictEqual(toPlace.level_index, 4);
  assert.deepStrictEqual(toSkip.map((l) => l.level_index), [2, 3]);
});

test('selectNextLevel: places the last level anyway even if it would instant-fill', () => {
  const pending = [{ level_index: 5, target_price: 0.0705, status: 'pending' }];
  // market crashed even below the deepest level - place it anyway rather than
  // leaving that tranche of capital permanently undeployed.
  const { toPlace, toSkip } = selectNextLevel(pending, 0.07);
  assert.strictEqual(toPlace.level_index, 5);
  assert.strictEqual(toSkip.length, 0);
});

test('selectNextLevel: no pending levels returns null', () => {
  const { toPlace, toSkip } = selectNextLevel([], 0.07);
  assert.strictEqual(toPlace, null);
  assert.strictEqual(toSkip.length, 0);
});

test('normalizeManualLevels: converts raw levels and computes take_profit_pct', () => {
  const levels = normalizeManualLevels([
    { target_price: 0.0945, amount_usdt: 1, sell_price: 0.098 },
    { target_price: 0.089, amount_usdt: 1.5, sell_price: 0.0925 },
  ]);
  assert.strictEqual(levels.length, 2);
  assert.strictEqual(levels[0].level_index, 1);
  assert.strictEqual(levels[1].level_index, 2);
  assert.ok(Math.abs(levels[0].take_profit_pct - (0.098 / 0.0945 - 1) * 100) < 1e-9);
});

test('normalizeManualLevels: rejects sell price not higher than buy price', () => {
  assert.throws(() => normalizeManualLevels([{ target_price: 0.09, amount_usdt: 1, sell_price: 0.08 }]));
});

test('normalizeManualLevels: rejects non-positive values', () => {
  assert.throws(() => normalizeManualLevels([{ target_price: 0, amount_usdt: 1, sell_price: 0.1 }]));
  assert.throws(() => normalizeManualLevels([]));
});

test('simulateCascadeBacktest: normal step-through fills both levels and their sells', () => {
  const levels = [
    { level_index: 1, target_price: 100, amount_usdt: 10, take_profit_pct: 5 },
    { level_index: 2, target_price: 90, amount_usdt: 10, take_profit_pct: 5 },
  ];
  const candles = [
    { time: 0, open: 110, high: 110, low: 110, close: 108 },
    { time: 1, open: 108, high: 109, low: 99, close: 100 },
    { time: 2, open: 100, high: 104, low: 98, close: 101 },
    { time: 3, open: 101, high: 106, low: 100, close: 105 },
    { time: 4, open: 105, high: 105, low: 89, close: 95 },
    { time: 5, open: 95, high: 96, low: 91, close: 93 },
  ];

  const result = simulateCascadeBacktest({ levels, candles });
  assert.strictEqual(result.armed, true);
  assert.strictEqual(result.armedAt.price, 110); // first candle's open, no triggerPrice

  const [l1, l2] = result.levels;
  assert.strictEqual(l1.status, 'filled');
  assert.strictEqual(l1.fill_price, 100);
  assert.strictEqual(l1.fill_time, 1);
  assert.strictEqual(l1.sell_status, 'filled');
  assert.strictEqual(l1.sell_price, 105);
  assert.strictEqual(l1.sell_time, 3);

  assert.strictEqual(l2.status, 'filled');
  assert.strictEqual(l2.fill_price, 90);
  assert.strictEqual(l2.fill_time, 4);
  assert.strictEqual(l2.sell_status, 'filled');
  assert.strictEqual(l2.sell_price, 94.5);
  assert.strictEqual(l2.sell_time, 5);

  assert.strictEqual(result.summary.fillsCount, 2);
  assert.strictEqual(result.summary.skipsCount, 0);
  assert.strictEqual(result.summary.totalInvestedUsdt, 20);
  assert.ok(result.summary.realizedPnlUsdt > 0);
});

test('simulateCascadeBacktest: a fast-crash candle skips levels ahead using its low, not just target_price', () => {
  const levels = [
    { level_index: 1, target_price: 100, amount_usdt: 10, take_profit_pct: 5 },
    { level_index: 2, target_price: 95, amount_usdt: 10, take_profit_pct: 5 },
    { level_index: 3, target_price: 90, amount_usdt: 10, take_profit_pct: 5 },
  ];
  const candles = [
    { time: 0, open: 101, high: 101, low: 101, close: 101 },
    { time: 1, open: 101, high: 101, low: 80, close: 85 }, // crashes through L1, L2, and L3's targets in one candle
    { time: 2, open: 85, high: 90, low: 85, close: 88 },
    { time: 3, open: 88, high: 106, low: 87, close: 100 },
  ];

  const result = simulateCascadeBacktest({ levels, candles });
  const [l1, l2, l3] = result.levels;

  assert.strictEqual(l1.status, 'filled');
  assert.strictEqual(l1.fill_price, 100);
  assert.strictEqual(l1.fill_time, 1);

  // L2 must be skipped: after L1's fill, the decision price is candle 1's
  // low (80), which is already below L2's target (95) - this is exactly
  // what would break if the decision price were L1's fill/target_price
  // instead (100), since 95 < 100 would always look like a normal rest.
  assert.strictEqual(l2.status, 'skipped');
  assert.strictEqual(l2.skip_reason, 'market_price_already_below_target');

  // L3 is forced (last remaining) even though it would also instant-fill,
  // but it does NOT fill on the same candle as L1 (candle 1) despite that
  // candle's low (80) already crossing its target (90) too - it waits for
  // the next candle (one-fill-per-candle granularity).
  assert.strictEqual(l3.status, 'filled');
  assert.strictEqual(l3.fill_price, 90);
  assert.strictEqual(l3.fill_time, 2);

  assert.strictEqual(result.summary.fillsCount, 2);
  assert.strictEqual(result.summary.skipsCount, 1);
});

test('simulateCascadeBacktest: same-candle buy+sell is deferred, not filled immediately', () => {
  const levels = [{ level_index: 1, target_price: 100, amount_usdt: 10, take_profit_pct: 5 }];
  const candles = [
    { time: 0, open: 102, high: 102, low: 102, close: 102 },
    // Buy fills here (low <= 100) AND this same candle's high (106) already
    // reaches the sell target (105) - the sell must NOT be recorded as
    // filled on this candle.
    { time: 1, open: 100, high: 106, low: 95, close: 101 },
    { time: 2, open: 101, high: 101, low: 99, close: 100 }, // never reaches 105 afterward
  ];

  const result = simulateCascadeBacktest({ levels, candles });
  const [l1] = result.levels;
  assert.strictEqual(l1.status, 'filled');
  assert.strictEqual(l1.fill_time, 1);
  assert.strictEqual(l1.sell_status, 'none'); // would be 'filled' at time 1 if same-candle fills were allowed
});

test('simulateCascadeBacktest: still open at window end is marked-to-market, not realized', () => {
  const levels = [{ level_index: 1, target_price: 100, amount_usdt: 10, take_profit_pct: 5 }];
  const candles = [
    { time: 0, open: 101, high: 101, low: 101, close: 101 },
    { time: 1, open: 101, high: 102, low: 99, close: 100 },
    { time: 2, open: 100, high: 103, low: 99, close: 101 }, // never reaches sell target (105)
  ];

  const result = simulateCascadeBacktest({ levels, candles });
  const [l1] = result.levels;
  assert.strictEqual(l1.status, 'filled');
  assert.strictEqual(l1.sell_status, 'none');
  assert.strictEqual(result.summary.realizedPnlUsdt, 0);
  assert.ok(result.summary.unrealizedPnlUsdt > 0);
  assert.strictEqual(result.summary.outcome, 'completed');
});

test('simulateCascadeBacktest: trigger price never reached in the window', () => {
  const levels = [{ level_index: 1, target_price: 100, amount_usdt: 10, take_profit_pct: 5 }];
  const candles = [
    { time: 0, open: 200, high: 205, low: 195, close: 198 },
    { time: 1, open: 198, high: 200, low: 190, close: 195 },
  ];

  const result = simulateCascadeBacktest({ levels, candles, triggerPrice: 50 });
  assert.strictEqual(result.armed, false);
  assert.strictEqual(result.armedAt, null);
  assert.strictEqual(result.summary.outcome, 'never_armed');
  assert.strictEqual(result.levels[0].status, 'pending');
});

test('simulateCascadeBacktest: fee math matches Gate.io convention (fees reduce what you receive)', () => {
  const levels = [{ level_index: 1, target_price: 100, amount_usdt: 100, take_profit_pct: 10 }];
  const sellTarget = computeSellTarget(100, 10); // 100 * 1.1, not exactly 110 in floating point
  const candles = [
    { time: 0, open: 100, high: 100, low: 100, close: 100 },
    { time: 1, open: 100, high: 110.5, low: 100, close: 105 },
  ];

  const result = simulateCascadeBacktest({ levels, candles, feePct: 1 });
  const [l1] = result.levels;
  assert.strictEqual(l1.fill_price, 100);
  assert.strictEqual(l1.sell_price, sellTarget);

  const expectedQty = (100 / 100) * (1 - 1 / 100);
  const expectedProceeds = expectedQty * sellTarget * (1 - 1 / 100);
  const expectedPnl = expectedProceeds - 100;
  assert.ok(Math.abs(l1.pnl_usdt - expectedPnl) < 1e-9);
  assert.ok(Math.abs(result.summary.realizedPnlUsdt - expectedPnl) < 1e-9);
  assert.ok(Math.abs(result.summary.roiPct - (expectedPnl / 100) * 100) < 1e-9);
});

test('simulateCascadeBacktest: no candle data returns no_data outcome', () => {
  const levels = [{ level_index: 1, target_price: 100, amount_usdt: 10, take_profit_pct: 5 }];
  const result = simulateCascadeBacktest({ levels, candles: [] });
  assert.strictEqual(result.armed, false);
  assert.strictEqual(result.summary.outcome, 'no_data');
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error('Some tests failed.');
}
