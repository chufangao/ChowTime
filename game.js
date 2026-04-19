/* ============================================================================
 * game.js  —  pure game logic. Zero Phaser dependencies.
 * ============================================================================
 * Contains:
 *   - Gameplay tuning (FOODS, CONFIG, grid dimensions)
 *   - Grid + A* pathfinding
 *   - Buildings (Stove, Table, Chair, Sink)
 *   - Entities (Customer, Employee)
 *   - Simulation root that ticks everything
 *
 * Anything here could run headlessly (e.g. in a test harness). Classes read
 * and mutate simulation state but NEVER touch graphics objects, scenes,
 * Phaser.Input, tweens, or textures.
 *
 * Referenced from sprites.js (visual palettes attached to entities) and from
 * scene.js (the orchestrator). game.js itself imports nothing.
 */

/* ---- Grid dimensions ------------------------------------------------------- */
const COLS = 12;
const ROWS = 8;

/* ---- Food menu (gameplay + a bit of display info) -------------------------- */
const FOODS = {
  BURGER: { name: 'Burger', cookTime: 4, price: 18, color: 0xd17a44, icon: '🍔' },
  SALAD:  { name: 'Salad',  cookTime: 2, price: 12, color: 0x7cb342, icon: '🥗' },
  PIZZA:  { name: 'Pizza',  cookTime: 5, price: 24, color: 0xe74c3c, icon: '🍕' },
  SOUP:   { name: 'Soup',   cookTime: 3, price: 15, color: 0xf4a261, icon: '🍲' },
};
const FOOD_KEYS = Object.keys(FOODS);

/* ---- Gameplay tuning ------------------------------------------------------- */
const CONFIG = {
  customerSpawnInterval: 6,
  customerMaxConcurrent: 12,
  customerSpeed:         3.2,
  eatDuration:           6,
  angerMax:              100,
  angerRates: { seekingSeat: 2.5, walkingToSeat: 1.0, waitingFood: 3.5, eating: 0 },
  employeeSpeed: 4.5,
  startingMoney: 200,
  costs: { stove: 150, table: 50, chair: 20, sink: 120, employee: 200 },
  refundRatio: 0.5,
  trafficLevels: [1, 2, 3, 5],
  speedLevels:   [1, 2, 4],
  tiredMult:     0.75,   // scales all stats (except STR) while a chef is tired
  tipRateBase:   0.15,   // baseline tip fraction of meal price at quality×cha = 1
  dayBaseQuota:     4,   // day-1 customer quota
  dayGrowthFactor:  1.5, // ceil(dayBaseQuota * factor^(day-1))
  dayBreakDuration: 6,   // seconds of paused spawning between days
};

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ---- Stat-driven helpers (pure) ------------------------------------------- */
function computeQuality(intStat) {
  // INT 1..10 → raw [0.2, 2.0] with a touch of jitter. Clamped to [0, 2].
  const jitter = (Math.random() - 0.5) * 0.2;
  return clamp(intStat / 5 + jitter, 0, 2);
}

