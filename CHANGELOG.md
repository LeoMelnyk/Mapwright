# Changelog

## v0.12.0

### Prop Panel

- **Thumbnail size toggle** — three new buttons at the top of the prop panel switch between 3-per-row (default), 2-per-row, and 1-per-row (full-width) layouts, so you can preview prop artwork at glance-sized or hero-sized without leaving the panel. The setting persists across sessions, and thumbnails re-render at a higher internal resolution at larger sizes so they stay crisp instead of pixelating.
- **Secondary toolbar row** — the Collapse All / Expand All buttons have moved out of the search bar onto a dedicated toolbar row alongside the new size toggle, giving the search input the full width of the panel.
- **Canvas interactions stay fast with the prop panel open** — the panel used to drag down pan/zoom and other canvas work because the browser had to re-evaluate layout for all ~1400 prop thumbnails every time the mouse moved, even though only a few were visible. Offscreen category grids are now culled from layout, style, and paint until they scroll into view, so panning the map with the panel open is roughly as snappy as with it closed.

### Windows

- **New Window tool** — dedicated edge-placement tool (keyboard W) for adding windows to walls. Click an edge to place, click again with the same gobo to remove, click again with a different gobo to swap, right-click to remove. Works on both cardinal (north/south/east/west) and diagonal (nw-se / ne-sw) edges. Shows the same yellow edge-highlight ghost as the wall and door tools when you hover.
- **Gobo dropdown in the toolbar** — a sub-toolbar dropdown lets you pick which gobo pattern new windows use. Switch freely between window styles per placement so you can mix a leaded-glass entry hall with a portcullised dungeon block on the same map.
- **Fourteen built-in window gobos** — arrow-slit, ceiling-grate, cruciform, diamond-lattice, double-hung, horizontal-clerestory, horizontal-slats, leaded-grid, narrow-casement, portcullis-window, rose-window, tall-lancet, vertical-bars, window-mullions. Covers castle arrow loops, cathedral lancets, leaded diamond panes, modern casements, and everything between. Two new pattern renderers ship alongside — `diamond` (leaded lattice) and `cross` (Latin crucifix arrow loop) — both fully procedural, no texture assets.
- **Plain "no-gobo" window option** — a new "None (plain sunpool)" entry sits at the top of the gobo dropdown (both the Window toolbar and the per-window edit popover). Windows placed with this option still block light on the floor and still admit a sunpool through the aperture, but no tracery pattern overlays it — use for open windows, broken panes, or clear modern glass where mullion shadows would look wrong.
- **Adjacent windows merge visually** — a run of neighboring window edges along the same wall draws as one continuous wide window (unbroken wall line, single sill/lintel pair, mullion ticks at each cell boundary). Cathedral-length windows and multi-cell barracks rows just work. Same for diagonal runs along a peaked roof slope.
- **Adjacent same-gobo windows merge their light projection** — a run of 3 adjacent windows with the same gobo projects as a single 15 ft continuous sunpool with the pattern tiling seamlessly across, instead of three independent 5 ft sunpools with restart seams. Mixed-gobo runs still project separately (two different window styles look like two different windows).
- **Windows block light like walls, except through the aperture** — the wall under a window still casts a full shadow on the floor, so a dimly-lit corridor outside a lit room stays dim. Light only reaches the far side through the window's aperture (4 ft to 6 ft above floor by default), producing a patterned "sunpool" carved out by the chosen gobo. The sunpool fades past the light's radius as a smooth arc — no chord-clipping, no flat edge.
- **Height-aware aperture physics** — the sunpool's near and far edges both depend on the light's z-height. A high torch (z=20) above a narrow window produces a thin sliver right under the window; a candle at aperture height (z=5) spills light freely through in a wide fan. A light below the aperture (z=3) throws no light through the window at all.
- **Walls past the window still block** — if a window opens onto a corridor that has its own walls, the sunpool stops at those further walls instead of leaking through. Computed via a second per-light visibility polygon that treats windows as open, intersected with the aperture's angular fan.
- **Animated lights project through windows** — flicker / pulse / strobe / strike lights all correctly cast sunpools through windows (with and without mullion shadows), matching static lights exactly. The bake cache path now carries the aperture-visibility clip through, so window-adjacent torches don't leak light into rooms beyond.
- **Per-window edit popover** — with the Window tool active, every placed window shows a small stained-glass icon at the middle of its edge. Click the icon to open a popover that edits that specific window's gobo without changing the toolbar default, and pick a tint color for the light that will shine through (stained-glass / mosaic effects). Icons are only drawn while the Window tool is active so they stay out of the way, and the icon hit-test runs before placement so clicking one never drops an extra window on top. Light tinting through the pane is wired up under the hood; the projected color change follows in the next update.
- **`setWindow` / `removeWindow` API** — programmatic window placement from the Puppeteer bridge. `setWindow(row, col, direction, goboId)` accepts cardinal *or* diagonal direction; `removeWindow(row, col, direction)` reverts the edge to a plain wall and drops the metadata entry.

### Weather

- **Weather panel** — new right-sidebar panel lets you create named weather groups and paint cells into them. Each group is its own localized storm — rain in the courtyard, fog in the crypt, ash falling on the volcanic outskirts — with its own type, intensity, wind, haze, and lightning. A single map can run several groups at once.
- **Eight weather types** — Rain, Snow, Ash, Embers, Sandstorm, Fog, Leaves, and Cloudy. Each has its own top-down particle behavior, default color, and motion characteristics. Pick any type per group and tweak from there. Cloudy is the outlier — instead of per-cell particles it drifts a handful of soft shadow sprites across the region, reading as fog tendrils or overcast patches at ground level, with a built-in intensity floor so the slider never looks empty.
- **Top-down rain as ripples** — falling raindrops from above look like expanding ripples on the ground, not diagonal streaks (which are a side-view convention). Each cell has several drops landing at seeded positions and periods; each ripple grows and fades, staggered so the whole storm looks organic instead of pulsing in unison.
- **Particles flow instead of teleporting** — snow drifts, ash settles, embers rise, sandstorm streaks rip horizontally, fog wisps crawl, leaves tumble. Every particle traverses its cell edge-to-edge and is replaced by the next one entering behind it, so nothing disappears at cell boundaries. Wind direction and strength tilt the motion and scale the speed.
- **Painting matches the paint tool** — click or drag a marquee to assign cells to the selected group; right-click or right-drag to clear cells from it. Shift+click flood-fills a whole connected room (respects walls, doors, diagonals, arc trims — same BFS the paint tool uses); shift+right-click flood-clears the connected area.
- **Per-group haze density** — a translucent wash over every weather cell. For Fog this *is* the density slider; for other types it adds atmosphere (dusty cellar, smoky forge) without needing a separate fog group on top.
- **Particle color override** — every type has a sensible default (pale blue rain, white snow, orange embers, etc.), but each group can override the particle/haze color for red ash, green embers, or whatever the vibe calls for. Hit **Auto** to revert to the type default.
- **Lightning as a real shadow-casting light** — enable lightning on a group and strikes spawn transient point lights inside the group's cells. The existing lighting engine handles the rest: walls cast penumbra shadows, props occlude the flash, distance falloff works the same as any other light. Strikes originate from overhead (z = 10 ft, so short props don't shadow them) with a large soft-shadow radius for the wide diffuse feel of a sky bolt.
- **Lightning frequency, intensity, and flash color** — three sliders control strikes per window, peak brightness, and flash tint (default pale blue-white). Strikes only fire inside cells with no walls / doors / diagonals on any edge, so the bolt never originates *inside* a wall and leaks light across. If a group has no eligible cells the strike is silently skipped — no crash, just no flash for that window.
- **Lightning requires map-wide lighting** — since the flash rides the lighting pipeline. The Lightning checkbox disables with a tooltip whenever lighting is turned off; existing configuration is preserved so turning lighting back on resumes strikes.
- **Show weather groups overlay** — toggle at the top of the Weather panel tints each group's cells in an auto-assigned color with a thin border around each contiguous region, so you can see group membership while painting. Panel-specific — disappears when you switch to a different right-sidebar tab.
- **Toolbar lock-in during cell assignment** — while a group is selected the main toolbar dims so you can't paint a wall or drop a prop while assigning weather cells. Click the group again, press Esc, or switch right panels to release. Middle-mouse-drag still pans the canvas.
- **Middle-mouse pan** — added a global middle-click pan binding so panning still works when the Weather tool has right-drag claimed for delete-marquee.
- **Weather layer has its own cache** — the haze wash renders once at map resolution into a dedicated offscreen canvas and blits per frame. Pan and zoom cost one `drawImage`. Config tweaks invalidate only the weather cache — the expensive cells / walls / props cache stays put. Cell paints rebuild just the bbox of touched cells, not the full weather canvas.
- **Animated particles don't cache** — because they move. Rendered per-frame on top of the cached haze, clipped per cell, with a new `Weather (particles)` diagnostics row so you can see their cost separately from haze update/blit.
- **Static weather mode** — a Weather Motion dropdown in the map metadata panel switches between Animated (particles drift, lightning strikes) and Static (haze only, no per-frame work). Use Static for PNG-style stills, slideshow maps, or when you want the atmospheric wash without the motion budget. The setting is a local editor preference, so it doesn't travel with the map file.
- **Weather shows up in the player view** — rain, snow, fog, embers, and the rest all render in the player's session window with the same haze + particle + lightning pipeline the DM sees. Weather is drawn under the fog of war so unrevealed rooms stay cleanly masked — players only see the storm in places they can see — and lightning strikes drive the player's lighting pass exactly like the DM's, so you get the same wall-shadow flashes across the table. Particles animate on the player side without needing any animated lights on the map, and the player's render loop goes fully idle on weatherless maps so there's zero cost when it's off.

### Lighting

