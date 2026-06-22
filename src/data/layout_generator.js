/* ============================================================================
 * data/layout_generator.js — Procedural wacky layout generator (gap-carve)
 * ============================================================================
 * Emits the same shape as _parseLayout in layouts.js so applyLayout works
 * unchanged: { id, name, blurb, rows, doors, gaps, starters }. Every candidate
 * is validated by validateLayout() before being returned — if it fails, the
 * generator rerolls. Generation is seeded for reproducibility.
 *
 * Pipeline per attempt (gap-default):
 *   1. Initialize gapSet = every interior tile (perimeter is always walkable
 *      so doors stay reachable).
 *   2. Roll N=1..5 doors uniformly across the perimeter (biased away from the
 *      west edge for variety).
 *   3. Pick a kernel (straight, serpentine, branching, starburst, ...).
 *      Each kernel REMOVES gap cells to carve walking paths from a chosen
 *      anchor (typically the door region).
 *   4. Place starters (table+chair adjacent, plus stove and sink) on currently
 *      walkable tiles, biased toward locations far from the doors.
 *   5. For any starter NOT yet reachable from a door, "patch carve" — flood
 *      A*-style toward it through gaps, deleting cells along the way until a
 *      path exists. If patching exceeds budget, reroll.
 *   6. Render rows[], score wackiness, run validateLayout. Accept or reroll.
 *
 * Returns null after maxAttempts so callers can fall back to the catalog.
 * ========================================================================== */

/* ---- Deterministic RNG (mulberry32, same algorithm as test/harness.js) ---- */
function _mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
function _pick(rng, arr)       { return arr[Math.floor(rng() * arr.length)]; }
function _shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

const _KEY = (x, y) => y * 1024 + x;
const _INTERIOR = (x, y) => x >= 1 && x <= COLS - 2 && y >= 1 && y <= ROWS - 2;
const _IN_BOUNDS = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS;

/* ---- Door placement ----------------------------------------------------- */

function _allPerimeter() {
  const out = [];
  for (let x = 0; x < COLS; x++) { out.push({ x, y: 0 }); out.push({ x, y: ROWS - 1 }); }
  for (let y = 1; y < ROWS - 1; y++) { out.push({ x: 0, y }); out.push({ x: COLS - 1, y }); }
  return out;
}

function _pickDoors(rng) {
  // Geometric distribution clamped to [1, 5]: P(n)=0.5^n. So roughly:
  //   1 door: 50%   2 doors: 25%   3 doors: 12.5%   4 doors: 6.25%   5 doors: 6.25%
  // Single-door layouts are the common case; multi-door is the rare wacky surprise.
  let desired = 1;
  while (desired < 5 && rng() < 0.5) desired++;

  const peri = _shuffle(rng, _allPerimeter());
  const doors = [];
  for (const p of peri) {
    if (doors.length >= desired) break;
    const tooClose = doors.some(d =>
      Math.abs(d.x - p.x) + Math.abs(d.y - p.y) < 2
    );
    if (tooClose) continue;
    // Bias against west edge (x===0) — the catalog already covers it.
    if (p.x === 0 && rng() < 0.55 && doors.length > 0) continue;
    doors.push(p);
  }
  if (!doors.length) doors.push(peri[0]);
  return doors;
}

/* ---- Carve kernels: remove gap cells to create walking paths ------------- *
 * Each kernel takes (rng, gapSet, doors) and mutates gapSet by deleting
 * cells. Kernels never touch the perimeter (those are floors already). */

function _carve(gapSet, x, y) {
  if (_INTERIOR(x, y)) gapSet.delete(_KEY(x, y));
}

function _kStraightCorridors(rng, gapSet, doors) {
  // Carve 2-4 perpendicular straight corridors crossing the interior.
  const corridors = _randInt(rng, 2, 4);
  for (let i = 0; i < corridors; i++) {
    const horiz = rng() < 0.5;
    if (horiz) {
      const y = _randInt(rng, 1, ROWS - 2);
      for (let x = 0; x < COLS; x++) _carve(gapSet, x, y);
    } else {
      const x = _randInt(rng, 1, COLS - 2);
      for (let y = 0; y < ROWS; y++) _carve(gapSet, x, y);
    }
  }
}

