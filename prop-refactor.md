# Prop System Refactor — Free-Form Placement

## Vision

Move props out of the cell grid and into a separate overlay layer. Props become "stickers" that can be placed at arbitrary positions, scaled, rotated freely, and overlapped with Z-order control.

## Current System

Props live inside `cell.prop = { type, span, facing, flipped }`:
- Locked to grid cells (one prop per cell, multi-cell via `span`)
- 4 rotation angles only (0, 90, 180, 270)
- No overlap allowed
- No scaling
- Z-order is implicit (render iteration order)

## Proposed System

Props stored in a separate array on metadata:
```json
{
  "metadata": {
    "props": [
      {
        "id": "prop_001",
        "type": "throne",
        "x": 42.5,         // world-feet (float, not grid-locked)
        "y": 17.3,
        "rotation": 135,   // degrees, any angle
        "scale": 1.0,      // 0.25 to 4.0
        "zIndex": 10,      // explicit layer ordering
        "flipped": false
      }
    ]
  }
}
```

### Key Changes

| Aspect | Current | Proposed |
|--------|---------|----------|
| Position | Grid cell (row, col) | World-feet (float x, y) |
| Rotation | 0/90/180/270 only | Any angle (degrees) |
| Scale | Fixed (footprint defines size) | Adjustable (0.25x to 4x) |
| Overlap | Forbidden | Allowed, Z-ordered |
| Storage | `cell.prop` | `metadata.props[]` |
| Collision | Hard block (cell occupied) | None (stickers layer) |

## AI Authoring Concern

**This is the biggest risk.** The current grid-locked system is easy for AI to reason about:
- "Place a throne at row 5, col 8" — unambiguous
- `getValidPropPositions` returns exact valid cells
- Spatial queries like `fillWallWithProps` work because positions are discrete

Free-form placement makes AI authoring harder:
- "Place a throne at x=42.5, y=17.3" — how does AI know this is good?
- Overlap detection becomes geometric (bounding box intersection)
- Alignment and spacing become subjective

### Mitigation Strategies (Priority Order)

1. **Grid-relative coordinates (default, most critical):** `placeProp(row, col, propType, facing)` signature is preserved exactly. The API converts grid coords to world-feet internally (`x = col * gridSize, y = row * gridSize`). AI never needs to think in world-feet unless explicitly opting in via `options.x, options.y`. This makes the refactor invisible to existing AI workflows.

2. **Smart placement helpers stay working:** All existing helpers that abstract away coordinates continue to work:
   - `getValidPropPositions` — returns valid anchor cells (grid-relative), conversion is internal
   - `fillWallWithProps` — still works, outputs world-feet positions internally
   - `scatterProps` / `clusterProps` / `lineProps` — calculate positions, output world-feet internally
   - **NEW:** `suggestPropPosition(roomLabel, propType)` — uses prop `placement` metadata (wall/center/corner/floor) to compute a semantically correct position. Returns `{ x, y, rotation, row, col }` (both coordinate systems). This is the big new AI helper — "put a throne in this room, facing the door" becomes a single call.

3. **Z-order presets:** Instead of raw numbers, use semantic layer names:
   - `"floor"` (z=0) — carpets, rugs, floor markings
   - `"furniture"` (z=10) — tables, chairs, beds
   - `"tall"` (z=20) — bookshelves, pillars, statues
   - `"hanging"` (z=30) — chandeliers, banners, hanging cages

4. **Collision warnings, not failures:** Overlap is opt-in. Default behavior still prevents overlap (backward compat for AI). When `{ allowOverlap: true }` is passed, overlapping props return `{ success: true, warnings: ["overlaps with prop_003"] }` instead of throwing. This lets AI intentionally stack props (book on desk, rug under furniture) without fear.

5. **Snap-to-grid default:** Props snap to grid cell origins by default. Free-form (sub-cell) placement is opt-in via `{ snap: false }`. Combined with strategy 1, this means AI-placed props land exactly where grid-locked props would have.

## Migration Path

1. **Phase 1: Dual storage** — Support both `cell.prop` (legacy) and `metadata.props[]` (new). Render both. Existing maps still work.
2. **Phase 2: Migration tool** — Convert `cell.prop` entries to `metadata.props[]` with grid-center positions.
3. **Phase 3: Remove cell.prop** — All props live in the overlay. Cell.prop is no longer read.

## Editor UI Changes

- **Prop tool:** Click to place, drag to move, scroll-wheel to rotate, Shift+scroll to scale
- **Properties panel:** Shows position, rotation, scale, Z-layer for selected prop
- **Z-order controls:** Bring forward / send backward buttons
- **Multi-select:** Select multiple props, move/rotate/scale as group

## Rendering Changes

- Sort `metadata.props[]` by `zIndex` before rendering
- Render props in a separate pass (after floor/walls/fills, before lighting)
- Rotation: full matrix transform (not just 4-way swap)
- Scale: multiply footprint dimensions by scale factor
- Bounding box: compute from rotated + scaled footprint for click detection

## Light-Blocking Props

Props with `blocksLight: true` currently contribute wall segments to the lighting engine via `extractPropLightSegments()`. With free-form placement:
- Light segments must be computed from the prop's actual rotated/scaled bounding box
- This is geometrically more complex but well-defined

## Resolved Questions

- **Wall snapping?** Yes — props with `placement: wall` snap to the nearest wall edge when dragged near one. Ctrl overrides to free placement.
- **Lock toggle?** Deferred — not needed for initial release. Can add later if accidental movement becomes a problem.
- **Format version bump?** Yes, auto-migrate on load. `formatVersion` goes from 1 → 2. Migration scans all `cell.prop` entries, creates `metadata.props[]` entries, and deletes `cell.prop`. Old files open seamlessly.
- **Scale affect light radius?** Yes — linked lights scale proportionally with the prop. A 2x brazier emits a 2x radius light.
