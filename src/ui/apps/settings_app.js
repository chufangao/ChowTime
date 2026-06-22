/* ============================================================================
 * src/ui/apps/settings_app.js — Speed, Debug, Save, Load
 * ============================================================================
 * Centered overlay panel. Quick controls that don't fit anywhere else.
 *
 *   - Speed: cycles through CONFIG.speedLevels (1×, 2×, 4×).
 *   - Debug: toggles sim.debug (free buildings, no rage-quit penalties).
 *   - Save: serializes the sim + UI state to JSON, hands the JSON to
 *           scene.onSaveRequested(json) which the browser layer wires up
 *           to a download. Allowed only at dayState === 'dayEnd' so we don't
 *           need to serialize in-flight projectiles.
 *   - Load: triggers scene.onLoadRequested() which the browser layer wires
 *           up to a hidden file input.
 * ========================================================================== */

class SettingsApp extends App {
  constructor() { super({ id: 'settings', icon: '⚙', title: 'Settings' }); }
  panelRect() {
    if (!this.scene) return null;
    return this._centeredRect(460, 440);
  }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;

    this._drawPanelFrame(g, dg, r, used, usedZones, { radius: 12 });
    this._t(used, 't', '⚙ Settings', r.x + 18, r.y + 14, { font: 'bold 18px system-ui', color: '#ffd84d' });

    // --- Speed row ---
    this._t(used, 'sp:l', 'Speed', r.x + 18, r.y + 60, { font: 'bold 14px system-ui', color: '#fff' });
    const speedLevels = (typeof CONFIG !== 'undefined' && CONFIG.speedLevels) || [1, 2, 4];
    const cur = (sim && sim._uiSpeed) || 1;
    let sx = r.x + 100;
    for (const lv of speedLevels) {
      const active = (cur === lv);
      this._drawPanelButton(`sp:${lv}`, sx, r.y + 56, 50, 30, {
        label: `${lv}×`, font: 'bold 13px system-ui',
        color: active ? '#1a1428' : '#fff',
        fill: active ? 0xffb84d : 0x3d2d5c,
        radius: 6, shadow: false, border: false,
        labelX: sx + 14, labelY: r.y + 62,
        onClick: () => { if (sim) sim._uiSpeed = lv; },
      }, used, usedZones);
      sx += 50 + 6;
    }

    // --- Debug toggle ---
    const debugOn = !!(sim && sim.debug);
    this._t(used, 'd:l', 'Debug Mode', r.x + 18, r.y + 110, { font: 'bold 14px system-ui', color: '#fff' });
    this._drawPanelButton('debug', r.x + 140, r.y + 106, 100, 30, {
      label: debugOn ? 'ON' : 'OFF', font: 'bold 13px system-ui',
      fill: debugOn ? 0x2d6a3c : 0x3d2d5c,
      radius: 6, shadow: false, border: false,
      labelX: r.x + 178, labelY: r.y + 112,
      onClick: () => { if (sim) sim.debug = !sim.debug; },
    }, used, usedZones);