function computeTip(customer) {
  // Needs: customer.seatedAt, deliveredAt, table.plate.quality, and the
  // delivering chef's CHA. The chef ref is stashed on the customer at delivery
  // (order.deliveryEmployee is cleared right after, so reading it here would
  // be null).
  const price = FOODS[customer.foodPref].price;
  const plate = customer.table && customer.table.plate;
  const quality = plate && plate.quality != null ? plate.quality : 1.0;
  const cook    = customer.deliveredBy;
  const cha     = cook ? cook.effStat('cha') : 5;

  const waitSec = (customer.deliveredAt != null && customer.seatedAt != null)
                  ? customer.deliveredAt - customer.seatedAt : 10;
  const waitFac = clamp(1 - (waitSec - 4) / 20, 0, 1);
  const effQual = quality * waitFac;                  // 0 .. 2
  const tipMult = 0.5 + (cha - 1) / 9;                // 0.5 .. 1.5
  const noise   = 1 + (Math.random() - 0.5) * 0.2;    // 0.9 .. 1.1
  const frac    = effQual * tipMult * CONFIG.tipRateBase;
  let tip = Math.max(0, Math.round(price * frac * noise));
  // Ability tip multipliers — cook-side (e.g. Showstopper) and customer-side
  // (e.g. Big Tipper) stack multiplicatively.
  if (cook) tip = tip * abilityMult(cook, 'tipMult');
  tip = tip * abilityMult(customer, 'tipMult');
  // Status bonus: a starstruck chef tips 25% more next day.
  if (cook && cook.status && cook.status.kind === 'starstruck') tip = tip * 1.25;
  return Math.round(tip);
}

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
/* ---- Between-day events ---------------------------------------------------- */
// Each event is resolved by assigning one hired chef. The chef rolls 1d10 +
// their relevant stat against the event's DC. Pass → reward, fail → penalty.
// The assigned chef always gets `statusOnAssign` applied on day start (the
// starter chef is immune to `kind: 'busy'`). Some events apply a forecast
// profile that shapes the NEXT day (food bias, volume, tip mult).
//
// Shape of each effect returned from onPass/onFail:
//   { deltaMoney?: number, profile?: {...}, statusOverride?: {...}, msg: string }
// msg is the terse headline shown inline in the modal after resolution.
const EVENTS = [
  {
    id: 'burglar', icon: '🦹', title: 'Masked Burglar',
    flavor: 'A hooded figure rattles the back door after close.',
    stat: 'str', statLabel: 'STR',
    dc: (day) => 5 + Math.min(day, 7),
    onPass: (sim, chef) => ({
      deltaMoney: 0,
      msg: `${chef.name} scared them off. Safe.`,
    }),
    onFail: (sim, chef) => {
      const today = Math.max(0, sim.money - sim.dayStartMoney);
      const loss  = Math.floor(today * 0.5);
      sim.money   = Math.max(0, sim.money - loss);
      return { deltaMoney: -loss, msg: `They got in. Lost $${loss}.` };
    },
  },
  {
    id: 'drunk_brawl', icon: '🥊', title: 'Table 3 Brawl',
    flavor: 'Two regulars start throwing punches over the salt.',
    stat: 'str', statLabel: 'STR',
    dc: (day) => 4 + Math.min(day, 6),
    onPass: (sim, chef) => {
      const bonus = 30 + 5 * chef.effStat('cha');
      sim.money += bonus;
      return { deltaMoney: bonus, msg: `Broken up. Grateful table tipped $${bonus}.` };
    },
    onFail: (sim, chef) => {
      sim.money = Math.max(0, sim.money - 40);
      return { deltaMoney: -40, msg: `Furniture smashed. Repairs cost $40.` };
    },
  },
  {
    id: 'health_inspector', icon: '📋', title: 'Health Inspector',
    flavor: 'Clipboard. Gloves. No smile.',
    stat: 'int', statLabel: 'INT',
    dc: (day) => 5 + Math.min(day, 7),
    onPass: (sim, chef) => ({
      profile: { tipMult: 1.10, label: 'A-grade boosts tips +10% tomorrow' },
      msg: `A-grade. Tomorrow tips +10%.`,
    }),
    onFail: (sim, chef) => {
      sim.money = Math.max(0, sim.money - 100);
      return {
        deltaMoney: -100,
        statusOverride: { kind: 'stressed', daysLeft: 1 },
        msg: `$100 fine. ${chef.name} stressed tomorrow.`,
      };
    },
  },
  {
    id: 'rodent_sighting', icon: '🐀', title: 'Rodent Sighting',
    flavor: 'Something moved by the walk-in.',
    stat: 'int', statLabel: 'INT',
    dc: (day) => 4 + Math.min(day, 6),
    onPass: (sim, chef) => ({ msg: `Trapped it in time. No loss.` }),
    onFail: (sim, chef) => ({
      profile: { tipMult: 0.9, label: 'Rumors spread — tips −10% tomorrow' },
      msg: `Whispers spread. Tomorrow tips −10%.`,
    }),
  },
  {
    id: 'food_critic', icon: '📝', title: 'Food Critic',
    flavor: 'Table 4 is scribbling in a notebook.',
    stat: 'int', statLabel: 'INT',
    dc: (day) => 6 + Math.min(day, 7),
    onPass: (sim, chef) => {
      sim.money += 200;
      return { deltaMoney: 200, msg: `Rave review! +$200.` };
    },
    onFail: (sim, chef) => ({
      profile: { quotaMult: 0.8, label: 'Slow reviews — fewer customers tomorrow' },
      msg: `Lukewarm review. Fewer customers tomorrow.`,
    }),
  },
  {
    id: 'supply_late', icon: '🚚', title: 'Supply Truck Late',
    flavor: 'Truck broke down on the interstate.',
    stat: 'dex', statLabel: 'DEX',
    dc: (day) => 5 + Math.min(day, 6),
    onPass: (sim, chef) => ({ msg: `Improvised perfectly. Stock intact.` }),
    onFail: (sim, chef) => {
      sim.money = Math.max(0, sim.money - 60);
      return { deltaMoney: -60, msg: `Emergency restock. −$60.` };
    },
  },
  {
    id: 'power_flicker', icon: '💡', title: 'Power Flicker',
    flavor: 'The lights blink twice, then stay.',
    stat: 'dex', statLabel: 'DEX',
    dc: (day) => 4 + Math.min(day, 6),
    onPass: (sim, chef) => ({ msg: `Breakers reset. All clear.` }),
    onFail: (sim, chef) => ({
      profile: { cookTimeMult: 1.4, label: 'Brownout — stoves slow 40% tomorrow' },
      msg: `Half the stoves flaky tomorrow.`,
    }),
  },
  {
    id: 'rival_poach', icon: '💼', title: 'Rival Scout',
    flavor: 'A scout leaves a business card on a chef\'s station.',
    stat: 'cha', statLabel: 'CHA',
    dc: (day) => 5 + Math.min(day, 6),
    onPass: (sim, chef) => ({
      statusOverride: { kind: 'starstruck', daysLeft: 1 },
      msg: `${chef.name} charmed the scout. Starstruck tomorrow.`,
    }),
    onFail: (sim, chef) => {
      sim.money = Math.max(0, sim.money - 150);
      return { deltaMoney: -150, msg: `Counter-offer to retain ${chef.name}. −$150.` };
    },
  },
  {
    id: 'celebrity', icon: '🕶️', title: 'Celebrity Visit',
    flavor: 'Sunglasses indoors, at 9pm.',
    stat: 'cha', statLabel: 'CHA',
    dc: (day) => 6 + Math.min(day, 7),
    onPass: (sim, chef) => ({
      profile: { tipMult: 1.5, label: 'Viral post — tips +50% tomorrow' },
      statusOverride: { kind: 'starstruck', daysLeft: 1 },
      msg: `Viral post incoming. Tips +50% tomorrow!`,
    }),
    onFail: (sim, chef) => ({
      profile: { tipMult: 0.8, label: 'Bad post — tips −20% tomorrow' },
      msg: `They posted the bad plate. Tips −20% tomorrow.`,
    }),
  },
  {
    id: 'party_booking', icon: '🎉', title: 'Birthday Booking',
    flavor: 'A party wants the back room tomorrow night.',
    stat: 'cha', statLabel: 'CHA',
    dc: (day) => 5 + Math.min(day, 6),
    onPass: (sim, chef) => ({
      profile: { quotaMult: 1.5, tipMult: 1.15, label: 'Big party tomorrow — +50% customers, +15% tips' },
      msg: `Booked! Big crowd tomorrow.`,
    }),
    onFail: (sim, chef) => {
      sim.money = Math.max(0, sim.money - 80);
      return { deltaMoney: -80, msg: `They walked. Refund $80.` };
    },
  },
  {
    id: 'rush_order', icon: '🛵', title: 'Rush Delivery',
    flavor: 'A courier whale needs 15 covers, yesterday.',
    stat: 'spd', statLabel: 'SPD',
    dc: (day) => 5 + Math.min(day, 7),
    onPass: (sim, chef) => {
      sim.money += 60;
      return { deltaMoney: 60, msg: `Out the door on time. +$60.` };
    },
    onFail: (sim, chef) => {
      sim.money = Math.max(0, sim.money - 40);
      return { deltaMoney: -40, msg: `Missed the window. Refund $40.` };
    },
  },
  {
    id: 'pipe_leak', icon: '🚰', title: 'Pipe Leak',
    flavor: 'Water pooling under the sink.',
    stat: 'spd', statLabel: 'SPD',
    dc: (day) => 4 + Math.min(day, 6),
    onPass: (sim, chef) => ({ msg: `Caught it fast. No damage.` }),
    onFail: (sim, chef) => {
      sim.money = Math.max(0, sim.money - 70);
      return { deltaMoney: -70, msg: `Plumber bill. −$70.` };
    },
  },
];

function rollDailyEvent(day) {
  return EVENTS[(Math.random() * EVENTS.length) | 0];
}

// Fresh forecast used when an event does not set its own profile. Keeps
// tomorrow's shape interesting even on quiet events.
const FORECASTS = [
  { label: 'Pizza crowd tomorrow',          profile: { foodBias: 'PIZZA' } },
  { label: 'Burger fans in town tomorrow',  profile: { foodBias: 'BURGER' } },
  { label: 'Salad Tuesday — healthy crowd', profile: { foodBias: 'SALAD' } },
  { label: 'Soup weather expected',         profile: { foodBias: 'SOUP' } },
  { label: 'Generous tippers tomorrow',     profile: { tipMult: 1.2 } },
  { label: 'Tightwads in tomorrow',         profile: { tipMult: 0.85 } },
  { label: 'Big crowd tomorrow',            profile: { quotaMult: 1.35 } },
  { label: 'Slow morning tomorrow',         profile: { quotaMult: 0.8 } },
  { label: 'Nothing unusual on the books',  profile: {} },
];
function rollBaseForecast() {
  return FORECASTS[(Math.random() * FORECASTS.length) | 0];
}

// Picks at most one ability per customer. ~55% have no ability, else weighted.
function rollCustomerAbilities() {
  if (Math.random() < 0.55) return [];
  const total = CUSTOMER_ABILITY_ROLL.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const entry of CUSTOMER_ABILITY_ROLL) {
    r -= entry.weight;
    if (r <= 0) return [entry.id];
  }
  return [];
}


/* ---- Chef presets ---------------------------------------------------------- */
// Starter chefs seeded at game start. Skin tone is randomized from SKIN_TONES
// (defined in sprites.js) per instance so the two starters don't look identical.
const STARTER_CHEF = {
  name: 'Line Cook',
  bio:  'does the job. no questions asked.',
  dex: 5, spd: 5, str: 5, int: 5, cha: 5,
  visual: { hat: 0, hasHair: false },   // skinColor filled in at construction
  cost: 0,
  abilities: [],
  isStarter: true,        // immune to disabling statuses from events
};

