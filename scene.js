/* ============================================================================
 * scene.js  —  Phaser-specific integration
 * ============================================================================
 * Contains:
 *   - Sidebar: UI built from real Phaser interactive Zones + Text objects
 *   - GameScene: the Phaser.Scene that owns the Graphics stack, ticks the
 *                simulation, y-sorts drawables, and routes grid-area input
 *   - Phaser.Game bootstrap
 *
 * This is the only file that references Phaser.* or mounts the canvas. It
 * imports Simulation from game.js and Sprites + iso helpers from sprites.js.
 * Must load after both.
 */

/* ============================================================================
 * Sidebar — built from real Phaser interactive objects
 * ============================================================================
 * Every clickable region is a Phaser Zone with setInteractive(), so hit
 * testing, cursor styling, and event routing are native. The Graphics layer
 * only paints backgrounds; Text objects handle all labels. refresh() re-skins
 * the buttons each frame (money affordability flips during play).
 */
class Sidebar {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim   = sim;
    this.tool  = null;        // active tool id (null = no placement)
    this.speed = 1;           // simulation speed multiplier (1/2/4)

    this.toolBtns    = [];    // { def, rect, bg, iconG, label, cost, hit }
    this.trafficBtns = [];    // { mult, idx, rect, bg, label, hit }
    this.pauseBtn    = null;
    this.speedBtn    = null;

