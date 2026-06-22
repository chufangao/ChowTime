/* ============================================================================
 * src/ui/apps/map_tools.js — Map-tool apps (Move, Sell)
 * ============================================================================
 * Map-tool apps share `hasPanel: false` + `lockedDuringService: true`. They
 * activate a cursor mode while open: GameScene routes the next map click
 * through forwardMapClick → onMapClick. Layout-edit gating (dayState ===
 * 'dayEnd' or sim.debug) is enforced by GameScene before forwarding.
 *
 *   Move — first click "picks up" a building, second click drops it on an
 *          empty tile. Right-click cancels (handled by GameScene). Picked-up
 *          state lives on the app instance, so onDeactivate clears it.
 *   Sell — single click removes a building (refund applied by Simulation
 *          .removeBuildingAt at CONFIG.refundRatio).
 * ========================================================================== */

class MapToolApp extends App {
  constructor(opts) {
    super(Object.assign({}, opts, { hasPanel: false, lockedDuringService: true }));
  }
}

// Helpers: classify a tile as a movable thing (building or player wall).
// Default-layout obstacles are now gaps, which the Sell/Move tools leave
// alone — buy a Floor tile from Build to fill them.
function _isPickupTile(t) {
  if (!t) return false;
  if (t.building) return true;
  if (t.type === 'wall') return true;   // only player walls exist now
  return false;
}

class MoveApp extends MapToolApp {
  constructor() {
    super({ id: 'move', icon: '↔', title: 'Move' });
    this.movingFrom = null;     // {x, y, kind:'building'|'player_wall'} once picked up
  }

  onMapClick(sim, tile, _button) {
    if (!tile) return;
    if (!this.movingFrom) {
      const t = sim.grid.getTile(tile.x, tile.y);
      if (!_isPickupTile(t)) return;
      const kind = t.building ? 'building' : 'player_wall';
      this.movingFrom = { x: tile.x, y: tile.y, kind };
    } else {
      let res;
      if (this.movingFrom.kind === 'player_wall') {
        // Move = remove + place. Both free for player walls.
        const dst = sim.grid.getTile(tile.x, tile.y);
        if (!dst || dst.type !== 'floor' || dst.building) {
          res = { ok: false, reason: 'invalid-target' };
        } else {
          const removed = sim.removeWallAt(this.movingFrom.x, this.movingFrom.y);
          if (!removed.ok) { res = removed; }
          else {
            res = sim.placeWall(tile.x, tile.y, 'player');
            // If placement somehow failed (shouldn't, given dst checks),
            // restore the source wall to keep the world consistent.
            if (!res.ok) sim.placeWall(this.movingFrom.x, this.movingFrom.y, 'player');
          }
        }
      } else {
        res = sim.moveBuilding(this.movingFrom.x, this.movingFrom.y, tile.x, tile.y);
      }
      if (res && res.ok) this.movingFrom = null;
    }
  }

  /** Whether (x,y) is a valid target for the current phase (pickup or drop).
   *  Used by the scene's hover preview. */
  isValidAt(sim, x, y) {
    const t = sim.grid.getTile(x, y); if (!t) return false;
    if (!this.movingFrom) return _isPickupTile(t);
    if (this.movingFrom.x === x && this.movingFrom.y === y) return false;
    if (this.movingFrom.kind === 'player_wall') {
      return t.type === 'floor' && !t.building;
    }
    return !t.building && t.type === 'floor';
  }

  onDeactivate(_sim) { this.movingFrom = null; }
  cancelPickup()     { this.movingFrom = null; }

  describe() {
    return Object.assign(super.describe(), {
      hasPickup: !!this.movingFrom,
      pickup:    this.movingFrom ? { x: this.movingFrom.x, y: this.movingFrom.y, kind: this.movingFrom.kind } : null,
    });
  }
}

class SellApp extends MapToolApp {
  constructor() { super({ id: 'sell', icon: '🏷', title: 'Sell' }); }

  onMapClick(sim, tile, _button) {
    if (!tile) return;
    const t = sim.grid.getTile(tile.x, tile.y);
    if (!t) return;
    if (t.building) { sim.removeBuildingAt(tile.x, tile.y); return; }
    if (t.type === 'wall') { sim.removeWallAt(tile.x, tile.y); return; }
  }

  isValidAt(sim, x, y) {
    const t = sim.grid.getTile(x, y);
    if (!t) return false;
    if (t.building) return true;
    if (t.type === 'wall') return true;   // affordability is checked at click-time
    return false;
  }
}

// Repair: clicking a broken building pays half its purchase price to fix it.
// Unlike Sell/Move, Repair is NOT locked during service — broken furniture is
// most punishing mid-shift, so the player can repair on the fly. Affordability
// is checked at click-time by sim.repairBuilding.
class RepairApp extends MapToolApp {
  constructor() {
    super({ id: 'repair', icon: '🔧', title: 'Repair' });
    // Override: allow during live service so broken furniture can be fixed
    // without waiting for dayEnd.
    this.lockedDuringService = false;
  }

