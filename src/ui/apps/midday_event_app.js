/* ============================================================================
 * src/ui/apps/midday_event_app.js — Midday event modal
 * ============================================================================
 * Auto-opens whenever sim.middayEvent is set (sim.dayState === 'midday_event').
 * Renders the event title/flavor + a card per choice. Each choice has one of
 * four kinds:
 *
 *   - 'pay'     — click-through, deducts money/reputation, applies onResolve
 *   - 'roll'    — picks a chef, rolls 1d10 + stat vs DC
 *   - 'ability' — picks a chef who must have abilityId, applies onResolve
 *   - 'hybrid'  — pays cost AND rolls (chef pick required)
 *
 * Two phases:
 *   1. Choice phase  — show choice cards. Clicking a choice that needs a
 *                      chef switches into the chef-pick sub-phase for that
 *                      choice.
 *   2. Outcome phase — sim.middayOutcome is set. Show the outcome panel +
 *                      Continue button that calls sim.dismissMiddayOutcome.
 *
 * The modal is `isModal: true` so the backdrop blocks game input.
 * ========================================================================== */

class MiddayEventApp extends App {
  constructor() {
    super({ id: 'midday_event', icon: '⚡', title: 'Midday', isModal: true });
    this._pendingChoiceIdx = null;     // choice the user clicked into for chef pick
  }

  // Slightly wider than the default panel so 2-3 cards lay out well.
  panelRect() {
    if (!this.scene) return null;
    const W = this.scene.gameWidth || 1100;
    const H = this.scene.gameHeight || 600;
    const w = Math.min(760, Math.floor(W * 0.85));
    const h = Math.min(540, Math.floor((H - this._topBarH()) * 0.88));
    return this._centeredRect(w, h);
  }

  autoOpenWhen(sim) {
    return !!(sim && sim.middayEvent);
  }

  onClose() {
    this._pendingChoiceIdx = null;
  }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;
    this._drawPanelFrame(g, dg, r, used, usedZones, { closeX: false });

    const ev = sim.middayEvent;
    if (!ev) { this._endFrame(used, usedZones); return; }

    // Header
    this._t(used, 'mt', `${ev.icon || '⚡'}  ${ev.title}`, r.x + 18, r.y + 14, {
      font: 'bold 20px system-ui', color: '#ffd84d',
    });
    this._t(used, 'mf', ev.flavor || '', r.x + 18, r.y + 42, {
      font: 'italic 12px system-ui', color: '#d8d0e8',
      wordWrap: { width: r.w - 36 },
    });

    // If an outcome is set, render the outcome panel + Continue.
    if (sim.middayOutcome) {
      this._renderOutcome(sim, r, used, usedZones, dg);
    } else if (this._pendingChoiceIdx != null) {
      this._renderChefPick(sim, ev, r, used, usedZones, dg);
    } else {
      this._renderChoices(sim, ev, r, used, usedZones, dg);
    }

