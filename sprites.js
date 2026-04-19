/* ============================================================================
 * sprites.js  —  all visual design
 * ============================================================================
 * Contains:
 *   - Visual layout constants (iso tile size, UI chrome, game canvas dims)
 *   - Color palettes (tile colors, customer clothing, skin tones, hair)
 *   - Iso math helpers (gridToScreen / screenToTile)
 *   - Drawing primitives (drawDiamond, drawIsoBox)
 *   - Sprites object: a function per drawable kind
 *
 * Uses Phaser's Graphics API to draw, but takes every needed handle through
 * the `view` object — it never imports Phaser or touches the scene directly.
 * References CONFIG, FOODS, CS, ES from game.js. COLS, ROWS come from game.js
 * too, so game.js must load before sprites.js.
 *
 * Every Sprites.* function takes (view, entity, sx, sy) where view = {
 *   g:       Phaser.Graphics        — main y-sorted object layer
 *   overlay: Phaser.Graphics        — top layer (bubbles, bars, arcs)
 *   time:    number (sim seconds)   — drives animation
 *   getText: (key, str, x, y, style) => Phaser.Text  — pooled text
 *   grid:    Grid                   — read-only, for adjacency lookups
 * }
 *
 * Rules:
 *   - NO sim mutations. NO calls into classes' methods that alter state.
 *   - NO references to GameScene, `this`, or any global outside CONFIG/COLORS.
 *   - Animations are driven purely by view.time so they pause/resume with sim.
 */

/* ---- Iso tile geometry (a tile diamond is 2*ISO_TW wide and 2*ISO_TH tall) - */
const ISO_TW = 36;
const ISO_TH = 18;

/* ---- Layout chrome around the iso grid ------------------------------------- */
const UI_W        = 280;
const TOP_H       = 52;
const BOT_H       = 32;
const LEFT_MARGIN = 24;
const RIGHT_MARGIN= 30;
const TOP_MARGIN  = 22;
const BOT_MARGIN  = 22;

/* ---- Derived canvas geometry (needs COLS, ROWS from game.js) --------------- */
// Grid origin: screen pixel where tile (0,0)'s CENTER sits.
// Leftmost point is tile (0, ROWS-1)'s west corner at LEFT_MARGIN.
const GRID_OX = LEFT_MARGIN + ROWS * ISO_TW;              // 312
const GRID_OY = TOP_H + TOP_MARGIN + ISO_TH;              // 92

const GAME_W = GRID_OX + COLS * ISO_TW + RIGHT_MARGIN + UI_W;
const GAME_H = TOP_H + TOP_MARGIN + (COLS + ROWS) * ISO_TH + BOT_MARGIN + BOT_H;

/* ---- Color palettes -------------------------------------------------------- */
const COLORS = {
  floorA: 0xf0d6a0, floorB: 0xe3c284, spawn: 0x8ad26b,
  outline: 0x2a1a1a,
  uiBg: 0x2a1f3e, uiPanel: 0x3d2d5c, uiSelected: 0xffb84d,
  trafficRamp: [0x4a9e4a, 0xb5a73c, 0xd17a44, 0xd64040],
};

// Read by game.js (Customer/Employee constructors attach picks to entities)
// and by Sprites functions below.
const CUSTOMER_BODY_COLORS = [
  0xff6b6b, 0x4ecdc4, 0xffe66d, 0xa8e6cf, 0xc7a7ff,
  0xf38181, 0x95e1d3, 0xffa07a, 0xb088f9, 0xffb5e8,
  0x6bcbef, 0xffd580,
];
const SKIN_TONES   = [0xfec9a7, 0xe8a777, 0xc68a5a, 0x8b5a3a, 0xfde5c8];
const PANTS_COLORS = [0x2a2a3a, 0x3a2a5a, 0x5a3a2a, 0x2a3a5a, 0x4a3a2a];
const HAIR_COLORS  = [0x3a2a1a, 0x8a6a3a, 0xbd9a5a, 0xc94a2a, 0xe0d0b0, 0x1a1a1a];


/* ---- Iso math helpers ------------------------------------------------------ */
function gridToScreen(gx, gy) {
  return {
    sx: GRID_OX + (gx - gy) * ISO_TW,
    sy: GRID_OY + (gx + gy) * ISO_TH,
  };
}
function screenToTile(sx, sy) {
  const rx = (sx - GRID_OX) / ISO_TW;
  const ry = (sy - GRID_OY) / ISO_TH;
  const gx = Math.round((rx + ry) / 2);
  const gy = Math.round((ry - rx) / 2);
  if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return null;
  return { x: gx, y: gy };
}


/* ---- Drawing primitives ---------------------------------------------------- */
// Filled & stroked diamond (tile footprint) at (sx, sy).
function drawDiamond(g, sx, sy, tw, th, fill, stroke, strokeW, fillAlpha = 1, strokeAlpha = 1) {
  g.fillStyle(fill, fillAlpha);
  g.beginPath();
  g.moveTo(sx, sy - th); g.lineTo(sx + tw, sy);
  g.lineTo(sx, sy + th); g.lineTo(sx - tw, sy);
  g.closePath();
  g.fillPath();
  if (stroke != null) {
    g.lineStyle(strokeW || 1, stroke, strokeAlpha);
    g.beginPath();
    g.moveTo(sx, sy - th); g.lineTo(sx + tw, sy);
    g.lineTo(sx, sy + th); g.lineTo(sx - tw, sy);
    g.closePath();
    g.strokePath();
  }
}

