# Prop Ideas — Missing from Catalog

Generated from 160 room vocab specs in `src/rooms/`. These are prop names referenced by specs but not found in the current `src/props/` catalog. Author in priority order — Tier 1 unlocks the most rooms per prop created.

**Original totals (pre-v0.11.0):** 1177 missing  |  Tier 1 (3+ uses): 105  |  Tier 2 (2 uses): 150  |  Tier 3 (1 use): 922
**Current totals:** 313 missing  |  Tier 1: 3 (aliases only)  |  Tier 2: 0 (complete)  |  Tier 3: 310
**Catalog size:** 1119 props

---

## Progress log

### 2026-04 (v0.11.0)

- **~874 props authored** across ten batches + follow-up fixes. Catalog grew from ~245 to **1119 props**.
- **Tier 1: complete.** Remaining 3 are aliases / non-drawable concepts — specs should be updated to use canonical names:
  - `counter` → use `bar-counter` with `counter-corner` for L/U-shaped counters.
  - `bookshelf-short` → use `bookshelf`.
  - `rat-swarm-marker` is a *concept*, not a prop — remove from specs or replace with a real object like `rat` or `rat-skeleton`.
- **Tier 2: complete.** 0 props remaining.
- **Tier 3: 310 remaining** (down from 922). Batch 10 added 208 props across 28 room settings — campsite-traveler, charcoal-burner-camp, ruined-watchtower, oubliette, interrogation-room, shadowfell-mausoleum, infernal-court, fey-glade, celestial-vault, spider-lair, bog-witch-hut, noble-bedchamber, mansion-library, workshop-artificer, refinery, ship-galley, ship-captains-cabin, ship-cargo-hold, farmhouse-common, apartment-tenement, library, command-room, brewery, cooperage, tunnel-mine-worked, cistern, smithy-large, elemental-earth-node, market-square, chasm-crossing. `rope-bridge` was deleted (duplicates the built-in bridge tool).
- **Perspective rules expanded** in `src/props/CLAUDE.md` — now covers columns/pillars/obelisks (square footprint, radial decoration), overhead-hanging/strung props, stuck/embedded weapons, cave mouths, fire columns (concentric rings), tileable/modular props (channels, tracks). Read those sections before authoring tall verticals, anything that hangs from above, or anything meant to tile.
- **Batch-7 footprint correction** — 12 props (bubble/coral/cloud/flame/basalt/pearl-obelisk/obelisk-astral/portal-stela/silver-cord-pylon/pillar-floating and kelp variants) were originally authored at `2x1` but `2x1` is for ground-elongated objects, not tall columns. They were rewritten to `1x1` or `2x2` with proper top-down artwork.
- **Showcase PNGs** — `prop-showcase-v0.11.0-batch{3,4,5,6,7,8,9}.png` each show a labeled grid of the props authored in that batch for visual review.

**Workflow for picking this back up:**

1. Regenerate the raw report: `node tools/_scan-missing-props.cjs` (rescans room specs, cross-references `src/props/`, writes fresh `_missing-props-report.json`).
2. Regenerate the tables below: `node tools/_gen-prop-ideas.cjs`.
3. Identify a cluster of ~20–50 props around a common room theme (see `bySpec` grouping at bottom of `_scan-missing-props.cjs` output for ideas), author in parallel agents.

---

## Context for future sessions (read this first)

This is a living worklist, not a spec to execute blindly. Read these notes before authoring anything.

### Why this file exists

When a room vocab spec lists a prop in `primary_palette` / `secondary_palette` / `scatter_palette` and Claude picks it during map generation, `placeProp` will fail if the prop doesn't exist. The visible symptom is usually a room that renders emptier than intended — the prop is silently skipped. Authoring the missing props directly improves output quality for every future map build.

### Before authoring ANY prop, read:

- **`mapwright/src/props/CLAUDE.md`** — the full prop creation guide. Non-obvious rules: top-down bird's-eye perspective (not side view), `footprint: RxC` means rows × cols (not W×H), `x` is cols / `y` is rows with origin top-left, facing-yes props have wall at north (low Y) / front at south (high Y), use `metal_plate` not `rusty_metal` for things that should read as clean metal.
- **An existing prop in the same category.** Don't invent style in a vacuum. Match layering (texfill + matching stroke), opacity (0.85 sweet spot), and detail density (10–25 commands for a 1×1). The user's standing rule is: *"compare quality side-by-side against neighbors in the same category. 3–5 revisions is normal."*

