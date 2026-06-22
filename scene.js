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
  // Fill the entire (enlarged) world rect with the dark floor backdrop so the
  // movable camera never reveals a hard edge as it pans/zooms across the
  // expansion area. The TopBar (on the fixed UI camera) paints its own opaque
  // strip over the top, so we no longer need the separate header band here.
  g.fillStyle(0x231a30, 1);
  g.fillRect(0, 0, GRID_PX_W, GRID_PX_H);
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
    // Wheel: an open panel's scroll wins; otherwise zoom the world toward the
    // cursor. forwardWheel gets the UI-cam world point so panel hit-tests match.
    this.input.on('wheel', (p, _go, _dx, dy) => {
      const up = this._uiPoint(p);
      if (this.appManager.forwardWheel({ worldX: up.x, worldY: up.y, x: p.x, y: p.y }, dy)) return;
      this._zoomAtPointer(p, dy);
    });
    this.input.keyboard.on('keydown', e => this._onKey(e));

    // Pixel-perfect canvas: the backing-store is sized at viewport CSS × DPR
    // (clamped to MAX_BACKING) in startChowTime. The fit-zoom (camZoom) scales
    // the GAME_W × GAME_H footprint view up to fill it.
    const size = (typeof window !== 'undefined' && window.__chowTimeSize) || null;
    const camZoom = (size && size.camZoom) || 1;
    this._setupCameras(camZoom);

    // Text resolution: glyph atlas is rasterised at fontSize × resolution, then
    // rendered at fontSize in world coords which the world camera magnifies by
    // up to fitZoom × MAX_ZOOM_MULT on its way to the canvas. Rasterise for that
    // max so pooled WORLD text stays crisp when the player zooms all the way in
    // (cheap, set once — no per-frame churn). Cap at 4 for texture memory. HUD
    // text rides the fixed UI camera, so it's already covered by the fit zoom.
    this._textResolution = Math.max(1, Math.min(4, Math.ceil(camZoom * MAX_ZOOM_MULT)));

    // WASD / arrow-key pan. The keydown→appManager.onKey path only consumes
    // Escape, so these don't conflict. Read each frame in update().
    if (this.input && this.input.keyboard && this.input.keyboard.addKeys) {
      this._panKeys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT');
    }

    // Launch the parallel HUD scene. It's empty today (see src/scenes/ui_scene.js)
    // but starting it now means future phases can move TopBar/widgets there
    // without touching the Phaser.Game config.
    if (!this.scene.isActive('ui')) this.scene.launch('ui');

    // Expose camera handles on window for ad-hoc zoom/pan / debugging.
    if (typeof window !== 'undefined') {
      window.gameZoom = (z) => { this.cameras.main.setZoom(z); };
      window.gamePan  = (x, y) => { this.cameras.main.setScroll(x | 0, y | 0); };
    }

    // Partition existing objects across the two cameras before the first render
    // so the HUD never flashes on the world camera (or vice-versa). update()
    // re-runs this each frame to catch lazily-created objects.
    this._partitionCameras();
  }

  /* ---- Cameras: movable world cam + fixed UI cam ----
   * cameras.main is the WORLD camera (wheel-zoom + WASD/arrow pan, clamped to
   * the full grid). this.uiCam reproduces today's fixed transform and carries
   * the HUD (TopBar + app panels), so panning/zooming the world leaves the HUD
   * put. Objects are split between the two via _partitionCameras() by depth:
   * world layers/graphics/text (depth < 500) render only on the world cam; HUD
   * (depth ≥ 900) renders only on the UI cam. */
  _setupCameras(fitZoom) {
    this._fitZoom = fitZoom || 1;
    this._userZoomMult = 1;
    const world = this.cameras && this.cameras.main;
    if (!world) return;
    world.setZoom(this._fitZoom);
    // Bounds = the full grid pixel extent; Phaser then clamps pan/zoom so the
    // camera can't fly off into empty space.
    if (world.setBounds) world.setBounds(0, 0, GRID_PX_W, GRID_PX_H);
    world.centerOn(RESTAURANT_VIEW_CX, RESTAURANT_VIEW_CY);

    // Fixed UI camera == today's single camera (zoom = fit, centered on the
    // GAME_W × GAME_H footprint view). The HUD is laid out in that logical
    // space, so its math is unchanged — we just feed it the UI-cam world point
    // for hit-tests.
    if (this.cameras.add) {
      this.uiCam = this.cameras.add(0, 0, world.width, world.height, false, 'ui');
      this.uiCam.setZoom(this._fitZoom);
      this.uiCam.centerOn(GAME_W / 2, GAME_H / 2);
    }
  }

  /** Zoom the world camera toward the cursor. Keeps the world point under the
   *  pointer fixed by adjusting scroll for the zoom delta. */
  _zoomAtPointer(p, dy) {
    const cam = this.cameras && this.cameras.main;
    if (!cam) return;
    const before = cam.getWorldPoint(p.x, p.y);
    const factor = dy > 0 ? 0.9 : 1.1;
    const mult = Math.max(1, Math.min(MAX_ZOOM_MULT, this._userZoomMult * factor));
    if (mult === this._userZoomMult) return;
    this._userZoomMult = mult;
    cam.setZoom(this._fitZoom * mult);
    const after = cam.getWorldPoint(p.x, p.y);
    cam.scrollX += before.x - after.x;
    cam.scrollY += before.y - after.y;
  }

  /** WASD / arrow-key pan, read each frame. Pan speed is constant in screen
   *  space (divided by zoom) so it feels the same at every zoom level. */
  _handleCameraPan(dtMs) {
    const cam = this.cameras && this.cameras.main;
    const k = this._panKeys;
    if (!cam || !k) return;
    const dt = Math.min(dtMs || 16, 100) / 1000;
    const speed = 700;   // logical px/sec at fit zoom
    let dx = 0, dy = 0;
    if ((k.A && k.A.isDown) || (k.LEFT && k.LEFT.isDown))  dx -= 1;
    if ((k.D && k.D.isDown) || (k.RIGHT && k.RIGHT.isDown)) dx += 1;
    if ((k.W && k.W.isDown) || (k.UP && k.UP.isDown))      dy -= 1;
    if ((k.S && k.S.isDown) || (k.DOWN && k.DOWN.isDown))  dy += 1;
    if (!dx && !dy) return;
    const step = speed * dt / (cam.zoom || 1);
    cam.scrollX += dx * step;
    cam.scrollY += dy * step;
  }

  /** Assign every not-yet-assigned top-level object to exactly one camera so
   *  the HUD stays on the UI cam and the world stays on the world cam. Depth is
   *  the discriminator: world objects are ≤ 310, HUD objects are ≥ 900. */
  _partitionCameras() {
    const world = this.cameras && this.cameras.main;
    const ui = this.uiCam;
    if (!world || !ui) return;
    const list = this.children && this.children.list;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const obj = list[i];
      if (!obj || obj.__camAssigned) continue;
      obj.__camAssigned = true;
      const d = obj.depth || 0;
      if (d >= 500) { if (world.ignore) world.ignore(obj); }   // HUD → UI cam only
      else          { if (ui.ignore)    ui.ignore(obj); }      // world → world cam only
    }
  }

  /** Re-apply camera framing after a viewport resize. Recomputes fit-zoom and
   *  keeps the user's zoom multiplier + current pan (bounds re-clamp the
   *  scroll); the UI cam re-centers on the footprint view. */
  onResize(size) {
    if (!size) return;
    this._fitZoom = size.camZoom || 1;
    const world = this.cameras && this.cameras.main;
    if (world) {
      if (world.setSize) world.setSize(size.backW, size.backH);
      world.setZoom(this._fitZoom * (this._userZoomMult || 1));
    }
    if (this.uiCam) {
      if (this.uiCam.setSize) this.uiCam.setSize(size.backW, size.backH);
      this.uiCam.setZoom(this._fitZoom);
      this.uiCam.centerOn(GAME_W / 2, GAME_H / 2);
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
    this.appManager.register(new AssignApp());
    // Place Room: hidden from the bar until a room grant is pending.
    if (typeof PlaceRoomApp === 'function') this.appManager.register(new PlaceRoomApp());
    // Hidden panel (no launcher) opened by the Assign tool to pick chefs.
    this.appManager.register(new AssignPickerApp());
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
    const perf = (typeof window !== 'undefined' && window.__chowPerf) ? window.performance : null;
    const t0 = perf ? perf.now() : 0;
    const dt = Math.min(dtMs / 1000, 0.1) * (this.sim._uiSpeed || 1);
    this.sim.update(dt);
    const tSim = perf ? perf.now() : 0;
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

    this._handleCameraPan(dtMs);

    this._drawScene();
    this.appManager.update(this.sim);
    this.topBar.refresh(this.sim);
    this._cullTexts();
    // Catch objects created this frame (pooled world/HUD text, app panels,
    // newly-placed-room floor sprites) so each lands on exactly one camera.
    this._partitionCameras();

    if (perf) this._updatePerfOverlay(perf, t0, tSim, perf.now(), dtMs);
  }

  /* ---- FPS / frame-time overlay (debug; toggled via window.__chowPerf) ----
   * Tracks rolling averages of total frame-ms, sim-ms (sim.update), and
   * draw-ms (everything else) so we can A/B optimizations. Rendered through the
   * pooled-text path at depth 970 so _partitionCameras routes it to the fixed
   * UI camera — it stays put under world pan/zoom. Read-only instrumentation;
   * costs nothing unless the flag is on. */
  _updatePerfOverlay(perf, t0, tSim, t1, dtMs) {
    const a = this._perf || (this._perf = { frame: 0, sim: 0, draw: 0, fps: 0, n: 0 });
    const frameMs = t1 - t0, simMs = tSim - t0, drawMs = t1 - tSim;
    const k = a.n < 60 ? (a.n + 1) : 60;     // warm-up then fixed 60-frame window
    a.n = k;
    a.frame += (frameMs - a.frame) / k;
    a.sim   += (simMs  - a.sim)   / k;
    a.draw  += (drawMs - a.draw)  / k;
    const instFps = dtMs > 0 ? 1000 / dtMs : 0;
    a.fps += (instFps - a.fps) / k;
    const counts = `c${this.sim.customers.length} e${this.sim.employees.length} b${this.sim.buildings.length}`;
    const txt = `${a.fps.toFixed(0)} fps  ${a.frame.toFixed(1)}ms (sim ${a.sim.toFixed(1)} / draw ${a.draw.toFixed(1)})  ${counts}`;
    const t = this._getText('__perf', txt, 8, GAME_H - 10, {
      fontFamily: 'monospace', fontSize: '12px', color: '#7CFC00',
      stroke: '#000000', strokeThickness: 3,
    });
    if (t.setOrigin) t.setOrigin(0, 1);
    if (t.setDepth) t.setDepth(970);   // ≥500 → UI camera (fixed), above the HUD
  }

  /* ---- Input routing ----
   * Two cameras share the canvas, so p.worldX/Y (which Phaser derives from a
   * single camera) is ambiguous. We compute both points explicitly: the WORLD
   * point (cameras.main) drives screenToTile picking, and the UI point (uiCam,
   * == today's fixed transform) drives panel / top-bar hit-tests. p.x/p.y are
   * canvas pixels, which getWorldPoint expects. */
  _worldPoint(p) {
    const cam = this.cameras && this.cameras.main;
    if (cam && cam.getWorldPoint) { const w = cam.getWorldPoint(p.x, p.y); return { x: w.x, y: w.y }; }
    return { x: p.worldX, y: p.worldY };
  }
  _uiPoint(p) {
    if (this.uiCam && this.uiCam.getWorldPoint) { const w = this.uiCam.getWorldPoint(p.x, p.y); return { x: w.x, y: w.y }; }
    return { x: p.worldX, y: p.worldY };
  }

  _onPointerMove(p) {
    const up = this._uiPoint(p);
    if (this.appManager.consumesPointer({ worldX: up.x, worldY: up.y })) { this.hover = null; return; }
    const wp = this._worldPoint(p);
    const tile = screenToTile(wp.x, wp.y);
    if (!tile) { this.hover = null; return; }
    this.hover = { x: tile.x, y: tile.y, valid: this._previewValidAt(tile.x, tile.y) };
  }

  _onPointerDown(p) {
    const up = this._uiPoint(p);
    if (this.appManager.consumesPointer({ worldX: up.x, worldY: up.y })) {
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
    const wp = this._worldPoint(p);
    const tile = screenToTile(wp.x, wp.y); if (!tile) return;

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
    const build = this.appManager.get('build');
    // Any active map tool that exposes isValidAt drives its own hover validity
    // (move, sell, repair, rotate, assign).
    const toolId = this.appManager.activeMapToolId;
    if (toolId) {
      const tool = this.appManager.get(toolId);
      if (tool && typeof tool.isValidAt === 'function') return tool.isValidAt(this.sim, x, y);
    }
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

    // Place-Room ghost: the full furnished room footprint following the cursor.
    // A floor diamond per cell (tinted by whole-room validity) plus a furniture
    // preview on the furnished cells, so the player sees exactly what will land.
    const roomTool = this.appManager.get('place_room');
    const roomGhostShown = this.appManager.activeMapToolId === 'place_room'
      && roomTool && this.hover && typeof ROOM_CONFIGS !== 'undefined';
    if (roomGhostShown) {
      const cfg = ROOM_CONFIGS.find(c => c.id === roomTool.configId);
      if (cfg) {
        const ok = this.hover.valid;
        const fill   = ok ? 0x6bcf7f : 0xff4d4d;
        const stroke = ok ? 0x3ca35c : 0xa63030;
        // Floor diamonds first (under the furniture).
        for (const cell of cfg.cells) {
          const { sx, sy } = gridToScreen(this.hover.x + cell.dx, this.hover.y + cell.dy);
          drawDiamond(this.gGhost, sx, sy, ISO_TW - 2, ISO_TH - 1, fill, stroke, 2, 0.30, 0.9);
        }
        // Furniture previews stamped on their cells.
        for (const cell of cfg.cells) {
          if (!cell.furniture) continue;
          const previewB = this._buildPreviewBuilding(cell.furniture);
          if (!previewB) continue;
          previewB.cooking = null; previewB.washing = null;
          previewB.plate = null;   previewB.broken = false;
          const { sx, sy } = gridToScreen(this.hover.x + cell.dx, this.hover.y + cell.dy);
          const facing = cell.furniture === 'chair' ? this._roomCellChairFacing(cfg, cell) : null;
          this._drawBuildingSprite(ghostView, previewB, sx, sy, { facing });
        }
      }
    }

    // Plain hover diamond — used when no ghost is shown (map tools other than
    // move/place_room, or build placing a non-building item like floor / wall).
    const showHover = this.hover && (
      this.appManager.activeMapToolId ||
      (this.appManager.get('build') && this.appManager.get('build').activeItem)
    ) && !moveGhostShown && !buildGhostShown && !roomGhostShown;
    if (showHover) {
      const { sx, sy } = gridToScreen(this.hover.x, this.hover.y);
      Sprites.hoverDiamond(view, sx, sy, this.hover.valid);
    }

    Sprites.popups(view, this.sim);

    // Each door shows its live count of not-yet-arrived customers
    // (sim.incomingByDoor, kept parallel to spawnTiles). Guard against the
    // array being undefined or a different length than spawnTiles (e.g. a bare
    // sim, or doors changed since the plan was built) — fall back to 0.
    const doors = this.sim.spawnTiles || [this.sim.spawnTile];
    const incoming = this.sim.incomingByDoor;
    const valid = Array.isArray(incoming) && incoming.length === doors.length;
    doors.forEach((sp, i) => {
      if (!sp) return;
      const { sx, sy } = gridToScreen(sp.x, sp.y);
      const n = valid ? incoming[i] : 0;
      // Lift the count above the door tile (and any customer standing on it)
      // and give it a light halo so it stays legible against a busy sprite.
      this._getText(`door:${i}`, String(n), sx, sy - 16, {
        fontFamily: 'system-ui', fontSize: '12px', fontStyle: 'bold',
        color: '#ffffff', stroke: '#1a3a0a', strokeThickness: 3,
      });
    });
    // Retire stale door labels when the door count shrinks (mirror the pad
    // pattern below).
    for (let i = doors.length; i < (this._doorLabelCount || 0); i++) {
      const t = this._texts.get(`door:${i}`);
      if (t && t.setVisible) t.setVisible(false);
    }
    this._doorLabelCount = doors.length;

    // Number each chef spawn pad so the player can match it to the Assign menu.
    const pads = this.sim.chefSpawnPads ? this.sim.chefSpawnPads() : [];
    pads.forEach((pad, i) => {
      const { sx, sy } = gridToScreen(pad.x, pad.y);
      this._getText(`pad:${i}`, `#${i + 1}`, sx, sy - 14, {
        fontFamily: 'system-ui', fontSize: '11px', fontStyle: 'bold', color: '#5a3a0a',
      });
    });
    // Retire stale pad labels when pads are removed.
    for (let i = pads.length; i < (this._padLabelCount || 0); i++) {
      const t = this._texts.get(`pad:${i}`);
      if (t && t.setVisible) t.setVisible(false);
    }
    this._padLabelCount = pads.length;
  }

  /* ---- Ghost-preview helpers ---- */
  /** Whether a BuildApp item id maps to a Building instance (i.e. it has a
   *  sprite function we can call). Floor / player_wall items don't. */
  _isBuildingItem(id) {
    return id === 'stove' || id === 'catapult_stove'
        || id === 'table' || id === 'chair' || id === 'sink'
        || id === 'chef_spawn';
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
    else if (itemId === 'chef_spawn')     b = new ChefSpawn();
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

  /** Facing index (0=N,1=E,2=S,3=W) toward an adjacent table cell within a room
   *  config, so a chair in the room ghost orients the same way it will once
   *  placed (Sprites.chair auto-detects the real table after placement). */
  _roomCellChairFacing(cfg, cell) {
    const offs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let i = 0; i < 4; i++) {
      const tx = cell.dx + offs[i][0], ty = cell.dy + offs[i][1];
      if (cfg.cells.some(c => c.dx === tx && c.dy === ty && c.furniture === 'table')) return i;
    }
    return null;
  }

  /** Dispatch a Sprites.* call for the given building type. Mirrors the
   *  switch inside _drawScene's y-sort pass but takes an explicit view +
   *  position so ghost rendering can reuse it. */
  _drawBuildingSprite(view, b, sx, sy, opts) {
    // Dispatch by type: every building's draw fn is Sprites[b.type] (e.g.
    // Sprites.stove, Sprites.chef_spawn). Generic so any building — current or
    // future — gets a move/build ghost without editing this switch. The extra
    // opts arg (chair facing) is ignored by sprites that don't read it.
    const fn = b && Sprites[b.type];
    if (typeof fn === 'function') fn(view, b, sx, sy, opts);
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
// canvas (sized at GAME_W, the top-bar minimum) is CSS-stretched by FIT mode and again by
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

// Daily seed: replace Math.random with a deterministic mulberry32 PRNG seeded
// from the current calendar day, so every run on the same day plays out
// identically (same layout, events, abilities, spawns) — a Wordle-style daily
// seed. All game randomness funnels through Math.random, so overriding it once
// at boot covers everything (the headless test suite seeds Math.random its own
// way in test/harness.js, so this browser-only path doesn't affect tests).
// An explicit window.__chowSeed (number) overrides the date — handy for sharing
// or reproducing a specific run.
function _seedRandomFromDate() {
  let seed;
  if (typeof window !== 'undefined' && Number.isFinite(window.__chowSeed)) {
    seed = window.__chowSeed >>> 0;
  } else {
    const d = new Date();   // local calendar day
    seed = (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) >>> 0;
  }
  let s = seed || 1;
  Math.random = function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  if (typeof window !== 'undefined') window.__chowActiveSeed = seed;
};

window.startChowTime = function (opts) {
  if (window.__chowTimeInstance) return window.__chowTimeInstance;
  // Seed all randomness from today's date BEFORE the sim/Phaser are created so
  // the entire run (and Phaser's own RNG usage) is deterministic for the day.
  _seedRandomFromDate();
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
      // Re-apply framing on every active scene. GameScene owns dual-camera
      // logic (world cam keeps the user's pan/zoom; UI cam re-centers), so we
      // delegate to its onResize when present and fall back to the simple
      // single-camera reset for the (empty) UIScene.
      const scenes = (game.scene && game.scene.scenes) || [];
      for (const s of scenes) {
        if (!s || !s.cameras || !s.cameras.main) continue;
        if (s.sys && s.sys.settings && s.sys.settings.active === false) continue;
        if (typeof s.onResize === 'function') { s.onResize(next); continue; }
        s.cameras.main.setZoom(next.camZoom);
        s.cameras.main.centerOn(GAME_W / 2, GAME_H / 2);
      }
    }, 150);
  };
  if (typeof window !== 'undefined') window.addEventListener('resize', _onResize);
  return game;
};