    this._endFrame(used, usedZones);
  }

  /* ---- Phase 1: choice cards ----------------------------------------------- */
  _renderChoices(sim, ev, r, used, usedZones, dg) {
    const choices = ev.choices || [];
    const cardsTop = r.y + 80;
    const cols = choices.length <= 2 ? choices.length : Math.min(2, choices.length);
    const rows = Math.ceil(choices.length / cols);
    const colGap = 12, rowGap = 12;
    const cardW = (r.w - 36 - colGap * (cols - 1)) / Math.max(1, cols);
    const cardH = 130;
    this._drawCardGrid(choices,
      { x: r.x + 18, y: cardsTop, cols, cardW, cardH, colGap, rowGap },
      (choice, cx, cy) => {
        const affordable = this._canAfford(sim, choice);
        if (dg) {
          dg.fillStyle(0x000000, 0.25);
          dg.fillRoundedRect(cx + 2, cy + 3, cardW, cardH, 8);
          dg.fillStyle(affordable ? 0x3d2d5c : 0x2a2233, 1);
          dg.fillRoundedRect(cx, cy, cardW, cardH, 8);
          dg.lineStyle(2, 0x2a1a1a, 0.6);
          dg.strokeRoundedRect(cx, cy, cardW, cardH, 8);
        }
        const labelColor = affordable ? '#ffffff' : '#6a5a8a';
        // Kind tag
        const kindTag = this._kindBadge(choice);
        this._t(used, `mc:${choice.label}:kind`, kindTag, cx + 10, cy + 10, {
          font: 'bold 10px system-ui', color: '#ffd84d',
        });
        this._t(used, `mc:${choice.label}:label`, choice.label, cx + 10, cy + 30, {
          font: 'bold 13px system-ui', color: labelColor,
          wordWrap: { width: cardW - 20 },
        });
        const detail = this._detailFor(choice, sim);
        this._t(used, `mc:${choice.label}:detail`, detail, cx + 10, cy + 70, {
          font: '11px system-ui', color: affordable ? '#c0b0e0' : '#6a5a8a',
          wordWrap: { width: cardW - 20 },
        });
        if (affordable) {
          this._bindZone(`mc:${choice.label}`, cx, cy, cardW, cardH, () => {
            const idx = (ev.choices || []).indexOf(choice);
            const needsChef = (choice.kind === 'roll' || choice.kind === 'ability' || choice.kind === 'hybrid');
            if (needsChef) {
              this._pendingChoiceIdx = idx;
            } else {
              sim.resolveMiddayChoice(idx);
            }
          }, usedZones);
        }
      });
  }

  /* ---- Phase 1b: chef-pick sub-screen ------------------------------------- */
  _renderChefPick(sim, ev, r, used, usedZones, dg) {
    const choice = (ev.choices || [])[this._pendingChoiceIdx];
    if (!choice) { this._pendingChoiceIdx = null; return; }
    this._t(used, 'cp:lead', `Choose a chef for: ${choice.label}`,
      r.x + 18, r.y + 80, { font: 'bold 14px system-ui', color: '#ffd84d' });
    if (choice.stat) {
      const dc = typeof choice.dc === 'function' ? choice.dc(sim.day) : (choice.dc || 10);
      const slLabel = choice.statLabel || choice.stat.toUpperCase();
      this._t(used, 'cp:dc', `Check ${slLabel} · DC ${dc}  (1d10 + stat)`,
        r.x + 18, r.y + 104, { font: 'bold 11px system-ui', color: '#9be8ff' });
    }
    const chefs = (typeof sim.eligibleChefsForMidday === 'function')
      ? sim.eligibleChefsForMidday(choice.stat)
      : sim.employees.filter(e => e.isStarter || (e.isAvailable && e.isAvailable()));
    const chipW = 150, chipH = 32;
    const chipsPerRow = Math.max(1, Math.floor((r.w - 36) / (chipW + 8)));
    chefs.slice(0, 12).forEach((chef, i) => {
      const col = i % chipsPerRow, row = (i / chipsPerRow) | 0;
      const cx = r.x + 18 + col * (chipW + 8);
      const cy = r.y + 140 + row * (chipH + 6);
      if (dg) {
        dg.fillStyle(0x5a4ab0, 1); dg.fillRoundedRect(cx, cy, chipW, chipH, 4);
        dg.lineStyle(2, 0x2a1a1a, 0.6); dg.strokeRoundedRect(cx, cy, chipW, chipH, 4);
      }
      const stat = choice.stat ? Math.round(chef.effStat ? chef.effStat(choice.stat) : 0) : null;
      const tag = stat != null
        ? `${(chef.name || '').split(' ')[0]} (${(choice.statLabel || choice.stat || '').toUpperCase()} ${stat})`
        : (chef.name || '').split(' ')[0];
      this._t(used, `cp:${chef.id}`, tag, cx + 10, cy + 8, {
        font: 'bold 11px system-ui', color: '#ffffff',
      });
      this._bindZone(`cp:${chef.id}`, cx, cy, chipW, chipH,
        () => {
          const idx = this._pendingChoiceIdx;
          this._pendingChoiceIdx = null;
          sim.resolveMiddayChoice(idx, chef.id);
        }, usedZones);
    });
    // Back button to return to choice list.
    const bw = 80, bh = 28;
    this._drawPanelButton('back', r.x + 18, r.y + r.h - 50, bw, bh, {
      label: '← Back', fill: 0x4a3d7a, color: '#ffffff',
      onClick: () => { this._pendingChoiceIdx = null; },
    }, used, usedZones);
  }

  /* ---- Phase 2: outcome ---------------------------------------------------- */
  _renderOutcome(sim, r, used, usedZones, dg) {
    const o = sim.middayOutcome;
    const top = r.y + 80;
    const isRoll = (o.kind === 'roll' || o.kind === 'hybrid');
    const banner = isRoll
      ? `${o.passed ? '✓ PASSED' : '✗ FAILED'} (roll ${o.roll} + stat = ${Math.round(o.total)} vs DC ${o.dc})`
      : (o.passed ? '✓ Resolved' : '⚠ Resolved');
    this._t(used, 'mo:banner', banner, r.x + 18, top, {
      font: 'bold 14px system-ui', color: o.passed ? '#7be68c' : '#ff7070',
    });
    this._t(used, 'mo:msg', o.msg || '', r.x + 18, top + 30, {
      font: '13px system-ui', color: '#ffffff',
      wordWrap: { width: r.w - 36 },
    });
    if (o.chef) {
      this._t(used, 'mo:chef', `Chef: ${o.chef.name}`, r.x + 18, top + 70, {
        font: 'italic 11px system-ui', color: '#c0b0e0',
      });
    }
    const bw = 160, bh = 38;
    this._drawPanelButton('continue', r.x + r.w - bw - 18, r.y + r.h - bh - 18, bw, bh, {
      label: '▶ Continue',
      fill: 0x5fd97e, color: '#1a1428', centerLabel: true,
      onClick: () => sim.dismissMiddayOutcome(),
    }, used, usedZones);
  }

  /* ---- Helpers ------------------------------------------------------------- */
  _canAfford(sim, choice) {
    const cost = choice.cost || {};
    if (sim.debug) return true;
    if ((cost.money || 0) > 0 && sim.money < cost.money) return false;
    if ((cost.reputation || 0) > 0 && sim.reputation < cost.reputation) return false;
    return true;
  }
  _kindBadge(choice) {
    if (choice.kind === 'pay')     return 'PAY';
    if (choice.kind === 'roll')    return `ROLL ${(choice.statLabel || choice.stat || '').toUpperCase()}`;
    if (choice.kind === 'ability') return 'ABILITY';
    if (choice.kind === 'hybrid')  return `PAY+ROLL ${(choice.statLabel || choice.stat || '').toUpperCase()}`;
    return '';
  }
  _detailFor(choice, sim) {
    const cost = choice.cost || {};
    const parts = [];
    if (cost.money > 0)        parts.push(`Cost: $${cost.money}`);
    if (cost.money < 0)        parts.push(`Grant: $${-cost.money}`);
    if (cost.reputation > 0)   parts.push(`Cost: ${cost.reputation} rep`);
    if (cost.reputation < 0)   parts.push(`Grant: ${-cost.reputation} rep`);
    if (choice.kind === 'roll' || choice.kind === 'hybrid') {
      const dc = typeof choice.dc === 'function' ? choice.dc(sim.day) : choice.dc;
      const slLabel = choice.statLabel || (choice.stat || '').toUpperCase();
      parts.push(`Roll ${slLabel} ≥ ${dc}`);
    }
    return parts.length ? parts.join(' · ') : 'Click to apply';
  }

  describe(sim) {
    return Object.assign(super.describe(), {
      middayEventId: sim && sim.middayEvent ? sim.middayEvent.id : null,
      hasOutcome:    sim ? !!sim.middayOutcome : null,
      pendingChoice: this._pendingChoiceIdx,
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { MiddayEventApp };
