/* ============================================================================
 * src/ui/apps/game_over_app.js — Game over screen, blocks all input
 * ============================================================================
 * Auto-opens (and stays open) when sim.gameOver is true. Modal — backdrop
 * click does nothing; only Restart closes the run.
 * ========================================================================== */

class GameOverApp extends App {
  constructor() {
    super({ id: 'game_over', icon: '☠', title: 'Game Over', isModal: true });
    this._panelBgDepth = 910;
  }
  panelRect() {
    if (!this.scene) return null;
    return this._centeredRect(460, 260);
  }
  autoOpenWhen(sim) { return !!(sim && sim.gameOver); }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;

    this._drawPanelFrame(g, dg, r, used, usedZones, {
      backdropAlpha: 0.75, border: 0xff6666, radius: 12, closeX: false,
    });
    this._t(used, 't', '☠  Game Over  ☠', r.x + r.w / 2 - 90, r.y + 16, {
      font: 'bold 24px system-ui', color: '#ff6666',
    });
    this._t(used, 's', 'Too many hangry customers walked out.', r.x + r.w / 2 - 130, r.y + 60, {
      font: 'italic 13px system-ui', color: '#c0b0e0',
    });
    const lines = [
      `Day reached:  ${sim.day}`,
      `Final cash:  $${sim.money}`,
      `Customers served:  ${sim.runStats.served}`,
      `Tips earned:  $${sim.runStats.tipsTotal}`,
    ];
    lines.forEach((line, i) =>
      this._t(used, `l${i}`, line, r.x + r.w / 2 - 90, r.y + 96 + i * 22, {
        font: '13px system-ui', color: '#ffffff',
      })
    );
    this._drawPanelButton('restart', r.x + r.w / 2 - 80, r.y + r.h - 62, 160, 44, {
      label: '↻ Restart', font: 'bold 16px system-ui',
      fill: 0x4a9e5c,
      labelX: r.x + r.w / 2 - 36, labelY: r.y + r.h - 50,
      onClick: () => { if (typeof window !== 'undefined' && window.location) window.location.reload(); },
    }, used, usedZones);

    this._endFrame(used, usedZones);
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { GameOverApp };
