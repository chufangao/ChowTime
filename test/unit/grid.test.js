const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('Grid bounds checks reject out-of-range coords', () => {
  const ctx = loadSim();
  const g = new ctx.Grid(5, 4);
  assert.equal(g.inBounds(0, 0), true);
  assert.equal(g.inBounds(4, 3), true);
  assert.equal(g.inBounds(5, 0), false);
  assert.equal(g.inBounds(-1, 0), false);
});

test('placeBuilding fills tile and removeBuildingAt clears it', () => {
  const ctx = loadSim();
  const g = new ctx.Grid(5, 4);
  const stove = new ctx.Stove();
  assert.ok(g.placeBuilding(stove, 2, 2));
  assert.equal(g.getTile(2, 2).building, stove);
  // Second place on same tile fails.
  assert.equal(g.placeBuilding(new ctx.Stove(), 2, 2), false);
  const removed = g.removeBuildingAt(2, 2);
  assert.equal(removed, stove);
  assert.equal(g.getTile(2, 2).building, null);
});

test('Pathfinder finds a straight path on empty grid', () => {
  const ctx = loadSim();
  const g = new ctx.Grid(6, 6);
  const pf = new ctx.Pathfinder(g);
  const path = pf.findPath(0, 0, (x, y) => x === 5 && y === 0);
  assert.ok(path);
  assert.equal(path[0].x, 0);
  assert.equal(path[path.length - 1].x, 5);
  assert.equal(path.length, 6);
});

test('Pathfinder routes around a wall', () => {
  const ctx = loadSim();
  const g = new ctx.Grid(5, 5);
  for (let y = 0; y < 4; y++) g.setType(2, y, 'wall');     // wall up to y=3, gap at y=4
  const pf = new ctx.Pathfinder(g);
  const path = pf.findPath(0, 0, (x, y) => x === 4 && y === 0);
  assert.ok(path, 'path should exist via the y=4 gap');
  // Confirm the path never crosses a walled tile.
  for (const step of path) assert.notEqual(g.getTile(step.x, step.y).type, 'wall');
});

test('Pathfinder returns null when target is unreachable', () => {
  const ctx = loadSim();
  const g = new ctx.Grid(3, 3);
  for (let y = 0; y < 3; y++) g.setType(1, y, 'wall');     // full vertical wall
  const pf = new ctx.Pathfinder(g);
  const path = pf.findPath(0, 0, (x, y) => x === 2 && y === 0);
  assert.equal(path, null);
});
