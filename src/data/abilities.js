/* ============================================================================
 * data/abilities.js — chef + customer ability table and resolver helpers
 * ============================================================================ */

/* ---- Ability system -------------------------------------------------------- */
// Abilities are referenced by string key on a preset's `abilities` array and
// resolved via ABILITIES[key] at call sites. Each ability may declare:
//   - Multiplier hooks (combined multiplicatively via abilityMult):
//       cookTimeMult(foodKey)   — chef-side, scales cook duration
//       eatTimeMult(foodKey)    — customer-side, scales eat duration
//       tipMult()               — either side, scales tip payout
//       angerMult(stateKey)     — customer-side, scales anger rate
//   - Additive hooks (summed via abilitySum):
//       extraOrders()           — customer-side, number of additional courses
//   - Event hooks fired at specific moments (no return value):
//       onCookStart(ctx), onCookComplete(ctx), onOrderPlaced(ctx),
//       onEat(ctx), onLeave(ctx)
//     ctx is {sim, entity, ability, foodKey?}. Hooks typically fire popups via
//     sim.emitPopup(entity, icon, label).
const ABILITIES = {
  // ---- Chef abilities ----
  knife_skills: {
    id: 'knife_skills', kind: 'chef', name: 'Knife Skills', icon: '🔪',
    description: 'Burgers cook 35% faster.',
    cookTimeMult: (foodKey) => foodKey === 'BURGER' ? 0.65 : 1,
    onCookStart: (ctx) => { if (ctx.foodKey === 'BURGER') ctx.sim.emitPopup(ctx.entity, '🔪', 'Knife Skills'); },
  },
  pizza_master: {
    id: 'pizza_master', kind: 'chef', name: 'Pizza Master', icon: '🍕',
    description: 'Pizzas cook 40% faster.',
    cookTimeMult: (foodKey) => foodKey === 'PIZZA' ? 0.60 : 1,
    onCookStart: (ctx) => { if (ctx.foodKey === 'PIZZA') ctx.sim.emitPopup(ctx.entity, '🍕', 'Pizza Master'); },
  },
  soup_savant: {
    id: 'soup_savant', kind: 'chef', name: 'Soup Savant', icon: '🥄',
    description: 'Soups cook 45% faster.',
    cookTimeMult: (foodKey) => foodKey === 'SOUP' ? 0.55 : 1,
    onCookStart: (ctx) => { if (ctx.foodKey === 'SOUP') ctx.sim.emitPopup(ctx.entity, '🥄', 'Soup Savant'); },
  },
  green_thumb: {
    id: 'green_thumb', kind: 'chef', name: 'Green Thumb', icon: '🥗',
    description: 'Salads cook 50% faster.',
    cookTimeMult: (foodKey) => foodKey === 'SALAD' ? 0.50 : 1,
    onCookStart: (ctx) => { if (ctx.foodKey === 'SALAD') ctx.sim.emitPopup(ctx.entity, '🥗', 'Green Thumb'); },
  },
  fast_hands: {
    id: 'fast_hands', kind: 'chef', name: 'Fast Hands', icon: '⚡',
    description: 'Every dish cooks 15% faster.',
    cookTimeMult: () => 0.85,
    onCookStart: (ctx) => ctx.sim.emitPopup(ctx.entity, '⚡', 'Fast Hands'),
  },
  showstopper: {
    id: 'showstopper', kind: 'chef', name: 'Showstopper', icon: '✨',
    description: 'Every plate this chef serves tips 40% more.',
    tipMult: () => 1.4,
  },
  perfectionist: {
    id: 'perfectionist', kind: 'chef', name: 'Perfectionist', icon: '💎',
    description: 'Dishes take 20% longer but tip 60% more.',
    cookTimeMult: () => 1.20,
    tipMult: () => 1.60,
    onCookStart: (ctx) => ctx.sim.emitPopup(ctx.entity, '💎', 'Perfecting…'),
  },
  burger_boss: {
    id: 'burger_boss', kind: 'chef', name: 'Burger Boss', icon: '🍔',
    description: 'Burgers cook 50% faster and tip 25% more when this chef cooks them.',
    cookTimeMult: (foodKey) => foodKey === 'BURGER' ? 0.50 : 1,
    tipMult:      () => 1.25,
    onCookStart:  (ctx) => { if (ctx.foodKey === 'BURGER') ctx.sim.emitPopup(ctx.entity, '🍔', 'Burger Boss'); },
  },
  mentor: {
    id: 'mentor', kind: 'chef', name: 'Mentor', icon: '📖',
    description: 'Flavorful, patient cooking. Dishes take 10% longer but all plates tip 20% more.',
    cookTimeMult: () => 1.10,
    tipMult:      () => 1.20,
  },
  eager_intern: {
    id: 'eager_intern', kind: 'chef', name: 'Eager Intern', icon: '🥴',
    description: 'Means well. 20% chance to burn the dish, 30% chance to cook it in half the time.',
    cookTimeMult: () => {
      const r = Math.random();
      if (r < 0.20) return 1.80;
      if (r < 0.50) return 0.50;
      return 1.0;
    },
    onCookStart: (ctx) => ctx.sim.emitPopup(ctx.entity, '🥴', 'Trying…'),
  },
  road_runner: {
    id: 'road_runner', kind: 'chef', name: 'Road Runner', icon: '🏁',
    description: 'All dishes cook 25% faster.',
    cookTimeMult: () => 0.75,
    onCookStart: (ctx) => ctx.sim.emitPopup(ctx.entity, '🏁', 'Road Runner'),
  },

  // ---- Customer abilities ----
  big_appetite: {
    id: 'big_appetite', kind: 'customer', name: 'Big Appetite', icon: '🍴',
    description: 'Orders two dishes before leaving.',
    extraOrders: () => 1,
    onEnter: (ctx) => ctx.sim.emitPopup(ctx.entity, '🍴', 'Big Appetite'),
  },
  slow_eater: {
    id: 'slow_eater', kind: 'customer', name: 'Slow Eater', icon: '🐢',
    description: 'Takes 75% longer to eat.',
    eatTimeMult: () => 1.75,
    onEnter: (ctx) => ctx.sim.emitPopup(ctx.entity, '🐢', 'Slow Eater'),
  },
  big_tipper: {
    id: 'big_tipper', kind: 'customer', name: 'Big Tipper', icon: '💵',
    description: 'Tips double.',
    tipMult: () => 2.0,
    onEnter: (ctx) => ctx.sim.emitPopup(ctx.entity, '💵', 'Big Tipper'),
  },
  picky: {
    id: 'picky', kind: 'customer', name: 'Picky', icon: '😤',
    description: 'Grows angry 50% faster while waiting for food.',
    angerMult: (stateKey) => stateKey === 'waitingFood' ? 1.5 : 1,
    onEnter: (ctx) => ctx.sim.emitPopup(ctx.entity, '😤', 'Picky'),
  },
  patient: {
    id: 'patient', kind: 'customer', name: 'Patient', icon: '😌',
    description: 'Gains anger 40% more slowly.',
    angerMult: () => 0.6,
    onEnter: (ctx) => ctx.sim.emitPopup(ctx.entity, '😌', 'Patient'),
  },
};

