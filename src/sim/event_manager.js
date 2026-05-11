/* ============================================================================
 * sim/event_manager.js — dayEnd event + boot-gift flow
 * ============================================================================
 * Extracted from Simulation. Owns no state of its own: all reads/writes go to
 * the parent sim's fields (currentEvent, eventAssignedChef, eventOutcome,
 * nextForecast, _bootEventDone). Simulation delegates four public methods to
 * this collaborator while keeping the same external signature, so callers
 * (UI apps, save/load, tests) don't need to know the split exists.
 * ========================================================================== */

class EventManager {
  constructor(sim) { this.sim = sim; }

  // Roll the boot-time gift on first inspection. Idempotent; UI surfaces
  // call this before reading currentEvent so the gift appears exactly when
  // the player first sees it. The _bootEventDone guard prevents a fresh gift
  // from being rolled on the frame *after* Begin Run (when day===1 and
  // currentEvent/eventOutcome both transiently === null).
  ensureBootEvent() {
    const sim = this.sim;
    if (sim._bootEventDone) return;
    if (sim.day !== 1 || sim.currentEvent || sim.eventOutcome) return;
    if (typeof rollGiftEvent === 'function') sim.currentEvent = rollGiftEvent();
    if (!sim.nextForecast && typeof rollBaseForecast === 'function') {
      sim.nextForecast = rollBaseForecast();
    }
  }

  // Boot gift: player picks one starting boon. Sets eventOutcome so Start
  // Day unlocks. Only valid while currentEvent is the gift event.
  acceptGift(giftId) {
    const sim = this.sim;
    if (sim.dayState !== 'dayEnd') return null;
    this.ensureBootEvent();
    if (!sim.currentEvent || sim.currentEvent.kind !== 'gift') return null;
    if (sim.eventOutcome) return null;
    const gift = (sim.currentEvent.options || []).find(o => o.id === giftId);
    if (!gift) return null;
    const result = (typeof gift.apply === 'function' ? gift.apply(sim) : null) || {};
    result.giftId = gift.id;
    sim.eventOutcome = {
      passed: true, roll: 0, total: 0, dc: 0,
      chef: null, result, msg: result.msg || gift.label,
    };
    return sim.eventOutcome;
  }

  // List of chefs the player can assign to today's event. Starter chefs are
  // always shown; others must be currently available (not recovering).
  eligibleChefsForEvent() {
    return this.sim.employees.filter(e => e.isStarter || e.isAvailable());
  }

  // Roll the event for an assigned chef and apply its immediate effects
  // (money delta, status). Forecast profile is stashed and applied at
  // startNextDay(). Safe to call only while in 'dayEnd'. Returns outcome
  // summary for the UI.
  resolveEvent(chefId) {
    const sim = this.sim;
    if (sim.dayState !== 'dayEnd' || !sim.currentEvent || sim.eventOutcome) return null;
    const chef = sim.employees.find(e => e.id === chefId);
    if (!chef) return null;
    const ev    = sim.currentEvent;
    const dc    = typeof ev.dc === 'function' ? ev.dc(sim.day) : (ev.dc || 10);
    const roll  = Math.floor(Math.random() * 10) + 1;     // 1..10
    const total = roll + chef.effStat(ev.stat);
    const passed = total >= dc;
    const result = passed ? ev.onPass(sim, chef) : ev.onFail(sim, chef);

    // Default chef status: busy for 1 day (skip tomorrow). Events can override
    // via statusOverride (e.g. 'starstruck'). Starter chefs shrug off any
    // disabling status but still accept positive ones.
    let nextStatus = result.statusOverride || { kind: 'busy', daysLeft: 1 };
    if (chef.isStarter && nextStatus.kind !== 'starstruck') nextStatus = null;
    chef.status = nextStatus;

    sim.eventAssignedChef = chef;
    sim.eventOutcome = {
      passed, roll, total, dc,
      chef, result,
      msg: result.msg || (passed ? 'Success.' : 'Failed.'),
    };
    return sim.eventOutcome;
  }