    this._build();
    this.refresh();
  }

  _build() {
    const scene = this.scene;
    const sbX   = GAME_W - UI_W;
    const bx    = sbX + 14;
    const bw    = UI_W - 28;

    // --- Static panel background (drawn once) ---
    const staticG = scene.add.graphics();
    staticG.fillStyle(COLORS.uiBg, 1);
    staticG.fillRect(sbX, 0, UI_W, GAME_H);
    staticG.fillStyle(0x6b5ba8, 1);
    staticG.fillRect(sbX, 0, 3, GAME_H);

    // --- Title + subtitle ---
    scene.add.text(sbX + 14, 8, '🍴 Chow Time', {
      font: 'bold 22px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 3,
    });
    scene.add.text(sbX + 14, 34, 'Seat · Order · Cook · Serve · Clean', {
      font: 'italic 11px system-ui', color: '#c0b0e0',
    });

    // --- Dynamic layer (button bodies; cleared each refresh) ---
    this.dynG = scene.add.graphics();

    // --- Tool buttons ---
    const btnH = 40, gap = 5;
    let by = TOP_H + 50;
    const defs = [
      { id: 'stove',  label: 'Stove',     cost: CONFIG.costs.stove,    color: 0x3a3a42, hint: 'cooks food' },
      { id: 'table',  label: 'Table',     cost: CONFIG.costs.table,    color: 0x8b5a2b, hint: 'holds plate' },
      { id: 'chair',  label: 'Chair',     cost: CONFIG.costs.chair,    color: 0x6a4a2a, hint: 'seat, needs table' },
      { id: 'sink',   label: 'Sink',      cost: CONFIG.costs.sink,     color: 0x5fa8d3, hint: 'washes plates' },
      { id: 'remove', label: 'Remove',    cost: 0,                     color: 0x663333, hint: 'right-click' },
      { id: 'hire',   label: 'Hire Cook', cost: CONFIG.costs.employee, color: 0x4a90e2, hint: 'one more worker' },
    ];
    for (const def of defs) {
      const rect = { x: bx, y: by, w: bw, h: btnH };
      this.toolBtns.push(this._makeToolBtn(def, rect));
      by += btnH + gap;
    }

    // --- Traffic segmented bar ---
    const tfY = by + 18, tfH = 36;
    scene.add.text(bx, tfY - 16, '🌊 Traffic', {
      font: 'bold 13px system-ui', color: '#ffffff',
    });
    const segW = (bw - (CONFIG.trafficLevels.length - 1) * 4) / CONFIG.trafficLevels.length;
    CONFIG.trafficLevels.forEach((mult, i) => {
      const rect = { x: bx + i * (segW + 4), y: tfY, w: segW, h: tfH };
      this.trafficBtns.push(this._makeTrafficBtn(mult, i, rect));
    });

    // --- Pause + speed controls ---
    const psY  = tfY + tfH + 16;
    const halfW = (bw - 6) / 2;
    this.pauseBtn = this._makeControlBtn(
      { x: bx, y: psY, w: halfW, h: 34 },
      () => this.sim.spawnEnabled ? '⏸ Pause' : '▶ Resume',
      () => this.sim.spawnEnabled ? 0x3d2d5c : 0x5a3d2d,
      () => { this.sim.spawnEnabled = !this.sim.spawnEnabled; }
    );
    this.speedBtn = this._makeControlBtn(
      { x: bx + halfW + 6, y: psY, w: halfW, h: 34 },
      () => `⏩ ${this.speed}×`,
      () => 0x3d2d5c,
      () => {
        const levels = CONFIG.speedLevels;
        const i = levels.indexOf(this.speed);
        this.speed = levels[(i + 1) % levels.length];
      }
    );

    // --- Orders panel ---
    const oy = psY + 44;
    scene.add.text(bx, oy, '📋 Orders in flight', {
      font: 'bold 13px system-ui', color: '#ffffff',
    });
    // Static panel frame
    const panelG = scene.add.graphics();
    panelG.fillStyle(COLORS.uiPanel, 1);
    panelG.fillRoundedRect(sbX + 12, oy + 14, UI_W - 24, 70, 6);
    panelG.lineStyle(2, COLORS.outline, 0.5);
    panelG.strokeRoundedRect(sbX + 12, oy + 14, UI_W - 24, 70, 6);
    this.ordersText = scene.add.text(bx, oy + 20, '', {
      font: '11px monospace', color: '#c0b0e0',
    });

    // --- Top-of-screen readouts ---
    this.moneyText = scene.add.text(14, 12, '', {
      font: 'bold 24px system-ui', color: '#ffd84d', stroke: '#000', strokeThickness: 3,
    });
    this.statsText = scene.add.text(220, 18, '', {
      font: 'bold 13px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 2,
    });
    this.tipText = scene.add.text(12, GAME_H - BOT_H + 8, '', {
      font: '12px monospace', color: '#c0b0e0',
    });
  }

  _makeToolBtn(def, rect) {
    const scene = this.scene;
    const label = scene.add.text(rect.x + 10, rect.y + 5, def.label, {
      font: 'bold 13px system-ui', color: '#ffffff',
    });
    const cost = scene.add.text(rect.x + 10, rect.y + 22, '', {
      font: '10px system-ui', color: '#c0b0e0',
    });
    const hit = scene.add.zone(rect.x, rect.y, rect.w, rect.h)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => {
      if (def.id === 'hire') this.sim.hireEmployee();
      else this.tool = (this.tool === def.id) ? null : def.id;
    });
    return { def, rect, label, cost, hit };
  }

  _makeTrafficBtn(mult, idx, rect) {
    const scene = this.scene;
    const label = scene.add.text(
      rect.x + rect.w / 2, rect.y + rect.h / 2, `${mult}×`,
      { font: 'bold 16px system-ui', color: '#ffffff' }
    ).setOrigin(0.5, 0.5);
    const hit = scene.add.zone(rect.x, rect.y, rect.w, rect.h)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => { this.sim.trafficMultiplier = mult; });
    return { mult, idx, rect, label, hit };
  }

  _makeControlBtn(rect, textFn, colorFn, onClick) {
    const scene = this.scene;
    const label = scene.add.text(
      rect.x + rect.w / 2, rect.y + rect.h / 2, '',
      { font: 'bold 15px system-ui', color: '#ffffff' }
    ).setOrigin(0.5, 0.5);
    const hit = scene.add.zone(rect.x, rect.y, rect.w, rect.h)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', onClick);
    return { rect, label, textFn, colorFn, hit };
  }

  /* Re-skin all backgrounds and update text. Called once per frame from
     GameScene.update — cheap, and handles "can't afford" indicator flips. */
  refresh() {
    const g = this.dynG; g.clear();
    const sim = this.sim;

    // Tool buttons
    for (const tb of this.toolBtns) {
      const { def, rect, label, cost } = tb;
      const selected = this.tool === def.id;
      g.fillStyle(0x000000, 0.25);
      g.fillRoundedRect(rect.x + 2, rect.y + 3, rect.w, rect.h, 6);
      g.fillStyle(selected ? COLORS.uiSelected : COLORS.uiPanel, 1);
      g.fillRoundedRect(rect.x, rect.y, rect.w, rect.h, 6);
      g.lineStyle(2, COLORS.outline, 0.6);
      g.strokeRoundedRect(rect.x, rect.y, rect.w, rect.h, 6);
      // Icon swatch
      g.fillStyle(def.color, 1);
      g.fillRoundedRect(rect.x + rect.w - 36, rect.y + 6, 28, 28, 4);
      g.lineStyle(2, COLORS.outline, 1);
      g.strokeRoundedRect(rect.x + rect.w - 36, rect.y + 6, 28, 28, 4);
      label.setColor(selected ? '#1a1428' : '#ffffff');
      let costStr = '';
      if (def.cost > 0) {
        costStr = `$${def.cost}`;
        if (sim.money < def.cost) costStr += ' ❌';
      } else if (def.hint) costStr = def.hint;
      cost.setText(costStr);
      cost.setColor(selected ? '#1a1428' : '#c0b0e0');
    }

    // Traffic bar
    for (const tb of this.trafficBtns) {
      const { mult, idx, rect, label } = tb;
      const selected = sim.trafficMultiplier === mult;
      g.fillStyle(0x000000, 0.25);
      g.fillRoundedRect(rect.x + 2, rect.y + 3, rect.w, rect.h, 5);
      const base = selected ? COLORS.trafficRamp[idx] : 0x3d2d5c;
      g.fillStyle(base, 1);
      g.fillRoundedRect(rect.x, rect.y, rect.w, rect.h, 5);
      g.lineStyle(2, COLORS.outline, selected ? 1 : 0.5);
      g.strokeRoundedRect(rect.x, rect.y, rect.w, rect.h, 5);
      label.setColor(selected ? '#ffffff' : '#c0b0e0');
    }

    // Pause + speed
    for (const cb of [this.pauseBtn, this.speedBtn]) {
      const { rect, label, textFn, colorFn } = cb;
      g.fillStyle(0x000000, 0.25);
      g.fillRoundedRect(rect.x + 2, rect.y + 3, rect.w, rect.h, 5);
      g.fillStyle(colorFn(), 1);
      g.fillRoundedRect(rect.x, rect.y, rect.w, rect.h, 5);
      g.lineStyle(2, COLORS.outline, 0.6);
      g.strokeRoundedRect(rect.x, rect.y, rect.w, rect.h, 5);
      label.setText(textFn());
    }

    // Readouts
    const live = sim.customers.filter(c => c.alive).length;
    this.moneyText.setText(`$${sim.money}`);
    this.statsText.setText(
      `😊 ${sim.stats.served}  😡 ${sim.stats.angry}  🍽 ${sim.stats.plates}  ·  ` +
      `waiting ${live}  cooks ${sim.employees.length}  ${Math.floor(sim.time)}s  ·  ` +
      `🌊 ${sim.trafficMultiplier}×`
    );
    const oc = sim.orderCountsByStatus();
    this.ordersText.setText(
      `pending    ${oc.pending}\ncooking    ${oc.cooking}\nready      ${oc.ready}`
    );
    const tip = this.tool
      ? `🔨 Tool: ${this.tool} — click a tile. Right-click removes.`
      : `Click a tool on the right. Right-click any tile to remove.`;
    this.tipText.setText(tip);
  }
}


