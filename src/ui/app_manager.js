/* ============================================================================
 * src/ui/app_manager.js — Single registry for apps, build items, status widgets
 * ============================================================================
 * Replaces the scattered isOpen flags on Sidebar/RecruitModal/DayEndModal/
 * GameOverModal with one source of truth. Owns:
 *
 *   apps         — Map<id, App> registered by name
 *   buildItems   — array of { id, label, cost, icon, category, validAt, place }
 *   widgets      — array of { id, render, describe } status widgets
 *   activeAppId  — id of the at-most-one open app, or null
 *
 * Auto-open priority: an app whose autoOpenWhen(sim) is true is opened
 * automatically each tick. Modal apps win over non-modal; later-registered
 * ties break in favour of the new entry (so game_over registered after
 * day_end always wins when both want to open). To make this deterministic
 * we sort by (isModal desc, registration order asc).
 *
 * The manager also owns:
 *   consumesPointer(p)  — single gate for GameScene's pointer pipeline
 *   onKey(key)          — single keyboard handler (ESC closes, etc.)
 * ========================================================================== */

class AppManager {
  constructor() {
    this.apps        = new Map();
    this.appOrder    = [];      // registration order (for top-bar layout)
    this.buildItems  = [];
    this.widgets     = [];
    this.activeAppId = null;
    this.activeMapToolId = null;  // convenience: id of active hasPanel=false app
    // GameScene fills this in so consumesPointer can hit-test the bar zones.
    // Each: { x, y, w, h }. Falsy means no top-bar gate.
    this.topBarRect  = null;
    this.scene       = null;
  }

  attachScene(scene) {
    this.scene = scene;
    for (const app of this.appOrder) {
      if (typeof app.init === 'function' && !app.layer) {
        app.manager = this;
        app.init(scene);
      }
    }
  }

  register(app) {
    if (this.apps.has(app.id)) throw new Error(`App already registered: ${app.id}`);
    app.manager = this;
    this.apps.set(app.id, app);
    this.appOrder.push(app);
    if (this.scene && typeof app.init === 'function' && !app.layer) {
      app.init(this.scene);
    }
    return app;
  }

  registerBuildItem(item) {
    // Adding a building = drop an entry in the build-items section at the
    // bottom of src/entities/buildings.js. BuildApp reads this list directly;
    // it has no hardcoded knowledge of any specific building.
    this.buildItems.push(item);
    return item;
  }

  registerWidget(widget) {
    this.widgets.push(widget);
    return widget;
  }

  get(id) { return this.apps.get(id) || null; }

  /** True when an app is currently locked-out by service phase. UI uses this
   *  to dim launchers; toggle/open use it to silently no-op user clicks. */
  isLockedNow(app) {
    if (!app || !app.lockedDuringService) return false;
    const sim = this._sim;
    if (!sim || sim.debug) return false;
    return typeof sim.isDayActive === 'function' && sim.isDayActive();
  }

  /** Open `id`, closing any other app first. Returns true on success.
   *  `auto=true` flags the open as automatic (driven by autoOpenWhen) so
   *  the manager can close it later when the condition flips off. User
   *  clicks (toggle/open from a launcher) leave it as a manual open. */
  open(id, auto = false) {
    const app = this.apps.get(id);
    if (!app) return false;
    if (this.isLockedNow(app)) return false;
    if (this.activeAppId && this.activeAppId !== id) this.close();
    if (app.hasPanel) {
      this.activeAppId = id;
      this.activeMapToolId = null;
    } else {
      // Map tools: no overlay; track separately so a panel app can also be
      // open simultaneously (e.g. Build app open + no map-tool, OR Move
      // active + no panel app — but never two map tools at once).
      // For simplicity: opening a map tool closes any panel app too.
      this.activeAppId = id;
      this.activeMapToolId = id;
    }
    this._activeAuto = !!auto;
    app.open();
    return true;
  }

  close() {
    if (!this.activeAppId) return;
    const app = this.apps.get(this.activeAppId);
    this.activeAppId = null;
    this.activeMapToolId = null;
    if (app) {
      app.close();
      if (!app.hasPanel && typeof app.onDeactivate === 'function') app.onDeactivate(this._sim);
    }
  }

  toggle(id) {
    const app = this.apps.get(id);
    if (this.isLockedNow(app)) return false;
    if (this.activeAppId === id) { this.close(); return false; }
    return this.open(id);
  }

  /** Ranks apps so a modal-required app (game_over) preempts a regular auto-open
   *  (day_end). Stable for everything else. */
  _autoPriority(app, idx) {
    return (app.isModal ? 1000 : 0) + idx;
  }

