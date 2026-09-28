import { readFileSync } from 'fs';
const content = readFileSync('content/quiz/15.json', 'utf8');
const lines = content.split('\n');
lines.forEach((line, i) => {
  // Find lines with 'kind' but missing 'why' key
  if (line.includes('"kind":') && !line.includes('"why":')) {
    console.log(`Line ${i+1}: ${line.trim()}`);
  }
});
