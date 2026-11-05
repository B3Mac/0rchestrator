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

// decomp-mini: C that matches each function, plus a near miss (a `while`
// loop where the original used `for`) of the kind people hand off with a note.
export const DECOMP = {
  Game_AddScore: `void Game_AddScore(s32 points) {
    gScore += points * 10;
}`,
  Game_LoseLife: `s32 Game_LoseLife(void) {
    if (gLives > 0) {
        gLives--;
    }
    return gLives;
}`,
  Game_Clamp: `s32 Game_Clamp(s32 x, s32 lo, s32 hi) {
    if (x < lo) {
        return lo;
    }
    if (x > hi) {
        return hi;
    }
    return x;
}`,
  Game_SumArray: `s32 Game_SumArray(s32 *arr, s32 n) {
    s32 i;
    s32 total = 0;

    for (i = 0; i < n; i++) {
        total += arr[i];
    }
    return total;
}`,
  Game_SumArray_nearMiss: `s32 Game_SumArray(s32 *arr, s32 n) {
    s32 i = 0;
    s32 total = 0;

    while (i < n) {
        total += arr[i++];
    }
    return total;
}`,
};

/** Replace one INCLUDE_ASM stub in a C file's text with C. */
export function decompile(text, symbol, code) {
  const re = new RegExp(`^INCLUDE_ASM\\([^)]*\\b${symbol}\\);\\n`, 'm');
  if (!re.test(text)) throw new Error(`no stub for ${symbol}`);
  return text.replace(re, `${code}\n`);
}
