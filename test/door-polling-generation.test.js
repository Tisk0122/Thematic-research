'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
const start = src.indexOf('function startDoorPolling(');
const stop = src.indexOf('function stopDoorPolling()');
const body = src.slice(start, stop);

test('ui.js: 外部から停止された古い開始サイクルの poll/SSE は再開・完了処理しない', () => {
  assert.match(src, /let _doorPollGeneration = 0;/);
  assert.match(body, /const _myGen = \+\+_doorPollGeneration;/);
  assert.match(body, /const _isStale = \(\) => _settled \|\| _myGen !== _doorPollGeneration;/);
  // poll再スケジュール・SSE再接続・状態処理は _settled 単独ではなく _isStale() で判定する
  assert.equal((body.match(/if \(_isStale\(\)\) return/g) || []).length, 4);
  assert.match(src.slice(stop, stop + 200), /_doorPollGeneration\+\+;/);
});