  onMapClick(sim, tile, _button) {
    if (!tile) return;
    sim.repairBuilding(tile.x, tile.y);
  }

  isValidAt(sim, x, y) {
    const t = sim.grid.getTile(x, y);
    return !!(t && t.building && t.building.broken);
  }
}

// Rotate: clicking a building cycles its facing (N → E → S → W → N).
// Currently only chairs render facing differently; other buildings carry the
// flag for future-sprite use but look the same. Locked during service so the
// player doesn't yank a chair under a seated customer mid-shift.
class RotateApp extends MapToolApp {
  constructor() { super({ id: 'rotate', icon: '🔄', title: 'Rotate' }); }

  onMapClick(sim, tile, _button) {
    if (!tile) return;
    const t = sim.grid.getTile(tile.x, tile.y);
    if (!t || !t.building) return;
    const b = t.building;
    // Cycle through the four cardinal directions. null → 0 → 1 → 2 → 3 → 0.
    const cur = (b.facing == null) ? -1 : (b.facing | 0);
    b.facing = (cur + 1) % 4;
  }

  isValidAt(sim, x, y) {
    const t = sim.grid.getTile(x, y);
    return !!(t && t.building);
  }
}

// Assign: clicking a placed chef spawn point opens the chef picker focused on
// that pad. Pure router — the actual assign/unassign toggles live in
// AssignPickerApp. Locked during service (assignment is a between-day edit).
class AssignApp extends MapToolApp {
  constructor() { super({ id: 'assign', icon: '👨‍🍳', title: 'Assign' }); }

  onMapClick(sim, tile, _button) {
    if (!tile) return;
    const t = sim.grid.getTile(tile.x, tile.y);
    if (!t || !t.building || t.building.type !== 'chef_spawn') return;
    const picker = this.manager && this.manager.get && this.manager.get('assignPicker');
    if (!picker) return;
    picker.target = { x: tile.x, y: tile.y };
    this.manager.open('assignPicker');
  }

  isValidAt(sim, x, y) {
    const t = sim.grid.getTile(x, y);
    return !!(t && t.building && t.building.type === 'chef_spawn');
  }
}

// Place Room: stamps a granted expansion-room config (floor + furniture) into
// the void with a single click. A multi-tile ghost follows the cursor (drawn by
// the scene) showing the furnished footprint + valid/invalid tint; the room is
// never rotated (configs are placed as authored). The tool is hidden from the
// bar unless a room grant is pending. Locked during service (a between-day
// edit, like Move). Single-phase: no pickup state — the active config is just
// the first pending grant.
class PlaceRoomApp extends MapToolApp {
  constructor() {
    super({ id: 'place_room', icon: '🏗', title: 'Add Room' });
    this.configId = null;
  }

  // The config currently being placed = the first pending grant. Re-read on
  // open and on each click so it tracks the queue as rooms are placed.
  _syncConfigId(sim) {
    const s = sim || (this.manager && this.manager._sim);
    this.configId = (s && s._pendingRooms && s._pendingRooms[0]) || null;
    return this.configId;
  }

  _config() {
    if (!this.configId || typeof ROOM_CONFIGS === 'undefined') return null;
    return ROOM_CONFIGS.find(c => c.id === this.configId) || null;
  }

  onOpen() { this._syncConfigId(); }

  onMapClick(sim, tile, _button) {
    if (!tile) return;
    if (!this.configId) this._syncConfigId(sim);
    if (!this.configId) return;
    const res = sim.placeRoom(this.configId, tile.x, tile.y);
    if (res && res.ok) {
      // Advance to the next pending grant; close the tool when none remain.
      this._syncConfigId(sim);
      if (!this.configId && this.manager) this.manager.close();
    }
  }

  // Whole-room validity at anchor (x,y) — drives the ghost's valid/invalid tint.
  isValidAt(sim, x, y) {
    const cfg = this._config();
    if (!cfg) return false;
    return sim.roomPlacement(cfg, x, y).ok;
  }

  // Hidden from the top bar unless a room is waiting to be placed; the red dot
  // fires whenever the queue is non-empty.
  hiddenInBar(sim) { return !(sim && sim._pendingRooms && sim._pendingRooms.length); }
  notification(sim) { return !!(sim && sim._pendingRooms && sim._pendingRooms.length); }

  onDeactivate(_sim) { this.configId = null; }

  describe() {
    return Object.assign(super.describe(), { configId: this.configId });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MapToolApp, MoveApp, SellApp, RepairApp, RotateApp, AssignApp, PlaceRoomApp };
}
