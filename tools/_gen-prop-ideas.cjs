// Regenerate the tier tables in prop-ideas.md from the missing-props report.
// Run with: node tools/_gen-prop-ideas.cjs
//
// The top of prop-ideas.md (everything above the "## Tier 1" heading) is
// hand-written context and MUST be preserved. This script splits the file
// at that sentinel and rewrites only the tier tables below it. If the file
// doesn't exist, it writes a minimal header so the result is still valid.
const fs = require('fs');
const path = require('path');

const REPORT_PATH = path.join(__dirname, '..', 'src', 'rooms', '_missing-props-report.json');
const OUT_PATH = path.join(__dirname, '..', 'prop-ideas.md');
const SENTINEL = '## Tier 1 — High priority';

const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));

const sorted = [...report.missing].sort((a, b) => {
  if (b.usedInSpecs !== a.usedInSpecs) return b.usedInSpecs - a.usedInSpecs;
  return a.prop.localeCompare(b.prop);
});

const tier1 = sorted.filter((m) => m.usedInSpecs >= 3);
const tier2 = sorted.filter((m) => m.usedInSpecs === 2);
const tier3 = sorted.filter((m) => m.usedInSpecs === 1);

const fmt = (specs) =>
  specs.length <= 4 ? specs.join(', ') : `${specs.slice(0, 3).join(', ')} +${specs.length - 3} more`;

// Build the auto-generated tail (from "## Tier 1" heading to end of file).
const tail = [];
tail.push('## Tier 1 — High priority (used in 3+ specs)');
tail.push('');
tail.push('Each prop here unlocks multiple room types. Author these first.');
tail.push('');
tail.push('| Prop | Uses | Rooms |');
tail.push('|------|------|-------|');
for (const m of tier1) tail.push(`| \`${m.prop}\` | ${m.usedInSpecs} | ${fmt(m.specs)} |`);
tail.push('');
tail.push('---');
tail.push('');
tail.push('## Tier 2 — Medium priority (used in 2 specs)');
tail.push('');
tail.push('| Prop | Rooms |');
tail.push('|------|-------|');
for (const m of tier2) tail.push(`| \`${m.prop}\` | ${m.specs.join(', ')} |`);
tail.push('');
tail.push('---');
tail.push('');
tail.push('## Tier 3 — Long tail (used in 1 spec each)');
tail.push('');
tail.push(
  'Flavor props. Only author when building the specific room that needs them, or if they fit a broader aesthetic worth supporting.',
);
tail.push('');
tail.push('| Prop | Room |');
tail.push('|------|------|');
for (const m of tier3) tail.push(`| \`${m.prop}\` | ${m.specs[0]} |`);
tail.push('');

// Preserve the existing hand-written head if the file exists.
let head;
if (fs.existsSync(OUT_PATH)) {
  const existing = fs.readFileSync(OUT_PATH, 'utf8');
  const idx = existing.indexOf(SENTINEL);
  if (idx < 0) {
    throw new Error(
      `prop-ideas.md exists but doesn't contain the "${SENTINEL}" sentinel. ` +
        `Refusing to overwrite — manually fix the file or delete it to regenerate from scratch.`,
    );
  }
  head = existing.slice(0, idx);
} else {
  // Minimal fallback head — only used when no hand-written context exists yet.
  head = [
    '# Prop Ideas — Missing from Catalog',
    '',
    'Generated from room vocab specs in `src/rooms/`. Regenerate tier tables with `node tools/_gen-prop-ideas.cjs`.',
    '',
    `**Total missing:** ${report.missing.length}  |  **Tier 1 (3+ uses):** ${tier1.length}  |  **Tier 2 (2 uses):** ${tier2.length}  |  **Tier 3 (1 use):** ${tier3.length}`,
    '',
  ].join('\n');
}

// Always also refresh the headline totals in the preserved head, since they
// change on every regeneration. Match the "**Total missing:** ..." line.
head = head.replace(
  /\*\*Total missing:\*\*[^\n]*\n/,
  `**Total missing:** ${report.missing.length}  |  **Tier 1 (3+ uses):** ${tier1.length}  |  **Tier 2 (2 uses):** ${tier2.length}  |  **Tier 3 (1 use):** ${tier3.length}\n`,
);

fs.writeFileSync(OUT_PATH, head + tail.join('\n'));
const sz = fs.statSync(OUT_PATH).size;
console.log(`Wrote ${OUT_PATH}: ${(sz / 1024).toFixed(1)} KB`);
console.log(`Tier 1: ${tier1.length} | Tier 2: ${tier2.length} | Tier 3: ${tier3.length}`);
console.log('Head preserved from existing file (hand-written context intact).');
