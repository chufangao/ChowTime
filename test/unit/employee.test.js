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

test('findTask sends the chef to the NEAREST available stove (by path), not the first placed', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();            // bare 24x24: footprint is walkable floor
  // Far stove placed FIRST, near second — old "first available" logic would
  // have picked the far one, so this discriminates the nearest-selection fix.
  sim.placeBuilding('stove', 10, 0, true);     // far from a chef at (0,0)
  sim.placeBuilding('stove', 2, 0, true);      // near
  const chef = new ctx.Employee(0, 0, ctx.STARTER_CHEF);
  chef.x = 0; chef.y = 0; chef.state = ctx.ES.IDLE;

  const cust = new ctx.Customer(0, 0, 0); cust.alive = true; cust.table = { x: 3, y: 3 };
  const o = new ctx.Order(cust, 'BURGER'); o.status = 'pending'; o.cookingEmployee = null;
  sim.orders.push(o);

  chef.findTask(sim);
  assert.ok(chef.task && chef.task.stove, 'chef should claim a cooking task');
  assert.equal(chef.task.stove.x, 2, 'nearest stove (2,0) chosen over the first-placed (10,0)');
});

test('findTask picks the sink NEAREST the dirty table, not the first placed', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.placeBuilding('sink', 0, 11, true);      // far from the table, placed first
  sim.placeBuilding('sink', 6, 6, true);       // near the table
  sim.placeBuilding('table', 5, 5, true);
  const tbl = sim.grid.getTile(5, 5).building;
  tbl.plate = { dirty: true, foodType: 'BURGER' };
  tbl.cleaningAssigned = false; tbl.occupyingCustomer = null;

  const chef = new ctx.Employee(5, 4, ctx.STARTER_CHEF);
  chef.x = 5; chef.y = 4; chef.state = ctx.ES.IDLE;

  chef.findTask(sim);
  assert.ok(chef.task && chef.task.sink, 'chef should claim a cleaning task');
  assert.equal(chef.task.sink.x, 6, 'nearest sink (6,6) chosen over the first-placed (0,11)');
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
