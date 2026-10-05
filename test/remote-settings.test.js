'use strict';
// リモート設定（GAS郵便受け → 教室PCで承認）のテスト。
// ローカルDB(SQLite)の取り込み・検証・承認、GAS(Code.gs)との署名互換性、
// 取得ジョブとAPIまでを通して確認する。

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

process.env.LOCAL_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-')), 'test.db');
const db = require('../local-db/db');
const LDB = require('../local-db/lending');
const RS = require('../local-db/remote_settings');
const { createRemoteSettingsJob } = require('../local-db/remote_settings_job');
const { createRemoteSettingsApi } = require('../local-db/remote_settings_api');

const TOKEN = 'a'.repeat(32);
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const NOW = Date.parse('2026-10-05T00:00:00.000Z');

// 既存テストは「承認待ち」の挙動を確認するため、自動適用は空にして始める。
function reset({ keepAuto = false } = {}) {
  db.exec('DELETE FROM remote_settings_requests; DELETE FROM remote_settings_state; DELETE FROM settings;');
  if (!keepAuto) RS.setConfig({ autoKeys: [] });
}

let seq = 0;
function makeRaw(changes, over = {}) {
  const r = {
    id: over.id || `RS-TEST-${++seq}-${crypto.randomBytes(3).toString('hex')}`,
    createdAt: over.createdAt || new Date(NOW - 60000).toISOString(),
    expiresAt: over.expiresAt || new Date(NOW + 3600000).toISOString(),
    createdBy: over.createdBy === undefined ? 'teacher@example.jp' : over.createdBy,
    note: over.note || '',
    changes
  };
  r.signature = over.signature || RS.sign(over.signToken || TOKEN, r);
  return r;
}

function deps() {
  const calls = [];
  return {
    calls,
    getSettings: () => LDB.getSettings(),
    applySettings: (partial, by) => {
      calls.push({ partial, by });
      const base = LDB.getSettings().settings;
      const res = LDB.updateSettings({ passcode: 'authenticated', data: JSON.stringify({ ...base, ...partial }), updatedBy: by });
      if (!res.success) throw new Error(res.message);
    }
  };
}

// ---------------------------------------------------------------- 値の正規化
test('正規化: bool/int/enum/timeList の受理と拒否', () => {
  const S = RS.REMOTE_SCHEMA;
  assert.deepEqual(RS.normalizeValue(S.maintenanceMode, 'TRUE'), { ok: true, value: true });
  assert.deepEqual(RS.normalizeValue(S.maintenanceMode, 'オフ'), { ok: true, value: false });
  assert.equal(RS.normalizeValue(S.maintenanceMode, 'maybe').ok, false);
  assert.deepEqual(RS.normalizeValue(S.returnDeadlineHour, '15'), { ok: true, value: 15 });
  assert.equal(RS.normalizeValue(S.returnDeadlineHour, 24).ok, false);
  assert.equal(RS.normalizeValue(S.returnDeadlineHour, 1.5).ok, false);
  assert.equal(RS.normalizeValue(S.returnDeadlineHour, '').ok, false);
  assert.equal(RS.normalizeValue(S.returnDeadlineHour, true).ok, false);
  assert.deepEqual(RS.normalizeValue(S.lendingSuspendedUntil, '2026-12-31'), { ok: true, value: '2026-12-31' });
  assert.deepEqual(RS.normalizeValue(S.lendingSuspendedUntil, 'unlimited'), { ok: true, value: 'unlimited' });
  assert.deepEqual(RS.normalizeValue(S.lendingSuspendedUntil, ''), { ok: true, value: 'unlimited' });
  assert.equal(RS.normalizeValue(S.lendingSuspendedUntil, '2026-02-30').ok, false);
  assert.deepEqual(RS.normalizeValue(S.blReoffense, '無期限にする'), { ok: true, value: 'permanent' });
  assert.equal(RS.normalizeValue(S.blReoffense, 'forever').ok, false);
  assert.deepEqual(RS.normalizeValue(S.teacherReportTimes, '16:30, 8:30 16:30'), { ok: true, value: '08:30,16:30' });
  assert.equal(RS.normalizeValue(S.teacherReportTimes, '25:00').ok, false);
  assert.equal(RS.normalizeValue(S.teacherReportTimes, '1,2,3').ok, false);
  assert.deepEqual(RS.normalizeValue(S.notifyEmailAddress, 'a@example.jp, b@example.jp'),
    { ok: true, value: 'a@example.jp,b@example.jp' });
  assert.deepEqual(RS.normalizeValue(S.notifyEmailAddress, 'CLEAR'), { ok: true, value: '' });
  assert.deepEqual(RS.normalizeValue(S.doorUnlockDurations, '1000, 1200, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000'),
    { ok: true, value: [1000, 1200, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000] });
  assert.equal(RS.normalizeValue(S.doorUnlockDurations, [99, ...Array(11).fill(1000)]).ok, false);
  assert.deepEqual(RS.normalizeValue(S.emailPatterns, JSON.stringify([
    { label: '1年生', template: '2026_6043_{{input}}@g.miyazaki-c.ed.jp', length: 4, inputType: 'digits' }
  ])), { ok: true, value: [
    { label: '1年生', template: '2026_6043_{{input}}@g.miyazaki-c.ed.jp', length: 4, inputType: 'digits' }
  ] });
  assert.equal(RS.normalizeValue(S.emailPatterns, 'not JSON').ok, false);
});

test('全運用設定を許可し、認証情報やGAS接続設定は対象外。機密・扉関連は承認必須', () => {
  for (const k of ['adminPassword', 'ADMIN_PW', 'GAS_URL', 'SYNC_TOKEN', 'assetConfig', 'captureDeviceId']) {
    assert.equal(Object.prototype.hasOwnProperty.call(RS.REMOTE_SCHEMA, k), false, k);
  }
  for (const k of ['notifyEmailAddress', 'teacherReportAddress', 'doorUnlockDurations', 'emailPatterns']) {
    assert.equal(Object.prototype.hasOwnProperty.call(RS.REMOTE_SCHEMA, k), true, k);
    assert.equal(RS.REMOTE_SCHEMA[k].autoApplyAllowed, false, k);
  }
  // 許可項目はすべて既定の運用設定に実在する
  for (const k of Object.keys(RS.REMOTE_SCHEMA)) {
    assert.ok(Object.prototype.hasOwnProperty.call(LDB.DEFAULT_SETTINGS, k), `${k} が DEFAULT_SETTINGS に無い`);
  }
});

// ---------------------------------------------------------------- 取り込み
test('取り込み: 正しい署名の依頼は承認待ちになり、設定は変わらない', () => {
  reset();
  const before = JSON.stringify(LDB.getSettings().settings);
  const raw = makeRaw({ maintenanceMode: true, returnDeadlineHour: 15 });
  assert.equal(RS.ingestRequest(raw, { token: TOKEN, now: NOW }).result, 'stored');
  assert.equal(RS.pendingCount(), 1);
  assert.equal(JSON.stringify(LDB.getSettings().settings), before);
  // 再受信は重複として無視
  assert.equal(RS.ingestRequest(raw, { token: TOKEN, now: NOW }).result, 'duplicate');
  assert.equal(RS.pendingCount(), 1);
});

