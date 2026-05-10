/* ============================================================================
 * data/events_forecasts.js — between-day events, daily forecasts, customer ability roller
 * ============================================================================ */

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
