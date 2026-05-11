/* ============================================================================
 * src/ui/top_bar.js — Persistent top bar (replaces the right-side Sidebar)
 * ============================================================================
 * Layout: fixed-height strip across the top of the canvas.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ [💰$420] [❤️❤️🖤] [Day 2 · 3/8] [😊5 😡1...]   …     [B][H][⚙]  [⏩2x][↔][🏷] │
 *   │ ← status widgets (auto-laid)            launchers     map-tools/speed →
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Reads the live registry from AppManager. Adding a new App or Widget elsewhere
 * is enough — TopBar discovers them at draw time. No hardcoded button list.
 *
 * NOTE: The bar height (default 60) is read from the global TOP_BAR_H if
 * sprites.js has set it; otherwise we fall back to 60. We do NOT redeclare
 * the constant here — multiple top-level `const`/`var` declarations of the
 * same name across <script> tags share one global lexical scope and crash
 * the browser bundle with "Identifier already declared".
 * ========================================================================== */

class TopBar {
  /**
   * scene   — Phaser.Scene-like object (real or stubbed)
   * manager — AppManager instance
   * gameWidth, gameHeight — canvas dimensions (passed in so we don't import sprites)
   */
  constructor(scene, manager, gameWidth, gameHeight) {
    this.scene   = scene;
    this.manager = manager;
    this.W       = gameWidth;
    this.H       = gameHeight;
    this.height  = (typeof TOP_BAR_H === 'number') ? TOP_BAR_H : 60;
    // Persistent, keyed pools. Destroying zones every frame caused Phaser to
    // sometimes miss the click that landed on a now-dead zone, since hit-test
    // and dispatch happen across frames. Reuse zone objects by key — we
    // reposition + rebind per refresh.
    this._zonePool = new Map();   // key → zone
    this._textPool = new Map();   // key → text
    this._build();
    manager.topBarRect = { x: 0, y: 0, w: this.W, h: this.height };
  }

  _build() {
    const scene = this.scene;
    // Background strip.
    this.bgG = scene.add.graphics ? scene.add.graphics() : null;
    if (this.bgG && this.bgG.setDepth) this.bgG.setDepth(950);
    // Foreground (button bodies, redrawn each frame).
    this.dynG = scene.add.graphics ? scene.add.graphics() : null;
    if (this.dynG && this.dynG.setDepth) this.dynG.setDepth(951);

    if (this.bgG) {
      this.bgG.fillStyle(0x2a1f3e, 1);
      this.bgG.fillRect(0, 0, this.W, this.height);
      this.bgG.fillStyle(0x6b5ba8, 1);
      this.bgG.fillRect(0, this.height - 2, this.W, 2);
    }
  }

  /** Pooled add.text — reused across redraws to avoid GC churn. */
  _addText(key, str, x, y, style) {
    let t = this._textPool.get(key);
    if (!t) {
      t = this.scene.add.text(x, y, str, style || {});
      if (t.setDepth) t.setDepth(952);
      // Match the scene's camera zoom (set by GameScene._setupCamera) so
      // glyphs rasterise at canvas-pixel resolution rather than the small
      // logical size that gets upscaled = blurry.
      const res = this.scene && this.scene._textResolution;
      if (res && res > 1 && t.setResolution) t.setResolution(res);
      this._textPool.set(key, t);
    } else {
      if (t.setText)     t.setText(str);
      if (t.setPosition) t.setPosition(x, y);
      if (t.setVisible)  t.setVisible(true);
    }
    return t;
  }

  _hideUnusedText(usedKeys) {
    for (const [k, t] of this._textPool.entries()) {
      if (!usedKeys.has(k) && t.setVisible) t.setVisible(false);
    }
  }

