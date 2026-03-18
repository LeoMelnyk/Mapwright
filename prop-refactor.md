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

### Mitigation Strategies

1. **Snap-to-grid mode (default for API):** AI places props at grid centers by default. Free-form is opt-in via `{ snap: false }`.

2. **Smart placement helpers:** Keep high-level helpers that return good positions:
   - `suggestPropPosition(roomLabel, propType)` — returns centered/wall-aligned position
   - `fillWallWithProps` — still works, outputs world-feet positions
   - `scatterProps` / `clusterProps` — calculate positions, output world-feet

3. **Grid-relative coordinates:** API accepts `{ row: 5, col: 8 }` and converts to world-feet internally. AI never needs to think in world-feet unless doing fine-tuning.

4. **Z-order presets:** Instead of raw numbers, use semantic layers:
   - `"floor"` (z=0) — carpets, rugs, floor markings
   - `"furniture"` (z=10) — tables, chairs, beds
   - `"tall"` (z=20) — bookshelves, pillars, statues
   - `"hanging"` (z=30) — chandeliers, banners, hanging cages

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

## Open Questions

- Should props snap to walls when dragged near them? (wall-mounted props like sconces, banners)
- Should there be a "lock" toggle to prevent accidental movement?
- How do we handle the `formatVersion` bump? Auto-migrate on load?
- Should scale affect light radius for light-emitting props (braziers, torches)?