- **Disabling lighting now restores full brightness** — unchecking "Enable Lighting" used to leave the map looking dim because the cached composite still had the lightmap baked in. The toggle now invalidates the lightmap cache, so the map snaps back to 100% brightness immediately.
- **Per-light edit dialog** — double-click any light on the canvas (or press Enter while it's selected, or click an entry in the Lights list) to open a floating draggable panel with every per-light property: name, group, darkness, preset, color, radius/range, intensity, falloff, dim radius, z-height, soft shadows, the full animation configuration, and cookie/gobo settings. Matches the prop edit dialog — one undo step per session, Enter applies, Esc reverts. The left-side Lighting panel keeps the map-wide controls (ambient, bloom, storm, groups, preset resync, coverage map, Lights list), so navigating lights is still one click but editing now happens inline with the light instead of 30 cm away from it.
- **Secondary color mode visibly cycles on pulses and flickers** — setting Color Mode to "Two-color blend" with a pulsing light used to tint only during the dim trough of the cycle, where the tint was almost invisible. The secondary hue now blends in symmetrically around baseline intensity, so a pulse between orange and blue cycles through visible blue at both the bright peak and the dim trough. The `auto` (red-shift) mode still uses the original dip-only math, since it models flames red-shifting as they die — asymmetric by physics.
- **Light indicator is now a lightbulb icon** — the marker that shows where each light sits on the map (visible while the Light tool is active) used to be a colored dot with a tiny "P" or "D" letter in it. It's now a 💡 emoji tinted by the light's color, so you can see at a glance where your lights are without reading letters. Directional lights also get a small arrow pointing along their aim.
- **Light tool has a selection-only mode** — pick "— select preset —" from the preset dropdown and the tool stops trying to stamp new lights: no placement preview ring follows your cursor, left-click only selects existing lights, and the status bar explains what's going on. Pick a preset again and you're back to placing. No more accidental lights when you're just trying to tweak existing ones.
- **Escape cascade on the Light tool** — Escape now steps backward through what you're doing: cancel an in-progress drag, then exit paste mode, then deselect the current light, then clear the preset back to "— select preset —". Covers the common "I'm done placing lights, stop stamping" flow without having to switch tools.
- **Prop gobos** — props can now declare upright patterned occluders with a `gobos:` field (window mullions, prison bars, lattice walls). Any nearby light that clears the gobo's base height projects the pattern onto the floor on the far side of the segment, same projection math as the existing z-height prop shadow system but pattern-modulated. Pairs with the existing light-side cookie feature: cookies are for floor-level effects (water caustics, tree dapple, magical sigils), gobos are for fixtures where the pattern moves with the light. Four built-in gobos ship out of the box — `window-mullions`, `vertical-bars`, `horizontal-slats`, `ceiling-grate` — and new ones are a one-file drop: add a `.gobo` YAML under `src/gobos/`, run `node tools/update-gobo-manifest.js`, reference the id from any prop. Pre-commit auto-regenerates the manifest + bundle so `.gobo` / `.prop` edits can't ship stale. Horizontal ceiling grates need a different projection model and will land in a follow-up; for now the four shipped gobos are all upright-segment fixtures.
- **Windows and grates are now passive props** — the `clerestory-window`, `stern-window`, and `sun-window` props previously auto-emitted a daylight/moonlight pool. In v0.12 they stop doing that: windows don't make light, they let light pass through. Drop a window and place any nearby light source to drive the mullion projection. If you want the old "sunpool" glow on a specific map, add an explicit `daylight` light next to the window.
- **Light cookies (gobos)** — every light can now project a patterned mask through its gradient: stained-glass shards, prison bars, water caustics, dappled tree canopy, magical sigils, or a plain window grid. Six built-in patterns; no asset files to manage. Cookies support static rotation/scale/scroll, plus animated rotation and scroll for moving effects (slow-rotating sigils, drifting canopy dapple). Configure on any light from the new Cookie section of the lighting panel, or declare one inline on a prop's `lights:` field so window/grate props auto-project their pattern.
- **More flame personality** — flicker animation gains four optional modifiers: a *noise* pattern variant (windblown gusty feel vs. the default sine flicker), a *guttering* envelope (occasional dropouts simulating a dying flame), an *auto* color-shift mode (flames red-shift as they dim), and an explicit *two-color* mode (blend between two arbitrary colors driven by the waveform — green↔purple faerie fire, blue↔cyan arcane portals). Radius variation now applies to pulse and strobe too, not just flicker.
- **New animation types** — *Strike* gives a light long-quiet stretches punctuated by brief bright flashes (electrical hazards, malfunctioning crystals, broken lighthouses). *Sweep* rotates a directional light's cone over time, full 360° or back-and-forth within an arc (lighthouse beams, nervous lantern carriers).
- **Storm mode** — new toggle in the Ambient section paints map-wide lightning flashes at irregular intervals, color-keyed to the ambient color (set ambient to pale blue for a thunderstorm). Synced across the whole map; great for outdoor encounters.
- **Light group transitions** — the Groups toggles gain a transition picker (Instant / Fade / Ignite / Extinguish). Igniting a group ramps from zero with a brief mid-flicker; extinguishing guttering down before going dark. Lets DMs cut the chandeliers mid-session without a hard pop.
- **Same lighting in editor preview and PNG export** — the export pipeline used to run a separate per-pixel renderer that subtly diverged from what you saw in the editor. PNG exports now use the same engine the editor preview uses, so cookies, color shifts, sweep angles, group fades, and ambient strikes all show up identically in `--export-png` output.
- **Twelve new presets** — Magical Ward, Malfunctioning Portal, Arcing Crystal, Summoning Sigil, Lighthouse Beam, Nervous Lantern, Stained-Glass Window, Prison Bars Light, Canopy Dapple, Water Caustics, Windblown Torch, Dying Candle. Each demonstrates one or more of the new features so you have working starting points.
- **Co-located identical lights no longer flicker in lockstep** — two torches with the same speed used to share an animation phase, so their flames pulsed in perfect sync (visible on hallway runs of identical sconces). Each light now derives a stable per-id phase offset, so a row of torches looks naturally chaotic out of the box. Set `phase: 0` on every member of a group if you actually want sync (alarm bells, ritual chants).
- **Light groups** — tag any light with a group name ("torches", "traps", "magic auras") and toggle the whole group on/off in the new Groups section at the bottom of the Lighting panel. The toggle affects both the live editor preview and PNG exports, so DMs can dim every torch in the dungeon mid-session without re-placing anything. Ungrouped lights are always visible.
- **Darkness / anti-light** — new checkbox per light. When enabled, the light SUBTRACTS illumination from the area it covers (D&D Darkness spell, cursed zones, shadow auras) instead of brightening it. Works with every existing feature — falloff curves, radius, animation, directional cones — the area just ends up dark instead of bright.
- **Soft shadows** — new per-light Soft Shadow slider (0–4 ft). Non-zero values cast four jittered sample rays from a disc around the light center and blend the results, so wall corners fade through a realistic penumbra instead of snapping from fully-lit to fully-dark. Reads as a hand-drawn aesthetic on printed maps.
- **Bloom** — Bloom slider in the Ambient section adds a soft Gaussian halo around the brightest lightmap regions, so torches and magical auras read as actual light sources instead of colored discs.
- **Kelvin color-temperature sliders** — new "Temp (K)" sliders in both the Ambient section and each light's color controls. Drag between 1500K (candle) and 10000K (moonlight); the hex color updates automatically. Artists and DMs usually think in warm/cool, not hex.
- **Live light preview tile** — the Selected Light section now shows a 64×64 radial-gradient thumbnail of the current color, falloff, and darkness state. Updates in place as you drag sliders, so you can preview choices before committing.

### Performance

- **Editor startup is no longer micro-hitchy** — opening the editor used to produce ~5 seconds of intermittent jank before settling, visible as small pauses during your first pan, zoom, or tool click. Root cause: the editor was generating prop selection/lighting hitboxes for all 1,400+ props in the background during idle time, and a single prop's hitbox rasterization could overrun the browser's idle-callback budget by 40×. Hitbox polygons are now precomputed at build time and shipped with the prop bundle, so the client reads them directly instead of running convex-hull rasterization in your browser. Measured on a post-fix trace: the 524 idle-callback chunks totalling 885 ms of main-thread work dropped to **zero**, and the remaining main-thread activity settles within 2–3 seconds instead of 5. The bundle is ~600 KB larger but compresses well over the wire.
- **Wheel-zoom stays smooth even with all the new animation features turned on** — animated cookies, sweep lights, color-shifting torches, and storm flashes are individually cheap, but together they add measurable per-frame lighting work. The animation tick now suspends itself for 150ms after each wheel event, so every zoom frame hits the lightmap cache short-circuit (one drawImage) instead of rebuilding the animated overlay. Animation resumes the moment the wheel goes idle; the brief flicker pause during a zoom is invisible (visual masking suppresses fine flicker detail during fast viewport motion). Pan was never affected and isn't throttled.
- **Zoom is now smooth on maps with animated lights** — on torch-heavy maps the editor used to rebuild the full lightmap on every wheel tick, blowing the 60 fps budget and making zoom feel like it was dragging. The lightmap bitmap is now reused across pan and zoom frames (it only changes when a light actually animates or moves), and the canvas just recomposites it at the new viewport — turning most zoom frames into a single `drawImage` instead of a full light pipeline rebuild.
- **Wheel events are coalesced per frame** — a fast-spinning mouse wheel can fire 100+ events per second. Each one used to mutate zoom state immediately, triggering duplicate work even though `requestAnimationFrame` collapses the paints. Deltas are now accumulated and applied once per frame, so rapid zooms produce one clean zoom step per frame regardless of how many wheel events arrived.
- **Off-screen grid lines skipped on oversized maps** — when a map is too large for the offscreen cache (rare, >16k px on either axis) the editor falls back to direct rendering. The matrix-grid pass used to iterate every cell on the map even though only a small portion was in view. It now culls to the viewport like the other phases, so scrolling and zooming on these huge maps scales with screen size, not grid size.

### Lighting — Performance & Correctness

- **Fewer per-frame allocations on flicker-heavy maps** — animated lights used to spread `{...light}` into a fresh object every frame (50 lights × 60 fps ≈ 3,000 short-lived allocations/sec). Replaced with a pooled per-light buffer keyed to each source light; same result, none of the GC pressure.
- **Prop shadows use a spatial hash** — maps with many light-blocking props previously paid O(lights × zones) per-frame even though most pairs couldn't possibly interact. Zones are now bucketed in 30×30 ft cells, and each light only visits the buckets its radius touches.
- **HQ exports skip distant prop shadows** — the PNG export path mirrored the real-time renderer's prop shadow list without the real-time path's radius culling, paying per-pixel point-in-polygon cost for shadows that couldn't reach. Now it does the same centroid-distance pre-filter, speeding up exports on dense maps.
- **Directional cone spread is clamped** — spread values over 180° used to diverge between the editor preview (wrapped to full circle) and the PNG export (narrowed back), producing inconsistent output. The cone half-angle is now clamped into [0°, 180°] at both the API boundary and the render entry points, so preview and export always agree.

### Editor UI

- **Escape blurs focused form fields globally** — pressing Escape while any input, select, or textarea is focused now blurs it and returns keyboard focus to the canvas, so tool shortcuts and per-tool Escape handlers actually fire. Previously the focused control would swallow Escape and you'd have to click the canvas first — especially noticeable when the Light tool's preset dropdown was open.
- **Scroll-wheel tweaks every slider** — hovering any range slider (opacity, intensity, radius, theme values, weather density, texture opacity, etc.) and scrolling now steps the value up or down by the slider's own step size. Saves the back-and-forth drag for small adjustments; all existing sliders pick it up automatically.

### Universal VTT Export

- **Export options dialog** — Export to Universal VTT now opens a modal first, letting you choose whether to bake lighting and static weather into the PNG. VTTs like Foundry usually drive their own lighting and weather systems, so unchecking these keeps the image clean and lets the VTT do its own thing. Light sources are still written to the `.uvtt` data either way — unchecking "bake lighting" only skips the lightmap on the baked image.
- **Windows export as terrain walls, not doors** — windows used to be routed into the `portals` array (so Foundry imported them as doors). They now go into `objects_line_of_sight`, which Foundry treats as terrain walls — see-through but sight-blocking, which is the right shape for a window.
- **Adjacent doors merge into one portal** — a 3-cell-wide double door used to arrive in Foundry as three stacked door objects because every edge cell got its own portal. Contiguous door edges along the same wall now merge into a single portal with `bounds` spanning the full width.
- **Round trims and diagonal cuts export as walls** — rooms with rounded corners or arc-trimmed walls used to export only their cardinal edges, leaving the curved sections open to line-of-sight in the VTT. The arc polylines now emit into `line_of_sight`, so the VTT's vision and lighting match the rendered map shape.
- **Format bumped to 0.4 and extension changed to `.uvtt`** — `.uvtt` is the tool-agnostic extension most VTT importers prefer now (Dungeondraft, Dungeon Fog, and Arkenforge all emit it). Bumped to format 0.4 so `objects_line_of_sight` is recognized; no JSON body changes beyond the new window field.

### Fixed

- **Erase tool drag can be cancelled** — pressing Escape or right-clicking during an erase-tool drag now clears the selection box without erasing anything, matching the cancel behavior of the other selection tools.

### New API methods

- `setLightGroup(id, group | null)` — assign a light to a group or clear its group
- `setLightGroupEnabled(group, enabled, { transition?, durationMs? })` — toggle every light in a group on/off; optional `transition: 'simple-fade' | 'ignite' | 'extinguish'` ramps the change instead of hard-cutting
- `setLightAnimation(id, animation | null)` — set or clear the animation config on a light
- `setLightCookie(id, cookie | null)` — attach (or remove) a procedural cookie/gobo on a light
- `setAmbientAnimation(animation | null)` — set/clear the map-wide ambient animation (currently `strike` for storm flashes)
- `listCookies()` — list available procedural cookie types
- `listLightGroups()` — summarize the groups present on the map with counts and enabled state
- `placeLight` now also forwards `animation`, `cookie`, `dimRadius`, `range`, `softShadowRadius`, `group`, and `name` from preset/config (in addition to `darkness: true`)

---

## v0.11.0

### Prop Panel

- **Alphabetical sort** — prop categories are now sorted A→Z in the sidebar, and props within each category are sorted by display name, so finding anything by name is predictable instead of guess-and-scroll.
- **Favorites** — hover any prop to reveal a heart in the top-right corner; click it to pin that prop to a new **★ Favorites** category at the top of the panel. Favorited props stay in their normal category too, and the list persists across sessions (per machine, via local storage).
- **Keybindings helper now lists every prop shortcut** — the floating helper panel was missing `Alt+Scroll` (fine rotate), `Alt+Shift+Scroll` (scale), `[` / `]` (z-order), `Ctrl` (freeform placement), and `Shift` (snap to grid). All six now appear when the Prop tool is active, so you don't have to read the tool's status line to discover them.

### Prop Placement

- **Random rotation toggle** — new Yes/No option in the Prop tool sub-bar. When enabled, each prop placed from the active stamp (not copy/paste) is rotated by a random multiple of 15°, so scattered rubble, bone piles, or mushrooms look varied without rotating each one by hand.
- **Random scale toggle** — sibling to Random Rotation. When enabled, stamp-placed props are scaled by a random factor between 0.8 and 3.0 (in 0.05 steps), adding dramatic size variation to natural props like boulders, trees, and mushrooms.
- **Alt+click syringes a prop** — hold Alt with the Prop tool and click any placed prop to load it as the active stamp, preserving its type, rotation, flip, and scale. The cursor shows the syringe icon while Alt is held, matching the Paint tool's sampler.
- **Stamp mode ignores placed props** — with a prop armed for placement, clicking on an already-placed prop now stamps a new one instead of accidentally selecting the one underneath. The hover cursor also stays on the placement ghost rather than flipping to the grab cursor.
- **Right-click clears the stamp** — while a prop is armed, right-click behaves like Escape and cancels the stamp. With no stamp armed, right-click still deletes the prop under the cursor as before.
- **Paste mode now behaves like an armed stamp** — after Ctrl+V, props on the map can't be clicked/selected, and **R**, **F**, **[**, **]**, and **Alt+Scroll** (rotate/scale) now transform the pending paste ghost instead of leaking through to any previously-selected props. Arrow keys and Delete are no-ops until you commit or cancel. Escape / right-click still cancel the paste.
- **Paste ghost outline follows prop rotation** — matches the selection and drag-ghost outlines. The green/red rectangle now rotates and scales with each pasted prop instead of staying axis-aligned.

### Lighting

- **Maps with many lights run smoother** — the animated-lights render path was doing three expensive things every frame that the snapshot data never actually needed: scanning the whole cell grid to re-detect lava pools, recomputing every prop's z-shadow polygon for every light, and ray-casting a visibility polygon even for lights that were fully off-screen. The first two are now cached between frames and invalidated alongside the existing visibility cache; the third skips any light whose radius doesn't reach the lightmap canvas. On a torch-heavy map with a flickering animation loop, this cut the lighting pass roughly in half.
- **Flicker and pulse lights bake their composite once** — a torch flicker loop used to rebuild the full radial gradient, re-fill the visibility polygon, and redraw every prop shadow every single frame, even though only the intensity actually changes frame-to-frame. Each flicker/pulse/strobe light now bakes its fully-composited render target at intensity 1 once, and per-frame work collapses to a single `drawImage` with `globalAlpha` set to the current intensity. Rooms lit by a dozen torches animate at the cost of a dozen GPU blits instead of a dozen full pipelines — the main lighting call chain is measurably cheaper and the animation loop has more headroom. Mathematically identical output (the destination-in visibility mask and destination-out shadow subtraction both commute with alpha scaling).

### Editor Decorations

- **Dungeon title, subtitles, scale indicator, and compass rose are cached** — each of these used to be redrawn from scratch on every animation frame, which meant reparsing a font, measuring text, and running two dozen arc/stroke commands per frame even though none of the content had changed. Each decoration now renders to a small offscreen bitmap keyed on its inputs (text, zoom level, theme colors) and the per-frame cost is a single `drawImage`. On a multi-level map with the compass rose and scale indicator enabled, this removes ~hundreds of milliseconds of per-second canvas work during lighting animations. Caches are dropped automatically when you change theme.
- **Diagnostic overlays stopped re-parsing their fonts** — the FPS counter, skip-mode overlay, and background-image drag readout each set `ctx.font` every frame with the same value, forcing Chromium to reparse the font string each time. They now go through a tiny guarded setter that skips the assignment when the value is unchanged.

### Debug

- **Show Selection Boxes toggle** — new checkbox in the Debug panel draws a magenta dashed polygon around every prop showing the exact selection hitbox (the `selectionHitbox` from the `.prop` file, or the auto-generated convex hull when none is defined). This is the shape `hitTestPropPixel` tests against for clicks, so any mismatch between the magenta outline and the rendered prop is a click-target bug you can spot at a glance.

### Fluid Rendering

- **Water, lava, and pit fills render ~100× faster** — fluids were the single biggest cost in the render breakdown (`Fills:` was clocking in around 5.8 seconds on fluid-heavy maps, more than every other phase combined), because each region rebuilt thousands of Voronoi polygons from scratch on every cache rebuild. The seven fill variants — pit plus three depths each of water and lava — now render via pre-built tile textures that are blitted with `createPattern('repeat')` across the map, the same trick that sped up hatching a few versions ago. Zooming, undo/redo, and theme edits on rivers-and-lava dungeons are smooth now.
- **Fluid color changes only repaint the fluid layer** — water and lava colors used to be baked into the main cells canvas, so changing Water Shallow in the theme editor had to rebuild floors, textures, and blending from scratch. Fluids now live in their own composite layer, so scrubbing any fluid color slider only repaints that layer. On large maps the difference is dramatic — big stutter becomes buttery.
- **Organic voronoi edges preserved** — the ragged bleed where water meets dirt is now driven by voronoi polygons centred in fluid cells, intersected with a wall-respecting rectangular extent. Walls still cut fluid off cleanly; open edges still get the organic polygon bleed. Same look as before, just faster.

### Theme Editor

- **Slider drags only rebuild the caches they actually affect** — every theme change used to trigger a full map rebuild, so dragging a color slider on anything but the simplest map would stutter. The editor now diffs the theme against a snapshot taken before each edit and routes each changed property to only the caches that depend on it. Grid opacity tweaks redraw just the grid overlay; wall color tweaks redraw just walls and doors; fluid color tweaks redraw just the fluid layer; border and compass-rose color tweaks don't touch any cache at all (they're redrawn per frame). The automation API `setTheme()` takes the same diff path too, so scripted theme swaps are incremental instead of brute-force.

