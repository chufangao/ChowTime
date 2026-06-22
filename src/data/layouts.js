/* ============================================================================
 * data/layouts.js — Random starter-layout templates
 * ============================================================================
 * On a fresh game, ONE template is rolled and applied. Templates paint gaps
 * (walkability-blocking holes — fillable for $150 via the Floor build item),
 * set 1+ doors on the perimeter, and place starter equipment slots
 * (1 stove, 1 sink, 1 table, 1 chair). Every template guarantees:
 *   - 1..5 doors, all on the perimeter
 *   - every starter slot is reachable from at least one door through walkable
 *     (non-gap, non-wall, non-building) tiles
 *
 * Authoring: each template is 8 ASCII rows of 12 chars. Legend:
 *   #  gap (default-layout obstacle; fill with Floor for $150)
 *   .  floor
 *   D  door (1..5, all on the perimeter)
 *   S  starter stove slot
 *   K  starter sink slot
 *   T  starter table slot
 *   C  starter chair slot (must be 4-adjacent to T)
 * ========================================================================== */

const _LAYOUT_TEMPLATES = [
  {
    id: 'open-plan',
    name: 'Open Plan',
    blurb: 'Bare floor. The easy pull.',
    rows: [
      '............',
      '............',
      '............',
      '............',
      '............',
      'D...........',
      '....T.....S.',
      '....C.....K.',
      '............',
      '............',
      '............',
      '............',
    ],
  },
  {
    id: 'galley',
    name: 'Galley',
    blurb: 'Two pinches force traffic single-file.',
    rows: [
      '............',
      '............',
      '............',
      '.##......##.',
      '............',
      'D...........',
      '....T...S...',
      '....C...K...',
      '............',
      '.##......##.',
      '............',
      '............',
    ],
  },
  {
    id: 'central-pillar',
    name: 'Central Pillar',
    blurb: 'A 2x2 column splits the floor.',
    rows: [
      '............',
      '............',
      '............',
      '.....##.....',
      'D....##.....',
      '.....##.....',
      '.T..........',
      '.C......S.K.',
      '............',
      '............',
      '............',
      '............',
    ],
  },
  {
    id: 'L-wing',
    name: 'L-Wing Alcove',
    blurb: 'The kitchen is tucked behind an L gap.',
    rows: [
      '............',
      '............',
      '........####',
      '........#...',
      'D.......#.S.',
      '........#.K.',
      '........#...',
      '....T.......',
      '....C.......',
      '............',
      '............',
      '............',
    ],
  },
  {
    id: 'split-kitchen',
    name: 'Split Kitchen',
    blurb: 'Stove and sink on opposite walls.',
    rows: [
      '............',
      '............',
      '.....##.....',
      '.....##.....',
      '.....##.....',
      'D.S..##..K..',
      '.....##.....',
      '.....##.....',
      '....T.......',
      '....C.......',
      '............',
      '............',
    ],
  },
  {
    id: 'maze-lite',
    name: 'Maze Lite',
    blurb: 'Soft zig-zag — no straight queues.',
    rows: [
      '............',
      '..##........',
      '.......##...',
      '............',
      'D..........K',
      '....##......',
      '............',
      '.T......S...',
      '.C..........',
      '............',
      '.##.........',
      '............',
    ],
  },
  {
    id: 'courtyard',
    name: 'Courtyard',
    blurb: 'A walled inner ring with one entry corridor.',
    rows: [
      '............',
      '............',
      '.##########.',
      '.#........#.',
      '.#........#.',
      'D.........#.',
      '.#........#.',
      '.#..T.S.K.#.',
      '.#..C.....#.',
      '.#........#.',
      '.##########.',
      '............',
    ],
  },
  {
    id: 'diagonal-spine',
    name: 'Diagonal Spine',
    blurb: 'A staircase splits NW from SE.',
    rows: [
      '............',
      '.##.........',
      '..##........',
      'D..##.......',
      '....##......',
      '.....##...S.',
      '......##..K.',
      '.T.....##...',
      '.C......##..',
      '.........##.',
      '............',
      '............',
    ],
  },
];

