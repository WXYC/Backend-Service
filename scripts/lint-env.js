#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const filesToCheck = ['.env', '.env.example'];

let hasErrors = false;
let checkedAny = false;

filesToCheck.forEach((filename) => {
  const filePath = path.join(rootDir, filename);

  if (!fs.existsSync(filePath)) {
    return;
  }

  checkedAny = true;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations = [];

  lines.forEach((line, index) => {
    if (/\s$/.test(line)) {
      violations.push({
        line: index + 1,
        content: line,
      });
    }
  });

  if (violations.length > 0) {
    hasErrors = true;
    console.error(`Error: ${filename} contains trailing whitespace:\n`);
    violations.forEach(({ line, content }) => {
      const visualized = content.replace(/\s+$/, (match) => '·'.repeat(match.length));
      console.error(`  Line ${line}: ${visualized}`);
    });
    console.error('');
  } else {
    console.log(`${filename} OK`);
  }
});

if (!checkedAny) {
  console.log('No .env files found, skipping check');
  process.exit(0);
}

if (hasErrors) {
  console.error('Remove trailing whitespace from the above lines.');
  process.exit(1);
}

console.log('All env files passed trailing whitespace check');
process.exit(0);
