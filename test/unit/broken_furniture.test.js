const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

const stdCook = { dex: 5, int: 5, str: 5, spd: 5, cha: 5, abilities: [], tired: false, status: null, effStat(n){ return this[n]; } };

test('broken stove takes twice as long to cook', () => {
  const ctx = loadSim({ seed: 1 });
  const healthy = new ctx.Stove();
  const broken  = new ctx.Stove();
  broken.broken = true;

  const o1 = Object.assign(new ctx.Order({}, 'PIZZA'), { cookingEmployee: stdCook });
  const o2 = Object.assign(new ctx.Order({}, 'PIZZA'), { cookingEmployee: stdCook });
  healthy.startCooking(o1, { todayProfile: {} });
  broken.startCooking(o2,  { todayProfile: {} });
  assert.ok(Math.abs(broken.cooking.total / healthy.cooking.total - 2) < 1e-9,
    `broken stove should take 2× the cook time, got ratio ${broken.cooking.total / healthy.cooking.total}`);
});

test('broken catapult stove ALSO doubles on top of the 2.5× catapult mult', () => {
  const ctx = loadSim({ seed: 1 });
  const regular = new ctx.Stove();
  const catapult = new ctx.CatapultStove();
  const brokenCatapult = new ctx.CatapultStove();
  brokenCatapult.broken = true;
  const mkO = () => Object.assign(new ctx.Order({}, 'BURGER'), { cookingEmployee: stdCook });
  regular.startCooking(mkO(), { todayProfile: {} });
  catapult.startCooking(mkO(), { todayProfile: {} });
  brokenCatapult.startCooking(mkO(), { todayProfile: {} });
  // Catapult is 2.5× regular; broken catapult is 5× regular.
  assert.ok(Math.abs(brokenCatapult.cooking.total / regular.cooking.total - 5) < 1e-6,
    `broken catapult should be 5× regular, got ${brokenCatapult.cooking.total / regular.cooking.total}`);
});

test('broken sink takes 4 seconds (2× the default 2s)', () => {
  const ctx = loadSim();
  const sink = new ctx.Sink();
  sink.broken = true;
  sink.startWashing();
  assert.equal(sink.washing.total, 4);
  // Tick 3.5s — still washing.
  for (let i = 0; i < 35; i++) sink.update(0.1);
  assert.equal(sink.isWashing(), true);
  // Tick another 1s — done.
  for (let i = 0; i < 10; i++) sink.update(0.1);
  assert.equal(sink.isWashing(), false);
});

test('sim.breakRandomBuilding flips one non-broken building and emits popup', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const before = sim.buildings.filter(b => !b.broken).length;
  assert.ok(before > 0, 'demo should have at least one healthy building');
  const broken = sim.breakRandomBuilding();
  assert.ok(broken, 'should return the broken building');
  assert.equal(broken.broken, true);
  assert.equal(sim.buildings.filter(b => b.broken).length, 1);
});

test('sim.breakRandomBuilding(type) respects the type filter', () => {
  const ctx = loadSim({ seed: 2 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const result = sim.breakRandomBuilding('stove');
  assert.ok(result, 'should find a stove to break');
  assert.equal(result.type, 'stove');
});

test('sim.repairBuilding deducts half the purchase price and clears broken flag', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  // Find the stove starter and break it.
  const stove = sim.buildings.find(b => b.type === 'stove');
  stove.broken = true;
  sim.money = 1000;
  const res = sim.repairBuilding(stove.x, stove.y);
  assert.equal(res.ok, true);
  // Stove purchase price is $150; half = $75.
  assert.equal(res.cost, 75);
  assert.equal(sim.money, 1000 - 75);
  assert.equal(stove.broken, false);
});

test('sim.repairBuilding fails when not broken', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const stove = sim.buildings.find(b => b.type === 'stove');
  const res = sim.repairBuilding(stove.x, stove.y);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-broken');
});

test('sim.repairBuilding fails when broke', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const stove = sim.buildings.find(b => b.type === 'stove');
  stove.broken = true;
  sim.money = 10;       // can't afford $75
  const res = sim.repairBuilding(stove.x, stove.y);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-money');
  assert.equal(stove.broken, true, 'flag stays set on failed repair');
});

test('save/load round-trips the broken flag', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const stove = sim.buildings.find(b => b.type === 'stove');
  stove.broken = true;
  sim.dayState = 'dayEnd';

  const json = ctx.serializeSim(sim, null);
  const { sim: loaded } = ctx.deserializeSim(json);
  const loadedStove = loaded.buildings.find(b => b.type === 'stove' && b.x === stove.x && b.y === stove.y);
  assert.ok(loadedStove);
  assert.equal(loadedStove.broken, true);
});

test('RepairApp.isValidAt only validates broken-building tiles', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const stove = sim.buildings.find(b => b.type === 'stove');
  const repair = new ctx.RepairApp();
  // Healthy stove: not valid.
  assert.equal(repair.isValidAt(sim, stove.x, stove.y), false);
  // Break it: now valid.
  stove.broken = true;
  assert.equal(repair.isValidAt(sim, stove.x, stove.y), true);
  // Off-grid: false.
  assert.equal(repair.isValidAt(sim, -1, -1), false);
});

test('broken table doubles the customer eat duration', () => {
  const ctx = loadSim({ seed: 7 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const table = sim.buildings.find(b => b.type === 'table');
  table.broken = true;
  const c = new ctx.Customer(0, 0, 0);
  c.table = table;
  c.foodPref = 'BURGER';
  c.state = ctx.CS.WAITING;
  table.plate = { foodType: 'BURGER', dirty: false, quality: 1 };
  // Drive one update tick — should transition to EATING and stamp 2× eat timer.
  c.update(0.01, sim);
  assert.equal(c.state, ctx.CS.EATING);
  assert.equal(c.eatTimer, ctx.CONFIG.eatDuration * 2);
});
