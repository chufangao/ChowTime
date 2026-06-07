const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

// All midday events must be well-formed (id, choices array, at least one
// choice). The catalog is loaded from data/events_forecasts.js via the harness.
test('MIDDAY_EVENTS catalog is well-formed', () => {
  const ctx = loadSim();
  const list = ctx.MIDDAY_EVENTS;
  assert.ok(Array.isArray(list) && list.length >= 6, 'expected at least 6 midday events');
  for (const ev of list) {
    assert.ok(ev.id && typeof ev.id === 'string');
    assert.ok(ev.title);
    assert.ok(Array.isArray(ev.choices) && ev.choices.length >= 1 && ev.choices.length <= 4);
    for (const c of ev.choices) {
      assert.ok(['pay', 'roll', 'ability', 'hybrid'].indexOf(c.kind) >= 0,
        `bad choice kind: ${c.kind} on ${ev.id}`);
      assert.ok(c.label);
      if (c.kind === 'roll' || c.kind === 'hybrid') {
        assert.ok(c.stat, `${ev.id}: ${c.kind} choice needs .stat`);
      }
    }
  }
});

test('startMiddayEvent pauses the sim and stores the event def', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  // Force into spawning so the pause has somewhere to come back to.
  sim.dayState = 'spawning';
  const ev = ctx.MIDDAY_EVENTS.find(e => e.id === 'grease_fire');
  sim.eventManager.startMiddayEvent(ev);
  assert.equal(sim.dayState, 'midday_event');
  assert.equal(sim.middayEvent, ev);
  assert.equal(sim.preMiddayState, 'spawning');
});

test('resolveMiddayChoice (pay) deducts money and applies onResolve', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.dayState = 'spawning';
  sim.money = 500;
  const ev = ctx.MIDDAY_EVENTS.find(e => e.id === 'grease_fire');
  sim.eventManager.startMiddayEvent(ev);
  // Choice 0 is the $80 pay option.
  const outcome = sim.resolveMiddayChoice(0);
  assert.ok(outcome);
  assert.equal(sim.money, 500 - 80);
  assert.equal(sim.middayOutcome, outcome);
  assert.equal(sim.middayOutcome.kind, 'pay');
});

test('resolveMiddayChoice (pay) refuses when broke', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.dayState = 'spawning';
  sim.money = 10;       // can't afford the $80 option
  const ev = ctx.MIDDAY_EVENTS.find(e => e.id === 'grease_fire');
  sim.eventManager.startMiddayEvent(ev);
  const result = sim.resolveMiddayChoice(0);
  assert.equal(result.error, 'no-money');
  assert.equal(sim.middayOutcome, null);
});

test('resolveMiddayChoice (roll) runs a stat-check and applies pass/fail', () => {
  const ctx = loadSim({ seed: 12 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.dayState = 'spawning';
  // Use an event whose roll choice doesn't have side-effects on furniture
  // (so we can isolate the check result). Critic_walks_in: CHA DC 10.
  const ev = ctx.MIDDAY_EVENTS.find(e => e.id === 'critic_walks_in');
  sim.eventManager.startMiddayEvent(ev);
  const chef = sim.employees[0];
  const outcome = sim.resolveMiddayChoice(1, chef.id);
  assert.ok(outcome);
  assert.equal(outcome.kind, 'roll');
  assert.equal(outcome.chef, chef);
  assert.ok(outcome.roll >= 1 && outcome.roll <= 10);
});

test('dismissMiddayOutcome restores prior dayState and clears state', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.dayState = 'draining';
  const ev = ctx.MIDDAY_EVENTS.find(e => e.id === 'grease_fire');
  sim.money = 500;
  sim.eventManager.startMiddayEvent(ev);
  sim.resolveMiddayChoice(0);
  assert.equal(sim.middayOutcome != null, true);
  sim.dismissMiddayOutcome();
  assert.equal(sim.dayState, 'draining');
  assert.equal(sim.middayEvent, null);
  assert.equal(sim.middayOutcome, null);
});

test('sim does not tick entities while midday_event is active', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  // Set up a cooking stove so we can detect whether time advanced.
  const stove = sim.buildings.find(b => b.type === 'stove');
  const cook = sim.employees[0];
  const order = Object.assign(new ctx.Order({}, 'BURGER'), { cookingEmployee: cook });
  stove.startCooking(order, sim);
  const timeBefore = stove.cooking.timeLeft;

  sim.dayState = 'midday_event';
  sim.middayEvent = ctx.MIDDAY_EVENTS[0];
  sim.update(1.0);
  assert.equal(stove.cooking.timeLeft, timeBefore,
    'stove should not tick during midday_event pause');
});

