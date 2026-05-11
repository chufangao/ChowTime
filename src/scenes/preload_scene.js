/* ============================================================================
 * src/scenes/preload_scene.js — Asset preload stage
 * ============================================================================
 * Runs after BootScene, before GameScene. This is where atlases, tilemaps,
 * and audio will be loaded once those assets exist (see migration phase 2).
 *
 * For now: preload() is empty and create() immediately starts GameScene. The
 * stage exists so phase 2 can land asset loading in one place without
 * touching scene.js.
 *
 * Future shape:
 *   preload() {
 *     this.load.atlas('entities',  'assets/atlases/entities.png',  'assets/atlases/entities.json');
 *     this.load.atlas('furniture', 'assets/atlases/furniture.png', 'assets/atlases/furniture.json');
 *     this.load.atlas('ui',        'assets/atlases/ui.png',        'assets/atlases/ui.json');
 *   }
 * ========================================================================== */

class PreloadScene extends Phaser.Scene {
  constructor() {
    super('preload');
  }

  preload() {
    // Real PNG/JSON atlases will land here once art exists. Until then, see
    // create() — we bake textures procedurally from the existing sprites.js
    // drawing code.
  }

  create() {
    // Pre-render every static building + wall variant into named Phaser
    // textures. From here on, Sprite(scene, x, y, 'building_stove') etc. is
    // valid anywhere. See src/view/texture_baker.js for the key list.
    if (typeof TextureBaker !== 'undefined') {
      TextureBaker.bakeAll(this);
    }
    this.scene.start('game');
  }
}
