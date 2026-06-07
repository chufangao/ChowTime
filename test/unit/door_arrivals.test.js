/* ============================================================================
 * test/unit/door_arrivals.test.js — Per-door incoming-customer planning
 * ============================================================================
 * Each day, the day's quota of arrivals is randomly distributed across the
 * doors into sim.incomingByDoor (parallel to spawnTiles). spawnCustomer pulls
 * one arrival from that plan and decrements the door it spawns at, so the
 * on-map number for each door is exactly its remaining planned arrivals.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('planDoorArrivals distributes the full quota across doors (sum === dayQuota)', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }, { x: 5, y: 0 }];
  sim.dayQuota = 17;
  sim.planDoorArrivals();
  assert.equal(sim.incomingByDoor.length, 3);
  assert.equal(sum(sim.incomingByDoor), 17);
  for (const n of sim.incomingByDoor) {
    assert.ok(Number.isInteger(n) && n >= 0, `bad door count ${n}`);
  }
});

test('planDoorArrivals: a single door receives the whole quota', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }];
  sim.dayQuota = 9;
  sim.planDoorArrivals();
  assert.deepEqual(sim.incomingByDoor, [9]);
});

test('spawnCustomer decrements the plan by 1 and spawns at a planned door', () => {
  const ctx = loadSim({ seed: 2 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }];
  sim.dayQuota = 6;
  sim.planDoorArrivals();
  sim.dayState = 'spawning';
  const before = sum(sim.incomingByDoor);   // 6
  sim.spawnCustomer();
  assert.equal(sum(sim.incomingByDoor), before - 1);
  const c = sim.customers[sim.customers.length - 1];
  assert.ok(c.entryDoor, 'spawned customer missing entryDoor');
  assert.ok(sim.spawnTiles.some(d => d.x === c.entryDoor.x && d.y === c.entryDoor.y),
    `entryDoor (${c.entryDoor.x},${c.entryDoor.y}) not in spawnTiles`);
});

test('draining the whole plan zeroes every door', () => {
  const ctx = loadSim({ seed: 2 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }];
  sim.dayQuota = 5;
  sim.planDoorArrivals();
  sim.dayState = 'spawning';
  const total = sum(sim.incomingByDoor);    // 5
  for (let i = 0; i < total; i++) sim.spawnCustomer();
  assert.equal(sum(sim.incomingByDoor), 0);
  assert.equal(sim.customers.length, total);
});

test('per-door arrivals tally exactly matches the planned distribution', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }, { x: 5, y: 0 }];
  sim.dayQuota = 13;
  sim.planDoorArrivals();
  sim.dayState = 'spawning';
  const planned = sim.incomingByDoor.slice();
  const total = sum(planned);
  for (let i = 0; i < total; i++) sim.spawnCustomer();
  const tally = new Array(sim.spawnTiles.length).fill(0);
  for (const c of sim.customers) {
    const idx = sim.spawnTiles.findIndex(d => d.x === c.entryDoor.x && d.y === c.entryDoor.y);
    tally[idx]++;
  }
  assert.deepEqual(tally, planned);
});

test('spawnCustomer falls back to randomSpawn when there is no usable plan', () => {
  // Bare sim: incomingByDoor defaults to [0] (length 1) but spawnTiles is
  // length 2 — the length-mismatch guard makes _takeDoorFromPlan return null,
  // so spawnCustomer still spawns via randomSpawn (protects direct-call tests).
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }];
  sim.dayState = 'spawning';
  sim.spawnCustomer();
  assert.equal(sim.customers.length, 1);
  const c = sim.customers[0];
  assert.ok(c.entryDoor, 'spawned customer missing entryDoor');
  assert.ok(sim.spawnTiles.some(d => d.x === c.entryDoor.x && d.y === c.entryDoor.y),
    `entryDoor (${c.entryDoor.x},${c.entryDoor.y}) not in spawnTiles`);
});

test('startNextDay rebuilds incomingByDoor to match spawnTiles and dayQuota', () => {
  const ctx = loadSim({ seed: 4 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }, { x: 5, y: 0 }];
  // startNextDay only runs from dayEnd once the day-end event is resolved.
  sim.dayState = 'dayEnd';
  sim.eventOutcome = { result: null };
  sim.dayStateMachine.startNextDay();
  assert.equal(sim.dayState, 'spawning');
  assert.equal(sim.incomingByDoor.length, sim.spawnTiles.length);
  assert.equal(sum(sim.incomingByDoor), sim.dayQuota);
});