// Odds table for random customer abilities. Rolled per customer; may yield none.
const CUSTOMER_ABILITY_ROLL = [
  { id: 'big_appetite', weight: 1.0 },
  { id: 'slow_eater',   weight: 1.0 },
  { id: 'big_tipper',   weight: 1.0 },
  { id: 'picky',        weight: 1.2 },
  { id: 'patient',      weight: 0.8 },
];

function abilitiesOf(entity) {
  const ids = entity && entity.abilities;
  if (!ids || !ids.length) return [];
  const out = [];
  for (const id of ids) { const a = ABILITIES[id]; if (a) out.push(a); }
  return out;
}
function abilityMult(entity, prop, ...args) {
  let m = 1;
  for (const a of abilitiesOf(entity)) {
    const fn = a[prop]; if (typeof fn === 'function') m *= fn(...args);
  }
  return m;
}
function abilitySum(entity, prop, ...args) {
  let s = 0;
  for (const a of abilitiesOf(entity)) {
    const fn = a[prop]; if (typeof fn === 'function') s += fn(...args);
  }
  return s;
}
function fireAbilityHook(entity, hookName, ctx) {
  for (const a of abilitiesOf(entity)) {
    const fn = a[hookName];
    if (typeof fn === 'function') fn({ ...ctx, entity, ability: a });
  }
}