  /** Per-frame layout + draw. Three horizontal regions split by allocated
   *  widths so widgets, launchers, tools, and speed never overlap. Zones
   *  are pooled by key — reused across frames, never destroyed mid-click. */
  refresh(sim) {
    const usedTexts = new Set();
    const usedZones = new Set();
    const g = this.dynG;
    if (g && g.clear) g.clear();

    const PAD       = 6;
    // BTN_W matches TOOL_W so all six panel launchers fit in the center gap
    // when the canvas is at its minimum width. With BTN_W=64 the start_day
    // and midday_event launchers got clipped by the rightLeftEdge cull below.
    const BTN_W     = 52;
    const TOOL_W    = 52;
    const SPEED_W   = 56;
    const BTN_GAP   = 4;

    // ---- RIGHT region: speed + map tools, packed right-to-left ----
    let rx = this.W - PAD;
    rx -= SPEED_W;
    this._drawButton(g, rx, 8, SPEED_W, this.height - 16, {
      label: `⏩${sim ? (sim._uiSpeed || 1) : 1}×`,
      bg: 0x3d2d5c, key: 'speed',
    }, usedTexts);
    this._bindZone('speed', rx, 8, SPEED_W, this.height - 16, () => this._cycleSpeed(sim), usedZones);
    rx -= BTN_GAP;

    for (const app of [...this.manager.appOrder].reverse()) {
      if (app.hasPanel) continue;
      rx -= TOOL_W;
      const active = (this.manager.activeMapToolId === app.id);
      const locked = this.manager.isLockedNow(app);
      this._drawButton(g, rx, 8, TOOL_W, this.height - 16, {
        label: app.icon, sub: app.title,
        bg: active ? 0xd9a14a : 0x3d2d5c,
        key: `tool:${app.id}`,
        textColor: active ? '#1a1428' : '#ffffff',
        dim: locked,
        notify: this._appNotifies(app, sim),
      }, usedTexts);
      if (!locked) {
        this._bindZone(`tool:${app.id}`, rx, 8, TOOL_W, this.height - 16,
          () => this.manager.toggle(app.id), usedZones);
      }
      rx -= BTN_GAP;
    }
    const rightLeftEdge = rx;

    // ---- LEFT region: status widgets ----
    let cx = PAD;
    for (const w of this.manager.widgets) {
      const ww = (typeof w.width === 'function') ? w.width(sim) : 80;
      if (ww <= 0) continue;
      if (cx + ww > rightLeftEdge - 4) break;
      if (typeof w.render === 'function') {
        w.render(g, (k, str, x, y, st) => {
          const key = `widget:${w.id}:${k}`;
          usedTexts.add(key);
          return this._addText(key, str, x, y, st);
        }, cx, 0, ww, sim);
      }
      cx += ww;
    }
    const leftRightEdge = cx;

    // ---- CENTER region: panel-app launchers ----
    // Game-over modal stays out (player can't dismiss it anyway).
    const panelApps = this.manager.appOrder.filter(a =>
      a.hasPanel && a.id !== 'game_over'
    );
    const centerW = panelApps.length * BTN_W + Math.max(0, panelApps.length - 1) * BTN_GAP;
    const gap = rightLeftEdge - leftRightEdge;
    let lx = (gap >= centerW + 24)
      ? leftRightEdge + Math.floor((gap - centerW) / 2)
      : leftRightEdge + 6;
    for (const app of panelApps) {
      if (lx + BTN_W > rightLeftEdge - 4) break;
      const panelOpen = (this.manager.activeAppId === app.id);
      // "In use" = the app has live placement/edit state outside of its
      // panel being open (BuildApp.activeItem is the canonical case). We
      // highlight it green so the player can see they're still in placement
      // mode even after the panel auto-closed.
      const inUse = !panelOpen && typeof app.isInUse === 'function' && !!app.isInUse();
      const active = panelOpen || inUse;
      const locked = this.manager.isLockedNow(app);
      // Panel-open uses the standard orange; in-use uses a clearly distinct
      // green so the two states read differently at a glance.
      const bg = panelOpen ? 0xffb84d : (inUse ? 0x4a9e5c : 0x3d2d5c);
      this._drawButton(g, lx, 8, BTN_W, this.height - 16, {
        label: app.icon, sub: app.title,
        bg,
        key: `app:${app.id}`,
        textColor: active ? '#1a1428' : '#ffffff',
        dim: locked,
        notify: this._appNotifies(app, sim),
      }, usedTexts);
      if (!locked) {
        this._bindZone(`app:${app.id}`, lx, 8, BTN_W, this.height - 16,
          () => this._onLauncherClick(app), usedZones);
      }
      lx += BTN_W + BTN_GAP;
    }

    this._hideUnusedText(usedTexts);
    this._disableUnusedZones(usedZones);
  }

  _drawButton(g, x, y, w, h, opts, used) {
    if (g) {
      g.fillStyle(0x000000, 0.25);
      g.fillRoundedRect(x + 1, y + 2, w, h, 6);
      g.fillStyle(opts.bg, 1);
      g.fillRoundedRect(x, y, w, h, 6);
      g.lineStyle(2, 0x2a1a1a, 0.6);
      g.strokeRoundedRect(x, y, w, h, 6);
      // Dim overlay for locked buttons — keeps the icon and label in place
      // so the bar layout doesn't shift between phases.
      if (opts.dim) {
        g.fillStyle(0x1a1428, 0.55);
        g.fillRoundedRect(x, y, w, h, 6);
      }
      // Notification dot in the top-right corner. Drawn over the dim overlay
      // so a locked-but-needs-attention app still shows it.
      if (opts.notify) {
        const cx = x + w - 6, cy = y + 6, rad = 5;
        g.fillStyle(0x000000, 0.5); g.fillCircle(cx + 1, cy + 1, rad + 1);
        g.fillStyle(0xff3a3a, 1);   g.fillCircle(cx, cy, rad);
        g.lineStyle(1.5, 0xffffff, 0.9); g.strokeCircle(cx, cy, rad);
      }
    }
    // Center label horizontally using a 0.5 origin so icons and short labels
    // sit cleanly inside the button regardless of width.
    const labelKey = `btn:${opts.key}:label`;
    used.add(labelKey);
    const lbl = this._addText(labelKey, opts.label, x + w / 2, y + 4, {
      font: 'bold 14px system-ui', color: opts.textColor || '#ffffff',
    });
    if (lbl && lbl.setOrigin) lbl.setOrigin(0.5, 0);
    if (opts.sub) {
      const subKey = `btn:${opts.key}:sub`;
      used.add(subKey);
      // Sub-label always white — the active-state textColor (dark on orange)
      // is for the icon's contrast on the highlighted background; the small
      // title underneath stays light so it remains legible at 9px.
      const s = this._addText(subKey, opts.sub, x + w / 2, y + 24, {
        font: '9px system-ui', color: '#ffffff',
      });
      if (s && s.setOrigin) s.setOrigin(0.5, 0);
    }
  }

