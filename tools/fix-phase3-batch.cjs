const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Find all .ts files with @ts-expect-error
const files = glob.sync('src/**/*.ts').filter(f => {
  const content = fs.readFileSync(f, 'utf8');
  return content.includes('@ts-expect-error');
});

let totalFixed = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  const original = content;
  
  // Fix: querySelectorAll('.class') → querySelectorAll<HTMLElement>('.class')
  // Only where the next line accesses .style, .dataset, .click, etc.
  content = content.replace(
    /document\.querySelectorAll\(([^)]+)\)(?!<)/g,
    'document.querySelectorAll<HTMLElement>($1)'
  );
  
  // Fix: querySelector('.class') where not already generic
  // Only non-generic querySelector calls
  content = content.replace(
    /document\.querySelector\(([^)]+)\)(?![\s\S]*?<)/g,
    (match, args) => {
      // Don't replace if already has generic or if next char is <
      if (match.includes('<')) return match;
      return `document.querySelector<HTMLElement>(${args})`;
    }
  );
  
  if (content !== original) {
    fs.writeFileSync(file, content);
    const diff = content.split('querySelectorAll<HTMLElement>').length - original.split('querySelectorAll<HTMLElement>').length;
    const diff2 = content.split('querySelector<HTMLElement>').length - original.split('querySelector<HTMLElement>').length;
    if (diff + diff2 > 0) {
      console.log(`${file}: fixed ${diff + diff2} querySelector calls`);
      totalFixed += diff + diff2;
    }
  }
}

console.log(`Total querySelector fixes: ${totalFixed}`);