// Helper: pick N seed tiles for path carving — every door, plus extras drawn
// from random interior tiles so the total carving budget is independent of
// the door count. Without this, single-door layouts carve too little space
// and reroll a lot, biasing the door distribution upward.
function _carveSeeds(rng, doors, target) {
  const seeds = doors.map(d => ({ x: d.x, y: d.y }));
  while (seeds.length < target) {
    seeds.push({ x: _randInt(rng, 1, COLS - 2), y: _randInt(rng, 1, ROWS - 2) });
  }
  return seeds;
}

function _kSerpentine(rng, gapSet, doors) {
  // Random walk from each seed, length 8-18, no diagonal moves. Total
  // seed count is fixed (~3) so single-door layouts still get enough carve.
  const seeds = _carveSeeds(rng, doors, 3);
  for (const s of seeds) {
    let x = s.x, y = s.y;
    const len = _randInt(rng, 8, 18);
    let lastDir = -1;
    for (let i = 0; i < len; i++) {
      _carve(gapSet, x, y);
      const dirs = [0, 1, 2, 3];
      _shuffle(rng, dirs);
      let moved = false;
      for (const dir of dirs) {
        if (dir === (lastDir ^ 1)) continue;
        const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
        const dy = dir === 2 ? 1 : dir === 3 ? -1 : 0;
        const nx = x + dx, ny = y + dy;
        if (_IN_BOUNDS(nx, ny)) { x = nx; y = ny; lastDir = dir; moved = true; break; }
      }
      if (!moved) break;
    }
  }
}

function _kBranching(rng, gapSet, doors) {
  // Drunkard's walk from each seed with branching forks. Total seed count is
  // fixed (~3) so single-door layouts still carve enough.
  const seeds = _carveSeeds(rng, doors, 3);
  const stack = seeds.map(s => ({ x: s.x, y: s.y, life: _randInt(rng, 8, 14) }));
  let safety = 250;
  while (stack.length && safety-- > 0) {
    const node = stack.pop();
    if (node.life <= 0) continue;
    _carve(gapSet, node.x, node.y);
    const dirs = _shuffle(rng, [[1,0],[-1,0],[0,1],[0,-1]]);
    let stepped = false;
    for (const [dx, dy] of dirs) {
      const nx = node.x + dx, ny = node.y + dy;
      if (!_IN_BOUNDS(nx, ny)) continue;
      stack.push({ x: nx, y: ny, life: node.life - 1 });
      stepped = true;
      if (rng() < 0.25 && node.life > 3) {
        stack.push({ x: nx, y: ny, life: node.life - 2 });
      }
      if (!stepped || rng() > 0.55) break;
    }
  }
}

function _kStarburst(rng, gapSet, doors) {
  // Carve a small open chamber somewhere central, then radial spokes outward.
  const cx = _randInt(rng, 4, COLS - 5);
  const cy = _randInt(rng, 2, ROWS - 3);
  const r = _randInt(rng, 1, 2);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) _carve(gapSet, cx + dx, cy + dy);
  }
  // Spokes.
  const spokes = _randInt(rng, 3, 5);
  const dirs = _shuffle(rng, [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]);
  for (let i = 0; i < spokes; i++) {
    const [dx, dy] = dirs[i % dirs.length];
    let x = cx, y = cy;
    const len = _randInt(rng, 3, 7);
    for (let k = 0; k < len; k++) {
      x += dx; y += dy;
      if (!_IN_BOUNDS(x, y)) break;
      _carve(gapSet, x, y);
    }
  }
}

function _kRoomChain(rng, gapSet, doors) {
  // Carve 2-3 small rectangular rooms and connect them with a thin corridor.
  const rooms = _randInt(rng, 2, 3);
  const centers = [];
  for (let i = 0; i < rooms; i++) {
    const w = _randInt(rng, 2, 4);
    const h = _randInt(rng, 2, 3);
    const x0 = _randInt(rng, 1, COLS - 1 - w);
    const y0 = _randInt(rng, 1, ROWS - 1 - h);
    for (let x = x0; x < x0 + w; x++) {
      for (let y = y0; y < y0 + h; y++) _carve(gapSet, x, y);
    }
    centers.push({ x: x0 + (w >> 1), y: y0 + (h >> 1) });
  }
  // Connect each room to the next with an L-corridor.
  for (let i = 0; i < centers.length - 1; i++) {
    const a = centers[i], b = centers[i + 1];
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (rng() < 0.5) {
      for (let x = x0; x <= x1; x++) _carve(gapSet, x, a.y);
      for (let y = y0; y <= y1; y++) _carve(gapSet, b.x, y);
    } else {
      for (let y = y0; y <= y1; y++) _carve(gapSet, a.x, y);
      for (let x = x0; x <= x1; x++) _carve(gapSet, x, b.y);
    }
  }
}

