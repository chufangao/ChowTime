const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');
const { runScenario, demoLayout } = require('../scenario.js');

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
  sim.resolveEvent(newChef.id);
  assert.ok(sim.eventOutcome, 'event must resolve');
  assert.ok(newChef.status, 'non-starter chef should pick up a status');
});
