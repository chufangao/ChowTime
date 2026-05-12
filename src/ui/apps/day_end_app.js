/* ============================================================================
 * src/ui/apps/day_end_app.js — Review tab: chef state + event log
 * ============================================================================
 * Pure on-demand surface. The dayEnd event (and the Day-1 boot gift) used to
 * resolve here; that flow now lives in MiddayEventApp, which auto-opens its
 * unified modal during 'dayEnd'. This tab is purely informational:
 *
 *   - Top section: chef cards (name, base stats, today's perf, status badge)
 *   - Bottom section: rolling event history log — one line per resolution
 *     across both midday and dayEnd events. Lines are stored on sim.eventHistory
 *     by EventManager._logHistoryEntry, persisted across save/load.
 *
 * The launcher (📅 Review) opens this panel; nothing here forces auto-open.
 * ========================================================================== */

class DayEndApp extends App {
  constructor() {
    super({ id: 'day_end', icon: '📅', title: 'Review', isModal: false });
  }

  // Wider/taller than the default — chef cards have full portraits and the
  // log can grow with the run.
  panelRect() {
    if (!this.scene) return null;
    const W = this.scene.gameWidth || 1100;
    const H = this.scene.gameHeight || 600;
    const w = Math.min(820, Math.floor(W * 0.86));
    const h = Math.min(580, Math.floor((H - this._topBarH()) * 0.92));
    return this._centeredRect(w, h);
  }

  // Always on-demand — the unified event modal handles all auto-opens now.
  autoOpenWhen(_sim) { return false; }

  // No persistent attention dot here either. The unified modal IS the call to
  // action for unresolved events; lighting up Review on top of that would
  // double-signal. (Past-day history is information the player browses to,
  // not a notification.)
  notification(_sim) { return false; }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;

    this._drawPanelFrame(g, dg, r, used, usedZones, { closeIcon: '–' });

    // Header
    this._t(used, 'title', `📅 Review`, r.x + 18, r.y + 14, {
      font: 'bold 20px system-ui', color: '#ffd84d',
    });
    const earned = sim.money - sim.dayStartMoney;
    const earnStr = earned >= 0 ? `+$${earned}` : `−$${-earned}`;
    const sub = sim.day > 1 && sim.dayState === 'dayEnd'
      ? `Day ${sim.day} — ${earnStr}  ·  served ${sim.stats.served}  ·  angry ${sim.stats.angry}  ·  plates ${sim.stats.plates}  ·  tips $${sim.stats.tipsTotal}`
      : `Day ${sim.day}`;
    this._t(used, 'sub', sub, r.x + 18, r.y + 42, {
      font: '12px system-ui', color: '#ffffff',
    });

    // Chef cards take the top half; history fills the rest.
    let cy = r.y + 70;
    cy = this._renderChefCards(sim, r, dg, used, cy) + 8;
    this._renderHistory(sim, r, dg, used, usedZones, cy);

