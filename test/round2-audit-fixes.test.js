'use strict';

// ============================================================
// 第2フェーズ徹底監査の修正に対する回帰テスト
// （lending.js の日付整形・ゴーストスイープ・入力検証と、
//  各ファイルのソースレベル不変条件の両方を検証する）
// ============================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function extractFunction(source, name, file) {
  const match = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(source);
  assert.ok(match, `${name} が ${file} に見つかりません`);
  const lines = source.slice(match.index).split('\n');
  const extracted = [];
  for (const line of lines) {
    extracted.push(line);
    if (line === '}') break;
  }
  return extracted.join('\n');
}

const LENDING = fs.readFileSync(path.join(__dirname, '..', 'local-db', 'lending.js'), 'utf8');

test('lending: 不正な日時文字列でも getLoans/getHistory/getBlacklist/getFailures が RangeError を投げない（_safeISO）', () => {
  const context = {};
  vm.runInNewContext([
    extractFunction(LENDING, '_safeISO', 'local-db/lending.js'),
    'globalThis.safeISO = _safeISO;'
  ].join('\n\n'), context);

  assert.equal(context.safeISO('not-a-date'), '');
  assert.equal(context.safeISO('abc-def-gh'), '');
  assert.equal(context.safeISO(null), '');
  assert.equal(context.safeISO(undefined), '');
  assert.equal(context.safeISO(''), '');
  assert.equal(context.safeISO(new Date('2026-01-02T03:04:05.000Z').toISOString()), '2026-01-02T03:04:05.000Z');
});

test('lending: 修正後ソースは DB 値を toISOString() へ直渡しせず _safeISO を経由している', () => {
  // getLoans / getHistory / getBlacklist / getFailures 系の読み出し整形は
  // すべて _safeISO() を使う（RangeError 対策の意図をソースで固定する）。
  const dangerousDirectPattern = /new Date\([^)]*\)\.toISOString\(\).*history|new Date\(r\.(checkout_time|return_time|created_at|reported_at|resolved_at|expiry)\)\.toISOString\(\)/;
  assert.ok(!dangerousDirectPattern.test(LENDING),
    'DBカラムの日時は new Date(...).toISOString() に直渡しせず _safeISO() を使うこと');
});

test('lending: _sweepStalePreparations は解錠済みゴーストを自動削除せず、不正日付と30分超は回収する', () => {
  const deleted = [];
  const warnMessages = [];
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const histIds = new Set(['is-history']);

  const rows = [
    { id: 'old-unprepared', checkout_time: iso(now - 31 * 60000), unlock_authorized: 0 }, // 30分超 → 回収
    { id: 'invalid-date', checkout_time: 'broken', unlock_authorized: 0 },               // 不正日付 → 回収
    { id: 'unlock-ghost', checkout_time: iso(now - 7 * 3600 * 1000), unlock_authorized: 1 }, // 7時間超でも解錠済み → 削除しない
    { id: 'is-history', checkout_time: iso(now - 999 * 60000), unlock_authorized: 0 },   // history に存在 → 対象外
  ];

  // STALE_MINUTES(30) より小さい差の行は何もしない（境界の行も準備）
  rows.push({ id: 'fresh-prepared', checkout_time: iso(now - 5 * 60000), unlock_authorized: 0 });

  const db = {
    prepare(sql) {
      if (sql.startsWith('DELETE FROM active_loans')) return { run: (id) => { deleted.push(id); } };
      if (sql.includes('SELECT id FROM history')) return { all: () => [{ id: 'is-history' }] };
      if (sql.includes('FROM active_loans')) return { all: () => rows };
      throw new Error('unexpected SQL: ' + sql);
    },
    transaction(fn) { return fn; }
  };

  const context = {
    db,
    STALE_MINUTES: 30,
    STALE_UNLOCK_GHOST_MS: 6 * 3600 * 1000,
    histIds: undefined, // 未使用（関数内で取得する）
    console: { warn: (m) => warnMessages.push(m) },
  };
  vm.runInNewContext([
    extractFunction(LENDING, '_sweepStalePreparations', 'local-db/lending.js'),
    'globalThis.sweep = _sweepStalePreparations;'
  ].join('\n\n'), context);

  context.sweep();

  assert.deepEqual(deleted.sort(), ['invalid-date', 'old-unprepared']);
  assert.ok(!deleted.includes('unlock-ghost'), '解錠済みゴーストはフェイルセーフのため削除しない');
  assert.ok(!deleted.includes('fresh-prepared'));
  // 7時間超の解錠済みゴーストは WARN で可視化される
  assert.ok(warnMessages.some(m => m.includes('unlock-ghost')), '解錠済みゴーストをWARNで通知すること');
  // WARN は「削除していない」ため1件のみ
  assert.equal(warnMessages.length, 1);
});

