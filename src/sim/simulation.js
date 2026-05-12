/* ============================================================================
 * sim/simulation.js — Simulation root: ticks the world, holds money/lives/day,
 * routes player actions (place/move/remove buildings, hire chefs, resolve events)
 * ============================================================================ */

/* ---- Profile merge helper -------------------------------------------------
 * Merges `delta` into `base` in place. The three multiplier keys stack
 * multiplicatively so e.g. a forecast tipMult and an event tipMult compound;
 * everything else (foodBias, label, etc.) is a straight overwrite. The
 * special key 'label' is dropped — labels are presentation-only and shouldn't
 * leak into the runtime profile.
 */
const _MULT_KEYS = new Set(['tipMult', 'quotaMult', 'cookTimeMult']);
function _mergeProfile(base, delta) {
  if (!delta) return base;
  for (const k of Object.keys(delta)) {
    if (k === 'label') continue;
    if (_MULT_KEYS.has(k)) base[k] = (base[k] || 1) * delta[k];
    else                   base[k] = delta[k];
  }
  return base;
}

/* ---- Simulation root ------------------------------------------------------- */
class Simulation {
  constructor() {
    this.grid = new Grid(COLS, ROWS);
    this.pathfinder = new Pathfinder(this.grid);
    this.buildings = []; this.customers = []; this.employees = []; this.orders = [];
    this.time = 0; this.spawnTimer = 1; this.spawnEnabled = true;
    this.trafficMultiplier = 1;
    this.money = CONFIG.startingMoney;
    this.stats = { served: 0, angry: 0, plates: 0, tipsTotal: 0 };
    // Run-level totals + reputation. Reputation drops when a customer leaves
    // angry from maxed-out rage (not from furniture being yanked — that's the
    // player's own doing). At zero, sim.gameOver is set and spawning halts.
    // Hitting the daily quota grants a small reputation regen at end of day.
    this.runStats = { served: 0, angry: 0, plates: 0, tipsTotal: 0, daysCompleted: 0 };
    this.reputationMax = CONFIG.reputationMax;
    this.reputation    = CONFIG.reputationStart;
    this.gameOver = false;
    // Debug mode: free building/hiring and angry customers don't drop reputation.
    // Toggled from the sidebar; off by default so normal play is unaffected.
    this.debug    = false;
    // The id of the layout template applied at boot (set by applyLayout in
    // src/data/layouts.js). Null until seedDemo runs.
    this.layoutId = null;
    this.day           = 1;
    this.daySpawned    = 0;
    this.dayStartMoney = CONFIG.startingMoney;
    this.todayProfile  = {};            // applied on day start: foodBias, quotaMult, tipMult, cookTimeMult
    // Collaborators that own cohesive sub-flows. Both are stateless (all
    // state stays on `this`); they exist so the methods physically live in
    // their own files. Constructed BEFORE _computeDayQuota — that forwarder
    // is invoked on the next line.
    this.eventManager     = new EventManager(this);
    this.dayStateMachine  = new DayStateMachine(this);
    this.dayQuota      = this._computeDayQuota(1);
    this.dayState      = 'dayEnd';      // 'spawning' | 'draining' | 'dayEnd'
    // Free-hire credits granted by the 'free_hire' gift; consumed by hireFromRoster.
    this._freeHireCredits = 0;

    // Between-day pause state. currentEvent and nextForecast are rolled on
    // entry to 'dayEnd'; eventOutcome is filled when the player picks a
    // chef (or a gift). The boot gift is rolled lazily on first inspection
    // — see ensureBootEvent — so headless tests that bypass the UI don't
    // burn host RNG.
    this.currentEvent     = null;
    this.eventOutcome     = null;        // {passed, roll, chef, result}
    this.nextForecast     = null;

    // Midday event state (fires mid-service via DayStateMachine.tick).
    //   middayEvent           — the active event definition, or null
    //   middayOutcome         — set once resolveMiddayChoice fires; modal
    //                           renders the outcome panel and waits for
    //                           dismissMiddayOutcome to clear it
    //   middayEventRolledToday — gate so we roll at most once per day
    //   preMiddayState        — dayState saved before the pause so we can
    //                           restore on dismiss
    //   freeBuildCredits      — array of building type ids the player can
    //                           place for free in BuildApp (consumed FIFO)
    this.middayEvent          = null;
    this.middayOutcome        = null;
    this.middayEventRolledToday = false;
    // Spawn-count threshold for this day's midday roll. Lazily set inside
    // EventManager.maybeStartMiddayEvent on the first tick of the day so we
    // can use the actual dayQuota (which depends on profile multipliers).
    this.middayEventTriggerAt = null;
    this.preMiddayState       = null;
    this.freeBuildCredits     = [];
    // Recently-fired midday event ids — keeps the next roll from picking
    // anything in this set so the player doesn't see the same event back-to-
    // back. Cleared once we've seen most of the catalog.
    this._recentMiddayEvents  = [];
    // Set true the first time the boot gift is consumed and Day 1 starts.
    // Without this, ensureBootEvent would re-roll a fresh gift event the very
    // next frame after Begin Run, because day===1, currentEvent===null,
    // eventOutcome===null all transiently re-line up.
    this._bootEventDone   = false;

    // Per-run event history. One entry per resolution (dayEnd or midday).
    // The Review tab reads this for its log; it survives save/load. Entries
    // store chef name+id rather than a live ref so a deleted chef doesn't
    // dangle. See EventManager._logHistoryEntry for the entry shape.
    this.eventHistory = [];

    // Popup queue for real-time ability floaters. Each entry is aged in
    // update() and rendered by Sprites.popups. Unique ids prevent text-pool
    // key collisions when the same entity fires multiple popups.
    this.popups     = [];
    this._popupSeq  = 0;

    // Live food in the air from catapult stoves. Each entry carries its own
    // resolve(sim) closure (built in buildings.js) so simulation.js stays
    // generic — we only tick age and call resolve when it lands.
    this.projectiles = [];

    // Default door pre-applyLayout. Replaced by applyLayout() in seedDemo;
    // kept here so a bare `new Simulation()` (used by save_load before it
    // replays the saved layout) is internally consistent. spawnTile/exitTile
    // are kept as live getters returning spawnTiles[0] (the "primary" door).
    this.spawnTiles = [{ x: 0, y: 4 }];
    this.grid.setType(0, 4, 'spawn');

    // Live recruit pool. Each entry carries an `id` (stable across the run)
    // used by the UI to identify the chef clicked. Shuffle so the player sees
    // a different order every session; removed on hire so every chef is unique.
    this.recruitPool = CHEF_ROSTER
      .map((e, i) => ({ ...e, id: i }))
      .sort(() => Math.random() - 0.5);
  }