### User's standing guidance for prop work

From earlier sessions (feedback memory, confirmed multiple times):

- **Creative freedom is granted.** Don't ask permission before inventing a new prop's visual style.
- **Token budget is not a constraint. Thoroughness is.** The user explicitly said "spend the tokens, take the time, make a good prop." Don't cut corners to save context.
- **Don't check or start the mapwright server for prop design.** The user verifies visually themselves.
- **Don't take Puppeteer screenshots for verification during initial prop design.** Author the `.prop` file, leave it; the user will review visually.
- **Agents are the preferred workflow for prop creation.** Spin off parallel `general-purpose` agents with a detailed brief + reference props. Saves main-context tokens. Use background mode.
- **Full prop treatment every time** — footprint, hitbox (if non-trivial), shadow, `blocks_light`, `height`, `lights:` if it glows, `placement`, `room_types`, `typical_count`, `clusters_with`, and `notes`. Don't skip metadata fields.
- **Do not generate raster/PNG props.** Vector primitives only (rect/circle/line/poly/arc/ring/bezier/texfill/cutout/clip-begin). Raster props look uncanny next to vectors.

### Recommended workflow (when picking this back up)

1. **Triage first — don't author blindly.** Not all 1177 entries deserve a new prop. Three outcomes per entry:
   - **Remap** → existing prop covers it. See the alias table below; there are more to find. Example: `fireplace` should be `hearth`. Updating specs is cheaper than authoring duplicates.
   - **Merge** → two invented names refer to the same thing (e.g. `empty-bottle` / `bottle-empty` / `bottle`). Pick one canonical name, update the specs that use variants.
   - **Author** → genuinely new prop, not covered elsewhere.
2. **Batch by aesthetic theme, not by usage count alone.** `ledger-stack` + `inkwell` + `quill` + `wax-seal` are one scribe-desk batch — author them together so the visual language is consistent. `ingot-stack` + `slag-heap` + `tool-rack` + `leather-apron` is one smithy batch. Thematic batches produce better cohesion than priority order.
3. **After authoring**: run `node mapwright/tools/validate-props.js` (bounds check) and `node mapwright/tools/update-manifest.js` (regenerate `src/props/manifest.json`).
4. **After remapping specs to use canonical names**: regenerate this file with `node tools/_gen-prop-ideas.cjs` so the tiers reflect the current state.

### Designing a prop — checklist

Before writing draw commands, for each missing prop:

1. **Read the specs that use it** — paths are in the tables below. They tell you the aesthetic context. A `ledger-stack` in `counting-house` wants different detail than in `thieves-guild-hideout` (same object, different vibe — but one prop should work for both; lean toward neutral detail).
2. **Pick the closest existing prop as your reference.** `ledger-stack` → look at `book-pile`. `ingot-stack` → look at `crate-stack`. `tool-rack` → look at `weapon-rack`. Match style, don't reinvent.
3. **Light-emitters need `lights:` in frontmatter.** If the prop obviously glows (brazier variants, forge variants, fires, magical glows), include a `lights:` entry so `placeProp` auto-adds the point light. Reference `brazier.prop` or `forge.prop` for the JSON format.
4. **Decide `placement` correctly.** Wall-mounted → `placement: wall` (bookshelf, tool-rack, shield-rack). Corner → `placement: corner`. Centerpiece → `placement: center` (throne-dais, magic-circle, fountain). Floor scatter → `placement: floor`. This drives `fillWallWithProps`, `searchProps({placement:...})`, and auto-furnish behavior.
5. **`room_types` matters.** This is how `getPropsForRoomType` discovers the prop. Pull tags from the specs that use it (each `.room.json` has a `tags` array — use those).
6. **`clusters_with` signals grouping.** A tankard clusters with bar-counter, bench, stool. A ledger-stack clusters with desk, inkwell, quill. `clusterProps` and auto-furnish use this.

### What to ignore

- **Tier 3 (922 long-tail props)**: Most of these are one-off flavor. Skip unless:
  - You're about to build the room that needs it, or
  - The name reveals an obvious gap (e.g. `potbelly-stove` is arguably worth making — it appears once but adds real value), or
  - It's a natural variant of a Tier 1 author (e.g. while making `ledger-stack`, making `ledger-open` is cheap).
