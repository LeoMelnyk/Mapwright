# Prop Ideas — Missing from Catalog

Generated from 160 room vocab specs in `src/rooms/`. These are prop names referenced by specs but not found in the current `src/props/` catalog. Author in priority order — Tier 1 unlocks the most rooms per prop created.

**Original totals (pre-v0.11.0):** 1177 missing  |  Tier 1 (3+ uses): 105  |  Tier 2 (2 uses): 150  |  Tier 3 (1 use): 922
**Current totals:** 619 missing  |  Tier 1: 3 (aliases only)  |  Tier 2: 0 (complete)  |  Tier 3: 616
**Catalog size:** 808 props

---

## Progress log

### 2026-04 (v0.11.0)

- **~563 props authored** across seven batches + follow-up fixes. Catalog grew from ~245 to **808 props**.
- **Tier 1: complete.** Remaining 3 are aliases / non-drawable concepts — specs should be updated to use canonical names:
  - `counter` → use `bar-counter` with `counter-corner` for L/U-shaped counters.
  - `bookshelf-short` → use `bookshelf`.
  - `rat-swarm-marker` is a *concept*, not a prop — remove from specs or replace with a real object like `rat` or `rat-skeleton`.
- **Tier 2: complete.** 0 props remaining.
- **Tier 3: 616 remaining** (down from 922). Batch-7 added 209 props across 20 atmospheric clusters — elemental water/air/fire/astral nodes, battlefield-recent, fairground-seasonal, four mansion rooms, market stall, temple nave, bardic hall, orc/goblin camps, sewer, merchant, drow, mine, ship gun deck, noble bedroom.
- **Perspective rules expanded** in `src/props/CLAUDE.md` — now covers columns/pillars/obelisks (square footprint, radial decoration), overhead-hanging/strung props, stuck/embedded weapons, cave mouths, fire columns (concentric rings), tileable/modular props (channels, tracks). Read those sections before authoring tall verticals, anything that hangs from above, or anything meant to tile.
- **Batch-7 footprint correction** — 12 props (bubble/coral/cloud/flame/basalt/pearl-obelisk/obelisk-astral/portal-stela/silver-cord-pylon/pillar-floating and kelp variants) were originally authored at `2x1` but `2x1` is for ground-elongated objects, not tall columns. They were rewritten to `1x1` or `2x2` with proper top-down artwork.
- **Showcase PNGs** — `prop-showcase-v0.11.0-batch{3,4,5,6,7}.png` each show a labeled grid of the props authored in that batch for visual review.

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
| `acid-etched-altar` | slime-pit |
| `adze` | cooperage |
| `algae-bloom` | cistern |
| `ancestor-portrait` | noble-bedchamber |
| `anchor-post` | chasm-crossing |
| `ancient-tree` | druid-grove |
| `animal-pen-partition` | peasant-hovel |
| `animal-skull-small` | bog-witch-hut |
| `antler-rack` | cabin-hunters |
| `apron-floured` | bakery |
| `arcane-experiment-core` | demiplane-laboratory |
| `arcane-sigil` | workshop-artificer |
| `arena-pit` | boss-chamber |
| `arrow-broken` | ruined-watchtower |
| `arrow-slit-wall` | gatehouse-inner |
| `auction-block` | market-square |
| `axe-stuck` | charcoal-burner-camp |
| `ballast-stones` | ship-cargo-hold |
| `banner-celestial` | celestial-vault |
| `banner-infernal` | infernal-court |
| `baptismal-pool` | baptistry |
| `barrel-salt-pork` | ship-galley |
| `basket` | textile-loomhouse |
| `basket-wool` | farmhouse-common |
| `bed-small` | house-small |
| `belaying-pin-rack` | ship-main-deck |
| `bell-small` | shrine-roadside |
| `bench-long` | ship-crew-quarters |
| `bilge-puddle` | ship-cargo-hold |
| `blanket-folded` | shop-general |
| `blast-furnace` | foundry-great |
| `blood-basin` | ritual-chamber-dark |
| `bloodstain-large` | boss-chamber |
| `blotting-rag` | scriptorium-mundane |
| `bobbin` | textile-loomhouse |
| `bone-chandelier` | ossuary |
| `bone-charm` | bog-witch-hut |
| `bone-specimen` | shop-apothecary |
| `bookmark-ribbons` | mansion-library |
| `bookshelf-child` | nursery |
| `boot-worn` | apartment-tenement |
| `boots-by-bed` | barracks |
| `boots-discarded` | ship-crew-quarters |
| `bottle-empty` | cave-bandit-camp |
| `bottle-nursing` | nursery |
| `bowl` | monastery-refectory |
| `bowl-of-stew` | mess-hall |
| `branding-iron` | torture-chamber |
| `brazier-small` | ship-brig |
| `bread-crust` | shepherds-shelter |
| `brewing-kettle` | brewery |
| `bridge-wood` | sewer-junction |
| `broadsheet-posted` | plaza-civic |
| `broken-antler` | cave-bear-lair |
| `broken-arrow-slit` | ruined-watchtower |
| `broken-binding` | library |
| `broken-bridge-stub` | chasm-crossing |
| `broken-fingernail-scratch` | oubliette |
| `broken-glassware` | demiplane-laboratory |
| `broken-pickaxe` | tunnel-mine-worked |
| `broken-plank` | chasm-crossing |
| `broken-plate` | servants-kitchen |
| `broken-pottery` | market-square |
| `broken-statue` | corrupted-temple |
| `broken-stool` | tavern-common |
| `broken-tooth` | interrogation-room |
| `brush-blind` | scouts-blind |
| `bucket-on-rope` | cistern |
| `building-blocks` | nursery |
| `bundle-of-herbs` | house-small |
| `burner-shelter` | charcoal-burner-camp |
| `butterfly-cloud` | forest-clearing |
| `cabin-window-glow` | ferry-house |
| `cabinet-liquor` | ship-captains-cabin |
| `cage-wicker` | cave-goblin-warren |
| `campaign-ledger` | command-room |
| `candle-bundle` | shop-general |
| `captains-bunk` | ship-captains-cabin |
| `card-catalog` | mansion-library |
| `card-table` | gambling-den |
| `cargo-hatch` | ship-main-deck |
| `cargo-lashing` | ship-cargo-hold |
| `cargo-scale` | dock-warehouse |
| `carved-stick` | shepherds-shelter |
| `casting-pit` | foundry-great |
| `cat-hunting` | butcher-shop |
| `celestial-globe` | mansion-library |
| `celestial-pillar-of-light` | celestial-vault |
| `celestial-scales` | celestial-vault |
| `chain-shackle` | courthouse-chamber |
| `chalk-circle-floor` | cabin-witch |
| `chalk-marks` | ritual-chamber |
| `chamber-pot` | mansion-servants-quarters |
| `charcoal-kiln` | charcoal-burner-camp |
| `charcoal-lump` | charcoal-burner-camp |
| `chess-set` | noble-solar |
| `chest-small` | hermit-cell |
| `chest-wooden` | house-small |
| `chicken-bone` | cave-bandit-camp |
| `chicken-crate` | market-square |
| `chicken-loose` | peasant-hovel |
| `child-doll-rag` | apartment-tenement |
| `child-wooden-toy` | farmhouse-common |
| `child's-toy` | house-small |
| `chips-stack` | gambling-den |
| `cigar-case` | tavern-highend |
| `cigarette-stub` | interrogation-room |
| `claw-marked-wall` | cave-bear-lair |
| `claw-marks-wall` | monster-lair-small |
| `clay-cup` | house-small |
| `clerestory-window` | dock-warehouse |
| `clerk-desk` | courthouse-chamber |
| `clock-tower-base` | plaza-civic |
| `clockwork-frame` | workshop-artificer |
| `clothes-rack` | mansion-servants-quarters |
| `coal-bin` | smithy-large |
| `coal-bucket` | apartment-tenement |
| `coal-pile` | forge |
| `cobweb-heavy` | shadowfell-mausoleum |
| `coin-in-water` | cistern |
| `coin-spill` | treasure-vault |
| `condenser-coil` | refinery |
| `confession-paper` | interrogation-room |
| `confessional-booth` | confessional |
| `contraband-stash` | dock-warehouse |
| `cook-spit` | cave-goblin-warren |
| `cooking-tripod` | ranger-camp |
| `cookware-scatter` | campsite-traveler |
| `cork-pile` | brewery |
| `crate-splintered` | cabin-abandoned |
| `crow-perched` | roadside-gallows |
| `crown-on-cushion` | treasure-vault |
| `crypt-entrance` | graveyard-village |
| `crystal-cluster-large` | crystal-grotto |
| `crystal-dust` | crystal-grotto |
| `crystal-heart` | crystal-grotto |
| `cupboard-galley` | ship-galley |
| `cupboard-small` | apartment-tenement |
| `curtain-screen` | confessional |
| `cutlery-pile` | mess-hall |
| `dagger-bedside` | noble-bedchamber |
| `dagger-through-map` | command-room |
| `damp-stain` | apartment-tenement |
| `dart-board` | tavern-common |
| `decaying-log` | mushroom-grove |
| `dew-drop-sparkle` | fey-glade |
| `dice-pile` | cave-bandit-camp |
| `dice-scatter` | campsite-traveler |
| `dice-table` | gambling-den |
| `dispatch-pouch` | command-room |
| `display-rack-armor` | smithy-large |
| `display-rack-weapons` | smithy-large |
| `dissolved-skeleton` | slime-pit |
| `distillery-vat` | refinery |
| `dog-chain` | lumberyard |
| `dog-sleeping` | inn-common-room |
| `drain-grate` | interrogation-room |
| `dried-flowers` | shrine-roadside |
| `dried-lizard` | shop-apothecary |
| `driftwood` | ferry-house |
| `dripping-stalactite` | slime-pit |
| `dropped-apple` | market-square |
| `dropped-rope` | roadside-gallows |
| `drowned-rat` | cistern |
| `dry-leaves` | cabin-abandoned |
| `drying-shelf` | house-medium-artisan |
| `dust-cover` | library |
| `dust-sheet-partial` | mansion-library |
| `dye-vat` | textile-loomhouse |
| `earth-elemental-anvil` | elemental-earth-node |
| `earth-node-core` | elemental-earth-node |
| `egg-sac` | monster-lair-small |
| `egg-sac-mound` | spider-lair |
| `embroidery-frame` | noble-solar |
| `fainting-couch` | brothel-parlor |
| `fallen-antler` | fey-glade |
| `fallen-tool` | cabin-abandoned |
| `family-portrait-small` | house-medium-family |
| `fang-scatter` | spider-lair |
| `farm-tool-hung` | farmhouse-common |
| `feather-celestial` | celestial-vault |
| `fence-wood-low` | roadside-gallows |
| `fermentation-vat` | brewery |
| `ferry-cabin` | ferry-house |
| `ferry-raft` | ferry-house |
| `fey-archfey-throne` | fey-glade |
| `fey-lantern-bloom` | fey-glade |
| `fey-mushroom-ring` | fey-glade |
| `fire-ring` | shepherds-shelter |
| `firepit-central` | peasant-hovel |
| `fish-bucket` | ferry-house |
| `fishing-rod` | campsite-traveler |
| `flask-small` | refinery |
| `floating-barrel` | cistern |
| `flour-bag` | servants-kitchen |
| `focused-lamp` | interrogation-room |
| `footlocker` | barracks |
| `forge-altar` | temple-of-craft |
| `fortune-wheel` | gambling-den |
| `fossil-embedded` | elemental-earth-node |
| `fruit-rotten` | shrine-roadside |
| `fume-hood` | alchemy-lab |
| `fur-nest` | cave-bear-lair |
| `fur-rug` | hunting-lodge-large |
| `gallows-triple` | roadside-gallows |
| `game-piece` | command-room |
| `gauntlet-pile` | armory |
| `gear-locker` | ship-crew-quarters |
| `gear-pile` | workshop-artificer |
| `gem-cluster` | treasure-vault |
| `geode-cluster` | elemental-earth-node |
| `glove-silk` | tavern-highend |
| `glove-stained` | refinery |
| `glowcap-cluster` | mushroom-grove |
| `goblin-totem` | cave-goblin-warren |
| `grate-ceiling` | oubliette |
| `grate-shaft` | ship-cargo-hold |
| `great-hearth` | hunting-lodge-large |
| `half-built-device` | workshop-artificer |
| `half-eaten-carcass` | monster-lair-small |
| `half-finished-work` | house-medium-artisan |
| `hammer-giant` | infernal-forge |
| `hammer-rack` | smithy-large |
| `harp-floor` | noble-solar |
| `hat-tricorn` | tavern-highend |
| `hay-wisps` | farmhouse-common |
| `hearth-small` | nursery |
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
| `jar-of-teeth` | bog-witch-hut |
| `jewel-casket` | noble-bedchamber |
| `jeweler-bench` | shop-jeweler |
| `jewelry-loose` | thieves-guild-hideout |
| `judge-bench` | courthouse-chamber |
| `kennel` | hunting-lodge-large |
| `kettle-hook` | ship-galley |
| `knife-on-block` | servants-kitchen |
| `knit-blanket` | lighthouse-keepers-room |
| `knitting-pile` | house-medium-family |
| `ladder-library` | shop-bookseller |
| `ladder-rolling` | library |
| `ladle-iron` | foundry-great |
| `lantern` | gatehouse-inner |
| `lantern-ground` | campsite-traveler |
| `lantern-hand` | shop-general |
| `lean-to` | ranger-camp |
| `leather-strap` | shop-weaponsmith |
| `letter-home` | mansion-servants-quarters |
| `library-ladder` | mansion-library |
| `lint-clump` | textile-loomhouse |
| `liquor-bottle` | ship-captains-cabin |
| `lockpicks` | thieves-guild-hideout |
| `log-carriage` | mill-lumber |
| `longboat-cradle` | ship-main-deck |
| `loom-altar` | temple-of-craft |
| `loot-pile` | cave-bandit-camp |
| `lullaby-music-box` | nursery |
| `luminous-spore` | mushroom-grove |
| `magic-sigil-floor` | throne-room |
| `magical-glow-prop` | alchemy-lab |
| `magnifier` | shop-jeweler |
| `mallet-wooden` | cooperage |
| `map-case` | library |
| `map-pinned` | campsite-traveler |
| `map-scroll` | command-room |
| `market-cross` | market-square |
| `mash-tun` | brewery |
| `mask-cloth` | thieves-guild-hideout |
| `mask-feathered` | brothel-parlor |
| `mast-fore` | ship-main-deck |
| `meat-hook-rack` | butcher-shop |
| `mess-table-folding` | ship-crew-quarters |
| `millstone` | mill-grain |
| `mine-shaft-opening` | tunnel-mine-worked |
| `mist-pool` | shadowfell-mausoleum |
| `moldy-bread` | oubliette |
| `mosaic-fragment` | ancient-ruin-overgrown |
| `mound-entrance` | burial-mound |
| `mourning-bell` | shadowfell-mausoleum |
| `muddy-boot-prints` | hunting-lodge-large |
| `muddy-boots` | farmhouse-common |
| `mug` | monastery-refectory |
| `murder-hole-grate` | gatehouse-inner |
| `mushroom-basket` | cabin-witch |
| `mycelium-web` | mushroom-grove |
| `myconid-circle` | mushroom-cavern |
| `nail-pile` | general-workshop |
| `nails-box` | shop-general |
| `nails-crate` | smithy-large |
| `nurse-stool` | nursery |
| `obelisk-memorial` | shadowfell-mausoleum |
| `obelisk-stone-raw` | elemental-earth-node |
| `oil-reservoir` | lighthouse-keepers-room |
| `ooze-pool` | slime-pit |
| `ooze-puddle` | slime-pit |
| `oracle-pit` | oracle-chamber |
| `ore-pile` | tunnel-mine-worked |
| `ore-sorting-table` | tunnel-mine-worked |
| `ore-vein-prop` | elemental-earth-node |
| `orrery-magical` | demiplane-laboratory |
| `overhead-crane` | foundry-great |
| `overturned-table` | cabin-abandoned |
| `paperweight` | mansion-study |
| `pearl-strand` | shop-jeweler |
| `pedestal` | treasure-vault |
| `peel-wooden` | bakery |
| `pelt-roll` | cabin-hunters |
| `pelt-stack` | cabin-trapper |
| `pen-and-inkwell` | interrogation-room |
| `personal-chest` | barracks |
| `pewter-mug` | farmhouse-common |
| `pewter-plate` | ship-galley |
| `pianoforte` | house-noble-townhouse |
| `pickaxe-rack` | tunnel-mine-worked |
| `picket-line` | campsite-traveler |
| `picture-book` | nursery |
| `pigeon-flock` | plaza-civic |
| `pillar-crystal` | crystal-grotto |
| `pillar-marble` | celestial-vault |
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
| `prayer-shelf` | farmhouse-common |
| `printing-press` | scriptorium-mundane |
| `prisoner-dock` | courthouse-chamber |
| `private-booth` | gambling-den |
| `produce-pile` | market-square |
| `puddle` | oubliette |
| `puddle-wort` | brewery |
| `quench-trough-blood` | infernal-forge |
| `quill-pen` | scriptorium-dark |
| `rabbit-trail` | forest-clearing |
| `rail-track` | tunnel-mine-worked |
| `rat-sign` | mill-grain |
| `ration-moldy` | ruined-watchtower |
| `ration-pack` | cabin-hunters |
| `raven-perch` | cabin-witch |
| `raven-perched` | graveyard-village |
| `ravens-feather` | burial-mound |
| `reading-chair` | mansion-library |
| `reading-table` | library |
| `reagent-rack` | demiplane-laboratory |
| `reliquary-bone` | shadowfell-mausoleum |
| `residual-torch-from-victims` | monster-lair-small |
| `resonance-pool` | crystal-grotto |
| `ring-display` | shop-jeweler |
| `ritual-candle` | standing-stones-circle |
| `rolled-blanket` | house-small |
| `rolling-pin` | bakery |
| `root-tangle` | mushroom-cavern |
| `rope-bridge` | chasm-crossing |
| `rope-cordon` | plaza-civic |
| `round-table` | sanctum-order |
| `rune-chalk-mark` | demiplane-laboratory |
| `rusted-bucket` | cistern |
| `rusted-weapon` | slime-pit |
| `sack-pile` | mill-grain |
| `sail-rolled` | ship-main-deck |
| `salt-barrel` | butcher-shop |
| `sand-mold` | foundry-great |
| `sand-shaker` | scriptorium-mundane |
| `sand-table` | command-room |
| `sarcophagus-shadow` | shadowfell-mausoleum |
| `sausage-link` | butcher-shop |
| `sawmill-blade` | mill-lumber |
| `scabbard-empty` | shop-weaponsmith |
| `scale-justice` | courthouse-chamber |
| `schematic-rolled` | workshop-artificer |
| `scoop-wooden` | mill-grain |
| `scorched-cell` | boss-chamber |
| `scorched-scroll` | infernal-court |
| `scratch-marks` | prison-block |
| `scratched-tally` | ship-brig |
| `screen-painted` | nursery |
| `screwdriver` | workshop-artificer |
| `scroll-loose` | library |
| `scroll-rack-tall` | library |
| `scroll-rolled` | ship-captains-cabin |
| `scroll-stack` | demiplane-laboratory |
| `scrying-crystal` | crystal-grotto |
| `sealing-wax` | mansion-study |
| `servant-uniform-hung` | mansion-servants-quarters |
| `settee` | house-noble-townhouse |
| `sewing-kit-small` | mansion-servants-quarters |
| `shadow-tree` | shadowfell-mausoleum |
| `shaft-light-from-above` | oubliette |
| `shattered-shield` | boss-chamber |
| `shed-skin` | monster-lair-small |
| `sheep-dung` | shepherds-shelter |
| `shelf-crockery` | farmhouse-kitchen |
| `shelf-tools` | house-medium-artisan |
| `shepherds-crook` | shepherds-shelter |
| `shield-broken` | ruined-watchtower |
| `ship-in-bottle-shelf` | ship-captains-cabin |
| `ship-stove` | ship-galley |
| `ships-ladder` | ship-main-deck |
| `shop-counter` | smithy-large |
| `shovel-leaning` | graveyard-village |
| `shrieker` | mushroom-cavern |
| `shroud-torn` | shadowfell-mausoleum |
| `side-table` | mansion-library |
| `signal-bell` | ferry-house |
| `signal-gong` | underdark-outpost |
| `signet-ring-tray` | noble-bedchamber |
| `silk-cocoon` | spider-lair |
| `silk-cocoon-victim` | spider-lair |
| `silver-tray` | tavern-highend |
| `single-tooth` | oubliette |
| `skull-offering` | ritual-chamber |
| `slime-puddle` | monster-lair-small |
| `slime-trail` | slime-pit |
| `slug-trail` | mushroom-grove |
| `small-bone` | cave-living |
| `smoke-wisp` | refinery |
| `smuggled-cage` | ship-cargo-hold |
| `snare-set` | ranger-camp |
| `snuffbox` | house-noble-townhouse |
| `songbird-nest` | fey-glade |
| `soot-print` | charcoal-burner-camp |
| `soot-streak` | infernal-forge |
| `soul-coin-pile` | infernal-court |
| `specimen-tank` | alchemy-lab |
| `spell-component-loose` | demiplane-laboratory |
| `spice-rack` | ship-galley |
| `spider-husk` | spider-lair |
| `spider-matriarch-pad` | spider-lair |
| `spill-reagent` | refinery |
| `spilled-flour-sack` | cabin-abandoned |
| `spilled-reagent` | alchemy-lab |
| `spilled-salt` | ritual-chamber |
| `spilled-toys` | nursery |
| `spindle-rack` | house-medium-artisan |
| `spore-pool` | mushroom-cavern |
| `spore-puff` | mushroom-cavern |
| `spore-puffball` | mushroom-grove |
| `spring-coil` | workshop-artificer |
| `spyglass-tripod` | scouts-blind |
| `stair-remnant` | ruined-watchtower |
| `staircase-wooden` | tavern-common |
| `stalagmite-forest` | cave-living |
| `statue-dark-god` | dark-temple |
| `statue-devil` | infernal-court |
| `statue-small` | shrine-roadside |
| `statue-solar` | celestial-vault |
| `statue-toppled` | ancient-ruin-overgrown |
| `statue-weeping` | graveyard-village |
| `stave-horse` | cooperage |
| `stave-pile` | cooperage |
| `stern-window` | ship-captains-cabin |
| `stone-arch-natural` | chasm-crossing |
| `stone-column-broken` | ancient-ruin-overgrown |
| `stone-debris` | elemental-earth-node |
| `stool-bar` | tavern-common |
| `stool-wooden` | ship-brig |
| `stopper-cork` | refinery |
| `stove-iron` | apartment-tenement |
| `strange-residue` | alchemy-lab |
| `straw-bed-large` | monster-lair-small |
| `straw-wisps` | peasant-hovel |
| `strigil` | bath-house |
| `summoning-pool-glow` | boss-chamber |
| `sun-disc-altar` | celestial-vault |
| `sun-window` | noble-solar |
| `supply-cache` | underdark-outpost |
| `table-long` | tavern-common |
| `table-round` | tavern-common |
| `tally-marks-wall` | oubliette |
| `tally-stick` | dock-warehouse |
| `tapestry-dark` | dark-temple |
| `tent-collapsed` | campsite-traveler |
| `thread-rack` | textile-loomhouse |
| `threadbare-rug` | mansion-servants-quarters |
| `thumbscrews` | interrogation-room |
| `timber-brace` | tunnel-mine-worked |
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
| `trash-heap` | cave-goblin-warren |
| `travel-pack` | inn-common-room |
| `treasure-chest-naval` | ship-cargo-hold |
| `tree-ancient-fey` | fey-glade |
| `tree-old` | druid-grove |
| `trophy-case` | ship-captains-cabin |
| `trunk-open` | cabin-abandoned |
| `turnip-pile` | peasant-hovel |
| `tweezers` | shop-jeweler |
| `type-case` | scriptorium-mundane |
| `urn` | crypt |
| `vase-floor` | house-noble-townhouse |
| `velvet-cloth` | shop-jeweler |
| `victim-cocoon` | slime-pit |
| `vine-hanging` | ancient-ruin-overgrown |
| `violet-fungus` | mushroom-cavern |
| `wagon` | lumberyard |
| `walking-stick` | inn-common-room |
| `wardrobe-small` | nursery |
| `washing-line` | apartment-tenement |
| `watchfire-pit` | underdark-outpost |
| `water-barrel` | ship-main-deck |
| `water-dish-dry` | oubliette |
| `water-jar` | bath-house |
| `water-pitcher` | interrogation-room |
| `water-skin` | charcoal-burner-camp |
| `waterskin` | campsite-traveler |
| `weapon-rack-broken` | ruined-watchtower |
| `weapon-rack-ceremonial` | throne-room |
| `weapon-rack-infernal` | infernal-forge |
| `weapon-rack-wall` | noble-bedchamber |
| `web-cluster` | monster-lair-small |
| `web-floor` | spider-lair |
| `web-funnel` | spider-lair |
| `whittled-stick` | ranger-camp |
| `wildflower-patch` | druid-grove |
| `winch-block` | dock-warehouse |
| `winch-mechanism` | gatehouse-inner |
| `winch-platform` | chasm-crossing |
| `wind-chime-pillar` | elemental-shrine |
| `window-seat` | noble-solar |
| `wine-decanter` | command-room |
| `witch-hut` | bog-witch-hut |
| `witch-hut-stilts` | bog-witch-hut |
| `witness-dock` | courthouse-chamber |
| `wood-pile` | campsite-traveler |
| `wood-shavings` | general-workshop |
| `wooden-paddle` | brewery |
| `wooden-spoon` | ship-galley |
| `wooden-spoon-pile` | farmhouse-kitchen |
| `work-in-progress` | general-workshop |
