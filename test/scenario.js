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

  // Suppress midday events by default — most existing scenarios predate
  // mid-service interrupts and break in unpredictable ways when an event
  // (e.g. critic_walks_in) spends reputation and triggers game over partway
  // through. Tests for midday behavior opt back in with enableMidday: true.
  // We replace the maybeStartMiddayEvent method entirely so day transitions
  // can't re-arm the roll.
  if (!opts.enableMidday && sim.eventManager) {
    sim.eventManager.maybeStartMiddayEvent = () => false;
  }

  // Boot state is dayEnd; advance into Day 1 by rolling and auto-picking
  // the first gift choice (the UI does this via the unified event modal;
  // tests skip the UI so we do it here once before driving the loop).
  if (sim.dayState === 'dayEnd' && !sim.eventOutcome) {
    if (typeof sim.ensureBootEvent === 'function') sim.ensureBootEvent();
    if (sim.currentEvent && sim.currentEvent.kind === 'gift') {
      const choices = sim.currentEvent.choices || [];
      if (choices.length) sim.resolveDayEndChoice(0);
      if (sim.eventOutcome) sim.startNextDay();
    }
  }

  let t = 0;
  while (sim.day <= untilDay && !sim.gameOver) {
    while (steps.length && steps[0].at <= t) {
      const step = steps.shift();
      step.do(sim);
    }
    sim.update(dt);
    t += dt;
    if (onTick) onTick(sim, t);

    // Auto-resolve midday events. Always on (independent of
    // autoResolveEvents, which gates dayEnd-event auto-clickthrough) because
    // midday events are an active pause: a test cannot inspect & continue
    // without resolving. Picks the first affordable choice, then dismisses.
    if (sim.dayState === 'midday_event') {
      if (!sim.middayOutcome) {
        const choices = (sim.middayEvent && sim.middayEvent.choices) || [];
        let resolved = false;
        for (let i = 0; i < choices.length && !resolved; i++) {
          const ch = choices[i];
          const cost = ch.cost || {};
          if ((cost.money || 0) > 0 && sim.money < cost.money) continue;
          if ((cost.reputation || 0) > 0 && sim.reputation < cost.reputation) continue;
          if (ch.kind === 'pay') {
            sim.resolveMiddayChoice(i);
            resolved = true;
          } else {
            const chefs = (typeof sim.eligibleChefsForMidday === 'function')
              ? sim.eligibleChefsForMidday(ch.stat) : [];
            if (chefs.length) {
              sim.resolveMiddayChoice(i, chefs[0].id);
              resolved = true;
            }
          }
        }
        // Last-resort: if nothing was affordable/usable, force the first
        // choice through so the test doesn't stall.
        if (!resolved && choices.length) sim.resolveMiddayChoice(0);
      }
      if (sim.middayOutcome) sim.dismissMiddayOutcome();
    }

    if (sim.dayState === 'dayEnd') {
      if (autoResolveEvents) {
        // Click through the modal: find the first roll/hybrid choice and
        // assign the first eligible chef. If none, fall back to the first
        // pay choice. Matches what a player on autopilot would do.
        if (!sim.eventOutcome && sim.currentEvent) {
          const choices = sim.currentEvent.choices || [];
          const rollIdx = choices.findIndex(c => c.kind === 'roll' || c.kind === 'hybrid');
          if (rollIdx >= 0) {
            const eligible = sim.eligibleChefsForEvent();
            if (eligible.length) sim.resolveDayEndChoice(rollIdx, eligible[0].id);
          } else if (choices.length) {
            sim.resolveDayEndChoice(0);
          }
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
    money:      sim.money,
    reputation: sim.reputation,
    day:        sim.day,
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
