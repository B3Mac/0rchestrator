import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('lowercases and joins words with dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});
test('drops punctuation and collapses separators', () => {
  assert.equal(slugify('  Rock & Roll -- Forever!  '), 'rock-roll-forever');
});
test('strips accents', () => {
  assert.equal(slugify('Café Crème'), 'cafe-creme');
});
test('returns an empty string for nothing usable', () => {
  assert.equal(slugify('!!!'), '');
});
