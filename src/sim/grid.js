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

// Binary min-heap for A* open nodes. Ordered by f, then by `seq` (a node's
// first-insertion order) so ties resolve exactly the way the previous
// linear-scan-over-a-Map did — earliest-inserted equal-f node wins. This keeps
// the returned path byte-identical to the old implementation (the test suite is
// tie-break-sensitive), while turning the per-iteration min-selection from O(n)
// into O(log n).
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  _less(x, y) { return x.f < y.f || (x.f === y.f && x.seq < y.seq); }
  push(node) {
    const a = this.a; a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._less(a[i], a[p])) { const t = a[i]; a[i] = a[p]; a[p] = t; i = p; }
      else break;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; this._sink(0); }
    return top;
  }
  _sink(i) {
    const a = this.a, n = a.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2; let m = i;
      if (l < n && this._less(a[l], a[m])) m = l;
      if (r < n && this._less(a[r], a[m])) m = r;
      if (m === i) break;
      const t = a[i]; a[i] = a[m]; a[m] = t; i = m;
    }
  }
}

class Pathfinder {
  constructor(grid) { this.grid = grid; }

  // Shared A* core. `isGoal(x,y)` decides the goal; `anchor` seeds the Manhattan
  // heuristic. A goal tile need not be walkable (e.g. a chair) — it's accepted
  // as a goal even though entities can't stand on it. Used by both findPath
  // (arbitrary predicate) and findPathToTargets (fixed tile set).
  //
  // Open set is a binary min-heap with lazy deletion: when a tile's g improves
  // we push a fresh entry and discard the superseded one on pop (its g no longer
  // matches bestG). `seq` is a tile's first-insertion order, kept stable across
  // updates, so tie-breaking matches the old linear scan exactly.
  _search(sx, sy, isGoal, anchor, walkableFn) {
    walkableFn = walkableFn || ((x, y) => this.grid.isWalkable(x, y));
    const key = (x, y) => y * 1024 + x;
    const h = (x, y) => Math.abs(x - anchor.x) + Math.abs(y - anchor.y);
    const open = new MinHeap();
    const closed = new Set();
    const bestG = new Map();   // key -> best g seen so far
    const seqOf = new Map();   // key -> first-insertion order (stable tie-break)
    let seq = 0;
    const sk = key(sx, sy);
    bestG.set(sk, 0); seqOf.set(sk, seq);
    open.push({ x: sx, y: sy, g: 0, f: h(sx, sy), parent: null, seq: seq++ });
    let iters = 0;
    while (open.size && iters < 4000) {
      const cur = open.pop();
      const curK = key(cur.x, cur.y);
      if (closed.has(curK)) continue;          // already expanded
      if (cur.g !== bestG.get(curK)) continue; // superseded by a cheaper entry
      iters++;
      if (isGoal(cur.x, cur.y)) {
        const path = []; let n = cur;
        while (n) { path.unshift({ x: n.x, y: n.y }); n = n.parent; }
        return path;
      }
      closed.add(curK);
      for (const nb of this.grid.neighbors4(cur.x, cur.y)) {
        const k = key(nb.x, nb.y);
        if (closed.has(k)) continue;
        const goal = isGoal(nb.x, nb.y);
        if (!goal && !walkableFn(nb.x, nb.y)) continue;
        const g = cur.g + 1;
        const prev = bestG.get(k);
        if (prev !== undefined && prev <= g) continue;
        bestG.set(k, g);
        let s = seqOf.get(k);
        if (s === undefined) { s = seq++; seqOf.set(k, s); }
        open.push({ x: nb.x, y: nb.y, g, f: g + h(nb.x, nb.y), parent: cur, seq: s });
      }
    }
    return null;
  }

  // Predicate-goal entry. Seeds the heuristic with the first matching tile via a
  // full-grid scan — kept for arbitrary predicates. Hot fixed-tile callers
  // should prefer findPathToTargets, which skips this scan.
  findPath(sx, sy, targetFn, walkableFn) {
    let anchor = { x: sx, y: sy };
    outer: for (let y = 0; y < this.grid.rows; y++)
      for (let x = 0; x < this.grid.cols; x++)
        if (targetFn(x, y)) { anchor = { x, y }; break outer; }
    return this._search(sx, sy, targetFn, anchor, walkableFn);
  }

  // Path to ANY tile in `targetTiles` ([{x,y}, …]). O(1) goal test via a key set
  // and an O(#targets) heuristic anchor — no full-grid scan. Returns null when
  // the set is empty. The anchor is the row-major-first target (smallest
  // y*1024+x), which is exactly the anchor findPath's full-grid scan would have
  // chosen for the same goal set — so paths are byte-identical to the old
  // predicate-based calls, making this a pure performance refactor.
  findPathToTargets(sx, sy, targetTiles, walkableFn) {
    if (!targetTiles || !targetTiles.length) return null;
    const key = (x, y) => y * 1024 + x;
    const goalSet = new Set();
    let anchor = null, bestKey = Infinity;
    for (const t of targetTiles) {
      const k = key(t.x, t.y);
      goalSet.add(k);
      if (k < bestKey) { bestKey = k; anchor = t; }
    }
    return this._search(sx, sy, (x, y) => goalSet.has(key(x, y)), anchor, walkableFn);
  }
}
