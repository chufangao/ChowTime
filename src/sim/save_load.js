/* ============================================================================
 * sim/save_load.js — Serialize / deserialize a full game state to JSON
 * ============================================================================
 * Two functions:
 *   serializeSim(sim, uiState)   → plain JSON object
 *   deserializeSim(json)         → { sim, uiState }
 *
 * Plus a test helper:
 *   describeSim(sim)             → small flat snapshot used to deep-equal
 *                                   two sims after a round-trip without
 *                                   tripping over object identity.
 *
 * Design rules:
 *   - Cross-references (order.customer, customer.table, etc.) serialize as
 *     ids and re-link in a second deserialize pass. Every entity already
 *     carries an id from its constructor counter (see _bid, _eid, _oid).
 *   - sim.pathfinder is derived from the grid; we drop it on save and
 *     reconstruct it on load.
 *   - In-flight projectiles are dropped (saving is gated to dayState ===
 *     'dayEnd', when the queue is empty).
 *   - currentEvent is referenced by id only; the live event object is
 *     looked up from EVENTS at load time. Same for nextForecast.
 *   - RNG state is NOT serialized — Math.random is process-global and
 *     reseeding mid-run is intentionally out of scope. Document this for
 *     callers who need post-load determinism.
 * ========================================================================== */

function serializeSim(sim, uiState) {
  // --- Buildings ---
  const buildings = sim.buildings.map(b => ({
    id: b.id,
    type: b.type,
    x: b.x, y: b.y,
    placedAt: b.placedAt || 0,
    broken: !!b.broken,
    facing: b.facing != null ? b.facing : null,
    // Nothing else transient (no in-flight cooking/washing or reservations);
    // saves are restricted to dayState='dayEnd' so these are guaranteed-empty.
  }));

  // --- Employees ---
  const employees = sim.employees.map(e => ({
    id: e.id,
    name: e.name, bio: e.bio,
    dex: e.dex, spd: e.spd, str: e.str, int: e.int, cha: e.cha,
    abilities: (e.abilities || []).slice(),
    isStarter: !!e.isStarter,
    visual: e.visual ? { ...e.visual } : null,
    stamina: e.stamina, staminaMax: e.staminaMax, tired: !!e.tired,
    dayStats: e.dayStats ? { ...e.dayStats } : null,
    career:   e.career   ? { ...e.career }   : null,
    status:   e.status   ? { ...e.status }   : null,
    spawnPoint: e.spawnPoint ? { x: e.spawnPoint.x, y: e.spawnPoint.y } : null,
    x: e.x, y: e.y,
  }));

  // --- Recruit pool (live remaining roster) ---
  const recruitPool = (sim.recruitPool || []).map(p => ({ ...p }));

  // --- Walls (player partitions only) and gaps (default-layout obstacles).
  // Both are tile state, not Building instances. ---
  const walls = [];
  const gaps  = [];
  for (let y = 0; y < sim.grid.rows; y++) {
    for (let x = 0; x < sim.grid.cols; x++) {
      const t = sim.grid.tiles[y][x];
      if (!t) continue;
      if (t.type === 'wall') walls.push({ x, y, kind: t.wallKind || 'player' });
      else if (t.type === 'gap') gaps.push({ x, y });
    }
  }

  // --- Day / run state ---
  const out = {
    version: 2,
    sim: {
      time: sim.time,
      money: sim.money,
      reputation: sim.reputation, reputationMax: sim.reputationMax,
      gameOver: sim.gameOver,
      debug: sim.debug,
      day: sim.day, daySpawned: sim.daySpawned,
      dayQuota: sim.dayQuota, dayState: sim.dayState,
      dayStartMoney: sim.dayStartMoney,
      stats: { ...sim.stats },
      runStats: { ...sim.runStats },
      todayProfile: { ...(sim.todayProfile || {}) },
      nextForecast: sim.nextForecast ? { label: sim.nextForecast.label, profile: { ...sim.nextForecast.profile } } : null,
      freeHireCredits: sim._freeHireCredits || 0,
      bootEventDone: !!sim._bootEventDone,
      currentEventId: sim.currentEvent ? sim.currentEvent.id : null,
      currentEventKind: sim.currentEvent ? (sim.currentEvent.kind || 'event') : null,
      eventOutcome:   sim.eventOutcome ? {
        passed: sim.eventOutcome.passed, roll: sim.eventOutcome.roll,
        total:  sim.eventOutcome.total,  dc:   sim.eventOutcome.dc,
        msg:    sim.eventOutcome.msg,    chefId: sim.eventOutcome.chef ? sim.eventOutcome.chef.id : null,
        // result.profile is data; result.statusOverride too. Functions never
        // make it into the outcome stash.
        result: sim.eventOutcome.result ? {
          msg: sim.eventOutcome.result.msg,
          profile: sim.eventOutcome.result.profile ? { ...sim.eventOutcome.result.profile } : null,
          statusOverride: sim.eventOutcome.result.statusOverride ? { ...sim.eventOutcome.result.statusOverride } : null,
        } : null,
      } : null,
      // Midday event (mid-service). Live def is re-linked at load via id.
      middayEventId: sim.middayEvent ? sim.middayEvent.id : null,
      middayEventRolledToday: !!sim.middayEventRolledToday,
      middayEventTriggerAt: sim.middayEventTriggerAt != null ? sim.middayEventTriggerAt : null,
      recentMiddayEvents: (sim._recentMiddayEvents || []).slice(),
      preMiddayState: sim.preMiddayState || null,
      middayOutcome: sim.middayOutcome ? {
        choiceIdx: sim.middayOutcome.choiceIdx,
        kind:      sim.middayOutcome.kind,
        passed:    sim.middayOutcome.passed,
        roll:      sim.middayOutcome.roll,
        total:     sim.middayOutcome.total,
        dc:        sim.middayOutcome.dc,
        msg:       sim.middayOutcome.msg,
        chefId:    sim.middayOutcome.chef ? sim.middayOutcome.chef.id : null,
      } : null,
      freeBuildCredits: (sim.freeBuildCredits || []).slice(),
      // Event history log (per-run, persists across days). One small object
      // per resolution; the Review tab renders these. We store plain
      // serialisable fields only — see EventManager._logHistoryEntry.
      eventHistory: Array.isArray(sim.eventHistory)
        ? sim.eventHistory.map(h => ({ ...h }))
        : [],
      trafficMultiplier: sim.trafficMultiplier,
      spawnTiles: (sim.spawnTiles || [sim.spawnTile]).map(d => ({ x: d.x, y: d.y })),
      layoutId: sim.layoutId || null,
      walls, gaps,
      buildings, employees, recruitPool,
      // No customers, orders, projectiles — saves are at dayEnd.
    },
    ui: uiState || null,
  };
  return out;
}

