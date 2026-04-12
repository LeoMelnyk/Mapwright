# Prop Ideas — Missing from Catalog

Generated from 160 room vocab specs in `src/rooms/`. These are prop names referenced by specs but not found in the current `src/props/` catalog. Author in priority order — Tier 1 unlocks the most rooms per prop created.

**Total missing:** 1177  |  **Tier 1 (3+ uses):** 105  |  **Tier 2 (2 uses):** 150  |  **Tier 3 (1 use):** 922

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
| `bedroll` | 16 | barracks, cabin-abandoned, cabin-hunters +13 more |
| `ledger-stack` | 14 | armory, brewery, counting-house +11 more |
| `cat-sleeping` | 12 | bakery, farmhouse-common, house-medium-artisan +9 more |
| `shelf-open` | 12 | bakery, bath-house, butcher-shop +9 more |
| `counter` | 11 | bakery, butcher-shop, counting-house +8 more |
| `fallen-leaves` | 11 | ancient-ruin-overgrown, burial-mound, charcoal-burner-camp +8 more |
| `rag-pile` | 11 | cave-goblin-warren, chasm-crossing, oubliette +8 more |
| `bread-loaf` | 10 | bakery, farmhouse-common, house-medium-artisan +7 more |
| `quill` | 10 | bardic-hall, counting-house, courthouse-chamber +7 more |
| `scale` | 10 | bakery, butcher-shop, counting-house +7 more |
| `bucket` | 9 | dock-warehouse, guard-post, prison-block +6 more |
| `playing-cards` | 9 | barracks, brothel-parlor, cave-bandit-camp +6 more |
| `tankard` | 9 | brewery, gambling-den, inn-common-room +6 more |
| `tool-rack` | 9 | cooperage, forge, general-workshop +6 more |
| `coin-pile` | 8 | bakery, counting-house, gambling-den +5 more |
| `tapestry` | 8 | crypt, mansion-ballroom, mansion-dining +5 more |
| `ash-pile` | 7 | cave-bandit-camp, charcoal-burner-camp, elemental-fire-node +4 more |
| `broom` | 7 | brewery, farmhouse-common, house-small +4 more |
| `dice-cup` | 7 | barracks, gambling-den, gatehouse-inner +4 more |
| `inkwell` | 7 | counting-house, courthouse-chamber, guildhall +4 more |
| `candle-dipped` | 6 | alchemy-lab, house-small, library +3 more |
| `dried-herbs` | 6 | alchemy-lab, cabin-hunters, cabin-trapper +3 more |
| `ingot-stack` | 6 | forge, foundry-great, general-workshop +3 more |
| `leather-apron` | 6 | cooperage, foundry-great, mill-lumber +3 more |
| `rat-swarm-marker` | 6 | cave-goblin-warren, dock-warehouse, oubliette +3 more |
| `torch-wall` | 6 | cave-bandit-camp, cave-goblin-warren, chasm-crossing +3 more |
| `coin-scatter` | 5 | cave-bandit-camp, ferry-house, goblin-warren-entrance +2 more |
| `empty-bottle` | 5 | barracks, campsite-traveler, graveyard-village +2 more |
| `oil-flask` | 5 | armory, cabin-hunters, cabin-trapper +2 more |
| `rocking-chair` | 5 | cabin-witch, farmhouse-common, house-medium-family +2 more |
| `sawdust-pile` | 5 | cooperage, dock-warehouse, house-medium-artisan +2 more |
| `slag-heap` | 5 | elemental-fire-node, forge, foundry-great +2 more |
| `spinning-wheel` | 5 | farmhouse-common, general-workshop, house-medium-family +2 more |
| `writing-desk` | 5 | house-merchant, house-noble-townhouse, library +2 more |
| `bread-heel` | 4 | apartment-tenement, bakery, peasant-hovel, tavern-common |
| `cairn-sacred` | 4 | burial-mound, druid-grove, shrine-roadside, standing-stones-circle |
| `chain-coil` | 4 | cistern, infernal-court, infernal-forge, torture-chamber |
| `chalk-mark` | 4 | cooperage, shop-tailor, textile-loomhouse, thieves-guild-hideout |
| `coin-purse` | 4 | brothel-parlor, house-merchant, market-stall, opium-den |
| `crystal-shard` | 4 | cabin-witch, crystal-grotto, elemental-earth-node, workshop-artificer |
| `decanter` | 4 | house-noble-townhouse, mansion-dining, mansion-study, noble-bedchamber |
| `dust-cloud` | 4 | mill-grain, mine-shaft-entrance, shop-apothecary, shop-bookseller |
| `gnawed-bone` | 4 | cave-bear-lair, goblin-warren-entrance, monster-lair-small, orc-war-camp |
| `lantern-floor` | 4 | cabin-hunters, library, mansion-servants-quarters, ruined-watchtower |
| `onion-braid` | 4 | farmhouse-kitchen, pantry, servants-kitchen, ship-galley |
| `pallet` | 4 | cabin-hunters, cabin-trapper, peasant-hovel, prison-block |
| `parchment-scrap` | 4 | scouts-blind, scriptorium-dark, scriptorium-mundane, toll-bridge-house |
| `quill-and-ink` | 4 | demiplane-laboratory, house-merchant, library, ship-captains-cabin |
| `ration-wrapper` | 4 | charcoal-burner-camp, ferry-house, scouts-blind, toll-bridge-house |
| `shelf` | 4 | apartment-tenement, farmhouse-common, house-medium-family, mansion-servants-quarters |
| `tuft-of-fur` | 4 | cave-bear-lair, hunting-lodge-large, orc-war-camp, shepherds-shelter |
| `wall-sconce` | 4 | mansion-ballroom, mansion-bedroom-master, noble-bedchamber, nursery |
| `water-jug` | 4 | cabin-hunters, cabin-trapper, house-medium-artisan, house-medium-family |
| `wax-seal` | 4 | counting-house, courthouse-chamber, guildhall, scriptorium-mundane |
| `wine-glass` | 4 | bardic-hall, brothel-parlor, mansion-ballroom, tavern-highend |
| `arrow-bundle` | 3 | armory, gatehouse-inner, shop-weaponsmith |
| `arrow-fletching` | 3 | hunting-lodge-large, ranger-camp, scouts-blind |
| `blood-smear` | 3 | butcher-shop, monster-lair-small, thieves-guild-hideout |
| `bone-marker` | 3 | burial-mound, druid-grove, standing-stones-circle |
| `bookshelf-short` | 3 | library, lighthouse-keepers-room, ship-captains-cabin |
| `broken-crate` | 3 | dock-warehouse, sewer-junction, ship-cargo-hold |
| `broken-shield` | 3 | battlefield-recent, monster-lair-small, orc-war-camp |
| `candle-stub` | 3 | apartment-tenement, mansion-servants-quarters, peasant-hovel |
| `chair-upholstered` | 3 | house-merchant, library, tavern-common |
| `chair-wooden` | 3 | house-merchant, house-small, tavern-common |
| `cheese-wheel` | 3 | farmhouse-common, farmhouse-kitchen, pantry |
| `cleaver` | 3 | butcher-shop, farmhouse-kitchen, ship-galley |
| `coin-offering` | 3 | burial-mound, shrine-roadside, standing-stones-circle |
| `coin-stack` | 3 | counting-house, gambling-den, thieves-guild-hideout |
| `cradle` | 3 | apartment-tenement, house-medium-family, nursery |
| `dagger-loose` | 3 | gambling-den, shop-weaponsmith, thieves-guild-hideout |
| `document-stack` | 3 | counting-house, courthouse-chamber, guildhall |
| `dropped-coin` | 3 | battlefield-recent, fairground-seasonal, plaza-civic |
| `feather-bundle` | 3 | druid-grove, elemental-shrine, shrine-roadside |
| `fly-swarm` | 3 | butcher-shop, market-stall, tannery |
| `fresh-flowers` | 3 | house-noble-townhouse, mansion-dining, noble-solar |
| `fungal-growth` | 3 | cave-drow-outpost, sewer-junction, slime-pit |
| `gear-pack` | 3 | ranger-camp, scouts-blind, shepherds-shelter |
| `glass-shard` | 3 | glassworks, refinery, workshop-artificer |
| `helm-on-peg` | 3 | armory, barracks, gatehouse-inner |
| `incense-burner` | 3 | noble-bedchamber, opium-den, throne-room |
| `ink-pot` | 3 | mansion-library, mansion-study, scriptorium-dark |
| `keg-stack` | 3 | brewery, inn-common-room, tavern-common |
| `letter-stack` | 3 | lighthouse-keepers-room, mansion-study, noble-solar |
| `mouse-trap` | 3 | apartment-tenement, mansion-servants-quarters, mill-grain |
| `ore-chunk` | 3 | elemental-earth-node, mine-shaft-entrance, tunnel-mine-worked |
| `pipe-clay` | 3 | gambling-den, inn-common-room, tavern-common |
| `prayer-book` | 3 | celestial-vault, dark-temple, temple-nave |
| `prayer-card` | 3 | apartment-tenement, mansion-servants-quarters, peasant-hovel |
| `quench-barrel` | 3 | forge, house-medium-artisan, smithy-large |
| `rat` | 3 | pantry, servants-kitchen, sewer-junction |
| `reading-spectacles` | 3 | mansion-library, mansion-study, scriptorium-dark |
| `rose-petals` | 3 | bath-house, brothel-parlor, celestial-vault |
| `scorch-mark` | 3 | foundry-great, glassworks, refinery |
| `sewing-basket` | 3 | house-medium-family, house-small, noble-solar |
| `sideboard` | 3 | house-merchant, house-noble-townhouse, mansion-dining |
| `silk-scarf` | 3 | bardic-hall, brothel-parlor, opium-den |
| `skull-stack` | 3 | corrupted-temple, ossuary, ritual-chamber-dark |
| `stage-small` | 3 | bardic-hall, tavern-common, tavern-highend |
| `standing-stone` | 3 | burial-mound, druid-grove, standing-stones-circle |
| `tin-cup` | 3 | apartment-tenement, mansion-servants-quarters, peasant-hovel |
| `torn-cloth` | 3 | cave-bandit-camp, cave-bear-lair, goblin-warren-entrance |
| `weapon-rack-crude` | 3 | cave-bandit-camp, orc-war-camp, toll-bridge-house |
| `withered-flowers` | 3 | graveyard-village, roadside-gallows, shadowfell-mausoleum |
| `wood-chip` | 3 | cooperage, lumberyard, mill-lumber |

