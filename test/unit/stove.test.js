const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

function fakeOrder(ctx, foodType, cookOverrides = {}) {
  const cook = Object.assign({
    dex: 5, int: 5, str: 5, spd: 5, cha: 5,
    abilities: [],
    tired: false,
    status: null,
    effStat(name) { return this[name]; },
  }, cookOverrides);
  return new ctx.Order({ foodPref: foodType }, foodType).constructor === ctx.Order
    ? Object.assign(new ctx.Order({}, foodType), { cookingEmployee: cook })
    : null;
}

test('Stove cookTime scales down with chef DEX', () => {
  const ctx = loadSim({ seed: 1 });
  const slow = new ctx.Stove();
  const fast = new ctx.Stove();

  const slowOrder = Object.assign(new ctx.Order({}, 'BURGER'), {
    cookingEmployee: { dex: 1, int: 5, str: 5, spd: 5, cha: 5, abilities: [], tired: false, status: null, effStat(n){ return this[n]; } },
  });
  const fastOrder = Object.assign(new ctx.Order({}, 'BURGER'), {
    cookingEmployee: { dex: 10, int: 5, str: 5, spd: 5, cha: 5, abilities: [], tired: false, status: null, effStat(n){ return this[n]; } },
  });

  slow.startCooking(slowOrder, { todayProfile: {} });
  fast.startCooking(fastOrder, { todayProfile: {} });
  assert.ok(fast.cooking.total < slow.cooking.total,
    `dex=10 cook time ${fast.cooking.total} should be less than dex=1 cook time ${slow.cooking.total}`);
});

test('Stove cookTime obeys ability cookTimeMult (knife_skills on burger)', () => {
  const ctx = loadSim({ seed: 1 });
  const baseStove = new ctx.Stove();
  const skilledStove = new ctx.Stove();

  const mkOrder = (abs) => Object.assign(new ctx.Order({}, 'BURGER'), {
    cookingEmployee: { dex: 5, int: 5, str: 5, spd: 5, cha: 5, abilities: abs, tired: false, status: null, effStat(n){ return this[n]; } },
  });

  baseStove.startCooking(mkOrder([]), { todayProfile: {} });
  skilledStove.startCooking(mkOrder(['knife_skills']), { todayProfile: {} });
  // knife_skills gives 0.65 for BURGER
  assert.ok(Math.abs(skilledStove.cooking.total / baseStove.cooking.total - 0.65) < 1e-9);
});

test('Stove tick produces a ready order with stamped quality', () => {
  const ctx = loadSim({ seed: 1 });
  const stove = new ctx.Stove();
  const order = Object.assign(new ctx.Order({}, 'SALAD'), {
    cookingEmployee: { dex: 10, int: 10, str: 5, spd: 5, cha: 5, abilities: [], tired: false, status: null, effStat(n){ return this[n]; } },
  });
  stove.startCooking(order, { todayProfile: {} });
  // Tick generously past total cookTime.
  for (let i = 0; i < 200; i++) stove.update(0.1);
  assert.equal(order.status, 'ready');
  assert.equal(order.readyStove, stove);
  assert.ok(typeof order.quality === 'number');
  assert.ok(order.quality > 0);
  assert.equal(stove.cooking, null);
});

test('Stove respects todayProfile.cookTimeMult (e.g., brownout event)', () => {
  const ctx = loadSim({ seed: 1 });
  const baseStove = new ctx.Stove();
  const slowStove = new ctx.Stove();
  const cook = { dex: 5, int: 5, str: 5, spd: 5, cha: 5, abilities: [], tired: false, status: null, effStat(n){ return this[n]; } };
  const o1 = Object.assign(new ctx.Order({}, 'PIZZA'), { cookingEmployee: cook });
  const o2 = Object.assign(new ctx.Order({}, 'PIZZA'), { cookingEmployee: cook });
  baseStove.startCooking(o1, { todayProfile: {} });
  slowStove.startCooking(o2, { todayProfile: { cookTimeMult: 1.4 } });
  assert.ok(Math.abs(slowStove.cooking.total / baseStove.cooking.total - 1.4) < 1e-9);
});

test('Sink finishes washing after 2s', () => {
  const ctx = loadSim();
  const sink = new ctx.Sink();
  sink.startWashing();
  assert.equal(sink.isWashing(), true);
  for (let i = 0; i < 30; i++) sink.update(0.1);   // 3s
  assert.equal(sink.isWashing(), false);
});

test('computeQuality stays within [0, 2] across the full INT range', () => {
  const ctx = loadSim({ seed: 1 });
  for (let i = 0; i < 200; i++) {
    for (let intStat = 0; intStat <= 10; intStat += 1) {
      const q = ctx.computeQuality(intStat);
      assert.ok(q >= 0 && q <= 2, `quality ${q} out of [0,2] for INT ${intStat}`);
    }
  }
});