  /** Get or create a persistent zone keyed by `key`, position it, rebind
   *  the click handler. Critical for click reliability — destroying zones
   *  every frame caused Phaser to drop clicks that landed on a zone in
   *  flight. */
  _bindZone(key, x, y, w, h, onClick, used) {
    if (!this.scene.add || !this.scene.add.zone) return null;
    used.add(key);
    let z = this._zonePool.get(key);
    if (!z) {
      z = this.scene.add.zone(x, y, w, h);
      if (z.setOrigin)      z.setOrigin(0, 0);
      if (z.setInteractive) z.setInteractive({ useHandCursor: true });
      if (z.setDepth)       z.setDepth(960);
      this._zonePool.set(key, z);
    } else {
      if (z.setPosition) z.setPosition(x, y);
      if (z.setSize)     z.setSize(w, h);
      if (z.input && z.input.hitArea && typeof z.input.hitArea.setSize === 'function') {
        z.input.hitArea.setSize(w, h);
      }
      if (z.setVisible)        z.setVisible(true);
      if (z.setInteractive && (!z.input || !z.input.enabled)) {
        z.setInteractive({ useHandCursor: true });
      }
    }
    // Rebind: clear previous listener, attach the new one. Wrap so the
    // AppManager knows this pointerdown was consumed by a UI Zone — keeps
    // the scene-level pointerdown from falling through to grid logic. See
    // AppManager._zoneClickInFlight for the full rationale.
    if (z.removeAllListeners) z.removeAllListeners('pointerdown');
    const mgr = this.manager;
    const wrapped = mgr
      ? (pointer, localX, localY, evt) => { mgr._zoneClickInFlight = true; onClick(pointer, localX, localY, evt); }
      : onClick;
    if (z.on) z.on('pointerdown', wrapped);
    return z;
  }

  _disableUnusedZones(used) {
    for (const [key, z] of this._zonePool.entries()) {
      if (used.has(key)) continue;
      if (z.disableInteractive) z.disableInteractive();
      if (z.setVisible) z.setVisible(false);
    }
  }

  /** Safely call app.notification(sim) — apps may not define it. */
  _appNotifies(app, sim) {
    if (!app || typeof app.notification !== 'function') return false;
    try { return !!app.notification(sim); } catch (_) { return false; }
  }

  // Launcher click for panel apps. When the panel is closed but the app
  // is "in use" (e.g. BuildApp has activeItem armed), prefer cancelling
  // that state over re-opening the panel — clicking the button is the
  // user's natural "exit" gesture.
  _onLauncherClick(app) {
    const panelOpen = (this.manager.activeAppId === app.id);
    const inUse = typeof app.isInUse === 'function' && !!app.isInUse();
    if (!panelOpen && inUse && typeof app.cancelInUse === 'function') {
      app.cancelInUse();
      return;
    }
    this.manager.toggle(app.id);
  }

  _cycleSpeed(sim) {
    if (!sim) return;
    const levels = (typeof CONFIG !== 'undefined' && CONFIG.speedLevels) || [1, 2, 4];
    const i = levels.indexOf(sim._uiSpeed || 1);
    sim._uiSpeed = levels[(i + 1) % levels.length];
  }

  describe(sim) {
    return {
      height: this.height,
      widgets: this.manager.widgets.map(w =>
        typeof w.describe === 'function' ? w.describe(sim) : { id: w.id }
      ),
      panelApps: this.manager.appOrder
        .filter(a => a.hasPanel && a.id !== 'game_over')
        .map(a => ({
          id: a.id, icon: a.icon, title: a.title,
          active: this.manager.activeAppId === a.id,
          inUse: typeof a.isInUse === 'function' ? !!a.isInUse() : false,
          notify: this._appNotifies(a, sim),
        })),
      mapTools: this.manager.appOrder
        .filter(a => !a.hasPanel)
        .map(a => ({
          id: a.id, icon: a.icon, title: a.title,
          active: this.manager.activeMapToolId === a.id,
          notify: this._appNotifies(a, sim),
        })),
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TopBar };
}
