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
  'src/data/abilities.js',
  'src/data/events_forecasts.js',
  'src/data/chef_presets.js',
  'src/sim/grid.js',
  'src/entities/buildings.js',
  'src/entities/customer.js',
  'src/entities/employee.js',
  'src/sim/simulation.js',
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
    parts.push(`/* ===== ${rel} ===== */`);
    parts.push(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
  }
  // Promote a handful of class/const names to ctx own-properties so tests can
  // pull them out by `ctx.Simulation` etc. (vm script-locals aren't visible
  // on the context object directly.)
  parts.push(`
    Object.assign(this, {
      // constants / data
      COLS, ROWS, FOODS, FOOD_KEYS, CONFIG,
      ABILITIES, CUSTOMER_ABILITY_ROLL,
      EVENTS, FORECASTS, STARTER_CHEF, CHEF_ROSTER,
      // helpers
      clamp, computeQuality, computeTip,
      abilitiesOf, abilityMult, abilitySum, fireAbilityHook,
      rollDailyEvent, rollBaseForecast, rollCustomerAbilities,
      // sim classes
      Grid, Pathfinder,
      Building, Stove, Table, Chair, Sink, Order,
      Entity, CS, Customer,
      ES, Employee,
      Simulation,
    });
  `);

  vm.runInContext(parts.join('\n'), ctx, { filename: 'sim-bundle.js' });
  return ctx;
}

module.exports = { loadSim, makeRng };