test('取り込み: 署名不一致・改ざん・別トークンは破棄(invalid)される', () => {
  reset();
  const forged = makeRaw({ maintenanceMode: true }, { signToken: 'b'.repeat(32) });
  assert.equal(RS.ingestRequest(forged, { token: TOKEN, now: NOW }).result, 'invalid');

  const raw = makeRaw({ maintenanceMode: true });
  const tampered = { ...raw, changes: { maintenanceMode: true, lendingSuspended: true } };
  assert.equal(RS.ingestRequest(tampered, { token: TOKEN, now: NOW }).result, 'invalid');

  const noSig = { ...makeRaw({ maintenanceMode: true }), signature: undefined };
  assert.equal(RS.ingestRequest(noSig, { token: TOKEN, now: NOW }).result, 'invalid');
  assert.equal(RS.pendingCount(), 0);
});

test('取り込み: 許可リスト外の項目・範囲外の値は署名が正しくても拒否', () => {
  reset();
  assert.equal(RS.ingestRequest(makeRaw({ SYNC_TOKEN: 'x' }), { token: TOKEN, now: NOW }).result, 'invalid');
  assert.equal(RS.ingestRequest(makeRaw({ returnDeadlineHour: 99 }), { token: TOKEN, now: NOW }).result, 'invalid');
  assert.equal(RS.ingestRequest(makeRaw({ lendingSuspended: true }), { token: TOKEN, now: NOW }).result, 'invalid');
  assert.equal(RS.ingestRequest(makeRaw({ lendingSuspended: true, lendingSuspendedUntil: '2026-02-30' }), { token: TOKEN, now: NOW }).result, 'invalid');
  assert.equal(RS.ingestRequest(makeRaw({ ['__proto__']: 1 }), { token: TOKEN, now: NOW }).result, 'invalid');
  assert.equal(RS.pendingCount(), 0);
});

test('取り込み: 貸出休止の開始と終了日は有効な組み合わせでのみ受理し、同時に自動適用', () => {
  reset({ keepAuto: true });
  const raw = makeRaw({ lendingSuspended: true, lendingSuspendedUntil: '2026-12-31' });
  const result = RS.ingestRequest(raw, { token: TOKEN, now: NOW, autoDeps: deps() });
  assert.equal(result.result, 'stored');
  assert.deepEqual(result.autoApplied.sort(), ['lendingSuspended', 'lendingSuspendedUntil']);
  const savedSettings = LDB.getSettings().settings;
  assert.equal(savedSettings.lendingSuspended, true);
  assert.equal(savedSettings.lendingSuspendedUntil, '2026-12-31');
});

test('取り込み: 無期限の貸出休止は終了日なしとして保存・自動適用する', () => {
  reset({ keepAuto: true });
  const raw = makeRaw({ lendingSuspended: true, lendingSuspendedUntil: 'unlimited' });
  const result = RS.ingestRequest(raw, { token: TOKEN, now: NOW, autoDeps: deps() });
  assert.equal(result.result, 'stored');
  assert.deepEqual(result.autoApplied.sort(), ['lendingSuspended', 'lendingSuspendedUntil']);
  const saved = LDB.getSettings().settings;
  assert.equal(saved.lendingSuspended, true);
  assert.equal(saved.lendingSuspendedUntil, '');
});

test('承認: メール形式・通知先・扉の解錠時間を手動承認で反映する', () => {
  reset();
  const changes = {
    emailPatterns: [{ label: '1年生', template: 'school_{{input}}@example.jp', length: 4, inputType: 'digits' }],
    notifyEmailAddress: 'admin@example.jp',
    teacherReportAddress: 'report@example.jp',
    doorUnlockDurations: [1200, ...Array(11).fill(1000)]
  };
  const raw = makeRaw(changes);
  assert.equal(RS.ingestRequest(raw, { token: TOKEN, now: NOW }).result, 'stored');
  assert.equal(RS.pendingCount(), 1, '追加項目はすべて手動承認待ち');
  const d = deps();
  assert.equal(RS.decide(raw.id, { acceptKeys: Object.keys(changes), decidedBy: 'tester' }, d, NOW).status, 'applied');
  const settings = LDB.getSettings().settings;
  assert.deepEqual(settings.emailPatterns, changes.emailPatterns);
  assert.equal(settings.notifyEmailAddress, changes.notifyEmailAddress);
  assert.equal(settings.teacherReportAddress, changes.teacherReportAddress);
  assert.deepEqual(settings.doorUnlockDurations, changes.doorUnlockDurations);
});

test('取り込み: 期限切れ・不正ID', () => {
  reset();
  const old = makeRaw({ maintenanceMode: true }, { expiresAt: new Date(NOW - 1000).toISOString() });
  assert.equal(RS.ingestRequest(old, { token: TOKEN, now: NOW }).result, 'expired');
  assert.equal(RS.pendingCount(), 0);
  assert.equal(RS.ingestRequest({ ...makeRaw({ maintenanceMode: true }), id: '../x' }, { token: TOKEN, now: NOW }).result, 'skipped');
});

test('ローカル固定の項目は依頼に含まれていても無視され、全部固定なら自動却下', () => {
  reset();
  RS.setConfig({ lockedKeys: ['returnDeadlineHour'] });
  const mixed = makeRaw({ maintenanceMode: true, returnDeadlineHour: 15 });
  assert.equal(RS.ingestRequest(mixed, { token: TOKEN, now: NOW }).result, 'stored');
  const req = RS.getRequest(mixed.id);
  assert.deepEqual(Object.keys(req.changes), ['maintenanceMode']);
  assert.deepEqual(req.ignoredKeys, ['returnDeadlineHour']);

  const onlyLocked = makeRaw({ returnDeadlineHour: 14 });
  assert.equal(RS.ingestRequest(onlyLocked, { token: TOKEN, now: NOW }).result, 'rejected');
  assert.equal(RS.getRequest(onlyLocked.id).status, 'rejected');
});

// ---------------------------------------------------------------- 差分
test('差分: 現在値と依頼値を項目ごとに比較し、変更なしも判別できる', () => {
  reset();
  const cur = LDB.getSettings().settings;
  const raw = makeRaw({ returnDeadlineHour: cur.returnDeadlineHour, gracePeriodMinutes: cur.gracePeriodMinutes + 5, teacherReportTimes: '09:00' });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  const rows = RS.buildDiff(RS.getRequest(raw.id), cur);
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.equal(byKey.returnDeadlineHour.changed, false);
  assert.equal(byKey.gracePeriodMinutes.changed, true);
  assert.equal(byKey.gracePeriodMinutes.proposed, cur.gracePeriodMinutes + 5);
  assert.equal(byKey.teacherReportTimes.current, '08:30,16:30');
  assert.equal(byKey.teacherReportTimes.proposed, '09:00');
});

// ---------------------------------------------------------------- 承認
test('承認: 選んだ項目だけが適用され、残りはローカルのまま(一部承認)', () => {
  reset();
  const raw = makeRaw({ maintenanceMode: true, gracePeriodMinutes: 10, teacherReportTimes: '09:00,17:00' });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  const d = deps();
  const r = RS.decide(raw.id, { acceptKeys: ['gracePeriodMinutes', 'teacherReportTimes'], decidedBy: 'tester' }, d, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'partial');
  const s = LDB.getSettings().settings;
  assert.equal(s.gracePeriodMinutes, 10);
  assert.deepEqual(s.teacherReportTimes, ['09:00', '17:00']);
  assert.equal(s.maintenanceMode, false, '承認していない項目は変わらない');
  assert.deepEqual(Object.keys(d.calls[0].partial).sort(), ['gracePeriodMinutes', 'teacherReportTimes']);
  const saved = RS.getRequest(raw.id);
  assert.equal(saved.status, 'partial');
  assert.deepEqual(saved.appliedKeys.sort(), ['gracePeriodMinutes', 'teacherReportTimes']);
  // 二重承認はできない
  assert.equal(RS.decide(raw.id, { acceptKeys: ['maintenanceMode'] }, d, NOW).code, 'not_pending');
  assert.equal(LDB.getSettings().settings.maintenanceMode, false);
});