    // Debug-only test actions: break every building / repair every building.
    // Useful to exercise the Repair toolbar tool + the broken-furniture
    // visual + the speed penalty without waiting for a midday-event penalty.
    if (debugOn) {
      this._t(used, 'dt:l', 'Test Actions', r.x + 18, r.y + 144, {
        font: 'bold 11px system-ui', color: '#9be8ff',
      });
      this._drawPanelButton('break_all', r.x + 18, r.y + 162, 372, 30, {
        label: '💥 Break All Furniture', font: 'bold 12px system-ui',
        fill: 0xa33d3d, color: '#ffffff',
        radius: 6, shadow: false, border: false,
        labelX: r.x + 130, labelY: r.y + 169,
        onClick: () => {
          if (!sim || typeof sim.breakAllBuildings !== 'function') return;
          sim.breakAllBuildings();
        },
      }, used, usedZones);
      // Force a midday event right now (any state). Skips the random gate
      // so the player can preview the modal immediately.
      this._drawPanelButton('force_midday', r.x + 18, r.y + 200, 372, 30, {
        label: '⚡ Trigger Midday Event', font: 'bold 12px system-ui',
        fill: 0x5a4ab0, color: '#ffffff',
        radius: 6, shadow: false, border: false,
        labelX: r.x + 130, labelY: r.y + 207,
        onClick: () => {
          if (!sim || !sim.eventManager) return;
          if (sim.middayEvent || sim.middayOutcome) return;
          const ev = sim.eventManager._pickMiddayEvent
            ? sim.eventManager._pickMiddayEvent()
            : (typeof rollMiddayEvent === 'function' ? rollMiddayEvent(sim.day) : null);
          if (!ev) return;
          // Force-start even if the current dayState isn't spawning/draining
          // (e.g. dayEnd) by temporarily flipping to spawning. The pause
          // mechanic will restore on dismiss.
          if (sim.dayState !== 'spawning' && sim.dayState !== 'draining') {
            sim.preMiddayState = sim.dayState;
            sim.dayState = 'spawning';
          }
          sim.eventManager.startMiddayEvent(ev);
        },
      }, used, usedZones);
      // Grant a room right now (the room-grant event's effect, on demand) so
      // the player can exercise the Add Room tool without waiting for day 3.
      this._drawPanelButton('grant_room', r.x + 18, r.y + 238, 372, 30, {
        label: '🏗 Grant Room', font: 'bold 12px system-ui',
        fill: 0x3c7e49, color: '#ffffff',
        radius: 6, shadow: false, border: false,
        labelX: r.x + 150, labelY: r.y + 245,
        onClick: () => {
          if (sim && typeof sim.grantRandomRoom === 'function') sim.grantRandomRoom();
        },
      }, used, usedZones);
      // Toggle the FPS / frame-time overlay (read-only instrumentation; lets us
      // A/B performance changes). Flips a window flag the scene reads each frame.
      const perfOn = (typeof window !== 'undefined' && !!window.__chowPerf);
      this._drawPanelButton('perf', r.x + 18, r.y + 276, 372, 30, {
        label: perfOn ? '📊 FPS Overlay: ON' : '📊 FPS Overlay: OFF', font: 'bold 12px system-ui',
        fill: perfOn ? 0x2d6a3c : 0x3d2d5c, color: '#ffffff',
        radius: 6, shadow: false, border: false,
        labelX: r.x + 150, labelY: r.y + 283,
        onClick: () => { if (typeof window !== 'undefined') window.__chowPerf = !window.__chowPerf; },
      }, used, usedZones);
    }

    // --- Save / Load ---
    // Shift down to make room for debug test actions when debug is on. We
    // keep a single y offset so the section doesn't jump as debug toggles.
    const slY = debugOn ? r.y + 324 : r.y + 160;
    const canSave = sim && sim.dayState === 'dayEnd';
    this._t(used, 'sl:l', 'Save / Load', r.x + 18, slY, { font: 'bold 14px system-ui', color: '#fff' });
    this._drawPanelButton('save', r.x + 18, slY + 24, 180, 36, {
      label: canSave ? '💾 Save Game' : '💾 Save (only at day-end)',
      font: 'bold 13px system-ui',
      fill: canSave ? 0x4a9e5c : 0x555566,
      shadow: false, border: false,
      labelX: r.x + 28, labelY: slY + 34,
      enabled: !!canSave,
      onClick: () => { if (this.scene.onSaveRequested) this.scene.onSaveRequested(); },
    }, used, usedZones);
    this._drawPanelButton('load', r.x + 210, slY + 24, 180, 36, {
      label: '📂 Load Game', font: 'bold 13px system-ui',
      fill: 0x4a90e2,
      shadow: false, border: false,
      labelX: r.x + 232, labelY: slY + 34,
      onClick: () => { if (this.scene.onLoadRequested) this.scene.onLoadRequested(); },
    }, used, usedZones);

    this._t(used, 'note', 'Saving is gated to between-day pauses to keep saves clean (no in-flight food).',
      r.x + 18, slY + 72, {
        font: 'italic 11px system-ui', color: '#9a8ac0',
        wordWrap: { width: r.w - 36 },
      });

    this._endFrame(used, usedZones);
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { SettingsApp };
