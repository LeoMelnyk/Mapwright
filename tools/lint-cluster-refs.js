#!/usr/bin/env node
/**
 * lint-cluster-refs.js — Report every `clusters_with` entry that references a prop
 * that doesn't exist in the catalog.
 *
 * Separate from `validate-props.js` because there are ~200 existing dead refs that
 * represent "props we'd like to create" more than actual bugs. This tool surfaces
 * the backlog without polluting the main validator's signal.
 *
 * Usage:
 *   node tools/lint-cluster-refs.js               # frequency-sorted list of dead refs
 *   node tools/lint-cluster-refs.js --by-file     # group by source prop instead
 *
 * Exit code 0 if no dead refs, 1 otherwise.
 */

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROPS_DIR = join(__dirname, '..', 'src', 'props');
const args = process.argv.slice(2);
const byFile = args.includes('--by-file');

const files = readdirSync(PROPS_DIR)
  .filter((f) => f.endsWith('.prop'))
  .sort();
const knownProps = new Set(files.map((f) => f.replace(/\.prop$/, '')));

const refCounts = {};
const refSources = {};
const fileDeadRefs = {};

for (const file of files) {
  const raw = readFileSync(join(PROPS_DIR, file), 'utf8');
  // `[^\S\r\n]*` only consumes whitespace within the same line. Using `\s*`
  // (which matches newlines) caused `clusters_with:` lines with no value to
  // greedily consume the newline and slurp the next line's text — turning
  // e.g. `notes: Standing light…` into a phantom cluster ref.
  const m = raw.match(/^clusters_with:[^\S\r\n]*(.*)$/m);
  if (!m) continue;
  const parts = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (knownProps.has(p)) continue;
    refCounts[p] = (refCounts[p] || 0) + 1;
    (refSources[p] = refSources[p] || []).push(file);
    (fileDeadRefs[file] = fileDeadRefs[file] || []).push(p);
  }
}

const totalDeadRefs = Object.values(refCounts).reduce((a, b) => a + b, 0);
const uniqueDeadRefs = Object.keys(refCounts).length;

if (byFile) {
  console.log(
    `${Object.keys(fileDeadRefs).length} files have ${totalDeadRefs} dead clusters_with refs across ${uniqueDeadRefs} missing prop names.\n`,
  );
  for (const [file, refs] of Object.entries(fileDeadRefs).sort()) {
    console.log(`${file}:`);
    for (const r of refs) console.log(`  - ${r}`);
  }
} else {
  const sorted = Object.entries(refCounts).sort((a, b) => b[1] - a[1]);
  console.log(`${totalDeadRefs} dead refs across ${uniqueDeadRefs} missing prop names. Sources listed per ref.\n`);
  for (const [ref, count] of sorted) {
    const sources =
      refSources[ref].slice(0, 5).join(', ') + (refSources[ref].length > 5 ? `, +${refSources[ref].length - 5}` : '');
    console.log(`  ${String(count).padStart(3)}×  ${ref.padEnd(30)} ← ${sources}`);
  }
}

process.exit(totalDeadRefs > 0 ? 1 : 0);