// Fixed roster of 10 hireable chefs. Each can only be hired once; the pool
// shrinks as the player recruits. All colors are raw hex so this stays
// Phaser-free / sprites-free.
const CHEF_ROSTER = [
  { name: 'Marco "The Knife" Ferraro',
    bio:  'twenty years in a Naples kitchen. does not smile. the blade is an extension of his hand, and burgers are his specialty.',
    dex: 9, spd: 5, str: 4, int: 7, cha: 2,
    abilities: ['knife_skills', 'pizza_master'],
    visual: { skinColor: 0xe8a777, hairColor: 0x3a2a1a, hasHair: true,  hat: 0 } },
  { name: 'Sunny Oduya',
    bio:  'brightest personality in the building. burns the soup sometimes, but nobody minds because they are tipping double by the time they leave.',
    dex: 4, spd: 7, str: 6, int: 3, cha: 10,
    abilities: ['showstopper'],
    visual: { skinColor: 0x8b5a3a, hairColor: 0x1a1a1a, hasHair: false, hat: 3 } },
  { name: 'Nana Beatrice',
    bio:  'retired. unretired. cooks like she raised you. her soups arrive faster than you can say grace, and every table feels the warmth.',
    dex: 6, spd: 2, str: 8, int: 9, cha: 8,
    abilities: ['soup_savant', 'mentor'],
    visual: { skinColor: 0xfde5c8, hairColor: 0xe0d0b0, hasHair: true,  hat: 0 } },
  { name: 'Yuki Tanaka',
    bio:  'silent, surgical. the plates come out clean and the cuts come out perfect. a quiet perfectionist who will not serve second best.',
    dex: 10, spd: 6, str: 3, int: 8, cha: 3,
    abilities: ['perfectionist'],
    visual: { skinColor: 0xfec9a7, hairColor: 0x1a1a1a, hasHair: true,  hat: 1 } },
  { name: 'Big Tommy',
    bio:  'can flip burgers with one hand. will. the patty is in the air before you finish ordering, and the tip always reflects it.',
    dex: 4, spd: 3, str: 10, int: 4, cha: 6,
    abilities: ['burger_boss'],
    visual: { skinColor: 0xc68a5a, hairColor: 0x8a6a3a, hasHair: true,  hat: 3 } },
  { name: 'Priya Raval',
    bio:  'trained in three Michelin kitchens. networks constantly. every plate is a performance, and diners lean in their chairs as she passes.',
    dex: 7, spd: 6, str: 5, int: 8, cha: 9,
    abilities: ['showstopper', 'green_thumb'],
    visual: { skinColor: 0xc68a5a, hairColor: 0x1a1a1a, hasHair: true,  hat: 0 } },
  { name: 'Colt "Speed" Jensen',
    bio:  'used to race. cooks like it too. every ticket is a lap and every stove is a pit. if you want it fast, he is your man.',
    dex: 5, spd: 10, str: 4, int: 3, cha: 7,
    abilities: ['road_runner', 'fast_hands'],
    visual: { skinColor: 0xfec9a7, hairColor: 0xbd9a5a, hasHair: true,  hat: 4 } },
  { name: 'Wanda Kowalski',
    bio:  'balanced. reliable. brought her own knives. never spectacular but never a weak shift either. the kitchen runs smoother when she is in it.',
    dex: 6, spd: 6, str: 6, int: 6, cha: 6,
    abilities: ['fast_hands'],
    visual: { skinColor: 0xe8a777, hairColor: 0xc94a2a, hasHair: true,  hat: 0 } },
  { name: 'Gus the Intern',
    bio:  'he is trying his best. please be kind. sometimes he cooks a dish in half the time; sometimes he burns it outright. unpredictable but cheap.',
    dex: 3, spd: 4, str: 3, int: 3, cha: 8,
    abilities: ['eager_intern'],
    visual: { skinColor: 0xfde5c8, hairColor: 0x3a2a1a, hasHair: true,  hat: 0 } },
  { name: 'Chef Blaise',
    bio:  'the old master. slow moving, genius on the stove. every dish is a small study, and the tips reflect the depth of his craft.',
    dex: 8, spd: 2, str: 6, int: 10, cha: 7,
    abilities: ['perfectionist', 'mentor'],
    visual: { skinColor: 0xe8a777, hairColor: 0xe0d0b0, hasHair: true,  hat: 2 } },
];
// Derive each chef's cost from total stats: baseline 5×5 = 25 → $150,
// maxed 10×5 = 50 → $500. Mutate here so designers only tune stats.
for (const c of CHEF_ROSTER) {
  const total = c.dex + c.spd + c.str + c.int + c.cha;
  c.cost = Math.round(80 + (total - 20) * 14);
}


/* ---- Grid + pathfinding ---------------------------------------------------- */
class Grid {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows; this.tiles = [];
    for (let y = 0; y < rows; y++) {
      const row = [];
      for (let x = 0; x < cols; x++) row.push({ x, y, type: 'floor', building: null });
      this.tiles.push(row);
    }
  }
  inBounds(x, y) { return x >= 0 && x < this.cols && y >= 0 && y < this.rows; }
  getTile(x, y) { return this.inBounds(x, y) ? this.tiles[y][x] : null; }
  setType(x, y, type) { const t = this.getTile(x, y); if (t) t.type = type; }
  isWalkable(x, y) {
    const t = this.getTile(x, y);
    if (!t || t.type === 'wall') return false;
    if (t.building && !t.building.walkable) return false;
    return true;
  }
  placeBuilding(b, x, y) {
    const t = this.getTile(x, y);
    if (!t || t.building || t.type === 'wall') return false;
    t.building = b; b.tile = t; b.x = x; b.y = y;
    return true;
  }
  removeBuildingAt(x, y) {
    const t = this.getTile(x, y); if (!t || !t.building) return null;
    const b = t.building; t.building = null; b.tile = null; return b;
  }
  neighbors4(x, y) {
    const out = [];
    if (this.inBounds(x+1, y)) out.push({ x: x+1, y });
    if (this.inBounds(x-1, y)) out.push({ x: x-1, y });
    if (this.inBounds(x, y+1)) out.push({ x, y: y+1 });
    if (this.inBounds(x, y-1)) out.push({ x, y: y-1 });
    return out;
  }
}

class Pathfinder {
  constructor(grid) { this.grid = grid; }
  findPath(sx, sy, targetFn, walkableFn) {
    walkableFn = walkableFn || ((x, y) => this.grid.isWalkable(x, y));
    const key = (x, y) => y * 1024 + x;
    let approx = { x: sx, y: sy };
    outer: for (let y = 0; y < this.grid.rows; y++)
      for (let x = 0; x < this.grid.cols; x++)
        if (targetFn(x, y)) { approx = { x, y }; break outer; }
    const h = (x, y) => Math.abs(x - approx.x) + Math.abs(y - approx.y);
    const open = new Map(), closed = new Set();
    const start = { x: sx, y: sy, g: 0, f: h(sx, sy), parent: null };
    open.set(key(sx, sy), start);
    let iters = 0;
    while (open.size && iters++ < 4000) {
      let curK = null, cur = null;
      for (const [k, n] of open) if (!cur || n.f < cur.f) { cur = n; curK = k; }
      if (targetFn(cur.x, cur.y)) {
        const path = []; let n = cur;
        while (n) { path.unshift({ x: n.x, y: n.y }); n = n.parent; }
        return path;
      }
      open.delete(curK); closed.add(curK);
      for (const nb of this.grid.neighbors4(cur.x, cur.y)) {
        const k = key(nb.x, nb.y);
        if (closed.has(k)) continue;
        const isGoal = targetFn(nb.x, nb.y);
        if (!isGoal && !walkableFn(nb.x, nb.y)) continue;
        const g = cur.g + 1;
        const existing = open.get(k);
        if (existing && existing.g <= g) continue;
        open.set(k, { x: nb.x, y: nb.y, g, f: g + h(nb.x, nb.y), parent: cur });
      }
    }
    return null;
  }
}


