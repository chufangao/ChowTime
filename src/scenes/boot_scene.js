/* ============================================================================
 * src/scenes/boot_scene.js — Boot stage
 * ============================================================================
 * Minimal scene that runs before anything else. Today it exists purely as a
 * lifecycle entry point; it does no asset loading itself. Its only job is to
 * hand control to PreloadScene immediately.
 *
 * Why split this out from PreloadScene? Phaser's recommended pattern is a
 * tiny Boot stage that loads just enough to draw a loading bar, followed by
 * a Preload stage that does the bulk of asset loading. Even though we have
 * no loading bar yet, keeping the stages separated makes adding one a
 * one-file change later.
 * ========================================================================== */

class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create() {
    this.scene.start('preload');
  }
}
