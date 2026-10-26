'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseList, compactKey } = require('../src/top250');

test('top 250 list parses every ranked entry', () => {
  const entries = parseList();
  assert.strictEqual(entries.length, 250);
  assert.strictEqual(entries[0].rank, 1);
  assert.strictEqual(entries[0].title, 'The Shawshank Redemption');
  assert.strictEqual(entries[0].year, 1994);
  assert.strictEqual(entries[249].rank, 250);
});

test('compactKey tolerates apostrophes and leading "the"', () => {
  assert.strictEqual(
    compactKey("One Flew Over the Cuckoo's Nest"),
    compactKey('One Flew Over the Cuckoos Nest')
  );
  assert.strictEqual(compactKey('The Green Book'), compactKey('Green Book'));
  assert.notStrictEqual(compactKey('A Separation'), compactKey('Separation'));
  assert.strictEqual(compactKey("Rosemary's Baby"), compactKey('Rosemarys Baby'));
});
