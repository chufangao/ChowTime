/* ============================================================================
 * test/unit/chef_spawn.test.js — Chef spawn points + chef assignment
 * ============================================================================
 * Covers the data-model side of the feature (the UI apps are exercised
 * separately): placement, day-start repositioning, save/load persistence, and
 * assignment cleanup when a pad is removed or moved.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

// Drive startNextDay from a clean dayEnd with no event side effects.
function startDay(sim) {
  sim.dayState     = 'dayEnd';
  sim.currentEvent = null;
  sim.nextForecast = null;
  sim.eventOutcome = { passed: true, roll: 0, total: 0, dc: 0, chef: null, result: null, msg: '' };
  sim.startNextDay();
}

test('chef_spawn is a placeable, walkable building', () => {
  const ctx = loadSim();
  const sim = new ctx.Simulation();
  const res = sim.placeBuilding('chef_spawn', 5, 5, true);
  assert.equal(res.ok, true);
  const t = sim.grid.getTile(5, 5);
  assert.equal(t.building.type, 'chef_spawn');
  assert.equal(t.building.walkable, true);
  // Walkable buildings don't block pathfinding.
  assert.equal(sim.grid.isWalkable(5, 5), true);
});

test('assigned chefs start the day at their pad; unassigned chefs stay put', () => {
  const ctx = loadSim();
  const sim = new ctx.Simulation();
  sim.placeBuilding('chef_spawn', 5, 5, true);
  sim.hireEmployee(true);   // assigned chef
  sim.hireEmployee(true);   // unassigned chef
  const [assigned, free] = sim.employees;
  assigned.spawnPoint = { x: 5, y: 5 };

  // Simulate end-of-day positions somewhere on the floor.
  assigned.x = 8; assigned.y = 8;
  free.x = 9;     free.y = 9;

  startDay(sim);

  assert.deepEqual({ x: assigned.x, y: assigned.y }, { x: 5, y: 5 }, 'assigned chef snaps to pad');
  assert.deepEqual({ x: free.x, y: free.y }, { x: 9, y: 9 }, 'unassigned chef is left in place');
  assert.equal(assigned.state, ctx.ES.IDLE);
  assert.equal(assigned.path, null);
});

test('a chef whose pad was removed reverts to the default door', () => {
  const ctx = loadSim();
  const sim = new ctx.Simulation();
  sim.placeBuilding('chef_spawn', 5, 5, true);
  sim.hireEmployee(true);
  const chef = sim.employees[0];
  chef.spawnPoint = { x: 5, y: 5 };

  // Removing the pad clears the assignment...
  sim.removeBuildingAt(5, 5);
  assert.equal(chef.spawnPoint, null);

  // ...so the next day start leaves it where it is (now unassigned).
  chef.x = 7; chef.y = 7;
  startDay(sim);
  assert.deepEqual({ x: chef.x, y: chef.y }, { x: 7, y: 7 });
});

test('moving a pad carries chef assignments with it', () => {
  const ctx = loadSim();
  const sim = new ctx.Simulation();
  sim.debug = true;     // free moves
  sim.placeBuilding('chef_spawn', 5, 5, true);
  sim.hireEmployee(true);
  const chef = sim.employees[0];
  chef.spawnPoint = { x: 5, y: 5 };

  const res = sim.moveBuilding(5, 5, 6, 6);
  assert.equal(res.ok, true);
  assert.equal(chef.spawnPoint.x, 6);
  assert.equal(chef.spawnPoint.y, 6);

  chef.x = 1; chef.y = 1;
  startDay(sim);
  assert.deepEqual({ x: chef.x, y: chef.y }, { x: 6, y: 6 });
});

test('chefSpawnTileFor falls back to the primary door for unassigned chefs', () => {
  const ctx = loadSim();
  const sim = new ctx.Simulation();
  sim.hireEmployee(true);
  const chef = sim.employees[0];
  assert.deepEqual(sim.chefSpawnTileFor(chef), sim.spawnTiles[0]);
  // A dangling assignment (no pad at the coord) also falls back.
  chef.spawnPoint = { x: 5, y: 5 };
  assert.deepEqual(sim.chefSpawnTileFor(chef), sim.spawnTiles[0]);
});

test('pads are numbered top-left to bottom-right, consistently for map + menu', () => {
  const ctx = loadSim();
  const sim = new ctx.Simulation();
  // Place out of display order; labels should follow (y, x) sort.
  sim.placeBuilding('chef_spawn', 7, 7, true);   // should be #2
  sim.placeBuilding('chef_spawn', 2, 3, true);   // should be #1
  assert.equal(sim.chefSpawnLabelAt(2, 3), 1);
  assert.equal(sim.chefSpawnLabelAt(7, 7), 2);
  assert.equal(sim.chefSpawnLabelAt(9, 9), null);
  assert.equal(sim.chefSpawnPads().length, 2);
});

test('spawnPoint and chef_spawn buildings survive a save/load round-trip', () => {
  const ctx = loadSim();
  const sim = new ctx.Simulation();
  sim.dayState = 'dayEnd';      // saves are gated to dayEnd
  sim.placeBuilding('chef_spawn', 5, 5, true);
  sim.hireEmployee(true);
  sim.employees[0].spawnPoint = { x: 5, y: 5 };

  const blob = JSON.parse(JSON.stringify(ctx.serializeSim(sim, null)));
  const { sim: sim2 } = ctx.deserializeSim(blob);

  const pad = sim2.buildings.find(b => b.type === 'chef_spawn');
  assert.ok(pad, 'chef_spawn building restored');
  assert.equal(pad.walkable, true);
  assert.equal(sim2.employees[0].spawnPoint.x, 5);
  assert.equal(sim2.employees[0].spawnPoint.y, 5);
});
