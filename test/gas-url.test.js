'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseGasUrl } = require('../lib/gas-url');

test('空/未設定の GAS URL は共有の既定エンドポイントにフォールバックしない', () => {
  // 設定漏れの端末が特定のスプレッドシートへまとまって書き込む事故を防ぐため、
  // 既定URLは持たず、エラー扱いにする。
  for (const value of ['', '   ']) {
    const result = parseGasUrl(value);
    assert.equal(result.url, '');
    assert.match(result.error, /GAS_URL/);
  }
});

test('既定のGAS URLは設定例から読み込まれ、実行コードにハードコードされていないこと', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const example = fs.readFileSync(path.join(root, 'config.env.example'), 'utf8');
  const match = /^GAS_URL=(.+)$/m.exec(example);
  assert.ok(match, 'config.env.example に既定のGAS_URLが設定されていません');
  assert.equal(parseGasUrl(match[1]).error, '', '既定のGAS_URLが有効なウェブアプリURLではありません');

  const targets = ['lib/gas-url.js', 'scripts/install.sh'];
  for (const rel of targets) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(
      !/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec/.test(content),
      `${rel} に本番GAS URLが残っています`
    );
  }
});

test('a valid Apps Script web app URL is accepted', () => {
  const result = parseGasUrl('https://script.google.com/macros/s/deployment-id/exec');
  assert.equal(result.error, '');
  assert.equal(result.url, 'https://script.google.com/macros/s/deployment-id/exec');
});

test('invalid GAS URLs are reported without throwing', () => {
  for (const value of [
    'not a url',
    'http://script.google.com/macros/s/id/exec',
    'https://example.com/macros/s/id/exec',
    'https://script.google.com/'
  ]) {
    const result = parseGasUrl(value);
    assert.equal(result.url, '');
    assert.match(result.error, /GAS_URL/);
  }
});