  /** Per-frame: drives auto-open and per-app update(). */
  update(sim) {
    this._sim = sim;
    // 1. Auto-open: pick highest-priority app whose autoOpenWhen(sim) is true.
    let candidate = null, bestPri = -1;
    for (let i = 0; i < this.appOrder.length; i++) {
      const app = this.appOrder[i];
      if (typeof app.autoOpenWhen === 'function' && app.autoOpenWhen(sim)) {
        const pri = this._autoPriority(app, i);
        if (pri > bestPri) { candidate = app; bestPri = pri; }
      }
    }
    if (candidate && this.activeAppId !== candidate.id) {
      // Don't kick out an already-open higher-priority app.
      const cur = this.activeAppId ? this.apps.get(this.activeAppId) : null;
      const curPri = cur
        ? this._autoPriority(cur, this.appOrder.indexOf(cur))
        : -1;
      if (bestPri >= curPri) this.open(candidate.id, true);
    } else if (!candidate && this._activeAuto && this.activeAppId) {
      // Active app was auto-opened and its condition no longer holds (e.g.
      // events resolved, day started). Close it so the player isn't left
      // staring at a stale panel.
      const cur = this.apps.get(this.activeAppId);
      const stillWants = cur && typeof cur.autoOpenWhen === 'function' && cur.autoOpenWhen(sim);
      if (!stillWants) this.close();
    }

    // 2. Per-frame redraw on every app (open or not — closed apps no-op cheaply).
    for (const app of this.appOrder) {
      if (typeof app.update === 'function') app.update(sim);
    }
    // 3. Widget update is implicit — they read sim each render.
  }

  /** Returns true if (px,py) is inside the top bar or the active app's panel.
   *  GameScene calls this once per pointer event before doing grid logic. */
  consumesPointer(p) {
    const px = p && (p.x != null ? p.x : p[0]);
    const py = p && (p.y != null ? p.y : p[1]);
    if (this.topBarRect) {
      const r = this.topBarRect;
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return true;
    }
    if (this.activeAppId) {
      const app = this.apps.get(this.activeAppId);
      if (app && app.hasPanel && app.containsPoint && app.containsPoint(px, py)) return true;
      // Modal apps consume the entire pointer space (backdrop blocks game).
      if (app && app.hasPanel && app.isModal) return true;
    }
    return false;
  }

  /** Centralised keyboard handling. Returns true if the key was consumed. */
  onKey(key) {
    if (key === 'Escape' || key === 'Esc') {
      if (this.activeAppId) {
        const app = this.apps.get(this.activeAppId);
        if (app && !(app.isModal)) { this.close(); return true; }
      }
      return false;
    }
    return false;
  }

  /** Forward a wheel scroll to the active panel app (if it implements
   *  onWheel). Returns true if consumed. */
  forwardWheel(p, dy) {
    if (!this.activeAppId) return false;
    const app = this.apps.get(this.activeAppId);
    if (!app || typeof app.onWheel !== 'function') return false;
    app.onWheel(p, dy);
    return true;
  }

  /** Forward map-area click to the active map-tool app, if any.
   *  Returns true if it was handled. */
  forwardMapClick(sim, tile, button) {
    if (!this.activeMapToolId) return false;
    const app = this.apps.get(this.activeMapToolId);
    if (!app || app.hasPanel) return false;
    app.onMapClick(sim, tile, button);
    return true;
  }
  forwardMapHover(sim, tile) {
    if (!this.activeMapToolId) return;
    const app = this.apps.get(this.activeMapToolId);
    if (!app || app.hasPanel) return;
    app.onMapHover(sim, tile);
  }

  /** Plain-JSON snapshot of the entire UI tree, for structural tests. */
  describe(sim) {
    return {
      activeAppId: this.activeAppId,
      activeMapToolId: this.activeMapToolId,
      apps: this.appOrder.map(a => a.describe(sim)),
      buildItems: this.buildItems.map(i => ({
        id: i.id, label: i.label, cost: i.cost, icon: i.icon, category: i.category,
      })),
      widgets: this.widgets.map(w =>
        typeof w.describe === 'function' ? w.describe(sim) : { id: w.id }
      ),
    };
  }

  /** Persist UI state — plain data only. Per-app state is opt-in. */
  serialize() {
    const perAppState = {};
    for (const app of this.appOrder) {
      const s = (typeof app.serialize === 'function') ? app.serialize() : null;
      if (s !== null && s !== undefined) perAppState[app.id] = s;
    }
    return {
      activeAppId: this.activeAppId,
      activeMapToolId: this.activeMapToolId,
      perAppState,
    };
  }

  deserialize(st) {
    if (!st) return;
    if (st.perAppState) {
      for (const [id, val] of Object.entries(st.perAppState)) {
        const app = this.apps.get(id);
        if (app && typeof app.deserialize === 'function') app.deserialize(val);
      }
    }
    if (this.activeAppId) this.close();
    if (st.activeAppId) this.open(st.activeAppId);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AppManager };
}
