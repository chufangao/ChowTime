/* ============================================================================
 * src/ui/app.js — App base class
 * ============================================================================
 * An "app" is one launchable surface in the phone-app-style shell. There is a
 * single registry (AppManager) and a single "active app" at a time, which
 * collapses the old web of modal-isOpen flags into one rule.
 *
 * Two flavours, distinguished only by the hasPanel flag:
 *   - hasPanel=true  → renders a centered overlay panel (Build, Hire, etc.)
 *   - hasPanel=false → "map-tool" app, no panel; activates a cursor mode
 *                      that intercepts grid clicks (Move, Sell)
 *
 * UI files live under src/ui/ so the harness can load them headless. They
 * never reference Phaser directly; they receive a `scene` object whose .add
 * factory produces drawables, and a Phaser.Container as their layer. In
 * tests, scene + container are stubbed.
 * ========================================================================== */

class App {
  /**
   * opts: { id, icon, title, isModal?, hasPanel?, lockedDuringService? }
   *   id                  — unique string ('build', 'hire', 'move', ...)
   *   icon                — short string for the top-bar button (emoji is fine)
   *   title               — long label for headers and snapshots
   *   isModal             — backdrop click cannot close (day_end, game_over)
   *   hasPanel            — false for map-tool apps; true for overlay apps (default)
   *   lockedDuringService — disables the launcher and refuses open/toggle while
   *                         sim.isDayActive() is true (Build/Hire/Move/Sell)
   */
  constructor(opts) {
    this.id       = opts.id;
    this.icon     = opts.icon || '?';
    this.title    = opts.title || opts.id;
    this.isModal  = !!opts.isModal;
    this.hasPanel = opts.hasPanel !== false;
    this.lockedDuringService = !!opts.lockedDuringService;
    this.isOpen   = false;
    this.layer    = null;          // Phaser.Container holding all visual children
    this.scene    = null;          // set by init()
    this.manager  = null;          // back-pointer set by AppManager.register()
  }

