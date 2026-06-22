/* ============================================================================
 * test/unit/grow_map.test.js — enlarged grid + expansion void
 * ============================================================================
 * The grid is allocated at GRID_COLS×GRID_ROWS but the restaurant footprint
 * stays COLS×ROWS at the origin; everything outside it is the 'gap' expansion
 * void. These tests pin that invariant, the door/footprint layout, the
 * save/load round-trip of an enlarged grid, and the iso math staying exact for
 * both restaurant and expansion tiles (sprites.js, loaded standalone).
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { loadSim } = require('../harness.js');

test('a fresh sim allocates GRID_COLS×GRID_ROWS with the footprint at the origin', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  assert.equal(sim.grid.cols, ctx.GRID_COLS);
  assert.equal(sim.grid.rows, ctx.GRID_ROWS);
  assert.ok(ctx.GRID_COLS > ctx.COLS && ctx.GRID_ROWS > ctx.ROWS, 'grid must be larger than footprint');
});

test('restaurant footprint is floor, everything outside it is gap', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();   // bare: no seedDemo, so footprint is floor-default
  // Corners of the footprint are floor (default spawn at (0,4) is the only non-floor).
  assert.equal(sim.grid.getTile(0, 0).type, 'floor');
  assert.equal(sim.grid.getTile(11, 11).type, 'floor');
  assert.equal(sim.grid.getTile(11, 0).type, 'floor');
  assert.equal(sim.grid.getTile(0, 11).type, 'floor');
  // Just outside the footprint (and far out) is the expansion void.
  assert.equal(sim.grid.getTile(12, 0).type, 'gap');
  assert.equal(sim.grid.getTile(0, 12).type, 'gap');
  assert.equal(sim.grid.getTile(12, 12).type, 'gap');
  assert.equal(sim.grid.getTile(ctx.GRID_COLS - 1, ctx.GRID_ROWS - 1).type, 'gap');
  // Expansion void is unwalkable (so customers/chefs can't path into it).
  assert.equal(sim.grid.isWalkable(12, 12), false);
});

test('seeded demo keeps doors on the 12x12 footprint perimeter', () => {
  const ctx = loadSim({ seed: 7 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  assert.ok(sim.spawnTiles.length >= 1);
  for (const d of sim.spawnTiles) {
    const onPerim = (d.x === 0 || d.x === ctx.COLS - 1 || d.y === 0 || d.y === ctx.ROWS - 1);
    assert.ok(onPerim, `door (${d.x},${d.y}) must be on the footprint perimeter`);
    assert.ok(d.x < ctx.COLS && d.y < ctx.ROWS, 'door inside footprint');
  }
});

test('save/load round-trips an enlarged grid with placed-room floors', () => {
  const ctx = loadSim({ seed: 3 });
  const sim = new ctx.Simulation();
  // Carve a couple of expansion tiles to floor (as a placed room would).
  sim.grid.setType(12, 5, 'floor');
  sim.grid.setType(13, 5, 'floor');
  sim._pendingRooms.push('diner_nook');   // a pending grant should survive too

  const blob = JSON.parse(JSON.stringify(ctx.serializeSim(sim, null)));
  assert.equal(blob.version, 3);
  assert.deepEqual(blob.sim.expansionFloors.sort((a, b) => a.x - b.x), [{ x: 12, y: 5 }, { x: 13, y: 5 }]);
  assert.deepEqual(blob.sim.pendingRooms, ['diner_nook']);

  const { sim: sim2 } = ctx.deserializeSim(blob);
  assert.equal(sim2.grid.cols, ctx.GRID_COLS);
  assert.equal(sim2.grid.getTile(12, 5).type, 'floor');
  assert.equal(sim2.grid.getTile(13, 5).type, 'floor');
  assert.equal(sim2.grid.getTile(14, 5).type, 'gap');     // untouched void stays void
  assert.deepEqual(Array.from(sim2._pendingRooms), ['diner_nook']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.describeSim(sim2))),
    JSON.parse(JSON.stringify(ctx.describeSim(sim))),
  );
});

test('old (version 2) saves still load — they simply have no expansion floors', () => {
  const ctx = loadSim({ seed: 4 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const blob = JSON.parse(JSON.stringify(ctx.serializeSim(sim, null)));
  // Simulate a legacy save: drop the v3-only fields and stamp version 2.
  blob.version = 2;
  delete blob.sim.expansionFloors;
  delete blob.sim.pendingRooms;
  const { sim: sim2 } = ctx.deserializeSim(blob);
  assert.equal(sim2.grid.cols, ctx.GRID_COLS);
  assert.equal(sim2._pendingRooms.length, 0);
  assert.equal(sim2.grid.getTile(12, 12).type, 'gap');
});

/* ---- Iso math: screenToTile(gridToScreen(x,y)) === (x,y) -------------------
 * sprites.js is browser-only (not in the harness SRC_FILES), so load it
 * standalone on top of constants.js to exercise the view-vs-grid decoupling. */
function loadSprites() {
  const repoRoot = path.join(__dirname, '..', '..');
  const ctx = vm.createContext({ Math, console });
  const parts = [
    fs.readFileSync(path.join(repoRoot, 'src/data/constants.js'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'sprites.js'), 'utf8'),
    `Object.assign(this, { gridToScreen, screenToTile, COLS, ROWS, GRID_COLS, GRID_ROWS,
      GRID_PX_W, GRID_PX_H, RESTAURANT_VIEW_CX, RESTAURANT_VIEW_CY, GRID_OX });`,
  ];
  vm.runInContext(parts.join('\n'), ctx, { filename: 'sprites-bundle.js' });
  return ctx;
}

test('iso inverse is exact for every tile in the enlarged grid', () => {
  const s = loadSprites();
  for (let y = 0; y < s.GRID_ROWS; y++) {
    for (let x = 0; x < s.GRID_COLS; x++) {
      const { sx, sy } = s.gridToScreen(x, y);
      const t = s.screenToTile(sx, sy);
      assert.ok(t, `tile (${x},${y}) must be pickable`);
      assert.equal(t.x, x, `round-trip x for (${x},${y})`);
      assert.equal(t.y, y, `round-trip y for (${x},${y})`);
    }
  }
});

test('every tile maps to a positive screen coord and within the world extent', () => {
  const s = loadSprites();
  for (let y = 0; y < s.GRID_ROWS; y++) {
    for (let x = 0; x < s.GRID_COLS; x++) {
      const { sx, sy } = s.gridToScreen(x, y);
      assert.ok(sx >= 0 && sx <= s.GRID_PX_W, `x in extent for (${x},${y})`);
      assert.ok(sy >= 0 && sy <= s.GRID_PX_H, `y in extent for (${x},${y})`);
    }
  }
});