test('承認: 全項目を選ぶと applied、空なら却下で設定は一切変わらない', () => {
  reset();
  const a = makeRaw({ lendingSuspended: true, lendingSuspendedUntil: '2026-12-31' });
  RS.ingestRequest(a, { token: TOKEN, now: NOW });
  assert.equal(RS.decide(a.id, { acceptKeys: ['lendingSuspended', 'lendingSuspendedUntil'] }, deps(), NOW).status, 'applied');
  assert.equal(LDB.getSettings().settings.lendingSuspended, true);

  const b = makeRaw({ lendingSuspended: false, maintenanceMode: true });
  RS.ingestRequest(b, { token: TOKEN, now: NOW });
  const d = deps();
  assert.equal(RS.decide(b.id, { acceptKeys: [] }, d, NOW).status, 'rejected');
  assert.equal(d.calls.length, 0);
  assert.equal(LDB.getSettings().settings.lendingSuspended, true);
  assert.equal(LDB.getSettings().settings.maintenanceMode, false);
});

test('承認: 依頼にない項目は受け付けない(画面から値を差し込めない)', () => {
  reset();
  const raw = makeRaw({ maintenanceMode: true });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  const d = deps();
  assert.equal(RS.decide(raw.id, { acceptKeys: ['maintenanceMode', 'returnDeadlineHour'] }, d, NOW).code, 'bad_keys');
  assert.equal(d.calls.length, 0);
  assert.equal(RS.getRequest(raw.id).status, 'pending');
});

test('承認: 画面を開いた後に設定が変わっていたら stale で拒否する', () => {
  reset();
  LDB.updateSettings({ passcode: 'x', data: JSON.stringify({ gracePeriodMinutes: 1 }), updatedBy: 't' });
  const shownAt = RS.settingsVersion(LDB.getSettings());
  const raw = makeRaw({ gracePeriodMinutes: 20 });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  // 別の管理操作で設定が書き換わる
  LDB.updateSettings({ passcode: 'x', data: JSON.stringify({ gracePeriodMinutes: 2 }), updatedBy: 't2' });
  const r = RS.decide(raw.id, { acceptKeys: ['gracePeriodMinutes'], expectedVersion: shownAt }, deps(), NOW);
  assert.equal(r.code, 'stale');
  assert.equal(RS.getRequest(raw.id).status, 'pending');
  const fresh = RS.settingsVersion(LDB.getSettings());
  assert.equal(RS.decide(raw.id, { acceptKeys: ['gracePeriodMinutes'], expectedVersion: fresh }, deps(), NOW).ok, true);
});

test('承認: 適用に失敗したら承認待ちのまま残る', () => {
  reset();
  const raw = makeRaw({ maintenanceMode: true });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  const r = RS.decide(raw.id, { acceptKeys: ['maintenanceMode'] }, { getSettings: () => LDB.getSettings(), applySettings() { throw new Error('boom'); } }, NOW);
  assert.equal(r.code, 'apply_failed');
  assert.equal(RS.getRequest(raw.id).status, 'pending');
});

test('期限切れの承認待ちは承認できず expired になる', () => {
  reset();
  const raw = makeRaw({ maintenanceMode: true }, { expiresAt: new Date(NOW + 1000).toISOString() });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  const r = RS.decide(raw.id, { acceptKeys: ['maintenanceMode'] }, deps(), NOW + 5000);
  assert.equal(r.code, 'expired');
  assert.equal(RS.getRequest(raw.id).status, 'expired');
  assert.equal(LDB.getSettings().settings.maintenanceMode, false);

  const raw2 = makeRaw({ maintenanceMode: true }, { expiresAt: new Date(NOW + 1000).toISOString() });
  RS.ingestRequest(raw2, { token: TOKEN, now: NOW });
  assert.equal(RS.expireOld(NOW + 5000), 1);
  assert.equal(RS.getRequest(raw2.id).status, 'expired');
});

// ---------------------------------------------------------------- 報告
test('報告: 受信確認→結果の順にGASへ報告され、報告済みは再送されない', () => {
  reset();
  const raw = makeRaw({ maintenanceMode: true });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  let reports = RS.collectReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].state, 'received');
  RS.markReported(reports);
  assert.equal(RS.collectReports().length, 0);

  RS.decide(raw.id, { acceptKeys: ['maintenanceMode'], decidedBy: 'tester' }, deps(), NOW);
  reports = RS.collectReports();
  assert.equal(reports[0].state, 'applied');
  assert.deepEqual(reports[0].appliedKeys, ['maintenanceMode']);
  RS.markReported(reports);
  assert.equal(RS.collectReports().length, 0);
});

test('取り消し: 承認待ちは cancelled になり、未受信IDも報告対象として残る', () => {
  reset();
  const raw = makeRaw({ maintenanceMode: true });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  RS.applyCancels([raw.id, 'RS-NEVER-SEEN-1'], NOW);
  assert.equal(RS.getRequest(raw.id).status, 'cancelled');
  assert.equal(RS.getRequest('RS-NEVER-SEEN-1').status, 'cancelled');
  assert.equal(RS.pendingCount(), 0);
  assert.ok(RS.collectReports().every(r => r.state === 'cancelled'));
});