### Fixed

- **Loading overlay stays up until textures are actually ready** — on first boot the splash used to clear as soon as texture *bytes* arrived, but the GPU-ready bitmaps hadn't finished decoding yet, so the map appeared briefly untextured and tiles popped in a frame later. The overlay now waits for `decode()` + `createImageBitmap()` to complete, so the first visible frame already has textures applied.
- **Prop Edit popout no longer loses focus on every keystroke** — typing into Row, Col, Rotation, Scale, Z-index, or any light field used to unfocus the input after each character because the panel rebuilt its entire DOM on every change. Edits now keep the caret in the input, and each field additionally waits 500 ms after you stop typing before applying, so rapid keystrokes and color-picker drags don't spam render invalidations. Blur or pressing Enter commits the pending value immediately.
- **Diagonal doors and walls no longer vanish when painting nearby textures** — a Region Fill paint near (or a few cells away from) a diagonal door or wall could make the feature disappear until the next render. The partial-rebuild path was clearing and re-rendering the walls cache on every texture edit, and any feature whose geometry straddled the padded clip boundary (like a 2-cell diagonal door) ended up half-cut. Texture edits now skip the walls cache entirely since nothing on that layer changed — also a small perf win on every texture paint.
- **Invisible walls and doors stay consistent when switching tools** — the editor's view of invisible walls (`iw`) and doors (`id`) is tied to the active tool (visible under the Wall and Door tools, hidden under Paint, Prop, etc.). Switching tools didn't invalidate the walls cache, so iw/id could linger on screen under a non-wall tool and then vanish abruptly on the next unrelated edit. Tool switches now immediately rebuild the top layer, so the visibility state matches the tool you're currently using.
- **Themes missing a color field no longer crash the editor** — a custom or older theme that omitted one of the lava-light, water, lava, or pit color fields could crash rendering as soon as a lava fill appeared on the map. Missing color fields are now filled with sensible defaults at the point a theme enters memory — whether it's a shipped theme, a user-saved theme, or a theme embedded inside a `.mapwright` file — so any map renders safely regardless of which fields the theme author set.
- **Right-click with the texture tool updates the map immediately** — right-clicking to clear a texture mutated the cell but the view didn't repaint until the next mouse interaction, because the clear path bypassed the invalidation that regular apply uses. All four texture-tool paths (click/drag apply, right-click clear, shift+click flood-fill, shift+click flood-clear) now share the same invalidation route and render instantly.
- **Undo/redo of a texture edit updates the blend edges** — applying a texture across a seam (dirt meeting cobblestone, say) used to leave the smoothed blend in place after undo/redo, because the blend topology cache wasn't repatched when texture state changed through the undo path. The smart-invalidation step now tracks texture changes, so undo and redo rebuild the blend edges for the affected cells.
- **Shift-click flood-fill textures render without a second click** — flood-filling or flood-clearing textures through a room had the same bug as right-click: the data applied correctly but the view showed the old state until you did anything else. Now renders instantly like normal apply.
- **Lights and props placed mid-session now reach players live** — creating, moving, or deleting a light or prop during an active session wasn't making it to the player view until the next structural edit (wall, door, cell). The player now sees lighting and prop changes as they happen, matching every other edit type.
- **Z-order brackets (`[` / `]`) now move through the full range** — previously they'd get stuck after a single step because the underlying "swap with neighbor" logic hit a ceiling as soon as your prop became topmost/bottommost. Each press now directly shifts z by ±1 (floored at 0), and multi-selections shift together in one undo step.
- **Prop edits now always target the selected prop** — when a prop was stacked underneath another, keyboard actions (arrow-key nudge, R rotate, F flip, `[` / `]` z-order, Delete, Ctrl+X) used to operate on whichever prop happened to be on top of the cell. They now track the selected prop by ID, so the one you actually clicked is always the one that moves, rotates, or deletes.
- **Hover outline matches the prop under the cursor on stacked props** — mousing over a small prop resting on a larger one (an urn on a table, a candle on an altar) used to draw the dashed hover box around the bottom prop even though clicking correctly selected the top one. The hover highlight now uses the same pixel-level hit result as click, so what you see is what will get picked.
- **Right-click delete targets the prop under the cursor on stacked props** — right-clicking an urn resting on a table used to delete the table instead of the urn because delete used a cell-based lookup that ignored z-order. Right-click now uses the same pixel-level hit test as click and hover, so you always delete the prop you're actually looking at.
- **Shadows, drag ghosts, placement previews, and click targets now stay aligned with non-square props at 90°/270°** — rotating a 1×2 bench or 1×3 bunting line to a cardinal non-zero angle used to place the prop in one spot while the cast shadow, drag ghost, placement outline, and click-hit polygon snapped to different offsets. All five now share the same base-center rotation, so you can actually click what you see.
- **Grid-snap places non-square rotated props on whole cells** — placing or drag-moving a 1×2 bench at 90° now treats it as a 2×1 prop for snapping purposes, so the visible prop lands on whole cells instead of straddling half-cell boundaries. The stored anchor is offset transparently so the renderer's base-center rotation still produces a cell-aligned visible. Applies to editor placement, drag-move with snap, and the `placeProp` API.
- **Non-cardinal-angle props can be clicked anywhere inside their selection outline** — rotating a 1×2 bench (or any non-square prop) to an arbitrary angle like 30° used to reject clicks in the corners of the tilted rectangle because the click-hit pre-filter checked an axis-aligned bbox sized for the unrotated shape. The pre-filter now uses the true trigonometric envelope of the rotated rectangle, so the clickable area matches what the Show Selection Boxes overlay draws.
- **Selection outline follows prop rotation** — the blue selection box now rotates with the prop instead of staying axis-aligned, so tilted props (bunting lines, tapestries, anything at 15°/30°/…/345°) show an outline that actually hugs their shape. The name-label still sits above the rotated outline.
- **Drag-move highlight follows prop rotation** — the green/red ghost box you see while dragging a prop now rotates and scales with the prop, matching the selection outline behavior. Previously it stayed axis-aligned and far oversized for tilted or scaled props.
- **Non-square props no longer jump at 90°/270°** — rotating a long prop (1×3 bunting line, 2×1 bed, etc.) by the scroll wheel used to make it teleport when it passed through exactly 90° or 270°, because the renderer used one pivot for cardinal angles and a different one for everything else. Both paths now rotate around the same point, so fine rotation stays smooth through the full 360°. Hit-testing and box-select for 90°/270° non-square props now match the visible prop too.

### Performance

- **Texture and wall edits on fluid-heavy maps no longer hitch** — every cell edit had been triggering a full fluid-composite rebuild due to a `null`/`undefined` comparison that falsely flagged the fluid state as changed whenever a cell didn't already have a fill. On maps with thousands of pit/water/lava cells, a single texture or wall edit could freeze the editor for a full second because the GPU was silently re-rasterizing every fluid tile on the map. The fluid composite now only rebuilds when fluid cells actually change; edits that used to lock up the map are now imperceptible.
- **First texture application no longer stalls** — the first time any texture was painted onto the map, Chromium synchronously decoded the source PNG and uploaded it to the GPU on the paint frame, costing a few hundred ms each time. Textures now decode and promote to a GPU-ready bitmap at catalog-load time, so the first `createPattern` fill is a straight GPU blit with no lazy work.
- **Redundant second rebuild per cell edit eliminated** — every edit was doing a partial cells rebuild immediately followed by a redundant full-canvas grid rebuild, because the partial path wasn't stamping its own grid-dirty counter as complete. Cut roughly in half the GPU work per edit on large maps.
- **Main-canvas blit only touches the visible viewport** — the cached composite used to be drawn onto the visible canvas with a destination-only `drawImage`, forcing Chromium to walk the entire off-screen composite texture. The blit now passes a source rect clipped to the viewport, so pan and edits on large maps only pay for pixels that are actually on screen.
- **Editor opens faster** — prop-hitbox generation used to run eagerly for every prop in the catalog at startup (over a thousand entries), even though a typical map only uses a few dozen. The editor now only materializes hitboxes for props actually placed on the map being opened; the rest fill in during idle time on the main thread. The theme catalog also no longer blocks the initial render — it loads in the background and the theme picker populates when it arrives.
- **Prop edits no longer rebuild the full map cache** — rotating, scaling, nudging, dragging, or z-ordering a prop used to force a full cells-layer rebuild on every tick (floors, textures, blending, fills, bridges, walls, props — the lot), which made wheel-driven rotate/scale chug on large maps. The cache now routes prop edits through the existing pre-grid snapshot path, so only the top phases (walls + grid + props + labels) replay on top of a cached base layer. First prop edit in a session still does one full rebuild to capture the snapshot; everything after is cheap.
- **Editor startup no longer fans out hundreds of tiny HTTP requests** — the prop catalog (~860 entries), shipped theme catalog (16 entries), and texture metadata catalog (~750 entries) used to load via one request per file at startup, which serialized behind the browser's 6-connections-per-origin HTTP/1.1 limit and sometimes took long enough to trip puppeteer's navigation timeout. Each catalog now ships as a single `bundle.json` with a content-hash version — one fetch per catalog instead of hundreds. Texture PNGs are unchanged; they still stream in lazily as the map needs them. `tools/update-manifest.js` (props), the new `tools/update-themes-manifest.js`, and the texture download flow all regenerate their bundles automatically whenever the underlying files change, so adding or editing a prop/theme/texture still shows up on the next reload.
- **Dropped localStorage caching from the prop, theme, and texture catalogs** — HTTP ETags give us 304-Not-Modified responses with zero body transfer on repeat loads, which is effectively free over localhost. The old localStorage mirror was about to hit the per-origin 5 MB ceiling as the prop and texture catalogs grew and would have started silently failing its cache writes. A one-time cleanup removes the old `prop-catalog`, `theme-catalog`, and `texture-catalog` keys from localStorage on next launch, freeing a few MB of dead storage on existing installs.

### Prop Catalog

- **Catalog grew from ~245 to 1426 props**, covering 70+ room types. Every prop includes full placement metadata (footprint, shadow, `blocks_light`, `lights`, `placement`, `room_types`, `typical_count`, `clusters_with`), and light-emitting props automatically glow when placed.
- **Room coverage** — furniture and domestic life (kitchens, taverns, bedrooms, nurseries, libraries, farmhouses, tenements, noble chambers, mansion halls, mansion servant quarters), workshops and industry (smithies, forges, foundries, breweries, cooperages, tanneries, glassworks, kilns, refineries, artificer labs, jeweler shops, print shops, scriptoria), nautical (ship galleys, captain's cabins, cargo holds, gun decks, main decks, crew quarters, brigs, ferry houses), dungeons and prisons (oubliettes, interrogation rooms, prison blocks, monster lairs, slime pits, spider lairs, torture chambers), wilderness and camps (traveler campsites, charcoal-burner camps, druid groves, bog-witch huts, ruined watchtowers, hunter cabins, ranger camps, scout blinds, shepherd's shelters, lean-tos), planar and magical (elemental water/air/fire/earth nodes, astral anchors, celestial vaults, fey glades, shadowfell mausoleums, infernal courts, demiplane labs, crystal grottos, oracle chambers, alchemy labs), urban life (market squares and stalls, merchant houses, opium dens, tailor shops, textile loomhouses, counting houses, plazas, courthouses, gambling dens, brothels, dockside warehouses), military (command rooms, battlefields, orc and goblin camps, armories, barracks, gatehouses), underground (sewers, mines, cisterns, drow outposts, chasm crossings, mushroom groves and caverns, crypts, catacombs, ossuaries, graveyards), and events (fairgrounds, bardic halls, temples, bath houses, shrines, confessionals, baptistries).
- **Tileable prop sets** — sewage channels and mine-cart tracks each ship as a full 5-6 piece modular kit (long straight, short straight, 90-degree turn, T-junction, X-junction, end-cap) with matching edge geometry so pieces snap together cleanly.

## v0.10.1

### Fixed

- **Desktop app now launches** — v0.10.0 crashed on startup with `spawn node ENOENT` on machines without Node.js installed. The bundled server is now compiled ahead of time and run via Electron itself, so no external Node runtime is required.
- **Packaged app window now appears** — the .exe/.dmg started its process but never showed a window. The compiled editor assets weren't being bundled into the installer, so the server silently fell back to serving raw TypeScript source and the browser refused to load it.
- **Texture browser thumbnails** — the texture panel only showed thumbnails for textures already used on the map. All thumbnails now appear immediately when the panel opens.
- **Startup error diagnostics** — if the app fails to start, a log file is now written to `%APPDATA%\Mapwright\logs\main.log` (Windows) or `~/Library/Logs/Mapwright/main.log` (macOS), and an error dialog is shown instead of a silent hang.
- **Build configuration** — corrected an invalid `win.publisherName` placement in `package.json` that was rejected by the electron-builder schema.