function deserializeSim(json) {
  if (!json || (json.version !== 1 && json.version !== 2)) throw new Error('Bad save version');
  const data = json.sim;
  const sim = new Simulation();

  // A bare `new Simulation()` does NOT call seedDemo, so there's no
  // auto-applied layout to wipe. But the constructor does set a default
  // spawn tile at (0,4); clear it before replaying the saved spawn so we
  // don't end up with two 'spawn' tiles.
  for (const d of (sim.spawnTiles || [])) {
    const ts = sim.grid.getTile(d.x, d.y);
    if (ts && ts.type === 'spawn') sim.grid.setType(d.x, d.y, 'floor');
  }
  // Wipe defaults so we don't double-up demo state.
  sim.buildings.length = 0;
  sim.employees.length = 0;
  sim.recruitPool.length = 0;

  // Replay walls (player partitions only).
  if (Array.isArray(data.walls)) {
    for (const w of data.walls) {
      if (!sim.grid.inBounds(w.x, w.y)) continue;
      sim.grid.setType(w.x, w.y, 'wall');
      const t = sim.grid.getTile(w.x, w.y);
      if (t) t.wallKind = w.kind || 'player';
    }
  }

  // Replay gaps (default-layout obstacles). Tile state, no extra fields.
  if (Array.isArray(data.gaps)) {
    for (const gp of data.gaps) {
      if (!sim.grid.inBounds(gp.x, gp.y)) continue;
      sim.grid.setType(gp.x, gp.y, 'gap');
    }
  }

  // Place buildings via Simulation.placeBuilding(free=true) so the grid
  // tracks them and ids are stable. We reset the building id counter so
  // the live ids match the saved ids — this is mildly hacky but the
  // alternative (rewiring all references afterwards) is messier.
  const idMap = { buildings: new Map(), employees: new Map() };
  for (const bs of data.buildings) {
    const res = sim.placeBuilding(bs.type, bs.x, bs.y, true);
    if (!res.ok) continue;
    const b = sim.buildings[sim.buildings.length - 1];
    b.placedAt = bs.placedAt || 0;
    b.broken = !!bs.broken;
    b.facing = (bs.facing != null) ? bs.facing : null;
    idMap.buildings.set(bs.id, b);
  }

  // Recruit pool BEFORE employees so hire flows reproduce the same shape.
  for (const p of data.recruitPool) sim.recruitPool.push({ ...p });

  // Employees: reconstruct via Employee preset signature.
  for (const es of data.employees) {
    const preset = {
      name: es.name, bio: es.bio,
      dex: es.dex, spd: es.spd, str: es.str, int: es.int, cha: es.cha,
      abilities: es.abilities, isStarter: es.isStarter,
      visual: es.visual,
    };
    const e = new Employee(es.x, es.y, preset);
    if (es.stamina != null) e.stamina = es.stamina;
    if (es.staminaMax != null) e.staminaMax = es.staminaMax;
    if (es.tired != null) e.tired = !!es.tired;
    if (es.dayStats) e.dayStats = { ...es.dayStats };
    if (es.career)   e.career   = { ...es.career };
    if (es.status)   e.status   = { ...es.status };
    e.spawnPoint = es.spawnPoint ? { x: es.spawnPoint.x, y: es.spawnPoint.y } : null;
    sim.employees.push(e);
    idMap.employees.set(es.id, e);
  }

  // Day / run state
  sim.time          = data.time;
  sim.money         = data.money;
  // v2: reputation. v1: lives — map via the same threshold rule used in the
  // hearts→reputation rewrite (any positive lives → full reputation).
  if (data.reputation != null) {
    sim.reputation    = data.reputation;
    sim.reputationMax = data.reputationMax;
  } else {
    sim.reputationMax = CONFIG.reputationMax;
    sim.reputation    = (data.lives > 0) ? CONFIG.reputationStart : 0;
  }
  sim.gameOver      = !!data.gameOver;
  sim.debug         = !!data.debug;
  sim.day           = data.day;
  sim.daySpawned    = data.daySpawned;
  sim.dayQuota      = data.dayQuota;
  sim.dayState      = data.dayState;
  sim.dayStartMoney = data.dayStartMoney;
  sim.stats         = { ...data.stats };
  sim.runStats      = { ...data.runStats };
  sim.todayProfile  = { ...(data.todayProfile || {}) };
  sim.nextForecast  = data.nextForecast ? { label: data.nextForecast.label, profile: { ...(data.nextForecast.profile || {}) } } : null;
  sim.trafficMultiplier = data.trafficMultiplier;
  sim._freeHireCredits = data.freeHireCredits || 0;
  sim._bootEventDone = !!data.bootEventDone;
  sim.layoutId       = data.layoutId || null;
  // Multi-door spawn tiles. Migration: legacy saves with single `spawnTile`
  // wrap into a one-element array.
  const savedDoors = Array.isArray(data.spawnTiles)
    ? data.spawnTiles
    : (data.spawnTile ? [data.spawnTile] : null);
  if (savedDoors && savedDoors.length) {
    sim.spawnTiles = savedDoors.map(d => ({ x: d.x, y: d.y }));
    for (const d of sim.spawnTiles) sim.grid.setType(d.x, d.y, 'spawn');
  }

  // Re-link the day-end event by id. Gift events aren't in EVENTS — re-roll
  // a fresh gift if the saved event was the boot gift and the player hadn't
  // resolved it yet. (After resolution we still re-link to EVENTS by id so
  // eventOutcome's chef ref + msg display work; the choice closures aren't
  // needed once the outcome is set.)
  if (data.currentEventKind === 'gift' && !data.eventOutcome && typeof rollGiftEvent === 'function') {
    sim.currentEvent = rollGiftEvent();
  } else if (data.currentEventId && typeof getDailyEventById === 'function') {
    sim.currentEvent = getDailyEventById(data.currentEventId);
  } else {
    sim.currentEvent = null;
  }
  if (data.eventOutcome) {
    const chef = idMap.employees.get(data.eventOutcome.chefId) || null;
    sim.eventOutcome = {
      passed: data.eventOutcome.passed,
      roll:   data.eventOutcome.roll,
      total:  data.eventOutcome.total,
      dc:     data.eventOutcome.dc,
      msg:    data.eventOutcome.msg,
      chef,
      result: data.eventOutcome.result ? { ...data.eventOutcome.result } : null,
    };
  } else {
    sim.eventOutcome = null;
  }
  // Midday event re-link via the id-lookup helper.
  if (data.middayEventId && typeof getMiddayEventById === 'function') {
    sim.middayEvent = getMiddayEventById(data.middayEventId);
  } else {
    sim.middayEvent = null;
  }
  sim.middayEventRolledToday = !!data.middayEventRolledToday;
  sim.middayEventTriggerAt   = data.middayEventTriggerAt != null ? data.middayEventTriggerAt : null;
  sim._recentMiddayEvents    = Array.isArray(data.recentMiddayEvents) ? data.recentMiddayEvents.slice() : [];
  sim.preMiddayState         = data.preMiddayState || null;
  if (data.middayOutcome) {
    const chef = idMap.employees.get(data.middayOutcome.chefId) || null;
    sim.middayOutcome = {
      choiceIdx: data.middayOutcome.choiceIdx,
      kind:      data.middayOutcome.kind,
      passed:    !!data.middayOutcome.passed,
      roll:      data.middayOutcome.roll,
      total:     data.middayOutcome.total,
      dc:        data.middayOutcome.dc,
      msg:       data.middayOutcome.msg,
      chef,
      result:    null,
    };
  } else {
    sim.middayOutcome = null;
  }
  sim.freeBuildCredits = Array.isArray(data.freeBuildCredits) ? data.freeBuildCredits.slice() : [];
  sim.eventHistory     = Array.isArray(data.eventHistory)
    ? data.eventHistory.map(h => ({ ...h }))
    : [];

  return { sim, uiState: json.ui || null };
}

