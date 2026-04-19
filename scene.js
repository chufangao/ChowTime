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

// Tools that physically alter the restaurant layout. Gated so the player
// can only rearrange between days (sim.dayState === 'dayEnd').
const LAYOUT_TOOLS = ['stove', 'table', 'chair', 'sink', 'move', 'remove'];

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
    const btnH = 34, gap = 4;
    let by = TOP_H + 44;
    const defs = [
      { id: 'stove',  label: 'Stove',     cost: CONFIG.costs.stove,    color: 0x3a3a42, hint: 'cooks food' },
      { id: 'table',  label: 'Table',     cost: CONFIG.costs.table,    color: 0x8b5a2b, hint: 'holds plate' },
      { id: 'chair',  label: 'Chair',     cost: CONFIG.costs.chair,    color: 0x6a4a2a, hint: 'seat, needs table' },
      { id: 'sink',   label: 'Sink',      cost: CONFIG.costs.sink,     color: 0x5fa8d3, hint: 'washes plates' },
      { id: 'move',   label: 'Move',      cost: 0,                     color: 0xd9a14a, hint: 'pick → place' },
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

    // --- Speed control (full width; Pause was removed — the game already
    //     pauses naturally during the day-end review). ---
    const psY  = tfY + tfH + 16;
    this.speedBtn = this._makeControlBtn(
      { x: bx, y: psY, w: bw, h: 34 },
      () => `⏩ Speed ${this.speed}×`,
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
      font: 'bold 22px system-ui', color: '#ffd84d', stroke: '#000', strokeThickness: 3,
    });
    this.livesText = scene.add.text(110, 14, '', {
      font: 'bold 18px system-ui', color: '#ff6b6b', stroke: '#000', strokeThickness: 3,
    });
    this.dayText = scene.add.text(200, 18, '', {
      font: 'bold 14px system-ui', color: '#9be8ff', stroke: '#000', strokeThickness: 3,
    });
    this.statsText = scene.add.text(370, 18, '', {
      font: 'bold 12px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 2,
    });
    this.tipText = scene.add.text(12, GAME_H - BOT_H + 8, '', {
      font: '12px monospace', color: '#c0b0e0',
    });
  }

  _makeToolBtn(def, rect) {
    const scene = this.scene;
    const label = scene.add.text(rect.x + 10, rect.y + 3, def.label, {
      font: 'bold 12px system-ui', color: '#ffffff',
    });
    const cost = scene.add.text(rect.x + 10, rect.y + 18, '', {
      font: '9px system-ui', color: '#c0b0e0',
    });
    const hit = scene.add.zone(rect.x, rect.y, rect.w, rect.h)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => {
      if (def.id === 'hire') {
        // Route through the recruit modal; the scene wires it at create time.
        if (this.scene.recruitModal) this.scene.recruitModal.open();
        return;
      }
      // Layout tools are locked mid-shift so the player can't rearrange
      // underneath live customers. Silently ignore the click.
      if (LAYOUT_TOOLS.includes(def.id) && this.sim.dayState !== 'dayEnd') return;
      this.tool = (this.tool === def.id) ? null : def.id;
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
    const layoutLocked = sim.dayState !== 'dayEnd';
    for (const tb of this.toolBtns) {
      const { def, rect, label, cost } = tb;
      const isLayout = LAYOUT_TOOLS.includes(def.id);
      const disabled = isLayout && layoutLocked;
      const selected = this.tool === def.id && !disabled;
      g.fillStyle(0x000000, 0.25);
      g.fillRoundedRect(rect.x + 2, rect.y + 3, rect.w, rect.h, 6);
      const fill = disabled ? 0x2a2233 : (selected ? COLORS.uiSelected : COLORS.uiPanel);
      g.fillStyle(fill, disabled ? 0.7 : 1);
      g.fillRoundedRect(rect.x, rect.y, rect.w, rect.h, 6);
      g.lineStyle(2, COLORS.outline, disabled ? 0.3 : 0.6);
      g.strokeRoundedRect(rect.x, rect.y, rect.w, rect.h, 6);
      // Icon swatch — dimmed when disabled.
      g.fillStyle(def.color, disabled ? 0.35 : 1);
      g.fillRoundedRect(rect.x + rect.w - 32, rect.y + 5, 24, 24, 4);
      g.lineStyle(2, COLORS.outline, disabled ? 0.4 : 1);
      g.strokeRoundedRect(rect.x + rect.w - 32, rect.y + 5, 24, 24, 4);
      label.setColor(disabled ? '#6a5a8a' : (selected ? '#1a1428' : '#ffffff'));
      let costStr = '';
      if (disabled) {
        costStr = 'between days only';
      } else if (def.cost > 0) {
        costStr = `$${def.cost}`;
        if (sim.money < def.cost) costStr += ' ❌';
      } else if (def.hint) costStr = def.hint;
      cost.setText(costStr);
      cost.setColor(disabled ? '#6a5a8a' : (selected ? '#1a1428' : '#c0b0e0'));
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

    // Speed
    {
      const { rect, label, textFn, colorFn } = this.speedBtn;
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
    // Lives as literal hearts so a glance reads the state without parsing.
    let hearts = '';
    for (let i = 0; i < sim.livesMax; i++) hearts += i < sim.lives ? '❤️' : '🖤';
    this.livesText.setText(hearts);
    let dayLine;
    if (sim.dayState === 'spawning') {
      dayLine = `Day ${sim.day}  ·  ${sim.daySpawned}/${sim.dayQuota}`;
    } else if (sim.dayState === 'draining') {
      dayLine = `Day ${sim.day}  ·  wrapping up (${live} left)`;
    } else {
      dayLine = `Day ${sim.day} done — review & Start Day`;
    }
    this.dayText.setText(dayLine);
    this.statsText.setText(
      `😊 ${sim.stats.served}  😡 ${sim.stats.angry}  🍽 ${sim.stats.plates}  ·  ` +
      `💰 tips $${sim.stats.tipsTotal}  ·  ` +
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
 * RecruitModal — the "Hire Cook" panel
 * ============================================================================
 * Two modes:
 *   - 'list':   scrollable grid of chef cards. Each card shows portrait, name,
 *               cost, and a small ability icon strip. Clicking opens the
 *               chef's detail page.
 *   - 'detail': full bio page for one chef — large portrait, full wrapped bio,
 *               all stat bars, full ability descriptions, Hire + Back buttons.
 *
 * List scrolling is done by mouse wheel: `_scrollRow` shifts the visible
 * window up/down one row at a time. With the 5×2 visible grid this only
 * matters if the roster ever exceeds 10, but the mechanism is in place.
 */
class RecruitModal {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim   = sim;
    this.isOpen = false;
    this._mode  = 'list';              // 'list' | 'detail'
    this._scrollRow = 0;               // list view row offset
    this._selectedEntry = null;        // detail view target (pool entry)
    this._noMoneyFlashUntil = 0;
    this._noMoneyFlashId    = -1;

    // Dynamic Graphics layer (backdrop, panel, stat bars, portraits).
    this._g = scene.add.graphics();
    this._g.setDepth(1000);
    this._g.setVisible(false);

    // Backdrop zone absorbs outside clicks → close. Also receives wheel events
    // while the modal is open so we can scroll the list.
    this._backdrop = scene.add.zone(0, 0, GAME_W, GAME_H)
      .setOrigin(0, 0)
      .setInteractive()
      .setDepth(999);
    this._backdrop.on('pointerdown', (p) => {
      if (!this.isOpen) return;
      if (!this._pointInPanel(p.x, p.y)) this.close();
    });
    this._backdrop.setVisible(false);

    // Wheel scroll: wire once, guard by isOpen + mode. Phaser routes wheel
    // events via scene.input; we filter to pointer-over-panel ourselves.
    scene.input.on('wheel', (pointer, over, dx, dy) => {
      if (!this.isOpen || this._mode !== 'list') return;
      if (!this._pointInPanel(pointer.x, pointer.y)) return;
      const dir = dy > 0 ? 1 : -1;
      const maxRow = Math.max(0, Math.ceil(this.sim.recruitPool.length / this._cols()) - this._rows());
      this._scrollRow = Math.max(0, Math.min(maxRow, this._scrollRow + dir));
    });

    // Texts pool — every Phaser.Text we create goes in here so
    // _setTextsVisible can hide them on close without tracking individually.
    this._texts = [];

    /* ---- List view widgets (titles, card zones, empty label) ---- */
    this._title = this._addLabel(this._panelX() + 20, this._panelY() + 14, 'Recruit a Cook', {
      font: 'bold 20px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 3,
    });
    this._sub = this._addLabel(this._panelX() + 20, this._panelY() + 38, 'Click a chef to view their bio.', {
      font: 'italic 11px system-ui', color: '#c0b0e0',
    });
    this._cashLabel = this._addLabel(this._panelX() + this._panelW() - 20, this._panelY() + 20, '',
      { font: 'bold 14px system-ui', color: '#ffd84d', stroke: '#000', strokeThickness: 2 },
      1, 0);
    this._emptyLabel = this._addLabel(this._panelX() + this._panelW() / 2, this._panelY() + this._panelH() / 2,
      'No more chefs seeking work.',
      { font: 'bold 14px system-ui', color: '#c0b0e0', stroke: '#000', strokeThickness: 2 },
      0.5, 0.5);
    this._scrollHint = this._addLabel(
      this._panelX() + this._panelW() / 2, this._panelY() + this._panelH() - 16, '',
      { font: 'italic 10px system-ui', color: '#8888a0' }, 0.5, 0.5);

    // Close "×" button (top-right of panel) — visible in both modes.
    const closeRect = { x: this._panelX() + this._panelW() - 36, y: this._panelY() + 36, w: 24, h: 24 };
    this._closeRect = closeRect;
    this._closeLabel = this._addLabel(closeRect.x + closeRect.w / 2, closeRect.y + closeRect.h / 2, '×',
      { font: 'bold 20px system-ui', color: '#ffffff' }, 0.5, 0.5);
    this._closeHit = scene.add.zone(closeRect.x, closeRect.y, closeRect.w, closeRect.h)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(1002);
    this._closeHit.on('pointerdown', () => this.close());
    this._closeHit.setVisible(false);

    // Card pool — 5×2 visible. Each card holds a hit zone + text nodes, plus
    // up to 4 ability icon labels so abilities render as emoji badges.
    this._cards = [];
    const grid = this._cardGrid();
    for (let i = 0; i < grid.length; i++) {
      const { x, y, w, h } = grid[i];
      const hit = scene.add.zone(x, y, w, h)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: true })
        .setDepth(1001);
      hit.on('pointerdown', () => this._onCardClick(i));

      const name = this._addLabel(x + 8, y + 82, '', {
        font: 'bold 11px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 2,
      });
      const costLabel = this._addLabel(x + w / 2, y + h - 14, '', {
        font: 'bold 12px system-ui', color: '#ffd84d', stroke: '#000', strokeThickness: 2,
      }, 0.5, 0.5);
      const statLabels = ['DEX','SPD','STR','INT','CHA'].map((k, si) => {
        return this._addLabel(x + 8, y + 102 + si * 12, '', {
          font: 'bold 9px monospace', color: '#ffffff',
        });
      });
      // Ability icon strip along the bottom — up to 4 emojis.
      const abilityIcons = [];
      for (let ai = 0; ai < 4; ai++) {
        abilityIcons.push(this._addLabel(x + 10 + ai * 22, y + h - 34, '', {
          font: 'bold 16px system-ui', color: '#ffe680',
        }));
      }
      this._cards.push({ hit, name, costLabel, statLabels, abilityIcons });
    }

    /* ---- Detail view widgets ---- */
    this._detailName = this._addLabel(this._panelX() + 120, this._panelY() + 16, '', {
      font: 'bold 22px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 3,
    });
    this._detailCost = this._addLabel(this._panelX() + this._panelW() - 72, this._panelY() + 20, '', {
      font: 'bold 18px system-ui', color: '#ffd84d', stroke: '#000', strokeThickness: 2,
    }, 1, 0);
    this._detailBio = this._addLabel(
      this._panelX() + 30, this._panelY() + 256, '',
      { font: 'italic 13px system-ui', color: '#d8d0e8',
        wordWrap: { width: this._panelW() - 60, useAdvancedWrap: true } });
    this._detailStatLabels = ['DEX','SPD','STR','INT','CHA'].map((k, si) => {
      return this._addLabel(this._panelX() + 280, this._panelY() + 84 + si * 26, '', {
        font: 'bold 12px monospace', color: '#ffffff',
      });
    });
    this._detailAbilityHeader = this._addLabel(
      this._panelX() + 30, this._panelY() + 356, 'Abilities',
      { font: 'bold 13px system-ui', color: '#9be8ff', stroke: '#000', strokeThickness: 2 });
    // Up to 4 abilities with icon + name + description block.
    this._detailAbilityRows = [];
    for (let ai = 0; ai < 4; ai++) {
      const icon = this._addLabel(
        this._panelX() + 36, this._panelY() + 382 + ai * 26, '',
        { font: 'bold 18px system-ui', color: '#ffe680' });
      const label = this._addLabel(
        this._panelX() + 62, this._panelY() + 384 + ai * 26, '',
        { font: 'bold 11px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 2,
          wordWrap: { width: this._panelW() - 110, useAdvancedWrap: true } });
      this._detailAbilityRows.push({ icon, label });
    }
    // Hire button.
    const hireRect = { x: this._panelX() + this._panelW() - 170, y: this._panelY() + this._panelH() - 58, w: 140, h: 40 };
    this._hireRect  = hireRect;
    this._hireLabel = this._addLabel(hireRect.x + hireRect.w / 2, hireRect.y + hireRect.h / 2, 'Hire',
      { font: 'bold 16px system-ui', color: '#ffffff' }, 0.5, 0.5);
    this._hireHit = scene.add.zone(hireRect.x, hireRect.y, hireRect.w, hireRect.h)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(1002);
    this._hireHit.on('pointerdown', () => this._onHireClick());
    this._hireHit.setVisible(false);

    // Back button (detail → list).
    const backRect = { x: this._panelX() + 24, y: this._panelY() + this._panelH() - 58, w: 100, h: 40 };
    this._backRect  = backRect;
    this._backLabel = this._addLabel(backRect.x + backRect.w / 2, backRect.y + backRect.h / 2, '← Back',
      { font: 'bold 14px system-ui', color: '#ffffff' }, 0.5, 0.5);
    this._backHit = scene.add.zone(backRect.x, backRect.y, backRect.w, backRect.h)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(1002);
    this._backHit.on('pointerdown', () => { this._mode = 'list'; });
    this._backHit.setVisible(false);

    this._hideAll();
    this._setZonesActive(false);

    scene.input.keyboard.on('keydown-ESC', () => {
      if (!this.isOpen) return;
      if (this._mode === 'detail') this._mode = 'list';
      else this.close();
    });
  }

  _setZonesActive(active) {
    const toggle = (z) => active ? z.setInteractive() : z.disableInteractive();
    toggle(this._backdrop);
    toggle(this._closeHit);
    toggle(this._hireHit);
    toggle(this._backHit);
    for (const c of this._cards) toggle(c.hit);
  }

  /* ---- Geometry ---- */
  _panelW() { return 820; }
  _panelH() { return 560; }
  _panelX() { return Math.floor((GAME_W - this._panelW()) / 2); }
  _panelY() { return Math.floor((GAME_H - this._panelH()) / 2); }
  _pointInPanel(x, y) {
    return x >= this._panelX() && x <= this._panelX() + this._panelW()
        && y >= this._panelY() && y <= this._panelY() + this._panelH();
  }
  _cols() { return 5; }
  _rows() { return 2; }
  _cardGrid() {
    const cols = this._cols(), rows = this._rows();
    const cardW = 150, cardH = 200;
    const gap = 12;
    const totalW = cols * cardW + (cols - 1) * gap;
    const startX = this._panelX() + Math.floor((this._panelW() - totalW) / 2);
    const startY = this._panelY() + 72;
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({
          x: startX + c * (cardW + gap),
          y: startY + r * (cardH + gap),
          w: cardW, h: cardH,
        });
      }
    }
    return out;
  }

  /* ---- Label helpers ---- */
  _addLabel(x, y, str, style, ox = 0, oy = 0) {
    const t = this.scene.add.text(x, y, str, style).setOrigin(ox, oy).setDepth(1002);
    t.setVisible(false);
    this._texts.push(t);
    return t;
  }
  _hideAll() {
    for (const t of this._texts) t.setVisible(false);
    for (const c of this._cards) c.hit.setVisible(false);
    this._hireHit.setVisible(false);
    this._backHit.setVisible(false);
    this._closeHit.setVisible(false);
  }

  /* ---- Open / close / mode ---- */
  open() {
    this.isOpen = true;
    this._mode = 'list';
    this._scrollRow = 0;
    this._g.setVisible(true);
    this._backdrop.setVisible(true);
    this._setZonesActive(true);
    this.render();
  }
  close() {
    this.isOpen = false;
    this._g.setVisible(false);
    this._g.clear();
    this._backdrop.setVisible(false);
    this._hideAll();
    this._setZonesActive(false);
  }

  /* ---- Click handlers ---- */
  _onCardClick(cardIdx) {
    // Translate card slot → pool index (accounting for scroll) and open detail.
    const poolIdx = cardIdx + this._scrollRow * this._cols();
    const entry = this.sim.recruitPool[poolIdx];
    if (!entry) return;
    this._selectedEntry = entry;
    this._mode = 'detail';
  }
  _onHireClick() {
    const entry = this._selectedEntry;
    if (!entry) return;
    const res = this.sim.hireFromRoster(entry.id);
    if (res.ok) {
      // Back to list; the hired entry has been spliced from the pool.
      this._selectedEntry = null;
      this._mode = 'list';
      // If the list is now empty, closing is the kind choice.
      if (this.sim.recruitPool.length === 0) this.close();
    } else if (res.reason === 'no-money') {
      this._noMoneyFlashUntil = this.sim.time + 0.6;
    }
  }

  /* ---- Per-frame draw ---- */
  render() {
    if (!this.isOpen) return;
    this._hideAll();          // baseline; per-mode sections re-enable
    const g = this._g; g.clear();

    // Dim backdrop.
    g.fillStyle(0x000000, 0.55); g.fillRect(0, 0, GAME_W, GAME_H);

    // Panel shell — shared by both modes.
    const px = this._panelX(), py = this._panelY();
    const pw = this._panelW(), ph = this._panelH();
    g.fillStyle(COLORS.uiBg, 1);     g.fillRoundedRect(px, py, pw, ph, 10);
    g.lineStyle(3, 0x6b5ba8, 1);     g.strokeRoundedRect(px, py, pw, ph, 10);

    // Close × frame.
    const cr = this._closeRect;
    g.fillStyle(0x3d2d5c, 1); g.fillRoundedRect(cr.x, cr.y, cr.w, cr.h, 4);
    g.lineStyle(2, COLORS.outline, 0.8); g.strokeRoundedRect(cr.x, cr.y, cr.w, cr.h, 4);
    this._closeLabel.setVisible(true);
    this._closeHit.setVisible(true);

    if (this._mode === 'list') this._renderList(g);
    else                       this._renderDetail(g);
  }

  _renderList(g) {
    const px = this._panelX(), py = this._panelY();
    const pw = this._panelW();
    // Header divider + cash readout + title strip.
    g.fillStyle(0x6b5ba8, 1); g.fillRect(px, py + 58, pw, 2);
    this._title.setVisible(true);
    this._sub.setVisible(true);
    this._cashLabel.setText(`Cash: $${this.sim.money}`);
    this._cashLabel.setVisible(true);

    const pool = this.sim.recruitPool;
    if (pool.length === 0) {
      this._emptyLabel.setVisible(true);
      return;
    }

    const cols = this._cols(), rows = this._rows();
    const startIdx = this._scrollRow * cols;
    const maxRow = Math.max(0, Math.ceil(pool.length / cols) - rows);
    if (this._scrollRow > maxRow) this._scrollRow = maxRow;
    const canScroll = pool.length > cols * rows;
    if (canScroll) {
      this._scrollHint.setText(
        this._scrollRow < maxRow || this._scrollRow > 0
          ? `row ${this._scrollRow + 1}/${maxRow + 1} — scroll to see more`
          : ''
      );
      this._scrollHint.setVisible(true);
    }

    for (let i = 0; i < this._cards.length; i++) {
      const card = this._cards[i];
      const entry = pool[startIdx + i];
      if (!entry) continue;

      const rect = card.hit;
      const x = rect.x, y = rect.y;
      const w = rect.width, h = rect.height;

      // Card body.
      g.fillStyle(COLORS.uiPanel, 1);
      g.fillRoundedRect(x, y, w, h, 8);
      g.lineStyle(2, COLORS.outline, 0.7);
      g.strokeRoundedRect(x, y, w, h, 8);

      // Portrait slot.
      g.fillStyle(0x231a30, 1);
      g.fillRoundedRect(x + 10, y + 8, w - 20, 64, 6);
      g.lineStyle(1.5, COLORS.outline, 0.5);
      g.strokeRoundedRect(x + 10, y + 8, w - 20, 64, 6);
      Sprites.chefPortrait(g, entry, x + w / 2, y + 34);

      // Name (bio omitted from card — see detail page).
      card.name.setText(entry.name);
      card.name.setVisible(true);

      // Stat bars (compact: 5 rows at 12px pitch).
      const keys = ['dex', 'spd', 'str', 'int', 'cha'];
      const upper = ['DEX', 'SPD', 'STR', 'INT', 'CHA'];
      for (let si = 0; si < 5; si++) {
        const v = entry[keys[si]];
        card.statLabels[si].setText(`${upper[si]} ${v}`);
        card.statLabels[si].setVisible(true);
        Sprites.statBar(g, x + 52, y + 108 + si * 12, w - 60, 6, v, 10);
      }

      // Ability icon badges.
      const abilities = (entry.abilities || []).map(id => ABILITIES[id]).filter(Boolean);
      for (let ai = 0; ai < card.abilityIcons.length; ai++) {
        const ic = card.abilityIcons[ai];
        const a = abilities[ai];
        if (a) { ic.setText(a.icon || '•'); ic.setVisible(true); }
      }

      // Cost footer — affordability + flash feedback.
      const affordable = this.sim.money >= entry.cost;
      const flashing = this._noMoneyFlashId === i && this.sim.time < this._noMoneyFlashUntil;
      card.costLabel.setText(`$${entry.cost}${affordable ? '' : ' ✗'}`);
      card.costLabel.setColor(flashing ? '#ff4d4d' : (affordable ? '#ffd84d' : '#8888a0'));
      card.costLabel.setVisible(true);
      card.hit.setVisible(true);
    }
  }

  _renderDetail(g) {
    const entry = this._selectedEntry;
    if (!entry) { this._mode = 'list'; return; }

    const px = this._panelX(), py = this._panelY();
    const pw = this._panelW(), ph = this._panelH();

    // Big portrait on the left.
    g.fillStyle(0x231a30, 1);
    g.fillRoundedRect(px + 30, py + 60, 180, 180, 10);
    g.lineStyle(2, COLORS.outline, 0.6);
    g.strokeRoundedRect(px + 30, py + 60, 180, 180, 10);
    Sprites.chefPortrait(g, entry, px + 120, py + 126);

    // Name (top-left) + cost (top-right).
    this._detailName.setText(entry.name);
    this._detailName.setVisible(true);
    const affordable = this.sim.money >= entry.cost;
    this._detailCost.setText(`$${entry.cost}${affordable ? '' : '  ✗'}`);
    this._detailCost.setColor(affordable ? '#ffd84d' : '#8888a0');
    this._detailCost.setVisible(true);

    // Stats (right of portrait).
    const keys  = ['dex', 'spd', 'str', 'int', 'cha'];
    const upper = ['DEX', 'SPD', 'STR', 'INT', 'CHA'];
    for (let si = 0; si < 5; si++) {
      const v = entry[keys[si]];
      this._detailStatLabels[si].setText(`${upper[si]} ${v}`);
      this._detailStatLabels[si].setVisible(true);
      Sprites.statBar(g, px + 330, py + 92 + si * 26, pw - 380, 14, v, 10);
    }

    // Bio block, positioned under portrait/stats.
    this._detailBio.setText(entry.bio || '');
    this._detailBio.setVisible(true);

    // Abilities list.
    const abilities = (entry.abilities || []).map(id => ABILITIES[id]).filter(Boolean);
    if (abilities.length) {
      this._detailAbilityHeader.setVisible(true);
      for (let ai = 0; ai < this._detailAbilityRows.length; ai++) {
        const row = this._detailAbilityRows[ai];
        const a = abilities[ai];
        if (a) {
          row.icon.setText(a.icon || '•');
          row.label.setText(`${a.name} — ${a.description}`);
          row.icon.setVisible(true); row.label.setVisible(true);
        }
      }
    }

    // Hire button — green if affordable, gray if not, red flash on no-money click.
    const hr = this._hireRect;
    const flashing = this.sim.time < this._noMoneyFlashUntil;
    const hireBg = !affordable ? 0x555566 : (flashing ? 0xc94a2a : 0x4a9e5c);
    g.fillStyle(0x000000, 0.25); g.fillRoundedRect(hr.x + 2, hr.y + 3, hr.w, hr.h, 6);
    g.fillStyle(hireBg, 1);      g.fillRoundedRect(hr.x, hr.y, hr.w, hr.h, 6);
    g.lineStyle(2, COLORS.outline, 0.8);
    g.strokeRoundedRect(hr.x, hr.y, hr.w, hr.h, 6);
    this._hireLabel.setText(affordable ? `Hire  $${entry.cost}` : `Can't afford`);
    this._hireLabel.setVisible(true);
    this._hireHit.setVisible(true);

    // Back button.
    const br = this._backRect;
    g.fillStyle(0x000000, 0.25); g.fillRoundedRect(br.x + 2, br.y + 3, br.w, br.h, 6);
    g.fillStyle(0x3d2d5c, 1);    g.fillRoundedRect(br.x, br.y, br.w, br.h, 6);
    g.lineStyle(2, COLORS.outline, 0.8);
    g.strokeRoundedRect(br.x, br.y, br.w, br.h, 6);
    this._backLabel.setVisible(true);
    this._backHit.setVisible(true);
  }
}