## v0.10.0

### Incremental Undo/Redo

Undo/redo previously serialized the entire map as JSON on every action and restored it in full on Ctrl+Z, triggering a complete cache rebuild (6–10 seconds on large maps). The system now tracks granular cell-level patches and uses dirty-region information to perform partial cache rebuilds.

- **Patch-aware undo/redo** — `undo()` and `redo()` now call `smartInvalidate()` with exact cell coordinates from patch entries, enabling partial cache rebuilds instead of full redraws
- **`mutate()` API** — new transaction wrapper that captures cell before/after states as compact patches, handles `smartInvalidate`, `markDirty`, and `notify` in one call; replaces the manual `captureBeforeState → pushUndo → modify → smartInvalidate → markDirty` boilerplate
- **Metadata-only mutations** — `mutate()` accepts `metaOnly: true` for operations that only touch `metadata` (lights, overlay props, stair links); stores only the metadata diff, and undo rebuilds just the lighting composite layer without touching the cell cache
- **`pushPatchUndo()` helper** — for tools with drag-accumulation patterns (wall tool), allows pushing a compact patch entry from externally collected before/after states
- **JSON snapshot diffing** — remaining `pushUndo()` sites (theme editor, level management, file load) now diff old vs new cells on undo to compute a dirty region; falls back to full rebuild only when >30% of cells changed or grid dimensions differ
- **Tool conversions** — room, door, fill, erase, trim, label, wall, paint (box modes), prop, light, stairs, and bridge tools all converted from full JSON snapshots to compact patches
- **API conversions** — `cells`, `fills`, `textures`, `labels`, `trims`, `convenience`, `spatial`, `lighting`, `props`, and `stairs-bridges` API modules converted

### Security Hardening

- **WebSocket relay hardened** — player messages validated against a type allowlist with JSON schema checks; `maxPayload` cap (2 MB) and `perMessageDeflate` limits prevent memory exhaustion from malicious clients
- **Client-side message validation** — DM session now validates inbound message shape (`player:count`, `range:highlight`) before acting on it; malformed payloads are dropped instead of crashing the editor
- **Reconnect backoff** — WebSocket reconnect uses exponential backoff (1s → 30s, max 12 attempts) instead of a fixed 2-second loop
- **AI log rotation** — session log capped at 5 MB with `.old` rollover; per-line cap prevents oversized payloads
- **MCP subprocess buffer cap** — `runProcess` limits stdout/stderr to 8 MB and kills runaway children
- **Electron navigation guard** — `will-navigate` handler blocks navigation away from localhost; explicit `sandbox: true` on BrowserWindow
- **taskkill safety** — server shutdown uses `execFileSync` (argv-based) instead of `execSync` (shell string interpolation)
- **CSP tightened** — `unsafe-inline` removed from `script-src`; inline styles still permitted (`style-src`)
- **Session password hashing** — DM session passwords are now hashed with scrypt + random salt instead of stored in plain text; comparison uses `crypto.timingSafeEqual`
- **Session token expiry** — session tokens expire after 1 hour; checked on WebSocket connect and status endpoint
- **Rate limiting on auth** — `/api/session/auth` rate-limited to 20 attempts per 15-minute window per IP
- **Error message sanitization** — API error responses no longer leak internal file paths
- **DM socket cleanup** — reconnecting as DM properly closes the previous socket instead of leaking it
- **MCP path validation** — file path allowlist uses `path.relative()` instead of string prefix matching, preventing symlink/UNC bypass

### Quality Infrastructure

- **Pre-commit hooks** — husky + lint-staged now runs ESLint `--fix` on staged files before each commit
- **Render tests in CI** — new `npm run test:render` script + GitHub Actions job; 257 render tests now run on every push
- **Repo cleanup** — deleted stale `ai-session.log` and `eslint-errors.json` artifacts, removed 6 legacy TypeScript migration scripts from `tools/`

### Render Pipeline

- **Theme normalization** — new `normalizeTheme()` fills in all expected color/numeric keys once at resolve time; downstream renderers no longer need scattered `?? '#ffffff'` fallbacks
- **Bridge texture IDs centralized** — `BRIDGE_TEXTURE_IDS` moved to `render/constants.ts` as the single source of truth; previously duplicated in `bridges.ts` and `io.ts`
- **Feature sizing constants centralized** — `DOOR_LENGTH_MULT`, `STAIR_HATCH_MARGIN`, and other border/feature sizing values moved from file-scoped consts to `constants.ts`
- **Shared polygon geometry** — `pointInPolygon`, `pointOnPolygonEdge`, and `getBridgeCorners` extracted to `util/polygon.ts`; eliminates duplicate implementations between `render/bridges.ts` and `editor/js/stair-geometry.ts`
- **lighting.ts split** — wall extraction, prop shadow zones, and projected-shadow computation moved to new `lighting-geometry.ts` (1438 → 1157 lines in the main module)
- **renderFloors parameter cleanup** — 11 positional args replaced with `RenderPhaseParams` + `RenderFloorsOptions` objects
- **Silent catch fixes** — prop and texture catalog loaders now log full error stacks instead of swallowing context

### Editor

- **notify() re-entrancy guard** — nested `notify()` calls from subscribers are queued and drained after the outer pass finishes, preventing infinite loops
- **Multi-step mutation rollback** — `shiftCells` and `normalizeMargin` now use a `withRollback()` helper that restores the dungeon snapshot and pops the undo entry if any step throws
- **Async load error handling** — `loadDungeonJSON` now catches texture-load failures with a user-facing toast instead of silently leaving the loading overlay stuck
- **Animation loop lifecycle** — `beforeunload` and `visibilitychange` handlers stop/restart the light animation loop on page close or tab background
- **Typed `window.editorAPI`** — new `EditorAPI` type derived from the assembled api object + `declare global` augmentation; renaming a method now surfaces a type error at the dispatch layer
- **Direction offsets consolidated** — 12 duplicate `{ north: [-1,0], ... }` definitions replaced by a single `CARDINAL_OFFSETS` export from `util/grid.ts`
- **Structured errors in dispatch** — `claude-tools.ts` now preserves `ApiValidationError.code` and `.context` when surfacing errors to the LLM, plus uses a declarative `TOOL_REQUIRED_FIELDS` table for input validation
- **`ApiValidationError` isolated** — moved to its own zero-dependency `api/errors.ts` file so dispatch code can import it without pulling in tool instances or the render pipeline

### Tests

- 21 new tests: polygon math helpers, notify re-entrancy guard, `withRollback` semantics, and first-ever panel smoke tests
- Test count: 942 unit + 257 render (up from 921 + 257)

### Universal VTT Export

Maps can now be exported as `.dd2vtt` files for use in Foundry VTT, Roll20, and other virtual tabletop platforms.

- **File > Export to Universal VTT** in the toolbar
- Embeds a full-quality PNG render alongside line-of-sight walls, door portals, and lights
- Doors exported as portals; invisible walls/doors excluded from line-of-sight data
- Compatible with Foundry VTT (via Universal Battlemap Import module)

### Editor Loading Overlay

- Loading spinner covers the canvas while textures and catalogs load on startup and file open
- Prevents interacting with a half-loaded map

### Stair & Bridge Improvements

- **Stair hover highlight** — placed stairs now highlight on mouse hover (same as bridges)
- **Stair shape preview** — ghost outline correctly shows rectangle, trapezoid, or triangle for all placement angles
- **Angled bridge/stair fix** — fractional cell indices from angled placement no longer cause crashes

### File Load Validation

- Corrupted or hand-edited `.mapwright` files are now checked on load for structural issues (invalid edge values, unknown cell properties, malformed metadata)
- Warnings shown via toast notification; files are never rejected

### Player Session Redesign

- **Session password** — DMs can set an optional password before starting a session; players must enter it to join
- **Redesigned session panel** — action-first layout with the start/stop button at top, grouped "Share with Players" and "Fog of War" sections, and a Yes/No toggle for DM View
- **Password persistence** — saved in editor settings so DMs don't have to re-enter it each session
- **Obfuscated sharing** — both the player link and password are masked with copy buttons (same pattern as the IP address)
- **Player password prompt** — players see a styled login screen when joining a password-protected session

### Claude Map-Building Improvements

A pass over the editor automation API to make Claude faster and more reliable when building maps for you in chat. You should notice:
- Fewer "stuck" moments where Claude can't figure out why a command failed and re-asks itself
- Cleaner finished maps — Claude can audit its own work and fix conflicts before handing it over
- L-shaped, U-shaped, and other irregular rooms work correctly with auto-furnishing

#### Smarter feedback when something goes wrong

- **Every command failure now explains itself** — when Claude tries to place a door on a wall that doesn't exist, or a prop in a cell that's already occupied, it gets a structured reason ("OUT_OF_BOUNDS", "OVERLAPS_PROP", etc.) plus the relevant context, instead of a generic error string. Cuts down on Claude getting confused mid-build.
- **Bulk placement reports what was skipped and why** — when Claude scatters props or fills a wall, the result now includes every position that didn't take a prop along with the reason ("DOOR_HERE", "OUT_OF_ROOM", "OVERLAPS_PROP"). No more silent gaps in furnishings.

#### Dry-run before committing

- **Validate command batches without applying them** — Claude can rehearse a sequence of edits and see which ones would fail, without actually changing the map. Shows you a working preview before any state changes happen.
- **Per-command "what would this do?" check** — Claude can ask the editor to simulate a single command and report the result before committing.

#### Build checkpoints and transactions

- **Named checkpoints** — Claude can mark "after walls", "after textures", "after props" and roll back to any of them if a phase doesn't look right. Replaces fragile counter-based undo tracking; checkpoints reset automatically when you open a new map.
- **All-or-nothing batches** — when Claude runs a transaction, the whole batch either applies cleanly or rolls back completely. No more half-built maps left behind by partial failures.

#### Map auditing and inspection

- **Conflict scan** — Claude can run a single audit that flags blocked doors, props blocking door approaches, unreachable rooms, lights placed in the void, and rooms that are mostly dark. Lets it clean up its own mistakes before showing you the result.
- **Lighting coverage check** — quick estimate of which cells fall below a brightness threshold per room; surfaces "I forgot to light this room" gaps.
- **Room summary in one call** — Claude can ask "tell me everything about room A1" and get bounds, cell count, props inside, fills, doors, neighboring rooms, and which lights reach it — all at once, instead of stitching together five separate queries.
- **Cell-level region inspection** — structured dump of every cell in a rectangle (walls, fills, props, textures, lights). Replaces dozens of individual cell lookups.
- **ASCII map preview** — Claude can ask for a text-art rendering of a region for quick sanity checks without the cost of a full screenshot.

#### Furnishing and bulk operations

- **Auto-furnish a room by purpose** — Claude can populate a labeled room based on its role ("library", "throne-room", "armory") in one call. Picks props from the catalog whose metadata says they belong there, places a centerpiece + wall props + scattered floor decorations. Density is tunable (sparse, normal, dense).
- **Multi-room furnishing brief** — apply auto-furnish to many rooms at once with per-room role and density.
- **Clone a room to a new location** — copies cells, walls, fills, textures, props, and lights to a new offset (with optional rename). Useful for symmetric layouts.
- **Mirror or rotate a region** — flip a rectangle horizontally/vertically, or rotate a square region 90/180/270 degrees. Walls are remapped correctly.
- **Bulk swap props or textures** — replace every "wooden chair" with "stone chair" across the map (or within a region) in one call.

#### Catalog browsing

- **Search the prop catalog with filters** — Claude can find props by placement, room type, footprint size, name pattern, or category, instead of dumping the whole catalog and grepping. Speeds up "what props would suit this kind of room?" decisions.
- **Find unlabelled rooms** — single call that flags rooms with no label, useful as a final pass before export.
- **List enumerations** — full inventories of doors, walls, and fills on the map.

#### Annotated screenshots

- **Highlight overlays on saved screenshots** — Claude (or you, via the CLI) can mark specific cells on a screenshot with boxes, dots, crosses, and labels in chosen colors. Useful for confirming "is this the cell I meant?" without juggling two images.

### Render Pipeline Polish

- **Wait-for-render helper** — Claude can wait until the lighting recompute settles after placing many lights, before screenshotting. Eliminates a class of "the screenshot was taken too early and lighting looks wrong" issues.

### Structured API Errors

API errors now include a machine-readable `code` and `context` object alongside the error message on **every** API method (was partial before — most validation errors now follow this pattern). Example: `{ code: "OUT_OF_BOUNDS", context: { row: 5, col: 99, maxRows: 20, maxCols: 30 } }`. Makes automated error handling and self-correction much more reliable.

- **`getRoomBounds`** and **`findWallBetween`** now return `{ success: false, error }` instead of `null` when a room is not found — consistent with all other API methods
- **`loadMap`** now returns map info alongside `{ success: true }`, saving a follow-up query after every map load

### Claude Map-Building Improvements — Round 2

A second pass focused on cutting Claude's overhead per call, raising the quality of auto-furnished rooms, and making it easier for Claude to verify its own work without paying for screenshots every time.

#### Persistent editor session (much faster)

- **Browser stays open between Claude's commands** — previously every batch from Claude spawned a fresh browser, navigated to the editor, and tore it down on exit. The MCP integration now keeps a long-running browser session and forwards each command batch through it. Typical multi-phase build is several times faster end-to-end and feels noticeably more responsive
- **Idle cleanup** — the persistent session shuts itself down after 10 minutes of inactivity, then re-spawns on demand
- **Per-command progress streaming** — when Claude clients support it (via the standard MCP `progressToken`), the editor now streams per-command progress events while a batch runs. You can watch a 60-command build land one step at a time instead of getting one final blob
- **Pause-for-review checkpoints** — Claude can drop a `pauseForReview` step into the middle of a batch to give you time to inspect a phase in the visible browser before the next phase runs

#### Smarter furnishing