  /* ------------------------------------------------------------------------
   * Midday event flow. Called from DayStateMachine.tick during 'spawning' /
   * 'draining'. Pauses the day via dayState='midday_event' and writes the
   * event def to sim.middayEvent. The MiddayEventApp auto-opens on that flag
   * and presents the choices.
   * ---------------------------------------------------------------------- */

  // Roll once per day during active service. ~55% chance scaled with day
  // number, capped at 80% — late-game days almost always feature one. Fires
  // partway through the day, NOT on the first spawn. The trigger spawn-count
  // is set when the day starts (sim.middayEventTriggerAt), targeting between
  // 30% and 70% of the day's quota so the event feels mid-service.
  maybeStartMiddayEvent() {
    const sim = this.sim;
    if (sim.middayEventRolledToday) return false;
    if (sim.dayState !== 'spawning' && sim.dayState !== 'draining') return false;
    if (sim.middayEvent || sim.middayOutcome) return false;
    if (sim.gameOver) return false;
    if (typeof rollMiddayEvent !== 'function') return false;

    // Pick a per-day trigger threshold the first time we tick into a fresh
    // day (DayStateMachine resets middayEventTriggerAt to null at startNextDay).
    // We lazily roll it here so we don't depend on DayStateMachine to call us.
    if (sim.middayEventTriggerAt == null) {
      const quota = Math.max(1, sim.dayQuota || 1);
      const lo = Math.max(1, Math.ceil(quota * 0.3));
      const hi = Math.max(lo, Math.floor(quota * 0.7));
      sim.middayEventTriggerAt = lo + Math.floor(Math.random() * (hi - lo + 1));
    }
    if (sim.daySpawned < sim.middayEventTriggerAt) return false;

    const chance = Math.min(0.8, 0.55 + 0.05 * Math.max(0, sim.day - 1));
    sim.middayEventRolledToday = true;
    if (Math.random() >= chance) return false;
    const ev = this._pickMiddayEvent();
    if (!ev) return false;
    this.startMiddayEvent(ev);
    return true;
  }

  // Pick a midday event, excluding any whose id appears in
  // sim._recentMiddayEvents so the player doesn't see the same one twice in
  // a row. We keep the recent window short (≤ half the catalog) so most
  // events stay eligible.
  _pickMiddayEvent() {
    const sim = this.sim;
    if (typeof MIDDAY_EVENTS === 'undefined' || !MIDDAY_EVENTS.length) return null;
    const recent = sim._recentMiddayEvents || [];
    const eligible = MIDDAY_EVENTS.filter(e => recent.indexOf(e.id) < 0);
    const pool = eligible.length ? eligible : MIDDAY_EVENTS;
    const ev = pool[Math.floor(Math.random() * pool.length)];
    // Remember this one. Cap the window at half the catalog so eligibility
    // keeps churning instead of locking us into a shrinking pool.
    const cap = Math.max(1, Math.floor(MIDDAY_EVENTS.length / 2));
    recent.push(ev.id);
    while (recent.length > cap) recent.shift();
    sim._recentMiddayEvents = recent;
    return ev;
  }

  startMiddayEvent(eventDef) {
    const sim = this.sim;
    if (!eventDef) return null;
    if (sim.middayEvent || sim.middayOutcome) return null;
    sim.preMiddayState = sim.dayState;
    sim.dayState       = 'midday_event';
    sim.middayEvent    = eventDef;
    sim.middayOutcome  = null;
    return eventDef;
  }

  // Chef pool for a midday choice. Currently the same as eligibleChefsForEvent
  // (starter chefs plus any non-busy chef). Kept as its own method so the
  // 'busy' suppression rule can diverge later without touching DayEndApp.
  eligibleChefsForMidday(_stat) {
    return this.sim.employees.filter(e => e.isStarter || e.isAvailable());
  }

