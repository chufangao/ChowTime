/* ============================================================================
 * game.js  —  pure game logic. Zero Phaser dependencies.
 * ============================================================================
 * Contains:
 *   - Gameplay tuning (FOODS, CONFIG, grid dimensions)
 *   - Grid + A* pathfinding
 *   - Buildings (Stove, Table, Chair, Sink)
 *   - Entities (Customer, Employee)
 *   - Simulation root that ticks everything
 *
 * Anything here could run headlessly (e.g. in a test harness). Classes read
 * and mutate simulation state but NEVER touch graphics objects, scenes,
 * Phaser.Input, tweens, or textures.
 *
 * Referenced from sprites.js (visual palettes attached to entities) and from
 * scene.js (the orchestrator). game.js itself imports nothing.
 */

/* ---- Grid dimensions ------------------------------------------------------- */
const COLS = 12;
const ROWS = 8;

/* ---- Food menu (gameplay + a bit of display info) -------------------------- */
const FOODS = {
  BURGER: { name: 'Burger', cookTime: 4, price: 18, color: 0xd17a44, icon: '🍔' },
  SALAD:  { name: 'Salad',  cookTime: 2, price: 12, color: 0x7cb342, icon: '🥗' },
  PIZZA:  { name: 'Pizza',  cookTime: 5, price: 24, color: 0xe74c3c, icon: '🍕' },
  SOUP:   { name: 'Soup',   cookTime: 3, price: 15, color: 0xf4a261, icon: '🍲' },
};
const FOOD_KEYS = Object.keys(FOODS);

/* ---- Gameplay tuning ------------------------------------------------------- */
const CONFIG = {
  customerSpawnInterval: 6,
  customerMaxConcurrent: 12,
  customerSpeed:         3.2,
  eatDuration:           6,
  angerMax:              100,
  angerRates: { seekingSeat: 2.5, walkingToSeat: 1.0, waitingFood: 3.5, eating: 0 },
  employeeSpeed: 4.5,
  startingMoney: 3000,
  costs: { stove: 150, table: 50, chair: 20, sink: 120, employee: 200 },
  refundRatio: 0.5,
  trafficLevels: [1, 2, 3, 5],
  speedLevels:   [1, 2, 4],
};


/* ---- Grid + pathfinding ---------------------------------------------------- */
class Grid {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows; this.tiles = [];
    for (let y = 0; y < rows; y++) {
      const row = [];
      for (let x = 0; x < cols; x++) row.push({ x, y, type: 'floor', building: null });
      this.tiles.push(row);
    }
  }
  inBounds(x, y) { return x >= 0 && x < this.cols && y >= 0 && y < this.rows; }
  getTile(x, y) { return this.inBounds(x, y) ? this.tiles[y][x] : null; }
  setType(x, y, type) { const t = this.getTile(x, y); if (t) t.type = type; }
  isWalkable(x, y) {
    const t = this.getTile(x, y);
    if (!t || t.type === 'wall') return false;
    if (t.building && !t.building.walkable) return false;
    return true;
  }
  placeBuilding(b, x, y) {
    const t = this.getTile(x, y);
    if (!t || t.building || t.type === 'wall') return false;
    t.building = b; b.tile = t; b.x = x; b.y = y;
    return true;
  }
  removeBuildingAt(x, y) {
    const t = this.getTile(x, y); if (!t || !t.building) return null;
    const b = t.building; t.building = null; b.tile = null; return b;
  }
  neighbors4(x, y) {
    const out = [];
    if (this.inBounds(x+1, y)) out.push({ x: x+1, y });
    if (this.inBounds(x-1, y)) out.push({ x: x-1, y });
    if (this.inBounds(x, y+1)) out.push({ x, y: y+1 });
    if (this.inBounds(x, y-1)) out.push({ x, y: y-1 });
    return out;
  }
}

