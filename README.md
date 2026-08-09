# Chow Time

Chow Time is a browser-based restaurant simulation game built with Phaser, with a headless simulation/test harness for deterministic testing in Node.js.

## Project structure

```
.
├── index.html              # Browser entrypoint and script load order
├── scene.js                # GameScene orchestration and Phaser wiring
├── sprites.js              # Shared drawing/constants helpers
├── src
│   ├── data/               # Static game data (constants, layouts, events, chef presets)
│   ├── sim/                # Core simulation (day flow, events, save/load, grid)
│   ├── entities/           # Domain entities (buildings, customers, employees)
│   ├── ui/                 # App shell + in-game panels/tools
│   ├── view/               # Rendering systems (floor/world/texture/audio)
│   └── scenes/             # Phaser boot/preload/ui scene modules
└── test/                   # Unit/integration/scenario/fuzz tests + harness
```

## High-level code logic

1. **Startup**
   - `index.html` shows the menu and launches `startChowTime()` from `scene.js`.
   - `BootScene` starts `PreloadScene`, which bakes textures, then starts `GameScene`.

2. **Simulation core (`src/sim`)**
   - `Simulation` is the main state container: grid, buildings, entities, money, reputation, day state, event history.
   - `DayStateMachine` drives day progression (`spawning -> draining -> dayEnd`).
   - `EventManager` handles boot gift, day-end events, and midday events with unified outcome handling.
   - `save_load.js` serializes/deserializes full run state for JSON save files.

3. **Entity behavior (`src/entities`)**
   - Customers spawn, pathfind, order, eat, and leave.
   - Employees (chefs) pick tasks and interact with stoves/sinks/tables.
   - Buildings encode station behavior (including special variants like catapult stoves).

4. **UI and tools (`src/ui`)**
   - `AppManager` enforces a single active app/panel/tool.
   - Apps implement build/hire/move/sell/repair/rotate/assign/day transitions/settings/game-over flows.
   - Top bar and widgets reflect simulation state and route user actions to simulation APIs.

5. **Rendering (`src/view`)**
   - Floor and world rendering are separated for performance and layering.
   - `GameScene` updates simulation each frame, then updates view systems and overlays.

## Test strategy

The `test/harness.js` loader runs the same simulation/UI source files in a Node VM context (without Phaser runtime rendering) so game logic can be tested deterministically.

Available scripts:

- `npm test`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:scenarios`
- `npm run test:fuzz`