function _kZigzagCarve(rng, gapSet, doors) {
  // Two zigzagging carved bands running horizontally — open dance floors with
  // gap walls between.
  const startY = _randInt(rng, 1, 2);
  let y = startY;
  for (let x = 0; x < COLS; x++) {
    _carve(gapSet, x, y);
    if (rng() < 0.4) y = Math.max(1, Math.min(ROWS - 2, y + (rng() < 0.5 ? -1 : 1)));
  }
  if (rng() < 0.7) {
    let y2 = Math.min(ROWS - 2, startY + _randInt(rng, 3, 4));
    for (let x = 0; x < COLS; x++) {
      _carve(gapSet, x, y2);
      if (rng() < 0.4) y2 = Math.max(1, Math.min(ROWS - 2, y2 + (rng() < 0.5 ? -1 : 1)));
    }
  }
}

// New kernels for added diversity. Each carves additional walkable shapes
// while leaving the surrounding gap field intact.

function _kRing(rng, gapSet, doors) {
  // Hollow rectangular ring with a central pillar of gaps. The ring band is
  // 1-2 tiles wide; the inner block stays solidly gapped.
  const w = _randInt(rng, 5, COLS - 4);
  const h = _randInt(rng, 4, ROWS - 4);
  const x0 = _randInt(rng, 1, COLS - 2 - w);
  const y0 = _randInt(rng, 1, ROWS - 2 - h);
  const band = (rng() < 0.5) ? 1 : 2;
  for (let yy = y0; yy <= y0 + h; yy++) {
    for (let xx = x0; xx <= x0 + w; xx++) {
      const onBand = (xx - x0) < band || (x0 + w - xx) < band ||
                     (yy - y0) < band || (y0 + h - yy) < band;
      if (onBand) _carve(gapSet, xx, yy);
    }
  }
}

function _kCross(rng, gapSet, doors) {
  // Plus-sign carved walkable area: one horizontal band + one vertical band
  // crossing at a random interior point. Bands are 2-3 wide.
  const cx = _randInt(rng, 3, COLS - 4);
  const cy = _randInt(rng, 2, ROWS - 3);
  const hw = _randInt(rng, 1, 2);
  for (let y = Math.max(1, cy - hw); y <= Math.min(ROWS - 2, cy + hw); y++) {
    for (let x = 0; x < COLS; x++) _carve(gapSet, x, y);
  }
  for (let x = Math.max(1, cx - hw); x <= Math.min(COLS - 2, cx + hw); x++) {
    for (let y = 0; y < ROWS; y++) _carve(gapSet, x, y);
  }
}

function _kSpiral(rng, gapSet, doors) {
  // Inward-spiraling corridor: walks the perimeter, then steps inward and
  // walks again. Creates a snail-shell layout where you traverse loops to
  // reach the center.
  let x0 = 1, y0 = 1, x1 = COLS - 2, y1 = ROWS - 2;
  let safety = 8;
  while (x0 <= x1 && y0 <= y1 && safety-- > 0) {
    for (let x = x0; x <= x1; x++) _carve(gapSet, x, y0);
    for (let y = y0; y <= y1; y++) _carve(gapSet, x1, y);
    for (let x = x1; x >= x0; x--) _carve(gapSet, x, y1);
    for (let y = y1; y >= y0; y--) _carve(gapSet, x0, y);
    // Inset by 2 each loop so the corridor has gap walls between arms.
    x0 += 2; y0 += 2; x1 -= 2; y1 -= 2;
    if (rng() < 0.3) break;             // sometimes leave an incomplete spiral
  }
}

