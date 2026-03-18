# Future Features

Ideas that are interesting but not currently prioritized. Revisit as the project evolves.

## Collaborative Editing

Real-time multi-user map editing via WebSocket (extending the existing DM-player session infrastructure). Two DMs could work on the same map simultaneously with cursor presence and conflict resolution.

**Why not now:** The current session system is one-directional (DM → player). True collaborative editing needs OT/CRDT for conflict resolution, which is a significant architecture change. Not needed for the current single-DM workflow.

## Random Dungeon Generation

Procedural generation of dungeon layouts from parameters (room count, theme, difficulty, connectivity style). The algorithm would need to produce varied, interesting layouts — not just random room grids.

**Why not now:** A naive algorithm produces boring, samey dungeons. This needs a genuinely good generation algorithm with variety in room shapes, connectivity patterns, and spatial storytelling. The current `planBrief` API handles semantic layout from descriptions, which produces better results than random generation for most use cases.

**When to revisit:** If we find a generation algorithm that produces layouts as varied and interesting as hand-designed ones. Consider BSP trees with post-processing, wave function collapse, or graph-grammar approaches.

## VTT Export (Foundry VTT / Roll20)

Export maps to Virtual Tabletop formats:
- **Foundry VTT:** Walls, doors, lights, and tokens as Foundry scene JSON
- **Roll20:** Universal VTT format (`.dd2vtt`) with wall/door/light data
- **Dungeondraft:** `.dungeondraft_map` format for interoperability

**Why not now:** Need sample JSON files from these systems to understand their data models and assess feasibility. Wall/door/light data maps conceptually, but coordinate systems and feature sets may differ significantly.

**Next step:** Obtain example Foundry VTT scene JSON and Roll20 `.dd2vtt` files to evaluate mapping complexity.

## Encounter / Room Annotations

Attach DM-only metadata to rooms beyond labels: encounter data, notes, triggers, loot tables. Could extend the existing `center` object with a `notes` field, or create a separate annotation layer.

**Current workaround:** DM labels (`dmLabel`) can hold short text. For full encounter data, DMs reference their adventure document alongside the map.

**Possible approach:** Add `center.notes` field (free text, DM-only, shown in sidebar when room is selected). Keep it simple — Mapwright is a map tool, not a full adventure management system.

## Import from Other Formats

Import maps from Dungeondraft, Foundry VTT, or other mapping tools. Would dramatically help adoption but requires reverse-engineering each format.

**Blocked on:** Obtaining sample files and understanding the data models of each source format.