test('maybeStartMiddayEvent only fires once per day', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.dayState = 'spawning';
  // Lift daySpawned above any possible trigger threshold (which is now
  // 30-70% of dayQuota, set lazily on first call).
  sim.daySpawned = 100;
  // First call may or may not fire (random), but must set the rolledToday gate.
  sim.eventManager.maybeStartMiddayEvent();
  assert.equal(sim.middayEventRolledToday, true);
  // Force-clear any event the first call started and call again — must NOT
  // trigger a second roll regardless of RNG.
  sim.middayEvent = null;
  sim.middayOutcome = null;
  sim.dayState = 'spawning';
  const before = sim.middayEvent;
  sim.eventManager.maybeStartMiddayEvent();
  assert.equal(sim.middayEvent, before, 'second call should not roll');
});

test('midday event does NOT fire on the first spawn (mid-service trigger)', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.dayState = 'spawning';
  sim.dayQuota = 6;
  sim.daySpawned = 1;
  // First call sets the trigger threshold lazily. With dayQuota=6, it's
  // between Math.ceil(6 * 0.3)=2 and Math.floor(6 * 0.7)=4 — strictly > 1.
  sim.eventManager.maybeStartMiddayEvent();
  assert.equal(sim.middayEvent, null, 'should not fire after just one spawn');
  assert.equal(sim.middayEventRolledToday, false, 'gate should NOT trip yet');
  assert.ok(sim.middayEventTriggerAt >= 2, 'trigger threshold should be ≥ 2');
});

test('startNextDay resets the per-day midday trigger threshold', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.middayEventTriggerAt = 999;
  sim.ensureBootEvent();
  if (sim.currentEvent && (sim.currentEvent.choices || []).length) sim.resolveDayEndChoice(0);
  sim.startNextDay();
  assert.equal(sim.middayEventTriggerAt, null);
});

test('_pickMiddayEvent prefers events not in the recent window', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  // Seed recents with all-but-one event id; the only eligible event MUST
  // be picked by the no-repeat selector.
  const lastEv = ctx.MIDDAY_EVENTS[ctx.MIDDAY_EVENTS.length - 1];
  sim._recentMiddayEvents = ctx.MIDDAY_EVENTS.slice(0, -1).map(e => e.id);
  // The recent window is capped at half the catalog so the selector will
  // trim — we expect the un-seen event to still be eligible.
  const picked = sim.eventManager._pickMiddayEvent();
  assert.ok(picked);
  // Picked event should NOT be in the recent set (after the selector's own
  // bookkeeping push; we asserted on the picked id directly).
  assert.equal(picked.id, lastEv.id);
});

test('sim.breakAllBuildings flips every building', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const n = sim.breakAllBuildings();
  assert.ok(n > 0, 'should have broken at least one building');
  for (const b of sim.buildings) assert.equal(b.broken, true);
});

test('startNextDay re-arms the midday roll', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.middayEventRolledToday = true;
  // Drive the boot-gift flow so startNextDay is allowed.
  sim.ensureBootEvent();
  if (sim.currentEvent && (sim.currentEvent.choices || []).length) sim.resolveDayEndChoice(0);
  sim.startNextDay();
  assert.equal(sim.middayEventRolledToday, false);
});

test('freeBuildCredits granted by an event are consumed by placeBuilding', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.money = 0;       // intentionally broke
  sim.freeBuildCredits = ['table', 'chair'];
  // Find an empty tile to place on.
  let placeTile = null;
  for (let y = 0; y < sim.grid.rows && !placeTile; y++) {
    for (let x = 0; x < sim.grid.cols; x++) {
      const t = sim.grid.getTile(x, y);
      if (t && t.type === 'floor' && !t.building) { placeTile = { x, y }; break; }
    }
  }
  assert.ok(placeTile, 'expected an empty floor tile');
  const r = sim.placeBuilding('table', placeTile.x, placeTile.y);
  assert.equal(r.ok, true, 'free-credit placement should succeed despite $0 cash');
  assert.equal(sim.money, 0);
  assert.deepEqual(sim.freeBuildCredits, ['chair']);
});

test('save/load round-trips midday state', () => {
  const ctx = loadSim({ seed: 5 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  sim.dayState = 'dayEnd';     // saves are gated to dayEnd
  sim.middayEventRolledToday = true;
  sim.freeBuildCredits = ['floor', 'table'];
  const json = ctx.serializeSim(sim, null);
  const { sim: loaded } = ctx.deserializeSim(json);
  assert.equal(loaded.middayEventRolledToday, true);
  assert.deepEqual(loaded.freeBuildCredits, ['floor', 'table']);
});
