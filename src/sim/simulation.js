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
    // Allocate the full (enlarged) grid, then seed everything outside the
    // COLS×ROWS restaurant footprint to 'gap' — the expansion void that
    // placeRoom() later fills in. The footprint (0..COLS-1, 0..ROWS-1) stays
    // floor-default exactly as before, so the layout validator / applyLayout /
    // the coordinate-hardcoded tests are unaffected.
    this.grid = new Grid(GRID_COLS, GRID_ROWS);
    this._seedExpansionVoid();
    this.pathfinder = new Pathfinder(this.grid);
    // Config ids of rooms granted by events, awaiting placement via the Place
    // Room tool (sim.placeRoom). FIFO; the matching entry is consumed on place.
    this._pendingRooms = [];
    this.buildings = []; this.customers = []; this.employees = []; this.orders = [];
    // Derived index over `buildings`, grouped by type, rebuilt on every
    // place/move/remove/load via _reindexBuildings(). `buildings` stays the
    // canonical list (iteration, serialization); the index lets the per-tick
    // hot paths (Employee.findTask, findAvailableChair, chefSpawnPads) skip
    // full-list type scans. `_chefSpawnPadsCache` is the chef_spawn bucket
    // pre-sorted by (y, x) for stable 1-based pad numbering.
    this.buildingsByType = { stove: [], catapult_stove: [], table: [], chair: [], sink: [], chef_spawn: [] };
    this._chefSpawnPadsCache = [];
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

    // Parallel to spawnTiles: each door's count of not-yet-arrived customers
    // for the current day. Rebuilt each day by DayStateMachine.startNextDay via
    // planDoorArrivals(); sums to (dayQuota - daySpawned). Not serialized — saves
    // happen only at dayEnd, when this is all-zeros anyway.
    this.incomingByDoor = [0];

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

  // Deterministic mulberry32 PRNG used ONLY for distributing arrivals across
  // doors. Deliberately separate from Math.random: door planning is cosmetic
  // and must not perturb the seeded gameplay RNG stream (customer abilities,
  // event rolls, anger/win-loss), which the deterministic tests depend on.
  // Seeded from the day so the spread varies day to day.
  _doorRng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Distribute this day's full quota randomly across the doors into
  // incomingByDoor (an int array parallel to spawnTiles). Each of the dayQuota
  // arrivals is assigned to a door via the dedicated _doorRng, so per-door
  // shares are random but always sum to exactly dayQuota (1 door → it gets all)
  // WITHOUT touching the gameplay Math.random stream. Rebuilt every day by
  // DayStateMachine.startNextDay right after dayQuota is set.
  planDoorArrivals() {
    const n = this.spawnTiles.length || 1;
    const plan = new Array(n).fill(0);
    const quota = Math.max(0, this.dayQuota | 0);
    const rnd = this._doorRng(this.day);
    for (let k = 0; k < quota; k++) plan[(rnd() * n) | 0]++;
    this.incomingByDoor = plan;
  }

  // Pick a door that still has planned arrivals, decrement its count, and
  // return it. Returns null when there's no usable plan (missing array, length
  // mismatch with spawnTiles, or all-zero) so spawnCustomer falls back to
  // randomSpawn — this preserves behavior for tests that call spawnCustomer
  // directly without going through startNextDay/planDoorArrivals.
  _takeDoorFromPlan() {
    const plan = this.incomingByDoor;
    if (!Array.isArray(plan) || plan.length !== this.spawnTiles.length) return null;
    const avail = [];
    for (let i = 0; i < plan.length; i++) if (plan[i] > 0) avail.push(i);
    if (!avail.length) return null;
    const idx = avail[(Math.random() * avail.length) | 0];
    plan[idx]--;
    return this.spawnTiles[idx];
  }

  // Resolve where a chef should start its shift. A chef assigned to a spawn
  // point (emp.spawnPoint = {x,y}) starts there, as long as a chef_spawn
  // building still occupies that tile; otherwise it falls back to the primary
  // door. Used by DayStateMachine.startNextDay to place chefs each morning.
  chefSpawnTileFor(emp) {
    const sp = emp && emp.spawnPoint;
    if (sp) {
      const t = this.grid.getTile(sp.x, sp.y);
      if (t && t.building && t.building.type === 'chef_spawn') return { x: sp.x, y: sp.y };
    }
    return this.spawnTiles[0];
  }

  // Chef spawn pads in a stable display order (top-left to bottom-right), so
  // the on-map number labels and the Assign menu agree. Used for the "Pad #N"
  // labels the player sees in both places.
  // Rebuild the by-type index (and the sorted chef-spawn cache) from the
  // canonical `buildings` list. O(K), called only on building mutation
  // (place/move/remove/load) — never per tick — so the hot paths read the
  // index for free. A type bucket is created lazily for any future type.
  _reindexBuildings() {
    const byType = { stove: [], catapult_stove: [], table: [], chair: [], sink: [], chef_spawn: [] };
    for (const b of this.buildings) {
      (byType[b.type] || (byType[b.type] = [])).push(b);
    }
    this.buildingsByType = byType;
    this._chefSpawnPadsCache = byType.chef_spawn.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  }

  chefSpawnPads() {
    return this._chefSpawnPadsCache;
  }

  // 1-based pad number for the pad at (x,y), or null if none. Matches the order
  // from chefSpawnPads().
  chefSpawnLabelAt(x, y) {
    const pads = this._chefSpawnPadsCache;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i].x === x && pads[i].y === y) return i + 1;
    }
    return null;
  }

  // True for coords inside the original restaurant footprint (0..COLS-1,
  // 0..ROWS-1). Everything else is expansion territory.
  inFootprint(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }

  // Paint every tile outside the restaurant footprint as 'gap' (the expansion
  // void). Reused by the ctor and replaceLayout's full reset.
  _seedExpansionVoid() {
    for (let y = 0; y < this.grid.rows; y++) {
      for (let x = 0; x < this.grid.cols; x++) {
        if (!this.inFootprint(x, y)) this.grid.setType(x, y, 'gap');
      }
    }
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
    this._reindexBuildings();
    // Reset the whole grid: the restaurant footprint goes back to floor
    // (bypassing the cost-charging player paths); everything outside it returns
    // to the expansion void. Any previously-placed room floors are wiped — a
    // reroll regenerates the entire restaurant from scratch.
    for (let y = 0; y < this.grid.rows; y++) {
      for (let x = 0; x < this.grid.cols; x++) {
        const t = this.grid.getTile(x, y);
        if (!t) continue;
        if (t.type === 'wall') t.wallKind = null;
        if (!this.inFootprint(x, y)) { this.grid.setType(x, y, 'gap'); }
        else if (t.type !== 'floor') { this.grid.setType(x, y, 'floor'); }
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
    else if (type === 'chef_spawn') b = new ChefSpawn();
    else return { ok: false, reason: 'bad-type' };
    if (!this.grid.placeBuilding(b, x, y)) return { ok: false, reason: 'grid-reject' };
    this.buildings.push(b); b.onPlaced(this);
    this._reindexBuildings();
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
    // Membership is unchanged (same instance), but a chef_spawn move reorders
    // the (y,x)-sorted pad cache, so refresh the index.
    this._reindexBuildings();
    // Chef assignments follow their spawn point when it's relocated.
    if (b.type === 'chef_spawn') {
      for (const e of this.employees) {
        if (e.spawnPoint && e.spawnPoint.x === fx && e.spawnPoint.y === fy) e.spawnPoint = { x: tx, y: ty };
      }
    }
    if (moveCost > 0 && !this.debug) this.money -= moveCost;
    return { ok: true };
  }

  removeBuildingAt(x, y) {
    const b = this.grid.removeBuildingAt(x, y); if (!b) return false;
    b.onRemoved(this);
    const i = this.buildings.indexOf(b); if (i >= 0) this.buildings.splice(i, 1);
    this._reindexBuildings();
    // A removed chef spawn point un-assigns any chefs pointing at it — they
    // revert to the default door next morning.
    if (b.type === 'chef_spawn') {
      for (const e of this.employees) {
        if (e.spawnPoint && e.spawnPoint.x === x && e.spawnPoint.y === y) e.spawnPoint = null;
      }
    }
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

  // Validity check for stamping room config `cfg` with its top-left at footprint
  // anchor (ax, ay). Pure (no mutation). Every cell must map to an in-bounds
  // 'gap' tile, and at least one cell must be 4-adjacent to existing walkable
  // floor so the room connects to the restaurant. Drives both placeRoom and the
  // Place Room tool's hover preview.
  roomPlacement(cfg, ax, ay) {
    if (!cfg || !cfg.cells || !cfg.cells.length) return { ok: false, reason: 'no-config' };
    for (const cell of cfg.cells) {
      const t = this.grid.getTile(ax + cell.dx, ay + cell.dy);
      if (!t || t.type !== 'gap') return { ok: false, reason: 'blocked' };
    }
    const inRoom = new Set(cfg.cells.map(c => (ay + c.dy) * 1024 + (ax + c.dx)));
    for (const cell of cfg.cells) {
      const x = ax + cell.dx, y = ay + cell.dy;
      for (const nb of this.grid.neighbors4(x, y)) {
        if (inRoom.has(nb.y * 1024 + nb.x)) continue;
        if (this.grid.isWalkable(nb.x, nb.y)) return { ok: true };
      }
    }
    return { ok: false, reason: 'disconnected' };
  }

  // Queue a random room grant for the Place Room tool. Shared by the room-grant
  // daily event and the debug "Grant Room" action. Returns the sampled config,
  // or null when no configs are loaded (file:// / load failure).
  grantRandomRoom() {
    const configs = (typeof ROOM_CONFIGS !== 'undefined' && ROOM_CONFIGS) || [];
    if (!configs.length) return null;
    const cfg = configs[(Math.random() * configs.length) | 0];
    this._pendingRooms = this._pendingRooms || [];
    this._pendingRooms.push(cfg.id);
    return cfg;
  }

  // Stamp a granted room config into the expansion void at anchor (ax, ay).
  // Resolves the config by id from ROOM_CONFIGS, validates via roomPlacement,
  // then floor-first converts every cell to floor (so furniture lands on valid
  // tiles) and places the furniture free. Consumes the matching _pendingRooms
  // entry. The new floor + furniture behave exactly like the rest of the
  // restaurant — the pathfinder and renderers pick them up automatically.
  placeRoom(configId, ax, ay) {
    const configs = (typeof ROOM_CONFIGS !== 'undefined' && ROOM_CONFIGS) || [];
    const cfg = configs.find(c => c.id === configId);
    if (!cfg) return { ok: false, reason: 'no-config' };
    const res = this.roomPlacement(cfg, ax, ay);
    if (!res.ok) return res;
    for (const cell of cfg.cells) this.grid.setType(ax + cell.dx, ay + cell.dy, 'floor');
    for (const cell of cfg.cells) {
      if (cell.furniture) this.placeBuilding(cell.furniture, ax + cell.dx, ay + cell.dy, true);
    }
    const pi = (this._pendingRooms || []).indexOf(configId);
    if (pi >= 0) this._pendingRooms.splice(pi, 1);
    return { ok: true, cfg };
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
    const door = this._takeDoorFromPlan() || this.randomSpawn();
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

  findAvailableChair() {
    for (const b of this.buildingsByType.chair) {
      if (b.occupyingCustomer) continue;
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