- **Plan-then-commit auto-furnish** — Claude can now propose a furnishing plan (every prop with role, position, facing, and a 1-line reason) and inspect or edit it before committing. Replaces the old "call autofurnish, hope for the best" flow. The legacy `autofurnish` API still works
- **Honors prop clustering metadata** — secondary prop selection is now biased toward props that the catalog tags as belonging together (e.g., `pillar` clusters with `throne`, `anvil` with `forge`). Fewer mismatched assortments
- **Door clearance is preserved** — auto-furnish no longer places props in cells immediately in front of doors
- **Light budget is enforced** — auto-furnish caps the number of light-emitting props per room to prevent rooms from being blown out by stacked torches and braziers
- **Symmetric flanking** — formal rooms (throne rooms, temples) now get bilateral pairs of pillars or braziers placed automatically when density is normal or dense

#### Relational placement helpers

- **`placeRelative(row, col, direction, offset, propType)`** — place a prop a given number of cells from an anchor in a cardinal direction. No more manual coordinate math for "put a candle two cells west of the throne"
- **`placeSymmetric(roomLabel, axis, row, col, propType, facing)`** — place a pair of props mirrored across a room's centerline, with facing automatically mirrored on the other side
- **`placeFlanking(roomLabel, anchorPropType, flankPropType)`** — find an existing prop in a room and place flanks on either side, perpendicular to its facing

#### Light-emitting prop awareness

- **`placeProp` now reports auto-added lights** — props like braziers, forges, hearths, chandeliers, and torch-sconces have always emitted their own light when placed. The result now surfaces a `lightsAdded` array so Claude knows not to double-add a `placeLight` at the same cell
- **`listLightEmittingProps()`** — lists every prop in the catalog that brings its own light, with the preset and offset

#### New verification tools (without screenshots)

- **`describeMap()`** — compact semantic snapshot of every labeled room: ASCII shape, numbered prop sidecar with coordinates, doors, fills, lights, textures, adjacent rooms. Uses far less context than a screenshot for routine "did things land where I think they did?" checks
- **`critiqueMap()`** — runs design heuristics across the whole map: rooms with no props, rooms with no centerpiece, blown-out lighting, light-emitting props with no light, overcrowded rooms, doors blocked by props, homogeneous prop usage. Replaces several manual review passes with one call

#### Undo summary

- **`diffFromCheckpoint(name)`** — summarize what `rollback(name)` would throw away. Returns counts by category (props added/removed, fills added, walls changed, doors added, lights added, etc.) plus per-entry labels. Makes rollback decisions much less scary

#### API discovery

- **`apiSearch(query, options)`** — search the editor API by keyword and category, returns lightweight method metadata. Avoids loading the full ~250-method reference for routine work
- **`apiDetails(methodName)`** and **`apiCategories()`** — drill into a single method or list every category with method counts

#### Visual prop browsing

- **`getPropThumbnail(name)`** — cached small PNG of any prop, rendered on demand. Useful for visual prop picking when Claude is choosing between several similar candidates
- **`getPropThumbnails(names)`** — batch fetch
- **`prewarmPropThumbnails()`** — pre-render the entire prop catalog into the cache (useful before a "show me 50 props" sweep)
- **`searchPropsWithThumbnails(filter)`** — combined `searchProps` + thumbnail in one call

### Claude Map-Building Improvements — Round 3

A third pass focused on how Claude *reasons* about rooms — moving from preloaded prose guides to a queryable palette library, plus convenience APIs that cut coordinate math and visual-verification overhead.

#### Room vocabulary library

- **160 queryable room-type palettes** live in `mapwright/src/rooms/` across 10 categories (dungeon, residential, sacred, wilderness, industrial, urban, underground, naval, planar, outdoor). Each spec is a *palette* — multiple primary/secondary/scatter prop options plus story prompts — so two rooms of the same type look meaningfully different because Claude composes from the palette rather than stamping a template. Covers the variations the old prose library lacked: cabin-hunters vs cabin-trapper vs cabin-witch vs cabin-abandoned; house-small vs house-medium-artisan vs mansion-grand-hall; etc.
- **`listRoomTypes`** / **`searchRoomVocab`** / **`getRoomVocab`** / **`suggestRoomType`** — four new API methods for discovering and fetching room palettes on demand. Claude no longer preloads 340+ lines of prose room specs; fetches only the types used in the current build.
- **Dynamic manifest** — new `/api/rooms/manifest` endpoint scans `src/rooms/` at request time, so adding a new `.room.json` spec is picked up without a rebuild.
- **DESIGN.md restructured** — the Room Semantic Library prose section is replaced by a pointer to the vocab API. Universal Spatial Rules, prop density guide, shape vocabulary, fill usage patterns, and anti-patterns stay in DESIGN.md.

#### Shape editing without coordinate math

- **`trimCorner(label, cornerOrCell, size, options)`** — label-based single-corner trim. Accepts `"nw"`/`"ne"`/`"sw"`/`"se"` OR a `[row, col]` cell coordinate (auto-detects the nearest convex corner). Works on irregular rooms (L, U, +, polygon) because it resolves the corner from the room's actual cell set, not a bounding box. Replaces the tip/extent math of `createTrim` for the common case.
- **`previewShape(label)`** — ASCII render of a labeled room plus a 1-cell margin. Cheap shape verification after trim/round/merge operations without taking a screenshot.

#### Intent-driven lighting check

- **Unlit rooms are now valid** — `findConflicts` reports mostly-dark rooms as `info` rather than `warning`, since caves, ruins, sealed crypts, and abandoned spaces are often dark on purpose. New `unlitRooms: [...]` option silences specific labels; `skipDarkCheck: true` disables the check entirely.
- **Room vocab carries lighting intent** — each spec includes `lighting_notes.ambient_is: "required" | "optional" | "discouraged"` so authors can signal whether a room type is meant to be lit. Claude reads this when deciding whether to place light sources.

#### MCP inline images

- **Prop thumbnails and screenshots now render inline** in MCP clients. The Puppeteer bridge extracts `dataUrl` strings from command results and the MCP server surfaces them as `image` content blocks instead of stringifying base64 into the text response. Vision-capable clients (Claude etc.) can actually see prop thumbnails when picking from `searchPropsWithThumbnails`.
- **`inline_images` tool parameter** — opt-in flag to also surface `export_png` output inline (off by default — HQ exports are large).

### Bug Fixes

- **Auto-furnish now respects its own light cap** — the `lightCap` option was being ignored because the candidate list dropped the `lights` field. Light-emitting props could be placed beyond the configured budget, leading to rooms with three braziers when one was asked for. Fixed
- **Prop thumbnail cache no longer collides between sizes** — requesting the same prop at two different sizes used to evict each other from the cache. Cache key now includes the requested size

### Breaking Changes

- **Removed `mapwright/room-templates/*.json`** — the seven JSON template files (throne-room, alchemist-lab, forge, crypt, temple, wizard-sanctum, prison-block) are gone. They were reference designs used as inspiration for AI-generated rooms; in practice they anchored Claude toward producing rooms that all looked alike. Same room-type guidance now lives in `mapwright/DESIGN.md` under "Room Semantic Library", which describes prop palettes and density without prescribing exact layouts. If you were running these templates standalone, the design notes for each room type are still in DESIGN.md

### Electron Fixes

- Server process tree is now properly killed on app close (Windows)
- Renderer console messages forwarded to terminal
- Vite watch mode runs automatically alongside Electron — code changes rebuild instantly without restarting the app

### Security Hardening

- **Session authentication** — DM connections use a server-generated token; player connections validate against an optional password. Prevents unauthorized users from joining LAN sessions
- Path traversal protection on file open and theme endpoints
- SSRF protection on Ollama proxy endpoints (localhost only)
- Content Security Policy, `X-Content-Type-Options`, and `X-Frame-Options` headers added

### Under the Hood

- **Full TypeScript migration** — entire codebase converted to strict TypeScript with zero type errors and zero lint suppressions
- **Vite build system** — faster dev server with hot module replacement; production builds in ~300ms
- **Test suite** — expanded from 734 to 1,111+ tests, now also type-checked via TypeScript
- **Codebase refactoring** — four largest files split into focused modules for maintainability
- **Cell type safety** — removed loose index signature from the Cell type; all cell property access is now compile-time checked
- **Hybrid undo system** — small edits store compact cell-level patches instead of full JSON snapshots, with periodic keyframes; reduces undo memory usage by up to 95%
- **Transaction helper** — new `mutate()` function wraps the undo/invalidate/notify ceremony, reducing boilerplate and preventing missed steps in state mutations
- **Selective subscriptions** — `notify()` now supports topic filtering so UI panels only re-render when relevant state changes
- **~30 type cast reductions** — replaced `as unknown` casts with proper type aliases, type guards, and narrowed interfaces

---

## v0.9.1

### Grid Customization

The grid overlay is now fully customizable per-theme via a new **Grid** section in the theme editor.

**New grid styles:**
- **Lines** — solid grid lines (default)
- **Dotted Lines** — dashed grid lines
- **Corner Crosses** — small + marks at grid intersections
- **Corner Dots** — dots at grid intersections

**New grid settings:**
- **Color** — grid line color (moved from the Colors section)
- **Width** — line/dot thickness (1–8px)
- **Opacity** — grid overlay transparency (0–1)
- **Corner Length** — cross arm length as fraction of cell size (Corner Crosses only)
- **Noise** — deterministic wobble for a hand-drawn feel (Lines/Dotted only)

**Per-theme defaults:** All 16 built-in themes now ship with custom grid settings tuned to their aesthetic — clean lines for architectural themes, corner dots for caves, corner crosses for magical/alien themes, dotted lines with noise for outdoor environments.

**Rendering changes:**
- Grid renders before walls (walls always above grid)
- Grid skips voided areas (corner crosses/dots require all 4 adjacent cells to be drawable)
- Grid-only setting changes use a snapshot-based rebuild that skips expensive floor/texture/blending phases

### Player View Incremental Cache Updates

Map changes from the DM now trigger targeted partial rebuilds on the player view instead of a full 6-second cache rebuild. This eliminates the GPU context loss (browser tab crash) that occurred on large maps when the DM made frequent edits.

**Change hint system:** The DM broadcast now includes `changeHints` — a typed diff describing what changed since the last broadcast:
- `dirtyRegion` — bounding box of changed cells (enables partial cell-layer redraws)
- `themeChanged` — theme colors/styles differ
- `lightingChanged` — light positions/properties changed
- `propsChanged` — props added/removed/moved
- `gridResized` — map dimensions changed

**Rebuild routing by change type:**

| Change | Cells layer | Composite | Shading/Hatching | Fog | Walls |
|--------|------------|-----------|-----------------|-----|-------|
| Cell edit (small) | Partial (dirty region) | Partial | Skip | Skip | Skip |
| Theme change | Full | Full | Check sig | Rebuild | Rebuild |
| Lighting only | Skip | Rebuild | Skip | Skip | Skip |
| Props only | Full (preserved cells) | Full | Skip | Skip | Skip |
| Grid resize | Full | Full | Full | Full | Full |

**Cached cells array:** The player now reuses a cached `fullCells` array across partial rebuilds, preserving reference-based caches (fluid geometry, texture blending, room topology). Only dirty-region cells are patched in-place.

**Fluid/blend patching:** Partial rebuilds patch the fluid render layer and blend topology cache for just the dirty region, avoiding a full 6-second fluid geometry rebuild.

**Props render layer:** The player now invalidates the props render layer and visibility cache on every update, ensuring new props and their shadows appear immediately.

**Broadcast baseline:** The DM session snapshots theme, lighting, props, and grid dimensions at session init, so the first `dungeon:update` correctly diffs against the initial state instead of treating everything as changed.

**Tool broadcast fixes:** The stairs and bridge tools now call `notify()` and accumulate dirty regions, which were previously missing — changes from these tools never reached the player view.

### Player View Diagnostics

The player diagnostics overlay (press `D`) now shows detailed cache rebuild information:

- **Build type** — full / partial / props / composite
- **Per-layer timing** — MapCache, shading layer, hatching layer, walls layer
- **renderCells phase breakdown** — roomCells, shading, floors, blending, fills, bridges, grid, walls, props, hazard
- **MapCache internal stats** — cells rebuilds, composite rebuilds, last rebuild type

### Map Cache Architecture

**Composite-only rebuilds:** `MapCache` now tracks cells-dirty and composite-dirty sequences separately. Lighting-only changes trigger a composite rebuild without touching the cells layer (the lightmap has its own internal cache).

**Grid snapshot mechanism:** The editor's `MapCache` captures a pre-grid snapshot of the cells layer after the base phases (floors, textures, fills, bridges). Grid setting changes restore from this snapshot and re-render only the cheap top phases (grid, walls, props), skipping the expensive base phases entirely. The snapshot is allocated lazily — only after the first grid setting change — so the player view incurs no extra memory.

### Player View — Partial Rebuild Fixes

**Fluid/blend cache preservation:** Partial rebuilds now reuse the cached `fullCells` array so reference-based caches (fluid geometry, texture blending, room topology) stay valid. Only dirty-region cells are patched in-place, with proper secret door (`'s'` → `'w'`/`'d'`) and invisible wall/door filtering applied during the patch.

**Secret door opening:** Opening a secret door now patches the cached player cells to convert `'w'` → `'d'` and triggers a partial rebuild with structural flag (walls layer rebuild + lighting invalidation). Previously, the cached cells retained the old `'w'` value, causing the `'S'` marker to persist alongside the opened door.

**Texture version tracking:** The player no longer unconditionally bumps `texturesVersion` on every update — only when genuinely new texture images are loaded. This prevents the `canPartial` check from failing due to version mismatches on texture-only cell edits.

**Props rendering:** Props changes now correctly invalidate the props render layer and visibility cache on the player side, and the DM broadcast includes a `propsChanged` hint. Previously, new props never appeared on the player view because the props layer cache never invalidated.

**Fill/fluid patching:** Partial rebuilds now patch the fluid render layer for the dirty region (via `patchFluidForDirtyRegion`), so water/lava/pit fills update correctly without a full 6-second fluid geometry rebuild.

**Blend topology patching:** Partial rebuilds patch the blend topology cache for the dirty region, so texture edge blending updates correctly on cell texture changes.

### Session Management

