/* ============================================================================
 * src/view/world_renderer.js — Y-sorted Layer of per-entity GameObjects
 * ============================================================================
 * Replaces the per-frame manual y-sort + dispatch loop that used to live in
 * scene._drawScene() with a Phaser display Layer that holds one GameObject
 * per renderable thing. Phaser sorts the Layer's children by their `.y`
 * property each tick, which is exactly the iso-occlusion semantics the game
 * needs.
 *
 * GameObject choice per category:
 *   - Buildings: a baked Sprite (from TextureBaker, see Phase 2) for the
 *     static body + a per-building Graphics for the animated overlays
 *     (cooking flame, plate, broken zigzag, ...). Both at the same Layer
 *     position so they composite and y-sort together.
 *   - Walls: Sprite only — no dynamic overlay needed.
 *   - Customers / Employees: per-entity Graphics, the existing
 *     Sprites.customer / Sprites.employee draws the full body into it each
 *     frame. (Future phase: bake these too.)
 *
 * Coordinate convention:
 *   Each GameObject's (x, y) is set to the footprint screen position via
 *   gridToScreen(entity.x, entity.y). Per-entity Graphics draw at LOCAL (0, 0)
 *   so the Graphics's position handles the world placement; the Layer then
 *   sorts by the .y property. Baked Sprites use their bake-time anchor as
 *   the origin so setPosition(sx, sy) lines up the footprint correctly.
 *
 * What this DOESN'T own (intentional):
 *   - Floor / door tiles: still painted into scene.gFloor (Phase 5 → Tilemap)
 *   - Ghost preview, hover diamond, build frame: scene.gGhost / scene.gOverlay
 *   - Projectiles, popups, pickup marker, door labels: scene.gObjects /
 *     scene.gOverlay — these are transient overlays that always render on
 *     top of the y-sorted world.
 * ========================================================================== */