/* ---- Buildings ------------------------------------------------------------- */
let _bid = 0;
class Building {
  constructor(type) {
    this.id = ++_bid; this.type = type;
    this.x = -1; this.y = -1; this.tile = null;
    this.walkable = false; this.placedAt = 0;
  }
  update() {} onPlaced(sim) { this.placedAt = sim.time; } onRemoved() {}
}

class Stove extends Building {
  constructor() { super('stove'); this.cooking = null; this.reservedFor = null; }
  isCooking()    { return this.cooking !== null; }
  isAvailable()  { return !this.cooking && !this.reservedFor; }
  startCooking(order, sim) {
    const food = FOODS[order.foodType];
    // Cook stats (via effStat so tiredness folds in automatically):
    //   DEX scales cookTime down, INT drives food quality at cook time.
    const cook = order.cookingEmployee;
    const dex  = cook ? cook.effStat('dex') : 5;
    const mult = clamp(1.3 - 0.06 * dex, 0.5, 1.3);
    const aMult = cook ? abilityMult(cook, 'cookTimeMult', order.foodType) : 1;
    const profMult = (sim && sim.todayProfile && sim.todayProfile.cookTimeMult) || 1;
    const cookTime = food.cookTime * mult * aMult * profMult;
    const quality  = cook ? computeQuality(cook.effStat('int')) : 1.0;
    this.cooking = { order, timeLeft: cookTime, total: cookTime, quality };
    this.reservedFor = null;
  }
  update(dt) {
    if (!this.cooking) return;
    this.cooking.timeLeft -= dt;
    if (this.cooking.timeLeft <= 0) {
      const o = this.cooking.order;
      o.status = 'ready';
      o.readyStove = this;
      o.quality = this.cooking.quality;   // carry quality forward to delivery
      this.cooking = null;
    }
  }
  onRemoved() {
    if (this.reservedFor) {
      this.reservedFor.assignedStove = null;
      this.reservedFor.cookingEmployee = null;
      this.reservedFor = null;
    }
    if (this.cooking) this.cooking.order.status = 'lost';
  }
}

class Table extends Building {
  constructor() {
    super('table');
    this.plate = null; this.occupyingCustomer = null; this.cleaningAssigned = false;
  }
  getAdjacentChairs(grid) {
    const out = [];
    for (const n of grid.neighbors4(this.x, this.y)) {
      const t = grid.getTile(n.x, n.y);
      if (t && t.building && t.building.type === 'chair') out.push(t.building);
    }
    return out;
  }
}

class Chair extends Building {
  constructor() { super('chair'); this.walkable = false; this.occupyingCustomer = null; }
  getAdjacentTable(grid) {
    for (const n of grid.neighbors4(this.x, this.y)) {
      const t = grid.getTile(n.x, n.y);
      if (t && t.building && t.building.type === 'table') return t.building;
    }
    return null;
  }
}

class Sink extends Building {
  constructor() { super('sink'); this.washing = null; this.reservedFor = null; }
  isAvailable() { return !this.washing && !this.reservedFor; }
  isWashing()   { return this.washing !== null; }
  startWashing() { this.washing = { timeLeft: 2.0, total: 2.0 }; this.reservedFor = null; }
  update(dt) {
    if (!this.washing) return;
    this.washing.timeLeft -= dt;
    if (this.washing.timeLeft <= 0) this.washing = null;
  }
  onRemoved() {
    if (this.reservedFor) { this.reservedFor.cleaningAssigned = false; this.reservedFor = null; }
    this.washing = null;
  }
}


/* ---- Orders ---------------------------------------------------------------- */
let _oid = 0;
class Order {
  constructor(customer, foodType) {
    this.id = ++_oid;
    this.customer = customer; this.foodType = foodType;
    this.status = 'pending';
    this.cookingEmployee = null; this.deliveryEmployee = null;
    this.assignedStove = null; this.readyStove = null;
  }
}


/* ---- Entities: Customer, Employee ------------------------------------------ */
let _eid = 0;
class Entity {
  constructor(x, y) {
    this.id = ++_eid;
    this.x = x; this.y = y;
    this.path = null; this.pathIdx = 0;
    this.speed = 2; this.alive = true;
    this.facing = { x: 1, y: 0 };
  }
  setPath(path) {
    if (!path || path.length === 0) { this.path = null; return; }
    this.path = path; this.pathIdx = 0;
  }
  hasPath() { return this.path && this.pathIdx < this.path.length; }
  tileX() { return Math.round(this.x); }
  tileY() { return Math.round(this.y); }
  stepMovement(dt) {
    if (!this.hasPath()) return false;
    const tgt = this.path[this.pathIdx];
    const dx = tgt.x - this.x, dy = tgt.y - this.y;
    const d = Math.hypot(dx, dy);
    const step = this.speed * dt;
    if (d > 0.001) this.facing = { x: dx / d, y: dy / d };
    if (d <= step) {
      this.x = tgt.x; this.y = tgt.y; this.pathIdx++;
      if (this.pathIdx >= this.path.length) { this.path = null; return true; }
    } else {
      this.x += (dx / d) * step;
      this.y += (dy / d) * step;
    }
    return false;
  }
}

const CS = {
  ENTERING: 'entering', SEEKING: 'seeking', WALKING: 'walking-to-seat',
  WAITING: 'waiting-food', EATING: 'eating', LEAVING: 'leaving',
};

class Customer extends Entity {
  constructor(x, y, spawnTime = 0) {
    super(x, y);
    this.spawnTime = spawnTime;
    this.queueSlot = null;
    this.speed = CONFIG.customerSpeed;
    this.state = CS.ENTERING;
    this.foodPref = FOOD_KEYS[(Math.random() * FOOD_KEYS.length) | 0];
    this.anger = 0;
    this.chair = null; this.table = null; this.order = null;
    this.eatTimer = 0; this.retrySeatTimer = 0;
    this.leftReason = null;

    // Tip bookkeeping: seatedAt set when entering WAITING, deliveredAt when
    // a plate lands, tipAwarded written at 'happy' leave so the floater sprite
    // can render it above the exiting customer.
    this.seatedAt    = null;
    this.deliveredAt = null;
    this.deliveredBy = null;
    this.tipAwarded  = 0;

    // Ability system. Filled in by sim.spawnCustomer right after construction
    // so the constructor stays side-effect free; defaults cover anything that
    // bypasses spawnCustomer.
    this.abilities       = [];
    this.ordersRemaining = 1;
    this.abilityAnnounced = false;

    // Visual randomization — palettes live in sprites.js. Read by SPRITES,
    // never mutated during play.
    const pick = (a) => a[(Math.random() * a.length) | 0];
    this.bodyColor  = pick(CUSTOMER_BODY_COLORS);
    this.skinColor  = pick(SKIN_TONES);
    this.pantsColor = pick(PANTS_COLORS);
    this.hat        = (Math.random() * 5) | 0;
    this.hatColor   = pick(CUSTOMER_BODY_COLORS);
    this.hairColor  = pick(HAIR_COLORS);
    this.hasHair    = Math.random() < 0.7;
  }