/* ============================================================================
 * DayEndModal — the between-day wrap-up screen
 * ============================================================================
 * Opens automatically when sim.dayState transitions to 'dayEnd', closes when
 * it returns to 'spawning'. Shows:
 *   - Today's summary (earned, served, angry, plates, tips)
 *   - One compact card per hired chef with today's numbers + status badge
 *   - A random event card with chef-assignment chips; resolution rolls on
 *     click, outcome is shown inline
 *   - Tomorrow's forecast line
 *   - A Start Day button (disabled until the event is resolved) that calls
 *     sim.startNextDay() and rolls the next day
 *
 * Unlike RecruitModal, this modal does NOT install a full-screen interactive
 * backdrop zone — the sidebar (hire, furniture) should stay usable during the
 * pause. Grid input is gated separately in GameScene._onPointerDown.
 */
class DayEndModal {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim   = sim;
    this.isOpen = false;
    // Collapsed = modal panel hidden, a small pill stays in the corner so
    // the player can see the grid underneath and rearrange furniture.
    this._collapsed = false;

    this._g = scene.add.graphics();
    this._g.setDepth(980);
    this._g.setVisible(false);

    this._texts = [];
    this._zones = [];

    // Static labels — positions are static so build once.
    const px = this._panelX(), py = this._panelY();
    const pw = this._panelW();