---

## Tier 2 — Medium priority (used in 2 specs)

| Prop | Rooms |
|------|-------|
| `altar-stone-flat` | ancient-ruin-overgrown, standing-stones-circle |
| `animal-tracks` | ancient-ruin-overgrown, druid-grove |
| `antler-pile` | cabin-trapper, hunting-lodge-large |
| `apron-hung` | farmhouse-kitchen, house-medium-artisan |
| `axe-head` | lumberyard, mill-lumber |
| `bellows-hand` | forge, smithy-large |
| `bird-nest` | ancient-ruin-overgrown, ruined-watchtower |
| `bloodstain` | dark-temple, ritual-chamber |
| `bloody-rag` | interrogation-room, torture-chamber |
| `bookmark` | library, shop-bookseller |
| `bookshelf-tall` | demiplane-laboratory, library |
| `boot-muddy` | cabin-hunters, cabin-trapper |
| `bowl-stew` | inn-common-room, tavern-common |
| `broken-blade` | mill-lumber, shop-weaponsmith |
| `broken-weapon` | boss-chamber, cave-goblin-warren |
| `bucket-stained` | butcher-shop, tannery |
| `bunk-bed` | barracks, mansion-servants-quarters |
| `bust-on-pedestal` | mansion-grand-hall, mansion-library |
| `butter-churn` | farmhouse-common, farmhouse-kitchen |
| `cabbage` | apartment-tenement, peasant-hovel |
| `calling-card-tray` | house-noble-townhouse, mansion-grand-hall |
| `candle-guttered` | graveyard-village, shadowfell-mausoleum |
| `cannon-swivel` | ship-gun-deck, ship-main-deck |
| `canopy-bed` | mansion-bedroom-master, noble-bedchamber |
| `carcass-fresh` | cave-bear-lair, orc-war-camp |
| `carved-rune-stone` | ancient-ruin-overgrown, standing-stones-circle |
| `chain-heavy` | chasm-crossing, ship-brig |
| `chair-restraint` | interrogation-room, torture-chamber |
| `chandelier-small` | house-merchant, tavern-common |
| `chart-rolled` | lighthouse-keepers-room, ship-captains-cabin |
| `chisel` | general-workshop, temple-of-craft |
| `chitin-barrier` | cave-drow-outpost, underdark-outpost |
| `clay-bin` | house-medium-artisan, kiln-pottery |
| `collapsed-wall-segment` | ancient-ruin-overgrown, ruined-watchtower |
| `crucible-large` | foundry-great, refinery |
| `cupboard` | farmhouse-common, house-medium-family |
| `curtain` | house-merchant, throne-room |
| `curtain-divider` | brothel-parlor, opium-den |
| `desk-lamp` | command-room, mansion-study |
| `desk-writing` | alchemy-lab, house-merchant |
| `dog-bowl` | hunting-lodge-large, shepherds-shelter |
| `dog-stray` | fairground-seasonal, market-square |
| `drive-shaft` | mill-grain, mill-lumber |
| `dust-heap` | cabin-abandoned, crypt |
| `embroidery-hoop` | house-noble-townhouse, noble-solar |
| `fabric-scrap` | shop-tailor, textile-loomhouse |
| `fallen-beam` | ancient-ruin-overgrown, ruined-watchtower |
| `fan` | house-noble-townhouse, noble-solar |
| `fee-board` | ferry-house, toll-bridge-house |
| `firewood-stack` | cabin-hunters, house-small |
| `flour-dust` | bakery, farmhouse-kitchen |
| `flour-sack` | bakery, mill-grain |
| `flour-sack-stack` | bakery, mill-grain |
| `folded-cloak` | barracks, noble-bedchamber |
| `forge-great` | forge, smithy-large |
| `fresh-dirt-mound` | graveyard-village, roadside-gallows |
| `fruit-bowl` | house-merchant, mansion-dining |
| `gavel` | courthouse-chamber, guildhall |
| `gem-loose` | elemental-earth-node, shop-jeweler |
| `giant-mushroom` | mushroom-cavern, mushroom-grove |
| `glowcap-mushroom` | mushroom-cavern, spider-lair |
| `goblet` | guildhall, treasure-vault |
| `grain-hopper` | brewery, mill-grain |
| `grain-spill` | brewery, mill-grain |
| `grandfather-clock` | house-merchant, mansion-grand-hall |
| `hammer` | general-workshop, temple-of-craft |
| `hanging-meat` | farmhouse-kitchen, ship-galley |
| `herb-bundle` | servants-kitchen, shop-apothecary |
| `herb-drying-rack` | bog-witch-hut, cabin-witch |
| `hide-tarp` | goblin-warren-entrance, orc-war-camp |
| `incense-stub` | dark-temple, ritual-chamber |
| `infernal-chain-hook` | infernal-court, infernal-forge |
| `iron-chain-hook` | corrupted-temple, ritual-chamber-dark |
| `key-ring` | counting-house, gatehouse-inner |
| `knife-curved` | butcher-shop, tannery |
| `lapdog-cushion` | house-noble-townhouse, noble-solar |
| `log-book` | lighthouse-keepers-room, ship-captains-cabin |
| `log-round` | lumberyard, mill-lumber |
| `low-table` | brothel-parlor, opium-den |
| `market-stall` | fairground-seasonal, market-square |
| `market-stall-awning` | fairground-seasonal, market-square |
| `mast-main` | ship-gun-deck, ship-main-deck |
| `melted-wax` | dark-temple, ritual-chamber |
| `miniature-portrait` | mansion-bedroom-master, noble-solar |
| `mud-print` | ferry-house, toll-bridge-house |
| `narrow-bed` | apartment-tenement, mansion-servants-quarters |
| `needle-case` | shop-tailor, textile-loomhouse |
| `nest-of-rags` | monster-lair-small, sewer-junction |
| `obsidian-shard` | elemental-fire-node, elemental-shrine |
| `offering-bowl` | burial-mound, standing-stones-circle |
| `ore-cart` | mine-shaft-entrance, tunnel-mine-worked |
| `patched-shirt` | apartment-tenement, peasant-hovel |
| `pedestal-stone` | mansion-grand-hall, reliquary |
| `peg-rail-wall` | apartment-tenement, mansion-servants-quarters |
| `perfume-bottle` | brothel-parlor, mansion-bedroom-master |
| `pin-cushion` | shop-tailor, textile-loomhouse |
| `pipe-outlet` | cistern, sewer-junction |
| `prayer-bench` | mansion-bedroom-master, noble-bedchamber |
| `prayer-stone` | druid-grove, shrine-roadside |
| `rag-damp` | brewery, butcher-shop |
| `rat-skeleton` | cabin-abandoned, oubliette |
| `reading-glasses` | library, shop-bookseller |
| `ribbon-tied` | shrine-roadside, standing-stones-circle |
| `rubble-pile` | corrupted-temple, ruined-watchtower |
| `sack` | campsite-traveler, market-square |
| `salt-sack` | servants-kitchen, shop-general |
| `scales-merchant` | house-merchant, market-stall |
| `scat-pile` | cave-bear-lair, monster-lair-small |
| `shelf-bare` | general-workshop, pantry |
| `shelf-bottles` | cabin-witch, tavern-common |
| `shrine-stone` | hermit-cell, shrine-roadside |
| `silk-bolt` | shop-tailor, textile-loomhouse |
| `silver-bowl` | mansion-grand-hall, shop-jeweler |
| `skinning-knife` | cabin-hunters, cabin-trapper |
| `skinning-table` | cabin-hunters, cabin-trapper |
| `skull-small` | cabin-witch, graveyard-village |
| `small-table` | noble-solar, nursery |
| `smoke-cloud` | gambling-den, opium-den |
| `soot-patch` | foundry-great, smithy-large |
| `spilled-ale` | fairground-seasonal, tavern-common |
| `spyglass` | lighthouse-keepers-room, ship-captains-cabin |
| `staircase` | brothel-parlor, inn-common-room |
| `standing-stone-fallen` | burial-mound, standing-stones-circle |
| `stretched-hide` | cabin-hunters, cabin-trapper |
| `summoning-pool` | boss-chamber, dark-temple |
| `table-small` | apartment-tenement, peasant-hovel |
| `tallow-pot` | cabin-trapper, cabin-witch |
| `tea-service` | house-noble-townhouse, noble-solar |
| `tea-table` | house-noble-townhouse, noble-solar |
| `tent` | campsite-traveler, fairground-seasonal |
| `thread-spool` | shop-tailor, textile-loomhouse |
| `tool-cart` | interrogation-room, torture-chamber |
| `torch-totem` | goblin-warren-entrance, orc-war-camp |
| `torn-banner` | corrupted-temple, orc-war-camp |
| `trap-rack` | cabin-hunters, cabin-trapper |
| `washing-tub` | apartment-tenement, house-small |
| `wax-seal-kit` | command-room, scriptorium-dark |
| `weapon-rack-small` | ship-brig, ship-captains-cabin |
| `web-strand` | cave-drow-outpost, spider-lair |
| `wedge-iron` | lumberyard, mill-lumber |
| `whetstone` | armory, shop-weaponsmith |
| `wine-bottle` | brothel-parlor, tavern-highend |
| `withered-wreath` | crypt, shrine-roadside |
| `wood-bin` | lighthouse-keepers-room, ship-galley |
| `wood-chip-pile` | charcoal-burner-camp, druid-grove |
| `wooden-bowl` | farmhouse-common, peasant-hovel |
| `wooden-toy` | house-medium-family, nursery |
| `worn-shoes` | mansion-servants-quarters, peasant-hovel |
| `writing-desk-small` | mansion-bedroom-master, noble-bedchamber |
| `yarn-basket` | house-medium-artisan, noble-solar |

