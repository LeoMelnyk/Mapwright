# Mapwright Test Guide

## Test Suites

Four tiers, each with its own Vitest config:

| Suite | Command | Config | Setup | Timeout |
|-------|---------|--------|-------|---------|
| **Unit/API** | `npm test` | `vitest.config.js` | `test/setup.ts` | 10s |
| **Render** | `npm run test:render` | `vitest.render.config.js` | `test/render/setup-render.js` | 120s |
| **Server** | `npm run test:server` | `vitest.server.config.js` | none | (suite default) |
| **E2E** | `npm run test:e2e` | `vitest.e2e.config.js` | none (tests manage server) | 60s |

`npm run test:all` runs unit + render + server. `npm run test:watch` runs unit in watch mode. `npm run test:coverage` reports v8 coverage on `src/**/*.ts`.

Run a single file: `node node_modules/vitest/vitest.mjs run --config <config> <path>`.

## Directory Structure

```
test/
  setup.ts                    — Global mocks (DOM, localStorage, editor modules)
  api/                        — Editor API unit tests (~33 files, one per api/ module)
  migrations/                 — Legacy → segment-model migration tests
  util/                       — Utility function tests (cell-segments, traverse, trim-geometry, polygon, grid, range-geometry)
    fixtures/                 — Test map files (.mapwright, .json)
  render/                     — Visual render tests (real canvas via @napi-rs/canvas)
    setup-render.js           — Canvas polyfills + theme registry loading
  e2e/                        — End-to-end (server + Puppeteer bridge)
    helpers/                  — server.js, bridge.js
    output/                   — E2E run artifacts (screenshots, saved maps)
  fog.test.ts, state.test.ts, …  — Cross-cutting tests at the test/ root
```

There's no `test/snapshots/` directory in the repo currently — render tests verify pixel patterns (alpha-channel counts, specific cell tints) rather than golden PNG diffs. If you add a snapshot helper, document the regeneration command here.

## Test Fixtures

Map files for tests live in `test/util/fixtures/`. Currently shipped:

- `island.mapwright` — outdoor island map (grasslands theme, multiple rooms)
- `circular-room-seed.json`, `circular-room-inside-fog.json`, `circular-room-outside-fog.json` — circular-room fog regression
- `fog-after-island.json` — fog state snapshot
- `open-trim-room.json` / `open-trim-room-expected.json` / `open-trim-room-expected-center.json` — open-trim regression
- `open-trim-multi-room.json` / `open-trim-multi-room-expected.json` — multi-room open-trim regression

## Setup Files

### `test/setup.ts` (unit/API tests)

Mocks browser APIs (`document`, `window`, `localStorage`, `requestAnimationFrame`) and editor modules that depend on the browser (`canvas-view`, `panels`, `io`, `tools`, `render/index`). Tests run in pure Node.js with no DOM.

### `test/render/setup-render.js` (render tests)

Provides real canvas via `@napi-rs/canvas` — **not** a mock. `document.createElement('canvas')` returns a real native canvas with working `getContext('2d')`, `Path2D`, `ImageData`. Also loads all `.theme` files from `src/themes/` into the `THEMES` registry.

Does **not** mock the render pipeline — `renderCells`, `renderDungeonToCanvas`, etc. all run for real.

## Writing Tests

### Unit/API tests (`test/api/`, `test/util/`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';

describe('myFeature', () => {
  beforeEach(() => {
    state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  });
  it('does something', () => { /* … */ });
});
```

Source files use TypeScript; tests use `.ts` and import via `.js` extensions (the standard NodeNext convention).

### Render tests (`test/render/`)

Use real canvas — call `renderCells`, `renderDungeonToCanvas`, etc. directly. Import from the barrel (`src/render/index.js`) or directly from source files.

```ts
import { createCanvas } from '@napi-rs/canvas';
import { drawHatching, THEMES } from '../../src/render/index.js';

it('renders hatching', () => {
  const canvas = createCanvas(500, 500);
  const ctx = canvas.getContext('2d');
  drawHatching(ctx, cells, roomCells, gridSize, theme, transform);
  // Verify with ctx.getImageData()
});
```

Common verification pattern: count non-transparent pixels (`countNonTransparent(canvas)`) or sample specific cell tints. Render tests are slow (seconds per case) — keep assertions focused; avoid unnecessary full-map renders.

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

E2E suite runs serially (`maxConcurrency: 1`) because the server is shared. Always kill any port-3000 process before running E2E — see [feedback_e2e_server](../../C:/Users/leonk/.claude/projects/c--Users-leonk-OneDrive-Documents-Projects-D-D/memory/feedback_e2e_server.md).

## Conventions

- Load test maps from `test/util/fixtures/`, not `examples/`.
- Call `invalidateGeometryCache()` before `renderCells` when testing with different cell data in the same test.
- Tests assume previous changes left them passing — see [feedback_tests_pass](../../C:/Users/leonk/.claude/projects/c--Users-leonk-OneDrive-Documents-Projects-D-D/memory/feedback_tests_pass.md). If a test fails after your edits, you broke it.
- Lint runs on changed files only via lint-staged; full lint isn't duplicated by render tests. See [feedback_precommit_thoroughness](../../C:/Users/leonk/.claude/projects/c--Users-leonk-OneDrive-Documents-Projects-D-D/memory/feedback_precommit_thoroughness.md).
