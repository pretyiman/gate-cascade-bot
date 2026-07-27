const assert = require('assert');
const { computeLevels, computeSellTarget, selectNextLevel } = require('../src/cascadeMath');

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

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error('Some tests failed.');
}
