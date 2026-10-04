'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'local-db', 'email_queue.js'), 'utf8');
const schedule = source.match(/const RETRY_SCHEDULE_MS = \[([\s\S]*?)\];/);
const delayFunction = source.match(/function nextDelayMs\(attempts\) \{[\s\S]*?\n\}/);
assert.ok(schedule, 'RETRY_SCHEDULE_MS が見つかりません');
assert.ok(delayFunction, 'nextDelayMs が見つかりません');

const context = {};
vm.runInNewContext(
  `const RETRY_SCHEDULE_MS = [${schedule[1]}];\n${delayFunction[0]}\nglobalThis.nextDelayMs = nextDelayMs;`,
  context
);

test('初回失敗後からコメントどおりの再試行間隔になる', () => {
  assert.equal(context.nextDelayMs(1), 30 * 1000);
  assert.equal(context.nextDelayMs(2), 2 * 60 * 1000);
  assert.equal(context.nextDelayMs(99), 30 * 60 * 1000);
});