/** Small flat snapshot used by tests to compare two sims after a round-trip
 *  without crashing on Reference identity. Captures the parts that matter:
 *  money, lives, day state, building/employee counts, key ids. */
function describeSim(sim) {
  // Walls (player partitions) and gaps (default-layout obstacles) captured
  // for round-trip parity (count + sorted list, with kind).
  const walls = [];
  const gaps = [];
  for (let y = 0; y < sim.grid.rows; y++) {
    for (let x = 0; x < sim.grid.cols; x++) {
      const t = sim.grid.tiles[y][x];
      if (!t) continue;
      if (t.type === 'wall') walls.push({ x, y, kind: t.wallKind || 'player' });
      else if (t.type === 'gap') gaps.push({ x, y });
    }
  }
  walls.sort((a, b) => a.x - b.x || a.y - b.y || a.kind.localeCompare(b.kind));
  gaps.sort((a, b) => a.x - b.x || a.y - b.y);
  const doors = (sim.spawnTiles || (sim.spawnTile ? [sim.spawnTile] : []))
    .map(d => ({ x: d.x, y: d.y }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  return {
    money: sim.money,
    reputation: sim.reputation, reputationMax: sim.reputationMax,
    gameOver: sim.gameOver,
    day: sim.day, dayState: sim.dayState, dayQuota: sim.dayQuota,
    dayStartMoney: sim.dayStartMoney,
    daySpawned: sim.daySpawned,
    debug: sim.debug,
    freeHireCredits: sim._freeHireCredits || 0,
    trafficMultiplier: sim.trafficMultiplier,
    layoutId: sim.layoutId || null,
    spawnTiles: doors,
    walls, gaps,
    stats: { ...sim.stats },
    runStats: { ...sim.runStats },
    buildings: sim.buildings.map(b => ({ type: b.type, x: b.x, y: b.y, broken: !!b.broken, facing: b.facing != null ? b.facing : null })).sort((a, b) => a.x - b.x || a.y - b.y || a.type.localeCompare(b.type)),
    employees: sim.employees.map(e => ({
      name: e.name, dex: e.dex, spd: e.spd, str: e.str, int: e.int, cha: e.cha,
      isStarter: !!e.isStarter, abilities: (e.abilities || []).slice().sort(),
      tired: !!e.tired,
      status: e.status ? { ...e.status } : null,
      spawnPoint: e.spawnPoint ? { x: e.spawnPoint.x, y: e.spawnPoint.y } : null,
    })),
    recruitPool: (sim.recruitPool || []).map(p => p.id).sort((a, b) => a - b),
    currentEventId: sim.currentEvent ? sim.currentEvent.id : null,
    eventOutcomePassed: sim.eventOutcome ? sim.eventOutcome.passed : null,
    middayEventId: sim.middayEvent ? sim.middayEvent.id : null,
    middayOutcomeMsg: sim.middayOutcome ? sim.middayOutcome.msg : null,
    middayRolledToday: !!sim.middayEventRolledToday,
    middayTriggerAt: sim.middayEventTriggerAt != null ? sim.middayEventTriggerAt : null,
    recentMiddayEvents: (sim._recentMiddayEvents || []).slice(),
    freeBuildCredits: (sim.freeBuildCredits || []).slice().sort(),
  };
}
