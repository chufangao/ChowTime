/* ============================================================================
 * scene.js — Phaser scene + AppManager wiring
 * ============================================================================
 * The old Sidebar / RecruitModal / DayEndModal / GameOverModal classes were
 * replaced by the modular App/AppManager system under src/ui/. This file is
 * now a thin orchestrator:
 *
 *   - GameScene boots the simulation
 *   - Builds an AppManager, registers default build items, apps, widgets
 *   - Wires the TopBar
 *   - Forwards pointer events through manager.consumesPointer()
 *   - Routes left-clicks on the grid through manager.forwardMapClick()
 *     when a map-tool app (Move / Sell) is active, OR through the active
 *     BuildApp's onMapClick when a placement is in progress
 *
 * Adding a new app: add the file under src/ui/apps/, register it in
 * _registerUI(), done. No code in this file knows the app's specifics.
 * ========================================================================== */

// Cheap hash of every floor/gap/door tile + spawnTiles array. Changes when a
// reroll, save-load, or Floor/Sell action mutates the static floor layer.
// Walls are NOT included — those render in the per-frame y-sort pass.
function _floorSignature(sim) {
  let h = 0;
  for (let y = 0; y < sim.grid.rows; y++) {
    for (let x = 0; x < sim.grid.cols; x++) {
      const t = sim.grid.tiles[y][x];
      const code = t.type === 'gap' ? 2 : (t.type === 'spawn' ? 3 : 1);
      h = (h * 31 + code) | 0;
    }
  }
  return h;
}

class GameScene extends Phaser.Scene {
  constructor() {
    super('game');
  }

  create() {
    // --- Sim init: either fresh + demo seed, or restored from a save JSON ---
    // Boot-time opts are stashed on window by startChowTime so we don't
    // depend on Phaser passing per-instance data to the Scene constructor.
    const initOpts = (typeof window !== 'undefined' && window.__chowTimeInitOpts) || {};
    if (initOpts.saveJson && typeof deserializeSim === 'function') {
      const { sim, uiState } = deserializeSim(initOpts.saveJson);
      this.sim = sim;
      this._pendingUiState = uiState;
    } else {
      this.sim = new Simulation();
      this.sim.seedDemo();
    }
    // _uiSpeed is the player-facing speed multiplier; default 1×.
    if (this.sim._uiSpeed == null) this.sim._uiSpeed = 1;

    // --- Graphics layers, bottom to top ---
    this.gFloor   = this.add.graphics();
    this.gObjects = this.add.graphics();
    this.gGhost   = this.add.graphics();   // translucent move-tool preview
    this.gOverlay = this.add.graphics();
    // Ghost layer is drawn on top of objects but below overlay UI. Translucent
    // so the player sees what they're holding (and how a chair will orient).
    if (this.gGhost.setAlpha) this.gGhost.setAlpha(0.45);

    Sprites.floorAndDoor(this.gFloor, this.sim);
    // Track which layout the floor layer was painted for. The floor pass is
    // static (drawn once into gFloor), but reroll/load/placeFloor mutate the
    // floor/gap/door tiles — so we redraw whenever the layout id or any
    // floor-relevant tile differs from last paint.
    this._floorPaintedFor = this.sim.layoutId;
    this._floorPaintedSig = _floorSignature(this.sim);

    this._texts = new Map();
    this._frame = 0;

    this._view = {
      g:       this.gObjects,
      overlay: this.gOverlay,
      time:    0,
      grid:    this.sim.grid,
      getText: (k, s, x, y, st) => this._getText(k, s, x, y, st),
    };

    // The scene exposes its dimensions to apps via these properties so they
    // don't need to import sprites.js's GAME_W/H constants directly.
    this.gameWidth  = GAME_W;
    this.gameHeight = GAME_H;

    // --- App shell: registry + top bar ---
    this.appManager = new AppManager();
    this.appManager.attachScene(this);
    this._registerUI();

    // Apply any per-app state from a loaded save now that apps are registered.
    if (this._pendingUiState) {
      this.appManager.deserialize(this._pendingUiState);
      this._pendingUiState = null;
    }

    this.topBar = new TopBar(this, this.appManager, GAME_W, GAME_H);
    // Floor needs the top-bar strip painted on top of it so the floor
    // backdrop doesn't bleed through. The bar's own bg already does that —
    // but we must redraw the bar AFTER the floor each frame. TopBar uses
    // depth 950 which is already above gFloor (depth 0).

    // --- Hover state for placement / map-tool preview ---
    this.hover = null;

    // --- Save/load hooks: index.html wires these to a download / file input ---
    this.onSaveRequested = () => this._handleSave();
    this.onLoadRequested = () => this._handleLoad();

    // --- Input ---
    this.input.mouse.disableContextMenu();
    this.input.on('pointermove', p => this._onPointerMove(p));
    this.input.on('pointerdown', p => this._onPointerDown(p));
    this.input.on('wheel', (p, _go, _dx, dy) => this.appManager.forwardWheel(p, dy));
    this.input.keyboard.on('keydown', e => this._onKey(e));
  }

