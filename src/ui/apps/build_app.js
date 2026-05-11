/* ============================================================================
 * src/ui/apps/build_app.js — Build (replaces stove/sink/table/chair/catapult)
 * ============================================================================
 * Centered-overlay panel app. Reads its placeable list from
 * AppManager.buildItems — adding a new placeable is one new entry in the
 * build-items section at the bottom of src/entities/buildings.js, never
 * edits this file.
 *
 * Tabs (Kitchen / Dining) filter by item.category. Selecting an item enters
 * "placement mode": GameScene reads buildApp.activeItem to draw a hover
 * preview and route the next click to item.place(sim, x, y). After a
 * successful placement the item stays selected so the player can place
 * several in a row; ESC, right-click, or clicking the item again clears it.
 *
 * The panel is "soft modal" — clicking outside the panel closes it (so the
 * map stays clickable when nothing is being placed). When activeItem is set,
 * the AppManager treats this app as a transient cursor mode while the panel
 * is closed: selecting an item closes the panel automatically so the player
 * sees the board.
 * ========================================================================== */

class BuildApp extends App {
  constructor() {
    super({ id: 'build', icon: '🛠', title: 'Build', lockedDuringService: true });
    this.tab        = 'kitchen';   // 'kitchen' | 'dining' | 'structure'
    this.activeItem = null;        // selected BuildItem (placement cursor)
  }

  // BuildApp is "always live" (cursor stays after panel closes). It opens
  // the visible overlay only on demand, but `activeItem` may persist across
  // close/open cycles so the player can place several stoves in a row.

  /** Items in the registry that match the current tab. */
  itemsInTab() {
    const list = (this.manager ? this.manager.buildItems : []) || [];
    return list.filter(i => i.category === this.tab);
  }

  /** Whether (x,y) is a legal placement for the active item. Used by hover. */
  isValidAt(sim, x, y) {
    if (!this.activeItem) return false;
    return this.activeItem.validAt(sim, x, y);
  }

  /** Map-area click handler (Build app delegates placement here). Returns
   *  true if the click was consumed. */
  onMapClick(sim, tile, _button) {
    if (!this.activeItem || !tile) return false;
    const res = this.activeItem.place(sim, tile.x, tile.y);
    return !!(res && res.ok);
  }

  /** Right-click while placing: cancel selection. */
  cancelSelection() { this.activeItem = null; }

  /** TopBar hook: true while the player has an item armed (panel may be
   *  closed). Used to keep the launcher button highlighted as a reminder
   *  that placement is live. */
  isInUse() { return !!this.activeItem; }

  /** TopBar hook: called when the player clicks the launcher while
   *  isInUse() is true and the panel isn't currently open. Cancels the
   *  armed placement instead of re-opening the panel. */
  cancelInUse() { this.activeItem = null; }

  onClose() {
    // Closing the panel preserves activeItem so the player keeps placing.
    // We do NOT clear it here — explicit cancel via right-click or re-toggle.
  }

  update(sim) {
    const f = this._beginFrame(); if (!f) return;
    const { used, usedZones, g, dg, r } = f;

    this._drawPanelFrame(g, dg, r, used, usedZones);

    // ---- Header ----
    this._t(used, 'title', '🛠 Build', r.x + 18, r.y + 14, {
      font: 'bold 20px system-ui', color: '#ffd84d',
    });
    this._t(used, 'sub', this.activeItem ? `Placing: ${this.activeItem.label}` : 'Pick a category, then an item.',
      r.x + 18, r.y + 42, { font: '12px system-ui', color: '#c0b0e0' });

    // ---- Tabs ----
    const tabs = ['kitchen', 'dining', 'structure'];
    const tabY = r.y + 70;
    let tx = r.x + 18;
    for (const tab of tabs) {
      const active = (this.tab === tab);
      this._drawPanelButton(`tab:${tab}`, tx, tabY, 90, 30, {
        label: tab[0].toUpperCase() + tab.slice(1),
        font: 'bold 13px system-ui',
        color: active ? '#1a1428' : '#ffffff',
        fill: active ? 0xffb84d : 0x3d2d5c,
        radius: 6, shadow: false, border: 0x2a1a1a,
        labelX: tx + 12, labelY: tabY + 6,
        onClick: () => { this.tab = tab; },
      }, used, usedZones);
      tx += 90 + 8;
    }

    // ---- Item grid ----
    const list = this.itemsInTab();
    const gridX = r.x + 18, gridY = tabY + 50;
    const cardW = (r.w - 36 - 12) / 2;        // 2-column grid
    const cardH = 86;
    this._drawCardGrid(list, { x: gridX, y: gridY, cols: 2, cardW, cardH, colGap: 12, rowGap: 10 },
      (item, cx, cy) => {
        const selected = (this.activeItem && this.activeItem.id === item.id);
        const affordable = !sim || sim.debug || sim.money >= item.cost;
        if (dg) {
          dg.fillStyle(0x000000, 0.25);
          dg.fillRoundedRect(cx + 2, cy + 3, cardW, cardH, 8);
          const bg = selected ? 0xffb84d : (affordable ? 0x3d2d5c : 0x2a2233);
          dg.fillStyle(bg, 1);
          dg.fillRoundedRect(cx, cy, cardW, cardH, 8);
          dg.lineStyle(2, 0x2a1a1a, 0.6);
          dg.strokeRoundedRect(cx, cy, cardW, cardH, 8);
        }
        this._t(used, `i:${item.id}:icon`,  item.icon, cx + 12, cy + 14, {
          font: '32px system-ui',
        });
        this._t(used, `i:${item.id}:label`, item.label, cx + 60, cy + 12, {
          font: 'bold 14px system-ui',
          color: selected ? '#1a1428' : (affordable ? '#ffffff' : '#6a5a8a'),
        });
        const costStr = item.cost > 0 ? `$${item.cost}${(!affordable && !sim.debug) ? ' ❌' : ''}` : 'free';
        this._t(used, `i:${item.id}:cost`, costStr, cx + 60, cy + 32, {
          font: '12px system-ui', color: selected ? '#1a1428' : '#c0b0e0',
        });
        this._t(used, `i:${item.id}:hint`, item.hint || '', cx + 60, cy + 50, {
          font: '10px system-ui', color: selected ? '#3a2233' : '#9a8ac0',
          wordWrap: { width: cardW - 70 },
        });
        this._bindZone(`item:${item.id}`, cx, cy, cardW, cardH, () => {
          if (this.activeItem && this.activeItem.id === item.id) { this.activeItem = null; return; }
          this.activeItem = item;
          // Close the panel so the user sees the board (placement mode persists).
          if (this.manager) this.manager.close();
        }, usedZones);
      });

    this._endFrame(used, usedZones);
  }

  describe(sim) {
    return Object.assign(super.describe(), {
      tab: this.tab,
      activeItemId: this.activeItem ? this.activeItem.id : null,
      items: ((this.manager && this.manager.buildItems) || []).map(i => ({
        id: i.id, label: i.label, category: i.category, cost: i.cost,
      })),
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { BuildApp };
