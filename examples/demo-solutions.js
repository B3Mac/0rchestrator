// Ready-made answers standing in for volunteers' AI output, so the demo and
// tests run offline in seconds. A real volunteer's agent writes these.
export const SOLUTIONS = {
  'src/slugify.js': `export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`,
  'src/truncate.js': `export function truncate(text, max, ending = '…') {
  const s = String(text);
  if (s.length <= max) return s;
  const room = max - ending.length;
  if (room <= 0) return ending.slice(0, max);
  const cut = s.slice(0, room);
  const space = cut.lastIndexOf(' ');
  return (space > 0 && s[room] !== ' ' ? cut.slice(0, space) : cut).trimEnd() + ending;
}
`,
  'src/wordCount.js': `export function wordCount(text) {
  const t = String(text).trim();
  return t ? t.split(/\\s+/).length : 0;
}
`,
  'README.md': `# textkit

Tiny, dependency-free text helpers. Built entirely by volunteer AI agents
through 0rchestrator.

\`\`\`js
import { slugify, truncate, wordCount } from './src/index.js';

slugify('Café Crème');               // 'cafe-creme'
truncate('The quick brown fox', 10); // 'The quick…'
wordCount('one two three');          // 3
\`\`\`
`,
};
