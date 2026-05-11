/* ============================================================================
 * test/unit/layout_generator.test.js — Procedural wacky layout generator
 * ============================================================================
 * Every seed in [1, 100] must produce a layout that validateLayout() accepts.
 * Also covers determinism, kernel coverage, and multi-door reachability.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('100 seeds all produce a validateLayout-accepted layout', () => {
  const ctx = loadSim({ seed: 1 });
  for (let s = 1; s <= 100; s++) {
    const L = ctx.generateLayout(s);
    assert.ok(L, `seed ${s} returned null`);
    const v = ctx.validateLayout(L);
    assert.ok(v.ok, `seed ${s} failed validation: ${(v.errors || []).join('; ')}`);
    // Output shape matches _parseLayout's contract.
    assert.equal(typeof L.id, 'string');
    assert.equal(L.id.startsWith('gen-'), true);
    assert.equal(Array.isArray(L.rows), true);
    assert.equal(L.rows.length, ctx.ROWS);
    for (const row of L.rows) assert.equal(row.length, ctx.COLS);
    assert.ok(Array.isArray(L.doors) && L.doors.length >= 1 && L.doors.length <= 5,
      `seed ${s} has ${L.doors && L.doors.length} doors`);
    for (const d of L.doors) {
      const onPerim = (d.x === 0 || d.x === ctx.COLS - 1 || d.y === 0 || d.y === ctx.ROWS - 1);
      assert.ok(onPerim, `seed ${s} door (${d.x},${d.y}) not on perimeter`);
    }
    assert.equal(Array.isArray(L.gaps), true);
    assert.equal(L.starters.length, 4);
  }
});

test('determinism: same seed -> byte-identical rows', () => {
  const ctx = loadSim({ seed: 1 });
  for (const s of [1, 7, 42, 9999]) {
    const a = ctx.generateLayout(s);
    const b = ctx.generateLayout(s);
    assert.deepEqual(a.rows, b.rows, `seed ${s} not deterministic`);
    assert.deepEqual(a.starters, b.starters);
    assert.deepEqual(a.doors, b.doors);
  }
});

test('kernel coverage: every kernel appears within 300 seeds', () => {
  const ctx = loadSim({ seed: 1 });
  const seenBase = new Set();
  for (let s = 1; s <= 300; s++) {
    const L = ctx.generateLayout(s);
    if (!L || !L._kernel) continue;
    for (const part of L._kernel.split('+')) seenBase.add(part);
  }
  const expected = [
    'corridors', 'serpentine', 'branching', 'starburst', 'rooms', 'zigzag',
    // New, added for shape diversity.
    'ring', 'cross', 'spiral', 'islands', 'half', 'lshape', 'compact',
  ];
  for (const name of expected) {
    assert.ok(seenBase.has(name), `kernel '${name}' never appeared in 300 seeds; got ${[...seenBase].join(',')}`);
  }
});

test('shape diversity: gap-count varies significantly across seeds', () => {
  // With 13 kernels and multi-kernel chaining, playable footprints should
  // span a wide range (very open ↔ very cramped). Verify min/max gap counts
  // differ by at least 30 across 200 seeds.
  const ctx = loadSim({ seed: 1 });
  let minGaps = Infinity, maxGaps = -Infinity;
  for (let s = 1; s <= 200; s++) {
    const L = ctx.generateLayout(s);
    if (!L) continue;
    const g = L.gaps.length;
    if (g < minGaps) minGaps = g;
    if (g > maxGaps) maxGaps = g;
  }
  assert.ok(maxGaps - minGaps >= 30,
    `expected gap-count spread ≥ 30, got ${minGaps}..${maxGaps}`);
});

test('compound kernels appear in 200 seeds (chained kernels)', () => {
  const ctx = loadSim({ seed: 1 });
  let compound = 0;
  for (let s = 1; s <= 200; s++) {
    const L = ctx.generateLayout(s);
    if (L && L._kernel && L._kernel.indexOf('+') >= 0) compound++;
  }
  assert.ok(compound >= 50,
    `expected ≥ 50/200 seeds to use chained kernels, saw ${compound}`);
});

test('door diversity: not every layout has exactly 1 door', () => {
  // The catalog has 1 door per layout. Generated layouts vary 1..5; in 100
  // seeds at least 25% should have 2+ doors.
  const ctx = loadSim({ seed: 1 });
  let multi = 0;
  for (let s = 1; s <= 100; s++) {
    const L = ctx.generateLayout(s);
    if (L && L.doors.length >= 2) multi++;
  }
  assert.ok(multi >= 25, `${multi}/100 layouts have 2+ doors; generator isn't using multi-door enough`);
});

test('door placement diversifies away from west edge', () => {
  // The catalog has every door on x=0. Generated layouts should land elsewhere
  // most of the time. Threshold: in 100 seeds, fewer than 50% have ALL doors
  // on x=0 (some single-door layouts will, but most multi-door won't).
  const ctx = loadSim({ seed: 1 });
  let allWest = 0;
  for (let s = 1; s <= 100; s++) {
    const L = ctx.generateLayout(s);
    if (L && L.doors.every(d => d.x === 0)) allWest++;
  }
  assert.ok(allWest < 50, `${allWest}/100 layouts have ALL doors on x=0`);
});

test('generated layout: every starter has a reachable walkable neighbor from some door', () => {
  // Reachability check: gaps block walking, exactly like the live runtime
  // does. validateLayout already asserts this; this test pins down the
  // semantics so a future weaker validator can't silently regress.
  const ctx = loadSim({ seed: 1 });
  for (const seed of [12345, 7, 88, 12, 555, 1111]) {
    const L = ctx.generateLayout(seed);
    assert.ok(L, `seed ${seed} returned null`);
    const gapSet = new Set(L.gaps.map(g => g.y * 1024 + g.x));
    const starterSet = new Set(L.starters.map(s => s.y * 1024 + s.x));
    const walkableNoStarter = (x, y) =>
      x >= 0 && x < ctx.COLS && y >= 0 && y < ctx.ROWS &&
      !gapSet.has(y * 1024 + x) && !starterSet.has(y * 1024 + x);
    // BFS from all doors.
    const seen = new Set();
    const queue = [];
    for (const d of L.doors) { seen.add(d.y * 1024 + d.x); queue.push({ x: d.x, y: d.y }); }
    while (queue.length) {
      const { x, y } = queue.shift();
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (!walkableNoStarter(nx, ny)) continue;
        const k = ny * 1024 + nx;
        if (seen.has(k)) continue;
        seen.add(k); queue.push({ x: nx, y: ny });
      }
    }
    for (const s of L.starters) {
      let ok = false;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if (seen.has((s.y + dy) * 1024 + (s.x + dx))) { ok = true; break; }
      }
      assert.ok(ok, `seed ${seed} starter ${s.type} (${s.x},${s.y}) unreachable from any door`);
    }
  }
});
