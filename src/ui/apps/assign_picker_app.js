/* ============================================================================
 * src/ui/apps/assign_picker_app.js — Assign chefs to a chef spawn point
 * ============================================================================
 * Opened by AssignApp (the 👨‍🍳 map tool) when the player clicks a placed
 * chef_spawn building. `this.target` is the {x,y} of that pad, set by AssignApp
 * before open. The panel lists every hired chef; clicking a row toggles whether
 * that chef starts its shift at this pad (employee.spawnPoint).
 *
 * launcherHidden keeps it off the top bar (it's only reachable via the tool).
 * Locked during service like the other layout-edit surfaces.
 * ========================================================================== */

class AssignPickerApp extends App {
  constructor() {
    super({ id: 'assignPicker', icon: '👨‍🍳', title: 'Assign Chefs', lockedDuringService: true });
    this.launcherHidden = true;
    this.target   = null;     // {x,y} of the chef_spawn pad being edited
    this.scrollRow = 0;
  }

  panelRect() {
    if (!this.scene) return null;
    const W = this.scene.gameWidth || 1100;
    const H = this.scene.gameHeight || 600;
    const w = Math.min(520, Math.floor(W * 0.7));
    const h = Math.min(480, Math.floor((H - this._topBarH()) * 0.9));
    return this._centeredRect(w, h);
  }

  onOpen()  { this.scrollRow = 0; }
  onClose() { this.target = null; }

  // True when (x,y) is the pad this picker is editing.
  _isHere(sp) {
    return !!(sp && this.target && sp.x === this.target.x && sp.y === this.target.y);
  }

  onWheel(_p, dy) {
    const sim = this.manager && this.manager._sim;
    const n = (sim && sim.employees) ? sim.employees.length : 0;
    const rows = this._visibleRows();
    const maxRow = Math.max(0, n - rows);
    if (maxRow === 0) return;
    this.scrollRow = Math.max(0, Math.min(maxRow, this.scrollRow + (dy > 0 ? 1 : -1)));
  }

  _visibleRows() { return 5; }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;

    this._drawPanelFrame(g, dg, r, used, usedZones);

    const padNo = (this.target && sim && sim.chefSpawnLabelAt)
      ? sim.chefSpawnLabelAt(this.target.x, this.target.y) : null;
    this._t(used, 'title', padNo ? `👨‍🍳 Assign to Pad #${padNo}` : '👨‍🍳 Assign Chefs', r.x + 18, r.y + 14, {
      font: 'bold 20px system-ui', color: '#ffd84d',
    });
    const sub = this.target
      ? 'Tap a chef to assign them to this pad. Green = already here.'
      : 'Pick a chef spawn point with the 👨‍🍳 tool first.';
    this._t(used, 'sub', sub, r.x + 18, r.y + 42, { font: '12px system-ui', color: '#c0b0e0' });

    const employees = (sim && sim.employees) || [];
    if (!this.target || employees.length === 0) {
      this._t(used, 'empty',
        employees.length === 0 ? 'No chefs hired yet.' : 'No spawn point selected.',
        r.x + r.w / 2 - 90, r.y + r.h / 2 - 8, { font: 'bold 14px system-ui', color: '#c0b0e0' });
      this._endFrame(used, usedZones);
      return;
    }

    const rows  = this._visibleRows();
    const cardW = r.w - 36;
    const cardH = 56;
    const gridY = r.y + 70;
    const maxRow = Math.max(0, employees.length - rows);
    this.scrollRow = Math.max(0, Math.min(maxRow, this.scrollRow));
    const windowed = employees.slice(this.scrollRow, this.scrollRow + rows);

    this._drawCardGrid(windowed, { x: r.x + 18, y: gridY, cols: 1, cardW, cardH, colGap: 0, rowGap: 8 },
      (e, cx, cy) => {
        const here = this._isHere(e.spawnPoint);
        if (dg) {
          dg.fillStyle(0x000000, 0.25); dg.fillRoundedRect(cx + 2, cy + 3, cardW, cardH, 8);
          dg.fillStyle(here ? 0x4a9e5c : 0x3d2d5c, 1);
          dg.fillRoundedRect(cx, cy, cardW, cardH, 8);
          dg.lineStyle(2, 0x2a1a1a, 0.6); dg.strokeRoundedRect(cx, cy, cardW, cardH, 8);
          dg.fillStyle(0x231a30, 1); dg.fillRoundedRect(cx + 8, cy + 8, 40, 40, 6);
          if (typeof Sprites !== 'undefined' && Sprites.chefPortrait) {
            Sprites.chefPortrait(dg, e, cx + 28, cy + 28);
          }
        }
        this._t(used, `e:${e.id}:name`, e.name || 'Chef', cx + 58, cy + 8, {
          font: 'bold 14px system-ui', color: '#ffffff',
        });
        let status;
        if (here) {
          status = '✓ spawns here';
        } else if (e.spawnPoint) {
          const otherNo = sim.chefSpawnLabelAt
            ? sim.chefSpawnLabelAt(e.spawnPoint.x, e.spawnPoint.y) : null;
          status = otherNo ? `→ Pad #${otherNo}` : `→ pad (${e.spawnPoint.x}, ${e.spawnPoint.y})`;
        } else {
          status = '→ default door';
        }
        this._t(used, `e:${e.id}:status`, status, cx + 58, cy + 30, {
          font: '12px system-ui', color: here ? '#bff5c8' : '#c0b0e0',
        });
        this._t(used, `e:${e.id}:act`, here ? 'Unassign' : 'Assign', cx + cardW - 96, cy + 18, {
          font: 'bold 13px system-ui', color: here ? '#ffd0d0' : '#ffd84d',
        });
        this._bindZone(`row:${e.id}`, cx, cy, cardW, cardH, () => {
          if (this._isHere(e.spawnPoint)) e.spawnPoint = null;
          else if (this.target)          e.spawnPoint = { x: this.target.x, y: this.target.y };
        }, usedZones);
      });

    // Scroll indicator.
    if (maxRow > 0 && dg) {
      const trackX = r.x + r.w - 14, trackY = gridY, trackH = rows * (cardH + 8) - 8, trackW = 4;
      dg.fillStyle(0x231a30, 1); dg.fillRoundedRect(trackX, trackY, trackW, trackH, 2);
      const thumbH = Math.max(20, Math.floor(trackH * (rows / employees.length)));
      const thumbY = trackY + Math.floor((trackH - thumbH) * (this.scrollRow / maxRow));
      dg.fillStyle(0x6b5ba8, 1); dg.fillRoundedRect(trackX, thumbY, trackW, thumbH, 2);
    }

    this._endFrame(used, usedZones);
  }

  describe(sim) {
    return Object.assign(super.describe(), {
      target: this.target ? { x: this.target.x, y: this.target.y } : null,
      chefCount: sim ? sim.employees.length : 0,
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { AssignPickerApp };