/* ---- Parser: ASCII grid → runtime template object -------------------------- */
// Single source of truth for the layout ASCII legend, shared by _parseLayout
// (char → schema) here and the generator's _renderRows (schema → char) in
// layout_generator.js so the two directions can never drift. Non-starter
// glyphs: '.' = floor, '#' or '_' = gap, 'D' = door.
const LAYOUT_STARTER_CHARS = { stove: 'S', sink: 'K', table: 'T', chair: 'C' };
const LAYOUT_CHAR_STARTERS = {};
for (const _t in LAYOUT_STARTER_CHARS) LAYOUT_CHAR_STARTERS[LAYOUT_STARTER_CHARS[_t]] = _t;

function _parseLayout(raw) {
  const { id, name, blurb, rows } = raw;
  const out = {
    id, name, blurb, rows,
    doors: [], gaps: [], starters: [],
  };
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if      (c === '#' || c === '_') out.gaps.push({ x, y });
      else if (c === 'D') out.doors.push({ x, y });
      else if (LAYOUT_CHAR_STARTERS[c]) out.starters.push({ type: LAYOUT_CHAR_STARTERS[c], x, y });
    }
  }
  // Convenience back-compat: `door` = first door.
  out.door = out.doors[0] || null;
  return out;
}

/* ---- Validator ------------------------------------------------------------ *
 * Runs at boot for every template; bad templates throw.
 */
function validateLayout(layout) {
  const errs = [];
  const { rows } = layout;

  if (!Array.isArray(rows) || rows.length !== ROWS) {
    errs.push(`expected ${ROWS} rows, got ${rows && rows.length}`);
    return { ok: false, errors: errs };
  }
  for (let y = 0; y < rows.length; y++) {
    if (typeof rows[y] !== 'string' || rows[y].length !== COLS) {
      errs.push(`row ${y} must be ${COLS} chars, got ${rows[y] && rows[y].length}`);
    }
    for (let x = 0; x < (rows[y] || '').length; x++) {
      if ('#_.DSKTC '.indexOf(rows[y][x]) < 0) {
        errs.push(`row ${y} col ${x}: bad char '${rows[y][x]}'`);
      }
    }
  }
  if (errs.length) return { ok: false, errors: errs };

  // Doors: 1..5 entries, all on the perimeter. Accept either layout.doors
  // (preferred) or layout.door (legacy single-door).
  const doors = layout.doors || (layout.door ? [layout.door] : []);
  if (!doors.length) errs.push('no doors');
  if (doors.length > 5) errs.push(`too many doors (${doors.length}; max 5)`);
  for (const d of doors) {
    const onPerim = (d.x === 0 || d.x === COLS - 1 || d.y === 0 || d.y === ROWS - 1);
    if (!onPerim) errs.push(`door (${d.x},${d.y}) not on perimeter`);
  }

  // Starter counts.
  const counts = { stove: 0, sink: 0, table: 0, chair: 0 };
  for (const s of layout.starters) counts[s.type]++;
  for (const k of Object.keys(counts)) {
    if (counts[k] !== 1) errs.push(`expected exactly one ${k} starter, got ${counts[k]}`);
  }

  // Chair adjacent to table.
  const t = layout.starters.find(s => s.type === 'table');
  const c = layout.starters.find(s => s.type === 'chair');
  if (t && c) {
    const md = Math.abs(t.x - c.x) + Math.abs(t.y - c.y);
    if (md !== 1) errs.push(`chair (${c.x},${c.y}) not 4-adjacent to table (${t.x},${t.y})`);
  }

  if (errs.length) return { ok: false, errors: errs };

  // Build a gap mask + walkability function for BFS. Gaps block walking,
  // exactly like walls do at runtime.
  const gaps = layout.gaps || layout.walls || [];
  const gapSet = new Set(gaps.map(g => g.y * 1024 + g.x));
  const walkable = (x, y) => {
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return false;
    return !gapSet.has(y * 1024 + x);
  };
  for (const d of doors) {
    if (!walkable(d.x, d.y)) errs.push(`door (${d.x},${d.y}) on a gap`);
  }
  for (const s of layout.starters) {
    if (!walkable(s.x, s.y)) errs.push(`starter ${s.type} (${s.x},${s.y}) on a gap`);
  }
  if (errs.length) return { ok: false, errors: errs };

  const k = (x, y) => y * 1024 + x;

  // Strict BFS: starter slots are non-walkable (they'll be buildings). A
  // starter is "operable" if at least one of its 4-neighbors is reachable
  // from at least one door. Multi-door layouts only require some path,
  // not that every door reaches every starter.
  const starterSet = new Set(layout.starters.map(s => k(s.x, s.y)));
  const walkableNoStarter = (x, y) => walkable(x, y) && !starterSet.has(k(x, y));
  const strictSeen = new Set();
  {
    const queue = [];
    for (const d of doors) {
      const dk = k(d.x, d.y);
      if (!strictSeen.has(dk)) { queue.push({ x: d.x, y: d.y }); strictSeen.add(dk); }
    }
    while (queue.length) {
      const { x, y } = queue.shift();
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (!walkableNoStarter(nx, ny)) continue;
        const nk = k(nx, ny);
        if (strictSeen.has(nk)) continue;
        strictSeen.add(nk); queue.push({ x: nx, y: ny });
      }
    }
  }
  for (const s of layout.starters) {
    let reachable = false;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = s.x + dx, ny = s.y + dy;
      if (strictSeen.has(k(nx, ny))) { reachable = true; break; }
    }
    if (!reachable) {
      errs.push(`starter ${s.type} (${s.x},${s.y}) has no reachable neighbor from any door`);
    }
  }

  return errs.length ? { ok: false, errors: errs } : { ok: true };
}

