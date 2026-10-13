// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const greeting = require('../src/greeting.cjs');
for (const [input, expected] of [['Ada', 'Hello, Ada!'], [' Grace Hopper ', 'Hello, Grace Hopper!'], ['José', 'Hello, José!'], [' 李 ', 'Hello, 李!']]) assert.equal(greeting(input), expected);
for (const value of [undefined, null, 42, {}, '', ' \t\n']) assert.throws(() => greeting(value), TypeError);
console.log('pilot-greeting-ok');
