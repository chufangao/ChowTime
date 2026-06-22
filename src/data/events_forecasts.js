/* ============================================================================
 * data/events_forecasts.js — between-day events, daily forecasts, customer ability roller
 * ============================================================================ */

/* ---- Roll helpers ---------------------------------------------------------
 * `_rollFrom(list)` is a uniform pick. `_rollWeighted(list, key)` reads the
 * weight from each entry's `key` field and rolls proportionally. Both go
 * through Math.random so the seedable Math swapped in by the headless harness
 * still drives every roll deterministically.
 */
function _rollFrom(list) {
  return list[(Math.random() * list.length) | 0];
}
function _rollWeighted(list, weightKey) {
  let total = 0;
  for (const e of list) total += e[weightKey];
  let r = Math.random() * total;
  for (const e of list) {
    r -= e[weightKey];
    if (r <= 0) return e;
  }
  return list[list.length - 1];
}

/* ---- Between-day events ---------------------------------------------------- */
// Each event fires at end-of-day and is resolved through the same modal as
// midday events — each entry's `choices` array follows the midday shape so
// MiddayEventApp can render both flows. A choice is one of:
//   { kind: 'pay',    label, cost: { money?, reputation? }, onResolve(sim) }
//   { kind: 'roll',   label, stat, dc, onPass(sim, chef), onFail(sim, chef) }
//   { kind: 'hybrid', label, cost, stat, dc, onPass, onFail }
// Callbacks may mutate sim and return { msg, profile?, statusOverride?,
// deltaMoney? }. The resolver pipes that through to sim.eventOutcome.
const EVENTS = [
  {
    id: 'burglar', icon: '🦹', title: 'Masked Burglar',
    flavor: 'A hooded figure rattles the back door after close.',
    choices: [
      {
        kind: 'roll', label: 'Confront them', stat: 'str', statLabel: 'STR',
        dc: (day) => 5 + Math.min(day, 7),
        onPass: (sim, chef) => ({ msg: `${chef.name} scared them off. Safe.` }),
        onFail: (sim, chef) => {
          const today = Math.max(0, sim.money - sim.dayStartMoney);
          const loss  = Math.floor(today * 0.5);
          sim.money   = Math.max(0, sim.money - loss);
          return { deltaMoney: -loss, msg: `${chef.name} couldn't stop them. Lost $${loss}.` };
        },
      },
      {
        kind: 'pay', label: 'Hire overnight security ($120)',
        cost: { money: 120 },
        onResolve: (sim) => ({ msg: 'Guard parked out back. They moved on.' }),
      },
    ],
  },
  {
    id: 'drunk_brawl', icon: '🥊', title: 'Table 3 Brawl',
    flavor: 'Two regulars start throwing punches over the salt.',
    choices: [
      {
        kind: 'roll', label: 'Break it up', stat: 'str', statLabel: 'STR',
        dc: (day) => 4 + Math.min(day, 6),
        onPass: (sim, chef) => {
          const bonus = 30 + 5 * chef.effStat('cha');
          sim.money += bonus;
          return { deltaMoney: bonus, msg: `${chef.name} broke it up. Grateful table tipped $${bonus}.` };
        },
        onFail: (sim, chef) => {
          sim.money = Math.max(0, sim.money - 40);
          return { deltaMoney: -40, msg: `Furniture smashed. Repairs cost $40.` };
        },
      },
      {
        kind: 'pay', label: 'Call the cops ($30, −5 rep)',
        cost: { money: 30 },
        onResolve: (sim) => {
          sim.reputation = Math.max(0, sim.reputation - 5);
          return { msg: 'Dragged out in cuffs. Patrons grumbled. −5 rep.' };
        },
      },
    ],
  },
  {
    id: 'health_inspector', icon: '📋', title: 'Health Inspector',
    flavor: 'Clipboard. Gloves. No smile.',
    choices: [
      {
        kind: 'roll', label: 'Walk them through the kitchen', stat: 'int', statLabel: 'INT',
        dc: (day) => 5 + Math.min(day, 7),
        onPass: (sim, chef) => ({
          profile: { tipMult: 1.10, label: 'A-grade boosts tips +10% tomorrow' },
          msg: `${chef.name} aced it. Tomorrow tips +10%.`,
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
        kind: 'pay', label: 'Slip them an envelope ($150)',
        cost: { money: 150 },
        onResolve: (sim) => ({ msg: 'Clipboard tucked away. No grade today.' }),
      },
    ],
  },
  {
    id: 'rodent_sighting', icon: '🐀', title: 'Rodent Sighting',
    flavor: 'Something moved by the walk-in.',
    choices: [
      {
        kind: 'roll', label: 'Set traps tonight', stat: 'int', statLabel: 'INT',
        dc: (day) => 4 + Math.min(day, 6),
        onPass: (sim, chef) => ({ msg: `${chef.name} trapped it in time. No loss.` }),
        onFail: (sim, chef) => ({
          profile: { tipMult: 0.9, label: 'Rumors spread — tips −10% tomorrow' },
          msg: `Whispers spread. Tomorrow tips −10%.`,
        }),
      },
      {
        kind: 'pay', label: 'Pro exterminator ($90)',
        cost: { money: 90 },
        onResolve: (sim) => ({ msg: 'Cleared overnight. No trace by open.' }),
      },
    ],
  },
  {
    id: 'food_critic', icon: '📝', title: 'Food Critic',
    flavor: 'Table 4 is scribbling in a notebook.',
    choices: [
      {
        kind: 'roll', label: 'Send chef out to schmooze', stat: 'int', statLabel: 'INT',
        dc: (day) => 6 + Math.min(day, 7),
        onPass: (sim, chef) => {
          sim.money += 200;
          return { deltaMoney: 200, msg: `${chef.name} earned a rave review! +$200.` };
        },
        onFail: (sim, chef) => ({
          profile: { quotaMult: 0.8, label: 'Slow reviews — fewer customers tomorrow' },
          msg: `Lukewarm review. Fewer customers tomorrow.`,
        }),
      },
      {
        kind: 'pay', label: 'Comp their meal (−15 rep)',
        cost: { reputation: 15 },
        onResolve: (sim) => ({ msg: 'They left with a free dinner and a neutral review.' }),
      },
    ],
  },
  {
    id: 'supply_late', icon: '🚚', title: 'Supply Truck Late',
    flavor: 'Truck broke down on the interstate.',
    choices: [
      {
        kind: 'roll', label: 'Improvise from pantry', stat: 'dex', statLabel: 'DEX',
        dc: (day) => 5 + Math.min(day, 6),
        onPass: (sim, chef) => ({ msg: `${chef.name} improvised perfectly. Stock intact.` }),
        onFail: (sim, chef) => {
          sim.money = Math.max(0, sim.money - 60);
          return { deltaMoney: -60, msg: `Emergency restock. −$60.` };
        },
      },
      {
        kind: 'pay', label: 'Pay rush surcharge ($45)',
        cost: { money: 45 },
        onResolve: (sim) => ({ msg: 'Driver got a bonus. Inventory back by morning.' }),
      },
    ],
  },
  {
    id: 'power_flicker', icon: '💡', title: 'Power Flicker',
    flavor: 'The lights blink twice, then stay.',
    choices: [
      {
        kind: 'roll', label: 'Reset the breakers yourself', stat: 'dex', statLabel: 'DEX',
        dc: (day) => 4 + Math.min(day, 6),
        onPass: (sim, chef) => ({ msg: `${chef.name} reset the breakers. All clear.` }),
        onFail: (sim, chef) => ({
          profile: { cookTimeMult: 1.4, label: 'Brownout — stoves slow 40% tomorrow' },
          msg: `Half the stoves flaky tomorrow.`,
        }),
      },
      {
        kind: 'pay', label: 'Call the electrician ($75)',
        cost: { money: 75 },
        onResolve: (sim) => ({ msg: 'Wiring fixed. Stoves humming.' }),
      },
    ],
  },
  {
    id: 'rival_poach', icon: '💼', title: 'Rival Scout',
    flavor: 'A scout leaves a business card on a chef\'s station.',
    choices: [
      {
        kind: 'roll', label: 'Charm them yourself', stat: 'cha', statLabel: 'CHA',
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
        kind: 'pay', label: 'Match the counter-offer ($100)',
        cost: { money: 100 },
        onResolve: (sim) => ({ msg: 'Loyalty bought, kitchen intact.' }),
      },
    ],
  },
  {
    id: 'celebrity', icon: '🕶️', title: 'Celebrity Visit',
    flavor: 'Sunglasses indoors, at 9pm.',
    choices: [
      {
        kind: 'roll', label: 'Send chef to charm them', stat: 'cha', statLabel: 'CHA',
        dc: (day) => 6 + Math.min(day, 7),
        onPass: (sim, chef) => ({
          profile: { tipMult: 1.5, label: 'Viral post — tips +50% tomorrow' },
          statusOverride: { kind: 'starstruck', daysLeft: 1 },
          msg: `${chef.name} made the viral post. Tips +50% tomorrow!`,
        }),
        onFail: (sim, chef) => ({
          profile: { tipMult: 0.8, label: 'Bad post — tips −20% tomorrow' },
          msg: `They posted the bad plate. Tips −20% tomorrow.`,
        }),
      },
      {
        kind: 'pay', label: 'Comp the whole meal ($80)',
        cost: { money: 80 },
        onResolve: (sim) => {
          sim.reputation = Math.min(sim.reputationMax, sim.reputation + 10);
          return { msg: 'A polite thank-you post. +10 rep.' };
        },
      },
    ],
  },
  {
    id: 'party_booking', icon: '🎉', title: 'Birthday Booking',
    flavor: 'A party wants the back room tomorrow night.',
    choices: [
      {
        kind: 'roll', label: 'Sell them the upsell', stat: 'cha', statLabel: 'CHA',
        dc: (day) => 5 + Math.min(day, 6),
        onPass: (sim, chef) => ({
          profile: { quotaMult: 1.5, tipMult: 1.15, label: 'Big party tomorrow — +50% customers, +15% tips' },
          msg: `${chef.name} booked it! Big crowd tomorrow.`,
        }),
        onFail: (sim, chef) => {
          sim.money = Math.max(0, sim.money - 80);
          return { deltaMoney: -80, msg: `They walked. Refund $80.` };
        },
      },
      {
        kind: 'pay', label: 'Decline the booking (free)',
        cost: {},
        onResolve: (sim) => ({ msg: 'No party tomorrow. No risk either.' }),
      },
    ],
  },
  {
    id: 'rush_order', icon: '🛵', title: 'Rush Delivery',
    flavor: 'A courier whale needs 15 covers, yesterday.',
    choices: [
      {
        kind: 'roll', label: 'Burn through prep', stat: 'spd', statLabel: 'SPD',
        dc: (day) => 5 + Math.min(day, 7),
        onPass: (sim, chef) => {
          sim.money += 60;
          return { deltaMoney: 60, msg: `${chef.name} got it out on time. +$60.` };
        },
        onFail: (sim, chef) => {
          sim.money = Math.max(0, sim.money - 40);
          return { deltaMoney: -40, msg: `Missed the window. Refund $40.` };
        },
      },
      {
        kind: 'pay', label: 'Turn them away (−3 rep)',
        cost: { reputation: 3 },
        onResolve: (sim) => ({ msg: 'They drove off. Word travels.' }),
      },
    ],
  },
  {
    id: 'pipe_leak', icon: '🚰', title: 'Pipe Leak',
    flavor: 'Water pooling under the sink.',
    choices: [
      {
        kind: 'roll', label: 'Patch it yourself', stat: 'dex', statLabel: 'DEX',
        dc: (day) => 4 + Math.min(day, 6),
        onPass: (sim, chef) => ({ msg: `${chef.name} caught it fast. No damage.` }),
        onFail: (sim, chef) => {
          sim.money = Math.max(0, sim.money - 70);
          return { deltaMoney: -70, msg: `Plumber bill. −$70.` };
        },
      },
      {
        kind: 'pay', label: 'Call the plumber ($55)',
        cost: { money: 55 },
        onResolve: (sim) => ({ msg: 'Patched cleanly within the hour.' }),
      },
    ],
  },
  {
    id: 'room_grant', icon: '🏗️', title: 'Spare Room Offer',
    flavor: 'The landlord offers to knock through to the empty space next door.',
    choices: [
      {
        // Free grant: samples a random preset room config and queues it for the
        // player to position with the Place Room tool. Mirrors the deferred
        // freeBuildCredits pattern — we store the config *id* (stable across
        // save/load) and look it up at placement time.
        kind: 'pay', label: 'Take the room (free)',
        cost: {},
        onResolve: (sim) => {
          const cfg = sim.grantRandomRoom();
          if (!cfg) return { msg: 'No room available to grant right now.' };
          return { msg: `New room: ${cfg.name}. Use the Add Room tool to place it.` };
        },
      },
      {
        kind: 'pay', label: 'Pass on it (free)',
        cost: {},
        onResolve: (sim) => ({ msg: 'Left the space empty for now.' }),
      },
    ],
  },
];

// Daily events minus the room grant — the grant is scheduled (every 3rd day),
// not part of the random draw, so rooms arrive on a predictable cadence.
const _RANDOM_DAILY_EVENTS = EVENTS.filter(e => e.id !== 'room_grant');

function rollDailyEvent(day) {
  // Guaranteed room-expansion grant every 3rd day (day 3, 6, 9, …); otherwise
  // a uniform pick from the rest of the catalog.
  if (day && day % 3 === 0) {
    return getDailyEventById('room_grant') || _rollFrom(_RANDOM_DAILY_EVENTS);
  }
  return _rollFrom(_RANDOM_DAILY_EVENTS);
}

// Look up a daily event by id (used by save/load).
function getDailyEventById(id) {
  return EVENTS.find(e => e.id === id) || null;
}

/* ---- Midday events ---------------------------------------------------------
 * Fire mid-service (during 'spawning' or 'draining'). The game pauses; the
 * player picks from 2-4 authored choices per event. Each choice is one of:
 *   { kind: 'pay',    label, cost: { money?, reputation? }, onResolve(sim) }
 *   { kind: 'roll',   label, stat, dc, onPass(sim, chef), onFail(sim, chef) }
 *   { kind: 'ability',label, abilityId, onResolve(sim, chef),
 *                     onMissing?(sim) }
 *   { kind: 'hybrid', label, cost, stat, dc, onPass, onFail }
 *
 * Effect callbacks may mutate sim (money, reputation, status, freeBuildCredits,
 * breakRandomBuilding) and must return { msg, ...details? }. The midday
 * resolver also accepts `chef` for roll/ability choices and runs the stat
 * check at 1d10 + chef.effStat(stat) vs dc.
 * ========================================================================== */

const MIDDAY_EVENTS = [
  {
    id: 'grease_fire',
    icon: '🔥', title: 'Grease Fire!',
    flavor: 'Flames lick up the back wall of the kitchen.',
    choices: [
      {
        kind: 'pay', label: 'Smother with $80 of soda water',
        cost: { money: 80 },
        onResolve: (sim) => ({ msg: 'Flames out. Inventory restocked.' }),
      },
      {
        kind: 'roll', label: 'Smother by hand', stat: 'dex', statLabel: 'DEX', dc: 9,
        onPass: (sim, chef) => ({
          msg: `${chef.name} stomps it out clean.`,
        }),
        onFail: (sim, chef) => {
          const b = sim.breakRandomBuilding(['stove', 'catapult_stove']);
          const where = b ? `${chef.name} saved the day but a stove cracked.` : `${chef.name} stomped it out, no damage.`;
          return { msg: where, brokeId: b ? b.id : null };
        },
      },
    ],
  },

  {
    id: 'critic_walks_in',
    icon: '📝', title: 'Local Critic — At The Counter',
    flavor: 'They tap their pen. Twice.',
    choices: [
      {
        kind: 'pay', label: 'Comp the table — 10 rep',
        cost: { reputation: 10 },
        onResolve: (sim) => ({ msg: 'Cleared their bill. They smiled.' }),
      },
      {
        kind: 'roll', label: 'Charm them', stat: 'cha', statLabel: 'CHA', dc: 10,
        onPass: (sim) => {
          sim.reputation = Math.min(sim.reputationMax, sim.reputation + 20);
          return { msg: `Rave-worthy! +20 reputation.` };
        },
        onFail: (sim) => {
          sim.reputation = Math.max(0, sim.reputation - 15);
          return { msg: `They scribbled darkly. −15 reputation.` };
        },
      },
    ],
  },

  {
    id: 'supply_truck',
    icon: '🚚', title: 'Surprise Supply Drop',
    flavor: 'A truck idles at the curb. Free goods or a haggle.',
    choices: [
      {
        kind: 'pay', label: 'Take cash on offer ($60)',
        cost: { money: -60 },     // negative cost = grant
        onResolve: (sim) => ({ msg: `Truck driver tossed you $60.`, deltaMoney: 60 }),
      },
      {
        kind: 'roll', label: 'Negotiate for goods', stat: 'int', statLabel: 'INT', dc: 9,
        onPass: (sim) => {
          sim.freeBuildCredits = sim.freeBuildCredits || [];
          sim.freeBuildCredits.push('table');
          sim.freeBuildCredits.push('chair');
          return { msg: `Free table + chair credit added to Build.` };
        },
        onFail: (sim) => {
          sim.money += 30;
          return { msg: `Walked away with $30 in your pocket.`, deltaMoney: 30 };
        },
      },
    ],
  },

  {
    id: 'drunk_brawl_mid',
    icon: '🥊', title: 'Brawl at Table 5',
    flavor: 'Two regulars are squaring up.',
    choices: [
      {
        kind: 'pay', label: 'Hire a bouncer ($100)',
        cost: { money: 100 },
        onResolve: (sim) => ({ msg: 'They scurried out quietly.' }),
      },
      {
        kind: 'roll', label: 'Wrestle them apart', stat: 'str', statLabel: 'STR', dc: 11,
        onPass: (sim, chef) => {
          sim.money += 40;
          return { msg: `${chef.name} broke it up. Grateful table tipped $40.`, deltaMoney: 40 };
        },
        onFail: (sim, chef) => {
          const b = sim.breakRandomBuilding();
          chef.status = { kind: 'injured', daysLeft: 2 };
          return {
            msg: `Furniture smashed, ${chef.name} took a punch. Out 2 days.`,
            brokeId: b ? b.id : null,
            statusOverride: { kind: 'injured', daysLeft: 2 },
          };
        },
      },
      {
        kind: 'hybrid', label: 'Pay $40 AND chef rolls SPD (DC 8)',
        cost: { money: 40 }, stat: 'spd', statLabel: 'SPD', dc: 8,
        onPass: (sim) => ({ msg: 'Out the door fast, no damage.' }),
        onFail: (sim) => {
          sim.reputation = Math.max(0, sim.reputation - 5);
          return { msg: 'A few patrons left grumbling. −5 reputation.' };
        },
      },
    ],
  },

  {
    id: 'health_inspector_mid',
    icon: '📋', title: 'Surprise Inspection',
    flavor: 'No appointment. No smile.',
    choices: [
      {
        kind: 'pay', label: 'Slip them $120',
        cost: { money: 120 },
        onResolve: (sim) => ({ msg: 'Clipboard tucked away. All clear.' }),
      },
      {
        kind: 'roll', label: 'Cite procedure', stat: 'int', statLabel: 'INT', dc: 10,
        onPass: (sim) => ({ msg: 'A-grade on the spot.' }),
        onFail: (sim) => {
          sim.money = Math.max(0, sim.money - 200);
          sim.reputation = Math.max(0, sim.reputation - 5);
          return { msg: '$200 fine + 5 rep hit.' };
        },
      },
    ],
  },

  {
    id: 'birthday_table',
    icon: '🎂', title: 'Birthday Booking',
    flavor: 'A party of six wants the back room — now.',
    choices: [
      {
        kind: 'pay', label: 'Comp dessert ($30)',
        cost: { money: 30 },
        onResolve: (sim) => {
          sim.reputation = Math.min(sim.reputationMax, sim.reputation + 8);
          return { msg: 'Selfies all around. +8 rep.' };
        },
      },
      {
        kind: 'roll', label: 'Sing for them', stat: 'cha', statLabel: 'CHA', dc: 9,
        onPass: (sim) => {
          sim.money += 70;
          sim.reputation = Math.min(sim.reputationMax, sim.reputation + 12);
          return { msg: 'Standing ovation. +$70, +12 rep.' };
        },
        onFail: (sim) => ({ msg: 'Awkward silence. They tipped politely.' }),
      },
    ],
  },

  {
    id: 'pipe_burst',
    icon: '💧', title: 'Pipe Bursts Under Sink',
    flavor: 'Water spreads under the floor tiles.',
    choices: [
      {
        kind: 'pay', label: 'Call plumber ($90)',
        cost: { money: 90 },
        onResolve: (sim) => ({ msg: 'Fixed within the hour.' }),
      },
      {
        kind: 'roll', label: 'Patch it yourself', stat: 'dex', statLabel: 'DEX', dc: 9,
        onPass: (sim) => ({ msg: 'Duct-tape special. Held.' }),
        onFail: (sim) => {
          const b = sim.breakRandomBuilding('sink');
          return { msg: 'Sink completely flooded — broken.', brokeId: b ? b.id : null };
        },
      },
    ],
  },

  {
    id: 'rush_delivery_mid',
    icon: '🛵', title: 'Rush Delivery',
    flavor: 'A courier paces at the door — 10 covers, fast.',
    choices: [
      {
        kind: 'roll', label: 'Whip it together', stat: 'spd', statLabel: 'SPD', dc: 9,
        onPass: (sim) => {
          sim.money += 80;
          return { msg: 'Out the door on time. +$80.', deltaMoney: 80 };
        },
        onFail: (sim) => {
          sim.money = Math.max(0, sim.money - 40);
          return { msg: 'Missed window, refund. −$40.', deltaMoney: -40 };
        },
      },
      {
        kind: 'pay', label: 'Turn them away (free)',
        cost: {},
        onResolve: (sim) => {
          sim.reputation = Math.max(0, sim.reputation - 3);
          return { msg: 'Word gets around. −3 reputation.' };
        },
      },
    ],
  },

  {
    id: 'celebrity_drops_in',
    icon: '🕶️', title: 'Celebrity Drops In',
    flavor: 'Sunglasses. Indoors. A small camera crew.',
    choices: [
      {
        kind: 'pay', label: 'Comp the table + 10 rep',
        cost: { reputation: -10 },     // negative = grant
        onResolve: (sim) => {
          sim.reputation = Math.min(sim.reputationMax, sim.reputation + 10);
          return { msg: 'They left a glowing post. +10 rep.' };
        },
      },
      {
        kind: 'roll', label: 'Star treatment', stat: 'cha', statLabel: 'CHA', dc: 11,
        onPass: (sim, chef) => {
          sim.money += 150;
          sim.reputation = Math.min(sim.reputationMax, sim.reputation + 20);
          chef.status = { kind: 'starstruck', daysLeft: 1 };
          return {
            msg: `Viral! +$150, +20 rep, ${chef.name} starstruck tomorrow.`,
            statusOverride: { kind: 'starstruck', daysLeft: 1 },
          };
        },
        onFail: (sim) => {
          sim.reputation = Math.max(0, sim.reputation - 10);
          return { msg: 'They posted the bad take. −10 reputation.' };
        },
      },
      {
        kind: 'hybrid', label: 'Bribe $50 + INT (DC 8)',
        cost: { money: 50 }, stat: 'int', statLabel: 'INT', dc: 8,
        onPass: (sim) => {
          sim.reputation = Math.min(sim.reputationMax, sim.reputation + 15);
          return { msg: 'Clean shoot, clean post. +15 rep.' };
        },
        onFail: (sim) => ({ msg: 'Wasted the bribe. They left bored.' }),
      },
    ],
  },

  {
    id: 'lucky_find',
    icon: '🪙', title: 'Lucky Find Under the Floorboards',
    flavor: 'A chef tripped on a loose tile.',
    choices: [
      {
        kind: 'pay', label: 'Pocket it',
        cost: {},
        onResolve: (sim) => {
          sim.money += 50;
          return { msg: 'Quietly pocketed $50.', deltaMoney: 50 };
        },
      },
      {
        kind: 'roll', label: 'Dig deeper', stat: 'str', statLabel: 'STR', dc: 9,
        onPass: (sim) => {
          sim.money += 150;
          return { msg: 'Old envelope of cash — $150!', deltaMoney: 150 };
        },
        onFail: (sim) => {
          const b = sim.breakRandomBuilding();
          return { msg: 'Pulled too hard. Something snapped.', brokeId: b ? b.id : null };
        },
      },
    ],
  },

  {
    id: 'free_decorator',
    icon: '🎨', title: 'Decorator Looking for Portfolio Shots',
    flavor: 'They want a free reno in exchange for photos.',
    choices: [
      {
        kind: 'pay', label: 'Decline',
        cost: {},
        onResolve: (sim) => ({ msg: 'Politely sent them packing.' }),
      },
      {
        kind: 'roll', label: 'Accept their pitch', stat: 'cha', statLabel: 'CHA', dc: 8,
        onPass: (sim) => {
          sim.freeBuildCredits = sim.freeBuildCredits || [];
          sim.freeBuildCredits.push('table');
          sim.freeBuildCredits.push('chair');
          sim.freeBuildCredits.push('floor');
          sim.freeBuildCredits.push('floor');
          return { msg: 'Two free floor tiles + table + chair credits!' };
        },
        onFail: (sim) => {
          sim.money = Math.max(0, sim.money - 50);
          return { msg: 'They charged a $50 consultation fee.', deltaMoney: -50 };
        },
      },
    ],
  },

  {
    id: 'rat_in_dining',
    icon: '🐀', title: 'Rat in the Dining Room',
    flavor: 'A small grey blur darts past Table 3.',
    choices: [
      {
        kind: 'pay', label: 'Call exterminator ($70)',
        cost: { money: 70 },
        onResolve: (sim) => ({ msg: 'Cleared in 10 minutes.' }),
      },
      {
        kind: 'roll', label: 'Chase it out', stat: 'spd', statLabel: 'SPD', dc: 10,
        onPass: (sim, chef) => ({ msg: `${chef.name} caught it bare-handed.` }),
        onFail: (sim) => {
          sim.reputation = Math.max(0, sim.reputation - 12);
          return { msg: 'Patrons saw. Word spreads. −12 reputation.' };
        },
      },
    ],
  },
];

// Roll a midday event keyed off the day so we can tune difficulty later;
// today it's a uniform pick.
function rollMiddayEvent(_day) {
  return _rollFrom(MIDDAY_EVENTS);
}

// Look up a midday event by id (used by save/load).
function getMiddayEventById(id) {
  return MIDDAY_EVENTS.find(e => e.id === id) || null;
}

/* ---- Pre-game gift event --------------------------------------------------- */
// One-shot at boot. The player picks one option; gift.apply(sim) mutates the
// sim and returns { msg } for the outcome banner. Unlike EVENTS, there is no
// stat check — the gift is a free choice the run starts with.
const GIFTS = [
  {
    id: 'seed_money', icon: '💰', label: 'Starter Bonus',
    description: '+$300 starting cash.',
    apply: (sim) => { sim.money += 300; return { msg: '+$300 to your starting cash.' }; },
  },
  {
    id: 'extra_heart', icon: '❤️', label: 'Iron Stomach',
    description: '+20 reputation.',
    apply: (sim) => {
      sim.reputationMax += 20;
      sim.reputation = Math.min(sim.reputationMax, sim.reputation + 20);
      return { msg: '+20 reputation (max +20).' };
    },
  },
  {
    id: 'free_hire', icon: '👤', label: 'Friend in the Industry',
    description: 'One free hire from the recruit pool (cost waived once).',
    apply: (sim) => {
      sim._freeHireCredits = (sim._freeHireCredits || 0) + 1;
      return { msg: 'Next hire is free.' };
    },
  },
  {
    id: 'big_crowd', icon: '🌊', label: 'Buzz',
    description: '+50% customers on Day 1.',
    apply: (sim) => {
      const p = sim.todayProfile || {};
      sim.todayProfile = { ...p, quotaMult: (p.quotaMult || 1) * 1.5 };
      return { msg: '+50% customers tomorrow.' };
    },
  },
  {
    id: 'tip_boost', icon: '✨', label: 'Generous Locals',
    description: '+25% tips on Day 1.',
    apply: (sim) => {
      const p = sim.todayProfile || {};
      sim.todayProfile = { ...p, tipMult: (p.tipMult || 1) * 1.25 };
      return { msg: '+25% tips tomorrow.' };
    },
  },
  {
    id: 'fast_kitchen', icon: '⚡', label: 'Sharpened Knives',
    description: '−20% cook time on Day 1.',
    apply: (sim) => {
      const p = sim.todayProfile || {};
      sim.todayProfile = { ...p, cookTimeMult: (p.cookTimeMult || 1) * 0.8 };
      return { msg: '−20% cook time tomorrow.' };
    },
  },
];

// Roll three random gift choices for the player to pick from at boot.
// Each gift becomes a `kind: 'pay'` choice with no cost — the player just
// picks one and its `apply(sim)` runs as the choice's onResolve.
function rollGiftEvent() {
  const shuffled = [...GIFTS].sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, 3);
  const choices = picks.map(g => ({
    id: g.id,             // stable per-gift id used in eventOutcome.result.giftId
    kind: 'pay',
    label: `${g.icon || '🎁'} ${g.label}`,
    description: g.description,
    cost: {},
    onResolve: (sim) => {
      const res = (typeof g.apply === 'function' ? g.apply(sim) : null) || {};
      res.giftId = g.id;
      return res;
    },
  }));
  return {
    kind: 'gift',
    id: 'starting_gift', icon: '🎁', title: 'A Welcome Gift',
    flavor: 'Pick one boon to kick off your run.',
    choices,
  };
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
  return _rollFrom(FORECASTS);
}

// Picks at most one ability per customer. ~55% have no ability, else weighted.
function rollCustomerAbilities() {
  if (Math.random() < 0.55) return [];
  return [_rollWeighted(CUSTOMER_ABILITY_ROLL, 'weight').id];
}
