// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const fs = require('node:fs');
const expected = JSON.parse(fs.readFileSync('fixtures/expected.json', 'utf8'));
const value = require('../src/value.cjs')();
if (expected.sha256) {
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex'), expected.sha256);
} else assert.deepEqual(value, expected.value);
console.log('spillway-acceptance-ok');