    this._endFrame(used, usedZones);
  }

  /* ---- Chef state cards ---------------------------------------------------
   * Card layout: portrait well on the left (Sprites.chefPortrait, same as
   * the Hire app's recruit cards so the player sees the SAME face here as
   * when they picked them), text column on the right (name, stats, today's
   * perf line, optional status badge). */
  _renderChefCards(sim, r, dg, used, top) {
    const colW = (r.w - 36 - 12) / 2;
    const cardH = 88;
    const list = sim.employees.slice(0, 8);
    this._drawCardGrid(list,
      { x: r.x + 18, y: top, cols: 2, cardW: colW, cardH, colGap: 12, rowGap: 8 },
      (e, cx, yy) => {
        const busy = e.status && e.status.kind === 'busy';
        if (dg) {
          // Card frame.
          dg.fillStyle(0x000000, 0.25);
          dg.fillRoundedRect(cx + 2, yy + 3, colW, cardH, 8);
          dg.fillStyle(busy ? 0x2a2233 : 0x3d2d5c, 1);
          dg.fillRoundedRect(cx, yy, colW, cardH, 8);
          dg.lineStyle(2, 0x2a1a1a, 0.6); dg.strokeRoundedRect(cx, yy, colW, cardH, 8);
          // Portrait well — sized to fit a full chefPortrait (headR=18 head +
          // toque ~20 above + shoulders ~14 below ≈ 64×72 visible).
          dg.fillStyle(0x231a30, 1);
          dg.fillRoundedRect(cx + 6, yy + 6, 60, cardH - 12, 6);
          dg.lineStyle(1.5, 0x2a1a1a, 0.5);
          dg.strokeRoundedRect(cx + 6, yy + 6, 60, cardH - 12, 6);
          // Real portrait — same renderer the Hire app uses, so the face
          // here matches what the player saw on recruit.
          if (typeof Sprites !== 'undefined' && Sprites.chefPortrait) {
            // Center: cx + 36, yy + cardH/2 + 6 (slight bias down so the
            // toque has room above the head).
            Sprites.chefPortrait(dg, e, cx + 36, yy + cardH / 2 + 6);
          }
        }
        const tx = cx + 76;
        const star = e.isStarter ? '★ ' : '';
        this._t(used, `e:${e.id}:n`, `${star}${e.name}`, tx, yy + 8, {
          font: 'bold 13px system-ui', color: '#ffffff',
        });
        this._t(used, `e:${e.id}:s`,
          `D${e.dex} S${e.spd} T${e.str} I${e.int} C${e.cha}`,
          tx, yy + 30, { font: '11px monospace', color: '#ffffff' });
        const d = e.dayStats || { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0 };
        this._t(used, `e:${e.id}:d`,
          `🍳${d.dishes}  💰$${d.tipsEarned}  😓${d.timesTired}  ✨${d.procs}`,
          tx, yy + 52, { font: '11px system-ui', color: '#ffd84d' });
        let badge = '';
        if (e.status) {
          if (e.status.kind === 'busy')        badge = 'BUSY';
          else if (e.status.kind === 'stressed') badge = 'STRESSED';
          else if (e.status.kind === 'starstruck') badge = '★';
          else if (e.status.kind === 'injured')  badge = 'INJURED';
        }
        if (badge) this._t(used, `e:${e.id}:b`, badge, cx + colW - 70, yy + 8, {
          font: 'bold 10px system-ui', color: '#ff7070',
        });
      });
    const rows = Math.ceil(Math.min(sim.employees.length, 8) / 2);
    return top + rows * (cardH + 8);
  }

  /* ---- Event history log -------------------------------------------------- */
  _renderHistory(sim, r, dg, used, usedZones, top) {
    const h = (r.y + r.h) - top - 14;
    if (h < 60) return;

    // Section header.
    this._t(used, 'hist:hdr', '📜 Event log', r.x + 18, top, {
      font: 'bold 14px system-ui', color: '#ffd84d',
    });

    const entries = Array.isArray(sim.eventHistory) ? sim.eventHistory : [];
    if (entries.length === 0) {
      this._t(used, 'hist:empty', 'No events resolved yet — choices show up here.',
        r.x + 18, top + 22, {
          font: 'italic 11px system-ui', color: '#ffffff',
        });
      return;
    }

    // Newest first. Render as many one-liners as fit; scrollable variants can
    // come later when the log grows past the panel.
    const rows = [...entries].reverse();
    const rowH = 18;
    const maxRows = Math.max(0, Math.floor((h - 28) / rowH));
    const visible = rows.slice(0, maxRows);
    visible.forEach((e, i) => {
      const y = top + 22 + i * rowH;
      const line = this._formatHistoryLine(e);
      const color = e.isRoll
        ? (e.passed ? '#7be68c' : '#ff7070')
        : '#ffffff';
      this._t(used, `hist:${i}:line`, line, r.x + 18, y, {
        font: '11px system-ui', color,
        wordWrap: { width: r.w - 36 },
      });
    });
    if (rows.length > visible.length) {
      this._t(used, 'hist:more', `…and ${rows.length - visible.length} earlier.`,
        r.x + 18, top + 22 + visible.length * rowH, {
          font: 'italic 10px system-ui', color: '#c0b0e0',
        });
    }
  }

  // "Day 3 — 🥊 Brawl · Break it up · Maria · PASS (8+4=12 vs DC 10) — Grateful table tipped $50."
  _formatHistoryLine(e) {
    const head = `Day ${e.day} — ${e.eventIcon ? e.eventIcon + ' ' : ''}${e.eventTitle}`;
    const choice = e.choiceLabel ? ` · ${e.choiceLabel}` : '';
    const chef   = e.chefName ? ` · ${e.chefName}` : '';
    const rollStr = e.isRoll
      ? ` · ${e.passed ? 'PASS' : 'FAIL'} (${e.roll}+${Math.max(0, (e.total || 0) - (e.roll || 0))}=${e.total} vs DC ${e.dc})`
      : '';
    const msg = e.msg ? ` — ${e.msg}` : '';
    return `${head}${choice}${chef}${rollStr}${msg}`;
  }

  describe(sim) {
    return Object.assign(super.describe(), {
      historyLen: Array.isArray(sim && sim.eventHistory) ? sim.eventHistory.length : 0,
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { DayEndApp };
