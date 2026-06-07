/* ============================================================================
 * data/constants.js — grid dimensions, food menu, gameplay tuning, pure helpers
 * ============================================================================ */

/* ---- Grid dimensions ------------------------------------------------------- */
const COLS = 12;
const ROWS = 12;

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
  // Each day past day 1, the effective spawn interval shrinks by this many
  // seconds. Floor at customerSpawnIntervalMin so the rate stays solveable.
  customerSpawnIntervalPerDay: 0.2,
  customerSpawnIntervalMin:    0.1,
  customerSpeed:               3.2,
  eatDuration:           6,
  angerMax:              100,
  angerRates: { seekingSeat: 2.5, walkingToSeat: 1.0, waitingFood: 3.5, eating: 0 },
  employeeSpeed: 4.5,
  startingMoney: 200,
  costs: {
    stove: 150, catapult_stove: 300, table: 50, chair: 20, sink: 120, employee: 200,
    chef_spawn: 100,           // walkable chef start-of-shift station
    floor: 150,                // fill a default-layout gap with solid floor
    player_wall: 0,            // free, lightweight partition
    move_furniture: 80,        // anything except table, chair, player_wall
  },
  refundRatio: 0.5,
  reputationMax: 100,
  reputationStart: 100,
  reputationAngryHit: 15,
  reputationDailyBonus: 1,
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
