/* ============================================================================
 * test/unit/walls.test.js — Player partition placement, demolition, and floor-fill
 * ============================================================================
 * Default-layout obstacles are now gaps (filled via placeFloor for $150).
 * Heavy structural walls no longer exist; only free player partitions and
 * gaps. This file covers the partition + floor mechanics.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('placeWall places a player partition for free', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.money = 500;

  const before = sim.money;
  const res = sim.placeWall(2, 2, 'player');
  assert.ok(res.ok);
  assert.equal(sim.grid.getTile(2, 2).type, 'wall');
  assert.equal(sim.grid.getTile(2, 2).wallKind, 'player');
  assert.equal(sim.money, before, 'player partition is free');
});

test('placeWall rejects spawn tile, walls, gaps, and existing buildings', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  // Spawn at (0,4) by default.
  assert.equal(sim.placeWall(0, 4, 'player').ok, false);
  // First wall ok, second on same tile fails.
  assert.equal(sim.placeWall(2, 2, 'player').ok, true);
  assert.equal(sim.placeWall(2, 2, 'player').ok, false);
  // Building blocks placement.
  sim.placeBuilding('stove', 5, 1, true);
  assert.equal(sim.placeWall(5, 1, 'player').ok, false);
  // Gap blocks placement (Floor must fill it first).
  sim.grid.setType(6, 1, 'gap');
  const res = sim.placeWall(6, 1, 'player');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'gap');
});

test('removeWallAt is free for player walls', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.money = 500;
  sim.placeWall(2, 2, 'player');
  const startMoney = sim.money;

  const res = sim.removeWallAt(2, 2);
  assert.ok(res.ok);
  assert.equal(sim.grid.getTile(2, 2).type, 'floor');
  assert.equal(sim.grid.getTile(2, 2).wallKind, null);
  assert.equal(sim.money, startMoney, 'partition demolish is free');
});

test('placeFloor fills a gap, costs $150, and rejects non-gap tiles', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.money = 500;
  sim.grid.setType(2, 2, 'gap');

  const before = sim.money;
  const res = sim.placeFloor(2, 2);
  assert.ok(res.ok);
  assert.equal(sim.grid.getTile(2, 2).type, 'floor');
  assert.equal(sim.money, before - ctx.CONFIG.costs.floor, 'floor costs $150');

  // Already a floor — refuses.
  const r2 = sim.placeFloor(2, 2);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'not-gap');

  // Spawn tile — refuses.
  const r3 = sim.placeFloor(0, 4);
  assert.equal(r3.ok, false);
});

test('placeFloor rejects when broke', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.grid.setType(2, 2, 'gap');
  sim.money = 50;
  const res = sim.placeFloor(2, 2);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-money');
  assert.equal(sim.grid.getTile(2, 2).type, 'gap', 'gap still there');
});

test('moveBuilding: tables and chairs are free, kitchen items cost $80', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.money = 500;
  sim.placeBuilding('stove', 5, 1, true);
  sim.placeBuilding('table', 6, 1, true);
  sim.placeBuilding('chair', 6, 2, true);

  const before = sim.money;
  // Move table — free.
  assert.equal(sim.moveBuilding(6, 1, 7, 1).ok, true);
  assert.equal(sim.money, before, 'table move free');

  // Move chair — free.
  assert.equal(sim.moveBuilding(6, 2, 8, 2).ok, true);
  assert.equal(sim.money, before, 'chair move free');

  // Move stove — $80.
  assert.equal(sim.moveBuilding(5, 1, 5, 2).ok, true);
  assert.equal(sim.money, before - ctx.CONFIG.costs.move_furniture, 'stove move costs');
});

test('moveBuilding rejects kitchen move when broke', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.placeBuilding('stove', 5, 1, true);
  sim.money = 20;          // < move cost
  const res = sim.moveBuilding(5, 1, 6, 1);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-money');
  // Source unchanged.
  assert.ok(sim.grid.getTile(5, 1).building);
});

test('placeBuilding rejects placing on a wall or gap tile', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.placeWall(5, 1, 'player');
  let res = sim.placeBuilding('stove', 5, 1, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'wall');

  sim.grid.setType(6, 1, 'gap');
  res = sim.placeBuilding('stove', 6, 1, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'gap');
});

test('save/load round-trips walls, gaps, and spawnTiles', () => {
  const ctx = loadSim({ seed: 9 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  // Add a player wall and a gap on top of the template.
  sim.money = 1000;
  // Pick free floor tiles by scanning.
  const free = [];
  for (let y = 0; y < ctx.ROWS && free.length < 2; y++) {
    for (let x = 0; x < ctx.COLS && free.length < 2; x++) {
      const t = sim.grid.getTile(x, y);
      if (t.type === 'floor' && !t.building) free.push({ x, y });
    }
  }
  assert.equal(free.length, 2);
  sim.placeWall(free[0].x, free[0].y, 'player');
  sim.grid.setType(free[1].x, free[1].y, 'gap');

  // Save requires dayEnd; the constructor leaves us there by default.
  assert.equal(sim.dayState, 'dayEnd');

  const json = JSON.parse(JSON.stringify(ctx.serializeSim(sim, null)));
  const { sim: sim2 } = ctx.deserializeSim(json);

  // describeSim now includes walls + gaps + spawnTiles + layoutId.
  const d1 = JSON.parse(JSON.stringify(ctx.describeSim(sim)));
  const d2 = JSON.parse(JSON.stringify(ctx.describeSim(sim2)));
  assert.deepEqual(d2, d1);
});
