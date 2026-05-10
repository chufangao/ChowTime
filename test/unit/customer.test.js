const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('customer anger maxes out then triggers angry leave', () => {
  const ctx = loadSim({ seed: 1 });
  // Bare-bones sim with no chairs — customer enters, queues, never seats,
  // and rage-quits.
  const sim = new ctx.Simulation();
  sim.spawnEnabled = false;          // we'll spawn manually below
  sim.spawnCustomer();
  const c = sim.customers[0];
  // Tick fast enough to push past angerMax. Default seekingSeat rate is 2.5/s.
  // Push it to max with a single huge dt so internal min/max guards trigger.
  c.anger = ctx.CONFIG.angerMax - 1;
  sim.update(1.0);
  assert.equal(c.state, 'leaving');
  assert.equal(c.leftReason, 'angry');
  assert.equal(sim.lives, 2, 'angry rage-quit costs one life');
});

test('lives clamp to 0 and trigger gameOver', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.spawnEnabled = false;
  for (let i = 0; i < 3; i++) {
    sim.spawnCustomer();
    const c = sim.customers[sim.customers.length - 1];
    c.anger = ctx.CONFIG.angerMax;
    sim.update(0.1);
  }
  assert.equal(sim.lives, 0);
  assert.equal(sim.gameOver, true);
  assert.equal(sim.spawnEnabled, false);
});

test('customer abilities default to empty when constructor used directly', () => {
  const ctx = loadSim({ seed: 1 });
  const c = new ctx.Customer(0, 0, 0);
  // c.abilities is an Array from the vm context — its prototype is not the
  // host's Array.prototype, so deepEqual([]) trips ERR_ASSERTION. Length
  // check is the right level of comparison here.
  assert.equal(c.abilities.length, 0);
  assert.equal(c.ordersRemaining, 1);
});

test('Customer.foodPref is one of the menu keys', () => {
  const ctx = loadSim({ seed: 7 });
  for (let i = 0; i < 20; i++) {
    const c = new ctx.Customer(0, 0, 0);
    assert.ok(ctx.FOOD_KEYS.includes(c.foodPref), `unknown foodPref ${c.foodPref}`);
  }
});

test('Customer state machine starts in ENTERING', () => {
  const ctx = loadSim({ seed: 1 });
  const c = new ctx.Customer(0, 0, 0);
  assert.equal(c.state, ctx.CS.ENTERING);
});
