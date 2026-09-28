'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const storage = require('../external-storage');

test('external-storage: detect() runs without throwing walk ReferenceError', async () => {
  // detect() calls _lsblkMountpoints() internally on Linux or returns candidate array.
  // Must complete without throwing ReferenceError: walk is not defined.
  const result = await storage.detect();
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.found, 'boolean');
});

test('gas: appsscript.json exists and specifies Asia/Tokyo timezone', () => {
  const appsscriptPath = path.join(__dirname, '../gas/appsscript.json');
  assert.ok(fs.existsSync(appsscriptPath), 'gas/appsscript.json must exist');
  const content = JSON.parse(fs.readFileSync(appsscriptPath, 'utf8'));
  assert.equal(content.timeZone, 'Asia/Tokyo');
});

test('server: backup stream attached error listener', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  // Confirm GET /backups/download attaches stream.on('error', ...)
  assert.ok(serverCode.includes("stream.on('error'"), 'server.js must attach error listener to backup stream');
});