  // Back-compat: code that predates multi-door reads sim.spawnTile / sim.exitTile.
  // Both resolve to the primary (first) door so single-door behavior is unchanged.
  get spawnTile() { return this.spawnTiles[0]; }
  get exitTile()  { return this.spawnTiles[0]; }

  // Pick a random door for a new arrival.
  randomSpawn() {
    const arr = this.spawnTiles;
    return arr[(Math.random() * arr.length) | 0];
  }

  // Pick the door closest (Manhattan) to (x, y). Used by customers leaving the
  // restaurant — they head to whichever door they're nearest, not a fixed exit.
  closestSpawn(x, y) {
    let best = this.spawnTiles[0], bestD = Infinity;
    for (const d of this.spawnTiles) {
      const md = Math.abs(d.x - x) + Math.abs(d.y - y);
      if (md < bestD) { bestD = md; best = d; }
    }
    return best;
  }

  seedDemo() {
    // Roll a random layout template, paint gaps, set the doors, and place the
    // bare-minimum starter kit (1 stove, 1 sink, 1 table, 1 chair). The
    // template guarantees every starter is reachable from at least one door.
    // Bare default door at (0,4) gets overwritten by applyLayout.
    for (const d of this.spawnTiles) {
      if (this.grid.getTile(d.x, d.y)) this.grid.setType(d.x, d.y, 'floor');
    }
    if (typeof pickRandomLayout === 'function' && typeof applyLayout === 'function') {
      applyLayout(this, pickRandomLayout());
    }
    this.hireEmployee(true);
  }