function _kIslands(rng, gapSet, doors) {
  // Several small "island" walkable patches connected by thin corridors. The
  // islands sit on a sea of gaps so paths between islands are forced through
  // their connecting threads.
  const islands = _randInt(rng, 3, 5);
  const centers = [];
  for (let i = 0; i < islands; i++) {
    const cx = _randInt(rng, 1, COLS - 2);
    const cy = _randInt(rng, 1, ROWS - 2);
    const r = _randInt(rng, 1, 2);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) + Math.abs(dy) <= r + 1) _carve(gapSet, cx + dx, cy + dy);
      }
    }
    centers.push({ x: cx, y: cy });
  }
  // Connect each island to the next with a thin L-corridor.
  for (let i = 0; i < centers.length - 1; i++) {
    const a = centers[i], b = centers[i + 1];
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (rng() < 0.5) {
      for (let x = x0; x <= x1; x++) _carve(gapSet, x, a.y);
      for (let y = y0; y <= y1; y++) _carve(gapSet, b.x, y);
    } else {
      for (let y = y0; y <= y1; y++) _carve(gapSet, a.x, y);
      for (let x = x0; x <= x1; x++) _carve(gapSet, x, b.y);
    }
  }
}

function _kHalfCarve(rng, gapSet, doors) {
  // Carve only one half (or one quadrant) of the interior to a near-empty
  // floor, leaving the other half a wall of gaps. Simulates a "wing" layout —
  // a cramped half of the restaurant that the player can expand into.
  const variant = _randInt(rng, 0, 3);
  if (variant === 0) {
    // West half open
    for (let y = 1; y <= ROWS - 2; y++)
      for (let x = 1; x <= Math.floor(COLS / 2); x++) _carve(gapSet, x, y);
  } else if (variant === 1) {
    // East half open
    for (let y = 1; y <= ROWS - 2; y++)
      for (let x = Math.floor(COLS / 2); x <= COLS - 2; x++) _carve(gapSet, x, y);
  } else if (variant === 2) {
    // North half open
    for (let y = 1; y <= Math.floor(ROWS / 2); y++)
      for (let x = 1; x <= COLS - 2; x++) _carve(gapSet, x, y);
  } else {
    // South half open
    for (let y = Math.floor(ROWS / 2); y <= ROWS - 2; y++)
      for (let x = 1; x <= COLS - 2; x++) _carve(gapSet, x, y);
  }
}

function _kLShape(rng, gapSet, doors) {
  // L-shaped walkable area. The "L" is one wide band along one wall plus a
  // shorter band along an adjacent wall, leaving a square corner of gaps.
  const armW = _randInt(rng, 3, 5);
  const corner = _randInt(rng, 0, 3);
  if (corner === 0) {
    // L hugging NW: top band + left band
    for (let y = 1; y <= armW; y++) for (let x = 1; x <= COLS - 2; x++) _carve(gapSet, x, y);
    for (let x = 1; x <= armW; x++) for (let y = 1; y <= ROWS - 2; y++) _carve(gapSet, x, y);
  } else if (corner === 1) {
    // NE
    for (let y = 1; y <= armW; y++) for (let x = 1; x <= COLS - 2; x++) _carve(gapSet, x, y);
    for (let x = COLS - 1 - armW; x <= COLS - 2; x++) for (let y = 1; y <= ROWS - 2; y++) _carve(gapSet, x, y);
  } else if (corner === 2) {
    // SE
    for (let y = ROWS - 1 - armW; y <= ROWS - 2; y++) for (let x = 1; x <= COLS - 2; x++) _carve(gapSet, x, y);
    for (let x = COLS - 1 - armW; x <= COLS - 2; x++) for (let y = 1; y <= ROWS - 2; y++) _carve(gapSet, x, y);
  } else {
    // SW
    for (let y = ROWS - 1 - armW; y <= ROWS - 2; y++) for (let x = 1; x <= COLS - 2; x++) _carve(gapSet, x, y);
    for (let x = 1; x <= armW; x++) for (let y = 1; y <= ROWS - 2; y++) _carve(gapSet, x, y);
  }
}

function _kCompact(rng, gapSet, doors) {
  // Compact small playable region — a single bounded box smaller than the
  // full interior. Variable size makes the layout feel like a tiny shop.
  const w = _randInt(rng, 5, 9);
  const h = _randInt(rng, 5, 8);
  const x0 = _randInt(rng, 1, COLS - 1 - w);
  const y0 = _randInt(rng, 1, ROWS - 1 - h);
  for (let y = y0; y <= y0 + h; y++) {
    for (let x = x0; x <= x0 + w; x++) _carve(gapSet, x, y);
  }
  // Occasionally bite an interior pillar out for character.
  if (rng() < 0.5) {
    const px = x0 + _randInt(rng, 2, w - 2);
    const py = y0 + _randInt(rng, 2, h - 2);
    gapSet.add(_KEY(px, py));
  }
}

