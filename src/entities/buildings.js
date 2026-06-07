/* ============================================================================
 * entities/buildings.js — Building base + Stove / Table / Chair / Sink, plus Order
 * ============================================================================ */

/* ---- Buildings ------------------------------------------------------------- */
let _bid = 0;
class Building {
  constructor(type) {
    this.id = ++_bid; this.type = type;
    this.x = -1; this.y = -1; this.tile = null;
    this.walkable = false; this.placedAt = 0;
    // Broken: midday-event penalty effect. Doubles the building's "work tick"
    // (stove cook time, sink wash time, table eat time). Repaired via the
    // Repair toolbar tool for half the purchase price.
    this.broken = false;
    // Manual rotation, set by RotateApp. null → sprite auto-orients (chairs
    // face their adjacent table). Otherwise 0=N, 1=E, 2=S, 3=W. Game logic
    // doesn't read this — purely a sprite-orientation hint.
    this.facing = null;
  }
  update() {} onPlaced(sim) { this.placedAt = sim.time; } onRemoved() {}
  // Broken buildings work at half speed: stove cook time, sink wash time, and
  // table eat time all multiply by this. Centralized so the constant lives in
  // one place instead of three `b.broken ? 2 : 1` literals.
  get workMult() { return this.broken ? 2 : 1; }
}

class Stove extends Building {
  constructor() { super('stove'); this.cooking = null; this.reservedFor = null; }
  isCooking()    { return this.cooking !== null; }
  isAvailable()  { return !this.cooking && !this.reservedFor; }
  startCooking(order, sim) {
    const food = FOODS[order.foodType];
    // Cook stats (via effStat so tiredness folds in automatically):
    //   DEX scales cookTime down, INT drives food quality at cook time.
    const cook = order.cookingEmployee;
    const dex  = cook ? cook.effStat('dex') : 5;
    const mult = clamp(1.3 - 0.06 * dex, 0.5, 1.3);
    const aMult = cook ? abilityMult(cook, 'cookTimeMult', order.foodType) : 1;
    const profMult = (sim && sim.todayProfile && sim.todayProfile.cookTimeMult) || 1;
    const cookTime = food.cookTime * mult * aMult * profMult * this.workMult;
    const quality  = cook ? computeQuality(cook.effStat('int')) : 1.0;
    this.cooking = { order, timeLeft: cookTime, total: cookTime, quality };
    this.reservedFor = null;
  }
  update(dt) {
    if (!this.cooking) return;
    this.cooking.timeLeft -= dt;
    if (this.cooking.timeLeft <= 0) {
      const o = this.cooking.order;
      o.status = 'ready';
      o.readyStove = this;
      o.quality = this.cooking.quality;   // carry quality forward to delivery
      this.cooking = null;
    }
  }
  onRemoved() {
    if (this.reservedFor) {
      this.reservedFor.assignedStove = null;
      this.reservedFor.cookingEmployee = null;
      this.reservedFor = null;
    }
    if (this.cooking) this.cooking.order.status = 'lost';
  }
}

