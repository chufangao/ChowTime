/* ============================================================================
 * test/unit/build_app.test.js — BuildApp + BuildItem registry
 * ============================================================================
 * Verifies that the registry-driven Build app picks up every default building
 * type, that placement works through onMapClick, and that the snapshot
 * `describe()` tree matches expectations. Catches the "added a building,
 * forgot to register it" failure mode.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootBuild: _bootBuild } = require('../harness.js');

// Cross-VM realm: normalise via JSON before deep-equal so prototypes match.
const norm = (v) => JSON.parse(JSON.stringify(v));

const bootBuild = (seed = 1) => _bootBuild({ seed });

test('all default building items are registered', () => {
  const { mgr } = bootBuild();
  const ids = mgr.buildItems.map(i => i.id).sort();
  assert.deepEqual(norm(ids), [
    'catapult_stove', 'chair', 'chef_spawn', 'floor', 'player_wall', 'sink', 'stove', 'table',
  ]);
});

test('BuildApp.itemsInTab partitions kitchen / dining / structure correctly', () => {
  const { build } = bootBuild();
  build.tab = 'kitchen';
  const k = build.itemsInTab().map(i => i.id).sort();
  assert.deepEqual(norm(k), ['catapult_stove', 'chef_spawn', 'sink', 'stove']);
  build.tab = 'dining';
  const d = build.itemsInTab().map(i => i.id).sort();
  assert.deepEqual(norm(d), ['chair', 'table']);
  build.tab = 'structure';
  const s = build.itemsInTab().map(i => i.id).sort();
  assert.deepEqual(norm(s), ['floor', 'player_wall']);
});

test('selecting an item then clicking the map places a building', () => {
  const { ctx, mgr, build, sim } = bootBuild();
  mgr.open('build');
  build.activeItem = mgr.buildItems.find(i => i.id === 'stove');
  // Place on (5,1): empty tile.
  const before = sim.buildings.length;
  const startMoney = sim.money;
  const ok = build.onMapClick(sim, { x: 5, y: 1 }, 0);
  assert.equal(ok, true);
  assert.equal(sim.buildings.length, before + 1);
  assert.equal(sim.buildings[before].type, 'stove');
  assert.equal(sim.money, startMoney - ctx.CONFIG.costs.stove);
});

test('placement on occupied / spawn tile fails gracefully', () => {
  const { ctx, mgr, build, sim } = bootBuild();
  mgr.open('build');
  build.activeItem = mgr.buildItems.find(i => i.id === 'stove');
  // Spawn tile is (0,4).
  assert.equal(build.onMapClick(sim, { x: 0, y: 4 }, 0), false);
  // Place once, then try same tile again.
  build.onMapClick(sim, { x: 5, y: 1 }, 0);
  assert.equal(build.onMapClick(sim, { x: 5, y: 1 }, 0), false);
});

test('describe() tree includes all items and current tab/active', () => {
  const { mgr, build } = bootBuild();
  mgr.open('build');
  build.tab = 'dining';
  build.activeItem = mgr.buildItems.find(i => i.id === 'chair');
  const d = JSON.parse(JSON.stringify(build.describe()));
  assert.equal(d.tab, 'dining');
  assert.equal(d.activeItemId, 'chair');
  assert.equal(d.items.length, 8);
  // Each item entry is plain JSON.
  for (const i of d.items) {
    assert.equal(typeof i.id, 'string');
    assert.equal(typeof i.label, 'string');
    assert.ok(['kitchen', 'dining', 'structure'].includes(i.category));
  }
});

test('selecting an item closes the panel (placement mode persists)', () => {
  const { mgr, build } = bootBuild();
  mgr.open('build');
  // Simulate selecting the first kitchen item the way the UI does:
  const item = mgr.buildItems.find(i => i.id === 'sink');
  build.activeItem = item;
  mgr.close();
  assert.equal(mgr.activeAppId, null);
  assert.equal(build.activeItem.id, 'sink', 'activeItem persists after close');
});
