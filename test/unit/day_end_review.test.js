/* ============================================================================
 * test/unit/day_end_review.test.js — Review tab chef-roster scrolling
 * ============================================================================
 * The Review tab caps the visible chef cards to a window; with a large roster
 * (e.g. many chefs assigned to spawn pads) the rest must scroll into view via
 * the mouse wheel rather than being silently truncated.
 * ========================================================================== */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootFullShell } = require('../harness.js');

// Put the shell at a resolved dayEnd so the event modal doesn't auto-open over
// the Review panel, and open Review with a big roster.
function openReviewWithChefs(n) {
  const { mgr, sim } = bootFullShell({ seed: 1, width: 1240, height: 600 });
  while (sim.employees.length < n) sim.hireEmployee(true);
  sim.day = 3; sim.dayState = 'dayEnd';
  sim.currentEvent = { id: 'ev', kind: 'event' };
  sim.eventOutcome = { passed: true };
  mgr.open('day_end');
  mgr.update(sim);                 // sets mgr._sim and keeps day_end active
  return { mgr, sim, app: mgr.get('day_end') };
}

test('wheel scrolls the Review roster and clamps to the last row', () => {
  const { mgr, app, sim } = openReviewWithChefs(15);
  assert.equal(mgr.activeAppId, 'day_end', 'Review stays active (no event modal)');
  const maxScroll = Math.ceil(sim.employees.length / 2) - app._visibleChefRows();
  assert.ok(maxScroll > 0, 'precondition: roster overflows the window');

  assert.equal(app.scrollRow, 0);
  mgr.forwardWheel(null, 1);
  mgr.forwardWheel(null, 1);
  assert.equal(app.scrollRow, 2, 'wheel-down advances by one row per notch');

  for (let i = 0; i < 20; i++) mgr.forwardWheel(null, 1);
  assert.equal(app.scrollRow, maxScroll, 'scroll clamps at the last row');

  mgr.forwardWheel(null, -1);
  assert.equal(app.scrollRow, maxScroll - 1, 'wheel-up scrolls back');

  // Rendering at any offset must not throw.
  app.update(sim);
});

test('small rosters do not scroll and reset on open', () => {
  const { mgr, app } = openReviewWithChefs(2);
  mgr.forwardWheel(null, 1);
  assert.equal(app.scrollRow, 0, 'no scrolling when everything fits');
  // Re-opening resets the offset.
  app.scrollRow = 3;
  app.onOpen();
  assert.equal(app.scrollRow, 0);
});
