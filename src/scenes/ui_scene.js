/* ============================================================================
 * src/scenes/ui_scene.js — Parallel HUD overlay scene
 * ============================================================================
 * Launched in parallel with GameScene via `this.scene.launch('ui')` from
 * GameScene.create(). Phaser renders launched scenes on top of the launcher
 * and dispatches input to them first (scenes are iterated in reverse for
 * input), which is the standard Phaser pattern for HUD overlays.
 *
 * Current state: this scene is intentionally empty. The TopBar, app panels,
 * and widgets still live inside GameScene because they're tightly coupled to
 * AppManager's world-click routing (BuildApp / MoveApp / SellApp need a
 * direct line to the world's pointer events). Migrating them to UIScene is
 * a later step that depends on refactoring AppManager to bridge two scenes.
 *
 * For now this scene exists as a registered placeholder so:
 *   - the scene array in scene.js reflects the target architecture
 *   - future phases can move HUD elements here one at a time without
 *     re-wiring the Phaser.Game config
 *
 * Cross-scene access pattern (to use when content migrates here):
 *   const game = this.scene.get('game');
 *   game.events.on('sim-tick', sim => this.refreshHud(sim));
 *   // remember to off() in shutdown() — leaked listeners across scene
 *   // restarts are Phaser's #1 memory leak source.
 * ========================================================================== */

class UIScene extends Phaser.Scene {
  constructor() {
    super('ui');
  }

  create() {
    // Empty by design — see file header. Content lands here in later phases.
    // Mirror GameScene's camera setup so any HUD added here later renders at
    // the same logical-coord scale: backing-store is at physical pixels and
    // we zoom the camera so world (0..GAME_W, 0..GAME_H) fills the canvas.
    const size = (typeof window !== 'undefined' && window.__chowTimeSize) || null;
    if (size && this.cameras && this.cameras.main) {
      this.cameras.main.setZoom(size.camZoom || 1);
      if (typeof GAME_W !== 'undefined' && typeof GAME_H !== 'undefined') {
        this.cameras.main.centerOn(GAME_W / 2, GAME_H / 2);
      }
    }
  }
}