---

## Tier 3 — Long tail (used in 1 spec each)

Flavor props. Only author when building the specific room that needs them, or if they fit a broader aesthetic worth supporting.

| Prop | Room |
|------|------|
| `abacus` | counting-house |
| `acid-etched-altar` | slime-pit |
| `adze` | cooperage |
| `air-node-vortex` | elemental-air-node |
| `air-node-wisp` | elemental-air-node |
| `algae-bloom` | cistern |
| `altar-sacrificial` | temple-nave |
| `altar-wooden` | druid-grove |
| `ancestor-portrait` | noble-bedchamber |
| `anchor-post` | chasm-crossing |
| `ancient-tree` | druid-grove |
| `anemone-glow` | elemental-water-node |
| `anemone-small` | elemental-water-node |
| `animal-pen-partition` | peasant-hovel |
| `animal-skull` | alchemy-lab |
| `animal-skull-small` | bog-witch-hut |
| `annealing-oven` | glassworks |
| `antler-offering` | druid-grove |
| `antler-rack` | cabin-hunters |
| `anvil-devil` | infernal-forge |
| `apple-barrel` | fairground-seasonal |
| `apple-pile` | market-stall |
| `apron-clay` | kiln-pottery |
| `apron-floured` | bakery |
| `arcane-experiment-core` | demiplane-laboratory |
| `arcane-sigil` | workshop-artificer |
| `arena-pit` | boss-chamber |
| `arrow-broken` | ruined-watchtower |
| `arrow-cluster-ground` | battlefield-recent |
| `arrow-slit-wall` | gatehouse-inner |
| `arrow-stuck` | battlefield-recent |
| `ashes-pile` | temple-nave |
| `astral-anchor-stone` | astral-anchor |
| `astral-lantern` | astral-anchor |
| `auction-block` | market-square |
| `axe-stuck` | charcoal-burner-camp |
| `ballast-stones` | ship-cargo-hold |
| `banner-celestial` | celestial-vault |
| `banner-fallen` | battlefield-recent |
| `banner-heraldic` | mansion-grand-hall |
| `banner-infernal` | infernal-court |
| `banner-religious` | temple-nave |
| `baptismal-pool` | baptistry |
| `barrel-open` | market-stall |
| `barrel-salt-pork` | ship-galley |
| `bars-cell-partition` | prison-block |
| `basalt-pillar` | elemental-fire-node |
| `basket` | textile-loomhouse |
| `basket-wool` | farmhouse-common |
| `bat-guano` | cave-living |
| `bath-pool` | bath-house |
| `bed-small` | house-small |
| `bedroll-hide` | orc-war-camp |
| `belaying-pin-rack` | ship-main-deck |
| `bell-small` | shrine-roadside |
| `bellows-giant` | infernal-forge |
| `bench-astral` | astral-anchor |
| `bench-long` | ship-crew-quarters |
| `bench-upholstered` | mansion-ballroom |
| `bilge-puddle` | ship-cargo-hold |
| `blanket-folded` | shop-general |
| `blast-furnace` | foundry-great |
| `blocks-pile` | nursery |
| `blood-basin` | ritual-chamber-dark |
| `blood-pool` | battlefield-recent |
| `blood-stain` | prison-block |
| `bloodstain-large` | boss-chamber |
| `blotting-rag` | scriptorium-mundane |
| `blowpipe` | glassworks |
| `bobbin` | textile-loomhouse |
| `bone-chandelier` | ossuary |
| `bone-charm` | bog-witch-hut |
| `bone-specimen` | shop-apothecary |
| `bone-totem-small` | goblin-warren-entrance |
| `bonfire` | orc-war-camp |
| `bonfire-large` | fairground-seasonal |
| `book-bedside` | mansion-bedroom-master |
| `bookmark-ribbons` | mansion-library |
| `bookshelf-child` | nursery |
| `boot-worn` | apartment-tenement |
| `boots-by-bed` | barracks |
| `boots-discarded` | ship-crew-quarters |
| `boots-drying` | campsite-traveler |
| `bottle` | pantry |
| `bottle-empty` | cave-bandit-camp |
| `bottle-nursing` | nursery |
| `bouquet` | bardic-hall |
| `bowl` | monastery-refectory |
| `bowl-of-stew` | mess-hall |
| `branding-iron` | torture-chamber |
| `brass-candlestick` | mansion-grand-hall |
| `brass-lamp` | house-merchant |
| `brazier-dead` | ruined-watchtower |
| `brazier-small` | ship-brig |
| `bread-crust` | shepherds-shelter |
| `brewing-kettle` | brewery |
| `bridge-wood` | sewer-junction |
| `broadsheet-posted` | plaza-civic |
| `broken-antler` | cave-bear-lair |
| `broken-arrow` | goblin-warren-entrance |
| `broken-arrow-slit` | ruined-watchtower |
| `broken-binding` | library |
| `broken-bottle` | cabin-abandoned |
| `broken-bridge-stub` | chasm-crossing |
| `broken-fingernail-scratch` | oubliette |
| `broken-glassware` | demiplane-laboratory |
| `broken-pickaxe` | tunnel-mine-worked |
| `broken-plank` | chasm-crossing |
| `broken-plate` | servants-kitchen |
| `broken-pot` | kiln-pottery |
| `broken-pottery` | market-square |
| `broken-spear` | battlefield-recent |
| `broken-statue` | corrupted-temple |
| `broken-stool` | tavern-common |
| `broken-sword` | battlefield-recent |
| `broken-tooth` | interrogation-room |
| `broken-vial` | alchemy-lab |
| `brush-blind` | scouts-blind |
| `bubble-drift` | elemental-water-node |
| `bubble-pillar` | elemental-water-node |
| `bucket-on-rope` | cistern |
| `bucket-water` | glassworks |
| `buffet-table` | mansion-ballroom |
| `building-blocks` | nursery |
| `bundle-of-herbs` | house-small |
| `bunting-line` | fairground-seasonal |
| `burner-shelter` | charcoal-burner-camp |
| `bush-berry` | druid-grove |
| `butchery-pit` | orc-war-camp |
| `butterfly-cloud` | forest-clearing |
| `buttons-jar` | shop-tailor |
| `cabin-window-glow` | ferry-house |
| `cabinet-liquor` | ship-captains-cabin |
| `cage-wicker` | cave-goblin-warren |
| `campaign-ledger` | command-room |
| `campfire-abandoned` | battlefield-recent |
| `campfire-cold` | campsite-traveler |
| `candelabra-tall` | mansion-grand-hall |
| `candle-bundle` | shop-general |
| `candle-miner` | mine-shaft-entrance |
| `candle-night-light` | nursery |
| `candle-red` | opium-den |
| `candle-violet` | cave-drow-outpost |
| `cannon-tackle` | ship-gun-deck |
| `canvas-awning` | market-stall |
| `captains-bunk` | ship-captains-cabin |
| `card-catalog` | mansion-library |
| `card-table` | gambling-den |
| `cargo-hatch` | ship-main-deck |
| `cargo-lashing` | ship-cargo-hold |
| `cargo-scale` | dock-warehouse |
| `cart-track` | mine-shaft-entrance |
| `carved-stick` | shepherds-shelter |
| `casting-pit` | foundry-great |
| `cat-begging` | farmhouse-kitchen |
| `cat-hunting` | butcher-shop |
| `cauldron-small` | alchemy-lab |
| `cave-cricket` | cave-living |
| `cave-mouth-small` | goblin-warren-entrance |
| `celestial-globe` | mansion-library |
| `celestial-pillar-of-light` | celestial-vault |
| `celestial-scales` | celestial-vault |
| `cell-door` | prison-block |
| `chain-shackle` | courthouse-chamber |
| `chair-broken` | cabin-abandoned |
| `chalk-circle-floor` | cabin-witch |
| `chalk-marks` | ritual-chamber |
| `chamber-pot` | mansion-servants-quarters |
| `chamber-pot-stand` | mansion-bedroom-master |
| `chandelier-grand` | mansion-grand-hall |
| `charcoal-kiln` | charcoal-burner-camp |
| `charcoal-lump` | charcoal-burner-camp |
| `chess-set` | noble-solar |
| `chest-ornate` | house-merchant |
| `chest-small` | hermit-cell |
| `chest-wooden` | house-small |
| `chicken-bone` | cave-bandit-camp |
| `chicken-crate` | market-square |
| `chicken-loose` | peasant-hovel |
| `chieftains-throne` | orc-war-camp |
| `child-bed` | nursery |
| `child-doll-rag` | apartment-tenement |
| `child-wooden-toy` | farmhouse-common |
| `child's-toy` | house-small |
| `children-toys` | fairground-seasonal |
| `china-cabinet` | mansion-dining |
| `chips-stack` | gambling-den |
| `chopped-vegetables` | farmhouse-kitchen |
| `cigar-case` | tavern-highend |
| `cigarette-stub` | interrogation-room |
| `claw-marked-wall` | cave-bear-lair |
| `claw-marks-wall` | monster-lair-small |
| `clay-cup` | house-small |
| `clay-dust` | kiln-pottery |
| `clay-lump` | kiln-pottery |
| `clerestory-window` | dock-warehouse |
| `clerk-desk` | courthouse-chamber |
| `clock-tower-base` | plaza-civic |
| `clockwork-frame` | workshop-artificer |
| `clothes-rack` | mansion-servants-quarters |
| `cloud-pillar` | elemental-air-node |
| `coal-bin` | smithy-large |
| `coal-bucket` | apartment-tenement |
| `coal-pile` | forge |
| `coat-rack-ornate` | mansion-grand-hall |
| `cobweb-cluster` | cabin-abandoned |
| `cobweb-heavy` | shadowfell-mausoleum |
| `coin-in-water` | cistern |
| `coin-spill` | treasure-vault |
| `collapsed-stair` | ruined-watchtower |
| `color-rod-bundle` | glassworks |
| `commander-corpse-mounted` | battlefield-recent |
| `condenser-coil` | refinery |
| `confession-paper` | interrogation-room |
| `confessional-booth` | confessional |
| `contraband-stash` | dock-warehouse |
| `cook-pot-tripod` | campsite-traveler |
| `cook-spit` | cave-goblin-warren |
| `cooking-tripod` | ranger-camp |
| `cookware-scatter` | campsite-traveler |
| `coral-pillar` | elemental-water-node |
| `cork-pile` | brewery |
| `corpse-horse` | battlefield-recent |
| `corpse-soldier` | battlefield-recent |
| `cot-blanket` | nursery |
| `crate-splintered` | cabin-abandoned |
| `crate-stacked` | market-stall |
| `crow-perched` | roadside-gallows |
| `crow-picking` | battlefield-recent |
| `crown-on-cushion` | treasure-vault |
| `crucifix-wall` | mansion-bedroom-master |
| `crypt-entrance` | graveyard-village |
| `crystal-cluster-large` | crystal-grotto |
| `crystal-dust` | crystal-grotto |
| `crystal-glow` | cave-living |
| `crystal-heart` | crystal-grotto |
| `cupboard-galley` | ship-galley |
| `cupboard-small` | apartment-tenement |
| `curtain-screen` | confessional |
| `cushion-pile` | opium-den |
| `cutlery-pile` | mess-hall |
| `cutting-table` | shop-tailor |
| `dagger-bedside` | noble-bedchamber |
| `dagger-through-map` | command-room |
| `damp-stain` | apartment-tenement |
| `dance-card` | mansion-ballroom |
| `dart-board` | tavern-common |
| `dead-god-fragment` | astral-anchor |
| `decanter-with-glasses` | house-merchant |
| `decaying-log` | mushroom-grove |
| `decorative-urn` | mansion-grand-hall |
| `dew-drop-sparkle` | fey-glade |
| `dice-pile` | cave-bandit-camp |
| `dice-scatter` | campsite-traveler |
| `dice-table` | gambling-den |
| `dining-table` | house-merchant |
| `dispatch-pouch` | command-room |
| `display-basket` | market-stall |
| `display-case-small` | market-stall |
| `display-rack-armor` | smithy-large |
| `display-rack-fabric` | market-stall |
| `display-rack-weapons` | smithy-large |
| `dissolved-skeleton` | slime-pit |
| `distillation-setup` | alchemy-lab |
| `distillery-vat` | refinery |
| `djinn-pavilion` | elemental-air-node |
| `dog-chain` | lumberyard |
| `dog-sleeping` | inn-common-room |
| `dollhouse` | nursery |
| `drain-grate` | interrogation-room |
| `dressing-screen` | mansion-bedroom-master |
| `dried-flowers` | shrine-roadside |
| `dried-lizard` | shop-apothecary |
| `drifting-stone` | astral-anchor |
| `driftwood` | ferry-house |
| `drip-stain` | cave-living |
| `dripping-stalactite` | slime-pit |
| `dropped-apple` | market-square |
| `dropped-fan` | mansion-ballroom |
| `dropped-fork` | mansion-dining |
| `dropped-rope` | roadside-gallows |
| `drow-command-slab` | cave-drow-outpost |
| `drow-weapon-rack` | cave-drow-outpost |
| `drowned-rat` | cistern |
| `drum-stand` | bardic-hall |
| `dry-leaves` | cabin-abandoned |
| `drying-rack` | kiln-pottery |
| `drying-shelf` | house-medium-artisan |
| `dung-pile` | goblin-warren-entrance |
| `dust-cover` | library |
| `dust-sheet-partial` | mansion-library |
| `dye-vat` | textile-loomhouse |
| `earth-elemental-anvil` | elemental-earth-node |
| `earth-node-core` | elemental-earth-node |
| `efreet-brazier-grand` | elemental-fire-node |
| `egg-sac` | monster-lair-small |
| `egg-sac-mound` | spider-lair |
| `ember-drift` | elemental-fire-node |
| `ember-pit` | elemental-fire-node |
| `embroidery-frame` | noble-solar |
| `fabric-bolt` | market-stall |
| `faerzress-sconce` | cave-drow-outpost |
| `fainting-couch` | brothel-parlor |
| `fallen-antler` | fey-glade |
| `fallen-mask` | fairground-seasonal |
| `fallen-tool` | cabin-abandoned |
| `family-portrait-small` | house-medium-family |
| `fang-scatter` | spider-lair |
| `farm-tool-hung` | farmhouse-common |
| `feather-celestial` | celestial-vault |
| `feather-drift` | elemental-air-node |
| `feather-drift-cluster` | elemental-air-node |
| `fence-wood-low` | roadside-gallows |
| `fermentation-vat` | brewery |
| `fern-cluster` | druid-grove |
| `ferry-cabin` | ferry-house |
| `ferry-raft` | ferry-house |
| `fey-archfey-throne` | fey-glade |
| `fey-lantern-bloom` | fey-glade |
| `fey-mushroom-ring` | fey-glade |
| `finished-pot` | kiln-pottery |
| `finished-vessel` | glassworks |
| `fire-node-core` | elemental-fire-node |
| `fire-ring` | shepherds-shelter |
| `firepit-central` | peasant-hovel |
| `fish-bucket` | ferry-house |
| `fish-skeleton` | elemental-water-node |
| `fishing-rod` | campsite-traveler |
| `fitting-mirror` | shop-tailor |
| `flame-pillar` | elemental-fire-node |
| `flask-small` | refinery |
| `floating-barrel` | cistern |
| `floating-candle` | astral-anchor |
| `floating-debris` | sewer-junction |
| `floating-stone` | elemental-air-node |
| `flour-bag` | servants-kitchen |
| `flour-barrel` | farmhouse-kitchen |
| `flower-arrangement` | mansion-grand-hall |
| `flower-petals` | bardic-hall |
| `focused-lamp` | interrogation-room |
| `folded-gown` | mansion-bedroom-master |
| `footlocker` | barracks |
| `forge-altar` | temple-of-craft |
| `fortune-wheel` | gambling-den |
| `fossil-embedded` | elemental-earth-node |
| `fountain-interior` | mansion-ballroom |
| `fruit-rotten` | shrine-roadside |
| `fume-hood` | alchemy-lab |
| `fur-clump` | tannery |
| `fur-nest` | cave-bear-lair |
| `fur-rug` | hunting-lodge-large |
| `gaffer-bench` | glassworks |
| `gallows-triple` | roadside-gallows |
| `game-booth` | fairground-seasonal |
| `game-piece` | command-room |
| `gauntlet-pile` | armory |
| `gear-locker` | ship-crew-quarters |
| `gear-pile` | workshop-artificer |
| `gem-cluster` | treasure-vault |
| `geode-cluster` | elemental-earth-node |
| `githyanki-perch` | astral-anchor |
| `glass-furnace` | glassworks |
| `glove-silk` | tavern-highend |
| `glove-single` | mansion-ballroom |
| `glove-stained` | refinery |
| `glowcap-cluster` | mushroom-grove |
| `glowing-ingot` | infernal-forge |
| `goblin-totem` | cave-goblin-warren |
| `grain-sack` | pantry |
| `grand-staircase` | mansion-grand-hall |
| `grate-ceiling` | oubliette |
| `grate-floor` | sewer-junction |
| `grate-shaft` | ship-cargo-hold |
| `grate-shaft-light` | sewer-junction |
| `grate-wall` | sewer-junction |
| `great-hearth` | hunting-lodge-large |
| `gun-port` | ship-gun-deck |
| `hairbrush-set` | mansion-bedroom-master |
| `half-built-device` | workshop-artificer |
| `half-eaten-carcass` | monster-lair-small |
| `half-finished-work` | house-medium-artisan |
| `ham-hook-row` | pantry |
| `hammer-giant` | infernal-forge |
| `hammer-rack` | smithy-large |
| `hanging-garlic` | farmhouse-kitchen |
| `hanging-ham` | pantry |
| `hanging-sausage` | farmhouse-kitchen |
| `harp` | bardic-hall |
| `harp-floor` | noble-solar |
| `harpsichord` | mansion-ballroom |
| `hat-tricorn` | tavern-highend |
| `hay-wisps` | farmhouse-common |
| `headframe` | mine-shaft-entrance |
| `hearth-small` | nursery |
| `helmet-fallen` | battlefield-recent |
| `helmet-mining` | mine-shaft-entrance |
| `helmet-rusted` | ruined-watchtower |
| `hide-scraps` | tannery |
| `hobby-horse` | nursery |
| `holy-symbol` | temple-nave |
| `holystone` | ship-main-deck |
| `homunculus-vat` | demiplane-laboratory |
| `hooping-fire` | cooperage |
| `hops-bunch` | brewery |
| `horse-dung` | toll-bridge-house |
| `horseshoe` | general-workshop |
| `horseshoe-pile` | smithy-large |
| `hot-iron` | torture-chamber |
| `hound-asleep` | noble-bedchamber |
| `hung-herb-bundle` | bog-witch-hut |
| `hunting-horn` | hunting-lodge-large |
| `hunting-trophy` | noble-bedchamber |
| `hut-window-glow` | bog-witch-hut |
| `icon-wall` | temple-nave |
| `infernal-contract-pedestal` | infernal-court |
| `infernal-furnace` | infernal-forge |
| `ingot-pile` | temple-of-craft |
| `ingot-single` | foundry-great |
| `ink-pot-small` | scouts-blind |
| `ink-stone` | scriptorium-mundane |
| `interrogation-chair` | ship-brig |
| `iron-cage-cell` | ship-brig |
| `iron-chair` | throne-room |
| `iron-hoop` | cooperage |
| `iron-scrap` | foundry-great |
| `iron-throne-spiked` | infernal-court |
| `jack-tool` | glassworks |
| `jar` | pantry |
| `jar-of-teeth` | bog-witch-hut |
| `jewel-casket` | noble-bedchamber |
| `jeweler-bench` | shop-jeweler |
| `jewelry-box` | mansion-bedroom-master |
| `jewelry-loose` | thieves-guild-hideout |
| `judge-bench` | courthouse-chamber |
| `junk-pile` | goblin-warren-entrance |
| `kelp-frond-giant` | elemental-water-node |
| `kelp-strand` | elemental-water-node |
| `kennel` | hunting-lodge-large |
| `kettle-hook` | ship-galley |
| `kiln-brick` | kiln-pottery |
| `kiln-large` | kiln-pottery |
| `knife-on-block` | servants-kitchen |
| `knit-blanket` | lighthouse-keepers-room |
| `knitting-pile` | house-medium-family |
| `ladder-library` | shop-bookseller |
| `ladder-rolling` | library |
| `ladle-iron` | foundry-great |
| `lantern` | gatehouse-inner |
| `lantern-ground` | campsite-traveler |
| `lantern-hand` | shop-general |
| `lantern-paper` | fairground-seasonal |
| `laurel-wreath` | bardic-hall |
| `lava-fountain` | elemental-fire-node |
| `leaf-drift` | elemental-air-node |
| `lean-to` | ranger-camp |
| `leather-stack` | tannery |
| `leather-strap` | shop-weaponsmith |
| `ledger` | house-merchant |
| `letter-home` | mansion-servants-quarters |
| `letter-sealed` | house-merchant |
| `library-ladder` | mansion-library |
| `lightning-arc-small` | elemental-air-node |
| `lime-bin` | tannery |
| `lime-dust` | tannery |
| `linstock` | ship-gun-deck |
| `lint-clump` | textile-loomhouse |
| `liquor-bottle` | ship-captains-cabin |
| `lockpicks` | thieves-guild-hideout |
| `log-carriage` | mill-lumber |
| `log-fallen` | druid-grove |
| `log-seat` | campsite-traveler |
| `long-spoon` | farmhouse-kitchen |
| `longboat-cradle` | ship-main-deck |
| `loom-altar` | temple-of-craft |
| `loot-pile` | cave-bandit-camp |
| `lullaby-music-box` | nursery |
| `luminous-spore` | mushroom-grove |
| `lute-stand` | bardic-hall |
| `magic-sigil-floor` | throne-room |
| `magical-glow-prop` | alchemy-lab |
| `magnifier` | shop-jeweler |
| `mallet-wooden` | cooperage |
| `mannequin` | shop-tailor |
| `map-case` | library |
| `map-pinned` | campsite-traveler |
| `map-scroll` | command-room |
| `marid-pavilion` | elemental-water-node |
| `market-cross` | market-square |
| `marver-slab` | glassworks |
| `mash-tun` | brewery |
| `mask-cloth` | thieves-guild-hideout |
| `mask-feathered` | brothel-parlor |
| `masquerade-mask` | mansion-ballroom |
| `massage-table` | bath-house |
| `mast-fore` | ship-main-deck |
| `match-tub` | ship-gun-deck |
| `maypole` | fairground-seasonal |
| `measuring-tape` | shop-tailor |
| `meat-hook-rack` | butcher-shop |
| `mess-table-folding` | ship-crew-quarters |
| `millstone` | mill-grain |
| `mine-shaft` | mine-shaft-entrance |
| `mine-shaft-opening` | tunnel-mine-worked |
| `mineral-vein` | cave-living |
| `mirror-reflected` | mansion-ballroom |
| `mirror-tall` | mansion-ballroom |
| `mist-pool` | shadowfell-mausoleum |
| `mixing-bowl` | farmhouse-kitchen |
| `moldy-bread` | oubliette |
| `molten-pool-small` | elemental-fire-node |
| `mosaic-fragment` | ancient-ruin-overgrown |
| `moss-patch-glowing` | cave-drow-outpost |
| `mound-entrance` | burial-mound |
| `mourning-bell` | shadowfell-mausoleum |
| `muddy-boot-prints` | hunting-lodge-large |
| `muddy-boots` | farmhouse-common |
| `mug` | monastery-refectory |
| `murder-hole-grate` | gatehouse-inner |
| `mushroom-basket` | cabin-witch |
| `mushroom-glow` | cave-living |
| `music-stand` | bardic-hall |
| `musicians-dais` | mansion-ballroom |
| `mycelium-web` | mushroom-grove |
| `myconid-circle` | mushroom-cavern |
| `nail-pile` | general-workshop |
| `nails-box` | shop-general |
| `nails-crate` | smithy-large |
| `napkin-pile` | mansion-dining |
| `nurse-stool` | nursery |
| `obelisk-astral` | astral-anchor |
| `obelisk-memorial` | shadowfell-mausoleum |
| `obelisk-stone-raw` | elemental-earth-node |
| `oil-amphora` | bath-house |
| `oil-reservoir` | lighthouse-keepers-room |
| `oil-slick` | sewer-junction |
| `ooze-pool` | slime-pit |
| `ooze-puddle` | slime-pit |
| `opium-couch` | opium-den |
| `opium-pipe` | opium-den |
| `oracle-pit` | oracle-chamber |
| `ore-pile` | tunnel-mine-worked |
| `ore-sorting-table` | tunnel-mine-worked |
| `ore-vein-prop` | elemental-earth-node |
| `ornamental-dagger` | mansion-grand-hall |
| `orrery-magical` | demiplane-laboratory |
| `overhead-crane` | foundry-great |
| `overturned-table` | cabin-abandoned |
| `painting-framed` | house-merchant |
| `painting-large` | mansion-ballroom |
| `pantry-door` | farmhouse-kitchen |
| `pantry-shelf` | pantry |
| `paperweight` | mansion-study |
| `pavise` | battlefield-recent |
| `pearl-cluster` | elemental-water-node |
| `pearl-obelisk` | elemental-water-node |
| `pearl-strand` | shop-jeweler |
| `pebble-suspended` | elemental-air-node |
| `pedestal` | treasure-vault |
| `peel-wooden` | bakery |
| `pelt-roll` | cabin-hunters |
| `pelt-stack` | cabin-trapper |
| `pen-and-inkwell` | interrogation-room |
| `personal-chest` | barracks |
| `pewter-mug` | farmhouse-common |
| `pewter-plate` | ship-galley |
| `pianoforte` | house-noble-townhouse |
| `pickaxe` | mine-shaft-entrance |
| `pickaxe-rack` | tunnel-mine-worked |
| `picket-line` | campsite-traveler |
| `picture-book` | nursery |
| `pie-stand` | fairground-seasonal |
| `pigeon-flock` | plaza-civic |
| `pillar-crystal` | crystal-grotto |
| `pillar-floating` | astral-anchor |
| `pillar-marble` | celestial-vault |
| `pincers` | torture-chamber |
| `pipe-ash` | opium-den |
| `pipe-ashtray` | mansion-study |
| `pit-saw` | mill-lumber |
| `place-card` | mansion-dining |
| `planar-sigil-shard` | astral-anchor |
| `plate-stack` | mess-hall |
| `plunge-basin` | bath-house |
| `polish-rag` | shop-weaponsmith |
| `poppet` | cabin-witch |
| `portal-stela` | astral-anchor |
| `portrait-framed` | mansion-grand-hall |
| `potbelly-stove` | lighthouse-keepers-room |
| `potion-bottle` | shop-apothecary |
| `potted-palm` | mansion-ballroom |
| `pottery-shard` | kiln-pottery |
| `powder-tub` | ship-gun-deck |
| `prayer-beads` | house-medium-family |
| `prayer-flag` | shrine-roadside |
| `prayer-shelf` | farmhouse-common |
| `printing-press` | scriptorium-mundane |
| `prisoner-cage` | orc-war-camp |
| `prisoner-dock` | courthouse-chamber |
| `private-booth` | gambling-den |
| `prize-ring` | fairground-seasonal |
| `produce-pile` | market-square |
| `puddle` | oubliette |
| `puddle-wort` | brewery |
| `pulpit` | temple-nave |
| `punch-table` | mansion-ballroom |
| `pyre-mass-grave` | battlefield-recent |
| `quench-trough-blood` | infernal-forge |
| `quill-pen` | scriptorium-dark |
| `rabbit-trail` | forest-clearing |
| `rag-doll` | nursery |
| `rags-bloody` | mine-shaft-entrance |
| `rail-track` | tunnel-mine-worked |
| `rain-puddle` | druid-grove |
| `rammer-rack` | ship-gun-deck |
| `rat-carcass` | goblin-warren-entrance |
| `rat-nest` | prison-block |
| `rat-sign` | mill-grain |
| `ration-bowl` | prison-block |
| `ration-moldy` | ruined-watchtower |
| `ration-pack` | cabin-hunters |
| `raven-perch` | cabin-witch |
| `raven-perched` | graveyard-village |
| `ravens-feather` | burial-mound |
| `reading-chair` | mansion-library |
| `reading-table` | library |
| `reagent-jar` | demiplane-laboratory |
| `reagent-rack` | demiplane-laboratory |
| `reliquary-bone` | shadowfell-mausoleum |
| `residual-torch-from-victims` | monster-lair-small |
| `resonance-pool` | crystal-grotto |
| `ribbon` | mansion-ballroom |
| `ribbon-scatter` | fairground-seasonal |
| `ring-display` | shop-jeweler |
| `ritual-candle` | standing-stones-circle |
| `rocking-horse` | nursery |
| `rolled-blanket` | house-small |
| `rolling-pin` | bakery |
| `root-tangle` | mushroom-cavern |
| `rope-bridge` | chasm-crossing |
| `rope-cordon` | plaza-civic |
| `rose-petal-scatter` | mansion-ballroom |
| `round-dining-table` | mansion-dining |
| `round-table` | sanctum-order |
| `rug-oriental` | house-merchant |
| `rug-runner` | mansion-grand-hall |
| `rune-chalk-mark` | demiplane-laboratory |
| `rusted-bucket` | cistern |
| `rusted-manacle` | prison-block |
| `rusted-tool` | sewer-junction |
| `rusted-weapon` | slime-pit |
| `sack-pile` | mill-grain |
| `sack-stack` | pantry |
| `sail-rolled` | ship-main-deck |
| `salt-barrel` | butcher-shop |
| `salt-brick` | pantry |
| `sand-bin` | glassworks |
| `sand-mold` | foundry-great |
| `sand-shaker` | scriptorium-mundane |
| `sand-spill` | glassworks |
| `sand-table` | command-room |
| `sandal-pair` | bath-house |
| `sarcophagus-shadow` | shadowfell-mausoleum |
| `sausage-link` | butcher-shop |
| `sawmill-blade` | mill-lumber |
| `scabbard-empty` | shop-weaponsmith |
| `scale-justice` | courthouse-chamber |
| `schematic-rolled` | workshop-artificer |
| `scissors-shears` | shop-tailor |
| `scoop-wooden` | mill-grain |
| `scorched-cell` | boss-chamber |
| `scorched-scroll` | infernal-court |
| `scraping-beam` | tannery |
| `scratch-marks` | prison-block |
| `scratched-tally` | ship-brig |
| `screen-folding` | opium-den |
| `screen-painted` | nursery |
| `screwdriver` | workshop-artificer |
| `scroll-loose` | library |
| `scroll-rack-tall` | library |
| `scroll-rolled` | ship-captains-cabin |
| `scroll-stack` | demiplane-laboratory |
| `scrying-crystal` | crystal-grotto |
| `scrying-pool` | cave-drow-outpost |
| `scummy-water-pool` | sewer-junction |
| `sea-glass-shard` | elemental-water-node |
| `sealing-wax` | mansion-study |
| `seed-float` | elemental-air-node |
| `servant-uniform-hung` | mansion-servants-quarters |
| `serving-trolley` | mansion-dining |
| `settee` | house-noble-townhouse |
| `severed-limb` | battlefield-recent |
| `sewage-channel` | sewer-junction |
| `sewing-bench` | shop-tailor |
| `sewing-kit-small` | mansion-servants-quarters |
| `shadow-tree` | shadowfell-mausoleum |
| `shaft-light-from-above` | oubliette |
| `shattered-shield` | boss-chamber |
| `shed-skin` | monster-lair-small |
| `sheep-dung` | shepherds-shelter |
| `sheet-music` | bardic-hall |
| `shelf-crockery` | farmhouse-kitchen |
| `shelf-fallen` | cabin-abandoned |
| `shelf-tools` | house-medium-artisan |
| `shell-giant` | elemental-water-node |
| `shell-scatter` | elemental-water-node |
| `shepherds-crook` | shepherds-shelter |
| `shield-broken` | ruined-watchtower |
| `shiny-trinket` | goblin-warren-entrance |
| `ship-in-bottle-shelf` | ship-captains-cabin |
| `ship-stove` | ship-galley |
| `ships-ladder` | ship-main-deck |
| `shop-counter` | smithy-large |
| `shot-garland` | ship-gun-deck |
| `shot-loose` | ship-gun-deck |
| `shovel-leaning` | graveyard-village |
| `shrieker` | mushroom-cavern |
| `shroud-torn` | shadowfell-mausoleum |
| `side-table` | mansion-library |
| `siege-engine-wrecked` | battlefield-recent |
| `signal-bell` | ferry-house |
| `signal-gong` | underdark-outpost |
| `signet-ring-tray` | noble-bedchamber |
| `silk-cocoon` | spider-lair |
| `silk-cocoon-victim` | spider-lair |
| `silver-candlestick` | mansion-dining |
| `silver-cord-pylon` | astral-anchor |
| `silver-cord-stub` | astral-anchor |
| `silver-tray` | tavern-highend |
| `single-tooth` | oubliette |
| `skeleton-charred` | elemental-fire-node |
| `skeleton-slumped` | ruined-watchtower |
| `skull-offering` | ritual-chamber |
| `skull-on-stick` | goblin-warren-entrance |
| `skull-totem` | orc-war-camp |
| `skull-trophy` | orc-war-camp |
| `slime-puddle` | monster-lair-small |
| `slime-trail` | slime-pit |
| `slippers` | mansion-bedroom-master |
| `slug-trail` | mushroom-grove |
| `small-bone` | cave-living |
| `smoke-wisp` | refinery |
| `smuggled-cage` | ship-cargo-hold |
| `snare-set` | ranger-camp |
| `snuffbox` | house-noble-townhouse |
| `songbird-nest` | fey-glade |
| `soot-print` | charcoal-burner-camp |
| `soot-streak` | infernal-forge |
| `sorting-table` | mine-shaft-entrance |
| `soul-coin-pile` | infernal-court |
| `soul-crucible` | infernal-forge |
| `spark-burst` | elemental-fire-node |
| `spear-stuck` | orc-war-camp |
| `specimen-jar-shelf` | alchemy-lab |
| `specimen-tank` | alchemy-lab |
| `spell-component-loose` | demiplane-laboratory |
| `spelljammer-dock-mooring` | astral-anchor |
| `spice-bowl` | market-stall |
| `spice-rack` | ship-galley |
| `spider-egg-cluster` | cave-drow-outpost |
| `spider-husk` | spider-lair |
| `spider-matriarch-pad` | spider-lair |
| `spider-shrine` | cave-drow-outpost |
| `spider-silk-drape` | cave-drow-outpost |
| `spike-pit-hidden` | goblin-warren-entrance |
| `spill-reagent` | refinery |
| `spilled-flour-sack` | cabin-abandoned |
| `spilled-punch` | mansion-ballroom |
| `spilled-reagent` | alchemy-lab |
| `spilled-salt` | ritual-chamber |
| `spilled-toys` | nursery |
| `spilled-wine` | mansion-dining |
| `spindle-rack` | house-medium-artisan |
| `sponge` | kiln-pottery |
| `spore-pool` | mushroom-cavern |
| `spore-puff` | mushroom-cavern |
| `spore-puffball` | mushroom-grove |
| `spring-coil` | workshop-artificer |
| `spyglass-tripod` | scouts-blind |
| `stage-large` | bardic-hall |
| `stage-performance` | fairground-seasonal |
| `stair-remnant` | ruined-watchtower |
| `staircase-wooden` | tavern-common |
| `stalactite-hanging` | cave-living |
| `stalagmite-forest` | cave-living |
| `stall-counter` | market-stall |
| `standing-stones-ring` | druid-grove |
| `star-dust-pile` | astral-anchor |
| `statue-classical` | mansion-ballroom |
| `statue-dark-god` | dark-temple |
| `statue-deity` | temple-nave |
| `statue-devil` | infernal-court |
| `statue-noble` | mansion-grand-hall |
| `statue-small` | shrine-roadside |
| `statue-solar` | celestial-vault |
| `statue-toppled` | ancient-ruin-overgrown |
| `statue-weeping` | graveyard-village |
| `stave-horse` | cooperage |
| `stave-pile` | cooperage |
| `steam-cloud` | bath-house |
| `stern-window` | ship-captains-cabin |
| `stolen-shoe` | goblin-warren-entrance |
| `stone-arch-natural` | chasm-crossing |
| `stone-column-broken` | ancient-ruin-overgrown |
| `stone-debris` | elemental-earth-node |
| `stool-bar` | tavern-common |
| `stool-vendor` | market-stall |
| `stool-wooden` | ship-brig |
| `stopper-cork` | refinery |
| `storm-altar` | elemental-air-node |
| `stove-iron` | apartment-tenement |
| `strange-residue` | alchemy-lab |
| `straw-bed-large` | monster-lair-small |
| `straw-pile` | prison-block |
| `straw-wisps` | peasant-hovel |
| `strigil` | bath-house |
| `stuffed-bear` | nursery |
| `summoning-pool-glow` | boss-chamber |
| `sun-disc-altar` | celestial-vault |
| `sun-window` | noble-solar |
| `supply-cache` | underdark-outpost |
| `swab-rammer` | ship-gun-deck |
| `table-long` | tavern-common |
| `table-round` | tavern-common |
| `tally-marks-wall` | oubliette |
| `tally-stick` | dock-warehouse |
| `tanning-pit` | tannery |
| `tanning-vat` | tannery |
| `tapestry-dark` | dark-temple |
| `tapestry-large` | mansion-grand-hall |
| `tapestry-religious` | temple-nave |
| `tattered-letter` | battlefield-recent |
| `teacup` | opium-den |
| `teapot` | opium-den |
| `tent-collapsed` | campsite-traveler |
| `thimble` | shop-tailor |
| `thread-rack` | textile-loomhouse |
| `threadbare-rug` | mansion-servants-quarters |
| `thumbscrews` | interrogation-room |
| `timber-brace` | tunnel-mine-worked |
| `tin-soldier-pile` | nursery |
| `tiny-chair` | nursery |
| `tiny-shoe` | fey-glade |
| `tobacco-pipe` | lighthouse-keepers-room |
| `toll-barrier` | toll-bridge-house |
| `toll-house` | toll-bridge-house |
| `tongs` | general-workshop |
| `tongs-long` | foundry-great |
| `tool-rack-wall` | house-medium-artisan |
| `tool-scatter` | house-medium-artisan |
| `tooth-jar` | torture-chamber |
| `torn-cloak` | monster-lair-small |
| `torn-notice` | roadside-gallows |
| `torn-page` | ritual-chamber |
| `torture-instrument-small` | prison-block |
| `towel-folded` | bath-house |
| `toy-chest` | nursery |
| `trash-heap` | cave-goblin-warren |
| `travel-pack` | inn-common-room |
| `treasure-chest-naval` | ship-cargo-hold |
| `tree-ancient-fey` | fey-glade |
| `tree-old` | druid-grove |
| `tripwire` | goblin-warren-entrance |
| `trophy-case` | ship-captains-cabin |
| `trunk-open` | cabin-abandoned |
| `tureen` | mansion-dining |
| `turnip-pile` | peasant-hovel |
| `tweezers` | shop-jeweler |
| `type-case` | scriptorium-mundane |
| `umbrella-stand` | mansion-grand-hall |
| `urn` | crypt |
| `vase-floor` | house-noble-townhouse |
| `velvet-cloth` | shop-jeweler |
| `victim-cocoon` | slime-pit |
| `vine-hanging` | ancient-ruin-overgrown |
| `violet-fungus` | mushroom-cavern |
| `wagon` | lumberyard |
| `walking-stick` | inn-common-room |
| `war-paint-pot` | orc-war-camp |
| `wardrobe-small` | nursery |
| `warren-hole` | goblin-warren-entrance |
| `washing-line` | apartment-tenement |
| `watchfire-pit` | underdark-outpost |
| `watchfire-ring` | ruined-watchtower |
| `water-barrel` | ship-main-deck |
| `water-bowl` | kiln-pottery |
| `water-dish-dry` | oubliette |
| `water-jar` | bath-house |
| `water-node-core` | elemental-water-node |
| `water-pitcher` | interrogation-room |
| `water-skin` | charcoal-burner-camp |
| `waterskin` | campsite-traveler |
| `weapon-rack-broken` | ruined-watchtower |
| `weapon-rack-ceremonial` | throne-room |
| `weapon-rack-infernal` | infernal-forge |
| `weapon-rack-wall` | noble-bedchamber |
| `weapon-stuck` | battlefield-recent |
| `web-cluster` | monster-lair-small |
| `web-floor` | spider-lair |
| `web-funnel` | spider-lair |
| `whittled-stick` | ranger-camp |
| `wild-plant-sprouting` | ruined-watchtower |
| `wildflower-patch` | druid-grove |
| `winch-block` | dock-warehouse |
| `winch-large` | mine-shaft-entrance |
| `winch-mechanism` | gatehouse-inner |
| `winch-platform` | chasm-crossing |
| `wind-chime-giant` | elemental-air-node |
| `wind-chime-pillar` | elemental-shrine |
| `window-seat` | noble-solar |
| `wine-decanter` | command-room |
| `wine-nightcap` | mansion-bedroom-master |
| `wine-rack-small` | house-merchant |
| `witch-hut` | bog-witch-hut |
| `witch-hut-stilts` | bog-witch-hut |
| `withered-offering` | temple-nave |
| `witness-dock` | courthouse-chamber |
| `wood-pile` | campsite-traveler |
| `wood-shavings` | general-workshop |
| `wooden-paddle` | brewery |
| `wooden-spoon` | ship-galley |
| `wooden-spoon-pile` | farmhouse-kitchen |
| `work-in-progress` | general-workshop |
