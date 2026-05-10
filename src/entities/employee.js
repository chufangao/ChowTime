/* ============================================================================
 * entities/employee.js — ES state enum + Employee (chef) state machine
 * ============================================================================ */

const ES = {
  IDLE: 'idle',
  TO_STOVE_COOK: 'to-stove-cook',
  TO_STOVE_PICKUP: 'to-stove-pickup',
  TO_TABLE_DELIVER: 'to-table-deliver',
  TO_TABLE_PICKUP_DIRTY: 'to-table-pickup-dirty',
  TO_SINK_DROP: 'to-sink-drop',
};

class Employee extends Entity {
  constructor(x, y, preset = STARTER_CHEF) {
    super(x, y);
    this.state = ES.IDLE;
    this.task = null;
    this.carrying = null;
    this.carryingDirty = false;

    // Identity + stats from the roster preset (pure data, no Phaser).
    this.name = preset.name;
    this.bio  = preset.bio;
    this.dex  = preset.dex;
    this.spd  = preset.spd;
    this.str  = preset.str;
    this.int  = preset.int;
    this.cha  = preset.cha;
    this.abilities = (preset.abilities || []).slice();

    // Visuals: prefer preset values; fall back to random SKIN_TONES pick so
    // two starter chefs don't look identical.
    const v = preset.visual || {};
    this.visual = {
      skinColor: v.skinColor != null ? v.skinColor
                 : SKIN_TONES[(Math.random() * SKIN_TONES.length) | 0],
      hairColor: v.hairColor != null ? v.hairColor : 0x3a2a1a,
      hasHair:   v.hasHair === true,
      hat:       v.hat != null ? v.hat : 0,
    };
    // Legacy alias used by parts of Sprites.employee that read e.skinColor.
    this.skinColor = this.visual.skinColor;

    // Stamina / tired: STR drives tank size. Starts full; ticks down while
    // working, regenerates while IDLE. Tired is a flag (hysteresis set in
    // update), not a state — the chef keeps working at 75%.
    this.staminaMax = 30 + 6 * this.str;
    this.stamina    = this.staminaMax;
    this.tired      = false;

    // Speed is recomputed per-frame in update() so tiredness is responsive.
    this.speed = CONFIG.employeeSpeed * (0.7 + 0.06 * this.spd);

    // End-of-day report tracking. dayStats resets at day boundary; career
    // accumulates for the run. Status is an event-driven effect on next
    // day's availability / behavior (e.g. {kind:'busy', daysLeft:1}).
    this.isStarter = !!preset.isStarter;
    this.dayStats  = { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0 };
    this.career    = { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0, daysWorked: 0 };
    this.status    = null;
  }

  // A chef is unavailable for the day when recovering from an event. Starter
  // chefs never pick up this flag (see sim.resolveEvent).
  isAvailable() { return !this.status || this.status.kind !== 'busy'; }

  // Returns the stat scaled by the tired multiplier. STR is the one stat that
  // doesn't degrade when tired — it's the meta-stat that defines the tank.
  effStat(name) {
    let nominal = this[name];
    if (this.status && this.status.kind === 'stressed' && name === 'int') nominal = Math.max(1, nominal - 2);
    if (name === 'str' || !this.tired) return nominal;
    return nominal * CONFIG.tiredMult;
  }

  pathToAdjacent(sim, tx, ty) {
    return sim.pathfinder.findPath(
      this.tileX(), this.tileY(),
      (x, y) => sim.grid.isWalkable(x, y) && sim.grid.neighbors4(x, y).some(n => n.x === tx && n.y === ty),
      (x, y) => sim.grid.isWalkable(x, y));
  }

  update(dt, sim) {
    // Per-frame speed recompute so tiredness kicks in immediately.
    this.speed = CONFIG.employeeSpeed * (0.7 + 0.06 * this.effStat('spd'));

    // Stamina: decay while working, regenerate while idle. Tired flips with
    // hysteresis so the chef doesn't flicker on/off at the threshold.
    if (this.state !== ES.IDLE) {
      this.stamina -= dt;
    } else {
      this.stamina = Math.min(this.staminaMax, this.stamina + dt);
    }
    if (!this.tired && this.stamina <= 0) {
      this.tired = true;
      this.dayStats.timesTired++; this.career.timesTired++;
    } else if (this.tired && this.stamina >= this.staminaMax * 0.25) {
      this.tired = false;
    }

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
    // An event-recovering chef drops every task (regen stamina only).
    if (!this.isAvailable()) return;
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
          t.stove.startCooking(t.order, sim); t.order.status = 'cooking';
          fireAbilityHook(this, 'onCookStart', { sim, foodKey: t.order.foodType });
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
          table.plate = {
            foodType: t.order.foodType,
            dirty: false,
            quality: t.order.quality != null ? t.order.quality : 1.0,
          };
          c.deliveredAt = sim.time;
          c.deliveredBy = this;          // stash before order clears the ref
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
          t.sink.startWashing(); sim.stats.plates++; sim.runStats.plates++;
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
        // Note whether this was a live cook BEFORE we clear refs. A chef
        // aborting mid-cook should re-pend the order so another cook can
        // pick it up — but only if the customer hasn't already walked
        // (Customer.leave stamps status 'abandoned' first; respect that).
        const wasCooking = t.stove && t.stove.cooking && t.stove.cooking.order === o;
        o.cookingEmployee = null; o.deliveryEmployee = null;
        if (t.stove && t.stove.reservedFor === o) t.stove.reservedFor = null;
        if (wasCooking) t.stove.cooking = null;
        if (o.status !== 'delivered' && o.status !== 'abandoned') {
          if (wasCooking) {
            o.status = 'pending';
            o.assignedStove = null;
            o.readyStove = null;
          } else {
            o.status = 'abandoned';
          }
        }
      }
      if (t.table) t.table.cleaningAssigned = false;
      if (t.sink)  t.sink.reservedFor = null;
    }
    this.carrying = null; this.carryingDirty = false;
    this.task = null; this.state = ES.IDLE;
  }
}
