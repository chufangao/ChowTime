/* ============================================================================
 * entities/customer.js — Entity (movement base), CS state enum, Customer
 * ============================================================================ */

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
    this.speed = CONFIG.customerSpeed;
    this.state = CS.ENTERING;
    this.foodPref = FOOD_KEYS[(Math.random() * FOOD_KEYS.length) | 0];
    this.anger = 0;
    this.chair = null; this.table = null; this.order = null;
    this.eatTimer = 0; this.retrySeatTimer = 0;
    this.leftReason = null;

    // Tip bookkeeping: seatedAt set when entering WAITING, deliveredAt when
    // a plate lands, tipAwarded written at 'happy' leave so the floater sprite
    // can render it above the exiting customer.
    this.seatedAt    = null;
    this.deliveredAt = null;
    this.deliveredBy = null;
    this.tipAwarded  = 0;

    // Ability system. Filled in by sim.spawnCustomer right after construction
    // so the constructor stays side-effect free; defaults cover anything that
    // bypasses spawnCustomer.
    this.abilities       = [];
    this.ordersRemaining = 1;
    this.abilityAnnounced = false;

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
    let rate = 0; let stateKey = null;
    if (this.state === CS.ENTERING || this.state === CS.SEEKING) { rate = CONFIG.angerRates.seekingSeat; stateKey = 'seekingSeat'; }
    else if (this.state === CS.WALKING) { rate = CONFIG.angerRates.walkingToSeat; stateKey = 'walkingToSeat'; }
    else if (this.state === CS.WAITING) { rate = CONFIG.angerRates.waitingFood;   stateKey = 'waitingFood'; }
    else if (this.state === CS.EATING)  { rate = CONFIG.angerRates.eating;        stateKey = 'eating'; }
    rate *= abilityMult(this, 'angerMult', stateKey);
    this.anger = Math.min(CONFIG.angerMax, this.anger + rate * dt);
    if (this.anger >= CONFIG.angerMax && this.state !== CS.LEAVING) { this.leave(sim, 'angry'); return; }

    switch (this.state) {
      case CS.ENTERING:
        this.state = CS.SEEKING;
        break;
      case CS.SEEKING:
        // No door queue: each seeker waits where it entered and tries to grab
        // an open seat on its own retry timer. trySeat reserves the chair
        // atomically, so parallel seekers don't double-book within a tick.
        this.retrySeatTimer -= dt;
        if (this.retrySeatTimer <= 0) {
          this.retrySeatTimer = 0.6;
          this.trySeat(sim);
        }
        break;
      case CS.WALKING:
        if (arrived) {
          this.state = CS.WAITING;
          this.seatedAt = sim.time;
          this.order = new Order(this, this.foodPref);
          sim.submitOrder(this.order);
          // Announce ability once the customer is visibly seated, not the
          // moment they spawn off-screen.
          if (!this.abilityAnnounced) {
            fireAbilityHook(this, 'onEnter', { sim });
            this.abilityAnnounced = true;
          }
        }
        break;
      case CS.WAITING:
        if (this.table && this.table.plate && !this.table.plate.dirty &&
            this.table.plate.foodType === this.foodPref) {
          this.state = CS.EATING;
          // Broken tables eat twice as slow (wobbly cutlery, sticky surface…).
          this.eatTimer = CONFIG.eatDuration * abilityMult(this, 'eatTimeMult', this.foodPref) * this.table.workMult;
          fireAbilityHook(this, 'onEat', { sim, foodKey: this.foodPref });
        }
        break;
      case CS.EATING:
        this.eatTimer -= dt;
        if (this.eatTimer <= 0) {
          if (this.table && this.table.plate) this.table.plate.dirty = true;
          this._consumePlate(sim);
        }
        break;
      case CS.LEAVING:
        if (arrived || !this.hasPath()) this.alive = false;
        break;
    }
  }

  // Called when one course finishes. Credits price + tip now rather than at
  // leave, so a multi-order customer earns per-course instead of lump-sum. If
  // more orders remain, rolls a fresh foodPref and re-enters WAITING with a
  // new Order; the dirty plate is cleared by the standard wash flow (or
  // overwritten by the next delivery).
  _consumePlate(sim) {
    const price = FOODS[this.foodPref].price;
    let tip     = computeTip(this);
    // Today's forecast-driven tip multiplier (e.g. "generous tippers").
    if (sim.todayProfile && sim.todayProfile.tipMult) {
      tip = Math.round(tip * sim.todayProfile.tipMult);
    }
    this.tipAwarded += tip;
    sim.money       += price + tip;
    sim.stats.tipsTotal += tip; sim.runStats.tipsTotal += tip;
    sim.stats.served++;         sim.runStats.served++;
    // Credit the delivering chef's end-of-day report (career + today).
    const cook = this.deliveredBy;
    if (cook) {
      cook.dayStats.dishes++;     cook.career.dishes++;
      cook.dayStats.tipsEarned += tip;
      cook.career.tipsEarned   += tip;
    }
    sim.emitPopup(this, '💰', `+$${price + tip}`);

    this.ordersRemaining--;
    if (this.ordersRemaining > 0) {
      // Re-enter WAITING with a fresh order. Randomize foodPref so the second
      // course isn't a guaranteed duplicate. Reset anger — a successful course
      // is a satisfying moment, and without this multi-course customers carry
      // their course-1 anger straight into course 2 and rage-quit before the
      // chef can even finish cooking.
      this.anger = 0;
      this.state = CS.WAITING;
      this.foodPref = FOOD_KEYS[(Math.random() * FOOD_KEYS.length) | 0];
      this.order = new Order(this, this.foodPref);
      this.seatedAt    = sim.time;
      this.deliveredAt = null;
      this.deliveredBy = null;
      sim.submitOrder(this.order);
      sim.emitPopup(this, '🍴', 'Another, please');
    } else {
      this.leave(sim, 'happy');
    }
  }

  trySeat(sim) {
    const chair = sim.findAvailableChair();
    if (!chair) return;
    const startX = Math.round(this.x), startY = Math.round(this.y);
    if (!sim.grid.inBounds(startX, startY)) return;
    const path = sim.pathfinder.findPathToTargets(
      startX, startY, [{ x: chair.x, y: chair.y }],
      (x, y) => sim.grid.isWalkable(x, y));
    if (!path) return;
    // Snap to tile so stepMovement starts cleanly.
    this.x = startX; this.y = startY;
    const table = chair.getAdjacentTable(sim.grid);
    chair.occupyingCustomer = this; table.occupyingCustomer = this;
    this.chair = chair; this.table = table;
    this.setPath(path); this.state = CS.WALKING;
  }

  leave(sim, reason) {
    this.leftReason = reason;
    if (this.chair) this.chair.occupyingCustomer = null;
    if (this.table) this.table.occupyingCustomer = null;
    this.state = CS.LEAVING;

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

    // 'angry' is the only non-happy reason now (rage-max). It both logs the
    // stat and costs a life.
    if (reason === 'angry') {
      sim.stats.angry++; sim.runStats.angry++;
      if (!sim.gameOver && !sim.debug) {
        sim.reputation -= (CONFIG.reputationAngryHit || 0);
        if (sim.reputation <= 0) {
          sim.reputation = 0;
          sim.gameOver = true;
          sim.spawnEnabled = false;
        }
      }
    }
    // Happy-path earnings are credited per course in _consumePlate; nothing
    // else to do here beyond the state transition and exit path.

    // Exit via the nearest door we can actually reach. Try doors in ascending
    // Manhattan distance; the first with a valid path wins. Only give up
    // (alive=false) if none are reachable (e.g. every door walled off).
    const here = { x: this.tileX(), y: this.tileY() };
    const doors = sim.spawnTiles.slice().sort((a, b) =>
      (Math.abs(a.x - here.x) + Math.abs(a.y - here.y)) -
      (Math.abs(b.x - here.x) + Math.abs(b.y - here.y)));
    let routed = false;
    for (const exit of doors) {
      const path = sim.pathfinder.findPathToTargets(
        here.x, here.y, [{ x: exit.x, y: exit.y }],
        (x, y) => sim.grid.isWalkable(x, y));
      if (path) { this.setPath(path); routed = true; break; }
    }
    if (!routed) this.alive = false;
  }
}
