/* ============================================================================
 * test/unit/place_room.test.js — sim.placeRoom + grant event + Place Room tool
 * ============================================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, makeStubScene } = require('../harness.js');

// A small, fully-specified 2×2 room: table+chair on top, floor + stove below.
const TEST_CFG = {
  id: 'test_room', name: 'Test Room', w: 2, h: 2,
  cells: [
    { dx: 0, dy: 0, furniture: 'table' },
    { dx: 1, dy: 0, furniture: 'chair' },
    { dx: 0, dy: 1, furniture: null },
    { dx: 1, dy: 1, furniture: 'stove' },
  ],
};

function simWithTestRoom(seed = 1) {
  const ctx = loadSim({ seed });
  const sim = new ctx.Simulation();   // bare: footprint is all walkable floor
  ctx.ROOM_CONFIGS.length = 0;
  ctx.ROOM_CONFIGS.push(TEST_CFG);
  sim._pendingRooms.push(TEST_CFG.id);
  return { ctx, sim };
}

test('placeRoom succeeds on void tiles adjacent to the restaurant', () => {
  const { sim } = simWithTestRoom();
  // Anchor (12,5): the room occupies x∈{12,13}, y∈{5,6} (all gap); cell (12,5)
  // is 4-adjacent to footprint floor (11,5), so the room connects.
  const res = sim.placeRoom('test_room', 12, 5);
  assert.equal(res.ok, true);
  // Floors stamped in.
  assert.equal(sim.grid.getTile(12, 5).type, 'floor');
  assert.equal(sim.grid.getTile(13, 5).type, 'floor');
  assert.equal(sim.grid.getTile(12, 6).type, 'floor');
  assert.equal(sim.grid.getTile(13, 6).type, 'floor');
  // Furniture placed (free).
  assert.equal(sim.grid.getTile(12, 5).building.type, 'table');
  assert.equal(sim.grid.getTile(13, 5).building.type, 'chair');
  assert.equal(sim.grid.getTile(13, 6).building.type, 'stove');
  assert.equal(sim.grid.getTile(12, 6).building, null, 'plain floor cell stays empty');
  // Pending grant consumed; money untouched (free).
  assert.equal(sim._pendingRooms.length, 0);
  assert.equal(sim.money, 200);
});

test('placeRoom rejects overlapping the footprint or fully-disconnected void', () => {
  const { sim } = simWithTestRoom();
  // Overlaps footprint floor (not gap).
  assert.equal(sim.placeRoom('test_room', 10, 10).ok, false);
  // Deep in the void, no walkable neighbor → disconnected.
  const far = sim.placeRoom('test_room', 20, 20);
  assert.equal(far.ok, false);
  assert.equal(far.reason, 'disconnected');
  // Nothing was consumed or mutated on failure.
  assert.deepEqual(Array.from(sim._pendingRooms), ['test_room']);
  assert.equal(sim.grid.getTile(20, 20).type, 'gap');
});

test('placeRoom rejects an unknown config id', () => {
  const { sim } = simWithTestRoom();
  assert.equal(sim.placeRoom('does_not_exist', 12, 5).ok, false);
});

test('customers/chefs can path into a placed room, and buildings drop on its floor', () => {
  const { sim } = simWithTestRoom();
  assert.equal(sim.placeRoom('test_room', 12, 5).ok, true);
  // Pathfinder routes from a footprint tile to the room's empty floor cell.
  const pf = new sim.pathfinder.constructor(sim.grid);
  const pathToRoom = pf.findPath(0, 0, (x, y) => x === 12 && y === 6);
  assert.ok(pathToRoom && pathToRoom.length, 'a path into the room exists');
  const last = pathToRoom[pathToRoom.length - 1];
  assert.equal(last.x, 12);
  assert.equal(last.y, 6);
  // A new building can be placed on the room's empty floor tile.
  const placed = sim.placeBuilding('sink', 12, 6, true);
  assert.equal(placed.ok, true);
  assert.equal(sim.grid.getTile(12, 6).building.type, 'sink');
});

test('placeRoom result + save/load round-trips a furnished placed room', () => {
  const { ctx, sim } = simWithTestRoom(5);
  assert.equal(sim.placeRoom('test_room', 12, 5).ok, true);
  const blob = JSON.parse(JSON.stringify(ctx.serializeSim(sim, null)));
  const { sim: sim2 } = ctx.deserializeSim(blob);
  // Floors + furniture survive the round-trip.
  assert.equal(sim2.grid.getTile(13, 6).type, 'floor');
  assert.equal(sim2.grid.getTile(13, 6).building.type, 'stove');
  assert.equal(sim2.grid.getTile(12, 5).building.type, 'table');
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.describeSim(sim2))),
    JSON.parse(JSON.stringify(ctx.describeSim(sim))),
  );
});

test('save/load round-trips a still-pending room grant (by config id)', () => {
  const { ctx, sim } = simWithTestRoom(6);
  // Don't place it — leave it pending.
  const blob = JSON.parse(JSON.stringify(ctx.serializeSim(sim, null)));
  const { sim: sim2 } = ctx.deserializeSim(blob);
  assert.deepEqual(Array.from(sim2._pendingRooms), ['test_room']);
});

test('the room-grant event pushes a valid config id onto _pendingRooms', () => {
  const ctx = loadSim({ seed: 2 });
  // ROOM_CONFIGS is already seeded from the in-code catalog at load.
  const ev = ctx.EVENTS.find(e => e.id === 'room_grant');
  assert.ok(ev, 'room_grant event exists');
  const sim = new ctx.Simulation();
  const out = ev.choices[0].onResolve(sim);
  assert.ok(out && out.msg);
  assert.equal(sim._pendingRooms.length, 1);
  assert.ok(ctx.getRoomConfigById(sim._pendingRooms[0]), 'granted id resolves to a real config');
});

test('rollDailyEvent guarantees the room grant every 3rd day and excludes it otherwise', () => {
  const ctx = loadSim({ seed: 1 });
  for (let day = 1; day <= 12; day++) {
    const ev = ctx.rollDailyEvent(day);
    assert.ok(ev, `day ${day} rolls an event`);
    if (day % 3 === 0) {
      assert.equal(ev.id, 'room_grant', `day ${day} (multiple of 3) is a room grant`);
    } else {
      assert.notEqual(ev.id, 'room_grant', `day ${day} is never a room grant`);
    }
  }
});

test('grantRandomRoom queues a valid config id (and no-ops when none loaded)', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  // No configs loaded → null, queue untouched.
  ctx.ROOM_CONFIGS.length = 0;
  assert.equal(sim.grantRandomRoom(), null);
  assert.equal(sim._pendingRooms.length, 0);
  // With configs, it queues a real id.
  ctx.setRoomConfigs(ctx.ROOMS_JSONL);
  const cfg = sim.grantRandomRoom();
  assert.ok(cfg && cfg.id);
  assert.equal(sim._pendingRooms.length, 1);
  assert.ok(ctx.getRoomConfigById(sim._pendingRooms[0]));
});

test('the room-grant event is a harmless no-op when no configs are loaded', () => {
  const ctx = loadSim({ seed: 2 });
  ctx.ROOM_CONFIGS.length = 0;         // simulate a total load failure
  const ev = ctx.EVENTS.find(e => e.id === 'room_grant');
  const sim = new ctx.Simulation();
  const out = ev.choices[0].onResolve(sim);
  assert.ok(out && out.msg);
  assert.equal(sim._pendingRooms.length, 0);
});

test('PlaceRoomApp: hidden until a grant is pending, then places + advances', () => {
  const ctx = loadSim({ seed: 8 });
  ctx.ROOM_CONFIGS.length = 0;
  ctx.ROOM_CONFIGS.push(TEST_CFG);
  const scene = makeStubScene();
  const mgr = new ctx.AppManager();
  mgr.attachScene(scene);
  const app = new ctx.PlaceRoomApp();
  mgr.register(app);

  const sim = new ctx.Simulation();
  mgr._sim = sim;

  // No pending rooms → hidden from the bar, no red dot.
  assert.equal(app.hiddenInBar(sim), true);
  assert.equal(!!app.notification(sim), false);

  // Grant one → visible, notifying. Opening syncs the active config id.
  sim._pendingRooms.push(TEST_CFG.id);
  assert.equal(app.hiddenInBar(sim), false);
  assert.equal(!!app.notification(sim), true);
  mgr.open('place_room');
  assert.equal(app.configId, 'test_room');
  assert.equal(app.isValidAt(sim, 12, 5), true);
  assert.equal(app.isValidAt(sim, 10, 10), false);

  // Clicking a valid tile places the room and consumes the grant; with none
  // left the tool closes itself.
  app.onMapClick(sim, { x: 12, y: 5 }, 0);
  assert.equal(sim._pendingRooms.length, 0);
  assert.equal(sim.grid.getTile(13, 6).building.type, 'stove');
  assert.equal(mgr.activeMapToolId, null, 'tool closes when the queue empties');
});