  update(dt, sim) {
    const arrived = this.stepMovement(dt);

    // Anger ticks by state.
    let rate = 0; let stateKey = null;
    if (this.state === CS.ENTERING || this.state === CS.SEEKING) { rate = CONFIG.angerRates.seekingSeat; stateKey = 'seekingSeat'; }
    else if (this.state === CS.WALKING) { rate = CONFIG.angerRates.walkingToSeat; stateKey = 'walkingToSeat'; }
    else if (this.state === CS.WAITING) { rate = CONFIG.angerRates.waitingFood;   stateKey = 'waitingFood'; }
    else if (this.state === CS.EATING)  { rate = CONFIG.angerRates.eating;        stateKey = 'eating'; }
    rate *= abilityMult(this, 'angerMult', stateKey);
    this.anger = Math.min(CONFIG.angerMax, this.anger + rate * dt);
    if (this.anger >= CONFIG.angerMax && this.state !== CS.LEAVING) { this.leave(sim, 'angry'); return; }

    switch (this.state) {
      case CS.ENTERING:
        this.state = CS.SEEKING;
        break;
      case CS.SEEKING: {
        // Compute my place in the arrival-ordered queue.
        const seekers = sim.getSeekingCustomers();
        const myIdx = seekers.indexOf(this);
        const slot = sim.getQueueSlot(myIdx);

        // Re-target whenever my slot shifts (someone ahead got seated).
        const slotChanged = !this.queueSlot ||
          this.queueSlot.x !== slot.x || this.queueSlot.y !== slot.y;
        if (slotChanged) {
          this.queueSlot = slot;
          const dist = Math.hypot(slot.x - this.x, slot.y - this.y);
          if (dist > 0.05) this.setPath([{ x: slot.x, y: slot.y }]);
          else             this.path = null;
        }

        // Only the front-of-queue customer actually tries seats.
        if (!this.hasPath() && myIdx === 0) {
          this.retrySeatTimer -= dt;
          if (this.retrySeatTimer <= 0) {
            this.retrySeatTimer = 0.6;
            this.trySeat(sim);
          }
        }
        break;
      }
      case CS.WALKING:
        if (arrived) {
          this.state = CS.WAITING;
          this.seatedAt = sim.time;
          this.order = new Order(this, this.foodPref);
          sim.submitOrder(this.order);
          // Announce ability once the customer is visibly seated, not the
          // moment they spawn off-screen.
          if (!this.abilityAnnounced) {
            fireAbilityHook(this, 'onEnter', { sim });
            this.abilityAnnounced = true;
          }
        }
        break;
      case CS.WAITING:
        if (this.table && this.table.plate && !this.table.plate.dirty &&
            this.table.plate.foodType === this.foodPref) {
          this.state = CS.EATING;
          this.eatTimer = CONFIG.eatDuration * abilityMult(this, 'eatTimeMult', this.foodPref);
          fireAbilityHook(this, 'onEat', { sim, foodKey: this.foodPref });
        }
        break;
      case CS.EATING:
        this.eatTimer -= dt;
        if (this.eatTimer <= 0) {
          if (this.table && this.table.plate) this.table.plate.dirty = true;
          this._consumePlate(sim);
        }
        break;
      case CS.LEAVING:
        if (arrived || !this.hasPath()) this.alive = false;
        break;
    }
  }

  // Called when one course finishes. Credits price + tip now rather than at
  // leave, so a multi-order customer earns per-course instead of lump-sum. If
  // more orders remain, rolls a fresh foodPref and re-enters WAITING with a
  // new Order; the dirty plate is cleared by the standard wash flow (or
  // overwritten by the next delivery).
  _consumePlate(sim) {
    const price = FOODS[this.foodPref].price;
    let tip     = computeTip(this);
    // Today's forecast-driven tip multiplier (e.g. "generous tippers").
    if (sim.todayProfile && sim.todayProfile.tipMult) {
      tip = Math.round(tip * sim.todayProfile.tipMult);
    }
    this.tipAwarded += tip;
    sim.money       += price + tip;
    sim.stats.tipsTotal += tip;
    sim.stats.served++;
    // Credit the delivering chef's end-of-day report (career + today).
    const cook = this.deliveredBy;
    if (cook) {
      cook.dayStats.dishes++;     cook.career.dishes++;
      cook.dayStats.tipsEarned += tip;
      cook.career.tipsEarned   += tip;
    }
    sim.emitPopup(this, '💰', `+$${price + tip}`);

    this.ordersRemaining--;
    if (this.ordersRemaining > 0) {
      // Re-enter WAITING with a fresh order. Randomize foodPref so the second
      // course isn't a guaranteed duplicate.
      this.state = CS.WAITING;
      this.foodPref = FOOD_KEYS[(Math.random() * FOOD_KEYS.length) | 0];
      this.order = new Order(this, this.foodPref);
      this.seatedAt    = sim.time;
      this.deliveredAt = null;
      this.deliveredBy = null;
      sim.submitOrder(this.order);
      sim.emitPopup(this, '🍴', 'Another, please');
    } else {
      this.leave(sim, 'happy');
    }
  }

  trySeat(sim) {
    const chair = sim.findAvailableChair();
    if (!chair) return;
    const startX = Math.round(this.x), startY = Math.round(this.y);
    if (!sim.grid.inBounds(startX, startY)) return;
    const path = sim.pathfinder.findPath(
      startX, startY,
      (x, y) => x === chair.x && y === chair.y,
      (x, y) => sim.grid.isWalkable(x, y));
    if (!path) return;
    // Snap to tile so stepMovement starts cleanly.
    this.x = startX; this.y = startY;
    const table = chair.getAdjacentTable(sim.grid);
    chair.occupyingCustomer = this; table.occupyingCustomer = this;
    this.chair = chair; this.table = table;
    this.setPath(path); this.state = CS.WALKING;
    this.queueSlot = null;
  }

  leave(sim, reason) {
    this.leftReason = reason;
    if (this.chair) this.chair.occupyingCustomer = null;
    if (this.table) this.table.occupyingCustomer = null;
    this.state = CS.LEAVING;
    this.queueSlot = null;

    // Abandon any in-flight order so cooks don't deliver to an empty seat.
    if (this.order) {
      const o = this.order;
      if (o.status !== 'delivered') o.status = 'abandoned';
      if (o.assignedStove) {
        if (o.assignedStove.reservedFor === o) o.assignedStove.reservedFor = null;
        if (o.assignedStove.cooking && o.assignedStove.cooking.order === o) {
          o.assignedStove.cooking = null;
        }
      }
      if (o.readyStove) o.readyStove = null;
    }

    if (reason !== 'happy') sim.stats.angry++;
    // Happy-path earnings are credited per course in _consumePlate; nothing
    // else to do here beyond the state transition and exit path.

    // Queue-giver-upper: off-grid, just storm west.
    if (this.x < 0) { this.setPath([{ x: -5, y: this.y }]); return; }

    const exit = sim.exitTile;
    const path = sim.pathfinder.findPath(
      this.tileX(), this.tileY(),
      (x, y) => x === exit.x && y === exit.y,
      (x, y) => sim.grid.isWalkable(x, y));
    if (path) this.setPath(path); else this.alive = false;
  }
}

const ES = {
  IDLE: 'idle',
  TO_STOVE_COOK: 'to-stove-cook',
  TO_STOVE_PICKUP: 'to-stove-pickup',
  TO_TABLE_DELIVER: 'to-table-deliver',
  TO_TABLE_PICKUP_DIRTY: 'to-table-pickup-dirty',
  TO_SINK_DROP: 'to-sink-drop',
};