/* ============================================================================
 * GameScene — thin orchestrator
 * ============================================================================
 * Wires the sim to Phaser: advances time, y-sorts drawables, and delegates
 * every visual to SPRITES. Owns the 4-layer Graphics stack, the text pool,
 * and the cursor/placement input for the grid area.
 */
class GameScene extends Phaser.Scene {
  constructor() { super('game'); }

  create() {
    this.sim = new Simulation();
    this.sim.seedDemo();

    // --- Graphics layers, bottom to top ---
    this.gFloor   = this.add.graphics();     // static: tiles + door
    this.gObjects = this.add.graphics();     // dynamic: buildings + entities
    this.gOverlay = this.add.graphics();     // dynamic: bubbles, bars, arcs, hover

    // Paint the floor exactly once.
    Sprites.floorAndDoor(this.gFloor, this.sim);

    // --- Text pool (stable keys, reused across frames) ---
    this._texts = new Map();
    this._frame = 0;

    // --- Sidebar owns UI state (this.sidebar.tool, this.sidebar.speed) ---
    this.sidebar = new Sidebar(this, this.sim);

    // --- Build the view context passed to every sprite call ---
    this._view = {
      g:       this.gObjects,
      overlay: this.gOverlay,
      time:    0,
      grid:    this.sim.grid,
      getText: (k, s, x, y, st) => this._getText(k, s, x, y, st),
    };

    // --- Hover state (for the placement preview diamond) ---
    this.hover = null;

    // --- Input: only the grid area. Sidebar zones handle themselves. ---
    this.input.mouse.disableContextMenu();
    this.input.on('pointermove', p => this._onPointerMove(p));
    this.input.on('pointerdown', p => this._onPointerDown(p));
  }

  update(_, dtMs) {
    const dt = Math.min(dtMs / 1000, 0.1) * this.sidebar.speed;
    this.sim.update(dt);
    this._frame++;

    this._view.time = this.sim.time;

    this._drawScene();
    this.sidebar.refresh();
    this._cullTexts();
  }

