/* ============================================================================
 * sim/grid.js — Grid (tile map + building registry) and Pathfinder (A*)
 * ============================================================================ */

/* ---- Grid + pathfinding ---------------------------------------------------- */
class Grid {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows; this.tiles = [];
    for (let y = 0; y < rows; y++) {
      const row = [];
      for (let x = 0; x < cols; x++) row.push({ x, y, type: 'floor', building: null });
      this.tiles.push(row);
    }
    // Monotonically increasing counter bumped whenever a tile type changes.
    // FloorRenderer reads this to decide whether to reconcile its sprites,
    // replacing the old per-frame 144-tile hash in scene.js.
    this.floorVersion = 0;
  }
  inBounds(x, y) { return x >= 0 && x < this.cols && y >= 0 && y < this.rows; }
  getTile(x, y) { return this.inBounds(x, y) ? this.tiles[y][x] : null; }
  setType(x, y, type) {
    const t = this.getTile(x, y);
    if (!t || t.type === type) return;
    t.type = type;
    this.floorVersion++;
  }
  isWalkable(x, y) {
    const t = this.getTile(x, y);
    if (!t || t.type === 'wall' || t.type === 'gap') return false;
    if (t.building && !t.building.walkable) return false;
    return true;
  }
  placeBuilding(b, x, y) {
    const t = this.getTile(x, y);
    if (!t || t.building || t.type === 'wall' || t.type === 'gap') return false;
    t.building = b; b.tile = t; b.x = x; b.y = y;
    return true;
  }
  removeBuildingAt(x, y) {
    const t = this.getTile(x, y); if (!t || !t.building) return null;
    const b = t.building; t.building = null; b.tile = null; return b;
  }
  neighbors4(x, y) {
    const out = [];
    if (this.inBounds(x+1, y)) out.push({ x: x+1, y });
    if (this.inBounds(x-1, y)) out.push({ x: x-1, y });
    if (this.inBounds(x, y+1)) out.push({ x, y: y+1 });
    if (this.inBounds(x, y-1)) out.push({ x, y: y-1 });
    return out;
  }
}

class Pathfinder {
  constructor(grid) { this.grid = grid; }
  findPath(sx, sy, targetFn, walkableFn) {
    walkableFn = walkableFn || ((x, y) => this.grid.isWalkable(x, y));
    const key = (x, y) => y * 1024 + x;
    let approx = { x: sx, y: sy };
    outer: for (let y = 0; y < this.grid.rows; y++)
      for (let x = 0; x < this.grid.cols; x++)
        if (targetFn(x, y)) { approx = { x, y }; break outer; }
    const h = (x, y) => Math.abs(x - approx.x) + Math.abs(y - approx.y);
    const open = new Map(), closed = new Set();
    const start = { x: sx, y: sy, g: 0, f: h(sx, sy), parent: null };
    open.set(key(sx, sy), start);
    let iters = 0;
    while (open.size && iters++ < 4000) {
      let curK = null, cur = null;
      for (const [k, n] of open) if (!cur || n.f < cur.f) { cur = n; curK = k; }
      if (targetFn(cur.x, cur.y)) {
        const path = []; let n = cur;
        while (n) { path.unshift({ x: n.x, y: n.y }); n = n.parent; }
        return path;
      }
      open.delete(curK); closed.add(curK);
      for (const nb of this.grid.neighbors4(cur.x, cur.y)) {
        const k = key(nb.x, nb.y);
        if (closed.has(k)) continue;
        const isGoal = targetFn(nb.x, nb.y);
        if (!isGoal && !walkableFn(nb.x, nb.y)) continue;
        const g = cur.g + 1;
        const existing = open.get(k);
        if (existing && existing.g <= g) continue;
        open.set(k, { x: nb.x, y: nb.y, g, f: g + h(nb.x, nb.y), parent: cur });
      }
    }
    return null;
  }
}
