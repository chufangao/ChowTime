/* ============================================================================
 * src/ui/apps/hire_app.js — Recruit a chef
 * ============================================================================
 * Centered-overlay panel app. Two modes:
 *   - 'list':   2-column scrollable card grid of sim.recruitPool entries.
 *   - 'detail': bio, full stats, abilities, Hire/Back.
 *
 * Persistent state (mode, selectedEntryId, scrollRow) survives close/open
 * via serialize()/deserialize() so save/load can restore mid-recruit screens.
 * ========================================================================== */

class HireApp extends App {
  constructor() {
    super({ id: 'hire', icon: '👤', title: 'Hire', lockedDuringService: true });
    this.mode             = 'list';
    this.scrollRow        = 0;
    this.selectedEntryId  = null;
    this.noMoneyFlashUntil = 0;
  }

  panelRect() {
    if (!this.scene) return null;
    const W = this.scene.gameWidth || 1100;
    const H = this.scene.gameHeight || 600;
    const w = Math.min(820, Math.floor(W * 0.85));
    const h = Math.min(520, Math.floor((H - this._topBarH()) * 0.92));
    return this._centeredRect(w, h);
  }

  onOpen() { this.mode = 'list'; this.scrollRow = 0; this.selectedEntryId = null; }

  // Mouse wheel scroll: only meaningful in list mode. Step by one row per
  // wheel notch; clamp to [0, maxRow] computed from the live pool.
  onWheel(p, dy) {
    if (this.mode !== 'list') return;
    const sim = this.manager && this.manager._sim;
    const pool = (sim && sim.recruitPool) || [];
    const cols = 2, rows = 4;
    const maxRow = Math.max(0, Math.ceil(pool.length / cols) - rows);
    if (maxRow === 0) return;
    const step = dy > 0 ? 1 : -1;
    this.scrollRow = Math.max(0, Math.min(maxRow, this.scrollRow + step));
  }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;
    this._usedZones = usedZones;     // captured by _renderList/_renderDetail

    this._drawPanelFrame(g, dg, r, used, usedZones);

    // Header
    this._t(used, 'title', this.mode === 'list' ? '👤 Recruit a Cook' : '👤 Chef Profile',
      r.x + 18, r.y + 14, { font: 'bold 20px system-ui', color: '#ffd84d' });
    this._t(used, 'cash', `Cash: $${sim ? sim.money : 0}`, r.x + r.w - 130, r.y + 18, {
      font: 'bold 14px system-ui', color: '#ffd84d',
    });

    if (this.mode === 'list') this._renderList(sim, r, dg, used);
    else                      this._renderDetail(sim, r, dg, used);

