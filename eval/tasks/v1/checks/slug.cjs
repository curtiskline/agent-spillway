// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const slug = require('../src/slug.cjs');
for (const [input, expected] of [['Hello World', 'hello-world'], [' --Release__2026!! ', 'release-2026'], ['a...b///c', 'a-b-c'], ['Already-slugged', 'already-slugged'], ['Café Déjà', 'caf-d-j'], ['123 456', '123-456'], ['!!!', ''], ['', '']]) assert.equal(slug(input), expected);
for (const value of [undefined, null, 42, {}, ['hello']]) assert.throws(() => slug(value), TypeError);
console.log('pilot-slug-ok');