test('lending: updateUser は restrictedUntil に形式検証を掛ける', () => {
  let updated = false;
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT * FROM users')) return { get: (rowId) => ({ row_id: rowId, overdue_count: 1, penalty_count: 0, restricted_until: '' }) };
      if (sql.includes('UPDATE users SET')) return { run: () => { updated = true; } };
      throw new Error('unexpected SQL: ' + sql);
    }
  };
  const context = { db };
  vm.runInNewContext([
    extractFunction(LENDING, 'updateUser', 'local-db/lending.js'),
    'globalThis.updateUser = updateUser;'
  ].join('\n\n'), context);

  // 不正な日付文字列 → エラー、DB更新なし
  let r = context.updateUser({ rowId: '5', restrictedUntil: 'not-a-date' });
  assert.equal(r.success, false);
  assert.match(r.message, /貸出制限期限/);
  assert.equal(updated, false);

  // 長すぎる値 → エラー
  r = context.updateUser({ rowId: '5', restrictedUntil: 'x'.repeat(50) });
  assert.equal(r.success, false);
  assert.equal(updated, false);

  // 妥当な日付 → 更新
  r = context.updateUser({ rowId: '5', restrictedUntil: '2026-12-31' });
  assert.equal(r.success, true);
  assert.equal(updated, true);

  // PERMANENT（無期限）と空（制限解除）も許可
  updated = false;
  r = context.updateUser({ rowId: '5', restrictedUntil: 'PERMANENT' });
  assert.equal(r.success, true);
  updated = false;
  r = context.updateUser({ rowId: '5', restrictedUntil: '' });
  assert.equal(r.success, true);
});

test('lending: editHistoryEntry は status を許可値に限定する', () => {
  let updated = false;
  const row = {
    id: 'h1', name: '山田', email: 'y@example.com', device_id: 'CB-01', dob: '2010-01-01',
    checkout_time: '2026-09-01T01:00:00.000Z', return_time: '2026-09-01T02:00:00.000Z', status: '返却済'
  };
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT 1 FROM active_loans')) return { get: () => undefined };
      if (sql.includes('SELECT * FROM history')) return { get: () => row };
      if (sql.includes('UPDATE history SET')) return { run: () => { updated = true; } };
      throw new Error('unexpected SQL: ' + sql);
    }
  };
  const context = {
    db,
    normalizeEmail: (e) => String(e || '').trim().toLowerCase(),
    normalizeDob: (d) => String(d || '').trim(),
  };
  vm.runInNewContext([
    extractFunction(LENDING, 'editHistoryEntry', 'local-db/lending.js'),
    'globalThis.editHistoryEntry = editHistoryEntry;'
  ].join('\n\n'), context);

  // 許可されていない status → エラー、DB更新なし
  let r = context.editHistoryEntry({ id: 'h1', status: '副生徒会長' });
  assert.equal(r.success, false);
  assert.match(r.message, /状態は/);
  assert.equal(updated, false);

  // 許可済み status → 更新
  r = context.editHistoryEntry({ id: 'h1', status: '延滞返却' });
  assert.equal(r.success, true);
  assert.equal(updated, true);

  // 指定なし(statusは行の値のまま) → 更新
  updated = false;
  r = context.editHistoryEntry({ id: 'h1', name: '更新' });
  assert.equal(r.success, true);
  assert.equal(updated, true);
});

