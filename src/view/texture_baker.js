/* ============================================================================
 * src/view/texture_baker.js — Procedural-art → Phaser texture pipeline
 * ============================================================================
 * The project ships no PNG art. Every building and entity is drawn from
 * Graphics primitives in sprites.js. To use Phaser Sprites + atlases (the
 * point of the phaser-native migration), we need actual textures with keys
 * that Sprite() can reference.
 *
 * Strategy: in PreloadScene.create(), draw each *static base* sprite into an
 * offscreen Graphics, then call Graphics.generateTexture(key, w, h) to bake
 * the result into a Phaser texture. Once baked, the textures are addressable
 * via `scene.textures.get(key)` from anywhere.
 *
 * What is baked here:
 *   - Building bases: stove, catapult_stove, table, chair (×4 facings), sink.
 *     "Base" means the entity with no transient state — no cooking flame, no
 *     broken zigzag, no plate on the surface. Those overlays continue to be
 *     drawn per-frame on top of the sprite in later phases.
 *   - Walls: player and prebuilt variants.
 *
 * What is NOT baked here (intentional):
 *   - Customers/employees: too many appearance variants (body × skin × pants
 *     × hair × facing). Phase 3 handles them via on-demand RenderTextures or
 *     tinted base sprites.
 *   - Animated state frames (stove cooking flame, smoke, customer leg swing):
 *     Phase 4 handles these as proper sprite animations or Tweens.
 *   - Hover/build/ghost overlays: stay as per-frame Graphics calls — they're
 *     transient UI, not entities, and don't benefit from baking.
 *
 * Texture key convention:
 *   <category>_<variant>   e.g. "building_stove", "wall_player", "chair_f2"
 *
 * Each Sprites.<type>(view, b, sx, sy[, opts]) function is called with an
 * offscreen Graphics as view.g/overlay, a stub building instance, and a
 * canvas-local (sx, sy) anchor positioned so the iso footprint sits roughly
 * centered horizontally and near the bottom of the texture (because iso
 * structures grow upward from their footprint).
 * ========================================================================== */

