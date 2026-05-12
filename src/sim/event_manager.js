/* ============================================================================
 * sim/event_manager.js — unified event flow (dayEnd, midday, boot gift)
 * ============================================================================
 * Owns no state of its own: all reads/writes go to the parent sim. Three flows
 * all funnel through the same `_applyChoice` helper so the data shape stays
 * uniform across surfaces:
 *
 *   - dayEnd event: rolled in DayStateMachine on entering 'dayEnd'. Stored in
 *     sim.currentEvent. Resolved via resolveDayEndChoice(idx, chefId?) which
 *     writes to sim.eventOutcome. The MiddayEventApp renders the modal — see
 *     its autoOpenWhen for the trigger.
 *
 *   - boot gift: a special dayEnd event (kind:'gift') rolled lazily on first
 *     inspection. Same code path as above; the choices are `kind:'pay'` with
 *     `cost: {}` and an onResolve that calls the gift's apply(sim).
 *
 *   - midday event: fires mid-service via maybeStartMiddayEvent. Stored in
 *     sim.middayEvent. Resolved via resolveMiddayChoice; the dismiss step
 *     restores the prior dayState so service can resume.
 *
 * Every resolution appends to sim.eventHistory (see _logHistoryEntry below).
 * The history is what the Review tab reads to render the per-day log.
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

  // Player picks a choice on the day-end event (regular or boot gift).
  // Writes the outcome to sim.eventOutcome so the Start Day gate unlocks.
  resolveDayEndChoice(choiceIdx, chefId) {
    const sim = this.sim;
    if (sim.dayState !== 'dayEnd' || !sim.currentEvent || sim.eventOutcome) return null;
    const ev = sim.currentEvent;
    const choice = (ev.choices || [])[choiceIdx];
    if (!choice) return null;
    const result = this._applyChoice(ev, choice, chefId);
    if (result && result.error) return result;
    const out = this._toOutcome(choiceIdx, choice, result);
    // Default chef status side-effect for day-end events: busy 1 day if a
    // chef rolled and the choice didn't override status. Keeps quotas /
    // scheduling tuned — playing through an event costs you that chef
    // tomorrow. Starter chefs shrug off plain 'busy'.
    if (out.chef && (choice.kind === 'roll' || choice.kind === 'hybrid' || choice.kind === 'ability')
        && !(result && result.statusOverride)) {
      let nextStatus = { kind: 'busy', daysLeft: 1 };
      if (out.chef.isStarter) nextStatus = null;
      if (nextStatus !== null) out.chef.status = nextStatus;
    }
    sim.eventOutcome = out;
    this._logHistoryEntry({ when: 'dayEnd', event: ev, choice, outcome: out });
    return out;
  }

  // List of chefs the player can assign to today's event. Starter chefs are
  // always shown; others must be currently available (not recovering).
  eligibleChefsForEvent() {
    return this.sim.employees.filter(e => e.isStarter || e.isAvailable());
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

  _pickMiddayEvent() {
    const sim = this.sim;
    if (typeof MIDDAY_EVENTS === 'undefined' || !MIDDAY_EVENTS.length) return null;
    const recent = sim._recentMiddayEvents || [];
    const eligible = MIDDAY_EVENTS.filter(e => recent.indexOf(e.id) < 0);
    const pool = eligible.length ? eligible : MIDDAY_EVENTS;
    const ev = pool[Math.floor(Math.random() * pool.length)];
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

  eligibleChefsForMidday(_stat) {
    return this.sim.employees.filter(e => e.isStarter || e.isAvailable());
  }

  resolveMiddayChoice(choiceIdx, chefId) {
    const sim = this.sim;
    if (sim.dayState !== 'midday_event' || !sim.middayEvent || sim.middayOutcome) return null;
    const ev = sim.middayEvent;
    const choice = (ev.choices || [])[choiceIdx];
    if (!choice) return null;
    const result = this._applyChoice(ev, choice, chefId);
    if (result && result.error) return result;
    const out = this._toOutcome(choiceIdx, choice, result);
    sim.middayOutcome = out;
    this._logHistoryEntry({ when: 'midday', event: ev, choice, outcome: out });
    return out;
  }

  dismissMiddayOutcome() {
    const sim = this.sim;
    if (sim.dayState !== 'midday_event' || !sim.middayOutcome) return false;
    sim.dayState      = sim.preMiddayState || 'spawning';
    sim.preMiddayState = null;
    sim.middayEvent   = null;
    sim.middayOutcome = null;
    return true;
  }

  /* ------------------------------------------------------------------------
   * Shared helpers
   * ---------------------------------------------------------------------- */

  // Apply cost, resolve roll/ability/hybrid, return a result envelope with
  // { passed, roll, total, dc, chef, result } — or { error } if a guard
  // failed (no money, no chef, etc). Caller wraps it into the appropriate
  // outcome field (eventOutcome vs middayOutcome) and applies any status
  // side-effects.
  _applyChoice(ev, choice, chefId) {
    const sim = this.sim;
    const cost = choice.cost || {};
    const moneyCost = cost.money || 0;
    const repCost   = cost.reputation || 0;
    if (moneyCost > 0 && !sim.debug && sim.money < moneyCost) return { error: 'no-money', cost };
    if (repCost   > 0 && !sim.debug && sim.reputation < repCost) return { error: 'no-reputation', cost };

    const needsChef = (choice.kind === 'roll' || choice.kind === 'ability' || choice.kind === 'hybrid');
    let chef = null;
    if (needsChef) {
      chef = sim.employees.find(e => e.id === chefId);
      if (!chef) return { error: 'no-chef' };
    }

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

    return { passed, roll, total, dc, chef, result };
  }

  _toOutcome(choiceIdx, choice, applied) {
    return {
      choiceIdx, kind: choice.kind,
      passed: applied.passed, roll: applied.roll, total: applied.total, dc: applied.dc,
      chef: applied.chef || null,
      result: applied.result,
      msg: (applied.result && applied.result.msg)
        ? applied.result.msg
        : (applied.passed ? 'Success.' : 'Failed.'),
    };
  }

  // Append one entry per resolution. The Review tab renders these. Kept
  // small (no live chef ref — store name + id) so the log survives save/load
  // round-trips and so a deleted chef doesn't keep a stale reference.
  _logHistoryEntry({ when, event, choice, outcome }) {
    const sim = this.sim;
    if (!Array.isArray(sim.eventHistory)) sim.eventHistory = [];
    const isRoll = (outcome.kind === 'roll' || outcome.kind === 'hybrid');
    sim.eventHistory.push({
      day:        sim.day,
      when,                              // 'dayEnd' | 'midday'
      eventId:    event.id,
      eventIcon:  event.icon || '',
      eventTitle: event.title || event.id || 'Event',
      kind:       outcome.kind,
      choiceLabel: choice.label || '',
      chefId:     outcome.chef ? outcome.chef.id : null,
      chefName:   outcome.chef ? outcome.chef.name : null,
      passed:     !!outcome.passed,
      isRoll,
      roll:       outcome.roll || 0,
      total:      outcome.total || 0,
      dc:         outcome.dc || 0,
      msg:        outcome.msg || '',
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { EventManager };
