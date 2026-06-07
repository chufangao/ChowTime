/* ============================================================================
 * test/unit/multi_door.test.js — Multiple-door spawn/exit behavior
 * ============================================================================
 * Layouts may now have 1..5 perimeter doors. Customers spawn from a random
 * door and exit through whichever door is closest (Manhattan) to where they
 * leave from. This file pins down both behaviors via headless sim assertions.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('closestSpawn picks the nearest door by Manhattan distance', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  const maxY = ctx.ROWS - 1;
  sim.spawnTiles = [
    { x: 0, y: 0 },
    { x: 11, y: 0 },
    { x: 0, y: maxY },
    { x: 11, y: maxY },
  ];
  // Bottom-left interior tile → closest to (0, maxY).
  let best = sim.closestSpawn(2, maxY - 1);
  assert.deepEqual(best, { x: 0, y: maxY });
  // Top-right interior tile → closest to (11, 0).
  best = sim.closestSpawn(9, 1);
  assert.deepEqual(best, { x: 11, y: 0 });
});

test('randomSpawn returns a tile from spawnTiles', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }, { x: 5, y: 0 }];
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const d = sim.randomSpawn();
    assert.ok(sim.spawnTiles.some(s => s.x === d.x && s.y === d.y),
      `randomSpawn returned (${d.x},${d.y}) not in spawnTiles`);
    seen.add(`${d.x},${d.y}`);
  }
  // With 3 doors and 50 trials, vanishingly unlikely we never picked >=2.
  assert.ok(seen.size >= 2, `randomSpawn only ever returned ${[...seen].join('|')}`);
});

test('spawnCustomer stamps entryDoor on the new customer', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }];
  sim.dayState = 'spawning';
  for (let i = 0; i < 5; i++) {
    sim.spawnCustomer();
  }
  assert.ok(sim.customers.length >= 1);
  for (const c of sim.customers) {
    assert.ok(c.entryDoor, 'customer missing entryDoor');
    assert.ok(sim.spawnTiles.some(s => s.x === c.entryDoor.x && s.y === c.entryDoor.y),
      `customer entryDoor (${c.entryDoor.x},${c.entryDoor.y}) not in spawnTiles`);
  }
});

test('back-compat: sim.spawnTile / sim.exitTile resolve to spawnTiles[0]', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }];
  assert.deepEqual({ x: sim.spawnTile.x, y: sim.spawnTile.y }, { x: 0, y: 4 });
  assert.deepEqual({ x: sim.exitTile.x, y: sim.exitTile.y }, { x: 0, y: 4 });
});

test('multi-door layout: customer from door A exits via closest door', () => {
  const ctx = loadSim({ seed: 7 });
  const sim = new ctx.Simulation();
  // Two doors on opposite sides.
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }];
  sim.grid.setType(0, 4, 'spawn');
  sim.grid.setType(11, 4, 'spawn');
  // Place a customer near the east door — closestSpawn should pick east.
  const c = new ctx.Customer(10, 4, 0);
  c.tileX = function () { return Math.round(this.x); };
  c.tileY = function () { return Math.round(this.y); };
  c.entryDoor = { x: 0, y: 4 };
  const exit = sim.closestSpawn(c.tileX(), c.tileY());
  assert.deepEqual({ x: exit.x, y: exit.y }, { x: 11, y: 4 });
});

test('leave: customer reroutes to the next-closest door when the closest is unreachable', () => {
  const ctx = loadSim({ seed: 3 });
  const sim = new ctx.Simulation();
  sim.spawnTiles = [{ x: 0, y: 4 }, { x: 11, y: 4 }];
  sim.grid.setType(0, 4, 'spawn');
  sim.grid.setType(11, 4, 'spawn');
  // Isolate the west door: wall every walkable neighbor so it's unreachable.
  sim.grid.setType(1, 4, 'wall');
  sim.grid.setType(0, 3, 'wall');
  sim.grid.setType(0, 5, 'wall');
  // Customer mid-floor: west door is closer (Manhattan 5) than east (6) but
  // walled off, so leave() must fall back to the reachable east door.
  const c = new ctx.Customer(5, 4, 0);
  sim.customers.push(c);
  c.leave(sim, 'happy');
  assert.equal(c.alive, true, 'customer should not vanish when the closest door is walled off');
  assert.ok(c.path && c.path.length, 'customer should have an exit path');
  const last = c.path[c.path.length - 1];
  assert.deepEqual({ x: last.x, y: last.y }, { x: 11, y: 4 },
    'customer should route to the reachable east door');
});
