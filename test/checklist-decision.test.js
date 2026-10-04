'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

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
vm.runInNewContext(extractFunction(appSource, '_checklistDecision', 'js/app.js'), context);
const decision = context._checklistDecision;

test('チェックリスト: 3項目すべてにチェックで「扉を開ける」ボタンを出す', () => {
  const d = decision(true, true, true, false);
  assert.equal(d.showOk, true);
  assert.equal(d.showDamageContinue, false);
  assert.equal(d.hint, '');
});

test('チェックリスト: 未完了ならヒントだけを出し、扉ボタンは出さない', () => {
  const d = decision(false, false, false, false);
  assert.equal(d.showOk, false);
  assert.equal(d.showDamageContinue, false);
  assert.match(d.hint, /壊してしまった生徒はこちら/);
});

test('チェックリスト: 破損の報告を済ませた生徒はチェック状態に関係なく返却へ進める', () => {
  const d = decision(false, false, false, true);
  assert.equal(d.showOk, false);
  assert.equal(d.showDamageContinue, true);
  assert.equal(d.hint, '');
});

test('チェックリスト: 破損報告済みでも「扉を開ける」は出さない（報告フロー優先）', () => {
  const d = decision(true, true, true, true);
  assert.equal(d.showOk, false);
  assert.equal(d.showDamageContinue, true);
});