// Scenario: a procedurally generated layout plays a full day. Proves
// generated layouts are not just validateLayout-valid but actually playable —
// customers can pathfind to the table, employees can reach the stove and
// sink, and the quota gets met.

module.exports = {
  name: 'generated_layout',
  seed: 5,
  build(sim, ctx) {
    // Roll a generated layout with a fixed sub-seed and apply it. We don't use
    // seedDemo because that rolls via pickRandomLayout (which has its own
    // catalog-vs-generator mix). Here we want the generator path explicitly.
    const layout = ctx.generateLayout(20240509);
    if (!layout) throw new Error('generator returned null for seed 20240509');
    sim.replaceLayout(layout);
    sim.hireEmployee(true);
    sim.trafficMultiplier = 5;
  },
  untilDay: 1,
  autoResolveEvents: false,
  expect(result, sim) {
    if (result.dayState !== 'dayEnd') {
      throw new Error(`day1 did not finish, ended in ${result.dayState}`);
    }
    if (sim.daySpawned < sim.dayQuota) {
      throw new Error(`quota not met: spawned ${sim.daySpawned} / ${sim.dayQuota}`);
    }
    if (sim.runStats.served < 1) {
      throw new Error('no customers served on the generated layout');
    }
  },
};
