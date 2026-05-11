/* ============================================================================
 * scene.js — Phaser scene + AppManager wiring
 * ============================================================================
 * GameScene is a thin orchestrator. World rendering now lives in
 * src/view/floor_renderer.js (per-tile floor Sprites) and
 * src/view/world_renderer.js (per-entity Sprites/Graphics on a y-sorted
 * Layer); this file is responsible for:
 *
 *   - Booting the simulation (fresh or from a save)
 *   - Calling FloorRenderer/WorldRenderer.update each frame
 *   - Building an AppManager, registering build items / apps / widgets
 *   - Wiring the TopBar and forwarding pointer events through it
 *   - Ghost preview rendering (build / move placement) into gGhost
 *   - Save/load file I/O
 *
 * Adding a new app: add the file under src/ui/apps/, register it in
 * _registerUI(), done. No code in this file knows the app's specifics.
 * ========================================================================== */

// Static backdrop behind the iso grid: header strip, footer strip, and the
// dark fill behind the diamond region. Drawn once into gFloor on create() —
// none of these pixels ever change at runtime, so a per-frame redraw or a
// signature compare would be pure waste. The per-tile floor diamonds + door
// overlays live on FloorRenderer's Layer instead.
function _drawFloorBackdrop(g) {
  g.fillStyle(0x1a1428, 1);
  g.fillRect(0, 0, GAME_W, TOP_BAR_H);
  g.fillRect(0, GAME_H - BOT_H, GAME_W, BOT_H);
  g.fillStyle(0x231a30, 1);
  g.fillRect(0, TOP_BAR_H, GAME_W, GAME_H - TOP_BAR_H - BOT_H);
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

    // --- Graphics layers, bottom to top, with explicit depths so the
    // WorldRenderer's display Layer (depth 100) sits between the static
    // floor and the per-frame transient overlays. ---
    this.gFloor   = this.add.graphics();   // depth 0  : floor + door tiles
    this.gObjects = this.add.graphics();   // depth 200: projectiles, pickup marker
    this.gGhost   = this.add.graphics();   // depth 250: translucent move-tool preview
    this.gOverlay = this.add.graphics();   // depth 300: hover diamond, build frame
    if (this.gFloor.setDepth)   this.gFloor.setDepth(0);
    if (this.gObjects.setDepth) this.gObjects.setDepth(200);
    if (this.gGhost.setDepth)   this.gGhost.setDepth(250);
    if (this.gOverlay.setDepth) this.gOverlay.setDepth(300);
    if (this.gGhost.setAlpha)   this.gGhost.setAlpha(0.45);

    // Static backdrop: header/footer strips + dark rect behind the iso grid.
    // The per-tile floor diamonds now come from FloorRenderer (Sprites on a
    // Layer), so gFloor only handles the fixed background that never changes
    // between frames or between layouts.
    _drawFloorBackdrop(this.gFloor);

    // World renderer owns one GameObject per building/wall/entity on a
    // y-sorted Layer (depth 100). Replaces the old per-frame manual y-sort
    // loop. Attach now so create()'s order matches GameScene shutdown.
    if (typeof WorldRenderer !== 'undefined') WorldRenderer.attach(this);

    // Floor renderer: one Sprite per tile on a Layer (depth 10), above the
    // backdrop, below the world. Replaces the old full-redraw-on-change
    // floor pass. Track the floor signature so we only reconcile tiles when
    // a Reroll / Floor build / Sell / save-load actually mutates the layout.
    if (typeof FloorRenderer !== 'undefined') FloorRenderer.attach(this, this.sim);
    this._floorPaintedFor = this.sim.layoutId;
    this._floorPaintedVer = this.sim.grid.floorVersion;

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
    // TopBar uses depth 950+ which sits above every world layer below
    // (gFloor 0, FloorRenderer 10, WorldRenderer 100, gObjects 200,
    // gGhost 250, gOverlay 300, pooled text 310).

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

    // Pixel-perfect canvas: the backing-store is sized at viewport CSS × DPR
    // (clamped to MAX_BACKING) in startChowTime. Here we scale the world to
    // fill it. With cam zoom = camZoom and centerOn(GAME_W/2, GAME_H/2),
    // world (0,0) → canvas (0,0) and world (GAME_W, GAME_H) → canvas
    // (backW, backH) — pointer worldX/Y stays in logical coords for the rest
    // of the game.
    const size = (typeof window !== 'undefined' && window.__chowTimeSize) || null;
    const camZoom = (size && size.camZoom) || 1;
    this.cameras.main.setZoom(camZoom);
    this.cameras.main.centerOn(GAME_W / 2, GAME_H / 2);

    // Text resolution: glyph atlas is rasterised at fontSize × resolution.
    // The atlas then renders at fontSize in world coords, which the camera
    // magnifies by camZoom on its way to the canvas. So to land 1 atlas
    // pixel on 1 canvas pixel we need resolution ≥ camZoom. (Sprites avoid
    // this via TextureBaker's 2× bake; text does not, which is why the
    // figures looked sharp while glyphs were still blurry.) Cap at 4 for
    // texture memory.
    this._textResolution = Math.max(1, Math.min(4, Math.ceil(camZoom)));

    // Launch the parallel HUD scene. It's empty today (see src/scenes/ui_scene.js)
    // but starting it now means future phases can move TopBar/widgets there
    // without touching the Phaser.Game config.
    if (!this.scene.isActive('ui')) this.scene.launch('ui');

    // Expose camera handles on window for ad-hoc zoom/pan. The viewport is
    // currently a fixed GAME_W × GAME_H but Phaser's camera already supports
    // setZoom/scrollX/Y — wiring it now means future "big map" features
    // (Phase 7 in the migration plan) cost no additional scene plumbing.
    if (typeof window !== 'undefined') {
      window.gameZoom = (z) => { this.cameras.main.setZoom(z); };
      window.gamePan  = (x, y) => { this.cameras.main.setScroll(x | 0, y | 0); };
    }
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

    // Floor tile sprites: reconcile only when the layout changed (reroll /
    // load) or a Floor/Sell mutated a tile type. Grid.setType bumps
    // floorVersion on any type change, so comparing the counter is O(1).
    const ver = this.sim.grid.floorVersion;
    if (this._floorPaintedFor !== this.sim.layoutId || this._floorPaintedVer !== ver) {
      const layoutChanged = this._floorPaintedFor !== this.sim.layoutId;
      if (typeof FloorRenderer !== 'undefined') FloorRenderer.update(this.sim, layoutChanged);
      this._floorPaintedFor = this.sim.layoutId;
      this._floorPaintedVer = ver;
    }

    this._drawScene();
    this.appManager.update(this.sim);
    this.topBar.refresh(this.sim);
    this._cullTexts();
  }

  /* ---- Input routing ----
   * Pointer coords: with the pixel-perfect canvas, the world is rendered via
   * camera zoom, so p.x/p.y are screen-space (canvas pixels). All hit-tests
   * here (screenToTile, panel rects, top bar rect) are in logical world
   * coords, so we route everything through p.worldX/p.worldY which Phaser
   * pre-inverts through the camera matrix. */
  _onPointerMove(p) {
    if (this.appManager.consumesPointer(p)) { this.hover = null; return; }
    const tile = screenToTile(p.worldX, p.worldY);
    if (!tile) { this.hover = null; return; }
    this.hover = { x: tile.x, y: tile.y, valid: this._previewValidAt(tile.x, tile.y) };
  }

  _onPointerDown(p) {
    if (this.appManager.consumesPointer(p)) {
      // Zone consumed this event — clear the flag so the NEXT pointerdown
      // starts fresh. (consumesPointer also returns true based on rect
      // hit-tests, so this clear is harmless when no Zone fired.)
      this.appManager._zoneClickInFlight = false;
      return;
    }
    this.appManager._zoneClickInFlight = false;
    // Click landed outside the active app's panel: standard mobile pattern
    // is to dismiss the (non-modal) panel and let the click also act on the
    // surface beneath. We close + return so the same click doesn't double up.
    if (this.appManager.activeAppId) {
      const app = this.appManager.get(this.appManager.activeAppId);
      if (app && app.hasPanel && !app.isModal) { this.appManager.close(); return; }
    }
    const tile = screenToTile(p.worldX, p.worldY); if (!tile) return;

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

  /* ---- Main draw pass: world via WorldRenderer + transient overlays ---- */
  _drawScene() {
    this.gObjects.clear();
    this.gOverlay.clear();
    const view = this._view;

    // World objects (buildings, walls, customers, employees) live on a
    // y-sorted Layer managed by WorldRenderer. Each frame it reconciles
    // sim state against per-entity GameObjects and re-sorts by .y.
    if (typeof WorldRenderer !== 'undefined') WorldRenderer.update(this.sim, view);

    // Tip floaters above leaving customers — pure pooled-text, doesn't go
    // through the y-sort. Drawn after the world so it always reads on top.
    for (const c of this.sim.customers) {
      const { sx, sy } = gridToScreen(c.x, c.y);
      Sprites.tipFloater(view, c, sx, sy);
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
      // Texts (door labels, popups, tip floaters, broken ⚠) render above the
      // world Layer (depth 100) and the transient overlays (200-300).
      if (t.setDepth) t.setDepth(310);
      // Match the camera zoom so glyphs rasterise at canvas-pixel resolution
      // rather than logical size (which the camera then upscales = blur).
      const res = this._textResolution;
      if (res && res > 1 && t.setResolution) t.setResolution(res);
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
// Pixel-perfect canvas sizing: the game runs in a fixed GAME_W × GAME_H
// logical-coord space, but we render into a backing-store that matches the
// display's physical pixels (CSS px × devicePixelRatio). The camera zoom
// scales the logical world up to fill the larger canvas. Without this, the
// canvas (sized at GAME_W = 1080) is CSS-stretched by FIT mode and again by
// DPR, blurring everything by ~3.5×.
//
// MAX_BACKING caps the canvas backing-store so we don't exceed WebGL texture
// limits on big displays (typical limit 8192–16384; 4096 is conservative).
const MAX_BACKING = 4096;
function _computeCanvasSize() {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const parent = (typeof document !== 'undefined') && document.getElementById('game-container');
  // Fall back to window dims pre-#app reveal (CSS keeps #app display:none
  // until Play is clicked; the parent has 0 size then). After reveal, prefer
  // the actual container so we letterbox into available area.
  const pw = (parent && parent.clientWidth)  || (typeof window !== 'undefined' ? window.innerWidth  : GAME_W);
  const ph = (parent && parent.clientHeight) || (typeof window !== 'undefined' ? window.innerHeight : GAME_H);
  const fitS = Math.min(pw / GAME_W, ph / GAME_H);
  const cssW = Math.max(1, Math.round(GAME_W * fitS));
  const cssH = Math.max(1, Math.round(GAME_H * fitS));
  // Clamp backing-store to MAX_BACKING on whichever axis is longer.
  const backScale = Math.min(dpr, MAX_BACKING / Math.max(cssW, cssH));
  const backW = Math.max(1, Math.round(cssW * backScale));
  const backH = Math.max(1, Math.round(cssH * backScale));
  const camZoom = backW / GAME_W; // == backH / GAME_H (within rounding)
  return { dpr, cssW, cssH, backW, backH, camZoom };
}

window.startChowTime = function (opts) {
  if (window.__chowTimeInstance) return window.__chowTimeInstance;
  // Stash opts on window — GameScene.create reads them. This avoids the
  // gotcha of trying to pass per-instance data through the Phaser.Scene ctor.
  window.__chowTimeInitOpts = opts || {};
  const size = _computeCanvasSize();
  window.__chowTimeSize = size;
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: size.backW,
    height: size.backH,
    backgroundColor: '#1a1428',
    parent: 'game',
    // NONE mode: we manage canvas CSS size and backing-store directly.
    // FIT mode CSS-stretches the canvas and blurs text — see the
    // _computeCanvasSize comment above.
    scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.NO_CENTER },
    // Scene order: Boot → Preload → Game (auto-started by Preload). UIScene
    // is registered but not auto-started; GameScene.create() launches it in
    // parallel so it overlays the world. Only BootScene has autoStart=true
    // via being first in this array.
    scene: [BootScene, PreloadScene, GameScene, UIScene],
    render: { pixelArt: false, antialias: true, roundPixels: false },
  });
  window.__chowTimeInstance = game;
  // Set CSS size after Phaser's own style setup so we win the cascade. The
  // canvas backing-store stays at backW × backH (physical pixels); CSS sizes
  // it down to cssW × cssH so the browser maps 1 backing pixel → 1 physical
  // pixel on the display.
  const _applyCanvasCss = () => {
    if (game.canvas) {
      game.canvas.style.width  = size.cssW + 'px';
      game.canvas.style.height = size.cssH + 'px';
    }
  };
  if (game.canvas) _applyCanvasCss();
  else game.events.once('ready', _applyCanvasCss);

  // Debounced resize: recompute sizing math from the container and re-apply
  // to canvas + all active cameras. The single biggest regression risk —
  // wire it once, here, so every scene shares the same path.
  let resizeTimer = null;
  const _onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const next = _computeCanvasSize();
      window.__chowTimeSize = next;
      if (game.scale && game.scale.resize) game.scale.resize(next.backW, next.backH);
      if (game.canvas) {
        game.canvas.style.width  = next.cssW + 'px';
        game.canvas.style.height = next.cssH + 'px';
      }
      // Re-apply zoom + center on every active scene's main camera.
      const scenes = (game.scene && game.scene.scenes) || [];
      for (const s of scenes) {
        if (!s || !s.cameras || !s.cameras.main) continue;
        if (s.sys && s.sys.settings && s.sys.settings.active === false) continue;
        s.cameras.main.setZoom(next.camZoom);
        s.cameras.main.centerOn(GAME_W / 2, GAME_H / 2);
      }
    }, 150);
  };
  if (typeof window !== 'undefined') window.addEventListener('resize', _onResize);
  return game;
};
