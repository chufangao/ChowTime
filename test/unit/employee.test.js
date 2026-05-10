const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('starter Employee inherits 5/5/5/5/5 stats', () => {
  const ctx = loadSim();
  const e = new ctx.Employee(0, 0, ctx.STARTER_CHEF);
  assert.equal(e.dex, 5);
  assert.equal(e.cha, 5);
  assert.equal(e.staminaMax, 30 + 6 * 5);
  assert.equal(e.stamina, e.staminaMax);
  assert.equal(e.tired, false);
  assert.equal(e.isStarter, true);
});

test('effStat applies tired multiplier to non-STR stats', () => {
  const ctx = loadSim();
  const e = new ctx.Employee(0, 0, ctx.STARTER_CHEF);
  e.tired = true;
  assert.equal(e.effStat('str'), 5);                                // STR exempt
  assert.equal(e.effStat('cha'), 5 * ctx.CONFIG.tiredMult);
});

test('stressed status reduces INT by 2 (floored at 1)', () => {
  const ctx = loadSim();
  const e = new ctx.Employee(0, 0, ctx.STARTER_CHEF);
  e.status = { kind: 'stressed', daysLeft: 1 };
  assert.equal(e.effStat('int'), 5 - 2);
  // Floor: an INT 1 chef caps at 1, not -1
  e.int = 1;
  assert.equal(e.effStat('int'), 1);
});

test('busy chef is unavailable; starstruck still available', () => {
  const ctx = loadSim();
  const busy = new ctx.Employee(0, 0, ctx.STARTER_CHEF);
  busy.status = { kind: 'busy', daysLeft: 1 };
  assert.equal(busy.isAvailable(), false);

  const starstruck = new ctx.Employee(0, 0, ctx.STARTER_CHEF);
  starstruck.status = { kind: 'starstruck', daysLeft: 1 };
  assert.equal(starstruck.isAvailable(), true);
});

test('busy chef does not pick up tasks via findTask', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const chef = sim.employees[0];
  // Inject a pending order so findTask has something to grab.
  const fakeCustomer = new ctx.Customer(0, 0, 0);
  fakeCustomer.alive = true;
  fakeCustomer.table = { x: 3, y: 3 };
  const o = new ctx.Order(fakeCustomer, 'BURGER');
  sim.orders.push(o);

  chef.status = { kind: 'busy', daysLeft: 1 };
  chef.findTask(sim);
  assert.equal(chef.task, null, 'busy chef must not claim a task');
  assert.equal(chef.state, ctx.ES.IDLE);
});