const WorldRenderer = (() => {
  let _scene = null;
  let _layer = null;
  // Maps: entity key → GameObject(s). Cleaned per-frame against the sim's
  // current entity lists.
  const _buildingSprite   = new Map(); // id → Sprite
  const _buildingOverlay  = new Map(); // id → Graphics
  const _wallSprite       = new Map(); // "x,y" → Sprite
  // entity.id → { container, back: Graphics, sprite: Sprite|null, front: Graphics, key }
  // The container holds the baked static-body Sprite between two Graphics
  // (back = shadow+legs, front = face/hat/overlays) so z-order is insertion-
  // stable while the Layer still y-sorts whole entities against buildings.
  const _entityNode       = new Map();
  // appearanceKey → baked texture key. One body texture per unique look.
  const _charTexKey       = new Map();
  let   _charTexSeq       = 0;
  // Set true once a character bake fails / TextureBaker is unavailable; the
  // renderer then falls back to the un-baked full per-frame Graphics draw.
  let   _charBakeBroken   = false;
  let   _CHAR_ORIGIN_X = 0.5;
  let   _CHAR_ORIGIN_Y = 56 / 64;

  // Reused per-frame "live key" sets — cleared each frame instead of
  // reallocated, to keep the update loop allocation-free.
  const _liveBuildings = new Set();
  const _liveWalls     = new Set();
  const _liveEntities  = new Set();
  // Walls are tile state that changes rarely; grid.setType bumps floorVersion
  // on any tile-type change (incl. walls), so we only rescan/reconcile walls
  // when that counter moves rather than scanning the whole grid every frame.
  let _lastWallVer = -1;
  // The Layer only needs a y-sort when a child's screen-y changed or membership
  // changed (entity/building added or removed). Reconcile sets this flag; update
  // skips the O(N log N) sort on fully-static frames (dayEnd pause, everyone
  // seated). Starts true so the first frame always sorts.
  let _sortDirty = true;

  // Origin within a baked building texture so setPosition(sx, sy) places the
  // iso footprint at (sx, sy). Mirrors TextureBaker's anchor constants.
  let _BAKE_ORIGIN_X = 0.5;
  let _BAKE_ORIGIN_Y = 56 / 72;
  // Sprites are baked at BAKE_SCALE× and displayed at this factor so the
  // on-screen iso footprint matches the logical sprite size.
  let _BAKE_DISPLAY_SCALE = 1;

  function _computeAnchor() {
    if (typeof TextureBaker === 'undefined' || !TextureBaker.getAnchor) return;
    const a = TextureBaker.getAnchor();
    _BAKE_ORIGIN_X = a.sx / a.w;
    _BAKE_ORIGIN_Y = a.sy / a.h;
    if (typeof TextureBaker.getDisplayScale === 'function') {
      _BAKE_DISPLAY_SCALE = TextureBaker.getDisplayScale();
    }
    if (typeof TextureBaker.getCharAnchor === 'function') {
      const ca = TextureBaker.getCharAnchor();
      _CHAR_ORIGIN_X = ca.sx / ca.w;
      _CHAR_ORIGIN_Y = ca.sy / ca.h;
    }
  }

  function attach(scene) {
    _scene = scene;
    _computeAnchor();
    // A Layer is a GameObject that contains other GameObjects and respects
    // their .y on sort('y'). Depth places it between the floor (0) and the
    // transient-overlay Graphics (gObjects depth not explicitly set, so 0
    // by default — but we override it in scene.js to a higher value).
    _layer = scene.add.layer();
    _layer.setDepth(100);
    _lastWallVer = -1;  // first update() paints all walls
    _sortDirty = true;  // force a sort on the first frame after (re)attach
  }

  function detach() {
    // Best-effort cleanup. Used if the scene ever restarts so we don't leak
    // GameObjects across runs.
    for (const s of _buildingSprite.values())  s.destroy();
    for (const g of _buildingOverlay.values()) g.destroy();
    for (const s of _wallSprite.values())      s.destroy();
    for (const n of _entityNode.values())      n.container.destroy(true);
    _buildingSprite.clear();
    _buildingOverlay.clear();
    _wallSprite.clear();
    _entityNode.clear();
    _charTexKey.clear();
    _lastWallVer = -1;  // force a wall repaint if the scene reattaches
    if (_layer) { _layer.destroy(); _layer = null; }
    _scene = null;
  }

  // --- Buildings ------------------------------------------------------------

  function _buildingTextureKey(b) {
    // Chairs are facing-sensitive — pick the baked frame for the rendered
    // facing. b.facing may be null when the chair auto-orients from its
    // adjacent table; fall back to that lookup so the baked frame matches
    // what the old draw path produced.
    if (b.type === 'chair') {
      let f = b.facing;
      if (f == null && typeof b.getAdjacentTable === 'function' && _scene) {
        const table = b.getAdjacentTable(_scene.sim ? _scene.sim.grid : null);
        if (table) {
          const dx = Math.sign(table.x - b.x);
          const dy = Math.sign(table.y - b.y);
          if (dy < 0) f = 0; else if (dx > 0) f = 1;
          else if (dy > 0) f = 2; else if (dx < 0) f = 3;
        }
      }
      if (f == null) f = 0;
      return `building_chair_f${((f | 0) % 4 + 4) % 4}`;
    }
    return `building_${b.type}`;
  }

  function _reconcileBuilding(b, view) {
    const { sx, sy } = gridToScreen(b.x, b.y);
    // Placement bounce — was per-frame in scene.js:303. Same math, but driven
    // by the building's own .y on the Layer so y-sort still works.
    const age = view.time - b.placedAt;
    const bounce = age < 0.25 ? -Math.sin((age / 0.25) * Math.PI) * 4 : 0;
    const layerY = sy + bounce - 0.1;  // -0.1 keeps buildings just behind
                                       // entities at the same tile y, matching
                                       // the old items.push sortY = sy - 0.1

    let sprite = _buildingSprite.get(b.id);
    const key = _buildingTextureKey(b);
    if (!sprite) {
      if (!_scene.textures.exists(key)) {
        console.warn('[WorldRenderer] missing baked texture', key, '— building will be invisible.');
        return;
      }
      sprite = _scene.add.sprite(sx, layerY, key);
      sprite.setOrigin(_BAKE_ORIGIN_X, _BAKE_ORIGIN_Y);
      sprite.setScale(_BAKE_DISPLAY_SCALE);
      _layer.add(sprite);
      _buildingSprite.set(b.id, sprite);
      _sortDirty = true;   // new child → re-sort
    } else if (sprite.texture && sprite.texture.key !== key) {
      // Chair facing changed (rotate / move / new adjacent table) — swap frame.
      if (_scene.textures.exists(key)) sprite.setTexture(key);
    }
    if (sprite._ly !== layerY) { sprite._ly = layerY; _sortDirty = true; }   // y moved (move / bounce)
    sprite.setPosition(sx, layerY);

    // Overlay Graphics: drawn at LOCAL (0, 0) and offset via .position so its
    // own .y participates in the Layer sort.
    let overlay = _buildingOverlay.get(b.id);
    if (!overlay) {
      overlay = _scene.add.graphics();
      _layer.add(overlay);
      _buildingOverlay.set(b.id, overlay);
    }
    // setPosition is cheap and must always run (placement bounce + Move), but
    // the expensive clear()+redraw is gated: idle buildings (a non-broken
    // chair, an empty table, an idle stove/sink) draw a static overlay once and
    // then skip until their state changes. buildingOverlayState() — colocated
    // with the *Overlay draws — says whether the overlay is animating and gives
    // a signature of its static state. See sprites.js.
    overlay.setPosition(sx, layerY);
    const ov = (Sprites.buildingOverlayState)
      ? Sprites.buildingOverlayState(b, view.time)
      : { animating: true, sig: null };
    if (ov.animating || ov.sig !== overlay._ovSig) {
      overlay.clear();
      // getText is a scene-wide pool that takes ABSOLUTE coords, but Sprites.*
      // are now called with local (0,0) so any text positions inside them are
      // entity-local. Wrap getText to translate local → absolute.
      const textAt = (k, s, lx, ly, st) => view.getText(k, s, sx + lx, layerY + ly, st);
      _drawBuildingOverlay(overlay, b, view, textAt);
      overlay._ovSig = ov.sig;
    }
  }

  function _drawBuildingOverlay(g, b, view, textAt) {
    const localView = { g, overlay: g, time: view.time, grid: view.grid, getText: textAt };
    if      (b.type === 'stove')          Sprites.stoveOverlay(localView, b, 0, 0);
    else if (b.type === 'catapult_stove') Sprites.catapult_stoveOverlay(localView, b, 0, 0);
    else if (b.type === 'table')          Sprites.tableOverlay(localView, b, 0, 0);
    else if (b.type === 'chair')          Sprites.chairOverlay(localView, b, 0, 0);
    else if (b.type === 'sink')           Sprites.sinkOverlay(localView, b, 0, 0);
  }

  // --- Walls ---------------------------------------------------------------

  function _wallKey(x, y) { return x + ',' + y; }

  function _reconcileWall(x, y, kind) {
    const { sx, sy } = gridToScreen(x, y);
    const k = _wallKey(x, y);
    let sprite = _wallSprite.get(k);
    const texKey = kind === 'prebuilt' ? 'wall_prebuilt' : 'wall_player';
    if (!sprite) {
      if (!_scene.textures.exists(texKey)) {
        console.warn('[WorldRenderer] missing baked texture', texKey, '— wall will be invisible.');
        return;
      }
      sprite = _scene.add.sprite(sx, sy - 0.05, texKey);
      sprite.setOrigin(_BAKE_ORIGIN_X, _BAKE_ORIGIN_Y);
      sprite.setScale(_BAKE_DISPLAY_SCALE);
      _layer.add(sprite);
      _wallSprite.set(k, sprite);
    } else if (sprite.texture && sprite.texture.key !== texKey) {
      if (_scene.textures.exists(texKey)) sprite.setTexture(texKey);
    }
    sprite.setPosition(sx, sy - 0.05);
  }

  // --- Customers / Employees -----------------------------------------------

  // Resolve (baking if needed) the static-body texture key for this entity's
  // appearance. Returns null if baking is unavailable, signalling the caller to
  // use the un-baked fallback draw.
  function _charTextureFor(e, kind) {
    // Debug escape hatch: window.__WR_NOBAKE forces the un-baked fallback draw
    // so the baked vs legacy paths can be A/B compared in the same build.
    if (typeof window !== 'undefined' && window.__WR_NOBAKE) return null;
    if (_charBakeBroken || typeof TextureBaker === 'undefined' || !TextureBaker.bakeCharacter) {
      _charBakeBroken = true; return null;
    }
    const appKey = (kind === 'customer') ? Sprites.customerAppearanceKey(e) : Sprites.employeeAppearanceKey(e);
    let texKey = _charTexKey.get(appKey);
    if (texKey) return texKey;
    texKey = 'char_' + (_charTexSeq++);
    const baseFn = (kind === 'customer') ? Sprites.customerBase : Sprites.employeeBase;
    // Neutral stub: hasPath()=false zeroes bob/stride so the body bakes at rest.
    const stub = (kind === 'customer')
      ? { bodyColor: e.bodyColor, skinColor: e.skinColor, hairColor: e.hairColor, hasHair: e.hasHair, hat: e.hat, id: 0, hasPath: () => false }
      : { skinColor: e.skinColor, visual: e.visual, id: 0, hasPath: () => false };
    // bakeCharacter calls drawFn(stubView, ax, ay) with ax/ay at the in-texture
    // footprint anchor; draw the base there so the sprite origin lines up.
    const ok = TextureBaker.bakeCharacter(_scene, texKey, (sv, ax, ay) => baseFn(sv, stub, ax, ay));
    if (!ok) { _charBakeBroken = true; return null; }
    _charTexKey.set(appKey, texKey);
    return texKey;
  }

  function _reconcileEntity(e, kind, view) {
    const { sx, sy } = gridToScreen(e.x, e.y);
    let node = _entityNode.get(e.id);
    if (!node) {
      const container = _scene.add.container(sx, sy);
      const back  = _scene.add.graphics();
      const front = _scene.add.graphics();
      // Insertion order = render order inside the container: back, (sprite), front.
      container.add(back);
      container.add(front);
      _layer.add(container);
      node = { container, back, front, sprite: null, key: null, ly: null };
      _entityNode.set(e.id, node);
      _sortDirty = true;   // new child → re-sort
    }
    if (node.ly !== sy) { node.ly = sy; _sortDirty = true; }   // entity moved in screen-y
    node.container.setPosition(sx, sy);
    node.container.y = sy;  // explicit: Layer.sort('y') reads container.y

    // Wrap the text pool so local (lx, ly) lands at the entity's world position.
    const textAt = (k, s, lx, ly, st) => view.getText(k, s, sx + lx, sy + ly, st);

    const texKey = _charTextureFor(e, kind);
    if (texKey) {
      // Baked body sprite between back/front, offset up by the walk bob.
      const bob = Sprites.entityBob(e, view.time, kind === 'employee');
      if (!node.sprite || node.key !== texKey) {
        if (node.sprite) node.sprite.destroy();
        node.sprite = _scene.add.sprite(0, 0, texKey);
        node.sprite.setOrigin(_CHAR_ORIGIN_X, _CHAR_ORIGIN_Y);
        node.sprite.setScale(_BAKE_DISPLAY_SCALE);
        // Keep z-order back < sprite < front.
        node.container.addAt(node.sprite, 1);
        node.key = texKey;
      }
      node.sprite.setPosition(0, -bob);
      const backView  = { g: node.back,  overlay: node.back,  time: view.time, grid: view.grid, getText: textAt };
      const frontView = { g: node.front, overlay: node.front, time: view.time, grid: view.grid, getText: textAt };
      node.back.clear();
      node.front.clear();
      if (kind === 'customer') { Sprites.customerBack(backView, e, 0, 0); Sprites.customerFront(frontView, e, 0, 0); }
      else                     { Sprites.employeeBack(backView, e, 0, 0); Sprites.employeeFront(frontView, e, 0, 0); }
    } else {
      // Fallback: no baking — draw the whole body into the back Graphics each
      // frame (front stays empty), preserving the original look.
      if (node.sprite) { node.sprite.destroy(); node.sprite = null; node.key = null; }
      const localView = { g: node.back, overlay: node.back, time: view.time, grid: view.grid, getText: textAt };
      node.back.clear();
      node.front.clear();
      if (kind === 'customer')      Sprites.customer(localView, e, 0, 0);
      else if (kind === 'employee') Sprites.employee(localView, e, 0, 0);
    }
  }

  // --- Reconciliation helpers ----------------------------------------------

  function _pruneMissing(map, validKeys) {
    for (const [key, obj] of map.entries()) {
      if (validKeys.has(key)) continue;
      obj.destroy();
      map.delete(key);
      _sortDirty = true;   // membership shrank → re-sort
    }
  }

  // --- Public per-frame update --------------------------------------------

  function update(sim, view) {
    if (!_scene || !_layer) return;

    // Buildings
    _liveBuildings.clear();
    for (const b of sim.buildings) {
      _liveBuildings.add(b.id);
      _reconcileBuilding(b, view);
    }
    _pruneMissing(_buildingSprite,  _liveBuildings);
    _pruneMissing(_buildingOverlay, _liveBuildings);

    // Walls — keyed by (x, y) since they're tile state, not entity instances.
    // Only rescan when the grid actually changed (a wall placed/removed bumps
    // floorVersion); otherwise the existing wall Sprites are already correct.
    const wallVer = sim.grid.floorVersion;
    if (wallVer !== _lastWallVer) {
      _lastWallVer = wallVer;
      _sortDirty = true;   // walls changed → re-sort
      _liveWalls.clear();
      for (let gy = 0; gy < sim.grid.rows; gy++) {
        for (let gx = 0; gx < sim.grid.cols; gx++) {
          const t = sim.grid.tiles[gy][gx];
          if (!t || t.type !== 'wall') continue;
          const k = _wallKey(gx, gy);
          _liveWalls.add(k);
          _reconcileWall(gx, gy, t.wallKind || 'player');
        }
      }
      _pruneMissing(_wallSprite, _liveWalls);
    }

    // Customers + employees share the _eid namespace from customer.js, so a
    // single map across both is safe.
    _liveEntities.clear();
    for (const c of sim.customers) {
      _liveEntities.add(c.id);
      _reconcileEntity(c, 'customer', view);
    }
    for (const e of sim.employees) {
      _liveEntities.add(e.id);
      _reconcileEntity(e, 'employee', view);
    }
    for (const [id, node] of _entityNode.entries()) {
      if (_liveEntities.has(id)) continue;
      node.container.destroy(true);   // destroys back/front Graphics + sprite child
      _entityNode.delete(id);
      _sortDirty = true;   // entity left → re-sort
    }

    // Sort the layer by y so taller-y children (closer to camera) draw on top.
    // Skipped on fully-static frames (nothing moved, no membership change) —
    // saves the O(N log N) sort during pauses and when everyone is seated.
    if (_sortDirty) { _layer.sort('y'); _sortDirty = false; }
  }

  return { attach, detach, update };
})();
