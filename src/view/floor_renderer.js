/* ============================================================================
 * src/view/floor_renderer.js — Per-tile Sprites for the iso grid floor
 * ============================================================================
 * Replaces the all-at-once Sprites.floorAndDoor() paint into a single
 * Graphics. Each grid tile becomes a Phaser Sprite using a baked texture
 * (floor_a / floor_b / floor_gap / floor_spawn). The tile sprites live on a
 * dedicated Layer at depth ~10, beneath the WorldRenderer Layer (depth 100)
 * but above the static background strips painted into scene.gFloor.
 *
 * Why not a Phaser Tilemap? Tilemap is great for orthogonal grids and has
 * tooling around Tiled JSON. For an iso projection like this game's, the
 * coordinate math + cell-by-cell mutation flow doesn't get simpler — and we
 * lose the ability to share gridToScreen with the rest of the renderer.
 * Per-tile Sprites give us the same benefit (GPU-batched, per-cell updates
 * without a full redraw) with much less plumbing.
 *
 * Tile-change detection: this module is called every time the floor "signature"
 * changes — same trigger the old code used. Internally we compare each tile's
 * current type against its last-painted type and only re-set textures for
 * tiles that actually changed.
 * ========================================================================== */

const FloorRenderer = (() => {
  let _scene = null;
  let _layer = null;
  // tileSprite[gy][gx] = Sprite. Pre-allocated 2D array indexed by grid coord.
  let _sprites = null;
  // tilePainted[gy][gx] = last applied texture key (or null).
  let _painted = null;

  let _ORIGIN_X = 0.5;
  let _ORIGIN_Y = 0.5;
  // Tile textures are baked at BAKE_SCALE× — display at the inverse so each
  // diamond stays the logical ISO_TW × ISO_TH size on screen.
  let _DISPLAY_SCALE = 1;

  function _computeAnchor() {
    if (typeof TextureBaker === 'undefined' || !TextureBaker.getTileAnchor) return;
    const a = TextureBaker.getTileAnchor();
    _ORIGIN_X = a.sx / a.w;
    _ORIGIN_Y = a.sy / a.h;
    if (typeof TextureBaker.getDisplayScale === 'function') {
      _DISPLAY_SCALE = TextureBaker.getDisplayScale();
    }
  }

  function _tileKey(t) {
    if (!t) return 'floor_a';
    if (t.type === 'gap')   return 'floor_gap';
    if (t.type === 'spawn') return 'floor_spawn';
    // Default floor uses an A/B checker by tile parity. Computed at the
    // call site (we need x+y) — caller passes the resolved key.
    return null; // sentinel: caller must compute parity-aware key
  }

  function _resolveKey(t, x, y) {
    const k = _tileKey(t);
    if (k) return k;
    return ((x + y) & 1) ? 'floor_a' : 'floor_b';
  }

  function attach(scene, sim) {
    _scene = scene;
    _computeAnchor();
    _layer = scene.add.layer();
    _layer.setDepth(10);  // above gFloor (0), below WorldRenderer Layer (100)
    const rows = sim.grid.rows;
    const cols = sim.grid.cols;
    _sprites = new Array(rows);
    _painted = new Array(rows);
    for (let y = 0; y < rows; y++) {
      _sprites[y] = new Array(cols).fill(null);
      _painted[y] = new Array(cols).fill(null);
    }
    // Initial paint of every cell.
    update(sim, /*force=*/true);
  }

  function detach() {
    if (_layer) { _layer.destroy(); _layer = null; }
    _sprites = null;
    _painted = null;
    _scene = null;
  }

  /** Reconcile tile sprites against current grid state. Skips unchanged tiles
   *  unless `force` is true. Pass force=true on attach + after a full layout
   *  reroll where every tile may have changed (the old code triggered a full
   *  repaint in both cases; here we just iterate every cell either way and
   *  the per-cell texture compare gates the actual setTexture call). */
  function update(sim, force) {
    if (!_scene || !_layer || !_sprites) return;
    const rows = sim.grid.rows;
    const cols = sim.grid.cols;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const t = sim.grid.tiles[y][x];
        const key = _resolveKey(t, x, y);
        if (!force && _painted[y][x] === key && _sprites[y][x]) continue;
        const { sx, sy } = gridToScreen(x, y);
        let s = _sprites[y][x];
        if (!s) {
          if (!_scene.textures.exists(key)) {
            // Texture missing — leave the cell empty. The static gFloor
            // backdrop still renders behind it so we don't get a hole.
            continue;
          }
          s = _scene.add.sprite(sx, sy, key);
          s.setOrigin(_ORIGIN_X, _ORIGIN_Y);
          s.setScale(_DISPLAY_SCALE);
          _layer.add(s);
          _sprites[y][x] = s;
        } else if (s.texture && s.texture.key !== key && _scene.textures.exists(key)) {
          s.setTexture(key);
        }
        _painted[y][x] = key;
      }
    }
  }

  return { attach, detach, update };
})();