const TextureBaker = (() => {
  // Super-sampling factor. We draw + bake each texture at BAKE_SCALE× the
  // logical sprite size, then Sprite.setScale(1 / BAKE_SCALE) at runtime so
  // the on-screen footprint matches the iso-grid math (which still works in
  // ISO_TW / ISO_TH logical pixels). With antialias on, the GPU downscales
  // the super-sampled texture and pixels stay crisp — especially on Retina
  // (DPR ≥ 2), where 1× bakes look noticeably soft.
  const BAKE_SCALE = 2;

  // Logical texture box. The tallest building (stove H=34 plus footprint
  // diamond) fits with margin. Same size for every key so Sprite placement
  // math is uniform — wasted alpha pixels are cheap.
  const TEX_W = 80;
  const TEX_H = 72;
  // Footprint center within the (logical) texture: horizontally centered,
  // vertically placed so the diamond's bottom corner sits a few px above
  // the texture floor and the tallest structure (~40px above sy) fits.
  const ANCHOR_SX = TEX_W / 2;       // 40
  const ANCHOR_SY = TEX_H - 16;      // 56  → leaves ~40px of headroom above

  // Stub view: drawing functions read view.g and view.overlay (both routed
  // to the same offscreen Graphics) plus view.time (set to 0; base
  // appearances ignore animated state) and view.grid (null; chair's table
  // lookup is skipped because we pass opts.facing explicitly).
  function _stubView(g) {
    return {
      g,
      overlay: g,
      time: 0,
      grid: null,
      getText: () => null,
    };
  }

  function _bake(scene, key, drawFn) {
    if (scene.textures.exists(key)) return;
    // make.graphics is the Phaser-idiomatic way to create an offscreen
    // Graphics that isn't added to the display list. add:false is critical
    // — without it the temp graphics flashes on screen for a frame.
    const g = scene.make.graphics({ x: 0, y: 0, add: false });
    try {
      // Scale the Graphics transform so all draw primitives (drawn in logical
      // coords) emit at BAKE_SCALE× pixels. generateTexture then reads back
      // a super-sampled bitmap.
      if (typeof g.scale === 'object' && g.scale) {
        g.scale.set(BAKE_SCALE, BAKE_SCALE);
      } else if (typeof g.setScale === 'function') {
        g.setScale(BAKE_SCALE);
      }
      drawFn(_stubView(g), ANCHOR_SX, ANCHOR_SY);
      g.generateTexture(key, TEX_W * BAKE_SCALE, TEX_H * BAKE_SCALE);
    } catch (err) {
      // Don't let a single bad bake brick the preload stage. The missing
      // texture will surface as a Sprite render miss later, which is
      // recoverable; an exception in create() is not.
      console.error('[TextureBaker] bake failed for', key, err);
    } finally {
      g.destroy();
    }
  }

  // Public API ------------------------------------------------------------

  function bakeAll(scene) {
    if (typeof Sprites === 'undefined') {
      console.warn('[TextureBaker] Sprites global missing; skipping bake.');
      return;
    }

    // --- Buildings (base appearance, no transient state) ---
    _bake(scene, 'building_stove', (v, sx, sy) => {
      Sprites.stove(v, new Stove(), sx, sy);
    });
    _bake(scene, 'building_catapult_stove', (v, sx, sy) => {
      Sprites.catapult_stove(v, new CatapultStove(), sx, sy);
    });
    _bake(scene, 'building_table', (v, sx, sy) => {
      Sprites.table(v, new Table(), sx, sy);
    });
    _bake(scene, 'building_sink', (v, sx, sy) => {
      Sprites.sink(v, new Sink(), sx, sy);
    });

    // Chairs are facing-sensitive. Bake one frame per cardinal so phase 4
    // can pick the right key without an additional runtime rotation step.
    for (let f = 0; f < 4; f++) {
      _bake(scene, `building_chair_f${f}`, (v, sx, sy) => {
        Sprites.chair(v, new Chair(), sx, sy, { facing: f });
      });
    }

    // --- Walls (two visual variants; tile state decides which at runtime) ---
    _bake(scene, 'wall_player', (v, sx, sy) => {
      Sprites.wall(v, null, null, 'player', sx, sy);
    });
    _bake(scene, 'wall_prebuilt', (v, sx, sy) => {
      Sprites.wall(v, null, null, 'prebuilt', sx, sy);
    });

    // --- Floor tiles (one per type) ---
    // Tile textures use a tighter bounding box than buildings because a floor
    // diamond is at most 2*ISO_TW wide and 2*ISO_TH tall. Anchor centered.
    _bakeTile(scene, 'floor_a', (v, sx, sy) => {
      drawDiamond(v.g, sx, sy, ISO_TW, ISO_TH, COLORS.floorA, 0x000000, 1, 1, 0.12);
    });
    _bakeTile(scene, 'floor_b', (v, sx, sy) => {
      drawDiamond(v.g, sx, sy, ISO_TW, ISO_TH, COLORS.floorB, 0x000000, 1, 1, 0.12);
    });
    _bakeTile(scene, 'floor_gap', (v, sx, sy) => {
      // Outer + inner ring give the recessed-void look without vertical
      // extrusion (a flat tile that never occludes adjacent diamonds).
      drawDiamond(v.g, sx, sy, ISO_TW,     ISO_TH,     0x0a0510, 0x000000, 1, 1, 1);
      drawDiamond(v.g, sx, sy, ISO_TW - 6, ISO_TH - 3, 0x05030a, 0x000000, 0, 1, 1);
    });
    _bakeTile(scene, 'floor_spawn', (v, sx, sy) => {
      // Door overlay is baked into the same texture as the green floor —
      // every spawn tile is a door tile in this game, so we never need to
      // render them separately.
      drawDiamond(v.g, sx, sy, ISO_TW, ISO_TH, COLORS.spawn, 0x000000, 1, 1, 0.12);
      drawDiamond(v.g, sx, sy, ISO_TW, ISO_TH, 0x4d8a3a, 0x2d5a1a, 2);
      v.g.fillStyle(0x2d5a1a, 1);
      v.g.fillCircle(sx, sy - 2, 5);
    });
  }

  // Smaller bounding box for floor tiles. ISO_TW=36, ISO_TH=18 → diamond
  // spans (-36, -18) to (+36, +18) around center. Box 80×40 fits with margin.
  const TILE_W = 80;
  const TILE_H = 40;
  const TILE_AX = TILE_W / 2;   // 40
  const TILE_AY = TILE_H / 2;   // 20

  function _bakeTile(scene, key, drawFn) {
    if (scene.textures.exists(key)) return;
    const g = scene.make.graphics({ x: 0, y: 0, add: false });
    try {
      if (typeof g.scale === 'object' && g.scale) {
        g.scale.set(BAKE_SCALE, BAKE_SCALE);
      } else if (typeof g.setScale === 'function') {
        g.setScale(BAKE_SCALE);
      }
      drawFn(_stubView(g), TILE_AX, TILE_AY);
      g.generateTexture(key, TILE_W * BAKE_SCALE, TILE_H * BAKE_SCALE);
    } catch (err) {
      console.error('[TextureBaker] tile bake failed for', key, err);
    } finally {
      g.destroy();
    }
  }

  // Origin for tile sprites so setPosition(sx, sy) places the diamond center
  // at (sx, sy). FloorRenderer reads this. w/h are in LOGICAL pixels; the
  // baked texture is BAKE_SCALE× larger and renderers compensate via
  // setScale(displayScale).
  function getTileAnchor() {
    return { sx: TILE_AX, sy: TILE_AY, w: TILE_W, h: TILE_H };
  }

  // The (sx, sy) anchor used during bake. Renderers need this to position
  // Sprites correctly: a sprite's center is at (origin*W, origin*H), so to
  // make a sprite render with its footprint at (worldX, worldY), the sprite
  // origin must compensate for the anchor offset within the texture.
  // The anchor is in LOGICAL coords; origins computed as sx/w / sy/h stay
  // correct regardless of BAKE_SCALE because they're a fraction of the box.
  function getAnchor() {
    return { sx: ANCHOR_SX, sy: ANCHOR_SY, w: TEX_W, h: TEX_H };
  }

  // The factor renderers should apply to baked Sprites so the on-screen size
  // matches the logical (pre-bake) sprite size. With BAKE_SCALE=2, this is
  // 0.5: the texture is 2× supersampled, displayed at 1× logical size.
  function getDisplayScale() {
    return 1 / BAKE_SCALE;
  }

  return { bakeAll, getAnchor, getTileAnchor, getDisplayScale };
})();