class Employee extends Entity {
  constructor(x, y, preset = STARTER_CHEF) {
    super(x, y);
    this.state = ES.IDLE;
    this.task = null;
    this.carrying = null;
    this.carryingDirty = false;

    // Identity + stats from the roster preset (pure data, no Phaser).
    this.name = preset.name;
    this.bio  = preset.bio;
    this.dex  = preset.dex;
    this.spd  = preset.spd;
    this.str  = preset.str;
    this.int  = preset.int;
    this.cha  = preset.cha;
    this.abilities = (preset.abilities || []).slice();

    // Visuals: prefer preset values; fall back to random SKIN_TONES pick so
    // two starter chefs don't look identical.
    const v = preset.visual || {};
    this.visual = {
      skinColor: v.skinColor != null ? v.skinColor
                 : SKIN_TONES[(Math.random() * SKIN_TONES.length) | 0],
      hairColor: v.hairColor != null ? v.hairColor : 0x3a2a1a,
      hasHair:   v.hasHair === true,
      hat:       v.hat != null ? v.hat : 0,
    };
    // Legacy alias used by parts of Sprites.employee that read e.skinColor.
    this.skinColor = this.visual.skinColor;

    // Stamina / tired: STR drives tank size. Starts full; ticks down while
    // working, regenerates while IDLE. Tired is a flag (hysteresis set in
    // update), not a state — the chef keeps working at 75%.
    this.staminaMax = 30 + 6 * this.str;
    this.stamina    = this.staminaMax;
    this.tired      = false;

    // Speed is recomputed per-frame in update() so tiredness is responsive.
    this.speed = CONFIG.employeeSpeed * (0.7 + 0.06 * this.spd);

    // End-of-day report tracking. dayStats resets at day boundary; career
    // accumulates for the run. Status is an event-driven effect on next
    // day's availability / behavior (e.g. {kind:'busy', daysLeft:1}).
    this.isStarter = !!preset.isStarter;
    this.dayStats  = { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0 };
    this.career    = { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0, daysWorked: 0 };
    this.status    = null;
  }

  // A chef is unavailable for the day when recovering from an event. Starter
  // chefs never pick up this flag (see sim.resolveEvent).
  isAvailable() { return !this.status || this.status.kind !== 'busy'; }

  // Returns the stat scaled by the tired multiplier. STR is the one stat that
  // doesn't degrade when tired — it's the meta-stat that defines the tank.
  effStat(name) {
    let nominal = this[name];
    if (this.status && this.status.kind === 'stressed' && name === 'int') nominal = Math.max(1, nominal - 2);
    if (name === 'str' || !this.tired) return nominal;
    return nominal * CONFIG.tiredMult;
  }

  pathToAdjacent(sim, tx, ty) {
    return sim.pathfinder.findPath(
      this.tileX(), this.tileY(),
      (x, y) => sim.grid.isWalkable(x, y) && sim.grid.neighbors4(x, y).some(n => n.x === tx && n.y === ty),
      (x, y) => sim.grid.isWalkable(x, y));
  }

  update(dt, sim) {
    // Per-frame speed recompute so tiredness kicks in immediately.
    this.speed = CONFIG.employeeSpeed * (0.7 + 0.06 * this.effStat('spd'));

    // Stamina: decay while working, regenerate while idle. Tired flips with
    // hysteresis so the chef doesn't flicker on/off at the threshold.
    if (this.state !== ES.IDLE) {
      this.stamina -= dt;
    } else {
      this.stamina = Math.min(this.staminaMax, this.stamina + dt);
    }
    if (!this.tired && this.stamina <= 0) {
      this.tired = true;
      this.dayStats.timesTired++; this.career.timesTired++;
    } else if (this.tired && this.stamina >= this.staminaMax * 0.25) {
      this.tired = false;
    }

    const arrived = this.stepMovement(dt);
    if (this.state === ES.IDLE) { this.findTask(sim); return; }
    // customer.alive stays true through LEAVING, so check state explicitly
    // or we'll deliver a plate to a walking-out customer.
    if (this.task && this.task.order) {
      const c = this.task.order.customer;
      if (!c.alive || c.state !== CS.WAITING) { this.abortTask(); return; }
    }
    if (arrived) this.onArrival(sim);
  }

  findTask(sim) {
    // An event-recovering chef drops every task (regen stamina only).
    if (!this.isAvailable()) return;
    // Priority 1: pick up ready food.
    for (const o of sim.orders) {
      if (o.status !== 'ready' || o.deliveryEmployee) continue;
      if (!o.customer.alive || !o.customer.table) { o.status = 'abandoned'; continue; }
      const stove = o.readyStove; if (!stove) continue;
      const path = this.pathToAdjacent(sim, stove.x, stove.y); if (!path) continue;
      o.deliveryEmployee = this;
      this.task = { order: o, stove };
      this.setPath(path); this.state = ES.TO_STOVE_PICKUP; return;
    }
    // Priority 2: start cooking a pending order.
    for (const o of sim.orders) {
      if (o.status !== 'pending' || o.cookingEmployee) continue;
      for (const stove of sim.buildings) {
        if (stove.type !== 'stove' || !stove.isAvailable()) continue;
        const path = this.pathToAdjacent(sim, stove.x, stove.y);
        if (!path) continue;
        o.cookingEmployee = this; o.assignedStove = stove;
        stove.reservedFor = o;
        this.task = { order: o, stove };
        this.setPath(path); this.state = ES.TO_STOVE_COOK; return;
      }
    }
    // Priority 3: clear a dirty plate.
    for (const b of sim.buildings) {
      if (b.type !== 'table' || !b.plate || !b.plate.dirty || b.cleaningAssigned) continue;
      if (b.occupyingCustomer) continue;
      let chosenSink = null;
      for (const s of sim.buildings) {
        if (s.type !== 'sink' || !s.isAvailable()) continue;
        chosenSink = s; break;
      }
      if (!chosenSink) continue;
      const path = this.pathToAdjacent(sim, b.x, b.y); if (!path) continue;
      b.cleaningAssigned = true;
      chosenSink.reservedFor = b;
      this.task = { table: b, sink: chosenSink };
      this.setPath(path); this.state = ES.TO_TABLE_PICKUP_DIRTY; return;
    }
  }

  onArrival(sim) {
    const t = this.task;
    if (!t) { this.state = ES.IDLE; return; }
    switch (this.state) {
      case ES.TO_STOVE_COOK: {
        if (t.stove && t.stove.reservedFor === t.order && !t.stove.isCooking()) {
          t.stove.startCooking(t.order, sim); t.order.status = 'cooking';
          fireAbilityHook(this, 'onCookStart', { sim, foodKey: t.order.foodType });
        } else {
          t.order.status = 'pending'; t.order.assignedStove = null;
          if (t.stove) t.stove.reservedFor = null;
        }
        t.order.cookingEmployee = null;
        this.task = null; this.state = ES.IDLE; break;
      }
      case ES.TO_STOVE_PICKUP: {
        this.carrying = t.order;
        const table = t.order.customer.table;
        if (!table) { this.abortTask(); break; }
        const path = this.pathToAdjacent(sim, table.x, table.y);
        if (!path) { this.abortTask(); break; }
        this.setPath(path); this.state = ES.TO_TABLE_DELIVER; break;
      }
      case ES.TO_TABLE_DELIVER: {
        const c = t.order.customer;
        const table = c.table;
        if (table && c.alive && c.state === CS.WAITING) {
          table.plate = {
            foodType: t.order.foodType,
            dirty: false,
            quality: t.order.quality != null ? t.order.quality : 1.0,
          };
          c.deliveredAt = sim.time;
          c.deliveredBy = this;          // stash before order clears the ref
          t.order.status = 'delivered';
        } else {
          t.order.status = 'abandoned';
        }
        this.carrying = null; t.order.deliveryEmployee = null;
        this.task = null; this.state = ES.IDLE; break;
      }
      case ES.TO_TABLE_PICKUP_DIRTY: {
        if (t.table && t.table.plate && t.table.plate.dirty) {
          this.carryingDirty = true;
          t.table.plate = null;
          t.table.cleaningAssigned = false;
          if (!t.sink || !t.sink.tile) { this.abortTask(); break; }
          const path = this.pathToAdjacent(sim, t.sink.x, t.sink.y);
          if (!path) { this.abortTask(); break; }
          this.setPath(path); this.state = ES.TO_SINK_DROP;
        } else {
          if (t.table) t.table.cleaningAssigned = false;
          if (t.sink)  t.sink.reservedFor = null;
          this.task = null; this.state = ES.IDLE;
        }
        break;
      }
      case ES.TO_SINK_DROP: {
        if (t.sink && t.sink.tile && !t.sink.isWashing()) {
          t.sink.startWashing(); sim.stats.plates++;
        } else if (t.sink) { t.sink.reservedFor = null; }
        this.carryingDirty = false;
        this.task = null; this.state = ES.IDLE; break;
      }
    }
  }