  // Player picks a choice (and optionally a chef for roll/ability/hybrid).
  // Applies the chosen branch's effects to sim and stores middayOutcome so
  // the modal can render the result. Returns the outcome.
  resolveMiddayChoice(choiceIdx, chefId) {
    const sim = this.sim;
    if (sim.dayState !== 'midday_event' || !sim.middayEvent || sim.middayOutcome) return null;
    const ev = sim.middayEvent;
    const choice = (ev.choices || [])[choiceIdx];
    if (!choice) return null;

    // Cost (pay/hybrid) is checked before anything resolves so a failed pay
    // doesn't half-apply effects. Negative cost == grant.
    const cost = choice.cost || {};
    const moneyCost = cost.money || 0;
    const repCost   = cost.reputation || 0;
    if (moneyCost > 0 && !sim.debug && sim.money < moneyCost) return { error: 'no-money', cost };
    if (repCost   > 0 && !sim.debug && sim.reputation < repCost) return { error: 'no-reputation', cost };

    // Resolve roll/ability before applying anything: a chef may be required.
    const needsChef = (choice.kind === 'roll' || choice.kind === 'ability' || choice.kind === 'hybrid');
    let chef = null;
    if (needsChef) {
      chef = sim.employees.find(e => e.id === chefId);
      if (!chef) return { error: 'no-chef' };
    }

    // Apply cost / grant.
    if (moneyCost) sim.money = Math.max(0, sim.money - moneyCost);
    if (repCost > 0) sim.reputation = Math.max(0, sim.reputation - repCost);
    if (repCost < 0) sim.reputation = Math.min(sim.reputationMax, sim.reputation - repCost);

    let roll = 0, total = 0, dc = 0, passed = true;
    let result;
    if (choice.kind === 'pay') {
      result = (choice.onResolve ? choice.onResolve(sim) : null) || { msg: choice.label };
    } else if (choice.kind === 'ability') {
      const hasAbility = (chef.abilities || []).indexOf(choice.abilityId) >= 0;
      if (!hasAbility) {
        result = (choice.onMissing ? choice.onMissing(sim) : null) ||
          { msg: `${chef.name} doesn't have that ability.` };
        passed = false;
      } else {
        result = (choice.onResolve ? choice.onResolve(sim, chef) : null) || { msg: 'Ability used.' };
      }
    } else if (choice.kind === 'roll' || choice.kind === 'hybrid') {
      dc    = typeof choice.dc === 'function' ? choice.dc(sim.day) : (choice.dc || 10);
      roll  = Math.floor(Math.random() * 10) + 1;
      total = roll + (chef.effStat ? chef.effStat(choice.stat) : 0);
      passed = total >= dc;
      const cb = passed ? choice.onPass : choice.onFail;
      result = (cb ? cb(sim, chef) : null) || { msg: passed ? 'Success.' : 'Failed.' };
    }

    // Status side-effect (if the result returned one and the chef isn't
    // immune). Starter chefs shrug off 'injured'/'busy' but accept positive
    // statuses like 'starstruck'.
    if (chef && result && result.statusOverride) {
      const ns = result.statusOverride;
      if (chef.isStarter && ns.kind !== 'starstruck') {
        // starter chef immune; no-op
      } else {
        chef.status = { ...ns };
      }
    }

    sim.middayOutcome = {
      choiceIdx, kind: choice.kind,
      passed, roll, total, dc,
      chef: chef || null, result,
      msg: result.msg || (passed ? 'Success.' : 'Failed.'),
    };
    return sim.middayOutcome;
  }

  // Player clicks "Continue" on the outcome panel. Restores the prior
  // dayState so service resumes; clears midday state.
  dismissMiddayOutcome() {
    const sim = this.sim;
    if (sim.dayState !== 'midday_event' || !sim.middayOutcome) return false;
    sim.dayState      = sim.preMiddayState || 'spawning';
    sim.preMiddayState = null;
    sim.middayEvent   = null;
    sim.middayOutcome = null;
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { EventManager };