  _registerUI() {
    // Build items first (BuildApp reads from manager.buildItems on init).
    if (typeof registerDefaultBuildItems === 'function') {
      registerDefaultBuildItems(this.appManager);
    }
    // Apps in launch-bar order.
    this.appManager.register(new BuildApp());
    this.appManager.register(new HireApp());
    this.appManager.register(new SettingsApp());
    // Map tools (right side of bar).
    this.appManager.register(new MoveApp());
    this.appManager.register(new SellApp());
    this.appManager.register(new RepairApp());
    this.appManager.register(new RotateApp());
    // Between-day surfaces. DayEndApp renders the wrap-up / event resolution
    // (auto-opens at dayEnd). StartDayApp is a separate panel just for the
    // Start Day / Begin Run button — keeps it from being clicked by accident
    // while resolving the event.
    this.appManager.register(new DayEndApp());
    this.appManager.register(new StartDayApp());
    this.appManager.register(new MiddayEventApp());
    this.appManager.register(new GameOverApp());

    // Status widgets.
    this.appManager.registerWidget(Widgets.money());
    this.appManager.registerWidget(Widgets.reputation());
    this.appManager.registerWidget(Widgets.day());
    this.appManager.registerWidget(Widgets.stats());
  }

  /* ---- Per-frame update ---- */
  update(_, dtMs) {
    const dt = Math.min(dtMs / 1000, 0.1) * (this.sim._uiSpeed || 1);
    this.sim.update(dt);
    this._frame++;

    // Layout edits during a shift: clear active map-tool / build placement so
    // stale highlights don't linger when the day starts. Also close any
    // locked panel app (Build/Hire) the player left open across Start Day.
    if (this.sim.isDayActive && this.sim.isDayActive() && !this.sim.debug) {
      const active = this.appManager.activeAppId
        ? this.appManager.get(this.appManager.activeAppId)
        : null;
      if (active && active.lockedDuringService) this.appManager.close();
      const build = this.appManager.get('build');
      if (build && build.activeItem) build.activeItem = null;
    }

    this._view.time = this.sim.time;

    // Repaint the static floor layer if the layout changed (reroll / load) or
    // any floor/gap/door tile mutated (Floor build, Sell tool, etc.).
    const sig = _floorSignature(this.sim);
    if (this._floorPaintedFor !== this.sim.layoutId || this._floorPaintedSig !== sig) {
      this.gFloor.clear();
      Sprites.floorAndDoor(this.gFloor, this.sim);
      this._floorPaintedFor = this.sim.layoutId;
      this._floorPaintedSig = sig;
    }

    this._drawScene();
    this.appManager.update(this.sim);
    this.topBar.refresh(this.sim);
    this._cullTexts();
  }

  /* ---- Input routing ---- */
  _onPointerMove(p) {
    if (this.appManager.consumesPointer(p)) { this.hover = null; return; }
    const tile = screenToTile(p.x, p.y);
    if (!tile) { this.hover = null; return; }
    this.hover = { x: tile.x, y: tile.y, valid: this._previewValidAt(tile.x, tile.y) };
  }

