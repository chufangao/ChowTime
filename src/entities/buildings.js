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
  }
  update() {} onPlaced(sim) { this.placedAt = sim.time; } onRemoved() {}
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
    const cookTime = food.cookTime * mult * aMult * profMult;
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

class Sink extends Building {
  constructor() { super('sink'); this.washing = null; this.reservedFor = null; }
  isAvailable() { return !this.washing && !this.reservedFor; }
  isWashing()   { return this.washing !== null; }
  startWashing() { this.washing = { timeLeft: 2.0, total: 2.0 }; this.reservedFor = null; }
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
