/* ============================================================================
 * src/ui/apps/start_day_app.js — Dedicated Start Day / Begin Run panel
 * ============================================================================
 * Split out from DayEndApp so the Start Day button can't be hit by accident
 * while the player is resolving the dayEnd event. The panel is intentionally
 * minimal: forecast line + one big button. A red notification dot lights up
 * on its launcher whenever the day is ready to start (sim.eventOutcome set).
 * ========================================================================== */

class StartDayApp extends App {
  constructor() { super({ id: 'start_day', icon: '▶️', title: 'Start Day' }); }

  panelRect() {
    if (!this.scene) return null;
    return this._centeredRect(420, 220);
  }

  /** Red dot on the launcher whenever the day is ready to begin. */
  notification(sim) {
    if (!sim) return false;
    if (sim.dayState !== 'dayEnd') return false;
    return !!sim.eventOutcome;
  }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;

    this._drawPanelFrame(g, dg, r, used, usedZones, { radius: 12 });

    const isBoot = !!(sim.currentEvent && sim.currentEvent.kind === 'gift');
    const ready = !!sim.eventOutcome && sim.dayState === 'dayEnd';

    const title = isBoot ? '▶️ Begin Run' : `▶️ Start Day ${(sim.day || 0) + 1}`;
    this._t(used, 'title', title, r.x + 18, r.y + 14, {
      font: 'bold 18px system-ui', color: '#ffd84d',
    });

    const fc = sim.nextForecast;
    const fcLabel = (fc && fc.label) || 'Nothing unusual on the books';
    this._t(used, 'fc', `🔮  ${fcLabel}`, r.x + 18, r.y + 56, {
      font: 'bold 12px system-ui', color: '#9be8ff',
      wordWrap: { width: r.w - 36 },
    });

    const hint = ready
      ? (isBoot ? 'Ready to begin your run.' : 'Day is ready — best of luck.')
      : (isBoot ? 'Pick a starting gift in 📅 Review first.'
                : 'Resolve the day-end event in 📅 Review first.');
    this._t(used, 'hint', hint, r.x + 18, r.y + 84, {
      font: '12px system-ui', color: ready ? '#c0b0e0' : '#ffb0b0',
      wordWrap: { width: r.w - 36 },
    });

    // Big centered button.
    const bw = 240, bh = 52;
    const bx = r.x + (r.w - bw) / 2, by = r.y + r.h - bh - 22;
    const label = ready
      ? (isBoot ? 'Begin Run →' : 'Start Day →')
      : (isBoot ? 'Pick a gift first' : 'Resolve event first');
    this._drawPanelButton('startDay', bx, by, bw, bh, {
      label, font: 'bold 16px system-ui',
      fill: ready ? 0x4a9e5c : 0x555566,
      radius: 10, shadow: false,
      centerLabel: true,
      enabled: ready,
      onClick: () => { sim.startNextDay(); if (this.manager) this.manager.close(); },
    }, used, usedZones);

    this._endFrame(used, usedZones);
  }

  describe(sim) {
    return Object.assign(super.describe(), {
      ready: !!(sim && sim.eventOutcome && sim.dayState === 'dayEnd'),
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { StartDayApp };