const _KERNELS = [
  { name: 'corridors',  fn: _kStraightCorridors },
  { name: 'serpentine', fn: _kSerpentine },
  { name: 'branching',  fn: _kBranching },
  { name: 'starburst',  fn: _kStarburst },
  { name: 'rooms',      fn: _kRoomChain },
  { name: 'zigzag',     fn: _kZigzagCarve },
  { name: 'ring',       fn: _kRing },
  { name: 'cross',      fn: _kCross },
  { name: 'spiral',     fn: _kSpiral },
  { name: 'islands',    fn: _kIslands },
  { name: 'half',       fn: _kHalfCarve },
  { name: 'lshape',     fn: _kLShape },
  { name: 'compact',    fn: _kCompact },
];

/* ---- Spice: extra sprinkled carves -------------------------------------- */

function _spice(rng, gapSet) {
  // Every door always has at least 1 carved interior tile right next to it
  // so the perimeter doesn't dead-end into a wall of gaps.
  // (Doors live on the perimeter; their immediate interior neighbor must be
  // walkable for any path to exist.) Done in _ensureDoorEntry below.
  if (rng() < 0.55) {
    const extras = _randInt(rng, 2, 6);
    for (let i = 0; i < extras; i++) {
      const x = _randInt(rng, 1, COLS - 2);
      const y = _randInt(rng, 1, ROWS - 2);
      _carve(gapSet, x, y);
    }
  }
}

function _ensureDoorEntry(gapSet, doors) {
  for (const d of doors) {
    const candidates = [
      { x: d.x + 1, y: d.y }, { x: d.x - 1, y: d.y },
      { x: d.x, y: d.y + 1 }, { x: d.x, y: d.y - 1 },
    ].filter(n => _INTERIOR(n.x, n.y));
    if (!candidates.length) continue;
    // If none are already carved, carve all of them so the door has an entry.
    const anyOpen = candidates.some(n => !gapSet.has(_KEY(n.x, n.y)));
    if (!anyOpen) for (const n of candidates) _carve(gapSet, n.x, n.y);
  }
}

function _generateGaps(rng) {
  // 45% of attempts run two kernels back-to-back (more open-floor variety),
  // 10% run three for chaotic compound layouts. Single-kernel is still the
  // majority so the base shapes read clearly.
  const gapSet = new Set();
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) gapSet.add(_KEY(x, y));
  }
  const doors = _pickDoors(rng);
  let kernelName;
  const r = rng();
  if (r < 0.10) {
    const k1 = _pick(rng, _KERNELS);
    const k2 = _pick(rng, _KERNELS);
    const k3 = _pick(rng, _KERNELS);
    k1.fn(rng, gapSet, doors);
    k2.fn(rng, gapSet, doors);
    k3.fn(rng, gapSet, doors);
    kernelName = `${k1.name}+${k2.name}+${k3.name}`;
  } else if (r < 0.55) {
    const k1 = _pick(rng, _KERNELS);
    const k2 = _pick(rng, _KERNELS);
    k1.fn(rng, gapSet, doors);
    k2.fn(rng, gapSet, doors);
    kernelName = `${k1.name}+${k2.name}`;
  } else {
    const k = _pick(rng, _KERNELS);
    k.fn(rng, gapSet, doors);
    kernelName = k.name;
  }
  _spice(rng, gapSet);
  _ensureDoorEntry(gapSet, doors);
  return { gapSet, doors, kernelName };
}

/* ---- Reachability + patch-carving --------------------------------------- */

function _bfsReachable(gapSet, doors) {
  const seen = new Set();
  const queue = [];
  for (const d of doors) { seen.add(_KEY(d.x, d.y)); queue.push({ x: d.x, y: d.y }); }
  while (queue.length) {
    const { x, y } = queue.shift();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (!_IN_BOUNDS(nx, ny)) continue;
      if (gapSet.has(_KEY(nx, ny))) continue;
      const nk = _KEY(nx, ny);
      if (seen.has(nk)) continue;
      seen.add(nk); queue.push({ x: nx, y: ny });
    }
  }
  return seen;
}