**Map load during active session:** Loading a new map while a player session is active now resets all fog state (revealed cells, opened doors, opened stairs) and re-sends `session:init` to the player. The player fully clears all caches (MapCache, fluid, blend, geometry, visibility, props, lightmap, fog, shading, hatching, walls) before loading the new map.

**Session end cleanup:** When the DM ends the session, the player now clears all dungeon data, caches, and the canvas. Previously, stale map content remained visible after the session ended.

**Theme change during session:** Theme changes now trigger a full cache clear and rebuild on the player view, ensuring all layers (shading, hatching, fog, walls) pick up the new theme colors.

### Player View — Diagonal Trim & Bridge Fixes

**Diagonal trim void clipping:** The `withTrimVoidClip` function now clips diagonal trim cells (cells with `trimCorner` but no `trimClip`) in addition to arc trims. Previously, grid lines and fill patterns bled into the void side of diagonal walls.

**Diagonal trim fog masking:** The player fog overlay now paints fog back over the void triangle of diagonal trim cells. Previously, revealing a diagonal trim cell cleared the full rectangle, exposing the void side to the player.

**Open diagonal trim fog:** Open diagonal trims (diagonal walls separating two rooms) now hide the unrevealed side's floor, texture, and walls in the player view. When only one side of a diagonal wall is revealed, the other side is treated as voided space. When both sides become revealed, all content is restored. This matches the existing behavior for open arc trims.

**Bridge textures in player view:** Bridge texture IDs are now included in the player view's texture loading, so bridges render with their proper textures instead of flat fallback colors.

### Removed

**Snapshot render tests:** Removed the visual regression snapshot tests (`test/render/visual.test.js`, `test/render/player-view.test.js`) and their golden images. These were not catching real regressions — golden files were overwritten on every intentional visual change. Removed from CI workflow and pre-commit hook. The `test:render` npm script and `vitest.render.config.js` have been removed. Non-snapshot render tests (`player-fog-layers.test.js`) are preserved.

## v0.9.0

### Round Trim System Overhaul

The round trim (arc wall) system has been completely rewritten. Each arc boundary cell now stores its own geometry data instead of referencing a shared arc center, eliminating an entire class of rendering, BFS, and texture bugs.

**New cell data model:**
- `trimClip` — floor polygon in cell-local coordinates (defines room vs void boundary)
- `trimWall` — arc polyline for wall rendering
- `trimCrossing` — 3x3 sub-grid crossing matrix for precise BFS traversal
- `trimCorner` — corner orientation (nw/ne/sw/se)

**What changed:**
- **Rendering**: Per-cell arc clipping replaces the old global canvas clip path. Each cell renders its own arc wall segment and floor polygon. Textures split precisely at the arc boundary (primary on room side, secondary on void side)
- **BFS / Flood Fill**: Arc walls use a per-cell crossing matrix instead of the old 200-line arc post-pass. The crossing matrix determines which exits are reachable from each entry direction, preventing leaking through the arc boundary
- **Texture flood fill**: Arc boundary cells correctly receive primary or secondary texture based on which side the fill originated from. Works consistently regardless of fill start position, handles multiple adjacent circles, and supports both inside and outside fills
- **Open trims**: Decorative arcs that don't void cells. The arc wall blocks texture flood fill but not structural BFS (fog reveal, room detection). Floor renders fully on both sides
- **Inverted trims**: Concave arcs that curve into the room. Void region extends beyond the original triangle into the room interior
- **Cell inspector**: Updated to show trim type, corner, wall points, clip points, and texture state. Raw JSON collapsed by default

**Removed:**
- `trimRound`, `trimArcCenterRow/Col`, `trimArcRadius`, `trimArcInverted`, `trimInsideArc`, `fogBoundary` cell properties
- `collectRoundedCorners()`, `buildArcVoidClip()`, `withArcClip()` render functions
- ~200 lines of arc geometry helpers and post-pass BFS in `grid.js`
- Arc bleed fix in player fog overlay

**Migration**: Old maps are automatically converted on load. The v3-to-v4 migration computes per-cell geometry from the old arc center/radius metadata.

### Player View Fog-of-War Overhaul

The player view rendering pipeline has been rebuilt with a layered compositing architecture. Fog, shading, hatching, and walls are now independent cached layers instead of being baked into a single map image.

**New layer stack (bottom to top):**
1. Full map cache (floors, props, lighting — no shading or hatching)
2. Fog overlay (theme-coloured, not black)
3. Outer shading composite (fog-edge masked)
4. Hatching composite (fog-edge masked)
5. Walls + doors overlay (revealed cells only)

**Fog-edge mask**: Shading and hatching appear in a band around revealed cells, using a Minkowski-sum (rolling ball) approach that produces naturally rounded outer edges instead of blocky cell-aligned rectangles. The mask rebuilds when fog changes; the shading and hatching canvases themselves are cached once per session and never recalculated.

**Theme-coloured fog**: The fog overlay and canvas background now use the theme's background colour instead of black, so the void around the dungeon matches the theme aesthetic.

**Walls overlay**: Walls and doors render above the fog and hatching layers so boundary walls are always visible. Uses a filtered cells grid containing only revealed cells — walls from unrevealed cells never render. Updated incrementally on reveal (dirty-region render); full rebuild on conceal.

**Bug fix — secret doors visible in player view**: The walls overlay was copying raw cell data without filtering secret door types, causing the "S" marker to appear on the player view before the door was opened. The overlay now applies the same filtering as the full-map cache — unopened secret doors render as plain walls, opened secret doors render as normal doors. Additionally, opening a multi-cell (double-width) secret door now correctly broadcasts all constituent cells to the player, so both halves update to show a door.

**Performance**: Hatching and shading layers build once and are keyed by a theme-property signature — only a mid-session theme change triggers a rebuild. The fog-edge mask (shared by both composites) is the only work done per reveal. The walls overlay uses incremental dirty-region rendering. Fog reset and starting room selection no longer trigger a full map cache rebuild on the player — fog reset sends a lightweight `fog:reset` message that clears only the fog-related layers, and starting room reveal sends an incremental `fog:reveal` instead of a full `session:init`.

### Donjon Importer Upgrade to v4

The Donjon random dungeon importer has been rewritten to output format version 4 natively (half-cell resolution + per-cell arc trims), bypassing the migration pipeline entirely.

**Half-cell resolution:**
- Each Donjon cell expands to a 2x2 subcell block (gridSize 2.5), matching the OPD importer's resolution
- Walls, doors, and stairs use subcell-aware edge helpers (`setEdge`/`clearEdge`) for correct placement across 2-subcell-wide boundaries

**True inscribed circles:**
- Circle rooms use per-cell `computeArcCellData()` for every boundary cell, producing pixel-perfect arcs instead of the old 4-corner diagonal approach
- Each quadrant is scanned independently; every cell the arc passes through gets its own `trimClip`/`trimWall`/`trimCrossing` data

**Corridor punch-through:**
- Doors punch corridor-width lanes from the room edge to the halfway mark, preventing arc/diagonal trims from blocking passage openings
- Circle rooms punch to center; polygon rooms compute punch depth from the trim diagonal geometry
- Side walls are added on punch-through cells where they face void or the void side of a trim cell (no end caps)

**Polygon trim improvements:**
- Polygon (hexagon, pentagon) trims computed at subcell scale with diagonal walls
- Voiding respects room ownership via `room_id` bitmask — a shaped room's trim never voids cells belonging to an adjacent room

**Archway props:**
- Donjon archway cells get an `archway` prop placed at the center of the 5ft cell with correct rotation (0 for N-S, 90 for E-W passages)
- Invisible doors (`'id'`) placed at the subcell center via `setCenterDoor` for fog/BFS control

### Improvements

- **Fog Reveal Tool: right-click to re-fog**: Right-clicking a cell with the Fog Reveal tool (F) now re-applies fog of war to that cell, hiding it from players again. Left-click drag to reveal remains unchanged.

### Bug Fixes

- **Fixed double door buttons in DM session**: Adjacent doors that visually merge into a single double door now show one "open door" button instead of two separate buttons. Clicking the merged button opens all doors in the group at once.
- **Fixed blank right-sidebar panels**: Panels with render caching (Background Image, Lighting, Session, History) appeared completely empty when switching tabs, because the cache skipped DOM rebuilds even when the container had been cleared. Panels now detect an empty container and force a rebuild regardless of cached state.
- **Fixed room tool lacking cancel**: Right-clicking or pressing Escape while dragging a room now cancels the placement instead of committing it. Right-click on a non-dragging cell still voids it as before.
- **Fixed Fog Reveal tool DM overlay**: The DM fog overlay is now forced on (and the checkbox disabled) while the Fog Reveal tool is active, preventing the toggle from getting out of sync. Switching away from the Player Session panel now correctly hides the overlay and deactivates the session tool.
- **Fixed fluid fills bleeding into trim voids**: Water, lava, and pit fills no longer render in the voided regions of arc wall trims. The fluid clip path now skips bleed into null (voided) cells and trims boundary cells to their floor polygon instead of the full cell rect.

## v0.8.0

### User-Saved Themes

Custom themes can now be saved, reused across maps, and shared between machines:

- **Save as Theme**: After customizing colors in the theme editor, click "Save as Theme" to persist the theme to disk with a name. Saved themes appear in the theme picker alongside built-in presets
- **Live editing**: Edits to a saved theme update the file on disk automatically — no need to re-save
- **Rename and delete**: Hover over a saved theme thumbnail to reveal rename (pencil) and delete (×) buttons
- **Cross-machine portability**: Maps embed the full theme data when a saved theme is active. Opening a map on a machine without the theme auto-installs it from the embedded data
- **Storage**: Saved themes live in `{userData}/themes/` (Electron) or `user-themes/` (dev mode), using the same `.theme` JSON format as built-in themes

### Label System Overhaul

Room labels are now freely positionable and visually prominent:

- **Free placement**: Labels can be placed at any position on the map, no longer snapped to cell centers. Click anywhere to place; drag to reposition freely
- **Doubled size**: Label circles, text, and backgrounds are all 2× larger for better readability at any zoom level (circled radius 15→30, font 14→28px)
- **Theme-controlled colors**: Labels now read `borderColor`, `fontColor`, and `backgroundColor` from a new `labels` block in each theme file. Default across all themes: black border, black font, white background
- **Proximity-based interaction**: Hover and selection highlights are now circles centered on the label's actual position instead of full-cell rectangles

### Z-Height Shadow Projection

Lights and props now have a vertical height dimension (`z` in feet above floor), enabling physically-based shadow projection:

- **Height-proportional shadows**: A 7ft torch casts short shadows from a 2ft chest, medium from a 3ft barrel, and long from a 6ft bookshelf. Shadow length = `zTop / |lightZ - zTop|`, capped at 20×
- **Three shadow cases**: Light above prop → short finite shadow with penumbra from the far face. Light within prop height range → long shadow from the far face, front of prop is lit. Light below prop bottom → no shadow (light passes underneath)
- **Multi-zone hitboxes**: Props can define multiple height zones with `hitbox rect x,y w,h z bottom-top` syntax. The statue demonstrates this with a wide pedestal (0–3ft) and narrower figure (3–6ft), each casting independently shaped shadows
- **All props assigned heights**: 206 light-blocking props have height values (0.5ft books to 15ft trees). 30 flat-on-floor props (carpets, magic circles, traps) remain non-blocking
- **All light presets have z values**: 30 presets with appropriate heights (1ft ground fires, 3ft braziers, 7ft torches, 20ft overhead/celestial lights)
- **Height slider in lighting panel**: New "Height (ft)" control for adjusting light z interactively
- **Prop scale affects height**: A 2× scaled pillar casts shadows as a 20ft prop instead of 10ft
- **Radius culling**: Props outside a light's effective radius are skipped during shadow computation
- **Light drag performance**: Light-only changes skip expensive wall segment and prop shadow zone recomputation; composite cache rebuilds are skipped when animated lights handle the overlay. Deferred undo snapshot — clicking a light to select it no longer triggers a cache rebuild
- **Cancellable light drag**: Escape or right-click during a light drag restores the original position with no undo entry

### Prop Art Overhaul

Comprehensive visual overhaul of the entire prop library — every prop reviewed, with ~100 props remade or significantly improved:

- **Perspective fixes**: Dozens of props corrected from front-facing to proper top-down perspective (notice board, scroll rack, shield rack, pot rack, portcullis, vault door, wine rack, trophy mount, etc.)
- **Visual quality improvements**: Props redesigned with richer detail, better textures, and consistent art style (treasure pile, skeleton, sarcophagus, throne, organ, magic circle, ritual circle, well, workbench, wardrobe, etc.)
- **New props**: Lumber Stack, Standing Mirror, Sarcophagus (Skull), Treasure Pile (Small/Large/Massive)
- **Removed redundant props**: Stable Partition, Summoning Cage, Zombie Pit, Well Windlass, Tapestry, Wood Pile
- **Resized props**: Obelisk (1x1→2x2), Training Dummy (1x1→2x2), Organ (3x3→4x3), Reliquary (1x1→2x3), Throne Dais (3x4→6x6), Wardrobe (2x2→3x2), Workbench (2x2→2x3), Ship Wheel (2x2→1x1)
- **Renamed**: Oil Cauldron → Cauldron (Oil), Stone Column → Column (Stone)

### Prop DSL Enhancements

New drawing primitives for richer prop artwork:

- **Gradient fills**: `gradient-radial` and `gradient-linear` styles on any shape, with configurable start/end colors, opacity, and angle
- **Bezier curves**: `bezier` (cubic, 2 control points) and `qbezier` (quadratic, 1 control point) for organic shapes and scrollwork
- **Elliptical ring**: `ering` command for non-circular donut/annulus shapes
- **Clipping masks**: `clip-begin`/`clip-end` blocks to restrict rendering to a shaped region
- All new primitives support rotation, flipping, fill/stroke/texfill styles, and the `width` modifier
- **Hitbox commands**: `hitbox rect/circle/poly` defines custom lighting occlusion shapes; `selection rect/circle/poly` defines custom click-detection shapes. Both are optional — auto-generated convex hulls are used as defaults

### Prop Tooling

- **Prop footprint validator** (`tools/validate-props.js`): CLI tool that scans all `.prop` files and reports coordinates exceeding declared footprint bounds. Catches clipping issues before they reach the renderer
- **Prop preview API** (`renderPropPreview`): Editor API method that renders a single prop to a data URL image — enables agents to visually self-correct prop designs. Accepts catalog names or raw `.prop` text. Callable via puppeteer bridge