  abortTask() {
    const t = this.task;
    if (t) {
      if (t.order) {
        const o = t.order;
        // Note whether this was a live cook BEFORE we clear refs. A chef
        // aborting mid-cook should re-pend the order so another cook can
        // pick it up — but only if the customer hasn't already walked
        // (Customer.leave stamps status 'abandoned' first; respect that).
        const wasCooking = t.stove && t.stove.cooking && t.stove.cooking.order === o;
        o.cookingEmployee = null; o.deliveryEmployee = null;
        if (t.stove && t.stove.reservedFor === o) t.stove.reservedFor = null;
        if (wasCooking) t.stove.cooking = null;
        if (o.status !== 'delivered' && o.status !== 'abandoned') {
          if (wasCooking) {
            o.status = 'pending';
            o.assignedStove = null;
            o.readyStove = null;
          } else {
            o.status = 'abandoned';
          }
        }
      }
      if (t.table) t.table.cleaningAssigned = false;
      if (t.sink)  t.sink.reservedFor = null;
    }
    this.carrying = null; this.carryingDirty = false;
    this.task = null; this.state = ES.IDLE;
  }
}


/* ---- Simulation root ------------------------------------------------------- */
class Simulation {
  constructor() {
    this.grid = new Grid(COLS, ROWS);
    this.pathfinder = new Pathfinder(this.grid);
    this.buildings = []; this.customers = []; this.employees = []; this.orders = [];
    this.time = 0; this.spawnTimer = 1; this.spawnEnabled = true;
    this.trafficMultiplier = 1;
    this.money = CONFIG.startingMoney;
    this.stats = { served: 0, angry: 0, plates: 0, tipsTotal: 0 };
    this.day           = 1;
    this.daySpawned    = 0;
    this.dayStartMoney = CONFIG.startingMoney;
    this.todayProfile  = {};            // applied on day start: foodBias, quotaMult, tipMult, cookTimeMult
    this.dayQuota      = this._computeDayQuota(1);
    this.dayState      = 'spawning';    // 'spawning' | 'draining' | 'dayEnd'

    // Between-day pause state. currentEvent and nextForecast are rolled on
    // entry to 'dayEnd'; eventOutcome is filled when the player assigns a
    // chef. startNextDay() consumes them to shape the following day.
    this.currentEvent     = null;
    this.eventAssignedChef = null;
    this.eventOutcome     = null;        // {passed, roll, chef, result}
    this.nextForecast     = null;        // {label, profile}

    // Popup queue for real-time ability floaters. Each entry is aged in
    // update() and rendered by Sprites.popups. Unique ids prevent text-pool
    // key collisions when the same entity fires multiple popups.
    this.popups     = [];
    this._popupSeq  = 0;

    this.spawnTile = { x: 0, y: 4 };
    this.exitTile  = { x: 0, y: 4 };
    this.grid.setType(this.spawnTile.x, this.spawnTile.y, 'spawn');

    // Live recruit pool. Each entry carries an `id` (stable across the run)
    // used by the UI to identify the chef clicked. Shuffle so the player sees
    // a different order every session; removed on hire so every chef is unique.
    this.recruitPool = CHEF_ROSTER
      .map((e, i) => ({ ...e, id: i }))
      .sort(() => Math.random() - 0.5);
  }

  seedDemo() {
    // Kitchen column: 3 stoves on top, 2 sinks on bottom.
    this.placeBuilding('stove', 10, 1, true);
    this.placeBuilding('stove', 10, 2, true);
    this.placeBuilding('stove', 10, 3, true);
    this.placeBuilding('sink',  10, 6, true);
    this.placeBuilding('sink',  10, 7, true);

    // Four 1-chair dining units. (A table only serves one customer at a time;
    // sharing one between two chairs leaves the second chair permanently
    // unusable — so we pair 1-to-1.)
    // Top row: chair NORTH of table.
    this.placeBuilding('chair',  3, 2, true);  this.placeBuilding('table',  3, 3, true);
    this.placeBuilding('chair',  6, 2, true);  this.placeBuilding('table',  6, 3, true);
    // Bottom row: chair SOUTH of table.
    this.placeBuilding('table',  3, 5, true);  this.placeBuilding('chair',  3, 6, true);
    this.placeBuilding('table',  6, 5, true);  this.placeBuilding('chair',  6, 6, true);

    this.hireEmployee(true);
  }

  placeBuilding(type, x, y, free = false) {
    if (!this.grid.inBounds(x, y)) return { ok: false, reason: 'out-of-bounds' };
    if (this.grid.getTile(x, y).building) return { ok: false, reason: 'occupied' };
    if (this.grid.getTile(x, y).type === 'spawn') return { ok: false, reason: 'blocks-door' };
    const cost = CONFIG.costs[type];
    if (!free && this.money < cost) return { ok: false, reason: 'no-money' };
    let b;
    if      (type === 'stove') b = new Stove();
    else if (type === 'table') b = new Table();
    else if (type === 'chair') b = new Chair();
    else if (type === 'sink')  b = new Sink();
    else return { ok: false, reason: 'bad-type' };
    if (!this.grid.placeBuilding(b, x, y)) return { ok: false, reason: 'grid-reject' };
    this.buildings.push(b); b.onPlaced(this);
    if (!free) this.money -= cost;
    return { ok: true };
  }

  removeBuildingAt(x, y) {
    const b = this.grid.removeBuildingAt(x, y); if (!b) return false;
    b.onRemoved(this);
    const i = this.buildings.indexOf(b); if (i >= 0) this.buildings.splice(i, 1);
    if (b.type === 'chair' && b.occupyingCustomer) b.occupyingCustomer.leave(this, 'angry');
    if (b.type === 'table' && b.occupyingCustomer) b.occupyingCustomer.leave(this, 'angry');
    this.money += Math.floor((CONFIG.costs[b.type] || 0) * CONFIG.refundRatio);
    return true;
  }

  // Seeds the demo with two starter chefs. The roster-based path is
  // hireFromRoster — this legacy method is only used by seedDemo.
  hireEmployee(free = false) {
    if (!free && this.money < CONFIG.costs.employee) return false;
    if (!free) this.money -= CONFIG.costs.employee;
    this.employees.push(new Employee(this.spawnTile.x, this.spawnTile.y, STARTER_CHEF));
    return true;
  }

  // Recruit from the modal. entryId matches the `id` field on a recruitPool
  // entry; we look it up instead of indexing so clicks remain valid if other
  // hires mutated the array underfoot. Returns {ok, reason} for the UI.
  hireFromRoster(entryId) {
    const idx = this.recruitPool.findIndex(e => e.id === entryId);
    if (idx < 0) return { ok: false, reason: 'gone' };
    const entry = this.recruitPool[idx];
    if (this.money < entry.cost) return { ok: false, reason: 'no-money' };
    this.money -= entry.cost;
    this.recruitPool.splice(idx, 1);
    this.employees.push(new Employee(this.spawnTile.x, this.spawnTile.y, entry));
    return { ok: true };
  }

