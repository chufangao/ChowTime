/* ============================================================================
 * test/unit/save_load.test.js — Round-trip a Simulation through save/load
 * ============================================================================
 * Builds a sim, runs scripted actions to reach dayState='dayEnd' (the only
 * state at which saves are allowed), serializes, deserializes into a fresh
 * sim, and asserts the describeSim() projections match.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');
const { runScenario, demoLayout } = require('../scenario.js');

function tickToDayEnd(ctx) {
  const sim = new ctx.Simulation();
  demoLayout(sim);
  // Run until we reach dayEnd. spawnEnabled and quota guarantee termination
  // within ~1 day; cap at 5 days for safety.
  runScenario(sim, { untilDay: 2, dt: 1 / 30 });
  // After day 1's dayEnd, runScenario auto-resolves the event and starts
  // the next day. Stop us at the START of day 2 by re-driving until dayEnd
  // again — but the second untilDay-2 call returns immediately.
  // Manually drive forward into the next dayEnd. Auto-resolve any midday
  // event that fires (mirrors scenario.js's auto-handling) so the loop
  // doesn't stall on the pause modal.
  let safety = 60000;     // ~50 minutes of sim time at dt=0.05
  while (sim.dayState !== 'dayEnd' && !sim.gameOver && safety-- > 0) {
    sim.update(0.05);
    if (sim.dayState === 'midday_event') {
      if (!sim.middayOutcome) {
        const choices = (sim.middayEvent && sim.middayEvent.choices) || [];
        // Pick first pay-only choice that's affordable; fall back to the
        // first choice with a usable chef.
        let resolved = false;
        for (let i = 0; i < choices.length && !resolved; i++) {
          const ch = choices[i];
          if (ch.kind === 'pay') {
            const c = ch.cost || {};
            if ((c.money || 0) > 0 && sim.money < c.money) continue;
            if ((c.reputation || 0) > 0 && sim.reputation < c.reputation) continue;
            sim.resolveMiddayChoice(i);
            resolved = true;
          }
        }
        if (!resolved && choices.length) {
          const ch = choices[0];
          const chefs = sim.eligibleChefsForMidday && sim.eligibleChefsForMidday(ch.stat);
          if (chefs && chefs.length) sim.resolveMiddayChoice(0, chefs[0].id);
          else sim.resolveMiddayChoice(0);
        }
      }
      if (sim.middayOutcome) sim.dismissMiddayOutcome();
    }
  }
  return sim;
}

test('save/load round-trip preserves describe-equivalent state', () => {
  const ctx = loadSim({ seed: 6 });
  const sim1 = tickToDayEnd(ctx);
  // Confirm we're at dayEnd as expected.
  assert.equal(sim1.dayState, 'dayEnd', 'precondition: should be at dayEnd');

  const json = ctx.serializeSim(sim1, { activeAppId: 'day_end' });
  // JSON-safe round-trip
  const blob = JSON.parse(JSON.stringify(json));
  assert.equal(blob.version, 2);
  // sim2 must be built in the SAME ctx so deserialize finds Simulation/Employee.
  const { sim: sim2, uiState } = ctx.deserializeSim(blob);
  assert.deepEqual(uiState, { activeAppId: 'day_end' });

  const d1 = JSON.parse(JSON.stringify(ctx.describeSim(sim1)));
  const d2 = JSON.parse(JSON.stringify(ctx.describeSim(sim2)));
  assert.deepEqual(d2, d1);
});

test('after load, sim continues to tick without throwing', () => {
  const ctx = loadSim({ seed: 9 });
  const sim1 = tickToDayEnd(ctx);
  const blob = JSON.parse(JSON.stringify(ctx.serializeSim(sim1, null)));
  const { sim: sim2 } = ctx.deserializeSim(blob);

  // Resolve the event with whatever chef is eligible, then start next day.
  const chef = sim2.eligibleChefsForEvent()[0];
  assert.ok(chef, 'should have an eligible chef to assign');
  // Resolve via the first roll choice in the unified-format dayEnd event.
  const rollIdx = (sim2.currentEvent.choices || [])
    .findIndex(c => c.kind === 'roll' || c.kind === 'hybrid');
  assert.ok(rollIdx >= 0, 'dayEnd event should expose a roll choice');
  sim2.resolveDayEndChoice(rollIdx, chef.id);
  sim2.startNextDay();
  assert.equal(sim2.dayState, 'spawning');
  // Tick a bit; must not throw, must continue producing customers.
  for (let i = 0; i < 200; i++) sim2.update(0.05);
  assert.ok(sim2.day >= 2);
});

test('serialize includes building/employee/recruitPool counts that match the live sim', () => {
  const ctx = loadSim({ seed: 10 });
  const sim = tickToDayEnd(ctx);
  const json = ctx.serializeSim(sim, null);
  assert.equal(json.sim.buildings.length, sim.buildings.length);
  assert.equal(json.sim.employees.length, sim.employees.length);
  assert.equal(json.sim.recruitPool.length, sim.recruitPool.length);
});

test('describeSim is stable for a given sim', () => {
  const ctx = loadSim({ seed: 11 });
  const sim = tickToDayEnd(ctx);
  const a = JSON.parse(JSON.stringify(ctx.describeSim(sim)));
  const b = JSON.parse(JSON.stringify(ctx.describeSim(sim)));
  assert.deepEqual(a, b);
});
