# Mapwright Tools

CLI utilities for development and map generation.

## Automation

| Tool | Description | Usage |
|------|-------------|-------|
| `puppeteer-bridge.js` | Headless/headed browser automation for the editor API. Primary tool for programmatic map creation. | `node tools/puppeteer-bridge.js --commands '[...]' --screenshot out.png` |
| `generate_dungeon.js` | Map generation utility | `node tools/generate_dungeon.js` |

## Prop Management

| Tool | Description | Usage |
|------|-------------|-------|
| `validate-props.js` | Validate `.prop` files for syntax and bounds errors | `node tools/validate-props.js` |
| `resize-props.js` | Resize prop footprints (batch operation) | `node tools/resize-props.js` |
| `update-manifest.js` | Regenerate `src/props/manifest.json` from `.prop` files | `node tools/update-manifest.js` |

## Textures

| Tool | Description | Usage |
|------|-------------|-------|
| `download-textures.js` | Download Polyhaven textures to `src/textures/` | `node tools/download-textures.js --required` |
| `polyhaven/download-polyhaven.js` | Full Polyhaven texture downloader with filtering | `npm run download-textures` |

## Build & Packaging

| Tool | Description | Usage |
|------|-------------|-------|
| `patch-app-builder.cjs` | Patches electron-builder for Windows builds (runs as `postinstall`) | Automatic |
| `build-electron.bat` | Windows batch script for Electron builds | `tools/build-electron.bat` |
| `make-ico.js` | Generate `.ico` icon from source PNG | `node tools/make-ico.js` |

## Asset Generation

| Tool | Description | Usage |
|------|-------------|-------|
| `rock-patterns/` | Generate rock texture patterns for themes | See files in subdirectory |
