'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'js', 'admin.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('サーバーが返す認証エラー文言はすべて管理画面のセッション切れ判定に含まれる', () => {
  const m = admin.match(/async function apiFetch[\s\S]*?return res;/);
  assert.ok(m, 'apiFetch が見つかること');
  const messages = new Set();
  for (const x of server.matchAll(/json\(res, 40[13], \{ ok: false, error: '([^']*)'/g)) {
    if (/^認証/.test(x[1])) messages.add(x[1]);
  }
  assert.ok(messages.size >= 2, '認証系メッセージを検出できること');
  for (const msg of messages) {
    assert.ok(m[0].includes(`'${msg}'`), `セッション切れ判定に「${msg}」が含まれていない`);
  }
});
