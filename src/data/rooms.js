/* ============================================================================
 * data/rooms.js — preset expansion-room configs (authored in-code)
 * ============================================================================
 * A room config is an n×n (or rectangular) ASCII grid encoding BOTH the room's
 * layout (which cells are floor) and its furniture. It reuses the layout legend
 * from layouts.js:
 *
 *   .       floor (walkable, no furniture)
 *   S K T C stove / sink / table / chair  (furniture; implies floor underneath)
 *   # _ ' ' empty — NOT part of the room (lets a config carve a non-rectangular
 *           shape out of its n×n box)
 *
 * The configs are authored as JSONL text in ROOMS_JSONL below (one object per
 * line) and parsed at load — no external file, so the feature works in every
 * runtime context (file://, deploy, http) with nothing to fetch. The module
 * global ROOM_CONFIGS is populated immediately; the grant event samples from it
 * and sim.placeRoom() looks configs up by id. parseRoomConfigs(text) stays PURE
 * (and unit-tested) so configs can also be parsed from arbitrary text in tests.
 * ========================================================================== */

// The room catalog, authored as JSONL (one JSON object per line). This is the
// single source of truth — kept in-code so there's nothing to fetch.
const ROOMS_JSONL = [
  '{"id":"diner_nook","name":"Diner Nook","grid":["TC.","...","TC."]}',
  '{"id":"kitchen_annex","name":"Kitchen Annex","grid":["S.S","...","K.K"]}',
  '{"id":"galley_extension","name":"Galley Extension","grid":["S.K.","TCTC"]}',
  '{"id":"corner_booth","name":"Corner Booth","grid":["TC#","..#","..K"]}',
  '{"id":"grand_hall","name":"Grand Hall","grid":["S..K",".TC.",".TC.","S..K"]}',
].join('\n');

// Parsed catalog. Kept as a stable array reference (mutated in place, never
// reassigned) so consumers that captured it early — the simulation, the
// headless test harness — always see the latest contents. Populated at load so
// it's ready before anything reads it.
let ROOM_CONFIGS = parseRoomConfigs(ROOMS_JSONL);

// Build one config object from a parsed JSON line, or null if it's malformed
// (missing id/grid, a non-string row, or an unknown glyph). Furniture chars
// map through LAYOUT_CHAR_STARTERS (S/K/T/C → stove/sink/table/chair), shared
// with the layout templates so the two can never drift.
function _buildRoomConfig(obj) {
  if (!obj || typeof obj.id !== 'string' || !Array.isArray(obj.grid)) return null;
  const charMap = (typeof LAYOUT_CHAR_STARTERS !== 'undefined') ? LAYOUT_CHAR_STARTERS : {};
  const cells = [];
  let w = 0;
  const h = obj.grid.length;
  for (let dy = 0; dy < obj.grid.length; dy++) {
    const row = obj.grid[dy];
    if (typeof row !== 'string') return null;
    if (row.length > w) w = row.length;
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[dx];
      if (ch === '#' || ch === '_' || ch === ' ') continue;   // not part of the room
      let furniture;
      if (ch === '.') furniture = null;
      else if (charMap[ch]) furniture = charMap[ch];
      else return null;                                       // unknown glyph → reject
      cells.push({ dx, dy, furniture });
    }
  }
  if (!cells.length) return null;
  return { id: obj.id, name: obj.name || obj.id, cells, w, h };
}

// Split JSONL text into configs. Blank lines are skipped; a line that fails to
// JSON.parse or fails validation is skipped (so one bad row can't blank out the
// whole catalog).
function parseRoomConfigs(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch (_e) { continue; }
    const cfg = _buildRoomConfig(obj);
    if (cfg) out.push(cfg);
  }
  return out;
}

// Replace ROOM_CONFIGS in place from JSONL text, falling back to the built-in
// catalog when the text is missing or yields nothing. Mutates the array in
// place so early captures stay valid. Returns the array. (Production never
// needs this — ROOM_CONFIGS is already seeded — but it's handy for tests.)
function setRoomConfigs(text) {
  let parsed = parseRoomConfigs(text);
  if (!parsed.length) parsed = parseRoomConfigs(ROOMS_JSONL);
  ROOM_CONFIGS.length = 0;
  for (const c of parsed) ROOM_CONFIGS.push(c);
  return ROOM_CONFIGS;
}

// Look up a config by id (used by placeRoom and the Place Room tool).
function getRoomConfigById(id) {
  return ROOM_CONFIGS.find(c => c.id === id) || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseRoomConfigs, setRoomConfigs, getRoomConfigById };
}
