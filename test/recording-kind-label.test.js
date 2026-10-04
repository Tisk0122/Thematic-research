'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFunction(source, name, file) {
  const match = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(source);
  assert.ok(match, `${name} が ${file} に見つかりません`);
  const lines = source.slice(match.index).split('\n');
  const functionLines = [];
  for (const line of lines) {
    functionLines.push(line);
    if (line === '}') break;
  }
  return functionLines.join('\n');
}

const context = {};
vm.runInNewContext(extractFunction(serverSource, 'getRecordingTypeLabel', 'server.js'), context);
const label = context.getRecordingTypeLabel;

test('録画種別: 返却は kind=return で「返却」として保存される', () => {
  assert.equal(label({ kind: 'return', reason: 'return_success', action: 'return_confirm' }), '返却');
});

test('録画種別: 貸出は kind=checkout で「貸出」として保存される', () => {
  assert.equal(label({ kind: 'checkout', reason: 'checkout_success' }), '貸出');
});

test('録画種別: kind が無い古いメタは reason/action から後方互換で判定する', () => {
  assert.equal(label({ reason: 'checkout_success' }), '貸出');
  assert.equal(label({ action: 'return_confirm' }), '返却');
  assert.equal(label({ reason: 'return_success', action: 'return_confirm' }), '返却');
});

test('録画種別: 種別不明のメタは「記録」になる', () => {
  assert.equal(label({ reason: 'admin' }), '記録');
  assert.equal(label({}), '記録');
  assert.equal(label(undefined), '記録');
});