// ---------------------------------------------------------------- ジョブ(スタブGAS)
function stubGas(handler) {
  return new Promise(resolve => {
    const state = { bodies: [] };
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => {
        const body = JSON.parse(data || '{}');
        state.bodies.push(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(handler(body)));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

test('ジョブ: GASから依頼を取得して承認待ちで保管し、結果を次回報告する(設定は変えない)', async () => {
  reset();
  const raw = makeRaw({ maintenanceMode: true, gracePeriodMinutes: 7 }, { expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString() });
  raw.signature = RS.sign(TOKEN, raw);
  const gas = await stubGas(() => ({ success: true, requests: [raw], cancelIds: [] }));
  let notified = 0;
  const job = createRemoteSettingsJob({ gasUrl: gas.url, token: TOKEN, logger: quiet, onNewPending: n => { notified += n; } });
  const before = JSON.stringify(LDB.getSettings().settings);

  const r1 = await job.runOnce({ force: true });
  assert.equal(r1.success, true);
  assert.equal(r1.received, 1);
  assert.equal(notified, 1);
  assert.equal(RS.pendingCount(), 1);
  assert.equal(JSON.stringify(LDB.getSettings().settings), before, '受信しただけでは設定は変わらない');
  assert.equal(gas.state.bodies[0].action, 'remoteSettingsSync');
  assert.equal(gas.state.bodies[0].token, TOKEN);

  // 2回目: 受信確認(received)が報告される。GASが同じ依頼を再送しても重複にならない。
  const r2 = await job.runOnce({ force: true });
  assert.equal(r2.received, 0);
  assert.deepEqual(gas.state.bodies[1].results.map(x => [x.id, x.state]), [[raw.id, 'received']]);
  assert.equal(RS.pendingCount(), 1);

  RS.decide(raw.id, { acceptKeys: ['gracePeriodMinutes'], decidedBy: 'tester' }, deps());
  await job.runOnce({ force: true });
  const last = gas.state.bodies[2].results[0];
  assert.equal(last.state, 'partial');
  assert.ok(!('_status' in last));
  gas.server.close();
});

test('ジョブ: 受信を無効(ローカルのみ)にするとGASへ接続しない', async () => {
  reset();
  RS.setConfig({ mode: 'off' });
  const gas = await stubGas(() => ({ success: true, requests: [] }));
  const job = createRemoteSettingsJob({ gasUrl: gas.url, token: TOKEN, logger: quiet });
  const r = await job.runOnce({ force: true });
  assert.equal(r.skipped, true);
  assert.equal(gas.state.bodies.length, 0);
  RS.setConfig({ mode: 'approve' });
  gas.server.close();
});

test('ジョブ: GASの失敗は記録され、貸出設定には影響しない', async () => {
  reset();
  const gas = await stubGas(() => ({ success: false, message: '同期トークンが一致しません' }));
  const job = createRemoteSettingsJob({ gasUrl: gas.url, token: TOKEN, logger: quiet });
  const r = await job.runOnce({ force: true });
  assert.equal(r.success, false);
  assert.match(RS.getState().lastError, /トークン/);
  gas.server.close();
});

test('ジョブ: GASが古い(未対応)場合は、更新とデプロイを促す文言で記録する', async () => {
  reset();
  const gas = await stubGas(() => ({ success: false, message: '不明なアクション: remoteSettingsSync' }));
  const job = createRemoteSettingsJob({ gasUrl: gas.url, token: TOKEN, logger: quiet });
  const r = await job.runOnce({ force: true });
  assert.equal(r.success, false);
  assert.match(RS.getState().lastError, /デプロイ/);
  gas.server.close();
});

// ---------------------------------------------------------------- API
test('API: 一覧(差分つき)→一部承認→履歴、設定の更新と監査ログ', async () => {
  reset();
  const audits = [];
  const api = createRemoteSettingsApi({
    getSettings: () => LDB.getSettings(),
    applySettings: (partial, by) => deps().applySettings(partial, by),
    audit: async (...a) => { audits.push(a); },
    logger: quiet, gasConfigured: true, intervalMs: 180000
  });
  const raw = makeRaw({ maintenanceMode: true, blThreshold: 5 }, { note: '放課後に変更お願いします' });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });

  const list = await api.handle('GET', '/api/remote-settings', '');
  assert.equal(list.status, 200);
  assert.equal(list.body.pending.length, 1);
  assert.equal(list.body.pending[0].note, '放課後に変更お願いします');
  const row = list.body.pending[0].rows.find(r => r.key === 'blThreshold');
  assert.equal(row.current, 3);
  assert.equal(row.proposed, 5);
  assert.equal((await api.handle('GET', '/api/remote-settings/summary', '')).body.pending, 1);

  const stale = await api.handle('POST', '/api/remote-settings/decision', JSON.stringify({ id: raw.id, acceptKeys: ['blThreshold'], expectedVersion: 'old' }));
  assert.equal(stale.status, 409);

  const ok = await api.handle('POST', '/api/remote-settings/decision', JSON.stringify({
    id: raw.id, acceptKeys: ['blThreshold'], expectedVersion: list.body.settingsVersion }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'partial');
  assert.equal(LDB.getSettings().settings.blThreshold, 5);
  assert.equal(LDB.getSettings().settings.maintenanceMode, false);
  assert.equal(audits.length, 1);
  assert.match(audits[0][1], /一部承認/);

  const again = await api.handle('POST', '/api/remote-settings/decision', JSON.stringify({ id: raw.id, acceptKeys: ['blThreshold'] }));
  assert.equal(again.status, 409);
  assert.equal((await api.handle('POST', '/api/remote-settings/decision', 'not json')).status, 400);

  const hist = await api.handle('GET', '/api/remote-settings', '');
  assert.equal(hist.body.pending.length, 0);
  assert.equal(hist.body.history[0].status, 'partial');

  const cfg = await api.handle('POST', '/api/remote-settings/config', JSON.stringify({ mode: 'off', lockedKeys: ['maintenanceMode'] }));
  assert.equal(cfg.body.mode, 'off');
  assert.deepEqual(cfg.body.lockedKeys, ['maintenanceMode']);
  assert.equal((await api.handle('POST', '/api/remote-settings/config', JSON.stringify({ lockedKeys: ['adminPassword'] }))).status, 400);
  assert.equal((await api.handle('POST', '/api/remote-settings/config', JSON.stringify({ mode: 'always' }))).status, 400);
  RS.setConfig({ mode: 'approve', lockedKeys: [] });
});

// ---------------------------------------------------------------- 自動適用
test('自動適用: 貸出休止の終了日も休止設定と一緒に自動適用される', () => {
  reset({ keepAuto: true });
  assert.deepEqual(RS.getState().autoKeys.sort(), ['lendingSuspended', 'lendingSuspendedUntil', 'maintenanceMode']);
});

test('自動適用: 対象項目だけの依頼は承認なしで即時適用され、履歴は applied(自動)になる', () => {
  reset({ keepAuto: true });
  const raw = makeRaw({ maintenanceMode: true });
  const d = deps();
  const r = RS.ingestRequest(raw, { token: TOKEN, now: NOW, autoDeps: d });
  assert.equal(r.result, 'stored');
  assert.deepEqual(r.autoApplied, ['maintenanceMode']);
  assert.equal(r.finished, true);
  assert.equal(LDB.getSettings().settings.maintenanceMode, true);
  assert.match(d.calls[0].by, /自動適用/);
  const saved = RS.getRequest(raw.id);
  assert.equal(saved.status, 'applied');
  assert.deepEqual(saved.autoApplied, ['maintenanceMode']);
  assert.match(saved.decidedBy, /自動適用/);
  assert.equal(RS.pendingCount(), 0);
  // GASへは確定結果として報告される
  assert.deepEqual(RS.collectReports().map(x => [x.id, x.state, x.appliedKeys]), [[raw.id, 'applied', ['maintenanceMode']]]);
  // オフへ戻す依頼も同様に自動で反映される
  const off = makeRaw({ maintenanceMode: false });
  RS.ingestRequest(off, { token: TOKEN, now: NOW, autoDeps: d });
  assert.equal(LDB.getSettings().settings.maintenanceMode, false);
});

test('自動適用: 混在した依頼は自動対象だけ即時適用し、残りは承認待ちのまま', () => {
  reset({ keepAuto: true });
  const raw = makeRaw({ maintenanceMode: true, gracePeriodMinutes: 15, blThreshold: 4 });
  const d = deps();
  const r = RS.ingestRequest(raw, { token: TOKEN, now: NOW, autoDeps: d });
  assert.equal(r.finished, false);
  assert.equal(LDB.getSettings().settings.maintenanceMode, true);
  assert.equal(LDB.getSettings().settings.gracePeriodMinutes, 0, '承認が必要な項目は変わらない');
  const pending = RS.getRequest(raw.id);
  assert.equal(pending.status, 'pending');
  assert.deepEqual(Object.keys(pending.changes).sort(), ['blThreshold', 'gracePeriodMinutes']);
  assert.deepEqual(pending.autoApplied, ['maintenanceMode']);

  // 残りの一部を承認 → partial。適用済みキーには自動分も含まれる
  const ok = RS.decide(raw.id, { acceptKeys: ['gracePeriodMinutes'], decidedBy: 'tester' }, d, NOW);
  assert.equal(ok.status, 'partial');
  assert.deepEqual(ok.appliedKeys.sort(), ['gracePeriodMinutes', 'maintenanceMode']);
  assert.equal(LDB.getSettings().settings.blThreshold, 3);
});

test('自動適用: 残りをすべて承認すれば applied、すべて却下しても自動分があれば partial', () => {
  reset({ keepAuto: true });
  const a = makeRaw({ lendingSuspended: true, lendingSuspendedUntil: '2026-12-31', gracePeriodMinutes: 5 });
  const d = deps();
  const r = RS.ingestRequest(a, { token: TOKEN, now: NOW, autoDeps: d });
  assert.deepEqual(r.autoApplied.sort(), ['lendingSuspended', 'lendingSuspendedUntil']);
  assert.equal(LDB.getSettings().settings.lendingSuspendedUntil, '2026-12-31');
  assert.equal(RS.decide(a.id, { acceptKeys: ['gracePeriodMinutes'] }, d, NOW).status, 'applied');

  const b = makeRaw({ lendingSuspended: false, blThreshold: 9 });
  RS.ingestRequest(b, { token: TOKEN, now: NOW, autoDeps: d });
  const rej = RS.decide(b.id, { acceptKeys: [] }, d, NOW);
  assert.equal(rej.status, 'partial');
  assert.deepEqual(rej.appliedKeys, ['lendingSuspended']);
  assert.equal(LDB.getSettings().settings.blThreshold, 3);
});

test('自動適用: autoDeps が無ければ（自動適用の対象でも）承認待ちになる', () => {
  reset({ keepAuto: true });
  const raw = makeRaw({ maintenanceMode: true });
  RS.ingestRequest(raw, { token: TOKEN, now: NOW });
  assert.equal(RS.getRequest(raw.id).status, 'pending');
  assert.equal(LDB.getSettings().settings.maintenanceMode, false);
});

test('自動適用: 署名不正・許可外・期限切れ・範囲外は自動適用されない', () => {
  reset({ keepAuto: true });
  const d = deps();
  RS.ingestRequest(makeRaw({ maintenanceMode: true }, { signToken: 'z'.repeat(32) }), { token: TOKEN, now: NOW, autoDeps: d });
  RS.ingestRequest(makeRaw({ maintenanceMode: true, notifyEmailAddress: 'x@y.z' }), { token: TOKEN, now: NOW, autoDeps: d });
  RS.ingestRequest(makeRaw({ maintenanceMode: true }, { expiresAt: new Date(NOW - 1000).toISOString() }), { token: TOKEN, now: NOW, autoDeps: d });
  RS.ingestRequest(makeRaw({ maintenanceMode: true, returnDeadlineHour: 99 }), { token: TOKEN, now: NOW, autoDeps: d });
  assert.equal(d.calls.length, 0);
  assert.equal(LDB.getSettings().settings.maintenanceMode, false);
});

test('自動適用: ローカル固定が優先され、自動対象でも適用されない', () => {
  reset({ keepAuto: true });
  RS.setConfig({ lockedKeys: ['maintenanceMode'] });
  assert.ok(!RS.getState().autoKeys.includes('maintenanceMode'));
  const d = deps();
  const raw = makeRaw({ maintenanceMode: true });
  assert.equal(RS.ingestRequest(raw, { token: TOKEN, now: NOW, autoDeps: d }).result, 'rejected');
  assert.equal(d.calls.length, 0);
  assert.equal(LDB.getSettings().settings.maintenanceMode, false);
  RS.setConfig({ lockedKeys: [] });
});

test('自動適用: 適用に失敗したら何も変えず承認待ちのまま残る', () => {
  reset({ keepAuto: true });
  const raw = makeRaw({ maintenanceMode: true, gracePeriodMinutes: 5 });
  const r = RS.ingestRequest(raw, { token: TOKEN, now: NOW, autoDeps: { getSettings: () => LDB.getSettings(), applySettings() { throw new Error('boom'); } } });
  assert.equal(r.finished, false);
  assert.deepEqual(r.autoApplied, []);
  const saved = RS.getRequest(raw.id);
  assert.equal(saved.status, 'pending');
  assert.deepEqual(Object.keys(saved.changes).sort(), ['gracePeriodMinutes', 'maintenanceMode']);
});

test('自動適用の設定: 項目の検証と、ローカル固定による除外', () => {
  reset({ keepAuto: true });
  assert.throws(() => RS.setConfig({ autoKeys: ['adminPassword'] }));
  RS.setConfig({ autoKeys: ['maintenanceMode', 'returnVerify'] });
  assert.deepEqual(RS.getState().autoKeys.sort(), ['maintenanceMode', 'returnVerify']);
  RS.setConfig({ lockedKeys: ['returnVerify'] });
  assert.deepEqual(RS.getState().autoKeys, ['maintenanceMode']);
  RS.setConfig({ lockedKeys: [] });
  assert.deepEqual(RS.getPolicy().autoKeys.sort(), ['maintenanceMode', 'returnVerify']);
});

test('ジョブ: 自動適用の対象は即時反映・監査ログ・事前バックアップ、ポリシーをGASへ送る', async () => {
  reset({ keepAuto: true });
  const raw = makeRaw({ maintenanceMode: true, blThreshold: 6 }, { expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString() });
  raw.signature = RS.sign(TOKEN, raw);
  const gas = await stubGas(() => ({ success: true, requests: [raw], cancelIds: [] }));
  const d = deps();
  const audits = [];
  let snapshots = 0;
  const job = createRemoteSettingsJob({
    gasUrl: gas.url, token: TOKEN, logger: quiet,
    deps: { applySettings: d.applySettings, snapshotBefore: async () => { snapshots++; }, audit: async (...a) => { audits.push(a); } }
  });
  const r = await job.runOnce({ force: true });
  assert.equal(r.success, true);
  assert.equal(LDB.getSettings().settings.maintenanceMode, true, '自動適用');
  assert.equal(LDB.getSettings().settings.blThreshold, 3, '承認が必要な項目は未適用');
  assert.equal(snapshots, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0][0], 'remote_settings_auto_apply');
  assert.equal(RS.pendingCount(), 1);
  assert.deepEqual(gas.state.bodies[0].policy.autoKeys.sort(), ['lendingSuspended', 'lendingSuspendedUntil', 'maintenanceMode']);
  assert.equal(gas.state.bodies[0].policy.mode, 'approve');
  gas.server.close();
});

// ---------------------------------------------------------------- GAS(Code.gs)との互換性
const GAS_SRC = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

function loadGas(extra = {}) {
  const store = new Map();
  const sheets = new Map();
  const sandbox = {
    console: quiet,
    Utilities: {
      computeHmacSha256Signature: (msg, key) => Array.from(crypto.createHmac('sha256', key).update(msg, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      formatDate: (d, tz, fmt) => (fmt === 'yyyyMMddHHmmss' ? d.toISOString().replace(/[-:T]/g, '').slice(0, 14) : fmt === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 16).replace('T', ' ')),
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, text) => Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      sleep: () => {}
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (store.has(k) ? store.get(k) : null),
      setProperty: (k, v) => store.set(k, String(v)),
      deleteProperty: k => store.delete(k) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Etc/GMT' },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }) },
    _currentSyncToken: () => TOKEN,
    _timingSafeStringEqual: (a, b) => String(a) === String(b),
    ...extra
  };
  vm.createContext(sandbox);
  // 副作用の無い定義だけを評価するため、必要な部分(リモート設定ブロック)を取り出す
  const start = GAS_SRC.indexOf('const SHEET_RS_INPUT');
  assert.ok(start > 0, 'リモート設定ブロックが Code.gs に見つかりません');
  vm.runInContext(GAS_SRC.slice(start).replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), sandbox);
  sandbox.__store = store;
  sandbox.__sheets = sheets;
  return sandbox;
}

test('GAS: RS_SCHEMA は教室PC側の REMOTE_SCHEMA と完全に一致する', () => {
  const gas = loadGas();
  assert.deepEqual(JSON.parse(JSON.stringify(gas.RS_SCHEMA)), JSON.parse(JSON.stringify(RS.REMOTE_SCHEMA)));
});

test('GAS: 署名は教室PC側で検証でき、改ざんすると検証に失敗する', () => {
  const gas = loadGas();
  const req = {
    id: 'RS-20261005-abc123', createdAt: '2026-10-05T01:02:03.000Z', expiresAt: '2026-10-12T01:02:03.000Z',
    createdBy: '先生@example.jp', changes: {
      maintenanceMode: true, returnDeadlineHour: 15, blReoffense: 'permanent',
      teacherReportTimes: '08:30,16:30', notifyEmailAddress: 'admin@example.jp',
      doorUnlockDurations: [1200, ...Array(11).fill(1000)],
      emailPatterns: [{ label: '1年生', template: 'school_{{input}}@example.jp', length: 4, inputType: 'digits' }]
    }
  };
  const sig = gas._rsSign(TOKEN, req);
  assert.equal(sig, RS.sign(TOKEN, req), 'GASとNodeで署名文字列が一致する');
  assert.equal(RS.verifySignature(TOKEN, req, sig), true);
  assert.equal(RS.verifySignature(TOKEN, { ...req, changes: { ...req.changes, returnDeadlineHour: 16 } }, sig), false);
  assert.equal(RS.verifySignature('x'.repeat(32), req, sig), false);
  assert.equal(RS.canonicalMessage(req), gas._rsCanonicalMessage(req));
});

test('GAS: 正規化規則は教室PC側と同じ結果になる', () => {
  const gas = loadGas();
  const samples = [
    ['maintenanceMode', ['TRUE', 'false', 'オン', true, 'x', '']],
    ['lendingSuspendedUntil', ['2026-12-31', '2026-02-30', '2026/12/31', '']],
    ['returnDeadlineHour', [15, '15', 24, -1, 1.5, '', 'abc', true]],
    ['blReoffense', ['double', '無期限にする', 'zzz']],
    ['teacherReportTimes', ['8:30,16:30', '16:30 08:30', '25:00', '', '1:1,2:2,3:3,4:4,5:5,6:6,7:7']],
    ['notifyEmailAddress', ['a@example.jp,b@example.jp', 'CLEAR', 'bad address']],
    ['doorUnlockDurations', [[1000, ...Array(11).fill(1000)], '1000,1200,1000,1000,1000,1000,1000,1000,1000,1000,1000,1000', [99, ...Array(11).fill(1000)]]],
    ['emailPatterns', [[{ label: '1年生', template: 'school_{{input}}@example.jp', length: 4, inputType: 'digits' }],
      JSON.stringify([{ label: '1年生', template: 'school_{{input}}@example.jp', length: 4, inputType: 'digits' }]), 'not JSON']]
  ];
  for (const [key, values] of samples) {
    for (const v of values) {
      const a = JSON.parse(JSON.stringify(gas._rsNormalize(gas.RS_SCHEMA[key], v)));
      const b = RS.normalizeValue(RS.REMOTE_SCHEMA[key], v);
      assert.equal(a.ok, b.ok, `${key}=${JSON.stringify(v)}`);
      if (a.ok) assert.deepEqual(a.value, b.value);
    }
  }
});

test('GAS: 入力シートから変更を取り出す(未入力は無視、同値はスキップ、誤りは報告)', () => {
  const gas = loadGas();
  const current = { maintenanceMode: false, returnDeadlineHour: 16, teacherReportTimes: ['08:30', '16:30'] };
  const rows = [
    ['maintenanceMode', '', '', '', 'TRUE', ''],
    ['returnDeadlineHour', '', '', '', 16, ''],
    ['gracePeriodMinutes', '', '', '', '', ''],
    ['blThreshold', '', '', '', 99, ''],
    ['teacherReportTimes', '', '', '', '16:30,08:30', ''],
    ['notifyEmailAddress', '', '', '', 'a@b.c', '']
  ];
  const r = JSON.parse(JSON.stringify(gas._rsCollectChanges(rows, current)));
  assert.deepEqual(r.changes, { maintenanceMode: true });
  assert.deepEqual(r.unchanged.sort(), ['定期レポートの送信時刻', '返却期限（時）'].sort());
  assert.equal(r.errors.length, 2);
});

test('GAS: 依頼の登録 → 取得 → 結果報告 → 教室PCへの取り込みまで一続きで動く', () => {
  reset();
  // 簡易スプレッドシート(依頼シートのみ)
  const grid = [];
  const sheet = {
    getLastRow: () => grid.length,
    appendRow: row => { grid.push(row.slice()); },
    getRange: (row, col, nRows = 1, nCols = 1) => ({
      getValues: () => { const out = []; for (let i = 0; i < nRows; i++) { const r = grid[row - 1 + i] || []; out.push(Array.from({ length: nCols }, (_, c) => (r[col - 1 + c] === undefined ? '' : r[col - 1 + c]))); } return out; },
      setValue: v => { grid[row - 1] = grid[row - 1] || []; grid[row - 1][col - 1] = v; },
      setNumberFormat() { return this; }, setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }
    }),
    setFrozenRows() {}, setColumnWidth() {}, hideColumns() {}, setTabColor() {}
  };
  grid.push(['header']);
  const gas = loadGas({
    getSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }),
    getRemoteSettings: () => ({ success: true, settings: { maintenanceMode: false, returnDeadlineHour: 16 } })
  });
  gas.__store.set('SYNC_TOKEN', TOKEN);

  const created = gas._rsCreateRequest({ maintenanceMode: true, returnDeadlineHour: 15 }, 'テスト', 'teacher@example.jp', TOKEN);
  assert.equal(created.success, true, created.message);

  // 教室PCが取りに来る
  const pulled = JSON.parse(JSON.stringify(gas.remoteSettingsSync({ results: [] })));
  assert.equal(pulled.success, true);
  assert.equal(pulled.requests.length, 1);
  assert.equal(RS.ingestRequest(pulled.requests[0], { token: TOKEN }).result, 'stored', 'GASが作った署名付き依頼が教室PCで受理される');

  // 受信確認 → 承認結果の報告がシートに反映される
  const id = pulled.requests[0].id;
  gas.remoteSettingsSync({ results: [{ id, state: 'received' }] });
  assert.equal(grid[1][11], 'received');
  assert.equal(JSON.parse(JSON.stringify(gas.remoteSettingsSync({ results: [] }))).requests.length, 0, '受信確認後は再送されない');
  gas.remoteSettingsSync({ results: [{ id, state: 'applied', decidedAt: new Date().toISOString(), decidedBy: '教室PC管理画面', appliedKeys: ['maintenanceMode'] }] });
  assert.equal(grid[1][11], 'applied');
  assert.match(grid[1][8], /メンテナンスモード/);
  // 確定後に古い received が来ても巻き戻らない
  gas.remoteSettingsSync({ results: [{ id, state: 'received' }] });
  assert.equal(grid[1][11], 'applied');
});

