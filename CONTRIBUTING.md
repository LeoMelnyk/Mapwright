# Contributing to Mapwright

Mapwright is a D&D dungeon map editor with a browser canvas UI, Node.js/Express server, Electron desktop wrapper, and a Puppeteer automation API for programmatic map generation.

## Getting Started

```bash
npm install
npm run dev          # starts API server + Vite dev server concurrently
```

Open `http://localhost:3000` in your browser. The API server runs on port 3000; Vite HMR runs on its own port and proxies API requests.

Other entry points:

```bash
npm start            # server only (no Vite HMR)
npm run electron     # desktop app via Electron
npm run build        # production Vite build
```

## Project Structure

```
src/
  editor/           # Browser editor: canvas, tools, panels, API modules
    js/api/         # Puppeteer automation API (one module per domain)
    js/tools/       # Interactive tools (room, wall, door, prop, light, etc.)
    js/panels/      # UI panels (toolbar, sidebar, properties, textures, etc.)
  render/           # Pure rendering: cells, walls, props, lighting, themes, export
  props/            # .prop file definitions (YAML header + draw commands)
  lights/           # Light preset catalog
  player/           # Player view (WebSocket client, fog-of-war)
  util/             # Grid math, geometry, shared helpers
  themes/           # Theme JSON files
server.js           # Express static server + WebSocket relay + PNG export
electron-main.cjs   # Electron main process
tools/              # CLI tools: Puppeteer bridge, texture downloader, etc.
test/               # Test files (unit, render, e2e, server)
```

## Code Style

### TypeScript Strict Mode

All code in `src/` is TypeScript with strict mode enabled. No `any` unless absolutely unavoidable (and never `eslint-disable` to hide it).

### Barrel Imports

Always import from the barrel `index.ts`, never from individual module files:

```typescript
// Good
import { renderCells, THEMES } from './render/index.js';
import { cellKey, floodFillRoom } from './util/index.js';

// Bad
import { renderCells } from './render/render-cells.js';
```

Exception: tool files may import `Tool` directly from `./tool-base.ts` to avoid circular deps.

Note: import paths use `.js` extensions even though source files are `.ts` (TypeScript ESM convention).

### State Mutation

All state changes follow this pattern:

```typescript
// Option A: manual
pushUndo();
state.dungeon.cells[row][col].fill = 'water';
markDirty();
notify();

// Option B: mutate() helper (auto-tracks changes)
mutate(() => {
  state.dungeon.cells[row][col].fill = 'water';
});
```

Never modify `state.dungeon` without `pushUndo()` first -- undo/redo depends on it.

### Linting

ESLint with typescript-eslint, flat config (`eslint.config.mjs`). No Prettier. Pre-commit hooks (husky + lint-staged) run `eslint --fix` and `tsc --noEmit` automatically.

```bash
npm run lint         # check
npm run lint:fix     # auto-fix
npm run typecheck    # tsc --noEmit
```

## Testing

Four test configurations:

```bash
npm test             # unit tests (vitest.config.js)
npm run test:render  # render/snapshot tests (vitest.render.config.js)
npm run test:server  # server API tests (vitest.server.config.js)
npm run test:e2e     # end-to-end Puppeteer tests (vitest.e2e.config.js)
npm run test:all     # unit + render + server (not e2e)
```

For e2e tests: kill any existing server on port 3000, then start a fresh one before running.

Run a single test file:

```bash
npx vitest run path/to/test.ts
```

## Adding Features

New features typically touch multiple layers. Before starting, read `CLAUDE.md` -- it has a full checklist covering:

1. **Data model** -- how the feature is stored in dungeon JSON
2. **Renderer** -- which render phase draws it
3. **Editor** -- tool class, panel UI, keyboard shortcuts
4. **API** -- automation method in `src/editor/js/api/`
5. **Tests** -- verify through Puppeteer bridge at minimum

Reference implementations for each feature type are listed in `CLAUDE.md` under "Reference Implementations."

## PR Process

Before opening a PR, verify all three pass:

```bash
npm run lint:strict  # zero warnings
npm run typecheck    # no type errors
npm test             # unit tests green
```

If your change affects rendering, also run `npm run test:render` and inspect any snapshot diffs.

Keep commits focused. One logical change per commit.
