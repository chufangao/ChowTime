const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

function makeCustomer(ctx, overrides = {}) {
  // Hand-build a minimal customer-shaped object — computeTip only reads the
  // fields below, so we don't need to spawn through the sim.
  return Object.assign({
    foodPref: 'BURGER',
    table: { plate: { quality: 1.0 } },
    deliveredBy: null,
    seatedAt: 0,
    deliveredAt: 4,        // 4s wait → waitFac = 1.0 (no penalty)
    abilities: [],
  }, overrides);
}

function fakeChef(stat, abilities = [], status = null) {
  return {
    effStat(name) { return name === 'cha' ? stat : 5; },
    abilities,
    status,
  };
}

test('tip is 0 when quality is 0', () => {
  const ctx = loadSim({ seed: 1 });
  const c = makeCustomer(ctx, { table: { plate: { quality: 0 } } });
  assert.equal(ctx.computeTip(c), 0);
});

test('tip rises with chef CHA', () => {
  const ctx = loadSim({ seed: 1 });
  const lo = ctx.computeTip(makeCustomer(ctx, { deliveredBy: fakeChef(1) }));
  const hi = ctx.computeTip(makeCustomer(ctx, { deliveredBy: fakeChef(10) }));
  assert.ok(hi > lo, `expected high-CHA tip ${hi} > low-CHA tip ${lo}`);
});

test('big_tipper customer ability doubles tip', () => {
  const ctx = loadSim({ seed: 1 });
  const baseCtx = loadSim({ seed: 1 });
  const baseTip = baseCtx.computeTip(makeCustomer(baseCtx, { deliveredBy: fakeChef(5) }));
  const bigTip = ctx.computeTip(makeCustomer(ctx, {
    deliveredBy: fakeChef(5),
    abilities: ['big_tipper'],
  }));
  assert.equal(bigTip, baseTip * 2);
});

test('long wait reduces tip via waitFac', () => {
  const ctx = loadSim({ seed: 1 });
  const fast = ctx.computeTip(makeCustomer(ctx, {
    deliveredBy: fakeChef(5), seatedAt: 0, deliveredAt: 4,
  }));
  const slowCtx = loadSim({ seed: 1 });
  const slow = slowCtx.computeTip(makeCustomer(slowCtx, {
    deliveredBy: fakeChef(5), seatedAt: 0, deliveredAt: 24,   // waitFac → 0
  }));
  assert.equal(slow, 0);
  assert.ok(fast > 0);
});

test('starstruck chef adds 25% tip multiplier', () => {
  const a = loadSim({ seed: 1 });
  const baseline = a.computeTip(makeCustomer(a, {
    deliveredBy: fakeChef(5),
  }));
  const b = loadSim({ seed: 1 });
  const boosted = b.computeTip(makeCustomer(b, {
    deliveredBy: fakeChef(5, [], { kind: 'starstruck' }),
  }));
  // 25% bonus is applied after rounding, then re-rounded
  assert.equal(boosted, Math.round(baseline * 1.25));
});

test('chef showstopper ability stacks with customer big_tipper', () => {
  const ctx = loadSim({ seed: 1 });
  const baseCtx = loadSim({ seed: 1 });
  const base = baseCtx.computeTip(makeCustomer(baseCtx, { deliveredBy: fakeChef(5) }));
  const both = ctx.computeTip(makeCustomer(ctx, {
    deliveredBy: fakeChef(5, ['showstopper']),
    abilities: ['big_tipper'],
  }));
  // base * 1.4 (showstopper) * 2.0 (big_tipper) = base * 2.8
  // computeTip rounds the price*frac*noise step then multiplies by abilities
  // and rounds again, so we check approximate ratio instead of exact equality.
  const ratio = both / base;
  assert.ok(ratio > 2.6 && ratio < 3.0, `expected ratio ~2.8, got ${ratio}`);
});
