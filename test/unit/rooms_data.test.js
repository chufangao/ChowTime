/* ============================================================================
 * test/unit/rooms_data.test.js — the in-code room catalog parses cleanly
 * ============================================================================
 * Runs parseRoomConfigs over the embedded ROOMS_JSONL and pins the shape of
 * every config — catching data typos (unknown glyphs, empty rooms) at test time
 * rather than at runtime when the grant event samples one.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

const KNOWN_FURNITURE = new Set(['stove', 'sink', 'table', 'chair']);

test('every config in the embedded catalog parses into a valid shape', () => {
  const ctx = loadSim();
  const configs = ctx.parseRoomConfigs(ctx.ROOMS_JSONL);
  const nonBlankLines = ctx.ROOMS_JSONL.split(/\r?\n/).filter(l => l.trim()).length;
  assert.equal(configs.length, nonBlankLines, 'no line should be silently dropped');
  assert.ok(configs.length >= 3, 'expect a handful of preset rooms');

  const ids = new Set();
  for (const cfg of configs) {
    assert.ok(cfg.id && typeof cfg.id === 'string', 'config has a string id');
    assert.ok(!ids.has(cfg.id), `duplicate room id: ${cfg.id}`);
    ids.add(cfg.id);
    assert.ok(cfg.name && typeof cfg.name === 'string', 'config has a name');
    assert.ok(Array.isArray(cfg.cells) && cfg.cells.length >= 1, `${cfg.id} has >=1 cell`);
    assert.ok(cfg.w >= 1 && cfg.h >= 1, `${cfg.id} has positive dims`);
    for (const cell of cfg.cells) {
      assert.ok(Number.isInteger(cell.dx) && cell.dx >= 0, 'dx int >= 0');
      assert.ok(Number.isInteger(cell.dy) && cell.dy >= 0, 'dy int >= 0');
      assert.ok(cell.dx < cfg.w && cell.dy < cfg.h, 'cell within bounds');
      if (cell.furniture !== null) {
        assert.ok(KNOWN_FURNITURE.has(cell.furniture), `${cfg.id}: known furniture (${cell.furniture})`);
      }
    }
  }
});

test('parseRoomConfigs is pure and resilient to malformed / blank lines', () => {
  const ctx = loadSim();
  const text = [
    '{"id":"ok","name":"OK","grid":["T."]}',
    '',                                   // blank → skipped
    'not json at all',                    // malformed → skipped
    '{"id":"bad","grid":["X"]}',          // unknown glyph → rejected
    '   ',                                // whitespace → skipped
    '{"id":"empty","grid":["##"]}',       // all-empty → rejected (no cells)
  ].join('\n');
  const configs = ctx.parseRoomConfigs(text);
  assert.deepEqual(Array.from(configs, c => c.id), ['ok']);
  // Furniture char maps through the shared layout legend.
  assert.deepEqual(JSON.parse(JSON.stringify(configs[0].cells)), [
    { dx: 0, dy: 0, furniture: 'table' },
    { dx: 1, dy: 0, furniture: null },
  ]);
});

test('ROOM_CONFIGS is seeded from the in-code catalog and setRoomConfigs keeps the reference', () => {
  const ctx = loadSim();
  const ref = ctx.ROOM_CONFIGS;
  // Seeded at load from ROOMS_JSONL — never empty, nothing to fetch.
  assert.ok(ref.length >= 3, 'seeded from the in-code catalog');
  ctx.setRoomConfigs(ctx.ROOMS_JSONL);
  assert.ok(ctx.ROOM_CONFIGS.length >= 3);
  assert.strictEqual(ctx.ROOM_CONFIGS, ref, 'array identity preserved');
  // Empty input falls back to the built-in catalog rather than blanking out.
  ctx.setRoomConfigs('');
  assert.ok(ctx.ROOM_CONFIGS.length >= 3, 'empty text falls back to the catalog');
  assert.strictEqual(ctx.ROOM_CONFIGS, ref, 'reference still stable after fallback');
  assert.ok(ctx.getRoomConfigById(ctx.ROOM_CONFIGS[0].id));
});
