// Loads the headless simulation source files (the same files index.html loads
// for the browser) into a fresh vm context. Returns the context, which carries
// Simulation, Customer, Employee, Stove, etc. as own properties.
//
// Two design notes:
//   1. We CONCATENATE the source files and run them as one script. vm.runInContext
//      gives each script its own lexical scope, so `class Foo` declared in one
//      runInContext call is invisible to another. Browsers, by contrast, share
//      a single global lexical environment across <script> tags. Concatenation
//      mirrors browser semantics exactly.
//   2. Customer and Employee constructors read color palettes (CUSTOMER_BODY_COLORS,
//      SKIN_TONES, PANTS_COLORS, HAIR_COLORS) that live in sprites.js, which we
//      do NOT load in headless mode. We stub them with single-entry arrays so
//      the constructors don't throw — values don't affect simulation behavior.

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC_FILES = [
  'src/data/constants.js',
  'src/data/layouts.js',
  'src/data/layout_generator.js',
  'src/data/abilities.js',
  'src/data/events_forecasts.js',
  'src/data/chef_presets.js',
  'src/sim/grid.js',
  'src/entities/buildings.js',
  'src/entities/customer.js',
  'src/entities/employee.js',
  'src/sim/event_manager.js',
  'src/sim/day_state_machine.js',
  'src/sim/simulation.js',
  'src/sim/save_load.js',
  // UI layer — Phaser-pure (no Phaser imports), receives a stub scene in tests.
  'src/ui/app.js',
  'src/ui/app_manager.js',
  'src/ui/widgets.js',
  'src/ui/top_bar.js',
  'src/ui/apps/map_tools.js',
  'src/ui/apps/build_app.js',
  'src/ui/apps/hire_app.js',
  'src/ui/apps/settings_app.js',
  'src/ui/apps/day_end_app.js',
  'src/ui/apps/start_day_app.js',
  'src/ui/apps/midday_event_app.js',
  'src/ui/apps/game_over_app.js',
];

function makeRng(seed) {
  // mulberry32 — deterministic, stateful, ~2^32 period. Plenty for tests.
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE_STUB = `
const CUSTOMER_BODY_COLORS = [0x000000];
const SKIN_TONES = [0x000000];
const PANTS_COLORS = [0x000000];
const HAIR_COLORS = [0x000000];
`;

function loadSim({ seed = 1 } = {}) {
  // Build a minimal Math whose .random is our seeded PRNG. Preserve every
  // other Math member by inheriting from the host Math.
  const stubMath = Object.create(Math);
  stubMath.random = makeRng(seed);

  const ctx = vm.createContext({
    Math: stubMath,
    console,
    Object, Array, Map, Set, Symbol, Number, String, Boolean,
    Error, JSON, Promise,
  });

  const repoRoot = path.join(__dirname, '..');
  const parts = [PALETTE_STUB];
  for (const rel of SRC_FILES) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;          // skip files not yet written
    parts.push(`/* ===== ${rel} ===== */`);
    parts.push(fs.readFileSync(abs, 'utf8'));
  }
  // Promote a handful of class/const names to ctx own-properties so tests can
  // pull them out by `ctx.Simulation` etc. (vm script-locals aren't visible
  // on the context object directly.)
  parts.push(`
    Object.assign(this, {
      // constants / data
      COLS, ROWS, FOODS, FOOD_KEYS, CONFIG,
      ABILITIES, CUSTOMER_ABILITY_ROLL,
      EVENTS, FORECASTS, GIFTS, STARTER_CHEF, CHEF_ROSTER,
      LAYOUTS, validateLayout, pickRandomLayout, getLayoutById, applyLayout,
      generateLayout: (typeof generateLayout === 'function' ? generateLayout : null),
      // helpers
      clamp, computeQuality, computeTip,
      abilitiesOf, abilityMult, abilitySum, fireAbilityHook,
      rollDailyEvent, rollBaseForecast, rollGiftEvent, rollCustomerAbilities,
      // sim classes
      Grid, Pathfinder,
      Building, Stove, CatapultStove, Table, Chair, Sink, Order,
      Entity, CS, Customer,
      ES, Employee,
      Simulation,
      // save/load
      serializeSim: (typeof serializeSim === 'function' ? serializeSim : null),
      deserializeSim: (typeof deserializeSim === 'function' ? deserializeSim : null),
      describeSim: (typeof describeSim === 'function' ? describeSim : null),
      // ui classes (TOP_BAR_H lives in sprites.js, not loaded headless)
      App, AppManager, Widgets, TopBar,
      MoveApp: (typeof MoveApp === 'function' ? MoveApp : null),
      SellApp: (typeof SellApp === 'function' ? SellApp : null),
      RepairApp: (typeof RepairApp === 'function' ? RepairApp : null),
      RotateApp: (typeof RotateApp === 'function' ? RotateApp : null),
      BuildApp: (typeof BuildApp === 'function' ? BuildApp : null),
      HireApp: (typeof HireApp === 'function' ? HireApp : null),
      SettingsApp: (typeof SettingsApp === 'function' ? SettingsApp : null),
      DayEndApp: (typeof DayEndApp === 'function' ? DayEndApp : null),
      StartDayApp: (typeof StartDayApp === 'function' ? StartDayApp : null),
      MiddayEventApp: (typeof MiddayEventApp === 'function' ? MiddayEventApp : null),
      GameOverApp: (typeof GameOverApp === 'function' ? GameOverApp : null),
      registerDefaultBuildItems: (typeof registerDefaultBuildItems === 'function' ? registerDefaultBuildItems : null),
      MIDDAY_EVENTS: (typeof MIDDAY_EVENTS !== 'undefined' ? MIDDAY_EVENTS : null),
      rollMiddayEvent: (typeof rollMiddayEvent === 'function' ? rollMiddayEvent : null),
      getMiddayEventById: (typeof getMiddayEventById === 'function' ? getMiddayEventById : null),
    });
  `);

  vm.runInContext(parts.join('\n'), ctx, { filename: 'sim-bundle.js' });
  return ctx;
}

