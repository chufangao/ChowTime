/* ============================================================================
 * test/unit/replace_layout.test.js — sim.replaceLayout swap behavior
 * ============================================================================
 * Verifies that replaceLayout wipes walls + buildings, applies the new layout,
 * and refuses during live service.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('replaceLayout: wipes walls/gaps/buildings, applies new layout, preserves money', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const moneyBefore = sim.money;
  // Add some player walls to verify the wipe.
  sim.placeWall(2, 2, 'player');
  sim.placeWall(2, 3, 'player');
  const beforeBuildings = sim.buildings.length;
  assert.ok(beforeBuildings >= 4, 'seedDemo should place at least 4 starters');

  const gen = ctx.generateLayout(7777);
  assert.ok(gen, 'generator should produce a layout for seed 7777');
  const res = sim.replaceLayout(gen);
  assert.equal(res.ok, true);

  // Layout id updated.
  assert.equal(sim.layoutId, gen.id);
  // The new starters are present (exactly the four from the generated layout).
  assert.equal(sim.buildings.length, 4);
  // No player walls survived. (Walls now only exist as player partitions.)
  for (let y = 0; y < sim.grid.rows; y++) {
    for (let x = 0; x < sim.grid.cols; x++) {
      const t = sim.grid.getTile(x, y);
      if (t.type === 'wall') {
        throw new Error(`player wall survived reroll at (${x},${y})`);
      }
    }
  }
  // spawnTiles match the generated layout's doors exactly (any order).
  const sortedA = [...sim.spawnTiles].map(d => `${d.x},${d.y}`).sort();
  const sortedB = [...gen.doors].map(d => `${d.x},${d.y}`).sort();
  assert.deepEqual(sortedA, sortedB);
  // Money unchanged: the generator's starters are placed free.
  assert.equal(sim.money, moneyBefore);
});

test('replaceLayout: refuses during live service', () => {
  const ctx = loadSim({ seed: 2 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.dayState = 'spawning';
  const gen = ctx.generateLayout(123);
  const res = sim.replaceLayout(gen);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'live-service');
});

test('replaceLayout: rejects malformed input', () => {
  const ctx = loadSim({ seed: 3 });
  const sim = new ctx.Simulation();
  assert.equal(sim.replaceLayout(null).ok, false);
  assert.equal(sim.replaceLayout({}).ok, false);
});
