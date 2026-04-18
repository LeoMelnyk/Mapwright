// Generates showcase commands JSON for the 307 props authored in batches 1-13.
// Usage: node tools/_gen-prop-showcase.cjs
// Writes: tools/_showcase/batch-NN.commands.json  (one per batch)

const fs = require('fs');
const path = require('path');

const PROPS_DIR = path.resolve(__dirname, '../src/props');
const OUT_DIR = path.resolve(__dirname, '_showcase');
fs.mkdirSync(OUT_DIR, { recursive: true });

// The 307 props authored in batches 1-13, grouped by theme.
const BATCHES = [
  {
    name: 'batch-01-kitchen',
    title: 'Kitchen & Food',
    props: [
      'apron-floured',
      'peel-wooden',
      'rolling-pin',
      'flour-bag',
      'broken-plate',
      'cutlery-pile',
      'knife-on-block',
      'shelf-crockery',
      'wooden-spoon-pile',
      'salt-barrel',
      'sausage-link',
      'meat-hook-rack',
      'bundle-of-herbs',
      'cat-hunting',
      'turnip-pile',
      'chamber-pot',
      'plate-stack',
      'bread-crust',
      'fruit-rotten',
      'mug',
      'bowl',
      'chicken-loose',
      'chicken-bone',
      'cooking-tripod',
      'cook-spit',
      'firepit-central',
    ],
  },
  {
    name: 'batch-02-scribe',
    title: 'Scribe & Civic',
    props: [
      'abacus',
      'blotting-rag',
      'ink-stone',
      'ink-pot-small',
      'paperweight',
      'pipe-ashtray',
      'printing-press',
      'quill-pen',
      'sand-shaker',
      'sealing-wax',
      'tobacco-pipe',
      'type-case',
      'snuffbox',
      'magnifier',
      'tweezers',
      'ladder-library',
      'letter-home',
      'clerk-desk',
      'judge-bench',
      'chess-set',
      'embroidery-frame',
      'family-portrait-small',
      'broadsheet-posted',
      'scale-justice',
    ],
  },
  {
    name: 'batch-03-forge',
    title: 'Forge & Workshop',
    props: [
      'coal-pile',
      'hammer-giant',
      'horseshoe',
      'infernal-furnace',
      'ingot-pile',
      'nail-pile',
      'nails-box',
      'quench-trough-blood',
      'soot-streak',
      'weapon-rack-infernal',
      'wood-shavings',
      'work-in-progress',
      'leather-strap',
      'polish-rag',
      'half-finished-work',
      'forge-altar',
      'loom-altar',
      'tool-rack-wall',
      'tool-scatter',
      'horse-dung',
      'scabbard-empty',
      'jeweler-bench',
      'pit-saw',
    ],
  },
  {
    name: 'batch-04-tavern',
    title: 'Tavern, Gambling & Noble',
    props: [
      'card-table',
      'chips-stack',
      'dice-pile',
      'dice-table',
      'dart-board',
      'fortune-wheel',
      'private-booth',
      'cigar-case',
      'glove-silk',
      'hat-tricorn',
      'silver-tray',
      'stool-bar',
      'broken-stool',
      'staircase-wooden',
      'dog-sleeping',
      'fainting-couch',
      'mask-feathered',
      'pianoforte',
      'harp-floor',
      'settee',
      'vase-floor',
      'window-seat',
      'sun-window',
      'table-long',
      'table-round',
      'threadbare-rug',
    ],
  },
  {
    name: 'batch-05-cave',
    title: 'Cave, Mushroom & Underground',
    props: [
      'decaying-log',
      'glowcap-cluster',
      'luminous-spore',
      'mushroom-basket',
      'mycelium-web',
      'myconid-circle',
      'slug-trail',
      'spore-pool',
      'spore-puff',
      'spore-puffball',
      'shrieker',
      'stalagmite-forest',
      'violet-fungus',
      'root-tangle',
      'small-bone',
      'claw-marked-wall',
      'fur-nest',
      'broken-antler',
      'driftwood',
      'mound-entrance',
      'dry-leaves',
      'trash-heap',
      'goblin-totem',
      'cage-wicker',
      'bottle-empty',
    ],
  },
  {
    name: 'batch-06-crystal',
    title: 'Crystal, Magic & Ritual',
    props: [
      'crystal-cluster-large',
      'crystal-dust',
      'crystal-heart',
      'pillar-crystal',
      'resonance-pool',
      'scrying-crystal',
      'magical-glow-prop',
      'magic-sigil-floor',
      'wind-chime-pillar',
      'oracle-pit',
      'chalk-circle-floor',
      'chalk-marks',
      'ritual-candle',
      'poppet',
      'raven-perch',
      'statue-dark-god',
      'tapestry-dark',
      'skull-offering',
      'spilled-salt',
      'torn-page',
      'blood-basin',
      'bloodstain-large',
      'summoning-pool-glow',
      'scorched-cell',
      'specimen-tank',
    ],
  },
  {
    name: 'batch-07-graveyard',
    title: 'Graveyard, Death & Torture',
    props: [
      'bone-chandelier',
      'branding-iron',
      'crypt-entrance',
      'crow-perched',
      'gallows-triple',
      'hot-iron',
      'interrogation-chair',
      'pincers',
      'raven-perched',
      'ravens-feather',
      'scratch-marks',
      'shovel-leaning',
      'torture-instrument-small',
      'tooth-jar',
      'statue-weeping',
      'urn',
      'dropped-rope',
      'torn-notice',
      'fence-wood-low',
      'chain-shackle',
      'prisoner-dock',
      'witness-dock',
      'scratched-tally',
      'iron-cage-cell',
    ],
  },
  {
    name: 'batch-08-hunter',
    title: 'Hunter, Outdoor & Peasant',
    props: [
      'antler-rack',
      'fur-rug',
      'great-hearth',
      'hunting-horn',
      'kennel',
      'muddy-boot-prints',
      'pelt-roll',
      'pelt-stack',
      'ration-pack',
      'snare-set',
      'lean-to',
      'whittled-stick',
      'carved-stick',
      'shepherds-crook',
      'straw-wisps',
      'sheep-dung',
      'prayer-beads',
      'prayer-flag',
      'dried-flowers',
      'wildflower-patch',
      'rabbit-trail',
      'butterfly-cloud',
      'tree-old',
      'vine-hanging',
      'fire-ring',
    ],
  },
  {
    name: 'batch-09-textile',
    title: 'Textile, Domestic & Sewing',
    props: [
      'basket',
      'bobbin',
      'dye-vat',
      'lint-clump',
      'thread-rack',
      'spindle-rack',
      'knit-blanket',
      'knitting-pile',
      'rolled-blanket',
      'blanket-folded',
      'clothes-rack',
      'drying-shelf',
      'sewing-kit-small',
      'servant-uniform-hung',
      'bed-small',
      'chest-wooden',
      'chest-small',
      'trunk-open',
      'footlocker',
      'personal-chest',
      'clay-cup',
      'childs-toy',
    ],
  },
  {
    name: 'batch-10-ship',
    title: 'Ship, Military & Outdoors',
    props: [
      'bench-long',
      'boots-by-bed',
      'boots-discarded',
      'gear-locker',
      'mess-table-folding',
      'stool-wooden',
      'gauntlet-pile',
      'ferry-cabin',
      'ferry-raft',
      'fish-bucket',
      'signal-bell',
      'cabin-window-glow',
      'water-jar',
      'water-skin',
      'strigil',
      'supply-cache',
      'signal-gong',
      'watchfire-pit',
      'brush-blind',
      'spyglass-tripod',
      'oil-reservoir',
      'potbelly-stove',
    ],
  },
  {
    name: 'batch-11-civic',
    title: 'Civic, Gatehouse & Shop',
    props: [
      'clock-tower-base',
      'rope-cordon',
      'pigeon-flock',
      'toll-barrier',
      'toll-house',
      'cargo-scale',
      'clerestory-window',
      'contraband-stash',
      'winch-block',
      'winch-mechanism',
      'tally-stick',
      'murder-hole-grate',
      'arrow-slit-wall',
      'lantern',
      'lantern-hand',
      'candle-bundle',
      'potion-bottle',
      'dried-lizard',
      'bone-specimen',
      'velvet-cloth',
      'pearl-strand',
      'ring-display',
    ],
  },
  {
    name: 'batch-12-treasure',
    title: 'Treasure, Thieves, Mill & Ruin',
    props: [
      'coin-spill',
      'crown-on-cushion',
      'gem-cluster',
      'pedestal',
      'mask-cloth',
      'lockpicks',
      'jewelry-loose',
      'loot-pile',
      'millstone',
      'sack-pile',
      'rat-sign',
      'scoop-wooden',
      'log-carriage',
      'sawmill-blade',
      'dog-chain',
      'wagon',
      'mosaic-fragment',
      'statue-toppled',
      'stone-column-broken',
      'broken-statue',
      'shattered-shield',
      'statue-small',
    ],
  },
  {
    name: 'batch-13-ritual',
    title: 'Ritual, Sacred, Abandoned & Misc',
    props: [
      'baptismal-pool',
      'confessional-booth',
      'curtain-screen',
      'bell-small',
      'arena-pit',
      'iron-chair',
      'round-table',
      'weapon-rack-ceremonial',
      'spilled-reagent',
      'strange-residue',
      'overturned-table',
      'fallen-tool',
      'crate-splintered',
      'spilled-flour-sack',
      'shelf-tools',
      'bridge-wood',
      'ancient-tree',
      'animal-pen-partition',
      'travel-pack',
      'walking-stick',
    ],
  },
];