/* ---- Catalog: parsed + validated at load ---------------------------------- */
const LAYOUTS = _LAYOUT_TEMPLATES.map(_parseLayout);
const LAYOUT_BOOT_ERRORS = [];
for (const L of LAYOUTS) {
  const v = validateLayout(L);
  if (!v.ok) LAYOUT_BOOT_ERRORS.push({ id: L.id, errors: v.errors });
}
if (LAYOUT_BOOT_ERRORS.length && typeof console !== 'undefined') {
  console.error('layouts.js: invalid templates', LAYOUT_BOOT_ERRORS);
  // Throw so a bad template fails loudly at boot rather than crashing mid-run.
  throw new Error('Invalid layout templates: ' +
    LAYOUT_BOOT_ERRORS.map(e => `${e.id}: ${e.errors.join('; ')}`).join(' | '));
}

// Mix-in for procedurally generated layouts. When layout_generator.js is
// loaded, ~70% of fresh games roll a wacky generated layout; the rest fall
// back to the hand-authored catalog. If generation exhausts its retry budget
// (rare) we silently fall through to the catalog as well.
const _GENERATED_MIX = 0.7;
function pickRandomLayout() {
  if (typeof generateLayout === 'function' && Math.random() < _GENERATED_MIX) {
    const gen = generateLayout();
    if (gen) return gen;
  }
  return LAYOUTS[(Math.random() * LAYOUTS.length) | 0];
}

function getLayoutById(id) {
  return LAYOUTS.find(l => l.id === id) || null;
}

/* ---- applyLayout(sim, layout): paint gaps + place doors + starters --------- *
 * Mutates sim.grid: sets every door tile to 'spawn', paints gap tiles, and
 * places starter buildings via sim.placeBuilding(..., free=true). Sets
 * sim.layoutId and sim.spawnTiles.
 */
function applyLayout(sim, layout) {
  sim.layoutId = layout.id;
  const doors = layout.doors || (layout.door ? [layout.door] : []);
  sim.spawnTiles = doors.map(d => ({ x: d.x, y: d.y }));
  for (const d of doors) sim.grid.setType(d.x, d.y, 'spawn');
  const gaps = layout.gaps || layout.walls || [];
  for (const g of gaps) {
    sim.grid.setType(g.x, g.y, 'gap');
  }
  for (const s of layout.starters) {
    sim.placeBuilding(s.type, s.x, s.y, true);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LAYOUTS, LAYOUT_BOOT_ERRORS, pickRandomLayout, getLayoutById, applyLayout, validateLayout };
}