// Manhattan-distance carve: BFS toward `target` allowing traversal of gaps,
// then delete every gap cell along the chosen path. Returns the number of
// carved cells, or -1 if no path exists (shouldn't happen on a finite grid).
function _patchCarve(gapSet, fromDoors, target) {
  const start = fromDoors[0];
  const startK = _KEY(start.x, start.y);
  const parent = new Map();
  parent.set(startK, null);
  const queue = [{ x: start.x, y: start.y }];
  let found = null;
  while (queue.length) {
    const cur = queue.shift();
    if (cur.x === target.x && cur.y === target.y) { found = cur; break; }
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!_IN_BOUNDS(nx, ny)) continue;
      const nk = _KEY(nx, ny);
      if (parent.has(nk)) continue;
      parent.set(nk, _KEY(cur.x, cur.y));
      queue.push({ x: nx, y: ny });
    }
  }
  if (!found) return -1;
  // Walk back, carving every gap on the path (skip target itself — that's where
  // a starter sits).
  let carved = 0;
  let nodeK = _KEY(found.x, found.y);
  while (nodeK != null) {
    const x = nodeK & 1023, y = nodeK >>> 10;
    if (!(x === target.x && y === target.y) && _INTERIOR(x, y) && gapSet.has(nodeK)) {
      gapSet.delete(nodeK); carved++;
    }
    nodeK = parent.get(nodeK);
  }
  return carved;
}

/* ---- Starter placement -------------------------------------------------- */

function _placeStarters(rng, gapSet, doors) {
  const reachable = _bfsReachable(gapSet, doors);
  const walkableTiles = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (gapSet.has(_KEY(x, y))) continue;
      if (doors.some(d => d.x === x && d.y === y)) continue;
      walkableTiles.push({ x, y });
    }
  }
  if (walkableTiles.length < 4) return null;
  const inReachable = walkableTiles.filter(t => reachable.has(_KEY(t.x, t.y)));
  // Prefer placing starters on currently-reachable tiles; if there aren't 4
  // distinct reachable tiles, fall back to any walkable tile (patch-carve will
  // re-connect them).
  const pool = (inReachable.length >= 8 ? inReachable : walkableTiles);

  for (let attempt = 0; attempt < 60; attempt++) {
    // Table + chair: pick a table tile, then a 4-adjacent chair tile that's
    // also walkable (gap or floor — gaps will be patch-carved).
    const tableCands = _shuffle(rng, pool.slice());
    let table = null, chair = null;
    for (const t of tableCands) {
      const neighbors = [
        { x: t.x + 1, y: t.y }, { x: t.x - 1, y: t.y },
        { x: t.x, y: t.y + 1 }, { x: t.x, y: t.y - 1 },
      ].filter(n => _IN_BOUNDS(n.x, n.y) &&
                    !doors.some(d => d.x === n.x && d.y === n.y) &&
                    !(n.x === t.x && n.y === t.y));
      _shuffle(rng, neighbors);
      // Chair must not sit on a gap (it's a building, can't be on a gap) —
      // but we'll filter to walkable below.
      const chairCand = neighbors.find(n => !gapSet.has(_KEY(n.x, n.y)));
      if (chairCand) { table = t; chair = chairCand; break; }
    }
    if (!table || !chair) continue;

    // Stove + sink: pick two walkable tiles distinct from table/chair/doors.
    const used = new Set([_KEY(table.x, table.y), _KEY(chair.x, chair.y)]);
    for (const d of doors) used.add(_KEY(d.x, d.y));
    const ssPool = walkableTiles.filter(t => !used.has(_KEY(t.x, t.y)));
    if (ssPool.length < 2) continue;

    let stove = null, sink = null, bestScore = -1;
    const trials = Math.min(40, ssPool.length * (ssPool.length - 1) / 2);
    for (let i = 0; i < trials; i++) {
      const a = ssPool[Math.floor(rng() * ssPool.length)];
      const b = ssPool[Math.floor(rng() * ssPool.length)];
      if (a === b) continue;
      const dAB = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      const dAT = Math.abs(a.x - table.x) + Math.abs(a.y - table.y);
      const dBT = Math.abs(b.x - table.x) + Math.abs(b.y - table.y);
      const s = dAB + dAT + dBT;
      if (s > bestScore) { bestScore = s; stove = a; sink = b; }
    }
    if (!stove || !sink) continue;

    return [
      { type: 'stove', x: stove.x, y: stove.y },
      { type: 'sink',  x: sink.x,  y: sink.y },
      { type: 'table', x: table.x, y: table.y },
      { type: 'chair', x: chair.x, y: chair.y },
    ];
  }
  return null;
}