test('GAS: 未処理の依頼が上限に達したら新規依頼を拒否する', () => {
  const grid = [['header']];
  const sheet = {
    getLastRow: () => grid.length, appendRow: r => grid.push(r.slice()),
    getRange: (row, col, nRows = 1, nCols = 1) => ({
      getValues: () => { const out = []; for (let i = 0; i < nRows; i++) { const r = grid[row - 1 + i] || []; out.push(Array.from({ length: nCols }, (_, c) => (r[col - 1 + c] === undefined ? '' : r[col - 1 + c]))); } return out; },
      setValue() {}, setNumberFormat() { return this; }, setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }
    }),
    setFrozenRows() {}, setColumnWidth() {}, hideColumns() {}, setTabColor() {}
  };
  const gas = loadGas({
    getSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }),
    getRemoteSettings: () => ({ success: true, settings: {} })
  });
  for (let i = 0; i < 5; i++) assert.equal(gas._rsCreateRequest({ maintenanceMode: true }, '', 't', TOKEN).success, true);
  const sixth = gas._rsCreateRequest({ maintenanceMode: true }, '', 't', TOKEN);
  assert.equal(sixth.success, false);
  assert.match(sixth.message, /未処理/);
  assert.equal(gas._rsCreateRequest({ maintenanceMode: true }, '', 't', '').success, false, 'ペアリング前は依頼できない');
});

