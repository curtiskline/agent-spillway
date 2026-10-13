// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const canEdit = require('../src/permission.cjs');
for (const owner of [true, false, undefined, 'true', 1]) assert.equal(canEdit('admin', owner), true);
assert.equal(canEdit('editor', true), true);
for (const owner of [false, undefined, null, 'true', 1, {}]) assert.equal(canEdit('editor', owner), false);
for (const role of ['viewer', 'unknown', 'Admin', ' admin ', '', undefined, null, true, 1, {}]) for (const owner of [true, false]) assert.equal(canEdit(role, owner), false);
console.log('pilot-permission-ok');