  // Wipe the current layout (walls + spawn + every building) and apply a fresh
  // one. Used by the Reroll app to swap in a procedurally generated layout
  // without restarting the game. Cold-zone only: a live shift has customers
  // and orders that can't be cleanly torn down, and gameplay invariants
  // (e.g. an employee mid-walk) would break.
  replaceLayout(layout) {
    if (this.dayState !== 'dayEnd') return { ok: false, reason: 'live-service' };
    const doors = layout && (layout.doors || (layout.door ? [layout.door] : null));
    if (!layout || !doors || !layout.starters) return { ok: false, reason: 'bad-layout' };
    // Remove every building. Iterate a snapshot of positions because
    // grid.removeBuildingAt mutates this.buildings via removeBuildingAt's path.
    const positions = this.buildings.map(b => ({ x: b.x, y: b.y }));
    for (const p of positions) {
      const b = this.grid.removeBuildingAt(p.x, p.y);
      if (b && typeof b.onRemoved === 'function') b.onRemoved(this);
    }
    this.buildings.length = 0;
    // Zap walls, gaps, and the current spawn tiles back to floor — bypassing
    // the cost-charging player paths.
    for (let y = 0; y < this.grid.rows; y++) {
      for (let x = 0; x < this.grid.cols; x++) {
        const t = this.grid.getTile(x, y);
        if (!t) continue;
        if (t.type === 'wall') { this.grid.setType(x, y, 'floor'); t.wallKind = null; }
        else if (t.type === 'gap' || t.type === 'spawn') { this.grid.setType(x, y, 'floor'); }
      }
    }
    if (typeof applyLayout === 'function') applyLayout(this, layout);
    return { ok: true };
  }

