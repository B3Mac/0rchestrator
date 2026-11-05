#!/usr/bin/env node
// STAND-IN for a real decomp toolchain, so this example runs anywhere.
//
// A real project compiles the C with the game's original compiler and compares
// the machine code to the original ROM (make compare, asm-differ, objdiff).
// This script instead compares the function's C to a fingerprint of the
// original, ignoring formatting and the names of locals and parameters, the
// way a compiler would. Like a real tool, it's picky: `x -= 1` and `x--`
// don't "match" here.
//
//   node tools/match.js Game_Clamp            exit 0 on a 100% match
//   node tools/match.js --syntax Game_Clamp   CI mode: is it C at all?

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = new Set(['void', 's8', 'u8', 's16', 'u16', 's32', 'u32', 'f32', 'return', 'if', 'else', 'for', 'while', 'do', 'break',
  'continue', 'static', 'const', 'unsigned', 'signed', 'int', 'char', 'short', 'long', 'struct', 'sizeof', 'switch', 'case', 'default']);

function findFunction(symbol) {
  for (const file of fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.c'))) {
    const text = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    if (new RegExp(`INCLUDE_ASM\\([^)]*\\b${symbol}\\)`).test(text)) return { file, stub: true };
    const m = new RegExp(`^[\\w\\s\\*]*\\b${symbol}\\s*\\([^;{]*\\)\\s*\\{`, 'm').exec(text);
    if (!m) continue;
    let depth = 0;
    for (let i = m.index; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return { file, code: text.slice(m.index, i + 1) };
    }
    return { file, code: text.slice(m.index), unbalanced: true };
  }
  return null;
}

export function tokens(code, symbol) {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  const raw = src.match(/[A-Za-z_]\w*|0x[\da-fA-F]+|\d+|\+\+|--|[-+*/%&|^]=|<<=?|>>=?|[<>=!]=|&&|\|\||->|\S/g) ?? [];
  const names = new Map();
  return raw.map((t, i) => {
    if (!/^[A-Za-z_]/.test(t) || KEEP.has(t) || t === symbol) return t;
    if (raw[i + 1] === '(' || /^(g|s)[A-Z]|^D_/.test(t) || raw[i - 1] === '.' || raw[i - 1] === '->') return t;
    if (!names.has(t)) names.set(t, `v${names.size}`);
    return names.get(t);
  });
}

function similarity(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return (2 * dp[a.length][b.length]) / (a.length + b.length || 1);
}

function main() {
  const args = process.argv.slice(2);
  const syntaxOnly = args[0] === '--syntax';
  const symbol = syntaxOnly ? args[1] : args[0];
  if (!symbol) {
    console.error('usage: node tools/match.js [--syntax] <function>');
    process.exit(2);
  }
  const found = findFunction(symbol);
  if (!found) {
    console.log(`${symbol}: not found in src/`);
    process.exit(1);
  }
  if (found.stub) {
    console.log(`${symbol}: still INCLUDE_ASM in src/${found.file}; nothing to compare yet`);
    process.exit(1);
  }
  if (found.unbalanced) {
    console.log(`${symbol}: doesn't compile (unbalanced braces)`);
    process.exit(1);
  }
  if (syntaxOnly) {
    console.log(`${symbol}: looks like C (CI can't check the match; that needs the original game)`);
    process.exit(0);
  }
  const want = fs.readFileSync(path.join(ROOT, 'tools', 'expected', `${symbol}.tok`), 'utf8').trim().split(' ');
  const got = tokens(found.code, symbol);
  if (want.join(' ') === got.join(' ')) {
    console.log(`${symbol}: 100% match`);
    process.exit(0);
  }
  let at = 0;
  while (at < want.length && want[at] === got[at]) at++;
  const pct = Math.floor(similarity(want, got) * 1000) / 10;
  console.log(`${symbol}: ${pct}% match`);
  console.log(`  first difference after: ${got.slice(Math.max(0, at - 6), at).join(' ') || '(start)'}`);
  console.log(`  original continues:     ${want.slice(at, at + 6).join(' ') || '(end of function)'}`);
  console.log(`  yours continues:        ${got.slice(at, at + 6).join(' ') || '(end of function)'}`);
  process.exit(1);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
