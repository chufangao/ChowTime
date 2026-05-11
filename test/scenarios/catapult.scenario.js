// Scenario: a single Catapult Stove fires a burger across the room and a
// customer eats without ever being approached by an employee. We watch the
// customer through their full lifecycle to confirm the catapult delivery
// path actually skips the chef's TO_TABLE_DELIVER walk.

module.exports = {
  name: 'catapult_solo',
  seed: 7,
  build(sim) {
    sim.placeBuilding('catapult_stove', 10, 1, true);
    sim.placeBuilding('chair',  3, 2, true);
    sim.placeBuilding('table',  3, 3, true);
    sim.hireEmployee(true);
    sim.trafficMultiplier = 5;

    // Force every spawn to want a BURGER so the catapult always has a target.
    const origSpawn = sim.spawnCustomer.bind(sim);
    sim.spawnCustomer = function () {
      const ok = origSpawn();
      if (ok) {
        const c = sim.customers[sim.customers.length - 1];
        c.foodPref = 'BURGER';
      }
      return ok;
    };
    // Track whether any employee ever entered TO_TABLE_DELIVER. (They might
    // still walk to the stove to start cooking — that's expected — but they
    // must never carry a plate to the table.)
    sim._sawDeliverState = false;
    const origUpdate = sim.update.bind(sim);
    sim.update = function (dt) {
      origUpdate(dt);
      for (const e of sim.employees) {
        if (e.state === 'to-table-deliver') sim._sawDeliverState = true;
      }
    };
  },
  untilDay: 1,
  autoResolveEvents: false,
  expect(result, sim) {
    if (sim.runStats.served < 1) {
      throw new Error('expected at least one customer served by catapult');
    }
    if (sim._sawDeliverState) {
      throw new Error('an employee entered TO_TABLE_DELIVER — catapult should bypass it');
    }
  },
};