// ---------------------------------------------------------------- 配線(静的確認)
test('配線: 管理画面のタブ・スクリプト・サーバーのルートが認証付きで接続されている', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(root, 'js', 'admin.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(html, /id="view-remote"/);
  assert.match(html, /js\/admin-remote-settings\.js/);
  assert.match(adminJs, /remote: \(\) => loadRemoteSettingsView\(\)/);
  const routeAt = server.indexOf("url.pathname === '/api/remote-settings'");
  assert.ok(routeAt > 0, 'サーバーに /api/remote-settings のルートが無い');
  assert.match(server.slice(routeAt, routeAt + 300), /verifySession\(req\)/, 'ルートは管理者セッションを要求する');
  // 画面から送る本文に「適用する値」が含まれず、承認はサーバー保管値だけを使う
  const ui = fs.readFileSync(path.join(root, 'js', 'admin-remote-settings.js'), 'utf8');
  assert.match(ui, /JSON\.stringify\(\{ id, acceptKeys: accept, expectedVersion/);
});

// ---------------------------------------------------------------- 依頼画面(USB用HTML)向けの入口
function fakeSheet() {
  const grid = [['header']];
  const sheet = {
    getLastRow: () => grid.length, appendRow: r => grid.push(r.slice()),
    getRange: (row, col, nRows = 1, nCols = 1) => ({
      getValues: () => { const out = []; for (let i = 0; i < nRows; i++) { const r = grid[row - 1 + i] || []; out.push(Array.from({ length: nCols }, (_, c) => (r[col - 1 + c] === undefined ? '' : r[col - 1 + c]))); } return out; },
      setValue: v => { grid[row - 1] = grid[row - 1] || []; grid[row - 1][col - 1] = v; },
      setNumberFormat() { return this; }, setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }
    }),
    setFrozenRows() {}, setColumnWidth() {}, hideColumns() {}, setTabColor() {}
  };
  return { grid, sheet };
}

function operatorGas(settings = { maintenanceMode: false, returnDeadlineHour: 16, teacherReportTimes: ['08:30', '16:30'], notifyEmailAddress: 'secret@example.jp' }) {
  const { grid, sheet } = fakeSheet();
  const gas = loadGas({
    getSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }),
    getRemoteSettings: () => ({ success: true, settings, updatedAt: '2026-10-05T00:00:00.000Z' })
  });
  gas.__grid = grid;
  return gas;
}