    this._title = this._addLabel(px + 20, py + 10, 'Day Wrap-Up', {
      font: 'bold 20px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 3,
    }, 0, 0, 982);
    this._summary = this._addLabel(px + 20, py + 40, '', {
      font: '12px system-ui', color: '#ffd84d',
    }, 0, 0, 982);
    this._chefHeader = this._addLabel(px + 20, py + 60, 'Chef Report Cards', {
      font: 'bold 12px system-ui', color: '#9be8ff', stroke: '#000', strokeThickness: 2,
    }, 0, 0, 982);

    // Chef card pool — sized to fit up to 8 cards; extra chefs spill silently.
    this._chefCards = [];
    const grid = this._chefGrid();
    for (let i = 0; i < grid.length; i++) {
      const { x, y, w, h } = grid[i];
      const name = this._addLabel(x + 52, y + 2, '', {
        font: 'bold 11px system-ui', color: '#ffffff',
      }, 0, 0, 982);
      const stats = this._addLabel(x + 52, y + 16, '', {
        font: '9px monospace', color: '#c0b0e0',
      }, 0, 0, 982);
      const numbers = this._addLabel(x + 52, y + 26, '', {
        font: '9px system-ui', color: '#ffd84d',
      }, 0, 0, 982);
      const status = this._addLabel(x + w - 6, y + 2, '', {
        font: 'bold 9px system-ui', color: '#ff7070', stroke: '#000', strokeThickness: 2,
      }, 1, 0, 982);
      this._chefCards.push({ rect: grid[i], name, stats, numbers, status });
    }

