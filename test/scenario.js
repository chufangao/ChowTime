// Scripted "user simulation" runner. A scenario is a list of timed actions
// the player would take through the UI (place buildings, hire chefs, resolve
// events, click Start Day) plus an exit condition (run until day N or sim ends).
// Wraps sim.update so tests can observe outcomes deterministically.

function runScenario(sim, opts) {
  const dt        = opts.dt        || 1/30;
  const untilDay  = opts.untilDay  || 1;
  const maxSimSec = opts.maxSimSec || 60 * 60;   // 1 hour of sim time
  const steps     = (opts.steps || []).slice().sort((a, b) => a.at - b.at);
  const onTick    = opts.onTick;                   // optional hook for invariants

  // Auto-resolve event modal & advance day so single-day scenarios still
  // terminate. Defaults true for ergonomics; set false to drive manually.
  const autoResolveEvents = opts.autoResolveEvents !== false;

  let t = 0;
  while (sim.day <= untilDay && !sim.gameOver) {
    while (steps.length && steps[0].at <= t) {
      const step = steps.shift();
      step.do(sim);
    }
    sim.update(dt);
    t += dt;
    if (onTick) onTick(sim, t);

    if (sim.dayState === 'dayEnd') {
      if (autoResolveEvents) {
        // Pick the first eligible chef and click through the modal.
        const eligible = sim.eligibleChefsForEvent();
        if (eligible.length && !sim.eventOutcome) {
          sim.resolveEvent(eligible[0].id);
        }
        if (sim.eventOutcome && sim.day < untilDay) {
          sim.startNextDay();
        } else if (sim.eventOutcome && sim.day >= untilDay) {
          break;   // reached target day's dayEnd; stop before advancing past it
        }
      } else if (sim.day >= untilDay) {
        // Manual mode: caller wants to inspect dayEnd state. Stop here.
        break;
      }
    }
    if (t > maxSimSec) {
      throw new Error(`scenario exceeded maxSimSec=${maxSimSec}; likely a stuck state`);
    }
  }
  return {
    endTime: t,
    money:   sim.money,
    lives:   sim.lives,
    day:     sim.day,
    dayState: sim.dayState,
    served:  sim.runStats.served,
    angry:   sim.runStats.angry,
    daysCompleted: sim.runStats.daysCompleted,
    gameOver: sim.gameOver,
  };
}

// Convenience: standard layout the demo seeds (3 stoves, 2 sinks, 4 dining
// units, 1 starter chef). Useful as a baseline for scenarios that want to
// focus on player actions, not setup.
function demoLayout(sim) {
  sim.seedDemo();
}

module.exports = { runScenario, demoLayout };
