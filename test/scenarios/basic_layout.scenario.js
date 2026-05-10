// Scenario: build a minimal restaurant from scratch (no seedDemo), hire the
// starter chef, run a single day. Asserts the player-facing API is enough to
// drive the game end-to-end.

module.exports = {
  name: 'basic_layout',
  seed: 41,
  build(sim) {
    sim.placeBuilding('stove', 10, 1, true);
    sim.placeBuilding('stove', 10, 2, true);
    sim.placeBuilding('sink',  10, 6, true);
    sim.placeBuilding('chair',  3, 2, true);
    sim.placeBuilding('table',  3, 3, true);
    sim.placeBuilding('chair',  6, 2, true);
    sim.placeBuilding('table',  6, 3, true);
    sim.hireEmployee(true);
    sim.trafficMultiplier = 5;
  },
  untilDay: 1,
  autoResolveEvents: false,
  expect(result, sim) {
    if (result.dayState !== 'dayEnd') throw new Error('day1 didn\'t finish');
    if (sim.daySpawned < sim.dayQuota) throw new Error('quota not met');
    if (sim.lives < 1) throw new Error('lost too many lives on the easy scenario');
  },
};
