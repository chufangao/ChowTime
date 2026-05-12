const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');
const { runScenario, demoLayout } = require('../scenario.js');

test('day 1 with demo layout: meets quota, ends in dayEnd, money grows', () => {
  const ctx = loadSim({ seed: 7 });
  const sim = new ctx.Simulation();
  demoLayout(sim);
  sim.trafficMultiplier = 5;   // burst-mode so the test runs quickly

  const result = runScenario(sim, {
    untilDay: 1,
    autoResolveEvents: false,   // we want to inspect dayEnd state
    maxSimSec: 240,
  });

  assert.equal(result.dayState, 'dayEnd', 'day 1 should reach dayEnd');
  assert.equal(result.gameOver, false);
  assert.ok(sim.daySpawned >= sim.dayQuota, 'all quota customers spawned');
  assert.ok(result.money >= ctx.CONFIG.startingMoney, 'demo layout should not lose money on day 1');
  // No customer should be left orphaned in a non-terminal state.
  for (const c of sim.customers) {
    assert.ok(['leaving'].includes(c.state) || c.alive === false,
      `customer left in state ${c.state}`);
  }
});

test('orders all reach a terminal status by dayEnd', () => {
  const ctx = loadSim({ seed: 11 });
  const sim = new ctx.Simulation();
  demoLayout(sim);
  sim.trafficMultiplier = 5;
  runScenario(sim, { untilDay: 1, autoResolveEvents: false, maxSimSec: 240 });

  // sim.orders is filtered each tick to only carry live ones; all served orders
  // are pruned. So the assertion is "no orders linger past dayEnd".
  assert.equal(sim.orders.length, 0, `expected 0 lingering orders, got ${sim.orders.length}`);
});

test('chef accumulates dishes + tips across the day', () => {
  const ctx = loadSim({ seed: 13 });
  const sim = new ctx.Simulation();
  demoLayout(sim);
  sim.trafficMultiplier = 5;
  runScenario(sim, { untilDay: 1, autoResolveEvents: false, maxSimSec: 240 });

  const chef = sim.employees[0];
  assert.ok(chef.dayStats.dishes > 0, 'chef should have served at least one dish');
  assert.ok(chef.career.dishes >= chef.dayStats.dishes);
  assert.ok(chef.dayStats.tipsEarned >= 0);
});

test('hireFromRoster deducts cost and removes entry from pool', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.money = 1000;
  const before = sim.recruitPool.length;
  const target = sim.recruitPool[0];
  const result = sim.hireFromRoster(target.id);
  assert.equal(result.ok, true);
  assert.equal(sim.recruitPool.length, before - 1);
  assert.equal(sim.money, 1000 - target.cost);
  assert.equal(sim.employees.length, 1);
  assert.equal(sim.employees[0].name, target.name);
});

test('placeBuilding rejects on no-money', () => {
  const ctx = loadSim();
  const sim = new ctx.Simulation();
  sim.money = 10;
  const r = sim.placeBuilding('stove', 5, 5);   // costs 150
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-money');
  assert.equal(sim.buildings.length, 0);
});

test('multi-day run: quota grows day-over-day for days actually completed', () => {
  const ctx = loadSim({ seed: 23 });
  const sim = new ctx.Simulation();
  demoLayout(sim);
  sim.trafficMultiplier = 5;

  const quotas = [];
  runScenario(sim, {
    untilDay: 5,
    autoResolveEvents: true,
    maxSimSec: 30 * 60,
    onTick: () => {
      // Snap quota at the start of each day (when daySpawned is fresh).
      if (sim.dayState === 'spawning' && sim.daySpawned === 0) {
        const last = quotas[quotas.length - 1];
        if (!last || last.day !== sim.day) quotas.push({ day: sim.day, quota: sim.dayQuota });
      }
    },
  });

  // Demo layout is small; some seeds will game-over before day 5. Either way,
  // the underlying day quota MUST grow with day number (base * 1.5^(day-1)),
  // even if a forecast quotaMult dampens individual days.
  assert.ok(quotas.length >= 2, `expected to observe ≥2 days, saw ${quotas.length}`);
  const day1Quota = quotas.find(q => q.day === 1).quota;
  const lastQuota = quotas[quotas.length - 1].quota;
  assert.ok(lastQuota >= day1Quota,
    `last quota ${lastQuota} should be ≥ day1 quota ${day1Quota}`);
});

test('event resolution applies status to assigned chef', () => {
  const ctx = loadSim({ seed: 31 });
  const sim = new ctx.Simulation();
  demoLayout(sim);
  // Hire a non-starter so we can verify 'busy' kicks in (starter chefs are
  // immune to busy).
  sim.money = 1000;
  const target = sim.recruitPool[0];
  sim.hireFromRoster(target.id);
  const newChef = sim.employees[sim.employees.length - 1];

  sim.trafficMultiplier = 5;
  runScenario(sim, { untilDay: 1, autoResolveEvents: false, maxSimSec: 240 });
  assert.equal(sim.dayState, 'dayEnd');

  // Resolve the event with the non-starter — they should pick up some status.
  // Pick the first roll choice (every dayEnd event in EVENTS has one).
  const rollIdx = (sim.currentEvent.choices || [])
    .findIndex(c => c.kind === 'roll' || c.kind === 'hybrid');
  assert.ok(rollIdx >= 0, 'event should expose a roll choice');
  sim.resolveDayEndChoice(rollIdx, newChef.id);
  assert.ok(sim.eventOutcome, 'event must resolve');
  assert.ok(newChef.status, 'non-starter chef should pick up a status');
});
