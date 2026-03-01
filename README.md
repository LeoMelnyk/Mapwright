# Mapwright

A dungeon map editor built for AI-assisted map generation. Describe a dungeon to Claude and get a finished, themed map — or draw it yourself in the browser-based visual editor.

![Example dungeon map](examples/island.png)

---

## AI Map Generation

Mapwright is designed from the ground up to be driven by AI. Claude can generate complete, detailed dungeon maps without any manual GUI work:

1. **Write a `.map` file** from a natural language description — a plain-text format that's easy for both humans and AI to author
2. **Compile to PNG** via `tools/build_map.js` — renders the map to a print-ready image
3. **Control the visual editor** via the Puppeteer bridge — load maps, issue editor commands, take screenshots, and save programmatically

```bash
# Compile a .map file to PNG
node tools/build_map.js my-dungeon.map

# Control the editor headlessly (load, command, screenshot, save)
node tools/puppeteer-bridge.js --load map.json --screenshot output.png
```

Full AI editor API reference: [`src/editor/CLAUDE.md`](src/editor/CLAUDE.md)

---

## Features

- **AI-driven generation** — full Puppeteer bridge and text-based `.map` format for programmatic map creation
- **`.map` text format** — describe dungeons in plain ASCII, compile to PNG or SVG
- **Browser-based visual editor** — draw rooms, place doors, add furniture and lights, undo/redo
- **16 themes** — stone dungeon, ice cave, underdark, volcanic, arcane, alien, and more
- **Hundreds of props** — furniture, containers, nautical items, arcane objects, structural elements
- **Multi-level dungeons** — towers, multi-floor buildings, stacked cave systems in one file
- **Doors & secret doors** — single, double, and secret doors with auto-detection
- **Diagonal & curved walls** — trim room corners with straight diagonals or quarter-circle arcs
- **Stairs** — up/down stair icons with cross-level linking and reachability validation
- **Fills** — pit, difficult terrain, and water fills with shallow/medium/deep depth rendering
- **Point light system** — per-light color, radius, intensity, and falloff
- **Per-cell textures** — 700+ free CC0 textures from [Polyhaven](https://polyhaven.com), downloadable on demand
- **Invisible walls** — walls visible in the editor but hidden from players, for blocking movement without revealing layout
- **Watch mode** — auto-rebuild on save for fast iteration
- **DM player view** — real-time fog-of-war session mode via WebSocket, with a DM fog overlay to visualize unrevealed cells
- **Import** — load maps from Donjon and OpenDungeonPlanner

---

## Getting Started

### Windows — Desktop App

Download `Mapwright.exe` from the [Releases page](https://github.com/LeoMelnyk/Mapwright/releases) and run it. No installation required.

On first launch, a texture downloader opens automatically. Download textures once and they persist across sessions.

### Mac — Desktop App

Download `Mapwright.dmg` from the [Releases page](https://github.com/LeoMelnyk/Mapwright/releases). The app is unsigned — on first launch, right-click the app and choose **Open** to bypass Gatekeeper.

### Windows / Mac — From Source

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/LeoMelnyk/Mapwright.git
cd Mapwright
npm install
npm start          # starts the server
```

Then open **http://localhost:3000/editor/** in your browser. Press `Ctrl+C` to stop.

On Windows you can also run `npm run electron` to open the app in a desktop window instead of a browser tab.

### Textures (Optional)

Textures are not included in the repo. The editor works without them — textures only affect the per-cell texture painting feature and prop rendering.

```bash
node tools/download-textures.js --required   # only textures used by built-in props
node tools/download-textures.js --all        # full Polyhaven library (700+, free CC0)
node tools/download-textures.js --check      # check what's missing, no download
```

In the desktop app, textures are downloaded through the built-in downloader and stored in your user data folder.

---

## Two Ways to Make Maps

### 1. Write a `.map` File

Describe your dungeon in a plain text file:

```
---
name: The Forgotten Crypt
theme: stone-dungeon
compassRose: true
scale: true
border: true
---

....AAA....
....AAA....
...BBBBB...
...BBBBB...
CCCBBBBBDDD
CCCBBBBBDDD
CCCEEEEEDDD
...EEEEE...
...EEEEE...

legend:
  A: A1
  B: A2
  C: A3
  D: A4
  E: A5

doors:
  3,4 east: door
  7,4 west: door
  3,6 east: door
  7,6 west: door
  4,2 south: door
```

Build it:

```bash
node tools/build_map.js my-dungeon.map
```

Outputs `my-dungeon.json` and `my-dungeon.png`. Use `--svg` for vector output, `--watch` to auto-rebuild on save.

### 2. Use the Visual Editor

Start the server (`npm start`) and open **http://localhost:3000/editor/**.

The editor has 14 tools: **Room, Paint, Wall, Door, Label, Stairs, Trim, Select, Prop, Light, Fill, Erase, Range, Bridge** — with full undo/redo, pan/zoom, and multi-level support. Hover over any placed object (prop, light, bridge, label) to select it; drag to move it. Maps save and load as JSON and can be exported back to `.map` format.

---

## Themes

| Theme | Best For |
|---|---|
| `stone-dungeon` | Crypts, tombs, underground fortresses |
| `crypt` | Dark stone crypts, undead lairs |
| `earth-cave` | Natural caves, mines, burrows |
| `ice-cave` | Frozen environments, winter dungeons |
| `water-temple` | Aquatic environments, flooded ruins |
| `underdark` | Deep underground, Underdark passages |
| `volcanic` | Lava caves, fire-themed dungeons |
| `swamp` | Bog ruins, murky environments |
| `desert` | Arid ruins, sand-buried dungeons |
| `dirt` | Earthen burrows, rough tunnels |
| `grasslands` | Outdoor overworld, surface maps |
| `snow-tundra` | Arctic overworld, frozen wastes |
| `arcane` | Wizard towers, magical environments |
| `alien` | Sci-fi, aberrant, Far Realm |
| `blue-parchment` | Clean architectural style, general purpose |
| `sepia-parchment` | Aged/historical feel, classic module aesthetic |

Individual colors can be overridden with `themeOverrides` in the `.map` header.

---

## Examples

A reference map is in [`examples/`](examples/):

| Example | Description |
|---|---|
| `island` | Coastal island encounter — water fills, rounded trims, 40+ props, lights, per-cell textures |
| `mines` | Underground mine complex — organic cave shapes, diagonal fill bands, burial chamber dressing |

Build one:

```bash
node tools/build_map.js examples/island.map
node tools/build_map.js examples/mines.map
```

Or render a pre-compiled JSON directly:

```bash
node tools/generate_dungeon.js examples/island.json
```

See [examples/examples.md](examples/examples.md) for a full feature breakdown of each map.

---

## Documentation

Full reference for the `.map` format, all options, validation errors, and CLI flags: **[CLAUDE.md — Map Format Reference](CLAUDE.md)**

Topics covered:
- Complete `.map` file format (header, grid, legend, doors, trims, stairs, fills, props)
- All 16 theme names and color properties
- Room sizing for combat encounters
- Room numbering conventions
- Multi-level dungeon syntax
- Compiler validation errors and common mistakes

---

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- Windows (the `.exe` target is Windows-only; the dev server runs on any platform)

### Setup

```bash
git clone https://github.com/LeoMelnyk/Mapwright.git
cd Mapwright
npm install
```

### Run without building

```bash
npm run electron
```

Starts the Express server and opens the Electron window directly from source. Frontend changes (HTML/CSS/JS) take effect on Ctrl+R. Server changes (`server.js`, `electron-main.cjs`) require restarting.

### Build the desktop app

```bash
npm run electron:build        # Windows portable exe → dist/Mapwright <version>.exe
npm run electron:build:mac    # Mac DMG → dist/Mapwright-<version>-arm64.dmg
```

The Windows build is a single self-contained portable executable, no installation required.

`npm install` automatically patches a bundled tool to handle a Windows symlink limitation. If the Windows build fails with `Cannot create symbolic link`, enable **Developer Mode** in Settings → System → For Developers and re-run.

The Mac build is unsigned — users will need to right-click → Open to bypass Gatekeeper on first launch.