// Ensure each starter has a reachable neighbor from at least one door. If
// not, patch-carve gaps along a shortest path until one exists. Returns the
// total number of cells carved (for scoring), or -1 if any starter is
// unreachable even after patching.
function _ensureStarterReachability(gapSet, doors, starters, maxBudget) {
  let carved = 0;
  for (const s of starters) {
    let reachable = _bfsReachable(gapSet, doors);
    const neighbors = [
      { x: s.x + 1, y: s.y }, { x: s.x - 1, y: s.y },
      { x: s.x, y: s.y + 1 }, { x: s.x, y: s.y - 1 },
    ].filter(n => _IN_BOUNDS(n.x, n.y));
    if (neighbors.some(n => reachable.has(_KEY(n.x, n.y)))) continue;
    // Try carving toward each neighbor; pick the cheapest.
    let best = -1, bestNeighbor = null;
    for (const n of neighbors) {
      // Skip neighbors on top of starters (they'd block placement) or doors.
      if (starters.some(o => o !== s && o.x === n.x && o.y === n.y)) continue;
      // Simulate by counting path carve cost without mutating gapSet.
      const trialSet = new Set(gapSet);
      const cost = _patchCarve(trialSet, doors, n);
      if (cost >= 0 && (best < 0 || cost < best)) { best = cost; bestNeighbor = n; }
    }
    if (bestNeighbor == null) return -1;
    carved += _patchCarve(gapSet, doors, bestNeighbor);
    if (carved > maxBudget) return -1;
  }
  return carved;
}

/* ---- Wackiness scoring --------------------------------------------------- */

function _scoreWackiness(gapSet, doors, starters) {
  let score = 0;
  // Density: more gaps = wackier.
  const gaps = gapSet.size;
  if (gaps >= 20) score += 2;
  if (gaps >= 30) score += 3;
  if (gaps >= 40) score += 3;
  if (gaps >= 50) score += 2;
  if (gaps < 10)  score -= 4;

  // Door variety: a small bonus for using a non-west edge so the catalog's
  // west-only feel doesn't dominate. NO bonus for door count itself — doors
  // follow a geometric distribution at picking time, not scoring time.
  const edges = new Set();
  for (const d of doors) {
    if (d.x === 0)            edges.add('W');
    else if (d.x === COLS - 1) edges.add('E');
    else if (d.y === 0)        edges.add('N');
    else if (d.y === ROWS - 1) edges.add('S');
  }
  if (edges.has('N') || edges.has('E') || edges.has('S')) score += 1;

  // Chokepoints (1-wide corridors).
  let chokes = 0;
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (gapSet.has(_KEY(x, y))) continue;
      const n = !gapSet.has(_KEY(x, y - 1));
      const s = !gapSet.has(_KEY(x, y + 1));
      const e = !gapSet.has(_KEY(x + 1, y));
      const w = !gapSet.has(_KEY(x - 1, y));
      const open = (n ? 1 : 0) + (s ? 1 : 0) + (e ? 1 : 0) + (w ? 1 : 0);
      if (open === 2 && ((n && s) || (e && w))) chokes++;
    }
  }
  if (chokes >= 2) score += 2;
  if (chokes >= 5) score += 2;

  // Stove/sink spread.
  const stove = starters.find(s => s.type === 'stove');
  const sink  = starters.find(s => s.type === 'sink');
  if (stove && sink) {
    const md = Math.abs(stove.x - sink.x) + Math.abs(stove.y - sink.y);
    if (md >= 4) score += 2;
    if (md >= 8) score += 2;
    if (md <= 1) score -= 2;
  }

  return score;
}

/* ---- Naming + blurbs ----------------------------------------------------- */

const _ADJECTIVES = [
  'Crooked', 'Wonky', 'Lopsided', 'Drunken', 'Tilted', 'Spiky',
  'Maze-y', 'Pinched', 'Chunky', 'Cluttered', 'Disjoint', 'Splintered',
  'Funhouse', 'Catawampus', 'Wayward', 'Bristly',
];

