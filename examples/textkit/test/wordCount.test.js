import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount } from '../src/wordCount.js';

test('counts words separated by any whitespace', () => {
  assert.equal(wordCount('one two\tthree\nfour'), 4);
});
test('ignores leading, trailing and repeated spaces', () => {
  assert.equal(wordCount('   lots   of   space   '), 3);
});
test('is zero for empty or blank text', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
});
test('counts hyphenated words and contractions as one word', () => {
  assert.equal(wordCount("well-known isn't hard"), 3);
});