  /** Called once when the app is registered. Subclasses build their visuals
   *  inside this.layer (a Container); open()/close() then just toggle its
   *  visibility. For panel apps (hasPanel=true) we also pre-allocate the
   *  shared bgG/dynG graphics + text-pool so subclasses inherit panel
   *  rendering boilerplate via _drawPanelFrame/_t/_hideUnusedText. */
  init(scene) {
    this.scene = scene;
    if (scene && scene.add && scene.add.container) {
      this.layer = scene.add.container(0, 0);
      if (this.layer.setDepth)   this.layer.setDepth(900);
      if (this.layer.setVisible) this.layer.setVisible(false);
    }
    if (this.hasPanel && scene && scene.add && scene.add.graphics) {
      this.bgG  = scene.add.graphics();
      this.dynG = scene.add.graphics();
      if (this.layer && this.layer.add) { this.layer.add(this.bgG); this.layer.add(this.dynG); }
      if (this.bgG.setDepth)  this.bgG.setDepth(this._panelBgDepth || 900);
      if (this.dynG.setDepth) this.dynG.setDepth((this._panelBgDepth || 900) + 1);
      this._textPool = new Map();
      this._textDepth = (this._panelBgDepth || 900) + 2;
    }
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    if (this.layer && this.layer.setVisible) this.layer.setVisible(true);
    this.onOpen();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.layer && this.layer.setVisible) this.layer.setVisible(false);
    // CRITICAL: setVisible(false) on a Phaser Container does NOT disable
    // input on its children. Without this, every closed app's zones keep
    // catching pointerdown invisibly, blocking everything beneath. We also
    // can't safely destroy them (next refresh would build new ones in their
    // place anyway) — so we disable + hide them and let the pool reuse them.
    this._disableAllZones();
    this.onClose();
  }

  /* Hooks for subclasses ---------------------------------------------------- */
  onOpen()  {}
  onClose() {}

  /** Per-frame redraw of dynamic content (money, lists, etc.) */
  update(_sim) {}

  /** Whether the manager should auto-open this app right now. Default: never. */
  autoOpenWhen(_sim) { return false; }

  /** Truthy → TopBar renders a small red dot on this app's launcher.
   *  Subclasses override (e.g. day_end while an event is unresolved). */
  notification(_sim) { return false; }

  /** Map-tool hooks (only used when hasPanel === false). */
  onMapClick(_sim, _tile, _button) {}
  onMapHover(_sim, _tile)          {}
  onDeactivate(_sim)               {}

  /** Pointer hit-test for centered overlays. Default rectangle covers the
   *  panel returned by panelRect(); override for custom shapes. */
  containsPoint(px, py) {
    if (!this.hasPanel) return false;
    const r = this.panelRect();
    if (!r) return false;
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  /** Centered-overlay geometry. Reserves the top bar area so the panel's
   *  top edge isn't clipped by the persistent bar. Subclasses override for
   *  a custom size; the default helper centeredRect(w, h) handles the
   *  "centered below the top bar" math for them. */
  panelRect() {
    if (!this.hasPanel || !this.scene) return null;
    const W = (this.scene.gameWidth  != null) ? this.scene.gameWidth  : 880;
    const H = (this.scene.gameHeight != null) ? this.scene.gameHeight : 600;
    const w = Math.min(720, Math.floor(W * 0.8));
    const h = Math.min(560, Math.floor((H - this._topBarH()) * 0.85));
    return this._centeredRect(w, h);
  }

  /** Top-bar height read from the global; default 60. Used by panelRect. */
  _topBarH() {
    return (typeof TOP_BAR_H === 'number') ? TOP_BAR_H : 60;
  }

  /** Center a panel of (w, h) horizontally, and vertically inside the area
   *  below the top bar (so it never gets clipped). */
  _centeredRect(w, h) {
    const W = (this.scene.gameWidth  != null) ? this.scene.gameWidth  : 880;
    const H = (this.scene.gameHeight != null) ? this.scene.gameHeight : 600;
    const top = this._topBarH();
    const availH = Math.max(40, H - top);
    return {
      x: Math.floor((W - w) / 2),
      y: top + Math.max(8, Math.floor((availH - h) / 2)),
      w, h,
    };
  }

  /** Plain-JSON snapshot for structural tests. Subclasses extend `items`. */
  describe() {
    return {
      id:       this.id,
      kind:     this.hasPanel ? 'panel' : 'map-tool',
      isOpen:   this.isOpen,
      isModal:  this.isModal,
      lockedDuringService: this.lockedDuringService,
      title:    this.title,
      icon:     this.icon,
    };
  }

  /** Optional persistent state for save/load. Apps with no per-instance state
   *  (Build, Settings, Move, Sell, GameOver, Orders) leave these as no-ops. */
  serialize()        { return null; }
  deserialize(_st)   {}

  /* --- Shared text pool + panel-frame helpers ----------------------------- */
  /** Pooled add.text — keyed by `key`, reuses the same text object across
   *  refreshes to avoid GC churn. Mirrors what every panel app used to keep
   *  as its own private `_t` / `_text`. */
  _t(used, key, str, x, y, style) {
    if (!this._textPool || !this.scene || !this.scene.add || !this.scene.add.text) return null;
    used.add(key);
    let t = this._textPool.get(key);
    if (!t) {
      t = this.scene.add.text(x, y, str, style || {});
      if (this.layer && this.layer.add) this.layer.add(t);
      if (t.setDepth) t.setDepth(this._textDepth || 902);
      // Match the scene's camera zoom (set by GameScene._setupCamera) so
      // glyphs rasterise at canvas-pixel resolution rather than the small
      // logical size that gets upscaled = blurry.
      const res = this.scene && this.scene._textResolution;
      if (res && res > 1 && t.setResolution) t.setResolution(res);
      this._textPool.set(key, t);
    } else {
      if (t.setText)     t.setText(str);
      if (t.setPosition) t.setPosition(x, y);
      if (style && style.color && t.setColor) t.setColor(style.color);
      if (t.setVisible)  t.setVisible(true);
    }
    return t;
  }

  /** Hide pooled text not visited this refresh. */
  _hideUnusedText(used) {
    if (!this._textPool) return;
    for (const [k, t] of this._textPool.entries()) {
      if (!used.has(k) && t.setVisible) t.setVisible(false);
    }
  }

  /** Standard panel frame: dim backdrop, panel bg + border, optional close-X
   *  in the top-right corner. Subclasses call this once per refresh and then
   *  draw their app-specific contents on top.
   *
   *  opts: { backdropAlpha?, bg?, border?, radius?, closeX?, closeIcon? }
   *  closeX === false → no close button (modal apps draw their own).
   */
  _drawPanelFrame(g, dg, r, used, usedZones, opts) {
    opts = opts || {};
    const W = (this.scene && this.scene.gameWidth)  || 1100;
    const H = (this.scene && this.scene.gameHeight) || 600;
    const radius = opts.radius != null ? opts.radius : 14;
    if (g) {
      g.fillStyle(0x000000, opts.backdropAlpha != null ? opts.backdropAlpha : 0.55);
      g.fillRect(0, 0, W, H);
      g.fillStyle(opts.bg != null ? opts.bg : 0x2a1f3e, 1);
      g.fillRoundedRect(r.x, r.y, r.w, r.h, radius);
      g.lineStyle(3, opts.border != null ? opts.border : 0x6b5ba8, 1);
      g.strokeRoundedRect(r.x, r.y, r.w, r.h, radius);
    }
    if (opts.closeX !== false) {
      const bx = r.x + r.w - 38, by = r.y + 14, bw = 26, bh = 26;
      if (dg) {
        dg.fillStyle(0x4a3d7a, 1);
        dg.fillRoundedRect(bx, by, bw, bh, 5);
      }
      const isMinus = opts.closeIcon === '–';
      this._t(used, '__closeX', opts.closeIcon || '✕',
        isMinus ? bx + 8 : bx + 7, isMinus ? by : by + 3,
        { font: isMinus ? 'bold 22px system-ui' : 'bold 16px system-ui', color: '#ffffff' });
      this._bindZone('__close', bx, by, bw, bh,
        () => this.manager && this.manager.close(), usedZones);
    }
  }

  /* --- Per-frame convenience: prologue/epilogue --------------------------- */
  /** Begin a panel-update frame. Returns { used, usedZones, g, dg, r } and
   *  clears the bg/dyn graphics. Subclasses call this once per update().
   *  Returns null when the panel can't render (closed / no scene / no rect).
   *  Combines the prologue boilerplate that every panel app used to repeat. */
  _beginFrame() {
    if (!this.isOpen || !this.scene) return null;
    const r = this.panelRect(); if (!r) return null;
    const g = this.bgG, dg = this.dynG;
    if (g  && g.clear)  g.clear();
    if (dg && dg.clear) dg.clear();
    return { used: new Set(), usedZones: new Set(), g, dg, r };
  }

  /** End a panel-update frame. Hides any pooled text not visited and
   *  disables any pooled zone not bound this frame. */
  _endFrame(used, usedZones) {
    this._hideUnusedText(used);
    this._disableUnusedZones(usedZones);
  }

  /* --- Shared button + card-grid helpers ---------------------------------- */
  /** Draws a rounded button (background + label) and binds a click zone in
   *  one call. Mirrors TopBar._drawButton's rendering style but lives here
   *  so panel apps can reuse it.
   *
   *  opts: {
   *    label, font?, color?,           // text
   *    fill, border?, radius?,         // background
   *    shadow?,                        // soft drop shadow (default true)
   *    enabled?,                       // when false, no zone is bound
   *    centerLabel?,                   // when true, label is centered
   *    onClick,                        // click handler (only bound if enabled)
   *  }
   */
  _drawPanelButton(key, x, y, w, h, opts, used, usedZones) {
    const dg = this.dynG;
    const radius = opts.radius != null ? opts.radius : 8;
    if (dg) {
      if (opts.shadow !== false) {
        dg.fillStyle(0x000000, 0.25);
        dg.fillRoundedRect(x + 1, y + 2, w, h, radius);
      }
      dg.fillStyle(opts.fill != null ? opts.fill : 0x3d2d5c, 1);
      dg.fillRoundedRect(x, y, w, h, radius);
      if (opts.border !== false) {
        dg.lineStyle(2, opts.border != null ? opts.border : 0x2a1a1a, 0.8);
        dg.strokeRoundedRect(x, y, w, h, radius);
      }
    }
    const label = opts.label != null ? opts.label : '';
    const style = {
      font:  opts.font  || 'bold 14px system-ui',
      color: opts.color || '#ffffff',
    };
    if (opts.centerLabel) {
      const t = this._t(used, `btn:${key}:label`, label, x + w / 2, y + (h - 16) / 2, style);
      if (t && t.setOrigin) t.setOrigin(0.5, 0);
    } else {
      this._t(used, `btn:${key}:label`, label,
        opts.labelX != null ? opts.labelX : x + 12,
        opts.labelY != null ? opts.labelY : y + (h - 16) / 2, style);
    }
    if (opts.enabled !== false && opts.onClick) {
      this._bindZone(`btn:${key}`, x, y, w, h, opts.onClick, usedZones);
    }
  }

  /** Iterate a card grid and invoke `renderCard(item, cx, cy, cardW, cardH, i)`
   *  for each visible cell. Pure geometry — no rendering itself. The caller
   *  computes cardW/cardH (variants like 1-row N-col vs 2-col grid keep the
   *  same call shape). Skips falsy items so callers can pass a sliced pool
   *  with holes. */
  _drawCardGrid(items, opts, renderCard) {
    const cols   = opts.cols;
    const cardW  = opts.cardW;
    const cardH  = opts.cardH;
    const colGap = opts.colGap != null ? opts.colGap : 12;
    const rowGap = opts.rowGap != null ? opts.rowGap : 10;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      const col = i % cols, row = (i / cols) | 0;
      const cx = opts.x + col * (cardW + colGap);
      const cy = opts.y + row * (cardH + rowGap);
      renderCard(item, cx, cy, cardW, cardH, i);
    }
  }

  /* --- Shared zone pool helpers ------------------------------------------- */
  /** Get-or-create a persistent zone keyed by `key`, parented to this.layer,
   *  and rebind its click handler. Reusing zones (instead of destroying and
   *  recreating each frame) is critical: Phaser dispatches pointerdown to
   *  the zone object that was hit-tested at click time, and a zone destroyed
   *  in the same frame can drop the click silently. */
  _bindZone(key, x, y, w, h, onClick, used) {
    if (!this.scene || !this.scene.add || !this.scene.add.zone) return null;
    if (!this._zonePoolMap) this._zonePoolMap = new Map();
    used.add(key);
    let z = this._zonePoolMap.get(key);
    if (!z) {
      z = this.scene.add.zone(x, y, w, h);
      if (z.setOrigin)      z.setOrigin(0, 0);
      if (z.setInteractive) z.setInteractive({ useHandCursor: true });
      if (z.setDepth)       z.setDepth(905);
      if (this.layer && this.layer.add) this.layer.add(z);
      this._zonePoolMap.set(key, z);
    } else {
      if (z.setPosition) z.setPosition(x, y);
      if (z.setSize)     z.setSize(w, h);
      if (z.input && z.input.hitArea && typeof z.input.hitArea.setSize === 'function') {
        z.input.hitArea.setSize(w, h);
      }
      if (z.setVisible) z.setVisible(true);
      if (z.setInteractive && (!z.input || !z.input.enabled)) {
        z.setInteractive({ useHandCursor: true });
      }
    }
    if (z.removeAllListeners) z.removeAllListeners('pointerdown');
    if (z.on) z.on('pointerdown', onClick);
    return z;
  }

  /** Hide + disableInteractive any pooled zone NOT visited this refresh. */
  _disableUnusedZones(used) {
    if (!this._zonePoolMap) return;
    for (const [key, z] of this._zonePoolMap.entries()) {
      if (used.has(key)) continue;
      if (z.disableInteractive) z.disableInteractive();
      if (z.setVisible) z.setVisible(false);
    }
  }

  /** Disable every pooled zone — used by close() so a hidden panel doesn't
   *  silently swallow pointer events. */
  _disableAllZones() {
    if (!this._zonePoolMap) return;
    for (const z of this._zonePoolMap.values()) {
      if (z.disableInteractive) z.disableInteractive();
      if (z.setVisible) z.setVisible(false);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { App };
}
