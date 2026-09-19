import { readFileSync, writeFileSync } from 'fs';

const content = readFileSync('content/quiz/15.json', 'utf8');
const lines = content.split('\n');
const fixedLines = lines.map(line => {
  // Pattern: { "text": "...", "kind": "...", "some text without why key" }
  // Need to add "why": before the last quoted string
  const match = line.match(/^(\s*\{ "text": "[^"]+", "kind": "[^"]+", )("[^"]+"[^}]*\}.*)$/);
  if (match && !line.includes('"why":')) {
    return match[1] + '"why": ' + match[2];
  }
  return line;
});

writeFileSync('content/quiz/15.json', fixedLines.join('\n'));
console.log('Fixed JSON file');
