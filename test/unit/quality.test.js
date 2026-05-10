const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('computeQuality stays in [0, 2] across the full INT range', () => {
  const ctx = loadSim({ seed: 1 });
  for (let i = 0; i < 1000; i++) {
    for (let intStat = 0; intStat <= 10; intStat += 0.5) {
      const q = ctx.computeQuality(intStat);
      assert.ok(q >= 0 && q <= 2, `quality ${q} out of [0,2] for INT ${intStat}`);
    }
  }
});

test('higher INT yields higher average quality', () => {
  const ctx = loadSim({ seed: 1 });
  const lowAvg  = avgN(() => ctx.computeQuality(2),  500);
  const highAvg = avgN(() => ctx.computeQuality(10), 500);
  assert.ok(highAvg > lowAvg, `high-INT avg ${highAvg} should beat low-INT ${lowAvg}`);
});

test('clamp respects lo/hi', () => {
  const ctx = loadSim();
  assert.equal(ctx.clamp(-5, 0, 10), 0);
  assert.equal(ctx.clamp(15, 0, 10), 10);
  assert.equal(ctx.clamp(5,  0, 10), 5);
});

function avgN(f, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += f();
  return s / n;
}
