/* ============================================================================
 * sim/simulation.js — Simulation root: ticks the world, holds money/lives/day,
 * routes player actions (place/move/remove buildings, hire chefs, resolve events)
 * ============================================================================ */

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
    // Run-level totals + lives. Lives tick down when a customer leaves angry
    // from maxed-out rage (not from furniture being yanked — that's the
    // player's own doing). At zero, sim.gameOver is set and spawning halts.
    this.runStats = { served: 0, angry: 0, plates: 0, tipsTotal: 0, daysCompleted: 0 };
    this.livesMax = 3;
    this.lives    = 3;
    this.gameOver = false;
    this.day           = 1;
    this.daySpawned    = 0;
    this.dayStartMoney = CONFIG.startingMoney;
    this.todayProfile  = {};            // applied on day start: foodBias, quotaMult, tipMult, cookTimeMult
    this.dayQuota      = this._computeDayQuota(1);
    this.dayState      = 'spawning';    // 'spawning' | 'draining' | 'dayEnd'

    // Between-day pause state. currentEvent and nextForecast are rolled on
    // entry to 'dayEnd'; eventOutcome is filled when the player assigns a
    // chef. startNextDay() consumes them to shape the following day.
    this.currentEvent     = null;
    this.eventAssignedChef = null;
    this.eventOutcome     = null;        // {passed, roll, chef, result}
    this.nextForecast     = null;        // {label, profile}

    // Popup queue for real-time ability floaters. Each entry is aged in
    // update() and rendered by Sprites.popups. Unique ids prevent text-pool
    // key collisions when the same entity fires multiple popups.
    this.popups     = [];
    this._popupSeq  = 0;

    this.spawnTile = { x: 0, y: 4 };
    this.exitTile  = { x: 0, y: 4 };
    this.grid.setType(this.spawnTile.x, this.spawnTile.y, 'spawn');

    // Live recruit pool. Each entry carries an `id` (stable across the run)
    // used by the UI to identify the chef clicked. Shuffle so the player sees
    // a different order every session; removed on hire so every chef is unique.
    this.recruitPool = CHEF_ROSTER
      .map((e, i) => ({ ...e, id: i }))
      .sort(() => Math.random() - 0.5);
  }

  seedDemo() {
    // Kitchen column: 3 stoves on top, 2 sinks on bottom.
    this.placeBuilding('stove', 10, 1, true);
    this.placeBuilding('stove', 10, 2, true);
    this.placeBuilding('stove', 10, 3, true);
    this.placeBuilding('sink',  10, 6, true);
    this.placeBuilding('sink',  10, 7, true);

    // Four 1-chair dining units. (A table only serves one customer at a time;
    // sharing one between two chairs leaves the second chair permanently
    // unusable — so we pair 1-to-1.)
    // Top row: chair NORTH of table.
    this.placeBuilding('chair',  3, 2, true);  this.placeBuilding('table',  3, 3, true);
    this.placeBuilding('chair',  6, 2, true);  this.placeBuilding('table',  6, 3, true);
    // Bottom row: chair SOUTH of table.
    this.placeBuilding('table',  3, 5, true);  this.placeBuilding('chair',  3, 6, true);
    this.placeBuilding('table',  6, 5, true);  this.placeBuilding('chair',  6, 6, true);

    this.hireEmployee(true);
  }

  placeBuilding(type, x, y, free = false) {
    if (!this.grid.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
    if (this.grid.getTile(x, y).building) return { ok: false, reason: 'occupied' };
    if (this.grid.getTile(x, y).type === 'spawn') return { ok: false, reason: 'blocks-door' };
    const cost = CONFIG.costs[type];
    if (!free && this.money < cost) return { ok: false, reason: 'no-money' };
    let b;
    if      (type === 'stove') b = new Stove();
    else if (type === 'table') b = new Table();
    else if (type === 'chair') b = new Chair();
    else if (type === 'sink')  b = new Sink();
    else return { ok: false, reason: 'bad-type' };
    if (!this.grid.placeBuilding(b, x, y)) return { ok: false, reason: 'grid-reject' };
    this.buildings.push(b); b.onPlaced(this);
    if (!free) this.money -= cost;
    return { ok: true };
  }

  // Move an existing building from (fx,fy) to (tx,ty), preserving the
  // instance so state (e.g., a plate on a table, a cooking stove) stays
  // intact. Refuses when the target is occupied or the source is mid-task —
  // moving a stove mid-cook would orphan the order.
  moveBuilding(fx, fy, tx, ty) {
    if (fx === tx && fy === ty) return { ok: false, reason: 'same-tile' };
    const src = this.grid.getTile(fx, fy);
    if (!src || !src.building) return { ok: false, reason: 'empty-source' };
    const b = src.building;
    if (b.type === 'stove' && (b.cooking || b.reservedFor)) return { ok: false, reason: 'busy' };
    if (b.type === 'sink'  && (b.washing || b.reservedFor)) return { ok: false, reason: 'busy' };
    if (b.type === 'chair' && b.occupyingCustomer)          return { ok: false, reason: 'busy' };
    if (b.type === 'table' && (b.occupyingCustomer || b.cleaningAssigned)) return { ok: false, reason: 'busy' };
    if (!this.grid.inBounds(tx, ty)) return { ok: false, reason: 'out-of-bounds' };
    const dst = this.grid.getTile(tx, ty);
    if (!dst || dst.type === 'wall') return { ok: false, reason: 'out-of-bounds' };
    if (dst.type === 'spawn') return { ok: false, reason: 'blocks-door' };
    if (dst.building)         return { ok: false, reason: 'occupied' };
    // Pop off source tile, drop on target. grid.placeBuilding reuses the
    // existing instance; it does not allocate.
    this.grid.removeBuildingAt(fx, fy);
    this.grid.placeBuilding(b, tx, ty);
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

  // Seeds the demo with two starter chefs. The roster-based path is
  // hireFromRoster — this legacy method is only used by seedDemo.
  hireEmployee(free = false) {
    if (!free && this.money < CONFIG.costs.employee) return false;
    if (!free) this.money -= CONFIG.costs.employee;
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
    if (this.money < entry.cost) return { ok: false, reason: 'no-money' };
    this.money -= entry.cost;
    this.recruitPool.splice(idx, 1);
    this.employees.push(new Employee(this.spawnTile.x, this.spawnTile.y, entry));
    return { ok: true };
  }

  _computeDayQuota(day) {
    const base = CONFIG.dayBaseQuota * Math.pow(CONFIG.dayGrowthFactor, day - 1);
    const mult = (this.todayProfile && this.todayProfile.quotaMult) || 1;
    return Math.max(1, Math.ceil(base * mult));
  }

  // List of chefs the player can assign to today's event. Starter chefs are
  // always shown; others must be currently available (not recovering).
  eligibleChefsForEvent() {
    return this.employees.filter(e => e.isStarter || e.isAvailable());
  }

  // Roll the event for an assigned chef and apply its immediate effects
  // (money delta, status). Forecast profile is stashed and applied at
  // startNextDay(). Safe to call only while in 'dayEnd'. Returns outcome
  // summary for the UI.
  resolveEvent(chefId) {
    if (this.dayState !== 'dayEnd' || !this.currentEvent || this.eventOutcome) return null;
    const chef = this.employees.find(e => e.id === chefId);
    if (!chef) return null;
    const ev    = this.currentEvent;
    const dc    = typeof ev.dc === 'function' ? ev.dc(this.day) : (ev.dc || 10);
    const roll  = Math.floor(Math.random() * 10) + 1;     // 1..10
    const total = roll + chef.effStat(ev.stat);
    const passed = total >= dc;
    const result = passed ? ev.onPass(this, chef) : ev.onFail(this, chef);

    // Default chef status: busy for 1 day (skip tomorrow). Events can override
    // via statusOverride (e.g. 'starstruck'). Starter chefs shrug off any
    // disabling status but still accept positive ones.
    let nextStatus = result.statusOverride || { kind: 'busy', daysLeft: 1 };
    if (chef.isStarter && nextStatus.kind !== 'starstruck') nextStatus = null;
    chef.status = nextStatus;

    this.eventAssignedChef = chef;
    this.eventOutcome = {
      passed, roll, total, dc,
      chef, result,
      msg: result.msg || (passed ? 'Success.' : 'Failed.'),
    };
    return this.eventOutcome;
  }

  // Player clicks "Start Day" in the modal. Advances day counter, resets
  // per-day stats, ticks chef statuses, and merges the rolled forecast +
  // event profile into todayProfile.
  startNextDay() {
    if (this.dayState !== 'dayEnd') return;
    if (!this.eventOutcome) return;      // must resolve event first

    // Assemble next day's profile: base forecast + any event profile.
    const profile = { ...(this.nextForecast && this.nextForecast.profile || {}) };
    const evProf = this.eventOutcome.result && this.eventOutcome.result.profile;
    if (evProf) {
      for (const k of Object.keys(evProf)) {
        if (k === 'label') continue;
        if (k === 'tipMult' || k === 'quotaMult' || k === 'cookTimeMult') {
          profile[k] = (profile[k] || 1) * evProf[k];
        } else {
          profile[k] = evProf[k];
        }
      }
    }
    this.todayProfile = profile;

    this.runStats.daysCompleted++;
    this.day++;
    this.dayQuota      = this._computeDayQuota(this.day);
    this.daySpawned    = 0;
    this.spawnTimer    = 0.5;
    this.dayState      = 'spawning';
    this.dayStartMoney = this.money;
    this.stats         = { served: 0, angry: 0, plates: 0, tipsTotal: 0 };

    for (const e of this.employees) {
      e.dayStats = { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0 };
      e.career.daysWorked++;
    }

    this.currentEvent      = null;
    this.eventAssignedChef = null;
    this.eventOutcome      = null;
    this.nextForecast      = null;
  }

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
    if (this.customers.filter(c => c.alive).length >= CONFIG.customerMaxConcurrent) return false;
    const c = new Customer(this.spawnTile.x, this.spawnTile.y, this.time);
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

  // Slot 0 is the door; later slots extend WEST off the grid so the queue
  // forms visibly outside the restaurant.
  getQueueSlot(index) {
    const maxVisible = 4;
    const effIdx = Math.min(index, maxVisible);
    return { x: this.spawnTile.x - effIdx * 0.9, y: this.spawnTile.y };
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
    if (this.spawnEnabled && !this.gameOver) {
      if (this.dayState === 'spawning') {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
          this.spawnTimer = CONFIG.customerSpawnInterval / this.trafficMultiplier;
          if (this.daySpawned < this.dayQuota && this.spawnCustomer()) {
            this.daySpawned++;
            if (this.daySpawned >= this.dayQuota) this.dayState = 'draining';
          }
        }
      } else if (this.dayState === 'draining') {
        if (!this.customers.some(c => c.alive)) {
          // Status is tick-decremented at end of day so "daysLeft:1" applied
          // during yesterday's dayEnd naturally clears after one full day.
          for (const e of this.employees) {
            if (e.status) {
              e.status.daysLeft--;
              if (e.status.daysLeft <= 0) e.status = null;
            }
          }
          this.dayState = 'dayEnd';
          // Roll today's event + tomorrow's baseline forecast. The modal
          // reads these; resolveEvent + startNextDay consume them.
          this.currentEvent  = rollDailyEvent(this.day);
          this.nextForecast  = rollBaseForecast();
          this.eventAssignedChef = null;
          this.eventOutcome  = null;
        }
      }
      // 'dayEnd' is a pure pause — the sim keeps ticking (chefs regen
      // stamina, popups fade), but day progression waits on the player's
      // Start Day click, which calls startNextDay().
    }
    for (const b of this.buildings) b.update(dt, this);
    for (const e of this.employees) e.update(dt, this);
    for (const c of this.customers) if (c.alive) c.update(dt, this);
    this.customers = this.customers.filter(c => c.alive);
    this.orders = this.orders.filter(o =>
      o.status !== 'delivered' && o.status !== 'abandoned' && o.status !== 'lost' && o.customer.alive);

    // Age popup floaters; drop expired entries.
    if (this.popups.length) {
      for (const p of this.popups) p.age += dt;
      this.popups = this.popups.filter(p => p.age < p.duration && p.entity && p.entity.alive !== false);
    }
  }

  orderCountsByStatus() {
    const c = { pending: 0, cooking: 0, ready: 0 };
    for (const o of this.orders) if (c[o.status] !== undefined) c[o.status]++;
    return c;
  }
}