const J = o => JSON.parse(JSON.stringify(o));

test('GAS操作キー: 発行→認証→失効。ハッシュだけが保存され、他のキー・形式不正は拒否', () => {
  const gas = operatorGas();
  const c = J(gas.issueRemoteOperatorKey('山田先生', true));
  assert.match(c.key, /^rsk_[0-9a-f]{64}$/);
  assert.equal(c.gasUrl, 'https://script.google.com/macros/s/FAKE/exec');
  const stored = gas.__store.get('RS_OPERATOR_KEYS');
  assert.ok(!stored.includes(c.key), 'キー本体は保存しない');
  assert.ok(stored.includes(crypto.createHash('sha256').update(c.key).digest('hex')));
  assert.equal(gas._rsVerifyOperator(c.key), '山田先生');
  assert.equal(gas._rsVerifyOperator('rsk_' + '0'.repeat(64)), null);
  assert.equal(gas._rsVerifyOperator('x'), null);
  assert.equal(gas._rsVerifyOperator(undefined), null);
  const c2 = J(gas.issueRemoteOperatorKey('佐藤先生', true));
  assert.equal(gas._rsVerifyOperator(c2.key), '佐藤先生');
  assert.equal(gas.revokeRemoteOperatorKey('山田先生'), 1);
  assert.equal(gas._rsVerifyOperator(c.key), null, '失効したキーは使えない');
  assert.equal(gas._rsVerifyOperator(c2.key), '佐藤先生');
  // 同じ名前で再発行すると古いキーは無効
  const c3 = J(gas.issueRemoteOperatorKey('佐藤先生', true));
  assert.equal(gas._rsVerifyOperator(c2.key), null);
  assert.equal(gas._rsVerifyOperator(c3.key), '佐藤先生');
});