  placeBuilding(type, x, y, free = false) {
    if (!this.grid.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
    const tile = this.grid.getTile(x, y);
    if (tile.building) return { ok: false, reason: 'occupied' };
    if (tile.type === 'spawn') return { ok: false, reason: 'blocks-door' };
    if (tile.type === 'wall')  return { ok: false, reason: 'wall' };
    if (tile.type === 'gap')   return { ok: false, reason: 'gap' };
    const cost = CONFIG.costs[type];
    // Free-build credits (granted by midday events). Consumed FIFO before any
    // money check, so the player can place even when broke.
    const creditIdx = (this.freeBuildCredits || []).indexOf(type);
    const useCredit = creditIdx >= 0;
    if (!free && !useCredit && !this.debug && this.money < cost) return { ok: false, reason: 'no-money' };
    let b;
    if      (type === 'stove') b = new Stove();
    else if (type === 'catapult_stove') b = new CatapultStove();
    else if (type === 'table') b = new Table();
    else if (type === 'chair') b = new Chair();
    else if (type === 'sink')  b = new Sink();
    else return { ok: false, reason: 'bad-type' };
    if (!this.grid.placeBuilding(b, x, y)) return { ok: false, reason: 'grid-reject' };
    this.buildings.push(b); b.onPlaced(this);
    if (useCredit) {
      this.freeBuildCredits.splice(creditIdx, 1);
    } else if (!free && !this.debug) {
      this.money -= cost;
    }
    return { ok: true };
  }

  // Move an existing building from (fx,fy) to (tx,ty), preserving the
  // instance so state (e.g., a plate on a table, a cooking stove) stays
  // intact. Refuses when the target is occupied or the source is mid-task —
  // moving a stove mid-cook would orphan the order.
  // Cost: free for tables and chairs; CONFIG.costs.move_furniture for
  // everything else (stoves, sinks, catapult). Player walls are moved via
  // moveWall (also free).
  moveBuilding(fx, fy, tx, ty) {
    if (fx === tx && fy === ty) return { ok: false, reason: 'same-tile' };
    const src = this.grid.getTile(fx, fy);
    if (!src || !src.building) return { ok: false, reason: 'empty-source' };
    const b = src.building;
    if ((b.type === 'stove' || b.type === 'catapult_stove') && (b.cooking || b.reservedFor)) return { ok: false, reason: 'busy' };
    if (b.type === 'sink'  && (b.washing || b.reservedFor)) return { ok: false, reason: 'busy' };
    if (b.type === 'chair' && b.occupyingCustomer)          return { ok: false, reason: 'busy' };
    if (b.type === 'table' && (b.occupyingCustomer || b.cleaningAssigned)) return { ok: false, reason: 'busy' };
    if (!this.grid.inBounds(tx, ty)) return { ok: false, reason: 'out-of-bounds' };
    const dst = this.grid.getTile(tx, ty);
    if (!dst || dst.type === 'wall') return { ok: false, reason: 'out-of-bounds' };
    if (dst.type === 'gap')   return { ok: false, reason: 'gap' };
    if (dst.type === 'spawn') return { ok: false, reason: 'blocks-door' };
    if (dst.building)         return { ok: false, reason: 'occupied' };
    const moveCost = (b.type === 'table' || b.type === 'chair') ? 0 : (CONFIG.costs.move_furniture || 0);
    if (moveCost > 0 && !this.debug && this.money < moveCost) return { ok: false, reason: 'no-money' };
    // Pop off source tile, drop on target. grid.placeBuilding reuses the
    // existing instance; it does not allocate.
    this.grid.removeBuildingAt(fx, fy);
    this.grid.placeBuilding(b, tx, ty);
    if (moveCost > 0 && !this.debug) this.money -= moveCost;
    return { ok: true };
  }

  removeBuildingAt(x, y) {
    const b = this.grid.removeBuildingAt(x, y); if (!b) return false;
    b.onRemoved(this);
    const i = this.buildings.indexOf(b); if (i >= 0) this.buildings.splice(i, 1);
    // Layout edits can only happen during dayEnd (enforced in the scene's
    // input layer), when no customers are alive — so occupyingCustomer is
    // always null here and no evict path is needed.
    this.money += Math.floor((CONFIG.costs[b.type] || 0) * CONFIG.refundRatio);
    return true;
  }

  // Debug helper: flip every building's broken flag on. Used by the Settings
  // panel's "Break All" button so the player can exercise the Repair tool
  // and the visual overlay end-to-end. Counts how many were toggled.
  breakAllBuildings() {
    let n = 0;
    for (const b of this.buildings) {
      if (!b.broken) { b.broken = true; n++; }
    }
    return n;
  }

  // Mark a random non-broken building as broken. Used by midday-event penalty
  // branches. Returns the affected building (for popup/feedback) or null when
  // there's nothing eligible to break.
  breakRandomBuilding(typeFilter) {
    const eligible = this.buildings.filter(b => !b.broken &&
      (!typeFilter || typeFilter === b.type ||
       (Array.isArray(typeFilter) && typeFilter.indexOf(b.type) >= 0)));
    if (!eligible.length) return null;
    const b = eligible[(Math.random() * eligible.length) | 0];
    b.broken = true;
    this.emitPopup(b, '💥', 'Broken!');
    return b;
  }

  // Player repair: half the purchase price clears the broken flag. Returns
  // a result object with ok and (when failing) a reason. Called by RepairApp.
  repairBuilding(x, y) {
    if (!this.grid.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
    const t = this.grid.getTile(x, y);
    if (!t || !t.building) return { ok: false, reason: 'no-building' };
    const b = t.building;
    if (!b.broken) return { ok: false, reason: 'not-broken' };
    const base = CONFIG.costs[b.type] || 0;
    const cost = Math.ceil(base * 0.5);
    if (!this.debug && this.money < cost) return { ok: false, reason: 'no-money', cost };
    if (!this.debug) this.money -= cost;
    b.broken = false;
    this.emitPopup(b, '🔧', `Repaired -$${cost}`);
    return { ok: true, cost };
  }

  // Paint a player partition wall. Free, sight-blocking, and removable for free.
  // Heavy structural walls no longer exist — default-layout obstacles are gaps.
  placeWall(x, y, _kind = 'player') {
    if (!this.grid.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
    const t = this.grid.getTile(x, y);
    if (t.type === 'spawn')  return { ok: false, reason: 'blocks-door' };
    if (t.type === 'wall')   return { ok: false, reason: 'occupied' };
    if (t.type === 'gap')    return { ok: false, reason: 'gap' };
    if (t.building)          return { ok: false, reason: 'occupied' };
    const cost = CONFIG.costs.player_wall || 0;
    if (cost > 0 && !this.debug && this.money < cost) return { ok: false, reason: 'no-money' };
    this.grid.setType(x, y, 'wall');
    t.wallKind = 'player';
    if (cost > 0 && !this.debug) this.money -= cost;
    return { ok: true };
  }

  // Demolish a (player) wall tile. Always free.
  removeWallAt(x, y) {
    if (!this.grid.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
    const t = this.grid.getTile(x, y);
    if (t.type !== 'wall') return { ok: false, reason: 'not-wall' };
    this.grid.setType(x, y, 'floor');
    t.wallKind = null;
    return { ok: true };
  }

  // Fill a default-layout gap with floor. Costs CONFIG.costs.floor ($150).
  // The "buy a floor tile" action that replaces the old "demolish wall".
  placeFloor(x, y) {
    if (!this.grid.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
    const t = this.grid.getTile(x, y);
    if (t.type !== 'gap') return { ok: false, reason: 'not-gap' };
    const cost = CONFIG.costs.floor || 0;
    const creditIdx = (this.freeBuildCredits || []).indexOf('floor');
    const useCredit = creditIdx >= 0;
    if (cost > 0 && !useCredit && !this.debug && this.money < cost) return { ok: false, reason: 'no-money' };
    this.grid.setType(x, y, 'floor');
    if (useCredit) this.freeBuildCredits.splice(creditIdx, 1);
    else if (cost > 0 && !this.debug) this.money -= cost;
    return { ok: true };
  }

  // Seeds the demo with two starter chefs. The roster-based path is
  // hireFromRoster — this legacy method is only used by seedDemo.
  hireEmployee(free = false) {
    if (!free && !this.debug && this.money < CONFIG.costs.employee) return false;
    if (!free && !this.debug) this.money -= CONFIG.costs.employee;
    this.employees.push(new Employee(this.spawnTile.x, this.spawnTile.y, STARTER_CHEF));
    return true;
  }

  // Recruit from the modal. entryId matches the `id` field on a recruitPool
  // entry; we look it up instead of indexing so clicks remain valid if other
  // hires mutated the array underfoot. Returns {ok, reason} for the UI.
  hireFromRoster(entryId) {
    const idx = this.recruitPool.findIndex(e => e.id === entryId);
    if (idx < 0) return { ok: false, reason: 'gone' };
    const entry = this.recruitPool[idx];
    const useFree = this._freeHireCredits > 0;
    if (!useFree && !this.debug && this.money < entry.cost) return { ok: false, reason: 'no-money' };
    if (useFree)             this._freeHireCredits--;
    else if (!this.debug)    this.money -= entry.cost;
    this.recruitPool.splice(idx, 1);
    this.employees.push(new Employee(this.spawnTile.x, this.spawnTile.y, entry));
    return { ok: true };
  }

  // ---- Day-state + event flow forwarders --------------------------------
  // Bodies live in src/sim/day_state_machine.js and src/sim/event_manager.js.
  // Kept on Simulation as thin pass-throughs so UI/save/load/test callers
  // see the same public surface they always have.
  isDayActive()             { return this.dayStateMachine.isDayActive(); }
  startNextDay()            { return this.dayStateMachine.startNextDay(); }
  _computeDayQuota(day)     { return this.dayStateMachine._computeDayQuota(day); }
  ensureBootEvent()         { return this.eventManager.ensureBootEvent(); }
  resolveDayEndChoice(choiceIdx, chefId) { return this.eventManager.resolveDayEndChoice(choiceIdx, chefId); }
  eligibleChefsForEvent()   { return this.eventManager.eligibleChefsForEvent(); }
  resolveMiddayChoice(choiceIdx, chefId) { return this.eventManager.resolveMiddayChoice(choiceIdx, chefId); }
  dismissMiddayOutcome()    { return this.eventManager.dismissMiddayOutcome(); }
  eligibleChefsForMidday(stat) { return this.eventManager.eligibleChefsForMidday(stat); }

  // Floater above `entity`. Rendered by Sprites.popups via the pooled text
  // system; lifetimes tick in update() and expired entries are dropped.
  emitPopup(entity, icon, label, duration = 1.6) {
    if (!entity) return;
    if (entity instanceof Employee) {
      entity.dayStats.procs++;
      entity.career.procs++;
    }
    this.popups.push({
      id: ++this._popupSeq,
      entity, icon: icon || '', label: label || '',
      age: 0, duration,
    });
  }

  spawnCustomer() {
    const door = this.randomSpawn();
    const c = new Customer(door.x, door.y, this.time);
    c.entryDoor = { x: door.x, y: door.y };
    // Food bias from today's forecast: 70% of customers chase the hot menu.
    const bias = this.todayProfile && this.todayProfile.foodBias;
    if (bias && FOODS[bias] && Math.random() < 0.7) c.foodPref = bias;
    c.abilities = rollCustomerAbilities();
    c.ordersRemaining = 1 + abilitySum(c, 'extraOrders');
    this.customers.push(c);
    return true;
  }

  submitOrder(o) { this.orders.push(o); }

  getSeekingCustomers() {
    return this.customers
      .filter(c => c.alive && (c.state === CS.SEEKING || c.state === CS.ENTERING))
      .sort((a, b) => a.spawnTime - b.spawnTime);
  }

  // Seekers queueing at a specific door, arrival-ordered. Customers without an
  // entryDoor (e.g. tests that bypass spawnCustomer) match every door so the
  // single-door legacy case still works. Used by both customer.update (to
  // determine my place in line) and getQueueSlot (to resolve the slot index
  // given just a Customer ref).
  seekersAtDoor(door) {
    if (!door) return [];
    return this.customers
      .filter(s => s.alive && (s.state === CS.SEEKING || s.state === CS.ENTERING))
      .filter(s => !s.entryDoor || (s.entryDoor.x === door.x && s.entryDoor.y === door.y))
      .sort((a, b) => a.spawnTime - b.spawnTime);
  }

  // Slot 0 is at the door; later slots extend OUTWARD from the restaurant
  // along whichever perimeter edge the door sits on, so the queue forms
  // visibly outside. With multiple doors, each door gets its own queue.
  getQueueSlot(indexOrCustomer) {
    let door = this.spawnTiles[0];
    let index = indexOrCustomer;
    if (typeof indexOrCustomer === 'object' && indexOrCustomer !== null) {
      const c = indexOrCustomer;
      if (c.entryDoor) door = c.entryDoor;
      index = this.seekersAtDoor(door).indexOf(c);
      if (index < 0) index = 0;
    }
    const maxVisible = 4;
    const effIdx = Math.min(index, maxVisible);
    // Direction outward from the perimeter edge the door is on.
    let dx = 0, dy = 0;
    if      (door.x === 0)            dx = -1;
    else if (door.x === this.grid.cols - 1) dx =  1;
    else if (door.y === 0)            dy = -1;
    else if (door.y === this.grid.rows - 1) dy =  1;
    else                              dx = -1;   // interior fallback (shouldn't happen)
    return { x: door.x + effIdx * 0.9 * dx, y: door.y + effIdx * 0.9 * dy };
  }

  findAvailableChair() {
    for (const b of this.buildings) {
      if (b.type !== 'chair' || b.occupyingCustomer) continue;
      const table = b.getAdjacentTable(this.grid);
      if (!table || table.occupyingCustomer || table.plate) continue;
      return b;
    }
    return null;
  }

  update(dt) {
    this.time += dt;
    // Day-state machine drives spawn cadence + spawning→draining→dayEnd
    // transitions. dayEnd is a pure pause: entity ticks below still run,
    // but no day progression happens until startNextDay().
    this.dayStateMachine.tick(dt);
    // midday_event is a hard pause: do NOT tick buildings, employees, or
    // customers while the player is resolving the modal. Catch the tick
    // here so any work-in-progress (cooking timers, eat timers) freezes.
    if (this.dayState === 'midday_event') return;
    for (const b of this.buildings) b.update(dt, this);
    for (const e of this.employees) e.update(dt, this);
    for (const c of this.customers) if (c.alive) c.update(dt, this);
    this.customers = this.customers.filter(c => c.alive);

    // Tick in-flight catapult plates. Each lands when age >= duration; the
    // resolve() closure (assembled in CatapultStove._fire) applies the hit
    // or miss outcome — we just drive time and prune.
    if (this.projectiles.length) {
      for (const p of this.projectiles) {
        p.age += dt;
        if (p.age >= p.duration && !p._resolved) {
          p._resolved = true;
          if (typeof p.resolve === 'function') p.resolve(this);
        }
      }
      this.projectiles = this.projectiles.filter(p => !p._resolved);
    }
    this.orders = this.orders.filter(o =>
      o.status !== 'delivered' && o.status !== 'abandoned' && o.status !== 'lost' && o.customer.alive);

    // Age popup floaters; drop expired entries.
    if (this.popups.length) {
      for (const p of this.popups) p.age += dt;
      this.popups = this.popups.filter(p => p.age < p.duration && p.entity && p.entity.alive !== false);
    }
  }
}