    // Event section labels.
    const evY = this._eventY();
    this._eventTitle = this._addLabel(px + 20, evY + 2, '', {
      font: 'bold 15px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 3,
    }, 0, 0, 982);
    this._eventFlavor = this._addLabel(px + 20, evY + 22, '', {
      font: 'italic 11px system-ui', color: '#d8d0e8',
      wordWrap: { width: pw - 40, useAdvancedWrap: true },
    }, 0, 0, 982);
    this._eventCheck = this._addLabel(px + 20, evY + 42, '', {
      font: 'bold 11px system-ui', color: '#ffd84d',
    }, 0, 0, 982);
    this._eventOutcome = this._addLabel(px + 20, evY + 126, '', {
      font: 'bold 11px system-ui', color: '#ffffff', stroke: '#000', strokeThickness: 2,
      wordWrap: { width: pw - 40, useAdvancedWrap: true },
    }, 0, 0, 982);

    // Chef-assign chips along the check row. Pool of 12.
    this._chefChips = [];
    for (let i = 0; i < 12; i++) {
      const chipW = 130, chipH = 26;
      const chipX = px + 20 + (i % 6) * (chipW + 6);
      const chipY = evY + 58 + Math.floor(i / 6) * (chipH + 4);
      const hit = scene.add.zone(chipX, chipY, chipW, chipH)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: true })
        .setDepth(983);
      const label = this._addLabel(chipX + chipW / 2, chipY + chipH / 2, '', {
        font: 'bold 10px system-ui', color: '#ffffff',
      }, 0.5, 0.5, 984);
      hit.on('pointerdown', () => this._onChipClick(i));
      hit.disableInteractive();
      hit.setVisible(false);
      this._zones.push(hit);
      this._chefChips.push({ hit, label, rect: { x: chipX, y: chipY, w: chipW, h: chipH } });
    }

    // Forecast line (just above the Start Day button).
    this._forecast = this._addLabel(px + 20, py + this._panelH() - 52, '', {
      font: 'bold 12px system-ui', color: '#9be8ff',
    }, 0, 0, 982);

    // Minimize toggle (top-right of panel). Lets the player hide the modal
    // to rearrange furniture / view the restaurant.
    const mbW = 90, mbH = 22;
    const mbX = px + this._panelW() - 20 - mbW;
    const mbY = py + 12;
    this._minRect = { x: mbX, y: mbY, w: mbW, h: mbH };
    this._minLabel = this._addLabel(mbX + mbW / 2, mbY + mbH / 2, '— Minimize', {
      font: 'bold 11px system-ui', color: '#ffffff',
    }, 0.5, 0.5, 984);
    this._minHit = scene.add.zone(mbX, mbY, mbW, mbH)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(983);
    this._minHit.on('pointerdown', () => this._toggleCollapse());
    this._minHit.disableInteractive();
    this._minHit.setVisible(false);
    this._zones.push(this._minHit);

    // Collapsed pill — a small bar at the top-left of the canvas that
    // surfaces Day N status + a Start Day button while the modal is tucked
    // away. Clicking the pill (not the button) re-opens the full modal.
    const pillW = 240, pillH = 30;
    const pillX = 14;
    const pillY = TOP_H + 4;
    this._pillRect = { x: pillX, y: pillY, w: pillW, h: pillH };
    this._pillLabel = this._addLabel(pillX + 12, pillY + pillH / 2, '', {
      font: 'bold 12px system-ui', color: '#ffffff',
    }, 0, 0.5, 984);
    this._pillHit = scene.add.zone(pillX, pillY, pillW, pillH)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(983);
    this._pillHit.on('pointerdown', () => this._toggleCollapse());
    this._pillHit.disableInteractive();
    this._pillHit.setVisible(false);
    this._zones.push(this._pillHit);

    // Start Day button that lives on the pill (right side). Only active
    // after the event is resolved.
    const psW = 96;
    const psX = pillX + pillW + 6;
    this._pillStartRect = { x: psX, y: pillY, w: psW, h: pillH };
    this._pillStartLabel = this._addLabel(psX + psW / 2, pillY + pillH / 2, 'Start Day →', {
      font: 'bold 12px system-ui', color: '#ffffff',
    }, 0.5, 0.5, 984);
    this._pillStartHit = scene.add.zone(psX, pillY, psW, pillH)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(983);
    this._pillStartHit.on('pointerdown', () => this._onStartClick());
    this._pillStartHit.disableInteractive();
    this._pillStartHit.setVisible(false);
    this._zones.push(this._pillStartHit);

    // Start Day button — bottom right.
    const sbW = 150, sbH = 36;
    const sbX = px + this._panelW() - 20 - sbW;
    const sbY = py + this._panelH() - 14 - sbH;
    this._startRect = { x: sbX, y: sbY, w: sbW, h: sbH };
    this._startLabel = this._addLabel(sbX + sbW / 2, sbY + sbH / 2, 'Start Day →', {
      font: 'bold 16px system-ui', color: '#ffffff',
    }, 0.5, 0.5, 984);
    this._startHit = scene.add.zone(sbX, sbY, sbW, sbH)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(983);
    this._startHit.on('pointerdown', () => this._onStartClick());
    this._startHit.disableInteractive();
    this._startHit.setVisible(false);
    this._zones.push(this._startHit);

    this._hideAll();

    // Track the sim state transition so we auto-open/close.
    this._lastState = sim.dayState;
  }

  /* ---- Geometry ---- */
  // Canvas is 1054x488 (GAME_W x GAME_H). Panel must stay inside.
  _panelW() { return 900; }
  _panelH() { return 470; }
  _panelX() { return Math.floor((GAME_W - this._panelW()) / 2); }
  _panelY() { return Math.floor((GAME_H - this._panelH()) / 2); }
  pointInPanel(x, y) {
    // When collapsed, only the pill + pill Start button absorb input so the
    // entire grid area behind it remains clickable.
    if (this._collapsed) {
      const inRect = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      return inRect(this._pillRect) || inRect(this._pillStartRect);
    }
    const px = this._panelX(), py = this._panelY();
    return x >= px && x <= px + this._panelW()
        && y >= py && y <= py + this._panelH();
  }
  _toggleCollapse() {
    this._collapsed = !this._collapsed;
    this.render();
  }

  _chefGrid() {
    const cols = 2, rows = 4;
    const cardW = 425, cardH = 38, gap = 4;
    const startX = this._panelX() + 20;
    const startY = this._panelY() + 76;
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({
          x: startX + c * (cardW + gap),
          y: startY + r * (cardH + gap),
          w: cardW, h: cardH,
        });
      }
    }
    return out;
  }
  _eventY() { return this._panelY() + 244; }

  /* ---- Label + zone helpers ---- */
  _addLabel(x, y, str, style, ox = 0, oy = 0, depth = 982) {
    const t = this.scene.add.text(x, y, str, style).setOrigin(ox, oy).setDepth(depth);
    t.setVisible(false);
    this._texts.push(t);
    return t;
  }
  _hideAll() {
    for (const t of this._texts) t.setVisible(false);
    for (const z of this._zones) { z.disableInteractive(); z.setVisible(false); }
  }

  /* ---- Open / close ---- */
  open() {
    this.isOpen = true;
    this._collapsed = false;           // fresh day — always start expanded
    this._g.setVisible(true);
    this.render();
  }
  close() {
    this.isOpen = false;
    this._g.setVisible(false);
    this._g.clear();
    this._hideAll();
  }

  /* ---- Called every frame from GameScene.update ---- */
  tick() {
    // Auto-toggle visibility from the sim state. The day ends when dayState
    // flips to 'dayEnd'; it flips back to 'spawning' when startNextDay() fires.
    const now = this.sim.dayState;
    if (now !== this._lastState) {
      if (now === 'dayEnd' && !this.isOpen)        this.open();
      else if (now !== 'dayEnd' && this.isOpen)    this.close();
      this._lastState = now;
    }
    if (this.isOpen) this.render();
  }

  /* ---- Click handlers ---- */
  _onChipClick(idx) {
    if (!this.isOpen) return;
    if (this.sim.eventOutcome) return;         // already resolved; locked
    const chefs = this.sim.eligibleChefsForEvent();
    const chef = chefs[idx]; if (!chef) return;
    this.sim.resolveEvent(chef.id);
  }
  _onStartClick() {
    if (!this.isOpen) return;
    if (!this.sim.eventOutcome) return;        // must resolve event first
    this.sim.startNextDay();                    // dayState flip will close us next tick
  }

  /* ---- Per-frame draw ---- */
  render() {
    const sim = this.sim;
    const g = this._g; g.clear();
    this._hideAll();

    if (this._collapsed) { this._renderCollapsed(g); return; }

    const px = this._panelX(), py = this._panelY();
    const pw = this._panelW(), ph = this._panelH();

    // Dim the scene so the modal pops. No interactive backdrop — sidebar
    // stays clickable through the dimmer.
    g.fillStyle(0x000000, 0.55);
    g.fillRect(0, 0, GAME_W, GAME_H);

    // Panel shell.
    g.fillStyle(COLORS.uiBg, 1);       g.fillRoundedRect(px, py, pw, ph, 10);
    g.lineStyle(3, 0x6b5ba8, 1);       g.strokeRoundedRect(px, py, pw, ph, 10);

    // Minimize toggle (top-right).
    const mr = this._minRect;
    g.fillStyle(0x3d2d5c, 1); g.fillRoundedRect(mr.x, mr.y, mr.w, mr.h, 4);
    g.lineStyle(1.5, COLORS.outline, 0.6);
    g.strokeRoundedRect(mr.x, mr.y, mr.w, mr.h, 4);
    this._minLabel.setText('— Minimize').setVisible(true);
    this._minHit.setInteractive(); this._minHit.setVisible(true);

    // Title + summary + divider.
    this._title.setText(`Day ${sim.day} Wrap-Up`).setVisible(true);
    const earned = sim.money - sim.dayStartMoney;
    const earnStr = earned >= 0 ? `+$${earned}` : `−$${-earned}`;
    this._summary.setText(
      `Earned ${earnStr}  ·  Served ${sim.stats.served}  ·  Angry ${sim.stats.angry}  ·  ` +
      `Plates ${sim.stats.plates}  ·  Tips $${sim.stats.tipsTotal}`
    ).setVisible(true);
    g.fillStyle(0x6b5ba8, 1); g.fillRect(px, py + 56, pw, 2);

    // Chef cards header.
    this._chefHeader.setVisible(true);
    this._renderChefs(g);

    // Event section divider (between chef grid and event card).
    g.fillStyle(0x6b5ba8, 1); g.fillRect(px, this._eventY() - 4, pw, 2);
    this._renderEvent(g);

    // Forecast.
    const fc = sim.nextForecast;
    const fcLabel = fc && fc.label ? fc.label : 'Nothing unusual on the books';
    this._forecast.setText(`🔮  Tomorrow:  ${fcLabel}`).setVisible(true);

    // Start Day button.
    const canStart = !!sim.eventOutcome;
    const r = this._startRect;
    g.fillStyle(0x000000, 0.3); g.fillRoundedRect(r.x + 2, r.y + 3, r.w, r.h, 6);
    g.fillStyle(canStart ? 0x4a9e5c : 0x555566, 1);
    g.fillRoundedRect(r.x, r.y, r.w, r.h, 6);
    g.lineStyle(2, COLORS.outline, 0.8);
    g.strokeRoundedRect(r.x, r.y, r.w, r.h, 6);
    this._startLabel.setText(canStart ? 'Start Day →' : 'Pick a chef').setVisible(true);
    if (canStart) this._startHit.setInteractive(); else this._startHit.disableInteractive();
    this._startHit.setVisible(true);
  }

  _renderChefs(g) {
    const emps = this.sim.employees;
    for (let i = 0; i < this._chefCards.length; i++) {
      const card = this._chefCards[i];
      const e = emps[i];
      const { x, y, w, h } = card.rect;
      if (!e) { card.name.setVisible(false); card.stats.setVisible(false);
                card.numbers.setVisible(false); card.status.setVisible(false);
                continue; }

      // Card body — faintly greyed if chef is unavailable tomorrow.
      const busy = e.status && e.status.kind === 'busy';
      g.fillStyle(busy ? 0x2a2233 : COLORS.uiPanel, 1);
      g.fillRoundedRect(x, y, w, h, 6);
      g.lineStyle(2, COLORS.outline, 0.6);
      g.strokeRoundedRect(x, y, w, h, 6);

      // Compact avatar swatch (skin + hair tint). Full chefPortrait is too
      // tall for this 38h row, so we render a small rounded head instead.
      const v = e.visual || {};
      const skin = v.skinColor != null ? v.skinColor : 0xfec9a7;
      g.fillStyle(0x231a30, 1);
      g.fillRoundedRect(x + 4, y + 4, 42, 30, 4);
      g.lineStyle(1.2, COLORS.outline, 0.5);
      g.strokeRoundedRect(x + 4, y + 4, 42, 30, 4);
      g.fillStyle(skin, 1);
      g.fillCircle(x + 25, y + 19, 10);
      g.lineStyle(1.2, COLORS.outline, 1);
      g.strokeCircle(x + 25, y + 19, 10);
      // Tiny toque or hair hint on top.
      if ((v.hat != null ? v.hat : 0) === 0) {
        g.fillStyle(0xffffff, 1);
        g.fillCircle(x + 25, y + 10, 5);
        g.strokeCircle(x + 25, y + 10, 5);
      } else if (v.hasHair) {
        g.fillStyle(v.hairColor != null ? v.hairColor : 0x3a2a1a, 1);
        g.fillCircle(x + 25, y + 13, 7);
      }

      const starter = e.isStarter ? '★ ' : '';
      card.name.setText(`${starter}${e.name}`).setVisible(true);
      card.stats.setText(
        `D${e.dex} S${e.spd} T${e.str} I${e.int} C${e.cha}`
      ).setVisible(true);
      const d = e.dayStats;
      card.numbers.setText(
        `🍳 ${d.dishes}  💰 $${d.tipsEarned}  😓 ${d.timesTired}  ✨ ${d.procs}`
      ).setVisible(true);

      let badge = '';
      let badgeColor = '#ff7070';
      if (e.status) {
        if (e.status.kind === 'busy')       { badge = 'BUSY';      badgeColor = '#ff7070'; }
        else if (e.status.kind === 'stressed')  { badge = 'STRESSED';  badgeColor = '#ffa94d'; }
        else if (e.status.kind === 'starstruck'){ badge = 'STARSTRUCK'; badgeColor = '#ffd84d'; }
      }
      card.status.setText(badge);
      card.status.setColor(badgeColor);
      card.status.setVisible(!!badge);
    }
  }

  _renderCollapsed(g) {
    const sim = this.sim;
    // No full-screen dimmer when collapsed — player needs to see the grid.
    const r = this._pillRect;
    const ps = this._pillStartRect;

    g.fillStyle(0x000000, 0.3); g.fillRoundedRect(r.x + 1, r.y + 2, r.w, r.h, 6);
    g.fillStyle(COLORS.uiBg, 1); g.fillRoundedRect(r.x, r.y, r.w, r.h, 6);
    g.lineStyle(2, 0x6b5ba8, 1); g.strokeRoundedRect(r.x, r.y, r.w, r.h, 6);

    const earned = sim.money - sim.dayStartMoney;
    const earnStr = earned >= 0 ? `+$${earned}` : `−$${-earned}`;
    const resolved = !!sim.eventOutcome;
    this._pillLabel.setText(
      `📋 Day ${sim.day} ${earnStr}  ${resolved ? '✓' : '•'}  tap to review`
    ).setVisible(true);
    this._pillHit.setInteractive(); this._pillHit.setVisible(true);

    const canStart = resolved;
    g.fillStyle(0x000000, 0.3); g.fillRoundedRect(ps.x + 1, ps.y + 2, ps.w, ps.h, 6);
    g.fillStyle(canStart ? 0x4a9e5c : 0x555566, 1);
    g.fillRoundedRect(ps.x, ps.y, ps.w, ps.h, 6);
    g.lineStyle(2, COLORS.outline, 0.6);
    g.strokeRoundedRect(ps.x, ps.y, ps.w, ps.h, 6);
    this._pillStartLabel.setText(canStart ? 'Start Day →' : 'Pick a chef').setVisible(true);
    if (canStart) this._pillStartHit.setInteractive();
    else this._pillStartHit.disableInteractive();
    this._pillStartHit.setVisible(true);
  }

  _renderEvent(g) {
    const sim = this.sim, ev = sim.currentEvent;
    if (!ev) return;

    const px = this._panelX();
    const pw = this._panelW();

    this._eventTitle.setText(`${ev.icon || '⚠️'}  ${ev.title}`).setVisible(true);
    this._eventFlavor.setText(ev.flavor || '').setVisible(true);
    const dc = typeof ev.dc === 'function' ? ev.dc(sim.day) : ev.dc;
    this._eventCheck.setText(
      `Check: ${ev.statLabel || ev.stat.toUpperCase()} · DC ${dc}   (1d10 + stat vs DC)`
    ).setVisible(true);

    // Chef chips — one per eligible chef. Selection state is loud on
    // purpose: before the roll the player needs zero doubt about which chef
    // they've picked.
    const chefs = sim.eligibleChefsForEvent();
    for (let i = 0; i < this._chefChips.length; i++) {
      const chip = this._chefChips[i];
      const chef = chefs[i];
      if (!chef) { chip.hit.setVisible(false); chip.hit.disableInteractive();
                   chip.label.setVisible(false); continue; }
      const r = chip.rect;
      const picked = sim.eventOutcome && sim.eventOutcome.chef === chef;
      const locked = !!sim.eventOutcome;

      // Glow/drop shadow for selected — draw a wide soft backing first.
      if (picked) {
        g.fillStyle(0xffd84d, 0.35);
        g.fillRoundedRect(r.x - 4, r.y - 3, r.w + 8, r.h + 6, 8);
      } else {
        g.fillStyle(0x000000, 0.25); g.fillRoundedRect(r.x + 1, r.y + 2, r.w, r.h, 4);
      }
      // Fill: bright green for picked; medium purple for live options;
      // darker and nearly flat for rejected options after lock.
      const fill = picked ? 0x5fd97e : (locked ? 0x322a42 : 0x5a4ab0);
      g.fillStyle(fill, 1); g.fillRoundedRect(r.x, r.y, r.w, r.h, 4);
      // Border: thick yellow ring for selected; thin for everything else.
      if (picked) {
        g.lineStyle(3, 0xffd84d, 1);
      } else {
        g.lineStyle(2, COLORS.outline, 0.6);
      }
      g.strokeRoundedRect(r.x, r.y, r.w, r.h, 4);

      const statVal = chef.effStat(ev.stat);
      const prefix  = picked ? '✓ ' : '';
      chip.label.setText(
        `${prefix}${chef.name.split(' ')[0]}  (${ev.statLabel || ev.stat.toUpperCase()} ${Math.round(statVal)})`
      );
      chip.label.setColor(picked ? '#1a1428' : (locked ? '#8888a0' : '#ffffff'));
      chip.label.setVisible(true);
      chip.hit.setVisible(true);
      if (locked) chip.hit.disableInteractive(); else chip.hit.setInteractive();
    }

    // Outcome text below the chips.
    if (sim.eventOutcome) {
      const o = sim.eventOutcome;
      const tag = o.passed ? 'PASSED' : 'FAILED';
      const tagColor = o.passed ? '#7be68c' : '#ff7070';
      this._eventOutcome.setText(
        `${tag}  (roll ${o.roll} + ${Math.round(o.chef.effStat(ev.stat))} = ${Math.round(o.total)} vs ${o.dc})   ${o.msg}`
      );
      this._eventOutcome.setColor(tagColor);
      this._eventOutcome.setVisible(true);
    } else {
      this._eventOutcome.setText('Assign a chef to resolve the check.');
      this._eventOutcome.setColor('#c0b0e0');
      this._eventOutcome.setVisible(true);
    }
  }
}


