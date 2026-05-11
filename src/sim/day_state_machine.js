/* ============================================================================
 * sim/day_state_machine.js — day transitions: spawning → draining → dayEnd
 * ============================================================================
 * Extracted from Simulation. Owns no state of its own: dayState, daySpawned,
 * dayQuota, dayStartMoney, spawnTimer, todayProfile, and stats all stay on
 * the parent sim. Three responsibilities:
 *
 *   - tick(dt): drives the spawn timer + draining transition each frame.
 *               Called once per Simulation.update() before entity ticks.
 *   - startNextDay(): consumes the resolved event, advances the day counter,
 *                     resets per-day stats, ticks chef statuses, merges the
 *                     forecast + event profile into todayProfile.
 *   - isDayActive(): convenience read for UI lockouts.
 *
 * The shared profile-merge helper lives on Simulation (_mergeProfile, top of
 * simulation.js); we read it via the constant at module scope.
 * ========================================================================== */

class DayStateMachine {
  constructor(sim) { this.sim = sim; }

  // True while customers are arriving or being drained — used by the UI to
  // gray out / lock layout & hire tools.
  isDayActive() {
    const ds = this.sim.dayState;
    // 'midday_event' is a pure pause overlay — entities don't tick — so UI
    // lockouts still apply (same as dayEnd).
    return ds === 'spawning' || ds === 'draining';
  }

  _computeDayQuota(day) {
    const sim = this.sim;
    const base = CONFIG.dayBaseQuota * Math.pow(CONFIG.dayGrowthFactor, day - 1);
    const mult = (sim.todayProfile && sim.todayProfile.quotaMult) || 1;
    return Math.max(1, Math.ceil(base * mult));
  }

  // Per-frame: drives spawning + draining transitions. dayEnd is a pure
  // pause — sim.update keeps ticking entities, but day progression waits on
  // startNextDay(). Returns nothing; mutates sim.* in place.
  tick(dt) {
    const sim = this.sim;
    if (!sim.spawnEnabled || sim.gameOver) return;
    // Midday-event pause: freeze everything until the modal resolves.
    if (sim.dayState === 'midday_event') return;
    // Mid-service midday roll. One chance per day, gated by a flag the day
    // state machine resets in startNextDay.
    if (sim.eventManager && typeof sim.eventManager.maybeStartMiddayEvent === 'function') {
      sim.eventManager.maybeStartMiddayEvent();
      if (sim.dayState === 'midday_event') return;   // a midday event just opened
    }
    if (sim.dayState === 'spawning') {
      sim.spawnTimer -= dt;
      if (sim.spawnTimer <= 0) {
        // Spawn interval shrinks 0.2s per day past day 1, floored at the
        // configured minimum so the rate never reaches zero. Traffic
        // multiplier (debug knob + scenarios) compounds on top.
        const dayShrink = CONFIG.customerSpawnIntervalPerDay * Math.max(0, sim.day - 1);
        const effectiveInterval = Math.max(
          CONFIG.customerSpawnIntervalMin,
          CONFIG.customerSpawnInterval - dayShrink,
        );
        sim.spawnTimer = effectiveInterval / sim.trafficMultiplier;
        if (sim.daySpawned < sim.dayQuota && sim.spawnCustomer()) {
          sim.daySpawned++;
          if (sim.daySpawned >= sim.dayQuota) sim.dayState = 'draining';
        }
      }
    } else if (sim.dayState === 'draining') {
      if (!sim.customers.some(c => c.alive)) {
        // Status is tick-decremented at end of day so "daysLeft:1" applied
        // during yesterday's dayEnd naturally clears after one full day.
        for (const e of sim.employees) {
          if (e.status) {
            e.status.daysLeft--;
            if (e.status.daysLeft <= 0) e.status = null;
          }
        }
        // Quota-met reputation bonus. Capped at reputationMax.
        if (sim.stats.served >= sim.dayQuota && !sim.debug) {
          sim.reputation = Math.min(sim.reputationMax,
            sim.reputation + (CONFIG.reputationDailyBonus || 0));
        }
        sim.dayState = 'dayEnd';
        // Roll today's event + tomorrow's baseline forecast. The modal
        // reads these; resolveEvent + startNextDay consume them.
        sim.currentEvent  = rollDailyEvent(sim.day);
        sim.nextForecast  = rollBaseForecast();
        sim.eventAssignedChef = null;
        sim.eventOutcome  = null;
      }
    }
  }

  // Player clicks "Start Day" in the modal. Advances day counter, resets
  // per-day stats, ticks chef statuses, and merges the rolled forecast +
  // event profile into todayProfile.
  startNextDay() {
    const sim = this.sim;
    if (sim.dayState !== 'dayEnd') return;
    if (!sim.eventOutcome) return;      // must resolve event first

    // Assemble next day's profile: existing todayProfile (gift-applied multipliers)
    // + base forecast + event profile. We multiply through so a gift like 'big_crowd'
    // stacks with whatever the forecast adds.
    const profile = { ...(sim.todayProfile || {}) };
    _mergeProfile(profile, sim.nextForecast && sim.nextForecast.profile);
    _mergeProfile(profile, sim.eventOutcome.result && sim.eventOutcome.result.profile);
    sim.todayProfile = profile;

    // First start coming out of the boot gift: Day 1 hasn't actually run yet,
    // so we keep day=1 and don't tick daysCompleted. Otherwise the usual bump.
    const firstStart = sim.currentEvent && sim.currentEvent.kind === 'gift';
    if (firstStart) {
      sim._bootEventDone = true;
    } else {
      sim.runStats.daysCompleted++;
      sim.day++;
    }
    sim.dayQuota      = this._computeDayQuota(sim.day);
    sim.daySpawned    = 0;
    sim.spawnTimer    = 0.5;
    sim.dayState      = 'spawning';
    sim.dayStartMoney = sim.money;
    sim.stats         = { served: 0, angry: 0, plates: 0, tipsTotal: 0 };
    // Re-arm the midday roll for the new day. middayEventTriggerAt is
    // re-rolled lazily by EventManager.maybeStartMiddayEvent against the
    // fresh dayQuota.
    sim.middayEventRolledToday = false;
    sim.middayEventTriggerAt   = null;
    sim.middayEvent   = null;
    sim.middayOutcome = null;
    sim.preMiddayState = null;

    for (const e of sim.employees) {
      e.dayStats = { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0 };
      e.career.daysWorked++;
    }

    sim.currentEvent      = null;
    sim.eventAssignedChef = null;
    sim.eventOutcome      = null;
    sim.nextForecast      = null;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { DayStateMachine };
