/* ============================================================================
 * src/ui/apps/day_end_app.js — Single between-day surface
 * ============================================================================
 * Auto-opens when sim.dayState === 'dayEnd'. Renders one of two layouts based
 * on sim.currentEvent.kind:
 *
 *   - 'gift'  → Day 1 boot. Header + gift choice cards.
 *   - regular → Day N wrap-up. Day summary + chef report cards + stat-check
 *               chef chips + forecast.
 *
 * The actual "Start Day" / "Begin Run" button lives in StartDayApp — split
 * out so the player can't hit it by accident while resolving the event.
 *
 * Closing this app while still in dayEnd is allowed; the player can re-open
 * via the 📅 Review launcher in the top bar.
 * ========================================================================== */

class DayEndApp extends App {
  constructor() {
    super({ id: 'day_end', icon: '📅', title: 'Review', isModal: false });
  }

  /** Wider panel during boot/gift so the choice cards have breathing room. */
  panelRect() {
    if (!this.scene) return null;
    const sim = this.manager && this.manager._sim;
    const isBoot = !!(sim && sim.currentEvent && sim.currentEvent.kind === 'gift');
    if (!isBoot) return super.panelRect();
    const W = this.scene.gameWidth || 1100;
    const H = this.scene.gameHeight || 600;
    const w = Math.min(720, Math.floor(W * 0.85));
    const h = Math.min(520, Math.floor((H - this._topBarH()) * 0.85));
    return this._centeredRect(w, h);
  }

  /** Open while in dayEnd. The boot-gift flow rolls its event lazily so we
   *  call ensureBootEvent here too — saves the player from a one-frame
   *  flicker if they bounced into dayEnd before any other code touched it. */
  autoOpenWhen(sim) {
    if (!sim) return false;
    if (sim.dayState !== 'dayEnd') return false;
    if (typeof sim.ensureBootEvent === 'function') sim.ensureBootEvent();
    return !this._userClosed;
  }

  onClose() { this._userClosed = true; }
  onOpen()  { this._userClosed = false; }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;

    this._drawPanelFrame(g, dg, r, used, usedZones, { closeIcon: '–' });

    const ev = sim.currentEvent;
    const isBoot = !!(ev && ev.kind === 'gift');

    // Header
    const headerTitle = isBoot
      ? `🎉 Welcome — Day 1 setup`
      : `📅 Day ${sim.day} Wrap-Up`;
    this._t(used, 'title', headerTitle, r.x + 18, r.y + 14, {
      font: 'bold 20px system-ui', color: '#ffd84d',
    });
    if (isBoot) {
      this._t(used, 'sum', `Pick your starting gift, then begin Day 1.`,
        r.x + 18, r.y + 42, { font: '12px system-ui', color: '#c0b0e0' });
    } else {
      const earned = sim.money - sim.dayStartMoney;
      const earnStr = earned >= 0 ? `+$${earned}` : `−$${-earned}`;
      this._t(used, 'sum', `${earnStr}  ·  served ${sim.stats.served}  ·  angry ${sim.stats.angry}  ·  plates ${sim.stats.plates}  ·  tips $${sim.stats.tipsTotal}`,
        r.x + 18, r.y + 42, { font: '12px system-ui', color: '#c0b0e0' });
    }

    // Body: gift cards on boot, chef cards + stat-check chips otherwise.
    let cy = r.y + 70;
    if (isBoot) {
      cy = this._renderGift(sim, ev, r, dg, used, usedZones, cy);
    } else {
      cy = this._renderChefCards(sim, r, dg, used, cy);
      cy = this._renderEventRow(sim, ev, r, dg, used, usedZones, cy);
    }