// ------------------------------------------------------------
// server.js のソース不変条件
// ------------------------------------------------------------
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server: /api/gas で本物の ADMIN_PASSWORD を GAS へ送らない（固定プロキシパスコード）', () => {
  // プロキシ用パスコード定数が定義され、注入は固定値のみになっていること
  assert.ok(/const GAS_PROXY_PASSCODE\s*=/.test(SERVER), 'GAS_PROXY_PASSCODE 定数が必要');
  // GET・POST の両方で passcode 注入に ADMIN_PASSWORD を使っていないこと
  const passcodeInjectionLines = SERVER.split('\n').filter(l =>
    l.includes("searchParams.set('passcode'") || l.includes('.passcode ='));
  assert.ok(passcodeInjectionLines.length >= 2, 'passcode 注入箇所が存在すること');
  for (const line of passcodeInjectionLines) {
    assert.ok(!line.includes('ADMIN_PASSWORD'), `passcode 注入に ADMIN_PASSWORD を使わない: ${line.trim()}`);
    assert.ok(line.includes('GAS_PROXY_PASSCODE'), `passcode 注入は GAS_PROXY_PASSCODE を使う: ${line.trim()}`);
  }
});

test('server: getSettings は未認証GETの許可一覧から外れ、getAvailabilityは残る', () => {
  const start = SERVER.indexOf('const GAS_SAFE_GET_ACTIONS = new Set([');
  assert.ok(start !== -1, 'GAS_SAFE_GET_ACTIONS 定義が必要');
  const end = SERVER.indexOf(']);', start);
  assert.ok(end !== -1, 'Set の閉じ括弧が必要');
  const block = SERVER.slice(start, end);
  assert.ok(!block.includes("'getSettings'"), 'getSettings を未認証許可から外す');
  assert.ok(block.includes("'getAvailableDevice'"));
});

test('server: 未認証GET getSettings 経由でも教員メール設定は除去される', () => {
  // POST 経由・将来の経路に備えた防御的サニタイズが存在すること
  assert.ok(SERVER.includes('delete result.settings.notifyEmailAddress'));
  assert.ok(SERVER.includes('delete result.settings.teacherReportAddress'));
  // 管理画面用の emailStatus 合成はセッション中のみ行う
  const idx = SERVER.indexOf("action === 'getSettings' && result && result.settings");
  assert.ok(idx !== -1, 'getSettings のローカル整形処理が存在');
  const snippet = SERVER.slice(idx, idx + 400);
  assert.ok(snippet.includes('!sessionOk'), '未認証時の分岐があること');
  assert.ok(snippet.includes('emailStatus'), 'セッション中は emailStatus を合成すること');
});

test('server: POST /api/gas はローカル未対応（GAS転送）アクションにセッションを要求する', () => {
  // syncFromLocal / sendUserActionEmail 等が未認証でGASへ転送されるのを防ぐガード
  assert.ok(SERVER.includes("!LOCAL_ACTIONS.has(action) && !sessionOk"),
    '非ローカルアクションはセッション必須のガードが必要');
});

test('server: moveBackupFile は isSettings を尊重し、部分コピーをサイズ照合で検出する', () => {
  const idx = SERVER.indexOf('const moveBackupFile');
  assert.ok(idx !== -1, 'moveBackupFile が存在');
  const snippet = SERVER.slice(idx, idx + 1200);
  assert.ok(snippet.includes('isSettings ? getSettingsBackupDir() : getBackupDir()'),
    '設定バックアップを設定用ディレクトリへ移すこと');
  assert.ok(snippet.includes('s.size !== file.size'),
    '送り先のファイルサイズ照合で部分コピーを検出すること');
});

test('server: 録画フォルダ移行も送り先サイズ照合で部分コピーを検出し直しコピーする', () => {
  const idx = SERVER.indexOf('const destFolder = path.join(REC_DIR');
  assert.ok(idx !== -1, '録画フォルダ移行処理が存在');
  const snippet = SERVER.slice(idx, idx + 900);
  assert.ok(snippet.includes('_dirSize(destFolder)'), '送り先ディレクトリのサイズ照合を行うこと');
  assert.ok(snippet.includes('不完全な録画コピーを検出'), '不完全コピーを検出して移行し直すこと');
});

test('server: DB復元は server.close 完了待ちにタイムアウト・フォールバックを持つ', () => {
  const idx = SERVER.indexOf("_restoreInProgress = true;");
  assert.ok(idx !== -1, '復元ハンドラが存在');
  const snippet = SERVER.slice(idx, idx + 4000);
  assert.ok(snippet.includes('restoreTimer'), '復元のタイムアウトタイマーが存在');
  assert.ok(snippet.includes('強制終了します'), 'close完了待ちを強制終了するフォールバックが存在');
  assert.ok(snippet.includes('finalizeRestore'), '二重実行防止の finalize があること');
});