  /* ---- Input ---- */
  _onPointerMove(p) {
    if (p.x >= GAME_W - UI_W) { this.hover = null; return; }
    const tile = screenToTile(p.x, p.y);
    if (!tile) { this.hover = null; return; }
    this.hover = { x: tile.x, y: tile.y, valid: this._isToolValidAt(tile.x, tile.y) };
  }
  _onPointerDown(p) {
    // Sidebar clicks are handled by the interactive Zones inside Sidebar.
    if (p.x >= GAME_W - UI_W) return;
    const tile = screenToTile(p.x, p.y); if (!tile) return;
    if (p.rightButtonDown()) { this.sim.removeBuildingAt(tile.x, tile.y); return; }
    const tool = this.sidebar.tool;
    if (!tool) return;
    if (tool === 'remove') this.sim.removeBuildingAt(tile.x, tile.y);
    else if (['stove','table','chair','sink'].includes(tool)) this.sim.placeBuilding(tool, tile.x, tile.y);
  }
  _isToolValidAt(x, y) {
    const tool = this.sidebar.tool;
    if (!tool) return false;
    const t = this.sim.grid.getTile(x, y); if (!t) return false;
    if (tool === 'remove') return !!t.building;
    if (t.building) return false;
    if (t.type === 'spawn') return false;
    return true;
  }

  /* ---- Main draw pass: y-sort everything, delegate to SPRITES ---- */
  _drawScene() {
    this.gObjects.clear();
    this.gOverlay.clear();

    const view = this._view;

    // Collect drawables with a y-sort key (further-back first).
    const items = [];
    for (const b of this.sim.buildings) {
      const { sx, sy } = gridToScreen(b.x, b.y);
      // -0.1 bias so entities on the SAME tile render *after* the building.
      items.push({ sortY: sy - 0.1, kind: 'b', ref: b, sx, sy });
    }
    for (const c of this.sim.customers) {
      const { sx, sy } = gridToScreen(c.x, c.y);
      items.push({ sortY: sy, kind: 'c', ref: c, sx, sy });
    }
    for (const e of this.sim.employees) {
      const { sx, sy } = gridToScreen(e.x, e.y);
      items.push({ sortY: sy, kind: 'e', ref: e, sx, sy });
    }
    items.sort((a, b) => a.sortY - b.sortY);

    for (const it of items) {
      if (it.kind === 'b') {
        const b = it.ref;
        // Subtle pop-in bounce when freshly placed (first 250ms of sim time).
        const age = this.sim.time - b.placedAt;
        const bounce = age < 0.25 ? -Math.sin((age / 0.25) * Math.PI) * 4 : 0;
        const sy = it.sy + bounce;
        if      (b.type === 'stove') Sprites.stove(view, b, it.sx, sy);
        else if (b.type === 'table') Sprites.table(view, b, it.sx, sy);
        else if (b.type === 'chair') Sprites.chair(view, b, it.sx, sy);
        else if (b.type === 'sink')  Sprites.sink (view, b, it.sx, sy);
      } else if (it.kind === 'c') {
        Sprites.customer(view, it.ref, it.sx, it.sy);
      } else {
        Sprites.employee(view, it.ref, it.sx, it.sy);
      }
    }

    // Hover preview
    if (this.sidebar.tool && this.hover) {
      const { sx, sy } = gridToScreen(this.hover.x, this.hover.y);
      Sprites.hoverDiamond(view, sx, sy, this.hover.valid);
    }

    // Door label (pooled text)
    const sp = this.sim.spawnTile;
    const { sx, sy } = gridToScreen(sp.x, sp.y);
    this._getText('door', 'DOOR', sx, sy, {
      fontFamily: 'system-ui', fontSize: '10px', fontStyle: 'bold', color: '#1a3a0a',
    });
  }

  /* ---- Text pool: borrow-or-create; destroy after prolonged absence ---- */
  _getText(key, str, x, y, style) {
    let t = this._texts.get(key);
    if (!t) {
      t = this.add.text(x, y, str, style);
      t.setOrigin(0.5, 0.5);
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
      // Hide immediately; destroy after ~2s of inactivity to keep pool bounded.
      t.setVisible(false);
      if (this._frame - (t._seenFrame || 0) > 120) {
        t.destroy();
        this._texts.delete(k);
      }
    }
  }
}


/* ============================================================================
 * Bootstrap
 * ============================================================================ */
new Phaser.Game({
  type: Phaser.AUTO,
  width: GAME_W,
  height: GAME_H,
  backgroundColor: '#1a1428',
  parent: 'game',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: GameScene,
  render: { pixelArt: false, antialias: true },
});