class Pathfinder {
  constructor(grid) { this.grid = grid; }
  findPath(sx, sy, targetFn, walkableFn) {
    walkableFn = walkableFn || ((x, y) => this.grid.isWalkable(x, y));
    const key = (x, y) => y * 1024 + x;
    let approx = { x: sx, y: sy };
    outer: for (let y = 0; y < this.grid.rows; y++)
      for (let x = 0; x < this.grid.cols; x++)
        if (targetFn(x, y)) { approx = { x, y }; break outer; }
    const h = (x, y) => Math.abs(x - approx.x) + Math.abs(y - approx.y);
    const open = new Map(), closed = new Set();
    const start = { x: sx, y: sy, g: 0, f: h(sx, sy), parent: null };
    open.set(key(sx, sy), start);
    let iters = 0;
    while (open.size && iters++ < 4000) {
      let curK = null, cur = null;
      for (const [k, n] of open) if (!cur || n.f < cur.f) { cur = n; curK = k; }
      if (targetFn(cur.x, cur.y)) {
        const path = []; let n = cur;
        while (n) { path.unshift({ x: n.x, y: n.y }); n = n.parent; }
        return path;
      }
      open.delete(curK); closed.add(curK);
      for (const nb of this.grid.neighbors4(cur.x, cur.y)) {
        const k = key(nb.x, nb.y);
        if (closed.has(k)) continue;
        const isGoal = targetFn(nb.x, nb.y);
        if (!isGoal && !walkableFn(nb.x, nb.y)) continue;
        const g = cur.g + 1;
        const existing = open.get(k);
        if (existing && existing.g <= g) continue;
        open.set(k, { x: nb.x, y: nb.y, g, f: g + h(nb.x, nb.y), parent: cur });
      }
    }
    return null;
  }
}


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
  startCooking(order) {
    const food = FOODS[order.foodType];
    this.cooking = { order, timeLeft: food.cookTime, total: food.cookTime };
    this.reservedFor = null;
  }
  update(dt) {
    if (!this.cooking) return;
    this.cooking.timeLeft -= dt;
    if (this.cooking.timeLeft <= 0) {
      const o = this.cooking.order; o.status = 'ready'; o.readyStove = this;
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


/* ---- Entities: Customer, Employee ------------------------------------------ */
let _eid = 0;
class Entity {
  constructor(x, y) {
    this.id = ++_eid;
    this.x = x; this.y = y;
    this.path = null; this.pathIdx = 0;
    this.speed = 2; this.alive = true;
    this.facing = { x: 1, y: 0 };
  }
  setPath(path) {
    if (!path || path.length === 0) { this.path = null; return; }
    this.path = path; this.pathIdx = 0;
  }
  hasPath() { return this.path && this.pathIdx < this.path.length; }
  tileX() { return Math.round(this.x); }
  tileY() { return Math.round(this.y); }
  stepMovement(dt) {
    if (!this.hasPath()) return false;
    const tgt = this.path[this.pathIdx];
    const dx = tgt.x - this.x, dy = tgt.y - this.y;
    const d = Math.hypot(dx, dy);
    const step = this.speed * dt;
    if (d > 0.001) this.facing = { x: dx / d, y: dy / d };
    if (d <= step) {
      this.x = tgt.x; this.y = tgt.y; this.pathIdx++;
      if (this.pathIdx >= this.path.length) { this.path = null; return true; }
    } else {
      this.x += (dx / d) * step;
      this.y += (dy / d) * step;
    }
    return false;
  }
}

const CS = {
  ENTERING: 'entering', SEEKING: 'seeking', WALKING: 'walking-to-seat',
  WAITING: 'waiting-food', EATING: 'eating', LEAVING: 'leaving',
};

class Customer extends Entity {
  constructor(x, y, spawnTime = 0) {
    super(x, y);
    this.spawnTime = spawnTime;
    this.queueSlot = null;
    this.speed = CONFIG.customerSpeed;
    this.state = CS.ENTERING;
    this.foodPref = FOOD_KEYS[(Math.random() * FOOD_KEYS.length) | 0];
    this.anger = 0;
    this.chair = null; this.table = null; this.order = null;
    this.eatTimer = 0; this.retrySeatTimer = 0;
    this.leftReason = null;

    // Visual randomization — palettes live in sprites.js. Read by SPRITES,
    // never mutated during play.
    const pick = (a) => a[(Math.random() * a.length) | 0];
    this.bodyColor  = pick(CUSTOMER_BODY_COLORS);
    this.skinColor  = pick(SKIN_TONES);
    this.pantsColor = pick(PANTS_COLORS);
    this.hat        = (Math.random() * 5) | 0;
    this.hatColor   = pick(CUSTOMER_BODY_COLORS);
    this.hairColor  = pick(HAIR_COLORS);
    this.hasHair    = Math.random() < 0.7;
  }

  update(dt, sim) {
    const arrived = this.stepMovement(dt);

    // Anger ticks by state.
    let rate = 0;
    if (this.state === CS.ENTERING || this.state === CS.SEEKING) rate = CONFIG.angerRates.seekingSeat;
    else if (this.state === CS.WALKING) rate = CONFIG.angerRates.walkingToSeat;
    else if (this.state === CS.WAITING) rate = CONFIG.angerRates.waitingFood;
    else if (this.state === CS.EATING)  rate = CONFIG.angerRates.eating;
    this.anger = Math.min(CONFIG.angerMax, this.anger + rate * dt);
    if (this.anger >= CONFIG.angerMax && this.state !== CS.LEAVING) { this.leave(sim, 'angry'); return; }

    switch (this.state) {
      case CS.ENTERING:
        this.state = CS.SEEKING;
        break;
      case CS.SEEKING: {
        // Compute my place in the arrival-ordered queue.
        const seekers = sim.getSeekingCustomers();
        const myIdx = seekers.indexOf(this);
        const slot = sim.getQueueSlot(myIdx);

        // Re-target whenever my slot shifts (someone ahead got seated).
        const slotChanged = !this.queueSlot ||
          this.queueSlot.x !== slot.x || this.queueSlot.y !== slot.y;
        if (slotChanged) {
          this.queueSlot = slot;
          const dist = Math.hypot(slot.x - this.x, slot.y - this.y);
          if (dist > 0.05) this.setPath([{ x: slot.x, y: slot.y }]);
          else             this.path = null;
        }

        // Only the front-of-queue customer actually tries seats.
        if (!this.hasPath() && myIdx === 0) {
          this.retrySeatTimer -= dt;
          if (this.retrySeatTimer <= 0) {
            this.retrySeatTimer = 0.6;
            this.trySeat(sim);
          }
        }
        break;
      }
      case CS.WALKING:
        if (arrived) {
          this.state = CS.WAITING;
          this.order = new Order(this, this.foodPref);
          sim.submitOrder(this.order);
        }
        break;
      case CS.WAITING:
        if (this.table && this.table.plate && !this.table.plate.dirty &&
            this.table.plate.foodType === this.foodPref) {
          this.state = CS.EATING;
          this.eatTimer = CONFIG.eatDuration;
        }
        break;
      case CS.EATING:
        this.eatTimer -= dt;
        if (this.eatTimer <= 0) {
          if (this.table && this.table.plate) this.table.plate.dirty = true;
          this.leave(sim, 'happy');
        }
        break;
      case CS.LEAVING:
        if (arrived || !this.hasPath()) this.alive = false;
        break;
    }
  }

  trySeat(sim) {
    const chair = sim.findAvailableChair();
    if (!chair) return;
    const startX = Math.round(this.x), startY = Math.round(this.y);
    if (!sim.grid.inBounds(startX, startY)) return;
    const path = sim.pathfinder.findPath(
      startX, startY,
      (x, y) => x === chair.x && y === chair.y,
      (x, y) => sim.grid.isWalkable(x, y));
    if (!path) return;
    // Snap to tile so stepMovement starts cleanly.
    this.x = startX; this.y = startY;
    const table = chair.getAdjacentTable(sim.grid);
    chair.occupyingCustomer = this; table.occupyingCustomer = this;
    this.chair = chair; this.table = table;
    this.setPath(path); this.state = CS.WALKING;
    this.queueSlot = null;
  }

  leave(sim, reason) {
    this.leftReason = reason;
    if (this.chair) this.chair.occupyingCustomer = null;
    if (this.table) this.table.occupyingCustomer = null;
    this.state = CS.LEAVING;
    this.queueSlot = null;

    // Abandon any in-flight order so cooks don't deliver to an empty seat.
    if (this.order) {
      const o = this.order;
      if (o.status !== 'delivered') o.status = 'abandoned';
      if (o.assignedStove) {
        if (o.assignedStove.reservedFor === o) o.assignedStove.reservedFor = null;
        if (o.assignedStove.cooking && o.assignedStove.cooking.order === o) {
          o.assignedStove.cooking = null;
        }
      }
      if (o.readyStove) o.readyStove = null;
    }

    if (reason === 'happy') { sim.stats.served++; sim.money += FOODS[this.foodPref].price; }
    else sim.stats.angry++;

    // Queue-giver-upper: off-grid, just storm west.
    if (this.x < 0) { this.setPath([{ x: -5, y: this.y }]); return; }

    const exit = sim.exitTile;
    const path = sim.pathfinder.findPath(
      this.tileX(), this.tileY(),
      (x, y) => x === exit.x && y === exit.y,
      (x, y) => sim.grid.isWalkable(x, y));
    if (path) this.setPath(path); else this.alive = false;
  }
}

const ES = {
  IDLE: 'idle',
  TO_STOVE_COOK: 'to-stove-cook',
  TO_STOVE_PICKUP: 'to-stove-pickup',
  TO_TABLE_DELIVER: 'to-table-deliver',
  TO_TABLE_PICKUP_DIRTY: 'to-table-pickup-dirty',
  TO_SINK_DROP: 'to-sink-drop',
};

class Employee extends Entity {
  constructor(x, y) {
    super(x, y);
    this.speed = CONFIG.employeeSpeed;
    this.state = ES.IDLE;
    this.task = null;
    this.carrying = null;
    this.carryingDirty = false;
    // SKIN_TONES lives in sprites.js.
    this.skinColor = SKIN_TONES[(Math.random() * SKIN_TONES.length) | 0];
  }

  pathToAdjacent(sim, tx, ty) {
    return sim.pathfinder.findPath(
      this.tileX(), this.tileY(),
      (x, y) => sim.grid.isWalkable(x, y) && sim.grid.neighbors4(x, y).some(n => n.x === tx && n.y === ty),
      (x, y) => sim.grid.isWalkable(x, y));
  }

  update(dt, sim) {
    const arrived = this.stepMovement(dt);
    if (this.state === ES.IDLE) { this.findTask(sim); return; }
    // customer.alive stays true through LEAVING, so check state explicitly
    // or we'll deliver a plate to a walking-out customer.
    if (this.task && this.task.order) {
      const c = this.task.order.customer;
      if (!c.alive || c.state !== CS.WAITING) { this.abortTask(); return; }
    }
    if (arrived) this.onArrival(sim);
  }

  findTask(sim) {
    // Priority 1: pick up ready food.
    for (const o of sim.orders) {
      if (o.status !== 'ready' || o.deliveryEmployee) continue;
      if (!o.customer.alive || !o.customer.table) { o.status = 'abandoned'; continue; }
      const stove = o.readyStove; if (!stove) continue;
      const path = this.pathToAdjacent(sim, stove.x, stove.y); if (!path) continue;
      o.deliveryEmployee = this;
      this.task = { order: o, stove };
      this.setPath(path); this.state = ES.TO_STOVE_PICKUP; return;
    }
    // Priority 2: start cooking a pending order.
    for (const o of sim.orders) {
      if (o.status !== 'pending' || o.cookingEmployee) continue;
      for (const stove of sim.buildings) {
        if (stove.type !== 'stove' || !stove.isAvailable()) continue;
        const path = this.pathToAdjacent(sim, stove.x, stove.y);
        if (!path) continue;
        o.cookingEmployee = this; o.assignedStove = stove;
        stove.reservedFor = o;
        this.task = { order: o, stove };
        this.setPath(path); this.state = ES.TO_STOVE_COOK; return;
      }
    }
    // Priority 3: clear a dirty plate.
    for (const b of sim.buildings) {
      if (b.type !== 'table' || !b.plate || !b.plate.dirty || b.cleaningAssigned) continue;
      if (b.occupyingCustomer) continue;
      let chosenSink = null;
      for (const s of sim.buildings) {
        if (s.type !== 'sink' || !s.isAvailable()) continue;
        chosenSink = s; break;
      }
      if (!chosenSink) continue;
      const path = this.pathToAdjacent(sim, b.x, b.y); if (!path) continue;
      b.cleaningAssigned = true;
      chosenSink.reservedFor = b;
      this.task = { table: b, sink: chosenSink };
      this.setPath(path); this.state = ES.TO_TABLE_PICKUP_DIRTY; return;
    }
  }

  onArrival(sim) {
    const t = this.task;
    if (!t) { this.state = ES.IDLE; return; }
    switch (this.state) {
      case ES.TO_STOVE_COOK: {
        if (t.stove && t.stove.reservedFor === t.order && !t.stove.isCooking()) {
          t.stove.startCooking(t.order); t.order.status = 'cooking';
        } else {
          t.order.status = 'pending'; t.order.assignedStove = null;
          if (t.stove) t.stove.reservedFor = null;
        }
        t.order.cookingEmployee = null;
        this.task = null; this.state = ES.IDLE; break;
      }
      case ES.TO_STOVE_PICKUP: {
        this.carrying = t.order;
        const table = t.order.customer.table;
        if (!table) { this.abortTask(); break; }
        const path = this.pathToAdjacent(sim, table.x, table.y);
        if (!path) { this.abortTask(); break; }
        this.setPath(path); this.state = ES.TO_TABLE_DELIVER; break;
      }
      case ES.TO_TABLE_DELIVER: {
        const c = t.order.customer;
        const table = c.table;
        if (table && c.alive && c.state === CS.WAITING) {
          table.plate = { foodType: t.order.foodType, dirty: false };
          t.order.status = 'delivered';
        } else {
          t.order.status = 'abandoned';
        }
        this.carrying = null; t.order.deliveryEmployee = null;
        this.task = null; this.state = ES.IDLE; break;
      }
      case ES.TO_TABLE_PICKUP_DIRTY: {
        if (t.table && t.table.plate && t.table.plate.dirty) {
          this.carryingDirty = true;
          t.table.plate = null;
          t.table.cleaningAssigned = false;
          if (!t.sink || !t.sink.tile) { this.abortTask(); break; }
          const path = this.pathToAdjacent(sim, t.sink.x, t.sink.y);
          if (!path) { this.abortTask(); break; }
          this.setPath(path); this.state = ES.TO_SINK_DROP;
        } else {
          if (t.table) t.table.cleaningAssigned = false;
          if (t.sink)  t.sink.reservedFor = null;
          this.task = null; this.state = ES.IDLE;
        }
        break;
      }
      case ES.TO_SINK_DROP: {
        if (t.sink && t.sink.tile && !t.sink.isWashing()) {
          t.sink.startWashing(); sim.stats.plates++;
        } else if (t.sink) { t.sink.reservedFor = null; }
        this.carryingDirty = false;
        this.task = null; this.state = ES.IDLE; break;
      }
    }
  }

  abortTask() {
    const t = this.task;
    if (t) {
      if (t.order) {
        const o = t.order;
        o.cookingEmployee = null; o.deliveryEmployee = null;
        if (t.stove && t.stove.reservedFor === o) t.stove.reservedFor = null;
        if (t.stove && t.stove.cooking && t.stove.cooking.order === o) t.stove.cooking = null;
        if (o.status !== 'delivered') o.status = 'abandoned';
      }
      if (t.table) t.table.cleaningAssigned = false;
      if (t.sink)  t.sink.reservedFor = null;
    }
    this.carrying = null; this.carryingDirty = false;
    this.task = null; this.state = ES.IDLE;
  }
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
    this.stats = { served: 0, angry: 0, plates: 0 };
    this.spawnTile = { x: 0, y: 4 };
    this.exitTile  = { x: 0, y: 4 };
    this.grid.setType(this.spawnTile.x, this.spawnTile.y, 'spawn');
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

    this.hireEmployee(true); this.hireEmployee(true);
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

  removeBuildingAt(x, y) {
    const b = this.grid.removeBuildingAt(x, y); if (!b) return false;
    b.onRemoved(this);
    const i = this.buildings.indexOf(b); if (i >= 0) this.buildings.splice(i, 1);
    if (b.type === 'chair' && b.occupyingCustomer) b.occupyingCustomer.leave(this, 'angry');
    if (b.type === 'table' && b.occupyingCustomer) b.occupyingCustomer.leave(this, 'angry');
    this.money += Math.floor((CONFIG.costs[b.type] || 0) * CONFIG.refundRatio);
    return true;
  }

  hireEmployee(free = false) {
    if (!free && this.money < CONFIG.costs.employee) return false;
    if (!free) this.money -= CONFIG.costs.employee;
    this.employees.push(new Employee(this.spawnTile.x, this.spawnTile.y));
    return true;
  }

  spawnCustomer() {
    if (this.customers.filter(c => c.alive).length >= CONFIG.customerMaxConcurrent) return;
    this.customers.push(new Customer(this.spawnTile.x, this.spawnTile.y, this.time));
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
    if (this.spawnEnabled) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = CONFIG.customerSpawnInterval / this.trafficMultiplier;
        this.spawnCustomer();
      }
    }
    for (const b of this.buildings) b.update(dt, this);
    for (const e of this.employees) e.update(dt, this);
    for (const c of this.customers) if (c.alive) c.update(dt, this);
    this.customers = this.customers.filter(c => c.alive);
    this.orders = this.orders.filter(o =>
      o.status !== 'delivered' && o.status !== 'abandoned' && o.status !== 'lost' && o.customer.alive);
  }

  orderCountsByStatus() {
    const c = { pending: 0, cooking: 0, ready: 0 };
    for (const o of this.orders) if (c[o.status] !== undefined) c[o.status]++;
    return c;
  }
}