    this._endFrame(used, usedZones);
  }

  _renderList(sim, r, dg, used) {
    const pool = (sim && sim.recruitPool) || [];
    const cols = 2, rows = 4;
    const cardW = (r.w - 36 - 16) / cols;
    const cardH = 96;
    const gridY = r.y + 60;
    const startIdx = this.scrollRow * cols;

    if (pool.length === 0) {
      this._t(used, 'empty', 'No more chefs seeking work.', r.x + r.w / 2 - 100, r.y + r.h / 2 - 8, {
        font: 'bold 14px system-ui', color: '#c0b0e0',
      });
      return;
    }

    const window = pool.slice(startIdx, startIdx + cols * rows);
    this._drawCardGrid(window, { x: r.x + 18, y: gridY, cols, cardW, cardH, colGap: 16, rowGap: 8 },
      (entry, cx, cy) => {
        const affordable = sim.debug || sim.money >= entry.cost;
        if (dg) {
          dg.fillStyle(0x000000, 0.25); dg.fillRoundedRect(cx + 2, cy + 3, cardW, cardH, 8);
          dg.fillStyle(affordable ? 0x3d2d5c : 0x2a2233, 1);
          dg.fillRoundedRect(cx, cy, cardW, cardH, 8);
          dg.lineStyle(2, 0x2a1a1a, 0.6); dg.strokeRoundedRect(cx, cy, cardW, cardH, 8);
          // Portrait well — small framed circle on the left of each card.
          dg.fillStyle(0x231a30, 1);
          dg.fillRoundedRect(cx + 8, cy + 8, 64, 80, 6);
          dg.lineStyle(1.5, 0x2a1a1a, 0.5);
          dg.strokeRoundedRect(cx + 8, cy + 8, 64, 80, 6);
          // Chef portrait drawn directly on graphics (no text-pool entry).
          if (typeof Sprites !== 'undefined' && Sprites.chefPortrait) {
            Sprites.chefPortrait(dg, entry, cx + 40, cy + 40);
          }
        }
        const tx = cx + 80;       // text starts to the right of the portrait
        this._t(used, `c:${entry.id}:name`, entry.name, tx, cy + 8, {
          font: 'bold 14px system-ui', color: affordable ? '#ffffff' : '#9a8ac0',
        });
        this._t(used, `c:${entry.id}:stats`,
          `D${entry.dex} S${entry.spd} T${entry.str} I${entry.int} C${entry.cha}`,
          tx, cy + 30, { font: '11px monospace', color: '#c0b0e0' });
        const abIcons = ((entry.abilities || []).map(id => (typeof ABILITIES !== 'undefined' && ABILITIES[id]) ? ABILITIES[id].icon : '•')
          .filter(Boolean).slice(0, 4)).join(' ');
        this._t(used, `c:${entry.id}:abil`, abIcons, tx, cy + 50, {
          font: '14px system-ui', color: '#ffe680',
        });
        this._t(used, `c:${entry.id}:cost`, `$${entry.cost}${affordable ? '' : ' ✗'}`,
          cx + cardW - 60, cy + cardH - 22, {
            font: 'bold 14px system-ui', color: affordable ? '#ffd84d' : '#8888a0',
          });
        this._bindZone(`card:${entry.id}`, cx, cy, cardW, cardH, () => {
          this.selectedEntryId = entry.id;
          this.mode = 'detail';
        }, this._usedZones);
      });

    // Scrolling indicator: thin vertical track on the right edge of the
    // panel with a proportional thumb. Wheel input drives scrollRow; the
    // bar is read-only feedback.
    const maxRow = Math.max(0, Math.ceil(pool.length / cols) - rows);
    if (maxRow > 0 && dg) {
      const trackX = r.x + r.w - 14;
      const trackY = gridY;
      const trackH = rows * (cardH + 8) - 8;
      const trackW = 4;
      dg.fillStyle(0x231a30, 1);
      dg.fillRoundedRect(trackX, trackY, trackW, trackH, 2);
      const totalRows = Math.ceil(pool.length / cols);
      const thumbH = Math.max(20, Math.floor(trackH * (rows / totalRows)));
      const thumbY = trackY + Math.floor((trackH - thumbH) * (this.scrollRow / maxRow));
      dg.fillStyle(0x6b5ba8, 1);
      dg.fillRoundedRect(trackX, thumbY, trackW, thumbH, 2);
    }
  }

  _renderDetail(sim, r, dg, used) {
    const entry = (sim.recruitPool || []).find(e => e.id === this.selectedEntryId);
    if (!entry) { this.mode = 'list'; return; }
    // Big portrait, top-left of the detail panel.
    if (dg) {
      dg.fillStyle(0x231a30, 1);
      dg.fillRoundedRect(r.x + 24, r.y + 56, 140, 140, 10);
      dg.lineStyle(2, 0x2a1a1a, 0.6);
      dg.strokeRoundedRect(r.x + 24, r.y + 56, 140, 140, 10);
      if (typeof Sprites !== 'undefined' && Sprites.chefPortrait) {
        Sprites.chefPortrait(dg, entry, r.x + 94, r.y + 116);
      }
    }
    this._t(used, 'd:name', entry.name, r.x + 184, r.y + 56, { font: 'bold 24px system-ui', color: '#ffffff' });
    this._t(used, 'd:bio', entry.bio || '', r.x + 184, r.y + 96, {
      font: 'italic 13px system-ui', color: '#d8d0e8',
      wordWrap: { width: r.w - 200 },
    });
    const keys = ['dex', 'spd', 'str', 'int', 'cha'];
    const upper = ['DEX', 'SPD', 'STR', 'INT', 'CHA'];
    for (let i = 0; i < 5; i++) {
      this._t(used, `d:s${i}`, `${upper[i]}  ${entry[keys[i]]}`, r.x + 24, r.y + 220 + i * 22, {
        font: 'bold 13px monospace', color: '#ffffff',
      });
    }
    // Ability list
    const abilities = (entry.abilities || []).map(id => (typeof ABILITIES !== 'undefined' ? ABILITIES[id] : null)).filter(Boolean);
    this._t(used, 'd:ah', 'Abilities', r.x + 220, r.y + 220, {
      font: 'bold 13px system-ui', color: '#9be8ff',
    });
    abilities.slice(0, 4).forEach((a, i) => {
      this._t(used, `d:a${i}`, `${a.icon || '•'}  ${a.name} — ${a.description || ''}`,
        r.x + 220, r.y + 246 + i * 24, {
          font: '12px system-ui', color: '#ffffff',
          wordWrap: { width: r.w - 240 },
        });
    });

    // Hire + Back
    const affordable = sim.debug || sim.money >= entry.cost;
    const flashing   = sim.time < this.noMoneyFlashUntil;
    this._drawPanelButton('back', r.x + 24, r.y + r.h - 56, 100, 36, {
      label: '← Back', font: 'bold 13px system-ui',
      fill: 0x3d2d5c, radius: 6, shadow: false,
      labelX: r.x + 50, labelY: r.y + r.h - 47,
      onClick: () => { this.mode = 'list'; },
    }, used, this._usedZones);
    this._drawPanelButton('hire', r.x + r.w - 184, r.y + r.h - 56, 160, 36, {
      label: affordable ? `Hire $${entry.cost}` : `Can't afford`,
      font: 'bold 14px system-ui',
      fill: !affordable ? 0x555566 : (flashing ? 0xc94a2a : 0x4a9e5c),
      radius: 6, shadow: false,
      labelX: r.x + r.w - 158, labelY: r.y + r.h - 47,
      onClick: () => {
        const res = sim.hireFromRoster(entry.id);
        if (res.ok) {
          this.selectedEntryId = null;
          this.mode = 'list';
          if (sim.recruitPool.length === 0) this.manager && this.manager.close();
        } else if (res.reason === 'no-money') {
          this.noMoneyFlashUntil = sim.time + 0.6;
        }
      },
    }, used, this._usedZones);
  }

  serialize() { return { mode: this.mode, scrollRow: this.scrollRow, selectedEntryId: this.selectedEntryId }; }
  deserialize(s) {
    if (!s) return;
    if (s.mode) this.mode = s.mode;
    if (s.scrollRow != null) this.scrollRow = s.scrollRow;
    if (s.selectedEntryId != null) this.selectedEntryId = s.selectedEntryId;
  }

  describe(sim) {
    return Object.assign(super.describe(), {
      mode: this.mode,
      scrollRow: this.scrollRow,
      selectedEntryId: this.selectedEntryId,
      poolSize: sim ? sim.recruitPool.length : 0,
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { HireApp };
