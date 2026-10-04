'use strict';

// ============================================================
// 隠しタップ順(トップ画面の端末タイルを指定順にタップして管理ログイン
// 画面へ進む操作)に対する回帰テスト。
//
// 検証する不変条件:
//   1. 順序・進行状態・成功判定がすべてサーバーにあり、配信される
//      クライアントの JS には1バイトも残らない
//   2. 失敗とロックが監査ログ(audit.jsonl)に残る
//   3. 連続失敗でロックし、ロック中は「成功」も拒否する
//   4. 通常運用(進行ゼロでのタップミス)で誤ってロックしない
// ============================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const UI = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');

// /api/admin-trigger のハンドラ本体を抜き出す(次のエンドポイント定義まで)
function adminTriggerBlock() {
  const start = SERVER.indexOf("url.pathname === '/api/admin-trigger'");
  assert.ok(start !== -1, '/api/admin-trigger の定義が必要');
  const end = SERVER.indexOf('if (method === ', start + 10);
  return SERVER.slice(start, end === -1 ? start + 3000 : end);
}

test('移設: 順序はサーバーにしか置かず、クライアントの配信JSには残さない', () => {
  assert.ok(SERVER.includes("const ADMIN_DEVICE_SEQUENCE = ['CB-04', 'CB-11', 'CB-02', 'CB-09']"),
    '順序は server.js に定義する');
  // 並びそのものが配信されるソースに書かれていないこと
  assert.ok(!UI.includes("['CB-04', 'CB-11'"), 'js/ui.js に順序の配列を書かない');
  assert.ok(!UI.includes('const ADMIN_DEVICE_SEQUENCE'),
    'js/ui.js に順序の定数を定義しない(コメント中の言及のみ許容)');
  // 進行状態もサーバー側
  assert.ok(!UI.includes('_deviceTapProgress'), '進行状態をクライアントに持たせない');
  assert.ok(!UI.includes('ADMIN_TAP_TIMEOUT_MS'), 'タイムアウト判定もサーバー側に置く');
  assert.ok(SERVER.includes('_adminTriggerState.progress'), '進行状態はサーバーが保持する');
});

test('server: /api/admin-trigger は認証不要だが、受け付けるのは端末IDのみ', () => {
  const block = adminTriggerBlock();
  // 生徒(未認証)が叩く必要があるためセッション必須にしない。
  // ここに verifySession が入ると機構そのものが使えなくなる。
  assert.ok(!block.includes('verifySession'), '生徒が叩くためセッション要求をしない');
  assert.ok(block.includes('ALL_DEVICES.includes(tap)'), '受け付けるのは既知の端末IDのみ');
  assert.ok(block.includes("JSON.parse(body)"), '本文はJSONとして検証する');
});

test('server: 失敗・ロック・到達の3種すべてが監査ログ(audit.jsonl)に残る', () => {
  const block = adminTriggerBlock();
  assert.ok(block.includes("writeAuditLog('admin_trigger_failed'"), '失敗の監査ログ記録が必要');
  assert.ok(block.includes("writeAuditLog('admin_trigger_locked'"), 'ロックの監査ログ記録が必要');
  assert.ok(block.includes("writeAuditLog('admin_trigger_matched'"), '到達(管理画面を開いたこと)の記録が必要');
  // 書込は共通ヘルパー経由(管理画面の POST /api/audit と形式を揃える)
  assert.ok(SERVER.includes('async function writeAuditLog'), 'writeAuditLog の定義が必要');
  const postStart = SERVER.indexOf("method === 'POST' && url.pathname === '/api/audit'");
  assert.ok(postStart !== -1, 'POST /api/audit が必要');
  assert.ok(SERVER.slice(postStart, postStart + 600).includes('writeAuditLog(action, detail, target)'),
    'POST /api/audit も writeAuditLog を使う');
});

test('server: 連続失敗が閾値に達するとロックし、成功でカウントをリセットする', () => {
  const block = adminTriggerBlock();
  assert.ok(SERVER.includes('const ADMIN_TRIGGER_MAX_FAILURES = 10'), '閾値は10回');
  assert.ok(block.includes('_adminTriggerState.failures >= ADMIN_TRIGGER_MAX_FAILURES'), '閾値判定が必要');
  assert.ok(block.includes('_adminTriggerState.lockedUntil = now + lockMs'), 'ロック時刻の更新が必要');
  assert.ok(block.includes('_adminTriggerState.failures = 0'), '到達で失敗カウントをリセットする');
});

test('server: ロック判定は成功処理より先に来る(総当たりで偶然当たるのも防ぐ)', () => {
  const block = adminTriggerBlock();
  const lockGuard = block.indexOf('_adminTriggerState.lockedUntil > now');
  const successPath = block.indexOf('_adminTriggerState.progress >= ADMIN_DEVICE_SEQUENCE.length');
  assert.ok(lockGuard !== -1, 'ロック判定が必要');
  assert.ok(successPath !== -1, '成功(順序が揃った)判定が必要');
  assert.ok(lockGuard < successPath, 'ロック中は進行があっても 429 で弾く');
});

test('server: ロック中は監査ログを書かない(連続POSTでのログ肥大化を防ぐ)', () => {
  const block = adminTriggerBlock();
  const lockGuard = block.indexOf('_adminTriggerState.lockedUntil > now');
  const failedLog = block.indexOf("writeAuditLog('admin_trigger_failed'");
  assert.ok(lockGuard !== -1 && failedLog !== -1);
  assert.ok(lockGuard < failedLog, 'ロック判定が先で、ロック中は1行も書き足さない');
});

test('server: 進行ゼロでのタップミスは失敗に数えない(通常運用で誤ロックしない)', () => {
  const block = adminTriggerBlock();
  assert.ok(block.includes('const hadProgress = _adminTriggerState.progress > 0'),
    '進行の有無で失敗かどうかを分ける');
  assert.ok(block.includes('if (!hadProgress)'), '進行ゼロなら失敗を数えない');
});

test('ui: 押したタイルを送るだけで、判定はサーバーの応答に従う', () => {
  assert.ok(UI.includes("JSON.stringify({ tap: deviceId })"), '端末IDを tap として送る');
  assert.ok(UI.includes("data.state === 'match'"), 'サーバーが match を返したときだけ管理画面を開く');
  assert.ok(UI.includes('showAdminPasswordDialog()'), 'ダイアログ呼び出しがある');
  // サーバー判定を経由せずにローカルで開く経路を残さない
  assert.ok(!UI.includes("reportAdminTrigger('match'"), '旧・自己判定方式を残さない');
  assert.ok(!UI.includes('handleTap'), 'クライアント側の進行ロジックを残さない');
});

test('ui: タップ報告は直列キューで送り、進行の順序が入れ替わらない', () => {
  assert.ok(UI.includes('let _adminTapQueue = Promise.resolve()'), '直列キューの状態が必要');
  assert.ok(UI.includes('_adminTapQueue.then(() => _sendAdminTap(deviceId))'),
    '前の送信が終わってから次を送る');
});

test('ui: サーバーがロックを返したら一定時間タップを無視する', () => {
  assert.ok(UI.includes('let _adminTriggerLockedUntil = 0'), 'ロック状態を保持する変数が必要');
  assert.ok(UI.includes('if (Date.now() < _adminTriggerLockedUntil) return;'),
    'ロック中はタイルタップを無視する');
  assert.ok(UI.includes('_adminTriggerLockedUntil = Date.now()'), '応答からロック時刻を更新する');
});