  _onPointerDown(p) {
    if (this.appManager.consumesPointer(p)) return;
    // Click landed outside the active app's panel: standard mobile pattern
    // is to dismiss the (non-modal) panel and let the click also act on the
    // surface beneath. We close + return so the same click doesn't double up.
    if (this.appManager.activeAppId) {
      const app = this.appManager.get(this.appManager.activeAppId);
      if (app && app.hasPanel && !app.isModal) { this.appManager.close(); return; }
    }
    const tile = screenToTile(p.x, p.y); if (!tile) return;

    const editingAllowed = !this.sim.isDayActive() || this.sim.debug;

    // Right-click: cancel pending placement / move pickup. No longer a Sell
    // shortcut — selling is reserved for the dedicated Sell toolbar tool so
    // a stray right-click can't accidentally refund a building.
    if (p.rightButtonDown && p.rightButtonDown()) {
      const move = this.appManager.get('move');
      if (move && move.movingFrom) { move.cancelPickup(); return; }
      const build = this.appManager.get('build');
      if (build && build.activeItem) { build.activeItem = null; return; }
      return;
    }

    if (!editingAllowed) return;

    // Active map-tool app handles the click first (Move, Sell).
    if (this.appManager.forwardMapClick(this.sim, tile, 0)) return;
    // Otherwise, if Build's placement cursor is armed, place via the build item.
    const build = this.appManager.get('build');
    if (build && build.activeItem) {
      build.onMapClick(this.sim, tile, 0);
    }
  }

  _onKey(e) {
    if (this.appManager.onKey(e.key)) return;
  }

  _previewValidAt(x, y) {
    const move  = this.appManager.get('move');
    const sell  = this.appManager.get('sell');
    const build = this.appManager.get('build');
    if (this.appManager.activeMapToolId === 'move' && move) return move.isValidAt(this.sim, x, y);
    if (this.appManager.activeMapToolId === 'sell' && sell) return sell.isValidAt(this.sim, x, y);
    if (build && build.activeItem) return build.isValidAt(this.sim, x, y);
    return false;
  }

