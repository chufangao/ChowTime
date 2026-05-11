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
  const _entityGraphics   = new Map(); // entity.id → Graphics  (customers + employees share id namespace via _eid)

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
  }

  function detach() {
    // Best-effort cleanup. Used if the scene ever restarts so we don't leak
    // GameObjects across runs.
    for (const s of _buildingSprite.values())  s.destroy();
    for (const g of _buildingOverlay.values()) g.destroy();
    for (const s of _wallSprite.values())      s.destroy();
    for (const g of _entityGraphics.values())  g.destroy();
    _buildingSprite.clear();
    _buildingOverlay.clear();
    _wallSprite.clear();
    _entityGraphics.clear();
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
    } else if (sprite.texture && sprite.texture.key !== key) {
      // Chair facing changed (rotate / move / new adjacent table) — swap frame.
      if (_scene.textures.exists(key)) sprite.setTexture(key);
    }
    sprite.setPosition(sx, layerY);

    // Overlay Graphics: drawn at LOCAL (0, 0) and offset via .position so its
    // own .y participates in the Layer sort.
    let overlay = _buildingOverlay.get(b.id);
    if (!overlay) {
      overlay = _scene.add.graphics();
      _layer.add(overlay);
      _buildingOverlay.set(b.id, overlay);
    }
    overlay.setPosition(sx, layerY);
    overlay.clear();
    // getText is a scene-wide pool that takes ABSOLUTE coords, but Sprites.*
    // are now called with local (0,0) so any text positions inside them are
    // entity-local. Wrap getText to translate local → absolute.
    const textAt = (k, s, lx, ly, st) => view.getText(k, s, sx + lx, layerY + ly, st);
    _drawBuildingOverlay(overlay, b, view, textAt);
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

  function _reconcileEntity(e, kind, view) {
    const { sx, sy } = gridToScreen(e.x, e.y);
    let g = _entityGraphics.get(e.id);
    if (!g) {
      g = _scene.add.graphics();
      _layer.add(g);
      _entityGraphics.set(e.id, g);
    }
    g.setPosition(sx, sy);
    g.clear();
    // Drive the full per-frame draw with a view that routes both g + overlay
    // to this entity's Graphics. Overlays (speech bubbles, anger bars) end
    // up on the same layer y as the body, which y-sorts correctly with the
    // rest of the world. The text pool, however, takes ABSOLUTE scene coords
    // — wrap getText so local (lx, ly) calls inside Sprites.* land at the
    // entity's world position. Without this, food-icon bubbles, broken ⚠,
    // etc. would all stack at the canvas origin.
    const textAt = (k, s, lx, ly, st) => view.getText(k, s, sx + lx, sy + ly, st);
    const localView = { g, overlay: g, time: view.time, grid: view.grid, getText: textAt };
    if (kind === 'customer')      Sprites.customer(localView, e, 0, 0);
    else if (kind === 'employee') Sprites.employee(localView, e, 0, 0);
  }

  // --- Reconciliation helpers ----------------------------------------------

  function _pruneMissing(map, validKeys) {
    for (const [key, obj] of map.entries()) {
      if (validKeys.has(key)) continue;
      obj.destroy();
      map.delete(key);
    }
  }

  // --- Public per-frame update --------------------------------------------

  function update(sim, view) {
    if (!_scene || !_layer) return;

    // Buildings
    const liveBuildings = new Set();
    for (const b of sim.buildings) {
      liveBuildings.add(b.id);
      _reconcileBuilding(b, view);
    }
    _pruneMissing(_buildingSprite,  liveBuildings);
    _pruneMissing(_buildingOverlay, liveBuildings);

    // Walls — keyed by (x, y) since they're tile state, not entity instances.
    const liveWalls = new Set();
    for (let gy = 0; gy < sim.grid.rows; gy++) {
      for (let gx = 0; gx < sim.grid.cols; gx++) {
        const t = sim.grid.tiles[gy][gx];
        if (!t || t.type !== 'wall') continue;
        const k = _wallKey(gx, gy);
        liveWalls.add(k);
        _reconcileWall(gx, gy, t.wallKind || 'player');
      }
    }
    _pruneMissing(_wallSprite, liveWalls);

    // Customers + employees share the _eid namespace from customer.js, so a
    // single map across both is safe.
    const liveEntities = new Set();
    for (const c of sim.customers) {
      liveEntities.add(c.id);
      _reconcileEntity(c, 'customer', view);
    }
    for (const e of sim.employees) {
      liveEntities.add(e.id);
      _reconcileEntity(e, 'employee', view);
    }
    _pruneMissing(_entityGraphics, liveEntities);

    // Sort the layer by y so taller-y children (closer to camera) draw on top.
    _layer.sort('y');
  }

  return { attach, detach, update };
})();