// Premium stove that launches its finished plate in an arc straight to a
// matching seated customer, skipping the chef's pickup+deliver walk. Falls
// back to the regular ready-on-stove flow if no matching customer exists at
// fire time. The trade-off vs a regular Stove is cook time: 2.5×, in
// exchange for a guaranteed hit (no chef walk, no miss).
class CatapultStove extends Stove {
  constructor() { super(); this.type = 'catapult_stove'; }
  static COOK_TIME_MULT = 2.5;
  startCooking(order, sim) {
    // Stash the cooking chef so the post-flight resolve can credit them with
    // the dish + tip — by the time the projectile lands, order.cookingEmployee
    // has already been cleared by Employee.onArrival.
    const cook = order.cookingEmployee;
    super.startCooking(order, sim);
    if (this.cooking) {
      this.cooking.cook = cook;
      // Double the cook time. We do this after super so all the parent's
      // multipliers (DEX, abilities, todayProfile) still compose normally.
      this.cooking.timeLeft *= CatapultStove.COOK_TIME_MULT;
      this.cooking.total    *= CatapultStove.COOK_TIME_MULT;
    }
  }
  update(dt, sim) {
    if (!this.cooking) return;
    this.cooking.timeLeft -= dt;
    if (this.cooking.timeLeft > 0) return;
    const order = this.cooking.order;
    const quality = this.cooking.quality;
    const cook = this.cooking.cook || null;
    this.cooking = null;
    const target = this._findTarget(sim, order.foodType);
    if (!target) {
      // No matching customer — behave like a regular stove so a chef can
      // walk over and deliver normally.
      order.status = 'ready';
      order.readyStove = this;
      order.quality = quality;
      return;
    }
    order.quality = quality;
    this._fire(sim, target, order, quality, cook);
  }
  _findTarget(sim, foodType) {
    if (!sim || !sim.customers) return null;
    let best = null, bestD = Infinity;
    for (const c of sim.customers) {
      if (!c.alive || c.state !== CS.WAITING) continue;
      if (c.foodPref !== foodType) continue;
      if (!c.table) continue;
      const dx = c.x - this.x, dy = c.y - this.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }
  _fire(sim, target, order, quality, cook) {
    order.status = 'launched';
    const stove = this;
    const proj = {
      sourceStove: this,
      fromX: this.x, fromY: this.y,
      toX: target.x, toY: target.y,
      foodType: order.foodType,
      quality,
      targetCustomer: target,
      order, cook,
      age: 0, duration: 0.45,
      // Guaranteed hit — the catapult never misses. The trade-off lives in
      // the doubled cook time, not in an accuracy roll.
      resolve(s) {
        const c = target;
        if (!c.alive || c.state !== CS.WAITING || !c.table) {
          if (order.status !== 'delivered') order.status = 'abandoned';
          return;
        }
        c.table.plate = { foodType: order.foodType, dirty: false, quality };
        c.deliveredAt = s.time;
        c.deliveredBy = cook || null;
        order.status = 'delivered';
        s.emitPopup(stove, '🎯', 'Bullseye!');
      },
    };
    sim.projectiles.push(proj);
    this._lastFireAt = sim.time;       // for the sprite's twang animation
  }
  onRemoved(sim) {
    super.onRemoved();
    if (sim && sim.projectiles) {
      sim.projectiles = sim.projectiles.filter(p => p.sourceStove !== this);
    }
  }
}

class Table extends Building {
  constructor() {
    super('table');
    this.plate = null; this.occupyingCustomer = null; this.cleaningAssigned = false;
  }
  getAdjacentChairs(grid) {
    const out = [];
    for (const n of grid.neighbors4(this.x, this.y)) {
      const t = grid.getTile(n.x, n.y);
      if (t && t.building && t.building.type === 'chair') out.push(t.building);
    }
    return out;
  }
}

class Chair extends Building {
  constructor() { super('chair'); this.walkable = false; this.occupyingCustomer = null; }
  getAdjacentTable(grid) {
    for (const n of grid.neighbors4(this.x, this.y)) {
      const t = grid.getTile(n.x, n.y);
      if (t && t.building && t.building.type === 'table') return t.building;
    }
    return null;
  }
}

// Chef spawn point: a walkable floor marker the player places and assigns
// chefs to. Carries no game logic — Simulation.chefSpawnTileFor reads the
// chef's assignment against the live grid, and DayStateMachine.startNextDay
// snaps each chef to its assigned pad at day start. Walkable so chefs and
// customers path straight over it (multiple chefs may share one).
class ChefSpawn extends Building {
  constructor() { super('chef_spawn'); this.walkable = true; }
}

class Sink extends Building {
  constructor() { super('sink'); this.washing = null; this.reservedFor = null; }
  isAvailable() { return !this.washing && !this.reservedFor; }
  isWashing()   { return this.washing !== null; }
  startWashing() {
    const t = 2.0 * this.workMult;
    this.washing = { timeLeft: t, total: t };
    this.reservedFor = null;
  }
  update(dt) {
    if (!this.washing) return;
    this.washing.timeLeft -= dt;
    if (this.washing.timeLeft <= 0) this.washing = null;
  }
  onRemoved() {
    if (this.reservedFor) { this.reservedFor.cleaningAssigned = false; this.reservedFor = null; }
    this.washing = null;
  }
}


/* ---- Orders ---------------------------------------------------------------- */
let _oid = 0;
class Order {
  constructor(customer, foodType) {
    this.id = ++_oid;
    this.customer = customer; this.foodType = foodType;
    this.status = 'pending';
    this.cookingEmployee = null; this.deliveryEmployee = null;
    this.assignedStove = null; this.readyStove = null;
  }
}


/* ---- Build items ----------------------------------------------------------
 * Plain data records for the BuildApp launcher. Adding a new placeable
 * building = drop another entry here and add it to registerDefaultBuildItems.
 * BuildApp reads from manager.buildItems and has no hardcoded knowledge of
 * any specific building.
 * -------------------------------------------------------------------------- */

function _emptyTileValidAt(sim, x, y) {
  const t = sim.grid.getTile(x, y);
  return !!(t && !t.building && t.type === 'floor');
}
function _placeBuilding(typeId) {
  return (sim, x, y) => sim.placeBuilding(typeId, x, y);
}
function _cost(key) {
  return (typeof CONFIG !== 'undefined') ? CONFIG.costs[key] : 0;
}

const STOVE_ITEM = {
  id: 'stove', label: 'Stove', category: 'kitchen',
  cost: _cost('stove'), icon: '🍳',
  hint: 'Cooks one order at a time. A chef walks over, starts the timer, then carries the finished plate.',
  validAt: _emptyTileValidAt, place: _placeBuilding('stove'),
};

const CATAPULT_STOVE_ITEM = {
  id: 'catapult_stove', label: 'Catapult', category: 'kitchen',
  cost: _cost('catapult_stove'), icon: '🎯',
  hint: 'Cooks like a stove, then launches the plate to the matching customer. Never misses, but cooks 2.5×.',
  validAt: _emptyTileValidAt, place: _placeBuilding('catapult_stove'),
};

const SINK_ITEM = {
  id: 'sink', label: 'Sink', category: 'kitchen',
  cost: _cost('sink'), icon: '🚰',
  hint: 'Chefs drop dirty plates here to free up tables. ~2 seconds per wash.',
  validAt: _emptyTileValidAt, place: _placeBuilding('sink'),
};

const TABLE_ITEM = {
  id: 'table', label: 'Table', category: 'dining',
  cost: _cost('table'), icon: '🍽',
  hint: 'Where the customer sits to eat. Must be next to a Chair.',
  validAt: _emptyTileValidAt, place: _placeBuilding('table'),
};

const CHAIR_ITEM = {
  id: 'chair', label: 'Chair', category: 'dining',
  cost: _cost('chair'), icon: '💺',
  hint: 'A seat for one customer. Needs an adjacent Table to be useful.',
  validAt: _emptyTileValidAt, place: _placeBuilding('chair'),
};

const CHEF_SPAWN_ITEM = {
  id: 'chef_spawn', label: 'Chef Spawn', category: 'kitchen',
  cost: _cost('chef_spawn'), icon: '👨‍🍳',
  hint: 'A station chefs start their shift at. Assign chefs with the 👨‍🍳 tool; unassigned chefs use the door.',
  validAt: _emptyTileValidAt, place: _placeBuilding('chef_spawn'),
};

// Floor: fills a default-layout gap with solid floor for $150. The "buy a
// floor tile" mechanic that replaces the old "demolish structural wall".
const FLOOR_ITEM = {
  id: 'floor', label: 'Floor', category: 'structure',
  cost: _cost('floor'), icon: '🟫',
  hint: 'Fill a gap with solid floor. $150 per tile.',
  validAt: (sim, x, y) => {
    const t = sim.grid.getTile(x, y);
    return !!(t && t.type === 'gap');
  },
  place: (sim, x, y) => sim.placeFloor(x, y),
};

// Player partition: free, lightweight, sight-blocking. Tile-only (no Building
// instance). Defaults are gaps now, so this is the only player-built wall kind.
const PLAYER_WALL_ITEM = {
  id: 'player_wall', label: 'Partition', category: 'structure',
  cost: _cost('player_wall'), icon: '▦',
  hint: 'Lightweight partition. Free to build, move, and remove.',
  validAt: _emptyTileValidAt,
  place: (sim, x, y) => sim.placeWall(x, y, 'player'),
};

function registerDefaultBuildItems(manager) {
  manager.registerBuildItem(STOVE_ITEM);
  manager.registerBuildItem(CATAPULT_STOVE_ITEM);
  manager.registerBuildItem(SINK_ITEM);
  manager.registerBuildItem(CHEF_SPAWN_ITEM);
  manager.registerBuildItem(TABLE_ITEM);
  manager.registerBuildItem(CHAIR_ITEM);
  manager.registerBuildItem(FLOOR_ITEM);
  manager.registerBuildItem(PLAYER_WALL_ITEM);
}
