/* ============================================================================
 * test/unit/layouts.test.js — Layout template catalog + applyLayout integration
 * ============================================================================
 * Boot validates all templates in the catalog (or it would have thrown at
 * harness load), but we re-assert here for clarity. Then for every template:
 *   - applyLayout produces a sim with the door, walls, and starters in place
 *   - the pathfinder can reach every starter from the door
 *   - the layoutId is recorded
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('every template in LAYOUTS validates', () => {
  const ctx = loadSim({ seed: 1 });
  assert.ok(ctx.LAYOUTS.length >= 5, `expected several templates, got ${ctx.LAYOUTS.length}`);
  for (const L of ctx.LAYOUTS) {
    const v = ctx.validateLayout(L);
    assert.ok(v.ok, `template ${L.id} invalid: ${(v.errors || []).join('; ')}`);
  }
});

test('applyLayout sets doors, paints gaps, places starters, sets layoutId', () => {
  const ctx = loadSim({ seed: 1 });
  for (const L of ctx.LAYOUTS) {
    const sim = new ctx.Simulation();
    ctx.applyLayout(sim, L);

    // layoutId stamped.
    assert.equal(sim.layoutId, L.id);

    // Every door tile is a spawn and lives in spawnTiles.
    assert.ok(sim.spawnTiles.length >= 1);
    for (const d of L.doors) {
      const tile = sim.grid.getTile(d.x, d.y);
      assert.equal(tile.type, 'spawn');
      const inArr = sim.spawnTiles.some(s => s.x === d.x && s.y === d.y);
      assert.ok(inArr, `${L.id}: door (${d.x},${d.y}) missing from spawnTiles`);
    }

    // Every gap painted as type='gap'.
    for (const g of L.gaps) {
      const t = sim.grid.getTile(g.x, g.y);
      assert.equal(t.type, 'gap', `gap not painted at (${g.x},${g.y}) for ${L.id}`);
    }

    // Every starter placed as a building.
    for (const s of L.starters) {
      const t = sim.grid.getTile(s.x, s.y);
      assert.ok(t.building, `${L.id}: no building at starter ${s.type} (${s.x},${s.y})`);
      assert.equal(t.building.type, s.type);
    }
  }
});

test('some door reaches every starter via pathfinder for every template', () => {
  const ctx = loadSim({ seed: 1 });
  for (const L of ctx.LAYOUTS) {
    const sim = new ctx.Simulation();
    ctx.applyLayout(sim, L);
    for (const s of L.starters) {
      // Buildings are non-walkable, so we ask for a path to ANY 4-neighbor of
      // the starter from ANY door. With multi-door layouts, only some path
      // needs to exist (not all doors → all starters).
      const neighbors = [
        { x: s.x + 1, y: s.y }, { x: s.x - 1, y: s.y },
        { x: s.x, y: s.y + 1 }, { x: s.x, y: s.y - 1 },
      ];
      let reachable = false;
      outer: for (const door of sim.spawnTiles) {
        for (const n of neighbors) {
          if (!sim.grid.inBounds(n.x, n.y)) continue;
          const path = sim.pathfinder.findPath(
            door.x, door.y,
            (x, y) => x === n.x && y === n.y,
            (x, y) => sim.grid.isWalkable(x, y));
          if (path) { reachable = true; break outer; }
        }
      }
      assert.ok(reachable, `${L.id}: no path from any door to neighbor of ${s.type} (${s.x},${s.y})`);
    }
  }
});

test('seedDemo applies a random layout and the starter chef + 4 starter buildings', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  // 1 stove, 1 sink, 1 table, 1 chair from any template.
  // Cross-vm deepEqual on arrays trips on prototype identity, so check
  // counts per type instead.
  const counts = {};
  for (const b of sim.buildings) counts[b.type] = (counts[b.type] || 0) + 1;
  assert.equal(counts.stove, 1, 'one stove');
  assert.equal(counts.sink, 1,  'one sink');
  assert.equal(counts.table, 1, 'one table');
  assert.equal(counts.chair, 1, 'one chair');
  assert.equal(sim.buildings.length, 4, 'exactly 4 starter buildings');
  assert.equal(sim.employees.length, 1, 'starter chef is hired');
  assert.ok(sim.layoutId, 'layoutId stamped');
});