/* ============================================================================
 * GameOverModal — run-ending screen, shown when sim.lives hits 0
 * ============================================================================
 * Simpler than the day-end modal: no event card, no chef assignment. Shows
 * the final run totals and a Restart button that reloads the page for a
 * clean state.
 */
class GameOverModal {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim   = sim;
    this.isOpen = false;

    this._g = scene.add.graphics();
    this._g.setDepth(990);        // above DayEndModal (980)
    this._g.setVisible(false);

    const pw = 460, ph = 260;
    const px = Math.floor((GAME_W - pw) / 2);
    const py = Math.floor((GAME_H - ph) / 2);
    this._rect = { x: px, y: py, w: pw, h: ph };

    this._title = scene.add.text(px + pw / 2, py + 18, '☠  Game Over  ☠', {
      font: 'bold 26px system-ui', color: '#ff6666', stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5, 0).setDepth(992).setVisible(false);

    this._subtitle = scene.add.text(px + pw / 2, py + 60, 'Too many hangry customers walked out.', {
      font: 'italic 13px system-ui', color: '#c0b0e0',
    }).setOrigin(0.5, 0).setDepth(992).setVisible(false);

    this._stats = scene.add.text(px + pw / 2, py + 96, '', {
      font: '14px system-ui', color: '#ffffff', align: 'center',
    }).setOrigin(0.5, 0).setDepth(992).setVisible(false);

    const bw = 160, bh = 44;
    const bx = px + pw / 2 - bw / 2;
    const by = py + ph - 62;
    this._btnRect = { x: bx, y: by, w: bw, h: bh };
    this._btnLabel = scene.add.text(bx + bw / 2, by + bh / 2, '↻ Restart', {
      font: 'bold 18px system-ui', color: '#ffffff',
    }).setOrigin(0.5, 0.5).setDepth(993).setVisible(false);
    this._btnHit = scene.add.zone(bx, by, bw, bh)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(993);
    this._btnHit.on('pointerdown', () => window.location.reload());
    this._btnHit.disableInteractive();
    this._btnHit.setVisible(false);
  }