function readFootprint(name) {
  const file = path.join(PROPS_DIR, `${name}.prop`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing prop file: ${name}.prop`);
  }
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^footprint:\s*(\d+)x(\d+)/m);
  if (!m) throw new Error(`No footprint in ${name}.prop`);
  return [parseInt(m[1], 10), parseInt(m[2], 10)]; // [rows, cols]
}

// Slot dimensions: enough to hold a 3x3 prop + a 1-cell label row below.
// SLOT_ROWS = 5 (3 prop + 1 gap + 1 label), SLOT_COLS = 5 (3 prop + 1 on each side).
const SLOT_ROWS = 5;
const SLOT_COLS = 5;
const GRID_COLS = 6; // 6 props wide per row of the showcase
const MARGIN = 2; // 2-cell margin around the edge

function buildBatch(batch) {
  const n = batch.props.length;
  const gridRows = Math.ceil(n / GRID_COLS);
  const mapCols = GRID_COLS * SLOT_COLS + MARGIN * 2;
  const mapRows = gridRows * SLOT_ROWS + MARGIN * 2 + 2; // +2 for title space

  const commands = [
    ['newMap', `Props — ${batch.title}`, mapRows, mapCols, 5, 'blue-parchment'],
    ['createRoom', MARGIN, MARGIN, mapRows - MARGIN - 1, mapCols - MARGIN - 1],
    ['setLabelStyle', 'plain'],
    ['setFeature', 'grid', false],
    ['setFeature', 'border', true],
  ];

  batch.props.forEach((name, i) => {
    const gr = Math.floor(i / GRID_COLS);
    const gc = i % GRID_COLS;
    const slotTopRow = MARGIN + gr * SLOT_ROWS;
    const slotLeftCol = MARGIN + gc * SLOT_COLS;

    const [fr, fc] = readFootprint(name);
    // Center prop anchor within the top 4 rows / 5 cols, so the bottom row
    // is left free for the label.
    const propAreaRows = SLOT_ROWS - 1; // 4
    const anchorRow = slotTopRow + Math.max(0, Math.floor((propAreaRows - fr) / 2));
    const anchorCol = slotLeftCol + Math.max(0, Math.floor((SLOT_COLS - fc) / 2));

    commands.push(['placeProp', anchorRow, anchorCol, name]);
    // Label on the bottom row of the slot, centered column
    commands.push(['setLabel', slotTopRow + SLOT_ROWS - 1, slotLeftCol + 2, name]);
  });

  commands.push(['setAmbientLight', 1.0]);
  commands.push(['setLightingEnabled', false]);
  commands.push(['waitForTextures', 5000]);

  const outFile = path.join(OUT_DIR, `${batch.name}.commands.json`);
  fs.writeFileSync(outFile, JSON.stringify(commands, null, 2));
  console.log(`  ${batch.name}: ${n} props, ${mapRows}x${mapCols} cells, ${commands.length} commands`);
  return outFile;
}

console.log(`Writing to ${OUT_DIR}`);
BATCHES.forEach(buildBatch);
console.log(`Wrote ${BATCHES.length} batches.`);

// --- Combined all-in-one showcase ---
// Produces a single commands file with every prop in one big map. Sections are
// labeled by batch via a bold label on the first row of each batch's grid.
function buildCombined() {
  const SECTION_GAP = 2; // blank rows between batches
  const mapCols = GRID_COLS * SLOT_COLS + MARGIN * 2;

  // Compute total rows: for each batch, (ceil(n/GRID_COLS) * SLOT_ROWS) + SECTION_GAP + 1 header row.
  let mapRows = MARGIN;
  const batchLayouts = BATCHES.map((batch) => {
    const gridRows = Math.ceil(batch.props.length / GRID_COLS);
    const headerRow = mapRows; // 1-row section header
    const firstSlotRow = mapRows + 1;
    mapRows = firstSlotRow + gridRows * SLOT_ROWS + SECTION_GAP;
    return { batch, gridRows, headerRow, firstSlotRow };
  });
  mapRows += MARGIN;

  const commands = [
    ['newMap', 'Prop Showcase — 306 new props (batches 1-13)', mapRows, mapCols, 5, 'blue-parchment'],
    ['createRoom', MARGIN, MARGIN, mapRows - MARGIN - 1, mapCols - MARGIN - 1],
    ['setLabelStyle', 'plain'],
    ['setFeature', 'grid', false],
    ['setFeature', 'border', true],
    ['setFeature', 'compass', false],
  ];

  for (const { batch, gridRows, headerRow, firstSlotRow } of batchLayouts) {
    // Section header label spanning the first 3 columns
    commands.push(['setLabel', headerRow, MARGIN + 1, `=== ${batch.title} (${batch.props.length}) ===`]);

    batch.props.forEach((name, i) => {
      const gr = Math.floor(i / GRID_COLS);
      const gc = i % GRID_COLS;
      const slotTopRow = firstSlotRow + gr * SLOT_ROWS;
      const slotLeftCol = MARGIN + gc * SLOT_COLS;

      const [fr, fc] = readFootprint(name);
      const propAreaRows = SLOT_ROWS - 1;
      const anchorRow = slotTopRow + Math.max(0, Math.floor((propAreaRows - fr) / 2));
      const anchorCol = slotLeftCol + Math.max(0, Math.floor((SLOT_COLS - fc) / 2));

      commands.push(['placeProp', anchorRow, anchorCol, name]);
      commands.push(['setLabel', slotTopRow + SLOT_ROWS - 1, slotLeftCol + 2, name]);
    });
  }

  commands.push(['setAmbientLight', 1.0]);
  commands.push(['setLightingEnabled', false]);

  const outFile = path.join(OUT_DIR, 'all-props-combined.commands.json');
  fs.writeFileSync(outFile, JSON.stringify(commands, null, 2));
  const totalProps = BATCHES.reduce((n, b) => n + b.props.length, 0);
  console.log(`\nCombined: ${totalProps} props, ${mapRows}x${mapCols} cells, ${commands.length} commands`);
  console.log(`  -> ${outFile}`);
}

buildCombined();