### Half-Cell Resolution

The grid system now supports half-cell precision. Internally, each display cell (5ft) is divided into 4 sub-cells (2.5ft each), allowing walls, doors, rooms, and features to be placed at half-cell boundaries. This gives map authors the same kind of freedom found in other map editors that divide cells into quarters.

- **Coordinate system**: The API uses half-step coordinates (0, 0.5, 1, 1.5, ...) — existing integer coordinates remain fully compatible
- **Internal storage**: Grid dimensions are doubled internally (`metadata.resolution = 2`, `gridSize` halved to 2.5ft) while the display grid stays at 5ft
- **Auto-migration**: Existing `.mapwright` files seamlessly upgrade from format v2 to v3 on load — each cell splits into 4 sub-cells with walls, fills, textures, trims, stairs, and bridges correctly replicated
- **Grid lines**: Primary grid drawn at 5ft display-cell boundaries
- **Scale indicator**: Correctly shows "1 square = 5 feet" (display grid size)

### Rendering Performance

- **HiDPI / devicePixelRatio support**: The editor canvas now renders at native physical resolution on high-DPI displays (e.g. 125%, 150%, 200% Windows scaling). Canvas backing store is sized to physical pixels with a DPR transform applied to all drawing operations. Automatically re-renders when moving between monitors with different scaling
- **Configurable render quality**: New "Render Quality" dropdown in the View menu controls the offscreen cache resolution (Low 10 / Medium 15 / High 20 / Ultra 30 px/ft). Default is High. Setting persists across maps via localStorage. Higher quality gives crisper textures, props, and walls at the cost of more GPU memory
- **Minimap caching**: The minimap now caches its cell rendering to an offscreen bitmap, only rebuilding on data changes — the single biggest performance win, boosting fps from 37 to 240 on a 100×100 map
- **Two-tier offscreen map cache**: Cell rendering (floors, walls, props) is cached separately from the composite (cells + lighting). Cell cache persists across animation ticks; composite rebuilds only when lighting animates or data changes
- **Content-driven cache invalidation**: Map cache rebuilds are driven by `smartInvalidate()` content versioning instead of undo stack signatures, ensuring every cell mutation (including mid-drag wall placement) triggers an immediate visual update
- **Iterative flood fill**: Converted recursive `floodFillOutside` in floor rendering to an iterative stack-based approach, fixing stack overflow crashes on large grids (100×100+)
- **Viewport culling**: Floor rendering and editor dots now skip off-screen cells
- **Display-cell coalescing**: Floor base fill draws one display-cell-sized rect instead of 4 sub-cell rects where possible (4× fewer GPU commands)
- **Editor dots**: Only drawn at display-cell boundaries with viewport culling (was iterating every internal cell)
- **Outer shading Path2D**: Steps by resolution — ~2,500 arcs instead of ~10,000 for a 50×50 map
- **Diagonal wall merging**: Consecutive diagonal wall sub-cells are merged into single long segments, reducing GPU draw commands and eliminating visible joints between sub-cell diagonals
- **Static/animated lightmap split**: Lightmap rendering now separates static lights (cached once) from animated lights (re-rendered per frame). Static light contributions, ambient fill, and normal map bump are cached and reused — only animated light intensities update each frame
- **Screen-resolution animated lighting**: When animated lights exist, the lightmap is rendered at screen resolution and composited directly onto the viewport instead of rebuilding the full 5000×5000 offscreen composite every animation tick. Eliminates the per-frame 25-megapixel cache rebuild that was dropping frame rate from 240Hz to 13Hz
- **Configurable light quality**: New "Light Quality" dropdown in the View menu (Low 5 / Medium 10 / High 15 / Ultra 20 px/ft). Controls lightmap rendering resolution independently from the cell cache. Lower settings dramatically improve animated lighting performance on large maps with minimal visual impact (lightmaps are smooth gradients)
- **Reusable lightmap canvas**: The lightmap OffscreenCanvas is cached and reused across frames instead of allocating a new 100MB+ VRAM buffer every frame
- **Auto-generated prop hitboxes**: Every prop now has a pre-computed convex hull polygon generated at load time by rasterizing draw commands onto a binary grid and tracing the boundary. Replaces per-query iteration of all draw commands for both click detection (`hitTestPropPixel`) and light occlusion (`extractPropLightSegments`). A prop with 91 draw commands that previously generated 200+ light-blocking segments now produces ~6-10 segments from a single polygon
- **Separate lighting and selection hitboxes**: Props support independent `hitbox` (lighting occlusion) and `selection` (click detection) shapes. Lighting hitboxes can be manually overridden in `.prop` files for props where the convex hull is too loose. Selection always uses the auto-generated hull unless a manual `selection` command is specified
- **Subscriber state-diff guards**: All panel `notify()` callbacks now check whether their relevant state actually changed before doing DOM work. Metadata skips if `metadata` ref unchanged; toolbar skips if `activeTool`/`lightingEnabled` unchanged; lighting skips if `lights`/`selectedLightId` unchanged; history skips if stack depths unchanged; properties skips if `selectedProp`/`selectedCells` unchanged; session skips if `sessionState` unchanged; background-image skips if `backgroundImage` ref unchanged. Reduces idle-frame notify cost from ~1ms to ~0.1ms
- **Raised offscreen cache limit**: Maximum cache canvas dimension increased from 8000px to 16384px, allowing large maps (e.g. 66×84 prop showcase) to use the offscreen cache instead of falling back to expensive per-frame direct rendering
- **Incremental cell cache updates**: Changing a cell's texture, fill, or erasing a cell no longer rebuilds the entire offscreen map cache. A dirty-region tracker in `smartInvalidate()` records which cells changed, and the cells cache redraws only a padded bounding rect around them — reducing cache rebuild cost from O(all cells) to O(dirty region) for single-cell edits
- **Incremental blend topology updates**: Texture changes now patch only the affected blend edges/corners via `patchBlendRegion()` instead of rebuilding the full blend topology and all ImageBitmaps. Single-cell texture edits drop from ~70ms to <2ms
- **Incremental fluid layer updates**: Fill removal patches the rendered fluid layer in-place — clears the dirty region and locally rebuilds Voronoi geometry for just the surrounding cells. Fill addition does the same local rebuild. Eliminates the full-map Voronoi tessellation that previously caused multi-second hitches on large maps
- **Stale blend cache fix**: The blend topology cache key now properly invalidates on in-place cell texture mutations. Previously the `cells` reference equality check allowed stale blend edges to persist after texture reassignment
- **Fill light invalidation**: Adding or removing fills (especially lava) now invalidates the static lightmap so fill-emitted lights update immediately in the dirty region
- **Canvas context**: Uses `{ alpha: false, desynchronized: true }` for reduced compositor overhead
- **GPU flags**: Electron configured with `ignore-gpu-blocklist`, `enable-accelerated-2d-canvas`, `enable-gpu-rasterization`, and `use-angle=gl` for maximum GPU utilization

### Performance Diagnostics

- **Collapsible overlay**: Click the header `[+]/[-]` to toggle between compact (Hz/draw/gap) and expanded view
- **Hz display**: Shows rAF probe rate instead of fps — more meaningful for an on-demand renderer
- **Categorized sections**: Metrics grouped into Map, Caches, Render, Undo, and Memory categories
- **Map info**: Cell count, prop count, light count, grid dimensions with display/internal distinction
- **Per-phase render timings**: Timing breakdown for every render phase: Mouse, Dots, RoomCells, Shading, Floors, Arcs, Blend, Fills, Walls, Bridges, Grid, Props, Hazard, Lighting, Decor
- **Cache diagnostics**: Cache dimensions, cells rebuild count, composite rebuild count, rebuild time
- **Undo diagnostics**: Serialize time, total time, undo/redo stack depth
- **Interaction timing**: `mouseMove` handler cost
- **Subscriber timing (Notify section)**: Per-subscriber callback cost breakdown — every `notify()` listener is labeled and timed, sorted by cost descending. Identifies expensive panel updates at a glance
- **Frame total**: Shows previous frame's complete render time including diagnostics, minimap, and post-draw work — reveals hidden per-frame costs not captured by individual phase timers
- **Post-frame busy probe**: `setTimeout(0)` probe measures main-thread blocking after `render()` returns, distinguishing JS bottlenecks from GPU compositor latency
- **Phase skip debugging**: `window._skipPhases = { cells: true }` in console to disable render phases and isolate GPU bottlenecks
- **Debug panel**: New right-sidebar panel (View > Developer > Debug Panel) with toggles to show hitbox overlays (cyan = lighting, yellow = selection) and enable/disable individual render layers without the console. Hitbox visibility persists across reloads

### Prop Sizing Overhaul

All 204 props reviewed and resized for the 2.5ft cell grid using real-world reference dimensions:

- **84 props scaled up** to correct real-world proportions (e.g. throne 1x1→2x2, bed 2x1→3x2, forge 2x2→3x3, fountain 2x2→3x3, tree 2x2→3x3)
- **120 props unchanged** — small items that fit naturally at 2.5ft (pillar, brazier, chair, candle, barrel, caltrops, etc.)
- **Rowboat redesigned**: New 8x2 hull (20ft×5ft) with proper tapered shape, thwarts, oarlocks, and gunwale detail
- **New prop: Boat** — 8x4 (20ft×10ft) sailing/fishing vessel with stern transom, mast step, rudder, and hull plank seams
- Automated resize script (`tools/resize-props.js`) scales both footprints and draw commands proportionally

### API Coordinate Translation

All ~20 API methods now accept half-step display coordinates and convert to internal indices transparently:

- **Input conversion**: `createRoom(2, 2, 4.5, 6.5)` creates a room with half-cell precision
- **Output conversion**: `getRoomBounds`, `findWallBetween`, `listRooms`, `getMapInfo`, `getLevels` etc. return display coordinates
- **Backward compatible**: Integer coordinates work identically to before
- `getMapInfo` returns display dimensions (`rows`, `cols`, `gridSize`) plus new `resolution` field

### Door Rendering at Half-Cell Resolution

- **Cardinal doors**: Adjacent sub-cell doors automatically coalesce — 2 sub-cell doors render as one 5ft single door, 4 as a double door. Odd leftovers render as small sub-cell doors
- **Diagonal doors**: Same coalescing logic with `sqrt(2)` compensation for diagonal length — doors fill 80% of the diagonal segment
- **Diagonal wall merging**: Continuous diagonal wall lines drawn as single merged segments, with door gaps painted on top — eliminates fragmented wall artifacts between doors

### Trim & Lighting Fixes

- **Rounded trim migration**: Arc trims re-compute void boundaries at sub-cell precision after migration — eliminates chunky 2×2 void blocks, producing smooth arcs. Diagonal walls removed from rounded trim hypotenuse cells (arc wall drawn from metadata)
- **Straight trim migration**: Correctly voids the corner sub-cell on the void side of diagonal trims; sets `trimCorner` on diagonal sub-cells for proper triangle clipping
- **Lighting trim cleanup**: After lightmap compositing, void triangles of trim cells are erased with `destination-out` — prevents light brightness from bleeding into the void side of diagonal trims

### Prop Ghost Improvements

- **Rotate and scale ghosts**: Alt+Scroll fine-rotates (15° steps) and Alt+Shift+Scroll scales both placement ghosts and drag ghosts. `[`/`]` adjusts z-order during drag. Changes apply directly to ghost state with no undo overhead
- **Ghost tooltip**: Placement and drag ghosts now show a name label with rotation, scale (when non-default), and z-height (when non-default) — matching the existing selection label format
- **Placement scale**: New `propScale` state allows pre-scaling props before placement. Scale and rotation reset on Escape

### UX

- **PNG export progress overlay**: Exporting to PNG now shows a full-screen overlay with a spinner and status message ("Rendering PNG...") instead of freezing the UI with no feedback. The overlay dismisses automatically when the render completes or on error

### Bug Fixes

