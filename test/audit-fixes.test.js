'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'local-db', 'db.js'), 'utf8');

// Fix 1: allowDefaultPassword デッドコードの削除
test('server: verifySession は allowDefaultPassword 引数を持たない（デッドコード除去）', () => {
  const m = serverSrc.match(/function verifySession\s*\(([^)]*)\)/);
  assert.ok(m, 'verifySession が見つかりません');
  assert.ok(!m[1].includes('allowDefaultPassword'),
    'verifySession の引数に allowDefaultPassword が残っています（デッドコード）');
});

test('server: /api/change-admin-password と /api/security-status の verifySession 呼び出しに true が渡っていない', () => {
  const calls = [...serverSrc.matchAll(/verifySession\([^)]*true[^)]*\)/g)];
  assert.strictEqual(calls.length, 0,
    `verifySession に true を渡している呼び出しが ${calls.length} 件残っています: ${calls.map(c => c[0]).join(', ')}`);
});

// Fix 2: active_loans.device_id UNIQUE インデックスのマイグレーション
test('db.js: active_loans.device_id に UNIQUE インデックスを作成するマイグレーションがある', () => {
  assert.ok(
    dbSrc.includes('CREATE UNIQUE INDEX') && dbSrc.includes('active_loans') && dbSrc.includes('device_id'),
    'db.js に active_loans.device_id の UNIQUE インデックス作成コードが見当たりません'
  );
});

test('db.js: UNIQUE インデックス作成前に重複データの存在を確認する', () => {
  assert.ok(
    dbSrc.includes('GROUP BY device_id HAVING c > 1'),
    'db.js の UNIQUE インデックス作成前に重複チェックがありません'
  );
});

// Fix 3: _adminSessions の定期クリーンアップ
test('server: _adminSessions の期限切れエントリが定期的に削除される', () => {
  // setInterval のコールバック内で _adminSessions.delete が呼ばれているか確認
  const intervalBlocks = [...serverSrc.matchAll(/setInterval\s*\(\s*\(\)\s*=>\s*\{[\s\S]{0,2000}?\},\s*60000\)/g)];
  const hasSessionCleanup = intervalBlocks.some(block => 
    block[0].includes('_adminSessions') && block[0].includes('.delete(')
  );
  assert.ok(hasSessionCleanup, 'setInterval(60秒)内で _adminSessions の期限切れエントリを削除していません');
});