const _BLURBS = {
  corridors:  'A few bare corridors and a sea of gaps.',
  serpentine: 'One narrow snaking trail through the void.',
  branching:  'A drunkard\'s walk built this place.',
  starburst:  'A center plaza with spokes radiating out.',
  rooms:      'Tiny rooms strung together by skinny halls.',
  zigzag:     'Zigzag trails dance across the gap floor.',
  ring:       'A hollow loop with a solid pillar in the middle.',
  cross:      'A wide cross-aisle splits the floor in four.',
  spiral:     'A snail-shell spiral coils inward to the kitchen.',
  islands:    'Floor patches strung together by skinny threads.',
  half:       'Half the floor is wide open, the other half is wall.',
  lshape:     'An L-shaped wing tucked into one corner.',
  compact:    'A cozy little shop tucked into a corner.',
};

function _nameFor(rng, kernelName) {
  return `${_pick(rng, _ADJECTIVES)} ${kernelName.charAt(0).toUpperCase()}${kernelName.slice(1)}`;
}

function _blurbFor(kernelName, doors) {
  const base = _BLURBS[kernelName] || 'A layout no architect would sign off on.';
  if (doors.length >= 3) return `${base} (${doors.length} doors!)`;
  return base;
}

/* ---- Render to ASCII rows ------------------------------------------------ */

function _renderRows(gapSet, doors, starters) {
  // Reuse the shared legend from layouts.js (loaded first) so the type→char
  // mapping stays in lockstep with _parseLayout's char→type mapping.
  const starterChar = (typeof LAYOUT_STARTER_CHARS !== 'undefined')
    ? LAYOUT_STARTER_CHARS
    : { stove: 'S', sink: 'K', table: 'T', chair: 'C' };
  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    let row = '';
    for (let x = 0; x < COLS; x++) {
      let ch = '.';
      if (gapSet.has(_KEY(x, y))) ch = '#';
      for (const d of doors) if (d.x === x && d.y === y) ch = 'D';
      for (const s of starters) if (s.x === x && s.y === y) { ch = starterChar[s.type]; break; }
      row += ch;
    }
    rows.push(row);
  }
  return rows;
}

/* ---- Public entry: generateLayout(seed, opts) ---------------------------- */

function generateLayout(seed, opts) {
  opts = opts || {};
  const seedNum = (typeof seed === 'number')
    ? (seed >>> 0)
    : ((Math.random() * 0x7fffffff) | 0);
  const rng = _mulberry32(seedNum);
  const threshold   = (opts.wackinessThreshold != null) ? opts.wackinessThreshold : 3;
  const maxAttempts = opts.maxAttempts || 150;
  const patchBudget = (opts.patchBudget != null) ? opts.patchBudget : 12;

  let bestFallback = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { gapSet, doors, kernelName } = _generateGaps(rng);

    const starters = _placeStarters(rng, gapSet, doors);
    if (!starters) continue;

    // Make sure the table and chair tiles themselves aren't gapped (chair sits
    // on a tile — must not be a gap). Carve them clean.
    for (const s of starters) gapSet.delete(_KEY(s.x, s.y));

    // Patch-carve so each starter has a reachable neighbor from a door.
    const carved = _ensureStarterReachability(gapSet, doors, starters, patchBudget);
    if (carved < 0) continue;

    const score = _scoreWackiness(gapSet, doors, starters);
    const rows = _renderRows(gapSet, doors, starters);
    const gaps = [];
    for (const k of gapSet) gaps.push({ x: k & 1023, y: (k >>> 10) });

    const layout = {
      id: `gen-${seedNum}`,
      name: _nameFor(rng, kernelName),
      blurb: _blurbFor(kernelName, doors),
      rows,
      doors,
      door: doors[0] || null,
      gaps,
      starters,
      _kernel: kernelName,
      _score: score,
    };

    if (typeof validateLayout === 'function') {
      const v = validateLayout(layout);
      if (!v.ok) continue;
    }
    if (score < threshold) {
      if (!bestFallback || score > bestFallback._score) bestFallback = layout;
      continue;
    }
    return layout;
  }
  return bestFallback;
}

/* ---- Module export ------------------------------------------------------- */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateLayout };
}
