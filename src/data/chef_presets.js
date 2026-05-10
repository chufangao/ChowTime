/* ============================================================================
 * data/chef_presets.js — starter chef + the fixed roster of 10 hireable chefs
 * ============================================================================ */

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
