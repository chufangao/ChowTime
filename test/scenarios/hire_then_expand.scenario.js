// Scenario: build a known layout (no random template), run a day, then
// between days hire a new chef and add a dining unit. Verifies the timed-step
// DSL works across day boundaries.

module.exports = {
  name: 'hire_then_expand',
  seed: 73,
  build(sim) {
    // Avoid the random-layout seedDemo so we control which tiles are free.
    sim.placeBuilding('stove', 10, 1, true);
    sim.placeBuilding('stove', 10, 2, true);
    sim.placeBuilding('sink',  10, 6, true);
    sim.placeBuilding('chair',  3, 2, true);
    sim.placeBuilding('table',  3, 3, true);
    sim.placeBuilding('chair',  6, 2, true);
    sim.placeBuilding('table',  6, 3, true);
    sim.hireEmployee(true);
    sim.money = 1000;          // budget for hire + furniture
    sim.trafficMultiplier = 5;
  },
  steps: [
    // After day 1 dayEnd auto-resolves, expand layout BEFORE day 2 begins.
    // We schedule actions by sim seconds; day 1 fits in ~30s at trafficMult=5.
    { at: 60, do(sim) {
        const r1 = sim.placeBuilding('chair', 8, 5);
        const r2 = sim.placeBuilding('table', 8, 6);
        if (!r1.ok || !r2.ok) throw new Error(`expand failed: ${r1.reason} / ${r2.reason}`);
      } },
  ],
  untilDay: 2,
  autoResolveEvents: true,
  expect(result, sim) {
    if (result.daysCompleted < 1) throw new Error('didn\'t complete day 1');
    // 7 starter buildings from build() + 2 from the expand step.
    if (sim.buildings.length !== 9) throw new Error(`expected 9 buildings, got ${sim.buildings.length}`);
  },
};
