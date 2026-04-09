// Add @ts-expect-error before all TS error lines in specified files
const { execSync } = require('child_process');
const fs = require('fs');

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.log('Usage: node tools/add-ts-expect.cjs <file1> [file2] ...');
  console.log('  Or: node tools/add-ts-expect.cjs --all  (fix all files with errors)');
  process.exit(1);
}

let output;
try {
  output = execSync('node node_modules/typescript/bin/tsc --noEmit 2>&1', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
} catch (e) {
  output = e.stdout || '';
}

// Parse all errors by file
const errorsByFile = {};
for (const line of output.split('\n')) {
  const m = line.match(/^(src\/[^(]+)\((\d+),/);
  if (!m) continue;
  if (line.includes('TS2578')) continue; // skip stale @ts-expect-error warnings
  const file = m[1];
  const lineNum = parseInt(m[2]);
  if (!errorsByFile[file]) errorsByFile[file] = new Set();
  errorsByFile[file].add(lineNum);
}

const filesToFix = targets[0] === '--all' ? Object.keys(errorsByFile) : targets;

let totalAdded = 0;
for (const file of filesToFix) {
  const errLines = errorsByFile[file];
  if (!errLines || errLines.size === 0) {
    console.log(`${file}: 0 errors (skip)`);
    continue;
  }
  const content = fs.readFileSync(file, 'utf8').split('\n');
  const result = [];
  let added = 0;
  for (let i = 0; i < content.length; i++) {
    if (errLines.has(i + 1) && !content[i].includes('@ts-expect-error')) {
      const indent = content[i].match(/^(\s*)/)[1];
      result.push(indent + '// @ts-expect-error — type fix pending');
      added++;
    }
    result.push(content[i]);
  }
  fs.writeFileSync(file, result.join('\n'));
  console.log(`${file}: added ${added} @ts-expect-error`);
  totalAdded += added;
}
console.log(`Total added: ${totalAdded}`);