  _computeDayQuota(day) {
    const base = CONFIG.dayBaseQuota * Math.pow(CONFIG.dayGrowthFactor, day - 1);
    const mult = (this.todayProfile && this.todayProfile.quotaMult) || 1;
    return Math.max(1, Math.ceil(base * mult));
  }

  // List of chefs the player can assign to today's event. Starter chefs are
  // always shown; others must be currently available (not recovering).
  eligibleChefsForEvent() {
    return this.employees.filter(e => e.isStarter || e.isAvailable());
  }

  // Roll the event for an assigned chef and apply its immediate effects
  // (money delta, status). Forecast profile is stashed and applied at
  // startNextDay(). Safe to call only while in 'dayEnd'. Returns outcome
  // summary for the UI.
  resolveEvent(chefId) {
    if (this.dayState !== 'dayEnd' || !this.currentEvent || this.eventOutcome) return null;
    const chef = this.employees.find(e => e.id === chefId);
    if (!chef) return null;
    const ev    = this.currentEvent;
    const dc    = typeof ev.dc === 'function' ? ev.dc(this.day) : (ev.dc || 10);
    const roll  = Math.floor(Math.random() * 10) + 1;     // 1..10
    const total = roll + chef.effStat(ev.stat);
    const passed = total >= dc;
    const result = passed ? ev.onPass(this, chef) : ev.onFail(this, chef);

    // Default chef status: busy for 1 day (skip tomorrow). Events can override
    // via statusOverride (e.g. 'starstruck'). Starter chefs shrug off any
    // disabling status but still accept positive ones.
    let nextStatus = result.statusOverride || { kind: 'busy', daysLeft: 1 };
    if (chef.isStarter && nextStatus.kind !== 'starstruck') nextStatus = null;
    chef.status = nextStatus;

    this.eventAssignedChef = chef;
    this.eventOutcome = {
      passed, roll, total, dc,
      chef, result,
      msg: result.msg || (passed ? 'Success.' : 'Failed.'),
    };
    return this.eventOutcome;
  }

  // Player clicks "Start Day" in the modal. Advances day counter, resets
  // per-day stats, ticks chef statuses, and merges the rolled forecast +
  // event profile into todayProfile.
  startNextDay() {
    if (this.dayState !== 'dayEnd') return;
    if (!this.eventOutcome) return;      // must resolve event first

    // Assemble next day's profile: base forecast + any event profile.
    const profile = { ...(this.nextForecast && this.nextForecast.profile || {}) };
    const evProf = this.eventOutcome.result && this.eventOutcome.result.profile;
    if (evProf) {
      for (const k of Object.keys(evProf)) {
        if (k === 'label') continue;
        if (k === 'tipMult' || k === 'quotaMult' || k === 'cookTimeMult') {
          profile[k] = (profile[k] || 1) * evProf[k];
        } else {
          profile[k] = evProf[k];
        }
      }
    }
    this.todayProfile = profile;

    this.day++;
    this.dayQuota      = this._computeDayQuota(this.day);
    this.daySpawned    = 0;
    this.spawnTimer    = 0.5;
    this.dayState      = 'spawning';
    this.dayStartMoney = this.money;
    this.stats         = { served: 0, angry: 0, plates: 0, tipsTotal: 0 };

    for (const e of this.employees) {
      e.dayStats = { dishes: 0, tipsEarned: 0, timesTired: 0, procs: 0 };
      e.career.daysWorked++;
    }

    this.currentEvent      = null;
    this.eventAssignedChef = null;
    this.eventOutcome      = null;
    this.nextForecast      = null;
  }

  // Floater above `entity`. Rendered by Sprites.popups via the pooled text
  // system; lifetimes tick in update() and expired entries are dropped.
  emitPopup(entity, icon, label, duration = 1.6) {
    if (!entity) return;
    if (entity instanceof Employee) {
      entity.dayStats.procs++;
      entity.career.procs++;
    }
    this.popups.push({
      id: ++this._popupSeq,
      entity, icon: icon || '', label: label || '',
      age: 0, duration,
    });
  }

  spawnCustomer() {
    if (this.customers.filter(c => c.alive).length >= CONFIG.customerMaxConcurrent) return false;
    const c = new Customer(this.spawnTile.x, this.spawnTile.y, this.time);
    // Food bias from today's forecast: 70% of customers chase the hot menu.
    const bias = this.todayProfile && this.todayProfile.foodBias;
    if (bias && FOODS[bias] && Math.random() < 0.7) c.foodPref = bias;
    c.abilities = rollCustomerAbilities();
    c.ordersRemaining = 1 + abilitySum(c, 'extraOrders');
    this.customers.push(c);
    return true;
  }

  submitOrder(o) { this.orders.push(o); }

  getSeekingCustomers() {
    return this.customers
      .filter(c => c.alive && (c.state === CS.SEEKING || c.state === CS.ENTERING))
      .sort((a, b) => a.spawnTime - b.spawnTime);
  }

  // Slot 0 is the door; later slots extend WEST off the grid so the queue
  // forms visibly outside the restaurant.
  getQueueSlot(index) {
    const maxVisible = 4;
    const effIdx = Math.min(index, maxVisible);
    return { x: this.spawnTile.x - effIdx * 0.9, y: this.spawnTile.y };
  }

  findAvailableChair() {
    for (const b of this.buildings) {
      if (b.type !== 'chair' || b.occupyingCustomer) continue;
      const table = b.getAdjacentTable(this.grid);
      if (!table || table.occupyingCustomer || table.plate) continue;
      return b;
    }
    return null;
  }

  update(dt) {
    this.time += dt;
    if (this.spawnEnabled) {
      if (this.dayState === 'spawning') {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
          this.spawnTimer = CONFIG.customerSpawnInterval / this.trafficMultiplier;
          if (this.daySpawned < this.dayQuota && this.spawnCustomer()) {
            this.daySpawned++;
            if (this.daySpawned >= this.dayQuota) this.dayState = 'draining';
          }
        }
      } else if (this.dayState === 'draining') {
        if (!this.customers.some(c => c.alive)) {
          // Status is tick-decremented at end of day so "daysLeft:1" applied
          // during yesterday's dayEnd naturally clears after one full day.
          for (const e of this.employees) {
            if (e.status) {
              e.status.daysLeft--;
              if (e.status.daysLeft <= 0) e.status = null;
            }
          }
          this.dayState = 'dayEnd';
          // Roll today's event + tomorrow's baseline forecast. The modal
          // reads these; resolveEvent + startNextDay consume them.
          this.currentEvent  = rollDailyEvent(this.day);
          this.nextForecast  = rollBaseForecast();
          this.eventAssignedChef = null;
          this.eventOutcome  = null;
        }
      }
      // 'dayEnd' is a pure pause — the sim keeps ticking (chefs regen
      // stamina, popups fade), but day progression waits on the player's
      // Start Day click, which calls startNextDay().
    }
    for (const b of this.buildings) b.update(dt, this);
    for (const e of this.employees) e.update(dt, this);
    for (const c of this.customers) if (c.alive) c.update(dt, this);
    this.customers = this.customers.filter(c => c.alive);
    this.orders = this.orders.filter(o =>
      o.status !== 'delivered' && o.status !== 'abandoned' && o.status !== 'lost' && o.customer.alive);

    // Age popup floaters; drop expired entries.
    if (this.popups.length) {
      for (const p of this.popups) p.age += dt;
      this.popups = this.popups.filter(p => p.age < p.duration && p.entity && p.entity.alive !== false);
    }
  }

  orderCountsByStatus() {
    const c = { pending: 0, cooking: 0, ready: 0 };
    for (const o of this.orders) if (c[o.status] !== undefined) c[o.status]++;
    return c;
  }
}
