/* ============================================================================
 * test/unit/app_manager.test.js — AppManager registry + App base behavior
 * ============================================================================
 * Verifies the foundation: registration, exclusive open/close, auto-open
 * priority, pointer/keyboard gating, structural describe() output, and
 * serialize/deserialize round-trip of UI state.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, makeStubScene, bootAppManager } = require('../harness.js');

const bootUI = (seed = 1) => bootAppManager({ seed });

test('AppManager.register adds an app and rejects duplicates', () => {
  const { ctx, mgr } = bootUI();
  const a = new ctx.App({ id: 'foo', icon: 'F', title: 'Foo' });
  mgr.register(a);
  assert.equal(mgr.get('foo'), a);
  assert.throws(() => mgr.register(a), /already registered/);
});

test('open() closes any other app first (only one active)', () => {
  const { ctx, mgr } = bootUI();
  const a = new ctx.App({ id: 'a', icon: 'A', title: 'A' });
  const b = new ctx.App({ id: 'b', icon: 'B', title: 'B' });
  mgr.register(a); mgr.register(b);
  mgr.open('a');
  assert.equal(mgr.activeAppId, 'a');
  assert.equal(a.isOpen, true);
  mgr.open('b');
  assert.equal(mgr.activeAppId, 'b');
  assert.equal(a.isOpen, false);
  assert.equal(b.isOpen, true);
});

test('toggle() opens then closes', () => {
  const { ctx, mgr } = bootUI();
  const a = new ctx.App({ id: 'a', icon: 'A', title: 'A' });
  mgr.register(a);
  mgr.toggle('a');
  assert.equal(mgr.activeAppId, 'a');
  mgr.toggle('a');
  assert.equal(mgr.activeAppId, null);
  assert.equal(a.isOpen, false);
});

test('map-tool app (hasPanel=false) sets activeMapToolId, panel app does not', () => {
  const { ctx, mgr } = bootUI();
  const tool   = new ctx.App({ id: 'tool',   icon: 'T', title: 'Tool',  hasPanel: false });
  const panel  = new ctx.App({ id: 'panel',  icon: 'P', title: 'Panel', hasPanel: true });
  mgr.register(tool); mgr.register(panel);
  mgr.open('tool');
  assert.equal(mgr.activeAppId, 'tool');
  assert.equal(mgr.activeMapToolId, 'tool');
  mgr.open('panel');
  assert.equal(mgr.activeAppId, 'panel');
  assert.equal(mgr.activeMapToolId, null);
});

test('autoOpenWhen() opens automatically; modal beats non-modal priority', () => {
  const { ctx, mgr } = bootUI();
  class A extends ctx.App { autoOpenWhen(s) { return s && s._wantA; } }
  class B extends ctx.App { autoOpenWhen(s) { return s && s._wantB; } }
  const a = new A({ id: 'a', icon: 'A', title: 'A', isModal: false });
  const b = new B({ id: 'b', icon: 'B', title: 'B', isModal: true });
  mgr.register(a); mgr.register(b);
  const sim = { _wantA: true, _wantB: false };
  mgr.update(sim);
  assert.equal(mgr.activeAppId, 'a');
  // Now both want to open — modal b wins.
  sim._wantB = true;
  mgr.update(sim);
  assert.equal(mgr.activeAppId, 'b');
});

test('consumesPointer respects topBarRect and active app panel', () => {
  const { ctx, mgr } = bootUI();
  mgr.topBarRect = { x: 0, y: 0, w: 1100, h: 60 };
  // Pointer in top bar → consumed.
  assert.equal(mgr.consumesPointer({ x: 50, y: 30 }), true);
  // Pointer below top bar with no app → not consumed.
  assert.equal(mgr.consumesPointer({ x: 50, y: 200 }), false);
  // Open a non-modal panel app and ensure panel containsPoint gates click.
  const a = new ctx.App({ id: 'a', icon: 'A', title: 'A', hasPanel: true });
  mgr.register(a);
  mgr.open('a');
  const r = a.panelRect();
  assert.equal(mgr.consumesPointer({ x: r.x + 10, y: r.y + 10 }), true);
  assert.equal(mgr.consumesPointer({ x: r.x - 50, y: r.y + 10 }), false);
});

test('modal app consumes pointer everywhere (backdrop blocks game)', () => {
  const { ctx, mgr } = bootUI();
  const a = new ctx.App({ id: 'a', icon: 'A', title: 'A', hasPanel: true, isModal: true });
  mgr.register(a);
  mgr.open('a');
  // Even a click far from the panel is consumed by the modal backdrop.
  assert.equal(mgr.consumesPointer({ x: 5, y: 500 }), true);
});

test('onKey: ESC closes a non-modal app, leaves modal alone', () => {
  const { ctx, mgr } = bootUI();
  const a = new ctx.App({ id: 'a', icon: 'A', title: 'A', hasPanel: true });
  const m = new ctx.App({ id: 'm', icon: 'M', title: 'M', hasPanel: true, isModal: true });
  mgr.register(a); mgr.register(m);
  mgr.open('a');
  assert.equal(mgr.onKey('Escape'), true);
  assert.equal(mgr.activeAppId, null);
  mgr.open('m');
  assert.equal(mgr.onKey('Escape'), false);
  assert.equal(mgr.activeAppId, 'm');
});

test('forwardMapClick goes to active map-tool, not to panel apps', () => {
  const { ctx, mgr } = bootUI();
  let panelClicks = 0, toolClicks = 0;
  class Tool extends ctx.App { onMapClick() { toolClicks++; } }
  class Panel extends ctx.App { onMapClick() { panelClicks++; } }
  const tool  = new Tool({ id: 't', icon: 'T', title: 'T', hasPanel: false });
  const panel = new Panel({ id: 'p', icon: 'P', title: 'P', hasPanel: true });
  mgr.register(tool); mgr.register(panel);
  // Panel app open — map click NOT forwarded.
  mgr.open('p');
  assert.equal(mgr.forwardMapClick({}, { x: 0, y: 0 }, 0), false);
  assert.equal(panelClicks, 0);
  // Tool app open — map click forwarded.
  mgr.open('t');
  assert.equal(mgr.forwardMapClick({}, { x: 0, y: 0 }, 0), true);
  assert.equal(toolClicks, 1);
});

test('describe() returns plain JSON tree', () => {
  const { ctx, mgr } = bootUI();
  const a = new ctx.App({ id: 'a', icon: 'A', title: 'A' });
  mgr.register(a);
  const d = mgr.describe(null);
  assert.equal(typeof d, 'object');
  assert.equal(Array.isArray(d.apps), true);
  const aDesc = d.apps.find(x => x.id === 'a');
  // Cross-VM realm: the stub-context object literal has a different Object
  // prototype than the test-runner literal, so use a JSON round-trip to
  // bring both into the same realm before deep-equal.
  const norm = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(norm(aDesc), { id: 'a', kind: 'panel', isOpen: false, isModal: false, lockedDuringService: false, title: 'A', icon: 'A' });
  // Ensure the tree is JSON-safe (no functions, no circular refs).
  const json = JSON.stringify(d);
  assert.ok(json.length > 0);
  assert.deepEqual(norm(d).activeAppId, null);
});

test('serialize/deserialize preserves activeAppId and per-app state', () => {
  const { ctx, mgr } = bootUI();
  class Stateful extends ctx.App {
    constructor(opts) { super(opts); this.foo = 0; }
    serialize()       { return { foo: this.foo }; }
    deserialize(s)    { this.foo = (s && s.foo) || 0; }
  }
  const a = new Stateful({ id: 'a', icon: 'A', title: 'A' });
  mgr.register(a);
  a.foo = 42;
  mgr.open('a');
  const json = JSON.parse(JSON.stringify(mgr.serialize()));

  // Fresh manager, same app type; restore.
  const ctx2 = loadSim({ seed: 1 });
  const mgr2 = new ctx2.AppManager();
  mgr2.attachScene(makeStubScene());
  const b = new (class extends ctx2.App {
    serialize()       { return { foo: this.foo }; }
    deserialize(s)    { this.foo = (s && s.foo) || 0; }
  })({ id: 'a', icon: 'A', title: 'A' });
  mgr2.register(b);
  mgr2.deserialize(json);
  assert.equal(mgr2.activeAppId, 'a');
  assert.equal(b.foo, 42);
});

