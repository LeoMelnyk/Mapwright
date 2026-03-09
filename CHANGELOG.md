# Changelog

## v0.4.1

### New: MCP Server (`mcp/`)

Added a Model Context Protocol server that exposes the full Mapwright editor API to Claude Code and other MCP clients.

**Install:**
```bash
cd mcp && node install.js
```

**Tools:**

| Tool | Requires server? | Description |
|---|---|---|
| `execute_commands` | Yes | Run any editor API command via the Puppeteer bridge |
| `build_map` | No | Compile a `.map` text file to PNG |
| `render_json` | No | Render a dungeon `.json` to PNG |
| `check_server` | No | Health-check the editor server |

**Resources (auto-loaded into AI context):**

| Resource | Contents |
|---|---|
| `mapwright://editor-api` | Full ~70-method API reference |
| `mapwright://map-format` | `.map` text format syntax reference |
| `mapwright://workflow` | 3-step AI generation workflow |
| `mapwright://domain-routing` | Codebase architecture guide |

### Bug Fix

**Light options sub-bar visible in wrong state** — The light tool options strip was not being hidden when switching to session tools or changing away from the light tool. Fixed in `toolbar.js`.

---

## v0.4.0

### Background Image Overlay

- New side panel: upload/replace/clear a background image, set scale (px/cell), X/Y offset, opacity, and resize the dungeon to match
- Drag-to-measure tool lets you drag across grid squares on the uploaded image to auto-calculate px/cell scale
- Grid calculator: enter rows × cols to compute canvas size from the detected scale
- Center button + auto-fill floor cells under the image on upload, measure, and calc
- Background image visible in player view and PNG export
- Auto-detect grid scale and phase on upload: gradient autocorrelation detects pixels-per-cell and aligns the editor grid to image grid lines

### DM Session

- New fog reveal drag tool (key `3`): DM can click-and-drag a rectangle to reveal cells to connected players; fog overlay is forced on while active; revealed cells fade in over 500ms

---

## v0.3.1

### Lava Lighting Improvements

- Lava pools now auto-generate lights using a flood-fill algorithm that detects connected lava regions and places lights on an adaptive grid (spacing scales with pool area) — prevents brightness explosions on large pools
- Lava glow uses `radius:0 / dimRadius:4` for a pure ambient halo with no visible hotspot circle
- Added Light Color and Light Strength controls to the custom theme editor's Lava section
- Fixed divide-by-zero NaN in `falloffMultiplier` when `radius <= 0`

### Prop Fixes

- Audited `blocks_light` flags across all props: removed from 18 props that aren't floor-to-ceiling (altars, boulders, statues, etc.), kept on tall/structural props only
- Redesigned vault door from a 2×2 ground-hatch to a 1×2 top-down door with flanking pillar lock columns, locking bolts, and a center valve wheel

### Bug Fix

- **Right-click always triggering delete** — `rightDragged` was reset before the guard check, so delete fired even after a pan-drag. Fixed by capturing the flag before resetting.

---

## v0.3.0

### Ollama AI Integration

- Replaced Anthropic Claude API with local [Ollama](https://ollama.com) (Qwen3.5:9b) — no API key required
- AI now writes a plan before executing (plan mode), with an Execute Plan button to confirm
- Streaming text bubble UI with live cursor animation
- Strips Qwen3 `<think>` reasoning blocks from responses

### `.map` Workflow for AI

- `loadMapText` / `exportMapText` as the primary AI dungeon workflow — build or replace full dungeons from `.map` text in a single call
- New `/api/compile-map` server endpoint for AI-generated `.map` compilation

### Expanded AI Tool Surface

15+ new tools added including:
- Prop/stair removal
- Lighting controls: `getLights`, `removeLight`, `setAmbientLight`, `setLightingEnabled`, `listLightPresets`
- Level management: `getLevels`, `addLevel`, `renameLevel`, `resizeLevel`
- Spatial utilities: `findCellByLabel`, `shiftCells`, `listRooms`, `placeLightInRoom`
- `listThemes`, `setLabelStyle`

---

## v0.2.1

### Claude AI Dungeon Assistant

- Embedded Claude AI chat panel: describe a dungeon in natural language and have Claude build or modify it directly via tool calls against the Editor API
- Full read/write access: create rooms, corridors, set properties, change themes, inspect state
- Server-side Anthropic proxy endpoint keeps the API key off the client
- Streaming-style message UI with tool-call status display and stop/retry controls
- Warning modal shown when enabling the AI agent

---

## v0.2.0

### Editor UX

- Props, bridges, labels, and lights support hover-to-highlight and drag-to-move without switching modes; removed legacy place/select mode toggles
- Box-select on empty drag selects multiple props; all selected props move together
- All tools show contextual status bar instructions
- Toolbar update notification badge when a newer GitHub release is available

### DM Session

- Fog overlay toggle visualizes which cells are unrevealed to players
- Invisible walls (`iw` type): block movement but hidden from the player view

### Infrastructure

- ESLint flat config
- GitHub Actions CI workflow (blocks PRs on lint failure)
- Azure Trusted Signing for Windows builds
- Electron desktop app with bundled texture downloader
- Auto-install Node.js if missing
- Release build workflow: auto-build and attach portable `.exe` on publish
- Universal Mac DMG (arm64 + x64) for Intel and Apple Silicon

### Lighting System

- Animated lights: flicker, pulse, strobe
- D&D 5e bright/dim light radii with unified gradient
- Inverse-square falloff option
- Colored ambient light
- Prop-bundled lights: placing a torch/candle/etc. auto-creates a linked light; erasing the prop removes the light
- Light names/labels in the lighting panel
- Shift+click snap-to-grid placement
- Dim radius overlay circle in editor

### Map Format

- Bridge support in `.map` format (`wood`, `stone`, `rope`, `dock` types)
- Invisible walls and doors for fog-of-war segmentation
- `mapwright/CLAUDE.md` — domain routing table and full dev guide
- `src/editor/CLAUDE.md` — Puppeteer automation API reference

---

## v0.1.0 — Initial Release

- Dungeon map editor with room, wall, door, stairs, trim, fill, prop, label, and light tools
- 16 themes
- `.map` ASCII text format with compile pipeline (`.map` → JSON → PNG)
- Puppeteer automation bridge for programmatic map generation
- Player session view with WebSocket fog-of-war reveal
- Polyhaven texture support with download tooling
- Prop catalog with 100+ props across 15 categories