test('server: POST /logs はレベルをホワイトリスト化し制御文字を除去する', () => {
  const idx = SERVER.indexOf("method === 'POST' && url.pathname === '/logs'");
  assert.ok(idx !== -1, '/logs POST エンドポイントが存在');
  const snippet = SERVER.slice(idx, idx + 900);
  assert.ok(snippet.includes('LEVEL_WHITELIST'), 'レベルホワイトリストが必要');
  assert.ok(snippet.includes('safeLevel'), '不正レベルをERRORへ丸めること');
  assert.ok(snippet.includes('stripCtl'), '制御文字を除去すること');
});

// ------------------------------------------------------------
// その他のファイルの不変条件
// ------------------------------------------------------------
const BACKUP = fs.readFileSync(path.join(__dirname, '..', 'local-db', 'backup.js'), 'utf8');
test('backup: runBackup は実行中ガード(_backupBusy)を持つ', () => {
  assert.ok(/let _backupBusy = false;/.test(BACKUP), '実行中フラグが必要');
  assert.ok(BACKUP.includes('if (_backupBusy)'), '既に実行中の場合はスキップすること');
  assert.ok(BACKUP.includes('finally'), 'finally でフラグを解放すること');
});

const SERIAL = fs.readFileSync(path.join(__dirname, '..', 'serial-bridge.js'), 'utf8');
test('serial-bridge: ReadlineParser に maxLength を設定する', () => {
  assert.ok(SERIAL.includes("maxLength: 4096"), 'ReadlineParser に maxLength が必要');
});

const ADMIN_JS = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');
test('admin.js: ログアウト・セッション失効・パスワード変更で admin_token も削除する', () => {
  const removeCount = (ADMIN_JS.match(/removeItem\('admin_token'\)/g) || []).length;
  assert.ok(removeCount >= 4,
    `admin_token をクリアする箇所が十分あること（handleSessionExpired/logout/idle/password/init）: ${removeCount}`);
  // SESSION_KEY 削除と同じ箇所で両方消している
  assert.ok(ADMIN_JS.includes("sessionStorage.removeItem(SESSION_KEY);\n    sessionStorage.removeItem('admin_token');"),
    'ログアウト系処理は両トークンをセットで削除すること');
});

test('admin.js: renderUsers の編集・削除ボタンの rowId は escHtml される', () => {
  assert.ok(ADMIN_JS.includes("openEditUserById('${escHtml(u.rowId)}')"), '編集ボタンのrowIdをescHtmlすること');
  assert.ok(ADMIN_JS.includes("deleteUserRecordById('${escHtml(u.rowId)}', this)"), '削除ボタンのrowIdをescHtmlすること');
});

const UI = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
test('ui.js: カスタムダイアログは Promise が未解決にならないよう直列化される', () => {
  assert.ok(UI.includes('function _enqueueDialog'), 'ダイアログ直列化ヘルパーが必要');
  assert.ok(UI.includes('function showCustomAlert') && UI.includes('return _enqueueDialog'),
    'showCustomAlert が直列化経由で表示すること');
  assert.ok(UI.includes('function showCustomConfirm') && UI.includes('return _enqueueDialog'),
    'showCustomConfirm が直列化経由で表示すること');
  // 以前の無名ハンドラ上書きパターンが残っていないこと
  assert.ok(!UI.includes('let _dialogAlertHandler'), '旧ハンドラ上書き方式を廃止すること');
  assert.ok(!UI.includes('let _dialogConfirmOkHandler'), '旧ハンドラ上書き方式を廃止すること');
});

const INSTALL = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install.sh'), 'utf8');
test('install.sh: sudo bash -c に埋め込む前にユーザー名とポートを検証する', () => {
  assert.ok(INSTALL.includes('validate_username()'), 'ユーザー名検証関数が必要');
  assert.ok(INSTALL.includes('validate_port()'), 'ポート検証関数が必要');
  assert.ok(INSTALL.includes('_CURRENT_USER="$(validate_username "${_CURRENT_USER}")"'),
    'run_arduino でユーザー名を検証すること');
  assert.ok(INSTALL.includes('_KIOSK_PORT="$(validate_port "${_KIOSK_PORT}")"'),
    'Chromiumポリシーのポートを検証すること');
});