  pointInPanel(x, y) {
    const r = this._rect;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  tick() {
    if (this.sim.gameOver && !this.isOpen) this.open();
    if (this.isOpen) this.render();
  }

  open() {
    this.isOpen = true;
    this._g.setVisible(true);
    this._title.setVisible(true);
    this._subtitle.setVisible(true);
    this._stats.setVisible(true);
    this._btnLabel.setVisible(true);
    this._btnHit.setInteractive();
    this._btnHit.setVisible(true);
  }

  render() {
    const g = this._g; g.clear();
    const { x, y, w, h } = this._rect;

    g.fillStyle(0x000000, 0.75); g.fillRect(0, 0, GAME_W, GAME_H);
    g.fillStyle(COLORS.uiBg, 1); g.fillRoundedRect(x, y, w, h, 12);
    g.lineStyle(3, 0xff6666, 1); g.strokeRoundedRect(x, y, w, h, 12);

    const sim = this.sim;
    this._stats.setText(
      `Day reached:  ${sim.day}\n` +
      `Final cash:  $${sim.money}\n` +
      `Customers served:  ${sim.runStats.served}\n` +
      `Tips earned:  $${sim.runStats.tipsTotal}`
    );

    const r = this._btnRect;
    g.fillStyle(0x000000, 0.3); g.fillRoundedRect(r.x + 2, r.y + 3, r.w, r.h, 8);
    g.fillStyle(0x4a9e5c, 1);   g.fillRoundedRect(r.x, r.y, r.w, r.h, 8);
    g.lineStyle(2, COLORS.outline, 0.8); g.strokeRoundedRect(r.x, r.y, r.w, r.h, 8);
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

    // --- Recruit modal: Sidebar.hire opens it; it draws on top of everything. ---
    this.recruitModal = new RecruitModal(this, this.sim);

    // --- Day-end modal: auto-opens when sim.dayState flips to 'dayEnd'. ---
    this.dayEndModal = new DayEndModal(this, this.sim);

    // --- Game over modal: auto-opens when sim.gameOver becomes true. ---
    this.gameOverModal = new GameOverModal(this, this.sim);

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
    // --- Move tool pickup state: once a building is picked, stores the
    //     source tile so the next click drops it. Cleared on drop, right-
    //     click, ESC, or tool switch.
    this.movingFrom = null;

    // --- Input: only the grid area. Sidebar zones handle themselves. ---
    this.input.mouse.disableContextMenu();
    this.input.on('pointermove', p => this._onPointerMove(p));
    this.input.on('pointerdown', p => this._onPointerDown(p));
  }

  update(_, dtMs) {
    const dt = Math.min(dtMs / 1000, 0.1) * this.sidebar.speed;
    this.sim.update(dt);
    this._frame++;

    // Switching tools while mid-pickup should drop the pickup state so the
    // source tile marker doesn't linger.
    if (this.sidebar.tool !== 'move' && this.movingFrom) this.movingFrom = null;

    // When the day starts, any active layout-tool selection and pickup
    // should clear so the sidebar reads as "idle shift" without stale
    // highlights.
    if (this.sim.dayState !== 'dayEnd') {
      if (this.sidebar.tool && LAYOUT_TOOLS.includes(this.sidebar.tool)) {
        this.sidebar.tool = null;
      }
      if (this.movingFrom) this.movingFrom = null;
    }

    this._view.time = this.sim.time;

    this._drawScene();
    this.sidebar.refresh();
    if (this.recruitModal.isOpen) this.recruitModal.render();
    this.dayEndModal.tick();
    this.gameOverModal.tick();
    this._cullTexts();
  }

  /* ---- Input ---- */
  _onPointerMove(p) {
    // Don't track grid hover while a modal is up (day-end modal only blocks
    // the hover diamond when the cursor is over the panel itself).
    if (this.gameOverModal && this.gameOverModal.isOpen) { this.hover = null; return; }
    if (this.recruitModal && this.recruitModal.isOpen) { this.hover = null; return; }
    if (this.dayEndModal && this.dayEndModal.isOpen &&
        this.dayEndModal.pointInPanel(p.x, p.y))       { this.hover = null; return; }
    if (p.x >= GAME_W - UI_W) { this.hover = null; return; }
    const tile = screenToTile(p.x, p.y);
    if (!tile) { this.hover = null; return; }
    this.hover = { x: tile.x, y: tile.y, valid: this._isToolValidAt(tile.x, tile.y) };
  }
  _onPointerDown(p) {
    // Run-ending modal fully blocks all non-modal input.
    if (this.gameOverModal && this.gameOverModal.isOpen) return;
    // Recruit modal fully owns input while open.
    if (this.recruitModal && this.recruitModal.isOpen) return;
    // DayEndModal leaves the sidebar + exposed grid cells live so players
    // can still hire and rearrange furniture during the pause. Only absorb
    // grid clicks that land on the panel itself.
    if (this.dayEndModal && this.dayEndModal.isOpen &&
        this.dayEndModal.pointInPanel(p.x, p.y))       return;
    // Sidebar clicks are handled by the interactive Zones inside Sidebar.
    if (p.x >= GAME_W - UI_W) return;
    const tile = screenToTile(p.x, p.y); if (!tile) return;
    // Layout mutations are only allowed during the day-end review.
    const editingAllowed = this.sim.dayState === 'dayEnd';
    if (p.rightButtonDown()) {
      // Right-click always cancels a pending move first.
      if (this.movingFrom) { this.movingFrom = null; return; }
      if (!editingAllowed) return;
      this.sim.removeBuildingAt(tile.x, tile.y);
      return;
    }
    const tool = this.sidebar.tool;
    if (!tool) return;
    if (!editingAllowed) return;
    if (tool === 'remove') this.sim.removeBuildingAt(tile.x, tile.y);
    else if (tool === 'move') this._handleMoveClick(tile.x, tile.y);
    else if (['stove','table','chair','sink'].includes(tool)) this.sim.placeBuilding(tool, tile.x, tile.y);
  }
  _handleMoveClick(tx, ty) {
    if (!this.movingFrom) {
      // First click: try to pick up. Only mark as "picked" if there's a
      // movable building under the click.
      const t = this.sim.grid.getTile(tx, ty);
      if (!t || !t.building) return;
      this.movingFrom = { x: tx, y: ty };
    } else {
      // Second click: attempt to place. On failure, keep the pickup active
      // so the player can try a different tile.
      const res = this.sim.moveBuilding(this.movingFrom.x, this.movingFrom.y, tx, ty);
      if (res.ok) this.movingFrom = null;
    }
  }
  _isToolValidAt(x, y) {
    const tool = this.sidebar.tool;
    if (!tool) return false;
    const t = this.sim.grid.getTile(x, y); if (!t) return false;
    if (tool === 'remove') return !!t.building;
    if (tool === 'move') {
      if (!this.movingFrom) return !!t.building;           // phase 1: pick up
      if (this.movingFrom.x === x && this.movingFrom.y === y) return false;
      return !t.building && t.type !== 'spawn';            // phase 2: place
    }
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
        // Piggybacks on the pooled-text system so the +$N fades via cull.
        Sprites.tipFloater(view, it.ref, it.sx, it.sy);
      } else {
        Sprites.employee(view, it.ref, it.sx, it.sy);
      }
    }

    // Source-tile marker while a move is mid-pickup.
    if (this.movingFrom) {
      const { sx, sy } = gridToScreen(this.movingFrom.x, this.movingFrom.y);
      Sprites.pickupMarker(view, sx, sy);
    }

    // Hover preview
    if (this.sidebar.tool && this.hover) {
      const { sx, sy } = gridToScreen(this.hover.x, this.hover.y);
      Sprites.hoverDiamond(view, sx, sy, this.hover.valid);
    }

    // Real-time ability popups (rendered last so they float above entities).
    Sprites.popups(view, this.sim);

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
 * Bootstrap — exposed as window.startChowTime() so the HTML start menu can
 * decide when to launch the game.
 * ============================================================================ */
window.startChowTime = function () {
  if (window.__chowTimeInstance) return window.__chowTimeInstance;
  window.__chowTimeInstance = new Phaser.Game({
    type: Phaser.AUTO,
    width: GAME_W,
    height: GAME_H,
    backgroundColor: '#1a1428',
    parent: 'game',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: GameScene,
    render: { pixelArt: false, antialias: true },
  });
  return window.__chowTimeInstance;
};
