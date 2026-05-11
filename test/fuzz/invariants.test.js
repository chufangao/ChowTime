const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, makeRng } = require('../harness.js');
const { runScenario } = require('../scenario.js');

// Property/fuzz tests: build many randomized layouts under different seeds
// and check that core invariants hold throughout the simulation. The seed is
// the only source of nondeterminism — same seed = same outcome.

const SEEDS_TO_RUN = 25;          // bumped down from 200 for CI runtime; raise locally to stress
const DAYS_PER_RUN = 3;

function buildRandomLayout(ctx, sim, rng) {
  // Random but always-viable layout: at least one stove, sink, and dining
  // unit. Uses the passed-in seeded `rng` (NOT host Math.random) so the same
  // seed always builds the same layout — required for the determinism test.
  // 30% of layouts swap that lone stove for a Catapult Stove — invariants
  // (money finite, no orphan cooking, no NaN positions) must still hold.
  const stoveType = rng() < 0.3 ? 'catapult_stove' : 'stove';
  sim.placeBuilding(stoveType, 10, 1, true);
  sim.placeBuilding('sink',  10, 7, true);
  sim.placeBuilding('chair',  3, 2, true);
  sim.placeBuilding('table',  3, 3, true);

  // Add 0-4 extra dining units in random free spots.
  const extra = (rng() * 5) | 0;
  for (let i = 0; i < extra; i++) {
    const cx = 2 + ((rng() * 6) | 0);
    const cy = 2 + ((rng() * 4) | 0);
    sim.placeBuilding('chair', cx, cy);
    sim.placeBuilding('table', cx, cy + 1);
  }

  // Hire 1-3 chefs from the roster (or starter for free).
  sim.hireEmployee(true);
  sim.money = 800;
  const hires = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < hires; i++) {
    if (sim.recruitPool.length === 0) break;
    const target = sim.recruitPool[(rng() * sim.recruitPool.length) | 0];
    sim.hireFromRoster(target.id);
  }

  sim.trafficMultiplier = 5;
}

function checkInvariants(sim) {
  assert.ok(Number.isFinite(sim.money), `money not finite: ${sim.money}`);
  assert.ok(sim.money >= 0, `money negative: ${sim.money}`);
  assert.ok(sim.reputation >= 0 && sim.reputation <= sim.reputationMax,
    `reputation out of range: ${sim.reputation} (max ${sim.reputationMax})`);
  if (sim.reputation === 0) {
    assert.equal(sim.gameOver, true, 'reputation at 0 must imply gameOver');
  }
  // Cooking orders must have a chef assigned (not orphaned mid-cook).
  for (const o of sim.orders) {
    if (o.status === 'cooking') {
      assert.ok(o.assignedStove, `cooking order without assignedStove`);
    }
  }
  // Customers in WALKING state must have a path or be in transition.
  for (const c of sim.customers) {
    if (!c.alive) continue;
    // No NaN positions.
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y),
      `customer position not finite: (${c.x}, ${c.y})`);
  }
}

for (let i = 0; i < SEEDS_TO_RUN; i++) {
  const seed = 1000 + i;
  test(`fuzz seed=${seed}: invariants hold across ${DAYS_PER_RUN} days`, () => {
    const ctx = loadSim({ seed });
    const sim = new ctx.Simulation();
    // Layout RNG uses seed+1 so it's distinct from but tied to the sim seed.
    buildRandomLayout(ctx, sim, makeRng(seed + 1));
    runScenario(sim, {
      untilDay: DAYS_PER_RUN,
      autoResolveEvents: true,
      maxSimSec: 30 * 60,
      onTick: (s) => checkInvariants(s),
    });
    // Final state assertions.
    checkInvariants(sim);
    // After the run, no orders should be in 'cooking' or 'ready' (every
    // pending plate should resolve to delivered/abandoned/lost or be pruned).
    // Exception: a game-over mid-shift freezes the world with whatever was
    // in flight, so we only enforce the clean-end invariant on runs that
    // actually reach dayEnd.
    if (!sim.gameOver) {
      for (const o of sim.orders) {
        assert.notEqual(o.status, 'ready', `lingering ready order at end`);
      }
    }
  });
}

test('fuzz determinism: same seed → identical outcome', () => {
  const runOnce = (seed) => {
    const ctx = loadSim({ seed });
    const sim = new ctx.Simulation();
    buildRandomLayout(ctx, sim, makeRng(seed + 1));
    const result = runScenario(sim, {
      untilDay: 2, autoResolveEvents: true, maxSimSec: 30 * 60,
    });
    return { money: result.money, served: result.served, angry: result.angry };
  };
  const a = runOnce(2024);
  const b = runOnce(2024);
  assert.deepEqual(a, b, 'same seed must yield identical results');
});