- **Names that don't describe a physical object.** Some agents invented "markers" or states — `rat-swarm-marker`, `mineral-vein-prop`, `shaft-light-from-above`, `residual-torch-from-victims`. These are *concepts*, not drawable props. Remove them from the specs or replace with real objects.
- **Texture IDs that leaked in as prop names.** A few entries like `marble_floor_cracked` or `grass_medium` are actually polyhaven texture references that ended up in prop slots. Fix the spec — move them to `texture_options.floor` instead.

### File locations (pre-cached for convenience)

- Room specs: `mapwright/src/rooms/<category>/*.room.json`
- Existing props: `mapwright/src/props/*.prop`
- Prop creation guide: `mapwright/src/props/CLAUDE.md`
- Missing-props raw data: `mapwright/src/rooms/_missing-props-report.json`
- Report regenerator: `mapwright/tools/_gen-prop-ideas.cjs`
- Manifest update: `mapwright/tools/update-manifest.js`
- Validator: `mapwright/tools/validate-props.js`
- Design reference: `mapwright/DESIGN.md` (spatial rules, lighting, anti-patterns — not prop format)

### Quality bar (from prior sessions)

The user accepted these as the standard:

- A good prop looks correct at zoom levels from thumbnail (32px) to close-up (256px+). Details below 0.03 radius or 0.15 opacity are invisible — don't waste commands on them (see prop CLAUDE.md "Minimum Visible Size Reference").
- Don't substitute "close enough" when the room description calls for a specific object. That's the whole reason this list exists.
- **Don't add eslint-disable or hack around errors.** Prop files aren't linted, but the principle carries: fix the root cause of a visual issue, don't mask it.

---

## Known aliases / remap-before-creating

Some missing names already exist under a different ID. Remap specs rather than create duplicates:

| Missing name | Existing prop to use |
|---|---|
| `counter` | `bar-counter` (use with `counter-corner` for L/U-shaped counters) |
| `fireplace` | `hearth` (same thing — hearth is the canonical name) |
| `bookshelf-tall` / `bookshelf-short` | `bookshelf` |
| `bowl` / `wooden-bowl` | check for substitute in existing scatter props |
| `tree-old` / `ancient-tree` | `tree` (consider variants later) |
| `standing-stone` | author new — distinct from `obelisk` (smaller, more organic) |

When a spec author used an alias, update the spec to use the canonical name — don't create a duplicate prop.

---

## Tier 1 — High priority (used in 3+ specs)

Each prop here unlocks multiple room types. Author these first.

| Prop | Uses | Rooms |
|------|------|-------|
| `counter` | 11 | bakery, butcher-shop, counting-house +8 more |
| `rat-swarm-marker` | 6 | cave-goblin-warren, dock-warehouse, oubliette +3 more |
| `bookshelf-short` | 3 | library, lighthouse-keepers-room, ship-captains-cabin |

---

## Tier 2 — Medium priority (used in 2 specs)

| Prop | Rooms |
|------|-------|

---

## Tier 3 — Long tail (used in 1 spec each)

Flavor props. Only author when building the specific room that needs them, or if they fit a broader aesthetic worth supporting.

