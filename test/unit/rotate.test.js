const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('Building starts with facing=null (auto-orient)', () => {
  const ctx = loadSim({ seed: 1 });
  const chair = new ctx.Chair();
  assert.equal(chair.facing, null);
});

test('RotateApp cycles facing through 0..3 then back to 0', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const chair = sim.buildings.find(b => b.type === 'chair');
  assert.ok(chair);
  const rotate = new ctx.RotateApp();
  rotate.onMapClick(sim, { x: chair.x, y: chair.y });
  assert.equal(chair.facing, 0);
  rotate.onMapClick(sim, { x: chair.x, y: chair.y });
  assert.equal(chair.facing, 1);
  rotate.onMapClick(sim, { x: chair.x, y: chair.y });
  assert.equal(chair.facing, 2);
  rotate.onMapClick(sim, { x: chair.x, y: chair.y });
  assert.equal(chair.facing, 3);
  rotate.onMapClick(sim, { x: chair.x, y: chair.y });
  assert.equal(chair.facing, 0);
});

test('RotateApp.isValidAt requires a building on the tile', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const chair = sim.buildings.find(b => b.type === 'chair');
  const rotate = new ctx.RotateApp();
  assert.equal(rotate.isValidAt(sim, chair.x, chair.y), true);
  // Empty floor tile: not valid.
  let empty = null;
  for (let y = 0; y < sim.grid.rows && !empty; y++) {
    for (let x = 0; x < sim.grid.cols; x++) {
      const t = sim.grid.getTile(x, y);
      if (t && t.type === 'floor' && !t.building) { empty = { x, y }; break; }
    }
  }
  assert.ok(empty);
  assert.equal(rotate.isValidAt(sim, empty.x, empty.y), false);
});

test('RotateApp is a click-through no-op on tiles with nothing', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const rotate = new ctx.RotateApp();
  // Clicking an empty tile must not throw and must not mutate any building.
  rotate.onMapClick(sim, { x: 0, y: 0 });
  for (const b of sim.buildings) assert.equal(b.facing, null);
});

test('save/load round-trips chair facing', () => {
  const ctx = loadSim({ seed: 1 });
  const sim = new ctx.Simulation();
  sim.seedDemo();
  const chair = sim.buildings.find(b => b.type === 'chair');
  chair.facing = 2;
  sim.dayState = 'dayEnd';
  const json = ctx.serializeSim(sim, null);
  const { sim: loaded } = ctx.deserializeSim(json);
  const loadedChair = loaded.buildings.find(b =>
    b.type === 'chair' && b.x === chair.x && b.y === chair.y);
  assert.ok(loadedChair);
  assert.equal(loadedChair.facing, 2);
});