// 3D "box" on a tile: two side faces + a top diamond.
function drawIsoBox(g, sx, sy, height, topCol, rightCol, leftCol) {
  // Right (SE) face
  g.fillStyle(rightCol, 1);
  g.beginPath();
  g.moveTo(sx + ISO_TW, sy);
  g.lineTo(sx, sy + ISO_TH);
  g.lineTo(sx, sy + ISO_TH - height);
  g.lineTo(sx + ISO_TW, sy - height);
  g.closePath();
  g.fillPath();
  g.lineStyle(2, COLORS.outline, 1);
  g.strokePath();

  // Left (SW) face
  g.fillStyle(leftCol, 1);
  g.beginPath();
  g.moveTo(sx - ISO_TW, sy);
  g.lineTo(sx, sy + ISO_TH);
  g.lineTo(sx, sy + ISO_TH - height);
  g.lineTo(sx - ISO_TW, sy - height);
  g.closePath();
  g.fillPath();
  g.lineStyle(2, COLORS.outline, 1);
  g.strokePath();

  // Top face
  drawDiamond(g, sx, sy - height, ISO_TW, ISO_TH, topCol, COLORS.outline, 2);
}


/* ---- Sprites: one function per drawable kind ------------------------------- */
const Sprites = {

  /* ---- Floor + door: static, drawn once into a dedicated layer ---- */
  floorAndDoor(g, sim) {
    // Header & footer strips
    g.fillStyle(0x1a1428, 1);
    g.fillRect(0, 0, GAME_W - UI_W, TOP_H);
    g.fillRect(0, GAME_H - BOT_H, GAME_W - UI_W, BOT_H);
    // Dark backdrop behind iso diamond region
    g.fillStyle(0x231a30, 1);
    g.fillRect(0, TOP_H, GAME_W - UI_W, GAME_H - TOP_H - BOT_H);

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = sim.grid.getTile(x, y);
        const { sx, sy } = gridToScreen(x, y);
        let col = ((x + y) & 1) ? COLORS.floorA : COLORS.floorB;
        if (t.type === 'spawn') col = COLORS.spawn;
        drawDiamond(g, sx, sy, ISO_TW, ISO_TH, col, 0x000000, 1, 1, 0.12);
      }
    }

    // Door arch on spawn tile
    const sp = sim.spawnTile;
    const { sx, sy } = gridToScreen(sp.x, sp.y);
    drawDiamond(g, sx, sy, ISO_TW, ISO_TH, 0x4d8a3a, 0x2d5a1a, 2);
    g.fillStyle(0x2d5a1a, 1);
    g.fillCircle(sx, sy - 2, 5);
  },

  /* ---- Tile hover marker (pulsing diamond) ---- */
  hoverDiamond(view, sx, sy, ok) {
    const pulse = 0.55 + 0.35 * Math.sin(view.time * 6);
    drawDiamond(view.overlay, sx, sy, ISO_TW - 2, ISO_TH - 1,
                ok ? 0x6bcf7f : 0xff4d4d,
                ok ? 0x3ca35c : 0xa63030, 3, 0.22, pulse);
  },

  /* ---- Stove ---- */
  stove(view, b, sx, sy) {
    const { g, time } = view;
    const H = 34;
    drawIsoBox(g, sx, sy, H, 0x4a4048, 0x35303a, 0x2a252e);

    // Oven window on the SE face
    g.fillStyle(0x1a1418, 1);
    const rfRight = sx + ISO_TW - 6, rfLeft = sx + 6;
    g.beginPath();
    g.moveTo(rfLeft, sy - H * 0.25 + 5);
    g.lineTo(rfRight, sy - H * 0.7);
    g.lineTo(rfRight, sy - 2);
    g.lineTo(rfLeft, sy + ISO_TH * 0.5);
    g.closePath();
    g.fillPath();
    g.lineStyle(1.2, 0x555555, 1);
    g.strokePath();
    if (b.cooking) {
      g.fillStyle(0xff8033, 0.45);
      g.beginPath();
      g.moveTo(rfLeft + 2, sy - H * 0.25 + 7);
      g.lineTo(rfRight - 2, sy - H * 0.7 + 3);
      g.lineTo(rfRight - 2, sy - 4);
      g.lineTo(rfLeft + 2, sy + ISO_TH * 0.5 - 2);
      g.closePath();
      g.fillPath();
    }
    // Two knobs
    for (let i = 0; i < 2; i++) {
      const kx = sx + 8 + i * 14;
      const ky = sy + ISO_TH - 6 - i * 4;
      g.fillStyle(0xff6b35, 1); g.fillCircle(kx, ky, 2.5);
      g.lineStyle(1, COLORS.outline, 1); g.strokeCircle(kx, ky, 2.5);
    }

    // Burner on top
    g.fillStyle(0x1a1418, 1);
    g.fillEllipse(sx, sy - H, ISO_TW * 0.8, ISO_TH * 0.6);
    g.lineStyle(1.5, COLORS.outline, 1);
    g.strokeEllipse(sx, sy - H, ISO_TW * 0.8, ISO_TH * 0.6);

    if (b.cooking) {
      // Flame + smoke + progress arc
      const flick = 1 + Math.sin(time * 18 + b.id) * 0.18;
      g.fillStyle(0xffa94d, 0.95);
      g.fillEllipse(sx, sy - H - 2, 20 * flick, 6 * flick);
      g.fillStyle(0xff6b35, 1);
      g.fillEllipse(sx, sy - H - 4, 14 * flick, 4 * flick);
      g.fillStyle(0xfff59d, 1);
      g.fillEllipse(sx, sy - H - 6, 7 * flick, 2.5 * flick);
      for (let i = 0; i < 3; i++) {
        const off = ((time * 1.5) + i * 0.35) % 1;
        const px = sx + Math.sin(time * 3 + i * 2) * 8;
        const py = sy - H - 12 - off * 22;
        g.fillStyle(0xffffff, 0.6 * (1 - off));
        g.fillCircle(px, py, 4 + off * 2);
      }
      const p = 1 - b.cooking.timeLeft / b.cooking.total;
      g.lineStyle(3.5, 0xffd84d, 1);
      g.beginPath();
      g.arc(sx, sy - H, 18, -Math.PI/2, -Math.PI/2 + p * Math.PI * 2, false);
      g.strokePath();
    } else if (b.reservedFor) {
      g.fillStyle(0xaaaaaa, 1); g.fillCircle(sx, sy - H, 3);
    }
  },

  /* ---- Table ---- */
  table(view, b, sx, sy) {
    const { g, time } = view;
    const H = 18;
    // 4 legs at iso cardinal points
    g.lineStyle(2, COLORS.outline, 1);
    g.fillStyle(0x5a3a20, 1);
    const legCorners = [
      { dx:  ISO_TW - 8, dy: 0 },
      { dx: -ISO_TW + 8, dy: 0 },
      { dx: 0, dy:  ISO_TH - 4 },
      { dx: 0, dy: -ISO_TH + 4 },
    ];
    for (const c of legCorners) {
      g.fillRect(sx + c.dx - 1.5, sy + c.dy - H, 3, H);
      g.strokeRect(sx + c.dx - 1.5, sy + c.dy - H, 3, H);
    }
    // Top + cloth
    drawDiamond(g, sx, sy - H, ISO_TW - 4, ISO_TH - 2, 0x7a4a2a, COLORS.outline, 2.5);
    drawDiamond(g, sx, sy - H, ISO_TW - 9, ISO_TH - 5, 0xd63a3a, COLORS.outline, 1.2);
    g.lineStyle(1, 0xffffff, 0.35);
    for (let i = -2; i <= 2; i++) {
      const off = i * 6;
      g.lineBetween(sx - ISO_TW + 12 + off, sy - H - 1, sx + off, sy - H - ISO_TH + 4);
      g.lineBetween(sx + off, sy - H + ISO_TH - 4, sx + ISO_TW - 12 + off, sy - H - 1);
    }

    // Plate
    if (b.plate) {
      const pcol = b.plate.dirty ? 0xa89880 : 0xffffff;
      g.fillStyle(pcol, 1); g.fillEllipse(sx, sy - H - 1, 18, 7);
      g.lineStyle(2, COLORS.outline, 1); g.strokeEllipse(sx, sy - H - 1, 18, 7);
      if (!b.plate.dirty) {
        const fc = FOODS[b.plate.foodType].color;
        g.fillStyle(fc, 1); g.fillEllipse(sx, sy - H - 2, 11, 4);
        g.lineStyle(1.2, COLORS.outline, 0.6); g.strokeEllipse(sx, sy - H - 2, 11, 4);
        for (let i = 0; i < 2; i++) {
          const off = (time * 1.2 + i * 0.5) % 1;
          g.fillStyle(0xffffff, 0.55 * (1 - off));
          g.fillCircle(sx + (i === 0 ? -3 : 3), sy - H - 7 - off * 10, 2.5);
        }
      } else {
        g.fillStyle(0x6a5540, 0.75);
        g.fillCircle(sx - 3, sy - H - 1, 2);
        g.fillCircle(sx + 2, sy - H + 1, 1.5);
      }
    }
  },

  /* ---- Chair ---- */
  chair(view, b, sx, sy) {
    const { g, grid } = view;
    const table = b.getAdjacentTable(grid);
    if (!table) {
      // Orphaned chair: low block with red X to signal uselessness.
      drawIsoBox(g, sx, sy, 8, 0xaa7d55, 0x8a6040, 0x6b4830);
      g.lineStyle(3, 0xff4d4d, 0.9);
      g.lineBetween(sx - 8, sy - 4, sx + 8, sy - 12);
      g.lineBetween(sx + 8, sy - 4, sx - 8, sy - 12);
      return;
    }

    const dx = Math.sign(table.x - b.x);
    const dy = Math.sign(table.y - b.y);

    const scale = 0.55;
    const stw   = ISO_TW * scale;
    const sth   = ISO_TH * scale;
    const seatH = 11;
    const slabH = 3;
    const backH = 20;
    const postH = seatH + backH;
    const legT  = 2.2;
    const woodDark = 0x5a3a1f;
    const woodMid  = 0x7a5430;
    const woodLit  = 0xb58860;
    const woodStk  = COLORS.outline;

    // Leg positions at iso cardinal points.
    const legPos = {
      N: { lx: sx,        ly: sy - sth },
      E: { lx: sx + stw,  ly: sy },
      S: { lx: sx,        ly: sy + sth },
      W: { lx: sx - stw,  ly: sy },
    };

    // Which 2 legs are back posts (opposite-from-table)?
    let back1, back2, front1, front2;
    if (dy > 0) {        back1 = legPos.N; back2 = legPos.E; front1 = legPos.W; front2 = legPos.S; }
    else if (dy < 0) {   back1 = legPos.W; back2 = legPos.S; front1 = legPos.N; front2 = legPos.E; }
    else if (dx > 0) {   back1 = legPos.N; back2 = legPos.W; front1 = legPos.E; front2 = legPos.S; }
    else {               back1 = legPos.E; back2 = legPos.S; front1 = legPos.N; front2 = legPos.W; }
    if (back1.ly  > back2.ly ) { const t = back1;  back1  = back2;  back2  = t; }
    if (front1.ly > front2.ly) { const t = front1; front1 = front2; front2 = t; }

    g.lineStyle(1.3, woodStk, 1);

    // Back posts (full height)
    for (const p of [back1, back2]) {
      g.fillStyle(woodMid, 1);
      g.fillRect(p.lx - legT / 2, p.ly - postH, legT, postH);
      g.strokeRect(p.lx - legT / 2, p.ly - postH, legT, postH);
    }

    // Top cross-rail between back posts
    const topA = { x: back1.lx, y: back1.ly - postH };
    const topB = { x: back2.lx, y: back2.ly - postH };
    const railH = 5;
    g.fillStyle(woodMid, 1);
    g.beginPath();
    g.moveTo(topA.x, topA.y);
    g.lineTo(topB.x, topB.y);
    g.lineTo(topB.x, topB.y + railH);
    g.lineTo(topA.x, topA.y + railH);
    g.closePath();
    g.fillPath();
    g.lineStyle(1.3, woodStk, 1);
    g.strokePath();

    // Seat slab
    const sBot = sy - seatH;
    g.fillStyle(woodMid, 1);
    g.beginPath();
    g.moveTo(sx + stw, sBot);         g.lineTo(sx, sBot + sth);
    g.lineTo(sx, sBot + sth - slabH); g.lineTo(sx + stw, sBot - slabH);
    g.closePath(); g.fillPath();
    g.lineStyle(1.3, woodStk, 1); g.strokePath();
    g.fillStyle(woodDark, 1);
    g.beginPath();
    g.moveTo(sx - stw, sBot);         g.lineTo(sx, sBot + sth);
    g.lineTo(sx, sBot + sth - slabH); g.lineTo(sx - stw, sBot - slabH);
    g.closePath(); g.fillPath();
    g.strokePath();
    drawDiamond(g, sx, sBot - slabH, stw, sth, woodLit, woodStk, 1.3);

    // Front legs (short, drawn after slab)
    g.lineStyle(1.3, woodStk, 1);
    for (const p of [front1, front2]) {
      g.fillStyle(woodMid, 1);
      g.fillRect(p.lx - legT / 2, p.ly - seatH, legT, seatH);
      g.strokeRect(p.lx - legT / 2, p.ly - seatH, legT, seatH);
    }
  },

  /* ---- Sink ---- */
  sink(view, b, sx, sy) {
    const { g, time } = view;
    const H = 26;
    drawIsoBox(g, sx, sy, H, 0xe8ecf2, 0xcad1db, 0xa9b3bf);

    // Basin
    g.fillStyle(0x4a7a9e, 1);
    g.fillEllipse(sx, sy - H, ISO_TW * 0.75, ISO_TH * 0.6);
    g.lineStyle(2, COLORS.outline, 1);
    g.strokeEllipse(sx, sy - H, ISO_TW * 0.75, ISO_TH * 0.6);
    g.fillStyle(0x7fb8d9, 0.85);
    g.fillEllipse(sx, sy - H - 1, ISO_TW * 0.55, ISO_TH * 0.35);

    // Faucet
    g.lineStyle(3, 0x888888, 1);
    const fX = sx - ISO_TW * 0.35, fY = sy - H;
    g.lineBetween(fX, fY - 14, fX, fY - 2);
    g.beginPath();
    g.arc(fX + 6, fY - 14, 6, Math.PI, 0, false);
    g.strokePath();
    g.fillStyle(0x888888, 1);
    g.fillRect(fX + 12 - 1, fY - 14, 2, 4);

    // Cabinet door hint
    g.lineStyle(1.5, COLORS.outline, 0.5);
    g.lineBetween(sx, sy + ISO_TH - 5, sx, sy - H * 0.6);
    g.fillStyle(COLORS.outline, 0.6);
    g.fillCircle(sx + 4, sy - H * 0.45, 1);
    g.fillCircle(sx - 4, sy - H * 0.45, 1);

    if (b.washing) {
      for (let i = 0; i < 5; i++) {
        const off = ((time * 1.8) + i * 0.25) % 1;
        const px = sx + Math.sin(time * 4 + i * 1.3) * 10;
        const py = sy - H - off * 18;
        g.fillStyle(0xffffff, 0.75 * (1 - off));
        g.fillCircle(px, py, 2 + off * 1.5);
      }
      const p = 1 - b.washing.timeLeft / b.washing.total;
      g.lineStyle(3, 0x7fb8d9, 1);
      g.beginPath();
      g.arc(sx, sy - H, 14, -Math.PI/2, -Math.PI/2 + p * Math.PI * 2, false);
      g.strokePath();
    } else if (b.reservedFor) {
      g.fillStyle(0xaaaaaa, 1); g.fillCircle(sx, sy - H, 3);
    }
  },

  /* ---- Customer (body into g, bubbles/bars into overlay, labels via text) ---- */
  customer(view, c, sx, sy) {
    const { g, overlay, time, getText } = view;
    const moving = c.hasPath();
    const stride = moving ? Math.sin(time * 12 + c.id) : 0;
    const bob    = moving ? Math.abs(Math.sin(time * 12 + c.id)) * 1.5 : 0;

    // Shadow
    g.fillStyle(0x000000, 0.3); g.fillEllipse(sx, sy + 2, 18, 6);

    // Legs
    const legTopY = sy - 8 - bob;
    const lH = 8 + stride * 2, rH = 8 - stride * 2;
    g.fillStyle(c.pantsColor, 1);
    g.lineStyle(2, COLORS.outline, 1);
    g.fillRect(sx - 5, legTopY, 4, lH);   g.strokeRect(sx - 5, legTopY, 4, lH);
    g.fillRect(sx + 1, legTopY, 4, rH);   g.strokeRect(sx + 1, legTopY, 4, rH);
    // Shoes
    g.fillStyle(0x2a2028, 1);
    g.fillEllipse(sx - 3, legTopY + lH + 1, 8, 4);
    g.fillEllipse(sx + 3, legTopY + rH + 1, 8, 4);
    g.lineStyle(1.2, COLORS.outline, 1);
    g.strokeEllipse(sx - 3, legTopY + lH + 1, 8, 4);
    g.strokeEllipse(sx + 3, legTopY + rH + 1, 8, 4);

    // Torso
    const torsoH = 13, torsoW = 22;
    const torsoY = legTopY - torsoH + 2;
    g.fillStyle(c.bodyColor, 1);
    g.fillRoundedRect(sx - torsoW/2, torsoY, torsoW, torsoH, 6);
    g.lineStyle(2, COLORS.outline, 1);
    g.strokeRoundedRect(sx - torsoW/2, torsoY, torsoW, torsoH, 6);

    // Arms + hands
    const armSwing = stride * 2;
    g.fillStyle(c.bodyColor, 1);
    g.fillRoundedRect(sx - torsoW/2 - 3, torsoY + 2, 4, 10 - armSwing, 2);
    g.fillRoundedRect(sx + torsoW/2 - 1, torsoY + 2, 4, 10 + armSwing, 2);
    g.lineStyle(2, COLORS.outline, 1);
    g.strokeRoundedRect(sx - torsoW/2 - 3, torsoY + 2, 4, 10 - armSwing, 2);
    g.strokeRoundedRect(sx + torsoW/2 - 1, torsoY + 2, 4, 10 + armSwing, 2);
    g.fillStyle(c.skinColor, 1);
    g.fillCircle(sx - torsoW/2 - 1, torsoY + 12 - armSwing, 3);
    g.fillCircle(sx + torsoW/2 + 1, torsoY + 12 + armSwing, 3);
    g.lineStyle(1.5, COLORS.outline, 1);
    g.strokeCircle(sx - torsoW/2 - 1, torsoY + 12 - armSwing, 3);
    g.strokeCircle(sx + torsoW/2 + 1, torsoY + 12 + armSwing, 3);

    // Head
    const headR = 13;
    const headY = torsoY - headR + 3;
    g.fillStyle(c.skinColor, 1); g.fillCircle(sx, headY, headR);
    g.lineStyle(2, COLORS.outline, 1); g.strokeCircle(sx, headY, headR);

    // Hair
    if (c.hasHair && c.hat !== 2) {
      g.fillStyle(c.hairColor, 1);
      g.beginPath(); g.arc(sx, headY - 3, headR - 0.5, Math.PI + 0.25, -0.25, false); g.closePath();
      g.fillPath();
      g.lineStyle(1.5, COLORS.outline, 1); g.strokePath();
    }

    // Eyes
    const eyeY = headY + 1, po = 1.4;
    g.fillStyle(0xffffff, 1);
    g.fillCircle(sx - 4, eyeY, 3.5); g.fillCircle(sx + 4, eyeY, 3.5);
    g.lineStyle(1.2, COLORS.outline, 1);
    g.strokeCircle(sx - 4, eyeY, 3.5); g.strokeCircle(sx + 4, eyeY, 3.5);
    g.fillStyle(0x1a1420, 1);
    g.fillCircle(sx - 4 + c.facing.x * po, eyeY + c.facing.y * 0.6, 1.9);
    g.fillCircle(sx + 4 + c.facing.x * po, eyeY + c.facing.y * 0.6, 1.9);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(sx - 4 + c.facing.x * po - 0.5, eyeY - 0.5 + c.facing.y * 0.6, 0.8);
    g.fillCircle(sx + 4 + c.facing.x * po - 0.5, eyeY - 0.5 + c.facing.y * 0.6, 0.8);
    // Cheeks
    g.fillStyle(0xff9fa8, 0.75);
    g.fillEllipse(sx - 8, headY + 5, 4, 2.5);
    g.fillEllipse(sx + 8, headY + 5, 4, 2.5);

    // Mouth — state dependent
    const angry = c.anger > 70;
    if (c.state === CS.EATING) {
      const open = (Math.sin(time * 10) + 1) * 0.5;
      g.fillStyle(0x3a1010, 1); g.fillEllipse(sx, headY + 5, 5, 1.5 + open * 3);
    } else if (angry) {
      g.lineStyle(2, COLORS.outline, 1);
      g.beginPath();
      g.moveTo(sx - 5, headY + 6); g.lineTo(sx - 2, headY + 4);
      g.lineTo(sx + 1, headY + 6); g.lineTo(sx + 4, headY + 4);
      g.strokePath();
    } else if (c.state === CS.WAITING || c.state === CS.SEEKING || c.state === CS.ENTERING) {
      g.fillStyle(0x3a1010, 1); g.fillCircle(sx, headY + 5, 1.8);
    } else {
      g.lineStyle(2, COLORS.outline, 1);
      g.beginPath(); g.arc(sx, headY + 3, 3.5, 0.2, Math.PI - 0.2, false); g.strokePath();
    }

    // Hat
    Sprites._hat(g, c, sx, headY, time);

    // Angry steam
    if (angry && c.state !== CS.LEAVING) {
      for (let i = 0; i < 3; i++) {
        const off = ((time * 2.5) + i * 0.4) % 1;
        const px = sx - 10 + i * 10;
        const py = headY - 16 - off * 14;
        g.fillStyle(0xff6666, 0.7 * (1 - off));
        g.fillCircle(px, py, 3.5 * (1 - off * 0.3));
      }
    }

    // Speech bubble (overlay) with food icon (pooled text)
    if (c.state === CS.SEEKING || c.state === CS.ENTERING || c.state === CS.WAITING) {
      const bx = sx + 18, by = headY - 16;
      overlay.fillStyle(0xffffff, 1); overlay.fillCircle(bx, by, 11);
      overlay.lineStyle(2, COLORS.outline, 1); overlay.strokeCircle(bx, by, 11);
      overlay.fillStyle(0xffffff, 1);
      overlay.fillTriangle(bx - 8, by + 6, bx - 4, by + 12, bx - 4, by + 6);
      overlay.lineStyle(2, COLORS.outline, 1);
      overlay.beginPath(); overlay.moveTo(bx - 8, by + 6); overlay.lineTo(bx - 4, by + 12); overlay.strokePath();
      getText('cfood_' + c.id, FOODS[c.foodPref].icon, bx, by, {
        fontFamily: 'system-ui', fontSize: '14px',
      });
    }

    // Anger bar (overlay)
    if (c.state !== CS.LEAVING) {
      const w = 22, h = 4;
      const frac = c.anger / CONFIG.angerMax;
      let col = 0x6bcf7f;
      if (frac > 0.66) col = 0xff4d4d;
      else if (frac > 0.33) col = 0xffa94d;
      const barY = headY - 26;
      overlay.fillStyle(0x000000, 0.5); overlay.fillRoundedRect(sx - w/2 - 1, barY, w + 2, h + 2, 2);
      overlay.fillStyle(col, 1); overlay.fillRoundedRect(sx - w/2, barY + 1, w * frac, h, 1);
    }

    // Eating progress arc (overlay)
    if (c.state === CS.EATING) {
      const frac = 1 - c.eatTimer / CONFIG.eatDuration;
      overlay.lineStyle(3, 0x6bcf7f, 0.9);
      overlay.beginPath();
      overlay.arc(sx, sy + 6, 10, -Math.PI/2, -Math.PI/2 + frac * Math.PI * 2, false);
      overlay.strokePath();
    }

    // Action label (pooled text)
    const label = Sprites._customerLabel(c);
    if (label) {
      getText('clabel_' + c.id, label, sx, headY - 36, {
        fontFamily: 'system-ui', fontSize: '10px', fontStyle: 'bold',
        color: '#ffffff', stroke: '#000000', strokeThickness: 3,
      });
    }
  },

  _hat(g, c, sx, headY, time) {
    if (c.hat === 0) return;
    const headTop = headY - 13;
    g.lineStyle(2, COLORS.outline, 1);
    if (c.hat === 1) {
      // Beanie with pom
      g.fillStyle(c.hatColor, 1);
      g.beginPath(); g.arc(sx, headTop, 13, Math.PI, 0, false); g.closePath();
      g.fillPath(); g.strokePath();
      g.fillStyle(0xffffff, 1); g.fillCircle(sx, headTop - 12, 4);
      g.strokeCircle(sx, headTop - 12, 4);
    } else if (c.hat === 2) {
      // Top hat
      g.fillStyle(0x222222, 1);
      g.fillRect(sx - 13, headTop - 2, 26, 4); g.strokeRect(sx - 13, headTop - 2, 26, 4);
      g.fillRect(sx - 8, headTop - 14, 16, 12); g.strokeRect(sx - 8, headTop - 14, 16, 12);
      g.fillStyle(c.hatColor, 1); g.fillRect(sx - 8, headTop - 8, 16, 3);
    } else if (c.hat === 3) {
      // Cap with brim
      g.fillStyle(c.hatColor, 1);
      g.beginPath(); g.arc(sx, headTop, 12, Math.PI, 0, false); g.closePath();
      g.fillPath(); g.strokePath();
      g.fillRect(sx - 3, headTop - 1, 14, 3); g.strokeRect(sx - 3, headTop - 1, 14, 3);
    } else if (c.hat === 4) {
      // Propeller beanie
      g.fillStyle(c.hatColor, 1);
      g.beginPath(); g.arc(sx, headTop, 12, Math.PI, 0, false); g.closePath();
      g.fillPath(); g.strokePath();
      g.fillStyle(0xffffff, 1); g.fillRect(sx - 11, headTop - 5, 22, 2);
      g.lineStyle(2, COLORS.outline, 1);
      g.lineBetween(sx, headTop - 12, sx, headTop - 19);
      g.fillStyle(0x333333, 1); g.fillCircle(sx, headTop - 20, 2);
      g.strokeCircle(sx, headTop - 20, 2);
      const rot = time * 18;
      g.lineStyle(3, 0xff4d4d, 1);
      const r = 8;
      g.lineBetween(sx, headTop - 20, sx + Math.cos(rot) * r, headTop - 20 + Math.sin(rot) * r);
      g.lineBetween(sx, headTop - 20, sx - Math.cos(rot) * r, headTop - 20 - Math.sin(rot) * r);
    }
  },

  _customerLabel(c) {
    const food = FOODS[c.foodPref].icon;
    switch (c.state) {
      case CS.ENTERING:
      case CS.SEEKING:  return `🔍 ${food}`;
      case CS.WALKING:  return `→ 💺`;
      case CS.WAITING:  return `⏳ ${food}`;
      case CS.EATING:   return `😋`;
      case CS.LEAVING:  return c.leftReason === 'happy' ? `😊` : `😡`;
      default: return '';
    }
  },

  /* ---- Employee ---- */
  employee(view, e, sx, sy) {
    const { g, time, getText } = view;
    const moving = e.hasPath();
    const stride = moving ? Math.sin(time * 12 + e.id) : 0;
    const bob    = moving ? Math.abs(Math.sin(time * 12 + e.id)) * 1.5 : 0;

    // Shadow
    g.fillStyle(0x000000, 0.3); g.fillEllipse(sx, sy + 2, 18, 6);

    // Legs (navy pants)
    const legTopY = sy - 8 - bob;
    const lH = 8 + stride * 2, rH = 8 - stride * 2;
    g.fillStyle(0x2a4a70, 1);
    g.lineStyle(2, COLORS.outline, 1);
    g.fillRect(sx - 5, legTopY, 4, lH); g.strokeRect(sx - 5, legTopY, 4, lH);
    g.fillRect(sx + 1, legTopY, 4, rH); g.strokeRect(sx + 1, legTopY, 4, rH);
    g.fillStyle(0x2a2028, 1);
    g.fillEllipse(sx - 3, legTopY + lH + 1, 8, 4);
    g.fillEllipse(sx + 3, legTopY + rH + 1, 8, 4);
    g.lineStyle(1.2, COLORS.outline, 1);
    g.strokeEllipse(sx - 3, legTopY + lH + 1, 8, 4);
    g.strokeEllipse(sx + 3, legTopY + rH + 1, 8, 4);

    // Apron torso
    const torsoH = 14, torsoW = 24;
    const torsoY = legTopY - torsoH + 2;
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(sx - torsoW/2, torsoY, torsoW, torsoH, 6);
    g.lineStyle(2, COLORS.outline, 1);
    g.strokeRoundedRect(sx - torsoW/2, torsoY, torsoW, torsoH, 6);
    g.lineStyle(2.5, 0x4a90e2, 1);
    g.lineBetween(sx - 6, torsoY, sx - 6, torsoY + torsoH);
    g.lineBetween(sx + 6, torsoY, sx + 6, torsoY + torsoH);
    g.fillStyle(0xf2f5fa, 1);
    g.fillRoundedRect(sx - 5, torsoY + 6, 10, 6, 1);
    g.lineStyle(1.2, COLORS.outline, 0.7);
    g.strokeRoundedRect(sx - 5, torsoY + 6, 10, 6, 1);

    // Arms + hands
    const armSwing = stride * 2;
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(sx - torsoW/2 - 3, torsoY + 2, 4, 10 - armSwing, 2);
    g.fillRoundedRect(sx + torsoW/2 - 1, torsoY + 2, 4, 10 + armSwing, 2);
    g.lineStyle(2, COLORS.outline, 1);
    g.strokeRoundedRect(sx - torsoW/2 - 3, torsoY + 2, 4, 10 - armSwing, 2);
    g.strokeRoundedRect(sx + torsoW/2 - 1, torsoY + 2, 4, 10 + armSwing, 2);
    g.fillStyle(e.skinColor, 1);
    g.fillCircle(sx - torsoW/2 - 1, torsoY + 12 - armSwing, 3);
    g.fillCircle(sx + torsoW/2 + 1, torsoY + 12 + armSwing, 3);
    g.lineStyle(1.5, COLORS.outline, 1);
    g.strokeCircle(sx - torsoW/2 - 1, torsoY + 12 - armSwing, 3);
    g.strokeCircle(sx + torsoW/2 + 1, torsoY + 12 + armSwing, 3);

    // Head
    const headR = 13;
    const headY = torsoY - headR + 3;
    g.fillStyle(e.skinColor, 1); g.fillCircle(sx, headY, headR);
    g.lineStyle(2, COLORS.outline, 1); g.strokeCircle(sx, headY, headR);

    // Chef hat (band + three puffs)
    g.fillStyle(0xf5f5f5, 1);
    g.fillRoundedRect(sx - 10, headY - 14, 20, 6, 2);
    g.lineStyle(2, COLORS.outline, 1);
    g.strokeRoundedRect(sx - 10, headY - 14, 20, 6, 2);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(sx - 6, headY - 20, 7.5);
    g.fillCircle(sx + 6, headY - 21, 7.5);
    g.fillCircle(sx, headY - 25, 7);
    g.strokeCircle(sx - 6, headY - 20, 7.5);
    g.strokeCircle(sx + 6, headY - 21, 7.5);
    g.strokeCircle(sx, headY - 25, 7);

    // Eyes, cheeks, mustache
    const eyeY = headY + 1;
    g.fillStyle(0xffffff, 1);
    g.fillCircle(sx - 4, eyeY, 3.3); g.fillCircle(sx + 4, eyeY, 3.3);
    g.lineStyle(1, COLORS.outline, 1);
    g.strokeCircle(sx - 4, eyeY, 3.3); g.strokeCircle(sx + 4, eyeY, 3.3);
    g.fillStyle(0x1a1420, 1);
    g.fillCircle(sx - 4 + e.facing.x * 1.2, eyeY + e.facing.y * 0.5, 1.7);
    g.fillCircle(sx + 4 + e.facing.x * 1.2, eyeY + e.facing.y * 0.5, 1.7);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(sx - 4 + e.facing.x * 1.2 - 0.5, eyeY - 0.5 + e.facing.y * 0.5, 0.7);
    g.fillCircle(sx + 4 + e.facing.x * 1.2 - 0.5, eyeY - 0.5 + e.facing.y * 0.5, 0.7);
    g.fillStyle(0xff9fa8, 0.75);
    g.fillEllipse(sx - 8, headY + 5, 4, 2.5);
    g.fillEllipse(sx + 8, headY + 5, 4, 2.5);
    g.lineStyle(2.5, 0x3a2818, 1);
    g.beginPath(); g.arc(sx - 3, headY + 6, 3, Math.PI * 0.1, Math.PI * 0.9, false); g.strokePath();
    g.beginPath(); g.arc(sx + 3, headY + 6, 3, Math.PI * 0.1, Math.PI * 0.9, false); g.strokePath();

    // Carry (clean plate or dirty plate)
    if (e.carrying) {
      const cyP = torsoY + 8, cxP = sx;
      g.fillStyle(0xffffff, 1); g.fillEllipse(cxP, cyP, 14, 5);
      g.lineStyle(2, COLORS.outline, 1); g.strokeEllipse(cxP, cyP, 14, 5);
      g.fillStyle(FOODS[e.carrying.foodType].color, 1);
      g.fillEllipse(cxP, cyP - 1, 9, 3);
      for (let i = 0; i < 2; i++) {
        const off = (time * 1.5 + i * 0.5) % 1;
        g.fillStyle(0xffffff, 0.55 * (1 - off));
        g.fillCircle(cxP + (i === 0 ? -3 : 3), cyP - 5 - off * 10, 2.2);
      }
    } else if (e.carryingDirty) {
      const cyP = torsoY + 8, cxP = sx;
      g.fillStyle(0xa89880, 1); g.fillEllipse(cxP, cyP, 14, 5);
      g.lineStyle(2, COLORS.outline, 1); g.strokeEllipse(cxP, cyP, 14, 5);
      g.fillStyle(0x6a5540, 0.85);
      g.fillCircle(cxP - 3, cyP - 1, 1.7);
      g.fillCircle(cxP + 2, cyP, 1.3);
      g.lineStyle(1.3, 0x8b7a60, 0.8);
      g.lineBetween(cxP - 5, cyP + 2, cxP + 5, cyP + 2);
    }

    const label = Sprites._employeeLabel(e);
    if (label) {
      getText('elabel_' + e.id, label, sx, headY - 40, {
        fontFamily: 'system-ui', fontSize: '10px', fontStyle: 'bold',
        color: '#ffd84d', stroke: '#000000', strokeThickness: 3,
      });
    }
  },

  _employeeLabel(e) {
    const f = e.task && e.task.order ? FOODS[e.task.order.foodType].icon : '';
    switch (e.state) {
      case ES.IDLE:                   return `💤`;
      case ES.TO_STOVE_COOK:          return `→🔥 ${f}`;
      case ES.TO_STOVE_PICKUP:        return `→🔥 get ${f}`;
      case ES.TO_TABLE_DELIVER:       return `→🍽 ${f}`;
      case ES.TO_TABLE_PICKUP_DIRTY:  return `→ dirty`;
      case ES.TO_SINK_DROP:           return `→🚰 wash`;
      default: return '';
    }
  },
};
