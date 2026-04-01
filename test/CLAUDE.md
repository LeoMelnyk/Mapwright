# Mapwright Test Guide

## Test Suites

Three tiers, each with its own Vitest config:

| Suite | Command | Config | Setup | Timeout |
|-------|---------|--------|-------|---------|
| **Unit/API** | `npm test` | `vitest.config.js` | `test/setup.js` | 10s |
| **Render** | `npm run test:render` | `vitest.render.config.js` | `test/render/setup-render.js` | 120s |
| **E2E** | `npm run test:e2e` | `vitest.e2e.config.js` | none (tests manage server) | 60s |

Run a single file: `node node_modules/vitest/vitest.mjs run --config <config> <path>`

## Test Fixtures

Map files for tests live in `test/util/fixtures/` — **not** `examples/`. Available maps:

- `island.mapwright` — outdoor island map (grasslands theme, multiple rooms)
- `testma.mapwright` — small test map
- `fog-before-testma.json` / `fog-after-testma.json` — fog state snapshots
- `fog-after-island.json` — fog state snapshot

## Directory Structure

```
test/
  setup.js                    — Global mocks (DOM, localStorage, editor modules)
  api/                        — Editor API unit tests (~18 files)
  util/                       — Utility function tests
    fixtures/                 — Test map files (.mapwright, .json)
  render/                     — Visual render tests (real canvas)
    setup-render.js           — Canvas polyfills via @napi-rs/canvas + theme loading
    helpers/
      snapshot-compare.js     — PNG render + pixelmatch comparison
  e2e/                        — End-to-end (server + Puppeteer bridge)
    helpers/
      server.js               — Start/stop Express server
      bridge.js               — Run puppeteer-bridge as child process
  snapshots/                  — Golden PNG files for visual regression
```

## Setup Files

### `test/setup.js` (unit/API tests)

Mocks browser APIs (`document`, `window`, `localStorage`, `requestAnimationFrame`) and editor modules that depend on the browser (`canvas-view`, `panels`, `io`, `tools`, `render/index`). Tests run in pure Node.js with no DOM.

### `test/render/setup-render.js` (render tests)

Provides real canvas via `@napi-rs/canvas` — **not** a mock. `document.createElement('canvas')` returns a real native canvas with working `getContext('2d')`, `Path2D`, `ImageData`. Also loads all `.theme` files from `src/themes/` into the `THEMES` registry.

Does **not** mock the render pipeline — `renderCells`, `renderDungeonToCanvas`, etc. all run for real.

## Writing Tests

### Unit/API tests (`test/api/`, `test/util/`)

```js
import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';

describe('myFeature', () => {
  beforeEach(() => {
    state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  });
  it('does something', () => { /* ... */ });
});
```

### Render tests (`test/render/`)

Use real canvas — can call `drawHatching`, `renderCells`, etc. directly. Import render functions from barrel (`src/render/index.js`) or directly from source files.

```js
import { createCanvas } from '@napi-rs/canvas';
import { drawHatching, THEMES } from '../../src/render/index.js';

it('renders hatching', () => {
  const canvas = createCanvas(500, 500);
  const ctx = canvas.getContext('2d');
  drawHatching(ctx, cells, roomCells, gridSize, theme, transform);
  // Check pixels with ctx.getImageData()
});
```

For snapshot comparison, use helpers from `test/render/helpers/snapshot-compare.js`:
- `renderMapToBuffer(jsonPath)` — full DM render to PNG
- `renderPlayerViewToBuffer(jsonPath, revealedCells, fogOptions)` — player view render
- `compareSnapshots(buffer, goldenPath, diffPath)` — pixelmatch comparison
- `updateGolden(buffer, goldenPath)` — write/update golden file

Set `UPDATE_GOLDENS=1` env var to regenerate golden files.

### E2E tests (`test/e2e/`)

Spawn a real server and drive it with the Puppeteer bridge:

```js
import { startServer, stopServer } from './helpers/server.js';
import { runBridge } from './helpers/bridge.js';

let port;
beforeAll(async () => { port = await startServer(); });
afterAll(async () => { await stopServer(); });

it('runs commands', async () => {
  const result = await runBridge(['--commands', JSON.stringify([...])], port);
  expect(result.code).toBe(0);
});
```

## Conventions

- Load test maps from `test/util/fixtures/`, not `examples/`
- Call `invalidateGeometryCache()` before `renderCells` when testing with different cell data in the same test
- Use `countNonTransparent(canvas)` pattern (check alpha channel) to verify render output without snapshots
- Render tests can take seconds — keep assertions focused, avoid unnecessary full-map renders
- Golden snapshots go in `test/snapshots/` — run `UPDATE_GOLDENS=1 npm run test:render` to regenerate after intentional visual changes