/* ============================================================================
 * Stub Phaser scene for headless UI tests.
 *
 * UI classes (App, TopBar, ...) call scene.add.graphics()/text()/zone()/
 * container() and chain setters. We return objects whose every setter and
 * mutator is a no-op that returns self, so any chainable Phaser API works.
 *
 * Tests can inspect `recorded` events on each stub (which method was called
 * with what args) to make richer assertions if they want, but most tests
 * just call .describe() on Apps/AppManager and assert against plain JSON.
 * ========================================================================== */
function makeStubScene({ width = 1100, height = 600 } = {}) {
  const noop = () => {};
  function chainable(props = {}) {
    const o = Object.assign({
      // common Phaser GameObject methods, all return self.
      setOrigin: function () { return this; },
      setDepth: function () { return this; },
      setVisible: function (v) { this.visible = v; return this; },
      setPosition: function () { return this; },
      setText: function (s) { this.text = String(s); return this; },
      setColor: function () { return this; },
      setStyle: function () { return this; },
      setInteractive: function () { return this; },
      setScrollFactor: function () { return this; },
      setAlpha: function () { return this; },
      setSize: function () { return this; },
      add: function () { return this; },
      remove: function () { return this; },
      destroy: function () { this._destroyed = true; },
      on: function () { return this; },
      off: function () { return this; },
      // graphics-style mutators
      clear: function () { return this; },
      fillStyle: function () { return this; },
      lineStyle: function () { return this; },
      fillRect: function () { return this; },
      fillRoundedRect: function () { return this; },
      strokeRoundedRect: function () { return this; },
      strokeRect: function () { return this; },
      fillCircle: function () { return this; },
      strokeCircle: function () { return this; },
      beginPath: function () { return this; },
      moveTo: function () { return this; },
      lineTo: function () { return this; },
      closePath: function () { return this; },
      fillPath: function () { return this; },
      strokePath: function () { return this; },
      // text introspection
      width: 0, height: 0,
    }, props);
    return o;
  }
  const scene = {
    gameWidth:  width,
    gameHeight: height,
    add: {
      graphics:  () => chainable({ kind: 'graphics' }),
      text:      (x, y, t, s) => chainable({ kind: 'text', x, y, text: String(t || ''), style: s }),
      zone:      (x, y, w, h) => chainable({ kind: 'zone', x, y, w, h }),
      container: (x, y) => chainable({ kind: 'container', x, y, children: [] }),
      rectangle: (x, y, w, h, color) => chainable({ kind: 'rectangle', x, y, w, h, color }),
    },
    input: {
      on: noop, off: noop,
      keyboard: { on: noop, off: noop, addKey: () => chainable({ kind: 'key' }) },
    },
    cameras: { main: { width, height, centerX: width/2, centerY: height/2 } },
    sys: { game: { config: { width, height } } },
    events: { on: noop, off: noop },
  };
  return scene;
}

/* ============================================================================
 * Higher-level boot helpers used by multiple test files.
 *
 * bootAppManager — fresh sim/scene/empty AppManager with scene attached.
 * bootBuild      — bootAppManager + default build items + a BuildApp + a Sim.
 * bootFullShell  — bootAppManager + sim.seedDemo + every default app + widgets
 *                  + a TopBar. Used by structural snapshot tests.
 * ========================================================================== */
function bootAppManager({ seed = 1 } = {}) {
  const ctx   = loadSim({ seed });
  const scene = makeStubScene();
  const mgr   = new ctx.AppManager();
  mgr.attachScene(scene);
  return { ctx, scene, mgr };
}

function bootBuild({ seed = 1 } = {}) {
  const r = bootAppManager({ seed });
  r.ctx.registerDefaultBuildItems(r.mgr);
  r.build = new r.ctx.BuildApp();
  r.mgr.register(r.build);
  r.sim = new r.ctx.Simulation();
  r.mgr._sim = r.sim;
  return r;
}

function bootFullShell({ seed = 1, width = 1100, height = 600 } = {}) {
  const ctx   = loadSim({ seed });
  const scene = makeStubScene({ width, height });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const mgr = new ctx.AppManager();
  mgr.attachScene(scene);
  ctx.registerDefaultBuildItems(mgr);
  mgr.register(new ctx.BuildApp());
  mgr.register(new ctx.HireApp());
  mgr.register(new ctx.SettingsApp());
  mgr.register(new ctx.MoveApp());
  mgr.register(new ctx.SellApp());
  if (ctx.RepairApp) mgr.register(new ctx.RepairApp());
  if (ctx.RotateApp) mgr.register(new ctx.RotateApp());
  mgr.register(new ctx.DayEndApp());
  mgr.register(new ctx.StartDayApp());
  if (ctx.MiddayEventApp) mgr.register(new ctx.MiddayEventApp());
  mgr.register(new ctx.GameOverApp());
  mgr.registerWidget(ctx.Widgets.money());
  mgr.registerWidget(ctx.Widgets.reputation());
  mgr.registerWidget(ctx.Widgets.day());
  mgr.registerWidget(ctx.Widgets.stats());
  const topBar = new ctx.TopBar(scene, mgr, scene.gameWidth, scene.gameHeight);
  return { ctx, scene, sim, mgr, topBar };
}

module.exports = {
  loadSim, makeRng, makeStubScene,
  bootAppManager, bootBuild, bootFullShell,
};