  /* ---- Save / load ---- */
  _handleSave() {
    if (typeof serializeSim !== 'function') return;
    const ui = this.appManager.serialize();
    const json = serializeSim(this.sim, ui);
    const blob = JSON.stringify(json, null, 2);
    if (typeof window === 'undefined') return;
    const fileBlob = new Blob([blob], { type: 'application/json' });
    const url = URL.createObjectURL(fileBlob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url; a.download = `chowtime-day${this.sim.day}-${stamp}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  _handleLoad() {
    if (typeof window === 'undefined') return;
    // Trigger the hidden file input from index.html.
    const input = document.getElementById('load-save-input');
    if (input) input.click();
  }

  /* ---- Main draw pass: y-sort everything, delegate to SPRITES ---- */
  _drawScene() {
    this.gObjects.clear();
    this.gOverlay.clear();
    const view = this._view;

    const items = [];
    for (const b of this.sim.buildings) {
      const { sx, sy } = gridToScreen(b.x, b.y);
      items.push({ sortY: sy - 0.1, kind: 'b', ref: b, sx, sy });
    }
    // Walls participate in the y-sort so they occlude entities behind them
    // and get hidden by entities in front. They live as tile state, not
    // building instances, so we scan the grid each frame.
    for (let gy = 0; gy < this.sim.grid.rows; gy++) {
      for (let gx = 0; gx < this.sim.grid.cols; gx++) {
        const t = this.sim.grid.tiles[gy][gx];
        if (!t || t.type !== 'wall') continue;
        const { sx, sy } = gridToScreen(gx, gy);
        items.push({ sortY: sy - 0.05, kind: 'w', wallKind: t.wallKind || 'player', sx, sy });
      }
    }
    for (const c of this.sim.customers) {
      const { sx, sy } = gridToScreen(c.x, c.y);
      items.push({ sortY: sy, kind: 'c', ref: c, sx, sy });
    }
    for (const e of this.sim.employees) {
      const { sx, sy } = gridToScreen(e.x, e.y);
      items.push({ sortY: sy, kind: 'e', ref: e, sx, sy });
    }
    items.sort((a, b) => a.sortY - b.sortY);

    for (const it of items) {
      if (it.kind === 'b') {
        const b = it.ref;
        const age = this.sim.time - b.placedAt;
        const bounce = age < 0.25 ? -Math.sin((age / 0.25) * Math.PI) * 4 : 0;
        const sy = it.sy + bounce;
        if      (b.type === 'stove')          Sprites.stove(view, b, it.sx, sy);
        else if (b.type === 'catapult_stove') Sprites.catapult_stove(view, b, it.sx, sy);
        else if (b.type === 'table')          Sprites.table(view, b, it.sx, sy);
        else if (b.type === 'chair')          Sprites.chair(view, b, it.sx, sy);
        else if (b.type === 'sink')           Sprites.sink(view, b, it.sx, sy);
      } else if (it.kind === 'w') {
        Sprites.wall(view, null, null, it.wallKind, it.sx, it.sy);
      } else if (it.kind === 'c') {
        Sprites.customer(view, it.ref, it.sx, it.sy);
        Sprites.tipFloater(view, it.ref, it.sx, it.sy);
      } else {
        Sprites.employee(view, it.ref, it.sx, it.sy);
      }
    }

    Sprites.projectiles(view, this.sim);

    // Pickup marker for Move tool.
    const move = this.appManager.get('move');
    if (move && move.movingFrom) {
      const { sx, sy } = gridToScreen(move.movingFrom.x, move.movingFrom.y);
      Sprites.pickupMarker(view, sx, sy);
    }

    this.gGhost.clear();
    const noOp = () => {};
    const ghostView = {
      g: this.gGhost, overlay: this.gGhost,
      time: this.sim.time, grid: this.sim.grid,
      getText: noOp,
    };

    // Move-ghost: a translucent copy of the picked-up building at the cursor
    // so chairs/tables/etc. read as themselves (not as a generic blob).
    const moveGhostShown = move && move.movingFrom && move.movingFrom.kind === 'building'
      && this.hover && this.hover.valid;
    if (moveGhostShown) {
      const src = this.sim.grid.getTile(move.movingFrom.x, move.movingFrom.y);
      const b = src && src.building;
      if (b) {
        const { sx, sy } = gridToScreen(this.hover.x, this.hover.y);
        // Chair-only: orient toward whichever adjacent table sits at the
        // HOVER position so the player sees which table it'll snap to.
        let chairFacing = (b.facing != null) ? b.facing : null;
        if (b.type === 'chair' && chairFacing == null) {
          chairFacing = this._findAdjacentTableFacing(this.hover.x, this.hover.y);
        }
        this._drawBuildingSprite(ghostView, b, sx, sy, { facing: chairFacing });
      }
    }

    // Build-ghost: same idea, but for the BuildApp's selected item. Shows
    // the actual sprite at the hover position plus a thick green frame so
    // the player knows they're in placement mode. Skips for items that
    // aren't Building instances (floor / player wall — still drawn as a
    // plain hover diamond below).
    const build = this.appManager.get('build');
    const buildItem = build && build.activeItem;
    const buildIsBuilding = buildItem && this._isBuildingItem(buildItem.id);
    const buildGhostShown = buildIsBuilding && this.hover;
    if (buildGhostShown) {
      const previewB = this._buildPreviewBuilding(buildItem.id);
      if (previewB) {
        const { sx, sy } = gridToScreen(this.hover.x, this.hover.y);
        // Reset transient sprite state so a previously-cached preview doesn't
        // flash a half-cooked dish on a freshly placed stove.
        previewB.cooking = null;
        previewB.washing = null;
        previewB.plate   = null;
        previewB.broken  = false;
        let chairFacing = null;
        if (buildItem.id === 'chair') {
          chairFacing = this._findAdjacentTableFacing(this.hover.x, this.hover.y);
        }
        this._drawBuildingSprite(ghostView, previewB, sx, sy, { facing: chairFacing });
        Sprites.buildFrame(view, sx, sy, this.hover.valid);
      }
    }

    // Plain hover diamond — used when no ghost is shown (map tools other than
    // move, or build placing a non-building item like floor / player wall).
    const showHover = this.hover && (
      this.appManager.activeMapToolId ||
      (this.appManager.get('build') && this.appManager.get('build').activeItem)
    ) && !moveGhostShown && !buildGhostShown;
    if (showHover) {
      const { sx, sy } = gridToScreen(this.hover.x, this.hover.y);
      Sprites.hoverDiamond(view, sx, sy, this.hover.valid);
    }

    Sprites.popups(view, this.sim);

    const doors = this.sim.spawnTiles || [this.sim.spawnTile];
    doors.forEach((sp, i) => {
      if (!sp) return;
      const { sx, sy } = gridToScreen(sp.x, sp.y);
      this._getText(`door:${i}`, 'DOOR', sx, sy, {
        fontFamily: 'system-ui', fontSize: '10px', fontStyle: 'bold', color: '#1a3a0a',
      });
    });
  }

  /* ---- Ghost-preview helpers ---- */
  /** Whether a BuildApp item id maps to a Building instance (i.e. it has a
   *  sprite function we can call). Floor / player_wall items don't. */
  _isBuildingItem(id) {
    return id === 'stove' || id === 'catapult_stove'
        || id === 'table' || id === 'chair' || id === 'sink';
  }

  /** Cached, never-placed Building instance for build-mode ghost rendering.
   *  Cached so we don't allocate (and burn _bid) every frame. */
  _buildPreviewBuilding(itemId) {
    if (!this._buildPreviews) this._buildPreviews = {};
    if (this._buildPreviews[itemId]) return this._buildPreviews[itemId];
    let b = null;
    if      (itemId === 'stove')          b = new Stove();
    else if (itemId === 'catapult_stove') b = new CatapultStove();
    else if (itemId === 'table')          b = new Table();
    else if (itemId === 'chair')          b = new Chair();
    else if (itemId === 'sink')           b = new Sink();
    if (b) {
      b._isPreview = true;
      this._buildPreviews[itemId] = b;
    }
    return b;
  }

  /** Look for a table neighbour at (x, y) and return the facing index that
   *  points toward it (0=N, 1=E, 2=S, 3=W). Null when there's no adjacent
   *  table — caller decides the fallback. */
  _findAdjacentTableFacing(x, y) {
    const offs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let i = 0; i < 4; i++) {
      const [dx, dy] = offs[i];
      const t = this.sim.grid.getTile(x + dx, y + dy);
      if (t && t.building && t.building.type === 'table') return i;
    }
    return null;
  }

  /** Dispatch a Sprites.* call for the given building type. Mirrors the
   *  switch inside _drawScene's y-sort pass but takes an explicit view +
   *  position so ghost rendering can reuse it. */
  _drawBuildingSprite(view, b, sx, sy, opts) {
    if      (b.type === 'stove')          Sprites.stove(view, b, sx, sy);
    else if (b.type === 'catapult_stove') Sprites.catapult_stove(view, b, sx, sy);
    else if (b.type === 'table')          Sprites.table(view, b, sx, sy);
    else if (b.type === 'chair')          Sprites.chair(view, b, sx, sy, opts);
    else if (b.type === 'sink')           Sprites.sink(view, b, sx, sy);
  }

  /* ---- Pooled text (used by Sprites.* helpers) ---- */
  _getText(key, str, x, y, style) {
    let t = this._texts.get(key);
    if (!t) {
      t = this.add.text(x, y, str, style);
      t.setOrigin(0.5, 0.5);
      this._texts.set(key, t);
    }
    t.setText(str);
    t.setPosition(x, y);
    if (style && style.color) t.setColor(style.color);
    t._seenFrame = this._frame;
    t.setVisible(true);
    return t;
  }
  _cullTexts() {
    for (const [k, t] of this._texts) {
      if (t._seenFrame === this._frame) continue;
      t.setVisible(false);
      if (this._frame - (t._seenFrame || 0) > 120) {
        t.destroy();
        this._texts.delete(k);
      }
    }
  }
}

/* ============================================================================
 * Bootstrap — exposed as window.startChowTime() so the HTML start menu can
 * decide when to launch the game. Accepts optional { saveJson } to load
 * a serialized run.
 * ============================================================================ */
window.startChowTime = function (opts) {
  if (window.__chowTimeInstance) return window.__chowTimeInstance;
  // Stash opts on window — GameScene.create reads them. This avoids the
  // gotcha of trying to pass per-instance data through the Phaser.Scene ctor.
  window.__chowTimeInitOpts = opts || {};
  window.__chowTimeInstance = new Phaser.Game({
    type: Phaser.AUTO,
    width: GAME_W,
    height: GAME_H,
    backgroundColor: '#1a1428',
    parent: 'game',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: GameScene,
    render: { pixelArt: false, antialias: true },
  });
  return window.__chowTimeInstance;
};