- **Prop drag hitch eliminated**: Picking up, cancelling, or dropping a prop no longer causes a visible frame hitch. Previously, drag start serialized the entire dungeon for the undo stack, forced a full wall segment + lightmap rebuild, and cancel/drop deserialized the whole snapshot back. Now drag operates without undo snapshots — props are removed from state on pickup, re-inserted directly on cancel (no deserialization), and `pushUndo` only fires on successful drop. Lightmap invalidation during prop operations skips wall segment extraction (only prop shadow zones are cleared, since walls don't change)
- Fixed Ctrl+freeform prop placement: the placement ghost now tracks the exact cursor position instead of snapping to cell grid, and the prop is placed where the ghost shows
- Fixed linked lights on freeform-placed props snapping to the anchor cell instead of following the prop's actual world position
- Fixed bridge textures missing in PNG export — bridge texture IDs weren't collected by the texture loader, and `DOMMatrix` (needed for pattern scaling) wasn't available in the Node.js render path
- **Export quality doubled**: `GRID_SCALE` increased from 10 to 20 px/ft — exported PNGs are now 4× the pixels for sharper prints and VTT use
- **Texture loading bar never completing**: Fixed race condition where `loadTextureImages()` returned an instantly-resolved promise for textures already in flight, causing `ensureTexturesLoaded()` to resolve before images finished loading. The progress bar also failed to track images started by `preloadPropTextures()`, leaving the loading overlay stuck indefinitely on maps with many props
- **Unknown prop type spam**: Props with unrecognized types (e.g. from removed or renamed props) now get purged from the map data on first encounter instead of logging a warning every frame
- **Prop-linked lights cleaned up on deletion**: Deleting a prop with a built-in light source (via `removePropAt` or `removePropsInRect`) now also removes the associated lights. Previously only `removeProp` cleaned up linked lights; the other two deletion paths left orphaned lights in the metadata
- **Viewport not centered on new map**: Creating a new map no longer leaves the viewport at the previous pan/zoom position — the map now auto-centers (zoom-to-fit) after creation, matching the existing behavior when loading a map
- **Erase tool not removing props**: The erase tool now removes overlay props (`metadata.props[]`) whose anchor falls within the erased rectangle. Previously only cell data was nulled — overlay prop entries persisted and continued rendering
- **Trim tool drag not cancellable**: Right-click or Escape during a trim drag now cancels the operation without applying any changes, matching the existing behavior of the light drag tool

### Migration

- Format version bumped to 3 (v2→v3 migration)
- Migration splits each cell into 4 sub-cells: replicates fill/texture/hazard, distributes outer walls to correct sub-cell edges, handles diagonal walls, trims, arc metadata, labels, stairs, and bridges
- Rounded trims: re-voids cells at sub-cell precision using doubled arc geometry; removes staircase-causing diagonal walls from hypotenuse
- Straight trims: voids the corner sub-cell in the void zone; preserves diagonal walls on the two hypotenuse sub-cells with correct `trimCorner`
- Props and lights unchanged (already stored in world-feet coordinates)

---

## v0.7.1

### Bug Fixes

- Fixed props being visible through fog of war in the player view — props now respect revealed cells, matching the existing behavior of stairs and bridges

### Testing

- Added player view unit tests (18 tests) covering fog-of-war cell filtering, prop/bridge visibility, secret door handling, and invisible wall stripping
- Added player view visual snapshot tests (6 tests) — fully revealed, partial fog, and fully fogged renders for each example map
- Added headless `renderPlayerViewToCanvas()` in the compile pipeline for player-view snapshot rendering

### Keybindings Helper

- Keybindings helper panel now shows DM tool shortcuts when in session mode (Doors, Range, Fog Reveal) instead of the editor tool binds
- Header displays "DM: Doors (1)" / "DM: Range (2)" / "DM: Fog Reveal (3)" with tool-specific actions
- Automatically switches back to editor keybinds when leaving session mode

---

## v0.7.0

### Onboarding

- Welcome modal on first launch with three options: interactive tutorial, example map gallery, or start fresh
- 5-step interactive tutorial with spotlight overlays that auto-advance as the user completes each action (create room → place door → add fill → place prop → add light)
- Example map gallery populated from `examples/` directory — thumbnail previews with click-to-load
- Contextual first-use tool hints — each of the 13 tools shows a dismissible tip toast the first time it's activated (persisted in localStorage)
- "Welcome Screen" option in the Help menu to re-open the onboarding modal at any time
- Tooltip hover delay reduced from 0.9s to 0.4s

### Keybindings Helper

- Floating contextual keybindings panel shows shortcuts for the currently active tool
- Updates instantly on tool switch and sub-mode changes (e.g. fill depth keys only shown in water/lava mode)
- Draggable — click and drag the header to reposition; position resets to default on close
- Toggle via View menu → Keybindings Helper checkbox; visibility persists across sessions via localStorage
- Shown by default on first launch

### Minimap

- Draggable — hover to reveal header, click and drag to reposition anywhere on the canvas

### Keyboard Shortcuts

- `/` now opens the keyboard shortcuts modal (in addition to existing `?`)

### File Format

- Example maps migrated from `.json` to `.mapwright` format
- Server `/api/examples` endpoint serves example map listing with PNG thumbnails

### Prop System — Free-Form Overlay

Props have been completely migrated from cell-locked grid storage (`cell.prop`) to a free-form overlay layer (`metadata.props[]`). Props are now "stickers" that can be placed at arbitrary positions, rotated to any angle, scaled, overlapped with z-ordering, and nudged with pixel precision.

#### Architecture

- **Overlay data model**: Props stored in `metadata.props[]` as `{ id, type, x, y, rotation, scale, zIndex, flipped }` — world-feet positioned with explicit z-ordering
- **Format version 2**: `.mapwright` files automatically migrated from v1 → v2 on load; `cell.prop` entries extracted into the overlay array and deleted
- **`cell.prop` fully removed**: The overlay is the sole source of truth — no dual-write, no cell-level prop storage. All API methods, rendering, lighting, and spatial queries read from `metadata.props[]`
- **App version stamped**: `.mapwright` files now include `metadata.createdWith` with the Mapwright version that last saved them

#### Free-Form Placement

- **Arbitrary rotation**: Props can be rotated to any angle (0–359°), not just 90° increments
- **Scaling**: Props can be scaled from 25% to 400% (`0.25x` to `4.0x`)
- **Freeform placement**: `Ctrl+Click` places props at exact cursor position (sub-cell precision); `Ctrl+Drag` moves props with sub-cell precision
- **Arrow key nudge**: `↑↓←→` nudges selected props by 1 foot; `Shift+↑↓←→` nudges by 1 full cell
- **Prop stacking**: Overlapping props are allowed — z-order determines visual layering

#### Z-Order Controls

- `]` key brings selected prop forward, `[` sends backward
- Z-order presets: `"floor"` (0), `"furniture"` (10), `"tall"` (20), `"hanging"` (30)
- API: `setPropZIndex(propId, zOrPreset)`, `bringForward(propId)`, `sendBackward(propId)`

#### Scroll-Wheel Controls

- `Alt+Scroll`: Fine rotation in 15° increments
- `Alt+Shift+Scroll`: Scale up/down in 0.1x increments
- Undo history debounced at 500ms — one undo reverses the entire scroll gesture
- Multi-prop: scroll-wheel rotation orbits props around the group's center pivot; scaling maintains relative prop distances

#### Multi-Prop Group Transforms

- **Group rotation** (R key or Alt+Scroll): props orbit around the group center while each prop also rotates individually
- **Group scaling** (Alt+Shift+Scroll): props scale individually while positions adjust to maintain relative distances from group center
- **Box-select**: drag from empty space selects all props whose visual bounds overlap the rectangle
- **Multi-drag**: click and drag any prop in a multi-selection to move the entire group, preserving relative positions and freeform offsets

#### Pixel-Perfect Hit Testing

- Hover and click detection uses geometric shape testing against prop draw commands (circles, rects, polygons) — not bounding boxes
- Shadows are excluded from hit testing — only actual prop art is clickable
- When props overlap, the smallest prop at the cursor position is preferred (most specific target)

#### API Enhancements

- `placeProp(row, col, type, facing, options)` now accepts `{ scale, zIndex, allowOverlap, x, y }` options
- `rotateProp(row, col, degrees)` accepts arbitrary degree values (default 90)
- `suggestPropPosition(roomLabel, propType)` — smart placement helper using prop `placement` metadata

#### Rendering

- Overlay renderer sorts by z-index before drawing
- Grid-aligned props at scale 1.0 reuse the tile cache for performance
- Arbitrary rotation and scale use canvas transforms (`save/translate/rotate/scale/restore`)
- Light-blocking segments computed from overlay props with full rotation and scale support

### Prop Library Audit & Expansion (164 → 196 props)

Holistic quality pass across the entire prop library — visual audit via Puppeteer screenshots, consistency fixes, and 32 new props.

#### Light Associations

Props that visually emit light now automatically place a light when used: floor-candelabra (candle), signal-fire (bonfire), lava-pool (lava-glow), lighthouse-lens (bright), necrotic-altar (necrotic), magic-circle (eldritch-glow), ritual-circle (infernal-flame), oven (fireplace).

#### Metadata & Drawing Fixes

- **statue**: now blocks light (tall solid object)
- **brazier**: swapped `rusty_metal` → `metal_plate` (no longer looks woody at small scale)
- **fountain**: recategorized Misc → Features
- **fireplace**: recategorized Kitchen → Furniture
- **altar**: fixed bare `fill 0.5` → explicit bone-white color
- **chair**: added shadow + leg shadow dots
- **bookshelf**: added colored book-spine rectangles across 3 shelves
- **lamp-post**: redrawn as ornate city lamp with octagonal pedestal (now distinct from lantern-post)

#### New Props — General (16)

bar-counter, keg, hay-bale, stable-partition, ladder, trapdoor, vanity-table, nightstand, wash-basin, cooking-spit, planter-box, organ, cage-large, well-windlass, dartboard, long-table

#### New Props — Trees & Nature (16)

Reworked the tree prop from a flat opaque disc to overlapping semi-transparent canopy lobes — floor shows through gaps. Added 4 tree variants and 12 nature/forest props.

- **Trees**: pine-tree, willow-tree, palm-tree, tree-small
- **Nature**: flowers, flower-patch, tall-grass, bush, fern, pond, lily-pads, reed-bed, bramble, moss-patch, log-pile, roots

### Clipboard Enhancements

- **Cut (Ctrl+X)** for cells (Select tool) and props (Prop tool) — copies to clipboard and deletes originals in one action
- **Light copy/cut/paste** — Ctrl+C copies the selected light, Ctrl+X cuts it, Ctrl+V enters paste mode with a radius/cone preview following the cursor; click to place, Shift+click to snap to grid

### Bug Fixes

- Loading a new map now fully invalidates all render caches (geometry, fluid, blend, floor, cell-edges, prop spatial hash) — fixes stale rendering artifacts when switching between maps
- Prop placement, movement, and deletion now always invalidate the lighting cache — fixes stale shadows from `blocksLight` props
- Right-click during drag or paste mode cancels the action instead of deleting props
- Fixed rotation direction mismatch between tile cache path and canvas transform path for non-grid-aligned angles

---

## v0.6.1

### Architecture Refactor

- Split `editor-api.js` (3083 lines) into 18 focused modules under `src/editor/js/api/` — each API category (cells, walls, props, spatial queries, lighting, etc.) is now its own file
- Standardized all API return values to `{ success: true, ...data }` / `{ success: false, error }` for consistent error handling
- Split `metadata.js` panel (1019 lines) into core settings (385 lines) + extracted theme editor (644 lines)
- Extracted `traceArcWedge()` helper in render.js to deduplicate arc void clip geometry
- Named all hardcoded rendering constants (rough wall spacing, buffer shading depth, compass rose size, etc.) across 5 render files

### Performance

- Added viewport culling to the editor canvas — walls, borders, and props outside the visible area are skipped during rendering, improving performance on large maps when zoomed in
- Replaced O(n²) prop collision detection with a spatial hash map — prop placement, hover, and bulk operations now use O(1) lookups instead of scanning a 4-cell search radius per footprint cell
- Added spatial grid acceleration to lighting raycasting — `computeVisibility()` now uses DDA grid traversal to test only wall segments along each ray path instead of scanning all segments linearly

### Error Reporting

- Added render warnings system (`src/render/warnings.js`) — collects deduplicated warnings during rendering and surfaces them as toast notifications in the editor
- Prop catalog and texture catalog load failures now show toast notifications instead of silently returning empty catalogs
- Unknown prop types and malformed prop light JSON now produce visible warnings instead of being silently skipped
- Bridge render errors now include bridge ID in the warning message

### Save Format

- Added `.mapwright` format versioning — save files now include a `formatVersion` field with migration support for future format changes
- Existing files without a version are treated as v0 and automatically migrated

### Testing

- Added Vitest test suite: 611 tests across 19 files covering API methods, spatial queries, utilities, and migrations
- Added visual snapshot tests — renders example maps via `@napi-rs/canvas` and compares against golden PNGs with `pixelmatch` (catches rendering regressions without a browser)
- Added E2E tests — full pipeline tests (create → save → load → modify → export) and room template validation via Puppeteer bridge
- Expanded GitHub Actions CI to run unit, snapshot, and E2E tests in parallel
- Added `npm run test:render` and `npm run test:e2e` scripts with separate Vitest configs

### Removed

- Removed the `.map` ASCII text format entirely — the editor API with `planBrief` fully supersedes it
- Removed `src/compile/` pipeline (parser, compiler, grid, trims, features, constants)
- Removed `tools/build_map.js`, `tools/compile_map.js` CLI tools
- Removed `importMapText`, `exportToMapFormat` API methods
- Removed `.map` export button from the editor UI
- Removed `build_map` MCP tool and `mapwright://map-format` resource

---

## v0.6.0

### `.mapwright` File Format

- Dungeon maps now save as `.mapwright` instead of `.json` — a custom file extension tied to the application
- Map data is minified (no whitespace) for smaller file sizes
- All tools accept both `.mapwright` and `.json` for backwards compatibility

### Windows Installer with File Association

- New NSIS installer build alongside the existing portable exe
- Installing via the installer registers `.mapwright` files with Windows — double-click to open directly in Mapwright
- Single-instance lock: opening a second `.mapwright` file loads it in the existing window
- macOS: `open-file` event support for Finder integration

### Auto-Update (Installer Only)

- NSIS installs check for updates on launch via `electron-updater`
- Native dialog prompts to download and restart when a new version is available
- Portable builds retain the existing toolbar link to the GitHub release page

### Editor Improvements

- Taskbar and title bar now show the Mapwright icon instead of the default Electron icon
- `Ctrl+Shift+S` keyboard shortcut for Save As

---

## v0.5.0

### Bulk Prop Placement API

Four new methods for placing props at scale without manual coordinate loops:

- `fillWallWithProps` — line a wall with repeated props (bookshelves, torch-sconces); auto-computes facing per wall
- `lineProps` — place props in a straight line (pillar colonnades, pew rows)
- `scatterProps` — randomly scatter props across a room (rubble, mushrooms, bone piles)
- `clusterProps` — place a furniture grouping at relative offsets from an anchor (desk + chair + book-pile)

### Prop Placement Metadata

All 171 props now carry placement metadata in their `.prop` headers:

| Field | Purpose |
|-------|---------|
| `placement` | Where the prop goes: `wall`, `corner`, `center`, `floor`, `any` |
| `room_types` | Which room types it belongs in (e.g. `library, study, wizard-sanctum`) |
| `typical_count` | How many per room: `single`, `few`, `many` |
| `clusters_with` | Props it commonly groups with |
| `notes` | Free-text placement guidance |

New query methods:
- `getPropsForRoomType(roomType)` — find all props tagged for a room type
- `listProps()` now includes all metadata fields

### New Editor API Methods

- `getFullMapInfo` — comprehensive map snapshot (rooms with bounds, all props, doors, lights, stairs, bridges)
- `defineLevels` — set level boundaries on existing rows without adding new ones
- `partitionRoom` — add internal wall partitions across a room with optional door
- `validateDoorClearance` — check for props blocking door cells or approach cells
- `validateConnectivity` — BFS reachability check from entrance to all rooms

### Room Design Guide (`DESIGN.md`)

New design reference covering room semantic library (20+ room types with prop/fill/lighting specs), universal spatial rules, prop density guide, lighting design, multi-agent pipeline, and anti-patterns.

### Room Templates

Seven ready-to-run JSON templates in `room-templates/`: throne room, alchemist's lab, forge, crypt, temple, wizard's sanctum, prison block.

---

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