    // Forecast line — Start Day button now lives in StartDayApp.
    const fc = sim.nextForecast;
    const fcLabel = (fc && fc.label) || 'Nothing unusual on the books';
    this._t(used, 'fc', `🔮  Tomorrow:  ${fcLabel}`, r.x + 18, r.y + r.h - 50, {
      font: 'bold 12px system-ui', color: '#9be8ff',
    });
    const canStart = !!sim.eventOutcome;
    const footHint = canStart
      ? (isBoot ? 'Open ▶️ Start Day to begin your run.' : 'Open ▶️ Start Day when you’re ready.')
      : (isBoot ? 'Pick a gift to unlock ▶️ Start Day.' : 'Resolve the event to unlock ▶️ Start Day.');
    this._t(used, 'fh', footHint, r.x + 18, r.y + r.h - 28, {
      font: 'italic 11px system-ui', color: canStart ? '#7be68c' : '#ffb84d',
    });

    this._endFrame(used, usedZones);
  }

  /** Red dot on the launcher whenever an unresolved dayEnd event is pending. */
  notification(sim) {
    if (!sim || sim.dayState !== 'dayEnd') return false;
    return !sim.eventOutcome;
  }

  /* ---- Gift cards (boot/Day-1) ------------------------------------------- */
  _renderGift(sim, ev, r, dg, used, usedZones, top) {
    const opts = ev.options || [];
    const cardsTop = top + 10;
    const cardW = (r.w - 36 - 12 * (opts.length - 1)) / Math.max(1, opts.length);
    const cardH = 150;
    const locked = !!sim.eventOutcome;
    const pickedId = locked && sim.eventOutcome.result && sim.eventOutcome.result.giftId;
    this._drawCardGrid(opts,
      { x: r.x + 18, y: cardsTop, cols: Math.max(1, opts.length), cardW, cardH, colGap: 12, rowGap: 0 },
      (opt, cx, cy) => {
        const isPicked = pickedId && pickedId === opt.id;
        if (dg) {
          dg.fillStyle(0x000000, 0.25); dg.fillRoundedRect(cx + 2, cy + 3, cardW, cardH, 8);
          const fill = isPicked ? 0xffb84d : (locked ? 0x322a42 : 0x3d2d5c);
          dg.fillStyle(fill, 1);
          dg.fillRoundedRect(cx, cy, cardW, cardH, 8);
          dg.lineStyle(isPicked ? 3 : 2, isPicked ? 0xffd84d : 0x2a1a1a, isPicked ? 1 : 0.6);
          dg.strokeRoundedRect(cx, cy, cardW, cardH, 8);
        }
        const labelColor = isPicked ? '#1a1428' : (locked ? '#8888a0' : '#ffffff');
        const descColor  = isPicked ? '#3a2233' : (locked ? '#7a6a90' : '#c0b0e0');
        const icon = this._t(used, `gi:${opt.id}:icon`, opt.icon || '🎁',
          cx + cardW / 2, cy + 16, { font: '40px system-ui', color: '#ffffff' });
        if (icon && icon.setOrigin) icon.setOrigin(0.5, 0);
        const label = this._t(used, `gi:${opt.id}:label`, opt.label || opt.id,
          cx + cardW / 2, cy + 70, {
            font: 'bold 14px system-ui', color: labelColor,
          });
        if (label && label.setOrigin) label.setOrigin(0.5, 0);
        const desc = this._t(used, `gi:${opt.id}:desc`, opt.description || '',
          cx + cardW / 2, cy + 96, {
            font: '12px system-ui', color: descColor,
            wordWrap: { width: cardW - 20 }, align: 'center',
          });
        if (desc && desc.setOrigin) desc.setOrigin(0.5, 0);
        if (!locked) {
          this._bindZone(`gi:${opt.id}`, cx, cy, cardW, cardH,
            () => sim.acceptGift(opt.id), usedZones);
        }
      });

    const outY = cardsTop + cardH + 14;
    if (sim.eventOutcome) {
      const o = sim.eventOutcome;
      this._t(used, 'gi:out', `🎁  ${o.msg}`, r.x + 18, outY, {
        font: 'bold 13px system-ui', color: '#7be68c',
        wordWrap: { width: r.w - 36 },
      });
    } else {
      this._t(used, 'gi:hint', 'Pick one — applies immediately.',
        r.x + 18, outY, {
          font: 'italic 12px system-ui', color: '#c0b0e0',
        });
    }
    return outY + 28;
  }

  /* ---- Chef report cards (regular wrap-up) ------------------------------- */
  _renderChefCards(sim, r, dg, used, top) {
    const colW = (r.w - 36 - 12) / 2;
    const cardH = 44;
    const list = sim.employees.slice(0, 8);
    this._drawCardGrid(list,
      { x: r.x + 18, y: top, cols: 2, cardW: colW, cardH, colGap: 12, rowGap: 6 },
      (e, cx, yy) => {
        const busy = e.status && e.status.kind === 'busy';
        if (dg) {
          dg.fillStyle(busy ? 0x2a2233 : 0x3d2d5c, 1);
          dg.fillRoundedRect(cx, yy, colW, cardH, 6);
          dg.lineStyle(2, 0x2a1a1a, 0.6); dg.strokeRoundedRect(cx, yy, colW, cardH, 6);
          const v = e.visual || {};
          const skin = v.skinColor != null ? v.skinColor : 0xfec9a7;
          dg.fillStyle(0x231a30, 1);
          dg.fillRoundedRect(cx + 4, yy + 4, 36, cardH - 8, 4);
          dg.fillStyle(skin, 1);
          dg.fillCircle(cx + 22, yy + cardH / 2, 11);
          dg.lineStyle(1.2, 0x2a1a1a, 1);
          dg.strokeCircle(cx + 22, yy + cardH / 2, 11);
          if ((v.hat != null ? v.hat : 0) === 0) {
            dg.fillStyle(0xffffff, 1);
            dg.fillCircle(cx + 22, yy + cardH / 2 - 7, 5);
            dg.lineStyle(1.2, 0x2a1a1a, 1);
            dg.strokeCircle(cx + 22, yy + cardH / 2 - 7, 5);
          } else if (v.hasHair) {
            dg.fillStyle(v.hairColor != null ? v.hairColor : 0x3a2a1a, 1);
            dg.fillCircle(cx + 22, yy + cardH / 2 - 3, 7);
          }
        }
        const star = e.isStarter ? '★ ' : '';
        this._t(used, `e:${e.id}:n`, `${star}${e.name}`, cx + 46, yy + 4, {
          font: 'bold 12px system-ui', color: '#ffffff',
        });
        this._t(used, `e:${e.id}:s`,
          `D${e.dex} S${e.spd} T${e.str} I${e.int} C${e.cha}`,
          cx + 46, yy + 22, { font: '10px monospace', color: '#c0b0e0' });
        const d = e.dayStats || { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0 };
        this._t(used, `e:${e.id}:d`,
          `🍳${d.dishes} 💰$${d.tipsEarned} 😓${d.timesTired} ✨${d.procs}`,
          cx + colW - 160, yy + 22, { font: '10px system-ui', color: '#ffd84d' });
        let badge = '';
        if (e.status) {
          if (e.status.kind === 'busy')        badge = 'BUSY';
          else if (e.status.kind === 'stressed') badge = 'STRESSED';
          else if (e.status.kind === 'starstruck') badge = '★';
        }
        if (badge) this._t(used, `e:${e.id}:b`, badge, cx + colW - 56, yy + 4, {
          font: 'bold 10px system-ui', color: '#ff7070',
        });
      });
    return top + Math.ceil(Math.min(sim.employees.length, 8) / 2) * (cardH + 6) + 8;
  }

  /* ---- Event row + stat-check chips (regular wrap-up) -------------------- */
  _renderEventRow(sim, ev, r, dg, used, usedZones, top) {
    if (!ev) return top;
    const tag = sim.eventOutcome ? '✓ Resolved' : '⚠ Pending';
    const color = sim.eventOutcome ? '#7be68c' : '#ffb84d';
    this._t(used, 'ev:status', `${ev.icon || '⚠️'}  ${ev.title}  ·  ${tag}`, r.x + 18, top, {
      font: 'bold 13px system-ui', color,
    });
    this._t(used, 'ev:flavor', ev.flavor || '', r.x + 18, top + 18, {
      font: 'italic 11px system-ui', color: '#d8d0e8',
      wordWrap: { width: r.w - 40 },
    });

    const dc = typeof ev.dc === 'function' ? ev.dc(sim.day) : ev.dc;
    this._t(used, 'sc:dc', `Check ${ev.statLabel || (ev.stat || '').toUpperCase()} · DC ${dc} (1d10 + stat)`,
      r.x + 18, top + 40, { font: 'bold 11px system-ui', color: '#ffd84d' });

    const chefs = (typeof sim.eligibleChefsForEvent === 'function' ? sim.eligibleChefsForEvent() : []) || [];
    const chipW = 130, chipH = 26;
    const chipsPerRow = Math.max(1, Math.floor((r.w - 36) / (chipW + 6)));
    const chipsTop = top + 60;
    const locked = !!sim.eventOutcome;
    chefs.slice(0, 12).forEach((chef, i) => {
      const col = i % chipsPerRow, row = (i / chipsPerRow) | 0;
      const cx = r.x + 18 + col * (chipW + 6);
      const cy = chipsTop + row * (chipH + 4);
      const picked = sim.eventOutcome && sim.eventOutcome.chef === chef;
      if (dg) {
        if (picked) { dg.fillStyle(0xffd84d, 0.35); dg.fillRoundedRect(cx - 4, cy - 3, chipW + 8, chipH + 6, 8); }
        const fill = picked ? 0x5fd97e : (locked ? 0x322a42 : 0x5a4ab0);
        dg.fillStyle(fill, 1); dg.fillRoundedRect(cx, cy, chipW, chipH, 4);
        dg.lineStyle(picked ? 3 : 2, picked ? 0xffd84d : 0x2a1a1a, picked ? 1 : 0.6);
        dg.strokeRoundedRect(cx, cy, chipW, chipH, 4);
      }
      const sv = Math.round(chef.effStat ? chef.effStat(ev.stat) : 0);
      const prefix = picked ? '✓ ' : '';
      this._t(used, `sc:${chef.id}`, `${prefix}${(chef.name || '').split(' ')[0]} (${ev.statLabel || (ev.stat || '').toUpperCase()} ${sv})`,
        cx + 8, cy + 6, {
          font: 'bold 10px system-ui',
          color: picked ? '#1a1428' : (locked ? '#8888a0' : '#ffffff'),
        });
      if (!locked) this._bindZone(`sc:${chef.id}`, cx, cy, chipW, chipH,
        () => sim.resolveEvent(chef.id), usedZones);
    });

    const outY = chipsTop + Math.ceil(Math.max(1, chefs.length) / chipsPerRow) * (chipH + 4) + 8;
    if (sim.eventOutcome) {
      const o = sim.eventOutcome;
      const otag = o.passed ? 'PASSED' : 'FAILED';
      const stat = ev.stat ? Math.round((o.chef && o.chef.effStat) ? o.chef.effStat(ev.stat) : 0) : 0;
      this._t(used, 'sc:out', `${otag} (roll ${o.roll}+${stat}=${Math.round(o.total)} vs ${o.dc}) ${o.msg}`,
        r.x + 18, outY, {
          font: 'bold 11px system-ui', color: o.passed ? '#7be68c' : '#ff7070',
          wordWrap: { width: r.w - 40 },
        });
    }
    return outY + 18;
  }

  describe(sim) {
    const ev = sim && sim.currentEvent;
    return Object.assign(super.describe(), {
      eventResolved: sim ? !!sim.eventOutcome : null,
      eventId:       ev ? ev.id : null,
      eventKind:     ev ? (ev.kind || 'event') : null,
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { DayEndApp };
