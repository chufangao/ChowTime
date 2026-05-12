/* ============================================================================
 * test/snapshot/top_bar.test.js — Structural snapshot of the UI shell
 * ============================================================================
 * Boots the AppManager + every default app + TopBar with a stub Phaser scene,
 * walks through several states (idle, build open, hire open, day-end auto-
 * open), and asserts on the JSON shape of describe(). Catches:
 *
 *   - widgets disappearing / reordering
 *   - apps not appearing in the launcher
 *   - panel/map-tool kinds confused
 *   - AppManager state after toggle/auto-open
 *
 * No pixel comparison; this is a structure check, not a visual one.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootFullShell } = require('../harness.js');

const norm = (v) => JSON.parse(JSON.stringify(v));

const bootShell = (seed = 1) => bootFullShell({ seed });

test('idle shell describe(): widgets present, no app open, all apps registered', () => {
  const { mgr, sim, topBar } = bootShell();
  topBar.refresh(sim);
  const tb = norm(topBar.describe(sim));
  // Widget identity & count
  const widgetIds = tb.widgets.map(w => w.id);
  assert.deepEqual(widgetIds, ['money', 'reputation', 'day', 'stats']);
  // Panel-app launchers should include the user-facing apps (game_over hides itself).
  // midday_event is included because it has hasPanel:true even though its
  // launcher button isn't user-clickable in normal flow (auto-opened only).
  const launcherIds = tb.panelApps.map(a => a.id).sort();
  assert.deepEqual(launcherIds, ['build', 'day_end', 'hire', 'midday_event', 'settings', 'start_day']);
  // Map tools: move, sell.
  const mapToolIds = tb.mapTools.map(a => a.id).sort();
  assert.deepEqual(mapToolIds, ['move', 'sell']);
  // No app currently active.
  for (const a of tb.panelApps) assert.equal(a.active, false);
  for (const t of tb.mapTools) assert.equal(t.active, false);
});

test('opening build app marks it active in the snapshot', () => {
  const { mgr, sim, topBar } = bootShell();
  mgr.open('build');
  topBar.refresh(sim);
  const tb = norm(topBar.describe(sim));
  const build = tb.panelApps.find(a => a.id === 'build');
  assert.equal(build.active, true);
});

test('toggling a map-tool sets activeMapToolId, not activeAppId-as-panel', () => {
  const { mgr, sim, topBar } = bootShell();
  mgr.toggle('move');
  topBar.refresh(sim);
  const tb = norm(topBar.describe(sim));
  const move = tb.mapTools.find(t => t.id === 'move');
  assert.equal(move.active, true);
  // No panel app is shown as active.
  assert.ok(tb.panelApps.every(a => a.active === false));
});

test('midday_event app auto-opens when an unresolved dayEnd event is pending', () => {
  const { mgr, sim } = bootShell();
  // Skip the boot-gift roll by advancing past day 1, then force a dayEnd
  // event into place. The unified modal (midday_event) auto-opens for
  // any unresolved dayEnd event; the Review tab is on-demand only.
  sim.day = 2;
  sim.dayState = 'dayEnd';
  sim.eventOutcome = null;
  sim.currentEvent = { id: 'test_ev', icon: '⚠', title: 'Test', flavor: '', choices: [
    { kind: 'pay', label: 'Skip', cost: {}, onResolve: () => ({ msg: 'ok' }) },
  ] };
  mgr.update(sim);
  assert.equal(mgr.activeAppId, 'midday_event');
});

test('no app auto-opens at dayEnd once the event is resolved', () => {
  const { mgr, sim } = bootShell();
  sim.day = 2;
  sim.dayState = 'dayEnd';
  // Event resolved — the modal stops auto-opening; Review stays on-demand.
  sim.currentEvent = { id: 'test_ev', icon: '⚠', title: 'Test', flavor: '', choices: [] };
  sim.eventOutcome = { passed: true, roll: 0, total: 0, dc: 0, chef: null, result: null, msg: 'ok' };
  mgr.update(sim);
  assert.notEqual(mgr.activeAppId, 'day_end');
  assert.notEqual(mgr.activeAppId, 'midday_event');
});

test('game_over app preempts the event modal (modal priority)', () => {
  const { mgr, sim } = bootShell();
  sim.dayState = 'dayEnd';
  sim.gameOver = true;
  mgr.update(sim);
  assert.equal(mgr.activeAppId, 'game_over');
});

test('full describe() tree round-trips through JSON', () => {
  const { mgr, sim } = bootShell();
  mgr.open('build');
  const tree = mgr.describe(sim);
  const blob = JSON.stringify(tree);
  const parsed = JSON.parse(blob);
  assert.equal(parsed.activeAppId, 'build');
  assert.ok(Array.isArray(parsed.apps));
  assert.ok(Array.isArray(parsed.widgets));
  assert.ok(Array.isArray(parsed.buildItems));
  assert.equal(parsed.buildItems.length, 7);
});

