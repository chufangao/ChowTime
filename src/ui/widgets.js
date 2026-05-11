/* ============================================================================
 * src/ui/widgets.js — Status widgets for the top bar
 * ============================================================================
 * Plain-object widgets, NOT a class hierarchy. Each widget is a small bag of
 * functions:
 *
 *   render(g, text, x, y, w, sim) — draws into Phaser graphics + text helper
 *   describe(sim)                 — returns plain JSON for snapshots
 *   width(sim)                    — preferred horizontal slot width
 *
 * The TopBar lays them out left-to-right. Adding a new readout = push a
 * plain object here, register it via AppManager.registerWidget().
 * ========================================================================== */

const Widgets = {

  /** Cash on hand — compact: just $N in yellow. */
  money() {
    return {
      id: 'money',
      width: () => 86,
      describe(sim) { return { id: 'money', value: sim ? sim.money : 0 }; },
      render(g, addText, x, y, w, sim) {
        addText('money:value', `💰$${sim.money}`, x + 6, y + 18, {
          font: 'bold 16px system-ui', color: '#ffd84d', stroke: '#000', strokeThickness: 2,
        });
      },
    };
  },

  /** Reputation: ★ N/MAX with a thin bar. Replaces the old hearts widget.
   *  Color shifts from green (healthy) to amber (warning, <30) to red
   *  (critical, <10) so the player notices at a glance. */
  reputation() {
    return {
      id: 'reputation',
      width: () => 110,
      describe(sim) {
        return { id: 'reputation', value: sim ? sim.reputation : 0, max: sim ? sim.reputationMax : 0 };
      },
      render(g, addText, x, y, w, sim) {
        const val = Math.max(0, sim.reputation | 0);
        const max = Math.max(1, sim.reputationMax | 0);
        const frac = val / max;
        const color = val < 10 ? '#ff5050'
                    : val < 30 ? '#ffb84d'
                    : '#9be88a';
        addText('reputation:value', `★ ${val}/${max}`, x + 4, y + 8, {
          font: 'bold 12px system-ui', color, stroke: '#000', strokeThickness: 1,
        });
        // Thin bar under the text.
        if (g) {
          const bx = x + 4, by = y + 28, bw = 100, bh = 6;
          g.fillStyle(0x1a1428, 1);
          g.fillRect(bx, by, bw, bh);
          const fillCol = val < 10 ? 0xff5050 : val < 30 ? 0xffb84d : 0x6bcf7f;
          g.fillStyle(fillCol, 1);
          g.fillRect(bx, by, Math.floor(bw * frac), bh);
          g.lineStyle(1, 0x000000, 0.5);
          g.strokeRect(bx, by, bw, bh);
        }
      },
    };
  },

  /** Day counter — compact one-liner. */
  day() {
    return {
      id: 'day',
      width: () => 132,
      describe(sim) {
        if (!sim) return { id: 'day' };
        return {
          id: 'day', day: sim.day, dayState: sim.dayState,
          spawned: sim.daySpawned, quota: sim.dayQuota,
        };
      },
      render(g, addText, x, y, w, sim) {
        let line;
        const isBoot = sim.currentEvent && sim.currentEvent.kind === 'gift';
        if (isBoot) {
          line = `Day 1 · setup`;
        } else if (sim.dayState === 'spawning') {
          line = `Day ${sim.day} · ${sim.daySpawned}/${sim.dayQuota}`;
        } else if (sim.dayState === 'draining') {
          line = `Day ${sim.day} · wrap`;
        } else {
          line = `Day ${sim.day} · end`;
        }
        addText('day:value', line, x + 6, y + 20, {
          font: 'bold 12px system-ui', color: '#9be8ff', stroke: '#000', strokeThickness: 1,
        });
      },
    };
  },

  /** Tiny inline stats. Two short lines so they fit in the 60px bar. */
  stats() {
    return {
      id: 'stats',
      width: () => 150,
      describe(sim) {
        if (!sim) return { id: 'stats' };
        const live = sim.customers.filter(c => c.alive).length;
        return {
          id: 'stats',
          served: sim.stats.served, angry: sim.stats.angry,
          tips: sim.stats.tipsTotal, waiting: live,
        };
      },
      render(g, addText, x, y, w, sim) {
        const live = sim.customers.filter(c => c.alive).length;
        addText('stats:l1', `😊${sim.stats.served} 😡${sim.stats.angry} 💰$${sim.stats.tipsTotal}`,
          x + 4, y + 8, { font: '11px system-ui', color: '#ffffff' });
        addText('stats:l2', `wait ${live}`,
          x + 4, y + 28, { font: '11px system-ui', color: '#c0b0e0' });
      },
    };
  },

};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Widgets };
}