| Prop | Room |
|------|------|
| `abacus` | counting-house |
| `ancient-tree` | druid-grove |
| `animal-pen-partition` | peasant-hovel |
| `antler-rack` | cabin-hunters |
| `apron-floured` | bakery |
| `arena-pit` | boss-chamber |
| `arrow-slit-wall` | gatehouse-inner |
| `baptismal-pool` | baptistry |
| `basket` | textile-loomhouse |
| `bed-small` | house-small |
| `bell-small` | shrine-roadside |
| `bench-long` | ship-crew-quarters |
| `blanket-folded` | shop-general |
| `blood-basin` | ritual-chamber-dark |
| `bloodstain-large` | boss-chamber |
| `blotting-rag` | scriptorium-mundane |
| `bobbin` | textile-loomhouse |
| `bone-chandelier` | ossuary |
| `bone-specimen` | shop-apothecary |
| `boots-by-bed` | barracks |
| `boots-discarded` | ship-crew-quarters |
| `bottle-empty` | cave-bandit-camp |
| `bowl` | monastery-refectory |
| `bowl-of-stew` | mess-hall |
| `branding-iron` | torture-chamber |
| `brazier-small` | ship-brig |
| `bread-crust` | shepherds-shelter |
| `bridge-wood` | sewer-junction |
| `broadsheet-posted` | plaza-civic |
| `broken-antler` | cave-bear-lair |
| `broken-plate` | servants-kitchen |
| `broken-statue` | corrupted-temple |
| `broken-stool` | tavern-common |
| `brush-blind` | scouts-blind |
| `bundle-of-herbs` | house-small |
| `butterfly-cloud` | forest-clearing |
| `cabin-window-glow` | ferry-house |
| `cage-wicker` | cave-goblin-warren |
| `candle-bundle` | shop-general |
| `card-table` | gambling-den |
| `cargo-scale` | dock-warehouse |
| `carved-stick` | shepherds-shelter |
| `cat-hunting` | butcher-shop |
| `chain-shackle` | courthouse-chamber |
| `chalk-circle-floor` | cabin-witch |
| `chalk-marks` | ritual-chamber |
| `chamber-pot` | mansion-servants-quarters |
| `chess-set` | noble-solar |
| `chest-small` | hermit-cell |
| `chest-wooden` | house-small |
| `chicken-bone` | cave-bandit-camp |
| `chicken-loose` | peasant-hovel |
| `child's-toy` | house-small |
| `chips-stack` | gambling-den |
| `cigar-case` | tavern-highend |
| `claw-marked-wall` | cave-bear-lair |
| `clay-cup` | house-small |
| `clerestory-window` | dock-warehouse |
| `clerk-desk` | courthouse-chamber |
| `clock-tower-base` | plaza-civic |
| `clothes-rack` | mansion-servants-quarters |
| `coal-pile` | forge |
| `coin-spill` | treasure-vault |
| `confessional-booth` | confessional |
| `contraband-stash` | dock-warehouse |
| `cook-spit` | cave-goblin-warren |
| `cooking-tripod` | ranger-camp |
| `crate-splintered` | cabin-abandoned |
| `crow-perched` | roadside-gallows |
| `crown-on-cushion` | treasure-vault |
| `crypt-entrance` | graveyard-village |
| `crystal-cluster-large` | crystal-grotto |
| `crystal-dust` | crystal-grotto |
| `crystal-heart` | crystal-grotto |
| `curtain-screen` | confessional |
| `cutlery-pile` | mess-hall |
| `dart-board` | tavern-common |
| `decaying-log` | mushroom-grove |
| `dice-pile` | cave-bandit-camp |
| `dice-table` | gambling-den |
| `dog-chain` | lumberyard |
| `dog-sleeping` | inn-common-room |
| `dried-flowers` | shrine-roadside |
| `dried-lizard` | shop-apothecary |
| `driftwood` | ferry-house |
| `dropped-rope` | roadside-gallows |
| `dry-leaves` | cabin-abandoned |
| `drying-shelf` | house-medium-artisan |
| `dye-vat` | textile-loomhouse |
| `embroidery-frame` | noble-solar |
| `fainting-couch` | brothel-parlor |
| `fallen-tool` | cabin-abandoned |
| `family-portrait-small` | house-medium-family |
| `fence-wood-low` | roadside-gallows |
| `ferry-cabin` | ferry-house |
| `ferry-raft` | ferry-house |
| `fire-ring` | shepherds-shelter |
| `firepit-central` | peasant-hovel |
| `fish-bucket` | ferry-house |
| `flour-bag` | servants-kitchen |
| `footlocker` | barracks |
| `forge-altar` | temple-of-craft |
| `fortune-wheel` | gambling-den |
| `fruit-rotten` | shrine-roadside |
| `fume-hood` | alchemy-lab |
| `fur-nest` | cave-bear-lair |
| `fur-rug` | hunting-lodge-large |
| `gallows-triple` | roadside-gallows |
| `gauntlet-pile` | armory |
| `gear-locker` | ship-crew-quarters |
| `gem-cluster` | treasure-vault |
| `glove-silk` | tavern-highend |
| `glowcap-cluster` | mushroom-grove |
| `goblin-totem` | cave-goblin-warren |
| `great-hearth` | hunting-lodge-large |
| `half-finished-work` | house-medium-artisan |
| `hammer-giant` | infernal-forge |
| `harp-floor` | noble-solar |
| `hat-tricorn` | tavern-highend |
| `horse-dung` | toll-bridge-house |
| `horseshoe` | general-workshop |
| `hot-iron` | torture-chamber |
| `hunting-horn` | hunting-lodge-large |
| `infernal-furnace` | infernal-forge |
| `ingot-pile` | temple-of-craft |
| `ink-pot-small` | scouts-blind |
| `ink-stone` | scriptorium-mundane |
| `interrogation-chair` | ship-brig |
| `iron-cage-cell` | ship-brig |
| `iron-chair` | throne-room |
| `jeweler-bench` | shop-jeweler |
| `jewelry-loose` | thieves-guild-hideout |
| `judge-bench` | courthouse-chamber |
| `kennel` | hunting-lodge-large |
| `knife-on-block` | servants-kitchen |
| `knit-blanket` | lighthouse-keepers-room |
| `knitting-pile` | house-medium-family |
| `ladder-library` | shop-bookseller |
| `lantern` | gatehouse-inner |
| `lantern-hand` | shop-general |
| `lean-to` | ranger-camp |
| `leather-strap` | shop-weaponsmith |
| `letter-home` | mansion-servants-quarters |
| `lint-clump` | textile-loomhouse |
| `lockpicks` | thieves-guild-hideout |
| `log-carriage` | mill-lumber |
| `loom-altar` | temple-of-craft |
| `loot-pile` | cave-bandit-camp |
| `luminous-spore` | mushroom-grove |
| `magic-sigil-floor` | throne-room |
| `magical-glow-prop` | alchemy-lab |
| `magnifier` | shop-jeweler |
| `mask-cloth` | thieves-guild-hideout |
| `mask-feathered` | brothel-parlor |
| `meat-hook-rack` | butcher-shop |
| `mess-table-folding` | ship-crew-quarters |
| `millstone` | mill-grain |
| `mosaic-fragment` | ancient-ruin-overgrown |
| `mound-entrance` | burial-mound |
| `muddy-boot-prints` | hunting-lodge-large |
| `mug` | monastery-refectory |
| `murder-hole-grate` | gatehouse-inner |
| `mushroom-basket` | cabin-witch |
| `mycelium-web` | mushroom-grove |
| `myconid-circle` | mushroom-cavern |
| `nail-pile` | general-workshop |
| `nails-box` | shop-general |
| `oil-reservoir` | lighthouse-keepers-room |
| `oracle-pit` | oracle-chamber |
| `overturned-table` | cabin-abandoned |
| `paperweight` | mansion-study |
| `pearl-strand` | shop-jeweler |
| `pedestal` | treasure-vault |
| `peel-wooden` | bakery |
| `pelt-roll` | cabin-hunters |
| `pelt-stack` | cabin-trapper |
| `personal-chest` | barracks |
| `pianoforte` | house-noble-townhouse |
| `pigeon-flock` | plaza-civic |
| `pillar-crystal` | crystal-grotto |
| `pincers` | torture-chamber |
| `pipe-ashtray` | mansion-study |
| `pit-saw` | mill-lumber |
| `plate-stack` | mess-hall |
| `polish-rag` | shop-weaponsmith |
| `poppet` | cabin-witch |
| `potbelly-stove` | lighthouse-keepers-room |
| `potion-bottle` | shop-apothecary |
| `prayer-beads` | house-medium-family |
| `prayer-flag` | shrine-roadside |
| `printing-press` | scriptorium-mundane |
| `prisoner-dock` | courthouse-chamber |
| `private-booth` | gambling-den |
| `quench-trough-blood` | infernal-forge |
| `quill-pen` | scriptorium-dark |
| `rabbit-trail` | forest-clearing |
| `rat-sign` | mill-grain |
| `ration-pack` | cabin-hunters |
| `raven-perch` | cabin-witch |
| `raven-perched` | graveyard-village |
| `ravens-feather` | burial-mound |
| `resonance-pool` | crystal-grotto |
| `ring-display` | shop-jeweler |
| `ritual-candle` | standing-stones-circle |
| `rolled-blanket` | house-small |
| `rolling-pin` | bakery |
| `root-tangle` | mushroom-cavern |
| `rope-cordon` | plaza-civic |
| `round-table` | sanctum-order |
| `sack-pile` | mill-grain |
| `salt-barrel` | butcher-shop |
| `sand-shaker` | scriptorium-mundane |
| `sausage-link` | butcher-shop |
| `sawmill-blade` | mill-lumber |
| `scabbard-empty` | shop-weaponsmith |
| `scale-justice` | courthouse-chamber |
| `scoop-wooden` | mill-grain |
| `scorched-cell` | boss-chamber |
| `scratch-marks` | prison-block |
| `scratched-tally` | ship-brig |
| `scrying-crystal` | crystal-grotto |
| `sealing-wax` | mansion-study |
| `servant-uniform-hung` | mansion-servants-quarters |
| `settee` | house-noble-townhouse |
| `sewing-kit-small` | mansion-servants-quarters |
| `shattered-shield` | boss-chamber |
| `sheep-dung` | shepherds-shelter |
| `shelf-crockery` | farmhouse-kitchen |
| `shelf-tools` | house-medium-artisan |
| `shepherds-crook` | shepherds-shelter |
| `shovel-leaning` | graveyard-village |
| `shrieker` | mushroom-cavern |
| `signal-bell` | ferry-house |
| `signal-gong` | underdark-outpost |
| `silver-tray` | tavern-highend |
| `skull-offering` | ritual-chamber |
| `slug-trail` | mushroom-grove |
| `small-bone` | cave-living |
| `snare-set` | ranger-camp |
| `snuffbox` | house-noble-townhouse |
| `soot-streak` | infernal-forge |
| `specimen-tank` | alchemy-lab |
| `spilled-flour-sack` | cabin-abandoned |
| `spilled-reagent` | alchemy-lab |
| `spilled-salt` | ritual-chamber |
| `spindle-rack` | house-medium-artisan |
| `spore-pool` | mushroom-cavern |
| `spore-puff` | mushroom-cavern |
| `spore-puffball` | mushroom-grove |
| `spyglass-tripod` | scouts-blind |
| `staircase-wooden` | tavern-common |
| `stalagmite-forest` | cave-living |
| `statue-dark-god` | dark-temple |
| `statue-small` | shrine-roadside |
| `statue-toppled` | ancient-ruin-overgrown |
| `statue-weeping` | graveyard-village |
| `stone-column-broken` | ancient-ruin-overgrown |
| `stool-bar` | tavern-common |
| `stool-wooden` | ship-brig |
| `strange-residue` | alchemy-lab |
| `straw-wisps` | peasant-hovel |
| `strigil` | bath-house |
| `summoning-pool-glow` | boss-chamber |
| `sun-window` | noble-solar |
| `supply-cache` | underdark-outpost |
| `table-long` | tavern-common |
| `table-round` | tavern-common |
| `tally-stick` | dock-warehouse |
| `tapestry-dark` | dark-temple |
| `thread-rack` | textile-loomhouse |
| `threadbare-rug` | mansion-servants-quarters |
| `tobacco-pipe` | lighthouse-keepers-room |
| `toll-barrier` | toll-bridge-house |
| `toll-house` | toll-bridge-house |
| `tongs` | general-workshop |
| `tool-rack-wall` | house-medium-artisan |
| `tool-scatter` | house-medium-artisan |
| `tooth-jar` | torture-chamber |
| `torn-notice` | roadside-gallows |
| `torn-page` | ritual-chamber |
| `torture-instrument-small` | prison-block |
| `trash-heap` | cave-goblin-warren |
| `travel-pack` | inn-common-room |
| `tree-old` | druid-grove |
| `trunk-open` | cabin-abandoned |
| `turnip-pile` | peasant-hovel |
| `tweezers` | shop-jeweler |
| `type-case` | scriptorium-mundane |
| `urn` | crypt |
| `vase-floor` | house-noble-townhouse |
| `velvet-cloth` | shop-jeweler |
| `vine-hanging` | ancient-ruin-overgrown |
| `violet-fungus` | mushroom-cavern |
| `wagon` | lumberyard |
| `walking-stick` | inn-common-room |
| `watchfire-pit` | underdark-outpost |
| `water-jar` | bath-house |
| `water-skin` | charcoal-burner-camp |
| `weapon-rack-ceremonial` | throne-room |
| `weapon-rack-infernal` | infernal-forge |
| `whittled-stick` | ranger-camp |
| `wildflower-patch` | druid-grove |
| `winch-block` | dock-warehouse |
| `winch-mechanism` | gatehouse-inner |
| `wind-chime-pillar` | elemental-shrine |
| `window-seat` | noble-solar |
| `witness-dock` | courthouse-chamber |
| `wood-shavings` | general-workshop |
| `wooden-spoon-pile` | farmhouse-kitchen |
| `work-in-progress` | general-workshop |
