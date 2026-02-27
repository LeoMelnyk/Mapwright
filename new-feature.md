# Adding a New Feature to the Dungeon Tool

When adding a new feature, every layer of the pipeline needs to be considered. Not all features touch every layer, but you should consciously decide which layers apply and verify each one is covered before considering the feature complete.

## Checklist

### 1. Core: Does the feature work?

The rendering pipeline flows: `.map` file -> parser -> compiler -> JSON -> renderer -> PNG/SVG.

- [ ] **Data model** — Define how the feature is stored in the matrix JSON (cell-level property, metadata field, etc.)
- [ ] **Parser** (`src/compile/parse.js`) — If the feature is configurable from `.map` files, add a new section keyword or header field. Validate syntax and emit clear errors with line numbers.
- [ ] **Compiler** (`src/compile/compile.js`, `grid.js`, `features.js`, `trims.js`) — If the feature transforms parsed data into cell properties, add the compilation step. Wire it into `compileLevel()` at the right stage.
- [ ] **Renderer** (`src/render/render.js`, `floors.js`, `borders.js`, `features.js`, `decorations.js`) — Add visual rendering. Determine which render pass the feature belongs in (floor fill, border, feature overlay, decoration).
- [ ] **Themes** (`src/render/themes.js`) — If the feature introduces new colors, add properties to the theme object and update all existing theme presets.
- [ ] **Constants** (`src/compile/constants.js`, `src/render/constants.js`) — If new reserved characters or magic numbers are needed, add them to the appropriate constants file.
- [ ] **Validation** — Add error messages for invalid configurations. Use the `srcLine()` helper in parse.js for line-number references.
- [ ] **CLI entry points** (`build_map.js`, `compile_map.js`, `generate_dungeon.js`) — If the feature adds CLI flags, update argument parsing and usage text in all relevant entry points.
- [ ] **Examples** — Update or add example `.map` files in `examples/` that demonstrate the feature.
- [ ] **Documentation** — Update `guide.md` with syntax, valid values, rendering behavior, and any new validation errors.

### 2. Editor: Can users control this feature visually?

The editor is a browser-based WYSIWYG tool at `src/editor/`.

- [ ] **State** (`src/editor/js/state.js`) — If the feature needs UI state (e.g. a mode selector), add it to the state object with a sensible default.
- [ ] **Tool** (`src/editor/js/tools/`) — If the feature is a new interactive tool or a sub-mode of an existing tool, create or update the tool class. Follow the `Tool` base class pattern (onMouseDown/Move/Up, onActivate/Deactivate).
- [ ] **Tool sub-options** — If the feature adds modes to an existing tool (like paint sub-modes), add the button group to `index.html` and wire show/hide + active state in `toolbar.js`.
- [ ] **Toolbar** (`src/editor/js/panels/toolbar.js`) — Wire new buttons, mode selectors, or export actions.
- [ ] **Properties panel** (`src/editor/js/panels/properties.js`) — If the feature is a cell-level property, add it to the properties inspector so users can view/edit it on selected cells.
- [ ] **Metadata panel** (`src/editor/js/panels/metadata.js`) — If the feature is a map-level setting (like label style or theme), add a control to the metadata panel.
- [ ] **Canvas rendering** (`src/editor/js/canvas-view.js`) — If the feature affects rendering, pass any new parameters through to `renderCells()` / `renderDungeonToCanvas()`.
- [ ] **HTML** (`src/editor/index.html`) — Add any new UI elements (buttons, dropdowns, checkboxes).
- [ ] **CSS** (`src/editor/style.css`) — Style new UI elements if needed.
- [ ] **Keyboard shortcuts** — If the feature warrants a shortcut, add it to the key handler in `main.js`.

### 3. API: Can Claude control this feature programmatically?

The automation API allows Puppeteer-based control for AI-assisted map building.

- [ ] **Editor API** (`src/editor/js/editor-api.js`) — Add methods for the feature. Follow the existing pattern: validate inputs, `pushUndo()`, modify state, `markDirty()`, `notify()`, return `{ success: true }`.
- [ ] **Puppeteer bridge** (`puppeteer-bridge.js`) — The bridge is generic (calls any `editorAPI` method by name), so new API methods work automatically. But verify the feature works end-to-end through the bridge.
- [ ] **API documentation** (`src/editor/CLAUDE.md`) — Document the new methods with args, description, and usage examples. This is what Claude reads to know how to use the API.
- [ ] **`getMapInfo()`** — If the feature adds map-level metadata, include it in the `getMapInfo()` return value so callers can inspect it.
- [ ] **`getCellInfo()`** — Cell-level properties are automatically included (it returns a deep clone of the cell), but verify the new property is present.

## Layer Applicability by Feature Type

| Feature Type | Parser | Compiler | Renderer | Editor Tool | Editor Panel | API |
|---|---|---|---|---|---|---|
| New cell property (e.g. fill) | Yes (section) | Yes (apply to cells) | Yes (draw it) | Maybe (paint mode) | Yes (properties) | Yes (set/remove) |
| New metadata setting (e.g. label style) | Yes (header) | Pass-through | Yes (use it) | No | Yes (dropdown) | Yes (setter) |
| New decoration (e.g. compass) | Yes (header flag) | Pass-through | Yes (draw it) | No | Yes (checkbox) | Yes (setFeature) |
| New tool (e.g. eraser) | No | No | No | Yes (tool class) | Maybe | Yes (method) |
| New theme color | No | No | Yes (use it) | No | No | No |
| New export format | No | No | Maybe | Yes (button) | No | Maybe |

## Testing

- Build all example maps and verify no regressions: `for f in examples/*.map; do node build_map.js "$f"; done`
- Open the editor, test the feature manually with each tool/panel involved
- Run through the Puppeteer bridge: `node puppeteer-bridge.js --commands '[["newMethod", args...]]' --screenshot test.png`

## Reference Implementations

When adding a feature, study an existing feature of the same type:

| Feature Type | Reference | Files |
|---|---|---|
| Cell property | **Fills** (difficult-terrain, pit) | `compile/features.js` → `render/features.js` → `editor-api.js:setFill` |
| Metadata setting | **Label style** (circled, plain, bold) | `compile/parse.js` header → `render/decorations.js` → `editor-api.js:setLabelStyle` |
| Interactive tool | **Door tool** | `editor/js/tools/tool-door.js` → `editor-api.js:setDoor` |
| Decoration toggle | **Compass rose** | `render/borders.js:drawCompassRose()` → `editor-api.js:setFeature` |
| Asset catalog | **Props** | `src/props/*.prop` → `prop-catalog.js` → `tool-prop.js` → `render/props.js` |
| Bulk rect operation | **Fill rect** | `editor-api.js:setFillRect` pattern |
