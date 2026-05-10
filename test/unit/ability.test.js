const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../harness.js');

test('abilityMult returns 1 when entity has no abilities', () => {
  const ctx = loadSim();
  assert.equal(ctx.abilityMult({}, 'cookTimeMult', 'BURGER'), 1);
  assert.equal(ctx.abilityMult({ abilities: [] }, 'tipMult'), 1);
});

test('abilityMult stacks multiplicatively', () => {
  const ctx = loadSim();
  const e = { abilities: ['fast_hands', 'showstopper'] };
  // fast_hands cookTimeMult = 0.85; showstopper has no cookTimeMult
  assert.equal(ctx.abilityMult(e, 'cookTimeMult', 'BURGER'), 0.85);
  // showstopper tipMult = 1.4; fast_hands has no tipMult
  assert.equal(ctx.abilityMult(e, 'tipMult'), 1.4);
});

test('food-targeted abilities only apply to matching foodKey', () => {
  const ctx = loadSim();
  const e = { abilities: ['knife_skills'] };   // burger 0.65, others 1
  assert.equal(ctx.abilityMult(e, 'cookTimeMult', 'BURGER'), 0.65);
  assert.equal(ctx.abilityMult(e, 'cookTimeMult', 'PIZZA'),  1);
});

test('abilitySum aggregates extraOrders', () => {
  const ctx = loadSim();
  assert.equal(ctx.abilitySum({ abilities: ['big_appetite'] }, 'extraOrders'), 1);
  assert.equal(ctx.abilitySum({ abilities: [] }, 'extraOrders'), 0);
});

test('fireAbilityHook calls each matching hook with ctx + entity + ability', () => {
  const ctx = loadSim();
  const seen = [];
  // Patch ABILITIES to install a probe hook just for this test (without
  // disturbing the standard table for other tests — each loadSim call yields
  // a fresh context).
  ctx.ABILITIES.__probe = {
    id: '__probe', kind: 'chef',
    onCookStart: (c) => seen.push(c),
  };
  const entity = { abilities: ['__probe'] };
  ctx.fireAbilityHook(entity, 'onCookStart', { sim: { tag: 'X' }, foodKey: 'BURGER' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].entity, entity);
  assert.equal(seen[0].sim.tag, 'X');
  assert.equal(seen[0].foodKey, 'BURGER');
  assert.equal(seen[0].ability.id, '__probe');
});

test('every ABILITIES entry has id/kind/name', () => {
  const ctx = loadSim();
  for (const [key, a] of Object.entries(ctx.ABILITIES)) {
    assert.equal(a.id, key, `${key} self-id mismatch`);
    assert.ok(a.kind === 'chef' || a.kind === 'customer', `${key} bad kind`);
    assert.ok(typeof a.name === 'string' && a.name.length > 0);
  }
});
