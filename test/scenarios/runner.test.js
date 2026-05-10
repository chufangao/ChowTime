const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSim } = require('../harness.js');
const { runScenario } = require('../scenario.js');

const dir = __dirname;
const scenarioFiles = fs.readdirSync(dir).filter(f => f.endsWith('.scenario.js'));

for (const file of scenarioFiles) {
  const scenario = require(path.join(dir, file));
  test(`scenario: ${scenario.name}`, () => {
    const ctx = loadSim({ seed: scenario.seed || 1 });
    const sim = new ctx.Simulation();
    scenario.build(sim);
    const result = runScenario(sim, {
      steps: scenario.steps || [],
      untilDay: scenario.untilDay || 1,
      autoResolveEvents: scenario.autoResolveEvents,
      maxSimSec: scenario.maxSimSec || 30 * 60,
    });
    scenario.expect(result, sim);
  });
}
