import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.js';

test('leaves short text alone', () => {
  assert.equal(truncate('short', 10), 'short');
});
test('cuts long text and adds an ellipsis within the limit', () => {
  assert.equal(truncate('The quick brown fox', 10), 'The quick…');
});
test('prefers to cut at a word boundary', () => {
  assert.equal(truncate('Hello wonderful world', 16), 'Hello wonderful…');
});
test('accepts a custom ending', () => {
  assert.equal(truncate('abcdefghij', 6, '...'), 'abc...');
});