test('GAS submit: キー認証、検証、署名付き依頼が教室PCで受理され、依頼者名が付く', () => {
  reset({ keepAuto: true });
  const gas = operatorGas();
  const { key } = J(gas.issueRemoteOperatorKey('山田先生', true));
  assert.equal(J(gas.remoteSettingsSubmit({ key: 'rsk_' + 'a'.repeat(64), changes: { maintenanceMode: true } })).code, 'auth');
  assert.equal(J(gas.remoteSettingsSubmit({ key, changes: {} })).success, false);
  assert.match(J(gas.remoteSettingsSubmit({ key, changes: { notifyEmailAddress: 'a@b.c' } })).message, /許可されていない/);
  assert.match(J(gas.remoteSettingsSubmit({ key, changes: { returnDeadlineHour: 99 } })).message, /範囲/);
  const indefinite = J(gas.remoteSettingsSubmit({ key, changes: { lendingSuspended: true } }));
  assert.equal(indefinite.success, true, indefinite.message);
  assert.equal(J(gas.remoteSettingsCancel({ key, id: indefinite.id })).cancelled, 1);
  assert.match(J(gas.remoteSettingsSubmit({ key, changes: { maintenanceMode: false } })).message, /変わる項目がありません/);
  assert.match(J(gas.remoteSettingsSubmit({ key, changes: JSON.parse('{"__proto__":1}') })).message, /許可されていない/);

  const ok = J(gas.remoteSettingsSubmit({ key, changes: { maintenanceMode: true, returnDeadlineHour: 16, teacherReportTimes: '09:00' }, note: '放課後\nお願い', operatorName: '山田\u0000太郎' }));
  assert.equal(ok.success, true, ok.message);
  // 現在値と同じ returnDeadlineHour は依頼から除かれる
  const pulled = J(gas.remoteSettingsSync({ results: [], policy: { mode: 'approve', autoKeys: ['maintenanceMode'], lockedKeys: [] } }));
  assert.equal(pulled.requests.length, 1);
  assert.deepEqual(Object.keys(pulled.requests[0].changes).sort(), ['maintenanceMode', 'teacherReportTimes']);
  assert.equal(pulled.requests[0].createdBy, '山田先生（山田 太郎）');
  assert.equal(pulled.requests[0].note, '放課後 お願い');
  const d = deps();
  const r = RS.ingestRequest(pulled.requests[0], { token: TOKEN, now: Date.now(), autoDeps: d });
  assert.equal(r.result, 'stored', 'GASが署名した依頼が教室PCで受理される');
  assert.deepEqual(r.autoApplied, ['maintenanceMode']);
  assert.equal(LDB.getSettings().settings.maintenanceMode, true);
  assert.equal(RS.getRequest(pulled.requests[0].id).status, 'pending', '承認が必要な時刻設定は承認待ち');
});

test('GAS status: 許可項目とポリシー・依頼状況を返し、通知先メールの値は伏せる', () => {
  const gas = operatorGas();
  const { key } = J(gas.issueRemoteOperatorKey('山田先生', true));
  assert.equal(J(gas.remoteSettingsStatus({ key: 'bad' })).code, 'auth');
  gas.remoteSettingsSync({ results: [], policy: { mode: 'approve', autoKeys: ['maintenanceMode', 'adminPassword'], lockedKeys: ['blThreshold'] } });
  gas.remoteSettingsSubmit({ key, changes: { lendingSuspended: true, lendingSuspendedUntil: '2026-12-31' } });
  const st = J(gas.remoteSettingsStatus({ key }));
  assert.equal(st.success, true);
  assert.equal(st.label, '山田先生');
  assert.deepEqual(Object.keys(st.current).sort(), Object.keys(RS.REMOTE_SCHEMA).sort());
  assert.equal(st.current.maintenanceMode, false);
  assert.equal(st.current.teacherReportTimes, '08:30,16:30');
  assert.equal(st.current.notifyEmailAddress, null);
  assert.equal(st.redacted.notifyEmailAddress, true);
  assert.ok(!JSON.stringify(st).includes('secret@example.jp'));
  assert.deepEqual(st.policy.autoKeys, ['maintenanceMode'], '未知のキーは除外');
  assert.deepEqual(st.policy.lockedKeys, ['blThreshold']);
  assert.equal(st.requests.length, 1);
  assert.equal(st.requests[0].state, 'sent');
  assert.equal(st.syncedAt, '2026-10-05T00:00:00.000Z');
});

test('GAS cancel: 未処理の依頼を取り消せる（個別・一括）', () => {
  const gas = operatorGas();
  const { key } = J(gas.issueRemoteOperatorKey('山田先生', true));
  const a = J(gas.remoteSettingsSubmit({ key, changes: { lendingSuspended: true, lendingSuspendedUntil: '2026-12-31' } }));
  const b = J(gas.remoteSettingsSubmit({ key, changes: { boardEnabled: false } }));
  assert.equal(J(gas.remoteSettingsCancel({ key: 'bad' })).code, 'auth');
  assert.equal(J(gas.remoteSettingsCancel({ key, id: a.id })).cancelled, 1);
  const pulled = J(gas.remoteSettingsSync({ results: [] }));
  assert.deepEqual(pulled.cancelIds, [a.id]);
  assert.deepEqual(pulled.requests.map(r => r.id), [b.id]);
  assert.equal(J(gas.remoteSettingsCancel({ key })).cancelled, 1);
});

test('GAS doPost: 操作キー用の3アクションは同期トークン不要、それ以外はトークン必須。text/plainのJSONを受け付ける', () => {
  const m = /^function doPost\(e\) \{[\s\S]*?\n\}\n/m.exec(GAS_SRC);
  assert.ok(m, 'doPost が見つかりません');
  const calls = [];
  const sandbox = {
    RS_OPERATOR_ACTIONS: ['remoteSettingsSubmit', 'remoteSettingsStatus', 'remoteSettingsCancel'],
    createJsonResponse: d => d,
    _authorizeRequest: (a, p) => (p.token === 'ok' ? null : { success: false, message: 'token' }),
    dispatch: (a, p) => { calls.push(a); return { success: true, a }; }
  };
  vm.createContext(sandbox);
  vm.runInContext(m[0], sandbox);
  const post = (type, body) => sandbox.doPost({ postData: { type, contents: JSON.stringify(body) }, parameter: {} });
  assert.equal(post('text/plain;charset=utf-8', { action: 'remoteSettingsStatus', key: 'k' }).success, true);
  assert.equal(post('application/json', { action: 'remoteSettingsSubmit', key: 'k' }).success, true);
  assert.equal(post('text/plain', { action: 'syncFromLocal' }).success, false, 'トークン無しの他アクションは拒否');
  assert.equal(post('text/plain', { action: 'updateSettings' }).success, false);
  assert.equal(post('application/json', { action: 'getLoans', token: 'ok' }).success, true);
  assert.deepEqual(calls, ['remoteSettingsStatus', 'remoteSettingsSubmit', 'getLoans']);
});

// ---------------------------------------------------------------- USB用の単体HTML(静的な安全確認)
test('USB用HTML: 外部読み込みなし・通信先はGASのみ・データをHTMLとして挿入しない・キーを保存しない', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'usb', 'remote-settings.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(csp, 'CSPが設定されていない');
  assert.match(csp[1], /default-src 'none'/);
  assert.match(csp[1], /connect-src https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com(;|$)/);
  assert.doesNotMatch(csp[1], /\*|http:/);
  // 外部のスクリプト・スタイル・画像・フォントを読み込まない
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|<img[^>]+src="http|@import|url\(http/i);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  // 受け取ったデータをHTMLとして解釈させる書き方をしない
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  // キーを端末に残さない
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  // URLを検証してからキーを送る
  assert.match(script, /GAS_RE\.test\(url\)/);
  assert.ok(script.includes('script\\.google\\.com\\/macros\\/s\\/'));
  // プリフライトを避けるため text/plain で送る
  assert.match(script, /text\/plain;charset=utf-8/);
  // 構文エラーがない
  assert.doesNotThrow(() => new Function(script));
});

test('USB用HTML: 許可リストの項目はGASが返すスキーマから描画する（HTMLに項目名を埋め込まない）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'usb', 'remote-settings.html'), 'utf8');
  for (const k of Object.keys(RS.REMOTE_SCHEMA)) {
    assert.ok(!html.includes(`'${k}'`) || ['maintenanceMode', 'lendingSuspended'].includes(k), `${k} がHTMLに直接書かれている`);
  }
});
