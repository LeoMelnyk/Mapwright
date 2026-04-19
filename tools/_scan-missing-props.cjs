// Regenerate src/rooms/_missing-props-report.json by scanning room specs.
// Extracts prop names from primary_palette[].props, primary_palette[].surrounded_by,
// secondary_palette, and scatter_palette — then cross-references against src/props/.
// Usage: node tools/_scan-missing-props.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROOMS_DIR = path.join(ROOT, 'src', 'rooms');
const PROPS_DIR = path.join(ROOT, 'src', 'props');
const OUT_PATH = path.join(ROOMS_DIR, '_missing-props-report.json');

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.room.json')) acc.push(full);
  }
  return acc;
}

function extractProps(spec) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.length) out.add(v);
  };
  const pal = spec.primary_palette || [];
  for (const entry of pal) {
    if (!entry) continue;
    (entry.props || []).forEach(add);
    (entry.surrounded_by || []).forEach(add);
  }
  (spec.secondary_palette || []).forEach(add);
  (spec.scatter_palette || []).forEach(add);
  if (spec.lighting_notes && Array.isArray(spec.lighting_notes.common_sources)) {
    spec.lighting_notes.common_sources.forEach(add);
  }
  return out;
}

const specFiles = walk(ROOMS_DIR);
const existingProps = new Set(
  fs
    .readdirSync(PROPS_DIR)
    .filter((f) => f.endsWith('.prop'))
    .map((f) => f.replace(/\.prop$/, '')),
);

const usage = new Map(); // prop -> Set of spec names
for (const file of specFiles) {
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = spec.name || path.basename(file, '.room.json');
  for (const prop of extractProps(spec)) {
    if (!usage.has(prop)) usage.set(prop, new Set());
    usage.get(prop).add(name);
  }
}

const allReferenced = [...usage.keys()].sort();
const missing = allReferenced
  .filter((p) => !existingProps.has(p))
  .map((p) => ({ prop: p, usedInSpecs: usage.get(p).size, specs: [...usage.get(p)].sort() }));

const report = {
  generatedAt: new Date().toISOString(),
  totalSpecs: specFiles.length,
  totalUniquePropsReferenced: allReferenced.length,
  existingProps: existingProps.size,
  missingProps: missing.length,
  missing,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
console.log(`Wrote ${OUT_PATH}`);
console.log(`Specs scanned: ${specFiles.length}`);
console.log(`Unique props referenced: ${allReferenced.length}`);
console.log(`Existing props: ${existingProps.size}`);
console.log(`Still missing: ${missing.length}`);
const t1 = missing.filter((m) => m.usedInSpecs >= 3).length;
const t2 = missing.filter((m) => m.usedInSpecs === 2).length;
const t3 = missing.filter((m) => m.usedInSpecs === 1).length;
console.log(`  Tier 1 (3+ uses): ${t1}  |  Tier 2 (2 uses): ${t2}  |  Tier 3 (1 use): ${t3}`);
