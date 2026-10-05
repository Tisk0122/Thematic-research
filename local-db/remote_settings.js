'use strict';
// GAS(スプレッドシート)の「リモート設定依頼」を、教室PCで承認してから運用設定へ
// 反映するための中核ロジック。
//
// 安全の方針:
// - 外部からは「取りに行く」だけ(ポートを開けない)。届いた依頼はDBに「承認待ち」で
//   保管するだけで、運用設定には一切触れない。
// - 管理画面で管理者が項目ごとに承認した時だけ、サーバーが保管済みの値を使って
//   適用する(画面から送られた値は使わない)。
// - 例外として、教室PC側で「自動適用」に指定した項目(既定: メンテナンスモード・貸出休止とその終了日)
//   だけは、署名・許可リスト・値の検証を通った依頼であれば承認なしで即時適用する。
// - 運用設定は REMOTE_SCHEMA の許可リストから依頼できる。認証情報やGAS接続設定は対象外。
// - 依頼にはHMAC署名が付き、署名・期限・値の範囲を検証してから保管する。
//   GAS側(Code.gs)の同名ロジックと canonicalMessage/正規化規則を一致させること。

const crypto = require('crypto');
const db = require('./db');

// 許可リスト。type: bool | int | date | enum | timeList | emailList | intList | patternList
const REMOTE_SCHEMA = {
  maintenanceMode:           { label: 'メンテナンスモード', group: '貸出の制御', type: 'bool' },
  lendingSuspended:          { label: '貸出の一時休止', group: '貸出の制御', type: 'bool' },
  lendingSuspendedUntil:     { label: '貸出休止の終了日', group: '貸出の制御', type: 'date' },
  returnDeadlineHour:        { label: '返却期限（時）', group: '返却期限', type: 'int', min: 0, max: 23, unit: '時' },
  returnDeadlineMinute:      { label: '返却期限（分）', group: '返却期限', type: 'int', min: 0, max: 59, unit: '分' },
  gracePeriodMinutes:        { label: '猶予時間', group: '返却期限', type: 'int', min: 0, max: 60, unit: '分' },
  blThreshold:               { label: '延滞制限のしきい値', group: '延滞・制限', type: 'int', min: 1, max: 10, unit: '回' },
  blDuration:                { label: '制限期間', group: '延滞・制限', type: 'int', min: 1, max: 12, unit: 'か月' },
  blReoffense:               { label: '再犯時の扱い', group: '延滞・制限', type: 'enum',
                               options: [{ value: 'double', label: '期間を2倍にする' }, { value: 'permanent', label: '無期限にする' }] },
  returnVerify:              { label: '返却時の本人確認', group: '貸出・返却', type: 'bool' },
  checkoutFields:            { label: '貸出時の入力項目', group: '貸出・返却', type: 'enum',
                               options: [{ value: 'all', label: '全項目' }, { value: 'name', label: '名前のみ' }, { value: 'email_dob', label: 'メールアドレスと生年月日' }] },
  emailPatterns:             { label: '生徒メールアドレス形式', group: '貸出・返却', type: 'patternList', maxItems: 20, autoApplyAllowed: false },
  logoutCameraCheckEnabled:  { label: '返却時のログアウト確認（カメラ自動）', group: '貸出・返却', type: 'bool' },
  deviceRestMinutes:         { label: '端末の充電待ち時間', group: '貸出・返却', type: 'int', min: 0, max: 240, unit: '分' },
  idleTimeoutEnabled:        { label: '無操作タイムアウト', group: '貸出・返却', type: 'bool' },
  recordingRetentionEnabled: { label: '録画の自動削除', group: '録画', type: 'bool' },
  recordingRetentionDays:    { label: '録画の保存日数', group: '録画', type: 'int', min: 1, max: 365, unit: '日' },
  notifyEmailEnabled:        { label: '即時アラートメール', group: '通知', type: 'bool' },
  notifyEmailAddress:        { label: '即時アラートの宛先', group: '通知', type: 'emailList', maxItems: 10, autoApplyAllowed: false },
  notifyOnOverdue:           { label: '延滞発生時に通知', group: '通知', type: 'bool' },
  notifyOnFailure:           { label: '故障報告時に通知', group: '通知', type: 'bool' },
  notifyOnBlacklist:         { label: 'ブラックリスト登録時に通知', group: '通知', type: 'bool' },
  teacherReportEnabled:      { label: '先生向け定期レポート', group: '通知', type: 'bool' },
  teacherReportAddress:      { label: '定期レポートの宛先', group: '通知', type: 'emailList', maxItems: 10, autoApplyAllowed: false },
  teacherReportTimes:        { label: '定期レポートの送信時刻', group: '通知', type: 'timeList', maxItems: 6 },
  notifyUserOnCheckout:      { label: '貸出完了メール（生徒宛）', group: '通知', type: 'bool' },
  notifyUserOnReturn:        { label: '返却完了メール（生徒宛）', group: '通知', type: 'bool' },
  boardEnabled:              { label: '貸出状況ボードの表示', group: 'ボード', type: 'bool' },
  boardSlideIntervalSec:     { label: 'ボードの表示時間', group: 'ボード', type: 'int', min: 3, max: 60, unit: '秒' },
  boardShowBlacklist:        { label: 'ボードに制限中の利用者を表示', group: 'ボード', type: 'bool' },
  doorUnlockDurations:       { label: '扉ごとの解錠時間', group: '端末・セキュリティ', type: 'intList', count: 12, min: 100, max: 15000, unit: 'ms', autoApplyAllowed: false },
  enableDebugLogs:           { label: 'デバッグログ', group: 'その他', type: 'bool' }
};

const MODES = ['approve', 'off'];
const DEFAULT_AUTO_KEYS = ['maintenanceMode', 'lendingSuspended', 'lendingSuspendedUntil'];
const MAX_KEYS_PER_REQUEST = 40;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const FINAL_STATUSES = ['applied', 'partial', 'rejected', 'expired', 'invalid', 'cancelled'];
const KEEP_FINAL_ROWS = 200;

// ---------------------------------------------------------------- 値の正規化
const TRUE_WORDS = new Set(['true', '1', 'on', 'yes', 'はい', 'オン', '有効', '☑', '✓']);
const FALSE_WORDS = new Set(['false', '0', 'off', 'no', 'いいえ', 'オフ', '無効', '☐']);

function _isValidRemoteDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// 依頼・画面・シートから来た値を、保存形式(wire値)へ正規化する。
// bool→true/false, int→整数, enum→文字列, timeList→"08:30,16:30" (昇順・重複なし)
function normalizeValue(def, raw) {
  if (!def) return { ok: false, error: '許可されていない項目です' };
  if (def.type === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const word = String(raw == null ? '' : raw).trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return { ok: true, value: true };
    if (FALSE_WORDS.has(word)) return { ok: true, value: false };
    return { ok: false, error: 'オン/オフ（TRUE/FALSE）で指定してください' };
  }
  if (def.type === 'int') {
    if (typeof raw === 'boolean' || raw === '' || raw == null) return { ok: false, error: '数値で指定してください' };
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: '整数で指定してください' };
    if (n < def.min || n > def.max) return { ok: false, error: `${def.min}〜${def.max}の範囲で指定してください` };
    return { ok: true, value: n };
  }
  if (def.type === 'date') {
    const value = String(raw == null ? '' : raw).trim();
    if (!value || value.toLowerCase() === 'unlimited') return { ok: true, value: 'unlimited' };
    if (!_isValidRemoteDateOnly(value)) return { ok: false, error: '実在する YYYY-MM-DD 形式の日付を指定してください' };
    return { ok: true, value };
  }
  if (def.type === 'enum') {
    const s = String(raw == null ? '' : raw).trim();
    const hit = def.options.find(o => o.value === s || o.label === s);
    if (!hit) return { ok: false, error: `次のいずれかで指定してください: ${def.options.map(o => o.value).join(' / ')}` };
    return { ok: true, value: hit.value };
  }
  if (def.type === 'timeList') {
    const parts = String(raw == null ? '' : raw).split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return { ok: false, error: '時刻を1つ以上指定してください（例: 08:30,16:30）' };
    if (parts.length > def.maxItems) return { ok: false, error: `時刻は${def.maxItems}個までです` };
    const out = [];
    for (const p of parts) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(p);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: `時刻の形式が不正です: ${p}（HH:MM）` };
      out.push(String(m[1]).padStart(2, '0') + ':' + m[2]);
    }
    return { ok: true, value: Array.from(new Set(out)).sort().join(',') };
  }
  if (def.type === 'emailList') {
    const value = String(raw == null ? '' : raw).trim();
    if (value.toUpperCase() === 'CLEAR') return { ok: true, value: '' };
    if (!value) return { ok: false, error: 'メールアドレスを入力するか、空にする場合は CLEAR と入力してください' };
    const emails = value.split(',').map(email => email.trim());
    const validEmail = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
    if (emails.length > def.maxItems || emails.some(email => !validEmail.test(email))) {
      return { ok: false, error: '有効なメールアドレスをカンマ区切りで指定してください（最大' + def.maxItems + '件）' };
    }
    return { ok: true, value: emails.join(',') };
  }
  if (def.type === 'intList') {
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,、\s]+/).filter(Boolean).map(Number) : null;
    if (!values || values.length !== def.count ||
        values.some(value => typeof value !== 'number' || !Number.isInteger(value) || value < def.min || value > def.max)) {
      return { ok: false, error: def.count + '個の整数（' + def.min + '〜' + def.max + def.unit + '）で指定してください' };
    }
    return { ok: true, value: values.slice() };
  }
  if (def.type === 'patternList') {
    let source = raw;
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch (_) { source = null; }
    }
    if (!Array.isArray(source) || source.length < 1 || source.length > def.maxItems) {
      return { ok: false, error: 'メール形式を1〜' + def.maxItems + '件で指定してください' };
    }
    const labels = new Set();
    const patterns = [];
    for (const pattern of source) {
      if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern) ||
          typeof pattern.label !== 'string' || !pattern.label.trim() || pattern.label.length > 40 ||
          typeof pattern.template !== 'string' || pattern.template.length > 254 ||
          (pattern.template.match(/\{\{input\}\}/g) || []).length !== 1 ||
          !Number.isInteger(Number(pattern.length)) || Number(pattern.length) < 1 || Number(pattern.length) > 10 ||
          !['digits', 'text'].includes(pattern.inputType) ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pattern.template.replace('{{input}}', '1234'))) {
        return { ok: false, error: '表示名・メール形式・桁数または入力種別が不正です' };
      }
      const label = pattern.label.trim();
      if (labels.has(label)) return { ok: false, error: 'メール形式の表示名は重複できません' };
      labels.add(label);
      patterns.push({
        label,
        template: pattern.template,
        length: Number(pattern.length),
        inputType: pattern.inputType
      });
    }
    return { ok: true, value: patterns };
  }
  return { ok: false, error: '未対応の型です' };
}

// wire値 → 運用設定に保存する値
function toSettingValue(def, wire) {
  if (def.type === 'timeList') return String(wire).split(',');
  if (def.type === 'date' && wire === 'unlimited') return '';
  return wire;
}

// 運用設定の現在値 → wire値(差分比較・表示用)
function fromSettingValue(def, stored) {
  if (def.type === 'timeList') return Array.isArray(stored) ? stored.join(',') : String(stored == null ? '' : stored);
  if (def.type === 'date' && !stored) return 'unlimited';
  return stored;
}

function _sameWireValue(a, b) {
  if ((a && typeof a === 'object') || (b && typeof b === 'object')) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

// ---------------------------------------------------------------- 署名
// GAS側 _rsCanonicalMessage と完全に同じ文字列を作ること。
function canonicalMessage(r) {
  const changes = r.changes || {};
  const lines = Object.keys(changes).sort().map(k => {
    const value = changes[k];
    const encoded = value && typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `${k}=${typeof value}:${encoded}`;
  });
  return ['rs1', r.id, r.createdAt, r.expiresAt, r.createdBy || '', ...lines].join('\n');
}

function sign(token, r) {
  return crypto.createHmac('sha256', String(token).trim()).update(canonicalMessage(r), 'utf8').digest('hex');
}

function verifySignature(token, r, signature) {
  if (!token || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(token, r), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------- 状態
function _ensureState() {
  db.prepare('INSERT OR IGNORE INTO remote_settings_state (id) VALUES (1)').run();
}

function getState() {
  _ensureState();
  const row = db.prepare('SELECT * FROM remote_settings_state WHERE id = 1').get();
  let locked = [];
  try { locked = JSON.parse(row.locked_keys_json); } catch (_) { locked = []; }
  let auto = DEFAULT_AUTO_KEYS;
  try { auto = JSON.parse(row.auto_keys_json); } catch (_) { auto = DEFAULT_AUTO_KEYS; }
  const lockedKeys = Array.isArray(locked) ? locked.filter(k => REMOTE_SCHEMA[k]) : [];
  // ローカル固定は自動適用より優先する
  const autoKeys = (Array.isArray(auto) ? auto : []).filter(k =>
    REMOTE_SCHEMA[k] && REMOTE_SCHEMA[k].autoApplyAllowed !== false && !lockedKeys.includes(k));
  if (autoKeys.includes('lendingSuspended') && !lockedKeys.includes('lendingSuspendedUntil') &&
      !autoKeys.includes('lendingSuspendedUntil')) {
    autoKeys.push('lendingSuspendedUntil');
  }
  return {
    mode: MODES.includes(row.mode) ? row.mode : 'approve',
    lockedKeys,
    autoKeys,
    lastPollAt: row.last_poll_at || null,
    lastOkAt: row.last_ok_at || null,
    lastError: row.last_error || null
  };
}

function setConfig({ mode, lockedKeys, autoKeys } = {}) {
  _ensureState();
  if (mode !== undefined) {
    if (!MODES.includes(mode)) throw new Error('モードが不正です');
    db.prepare('UPDATE remote_settings_state SET mode = ? WHERE id = 1').run(mode);
  }
  if (lockedKeys !== undefined) {
    if (!Array.isArray(lockedKeys) || lockedKeys.some(k => typeof k !== 'string' || !REMOTE_SCHEMA[k])) {
      throw new Error('ローカル固定の項目が不正です');
    }
    db.prepare('UPDATE remote_settings_state SET locked_keys_json = ? WHERE id = 1')
      .run(JSON.stringify(Array.from(new Set(lockedKeys))));
  }
  if (autoKeys !== undefined) {
    if (!Array.isArray(autoKeys) || autoKeys.some(k =>
      typeof k !== 'string' || !REMOTE_SCHEMA[k] || REMOTE_SCHEMA[k].autoApplyAllowed === false)) {
      throw new Error('自動適用の項目が不正です');
    }
    db.prepare('UPDATE remote_settings_state SET auto_keys_json = ? WHERE id = 1')
      .run(JSON.stringify(Array.from(new Set(autoKeys))));
  }
  return getState();
}

// GAS(依頼画面)へ知らせる現在のポリシー。
function getPolicy() {
  const st = getState();
  return { mode: st.mode, autoKeys: st.autoKeys, lockedKeys: st.lockedKeys };
}

function recordPoll(ok, message, now) {
  _ensureState();
  const ts = new Date(now || Date.now()).toISOString();
  if (ok) {
    db.prepare('UPDATE remote_settings_state SET last_poll_at = ?, last_ok_at = ?, last_error = NULL WHERE id = 1').run(ts, ts);
  } else {
    db.prepare('UPDATE remote_settings_state SET last_poll_at = ?, last_error = ? WHERE id = 1').run(ts, String(message || '').slice(0, 500));
  }
}

// ---------------------------------------------------------------- 依頼の取り込み
function _isoOrNull(s) {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function _insert(row) {
  db.prepare(`
    INSERT INTO remote_settings_requests
      (id, created_at, created_by, expires_at, note, changes_json, ignored_keys_json, received_at, status, decision_note, report_state, decided_at)
    VALUES (@id, @created_at, @created_by, @expires_at, @note, @changes_json, @ignored_keys_json, @received_at, @status, @decision_note, '', @decided_at)
  `).run(row);
}

// GASから届いた1件の依頼を検証して保管する(適用はしない)。
// 戻り値: { result: 'stored'|'duplicate'|'invalid'|'expired'|'rejected'|'skipped', id, reason? }
function ingestRequest(raw, { token, now = Date.now(), autoDeps } = {}) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.id || ''))) {
    return { result: 'skipped', reason: 'IDが不正です' };
  }
  const id = String(raw.id);
  if (db.prepare('SELECT 1 FROM remote_settings_requests WHERE id = ?').get(id)) {
    return { result: 'duplicate', id };
  }
  const nowIso = new Date(now).toISOString();
  const createdAt = _isoOrNull(raw.createdAt);
  const expiresAt = _isoOrNull(raw.expiresAt);
  const createdBy = typeof raw.createdBy === 'string' ? raw.createdBy.slice(0, 254) : '';
  const note = typeof raw.note === 'string' ? raw.note.slice(0, 500) : '';

  const base = {
    id, created_at: createdAt || nowIso, created_by: createdBy, expires_at: expiresAt || nowIso,
    note, changes_json: '{}', ignored_keys_json: '[]', received_at: nowIso,
    status: 'invalid', decision_note: '', decided_at: ''
  };
  const fail = (reason) => {
    _insert({ ...base, status: 'invalid', decision_note: reason, decided_at: nowIso });
    _pruneFinal();
    return { result: 'invalid', id, reason };
  };

  if (!createdAt || !expiresAt) return fail('日時の形式が不正です');

  let changes = raw.changes;
  if (typeof changes === 'string') { try { changes = JSON.parse(changes); } catch (_) { return fail('変更内容を解釈できません'); } }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return fail('変更内容がありません');
  const keys = Object.keys(changes);
  if (keys.length === 0) return fail('変更内容がありません');
  if (keys.length > MAX_KEYS_PER_REQUEST) return fail('変更項目が多すぎます');

  // 署名は GAS が登録した値そのもの(正規化前)に対して検証する。
  if (!verifySignature(token, { id, createdAt: raw.createdAt, expiresAt: raw.expiresAt, createdBy: raw.createdBy || '', changes }, raw.signature)) {
    return fail('署名が一致しません（改ざんまたはトークン不一致）');
  }

  const normalized = {};
  for (const k of keys) {
    const def = REMOTE_SCHEMA[k];
    if (!Object.prototype.hasOwnProperty.call(REMOTE_SCHEMA, k)) return fail(`許可されていない項目が含まれています: ${k}`);
    const n = normalizeValue(def, changes[k]);
    if (!n.ok) return fail(`${def.label}: ${n.error}`);
    normalized[k] = n.value;
  }

  if (normalized.lendingSuspended === true &&
      !Object.prototype.hasOwnProperty.call(normalized, 'lendingSuspendedUntil')) {
    return fail('貸出休止を有効にする場合は、終了日または「unlimited」を同時に指定してください');
  }

  const currentSettings = require('./lending').getSettings().settings || {};
  const proposedSettings = Object.assign({}, currentSettings, normalized);
  const suspensionTouched = normalized.lendingSuspended !== undefined ||
    normalized.lendingSuspendedUntil !== undefined;
  if (suspensionTouched && proposedSettings.lendingSuspended) {
    const until = proposedSettings.lendingSuspendedUntil;
    const today = (() => {
      const nowDate = new Date(now);
      return `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
    })();
    if (until !== 'unlimited' && (!_isValidRemoteDateOnly(until) || until < today)) {
      return fail('貸出休止期限は今日以降の日付、または無期限で指定してください');
    }
  }

  if (Date.parse(expiresAt) <= now) {
    _insert({ ...base, changes_json: JSON.stringify(normalized), status: 'expired', decision_note: '受信時点で期限切れ', decided_at: nowIso });
    return { result: 'expired', id };
  }

  const locked = new Set(getState().lockedKeys);
  const ignored = keys.filter(k => locked.has(k));
  const remaining = {};
  for (const k of keys) if (!locked.has(k)) remaining[k] = normalized[k];
  const effectiveSettings = Object.assign({}, currentSettings, remaining);
  const effectiveSuspensionTouched = remaining.lendingSuspended !== undefined ||
    remaining.lendingSuspendedUntil !== undefined;
  if (effectiveSuspensionTouched && effectiveSettings.lendingSuspended) {
    const until = effectiveSettings.lendingSuspendedUntil;
    const currentDate = new Date(now);
    const today = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
    if (until !== 'unlimited' && (!_isValidRemoteDateOnly(until) || until < today)) {
      return fail('貸出休止の終了日がローカル固定のため、有効な期限を適用できません');
    }
  }

  if (Object.keys(remaining).length === 0) {
    _insert({ ...base, changes_json: JSON.stringify({}), ignored_keys_json: JSON.stringify(ignored),
      status: 'rejected', decision_note: 'すべてローカル固定の項目のため自動で却下', decided_at: nowIso });
    return { result: 'rejected', id };
  }

  _insert({ ...base, changes_json: JSON.stringify(remaining), ignored_keys_json: JSON.stringify(ignored), status: 'pending' });
  const out = { result: 'stored', id, autoApplied: [], finished: false };
  if (autoDeps) {
    const autoSet = new Set(getState().autoKeys);
    const autoKeys = Object.keys(remaining).filter(k => autoSet.has(k));
    if (autoKeys.length > 0) Object.assign(out, _autoApply(id, autoKeys, autoDeps, now));
  }
  return out;
}

function _pruneFinal() {
  db.prepare(`
    DELETE FROM remote_settings_requests
    WHERE status != 'pending' AND report_state = status
      AND id NOT IN (SELECT id FROM remote_settings_requests WHERE status != 'pending' ORDER BY received_at DESC LIMIT ?)
  `).run(KEEP_FINAL_ROWS);
}

// ---------------------------------------------------------------- 参照
function _rowToRequest(row) {
  const parse = (s, fb) => { try { return JSON.parse(s); } catch (_) { return fb; } };
  return {
    id: row.id, createdAt: row.created_at, createdBy: row.created_by, expiresAt: row.expires_at,
    note: row.note, changes: parse(row.changes_json, {}), ignoredKeys: parse(row.ignored_keys_json, []),
    receivedAt: row.received_at, status: row.status, decidedAt: row.decided_at, decidedBy: row.decided_by,
    appliedKeys: parse(row.applied_keys_json, []), autoApplied: parse(row.auto_applied_json, []), decisionNote: row.decision_note, reportState: row.report_state
  };
}

function getRequest(id) {
  const row = db.prepare('SELECT * FROM remote_settings_requests WHERE id = ?').get(String(id || ''));
  return row ? _rowToRequest(row) : null;
}

function listPending() {
  return db.prepare("SELECT * FROM remote_settings_requests WHERE status = 'pending' ORDER BY created_at ASC").all().map(_rowToRequest);
}

function listHistory(limit = 30) {
  return db.prepare("SELECT * FROM remote_settings_requests WHERE status != 'pending' ORDER BY received_at DESC LIMIT ?")
    .all(limit).map(_rowToRequest);
}

function pendingCount() {
  return db.prepare("SELECT COUNT(*) c FROM remote_settings_requests WHERE status = 'pending'").get().c;
}

// 承認画面に出す差分。current/proposed はどちらも wire 値で返す。
function buildDiff(request, currentSettings) {
  const locked = new Set(getState().lockedKeys);
  return Object.keys(request.changes).map(key => {
    const def = REMOTE_SCHEMA[key];
    const current = fromSettingValue(def, currentSettings ? currentSettings[key] : undefined);
    const proposed = request.changes[key];
    return {
      key, label: def.label, group: def.group, type: def.type, unit: def.unit || '',
      options: def.options || null, current, proposed,
      changed: !_sameWireValue(current, proposed), locked: locked.has(key)
    };
  });
}

// ---------------------------------------------------------------- 自動適用
// 自動適用に指定された項目だけを、承認なしで即時適用する。取り込み時の検証(署名・許可リスト・
// 値の範囲・期限・ローカル固定の除外)を通った依頼にしか呼ばれない。
// 自動適用できなかった(失敗した)場合は何も変えず、承認待ちのまま残す。
// 戻り値: { autoApplied: [...キー], finished: 依頼のすべてを自動適用し終えたか }
function _autoApply(id, autoKeys, deps, now) {
  const req = getRequest(id);
  if (!req || req.status !== 'pending') return { autoApplied: [], finished: false };
  const partial = {};
  for (const k of autoKeys) {
    const def = REMOTE_SCHEMA[k];
    if (!def || def.autoApplyAllowed === false) return { autoApplied: [], finished: false };
    const n = normalizeValue(def, req.changes[k]);
    if (!n.ok) return { autoApplied: [], finished: false };
    partial[k] = toSettingValue(def, n.value);
  }
  try {
    deps.applySettings(partial, `リモート設定の自動適用（依頼者: ${req.createdBy || '不明'}）`);
  } catch (e) {
    return { autoApplied: [], finished: false, error: e.message };
  }
  const remaining = {};
  for (const k of Object.keys(req.changes)) if (!autoKeys.includes(k)) remaining[k] = req.changes[k];
  const nowIso = new Date(now).toISOString();
  const finished = Object.keys(remaining).length === 0;
  db.prepare(`
    UPDATE remote_settings_requests
    SET changes_json = ?, auto_applied_json = ?,
        status = ?, decided_at = ?, decided_by = ?, applied_keys_json = ?, decision_note = ?
    WHERE id = ? AND status = 'pending'
  `).run(
    JSON.stringify(finished ? req.changes : remaining), JSON.stringify(autoKeys),
    finished ? 'applied' : 'pending', finished ? nowIso : '', finished ? '自動適用（教室PC）' : '',
    JSON.stringify(finished ? autoKeys : []), finished ? '自動適用の対象項目のみの依頼' : '', id
  );
  return { autoApplied: autoKeys, finished };
}

// ---------------------------------------------------------------- 設定のバージョン
// 承認画面を開いた時点の設定と、承認する瞬間の設定が同じかを確かめるための識別子。
// 更新時刻だけだと同一ミリ秒の更新を見逃すので、設定内容のハッシュも含める。
function settingsVersion(cur) {
  const body = JSON.stringify((cur && cur.settings) || {});
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  return `${(cur && cur.updatedAt) || ''}|${hash}`;
}

// ---------------------------------------------------------------- 決定(承認/却下)
// acceptKeys: 適用する項目。空なら却下(ローカルのまま)。
// deps.getSettings(): { settings, updatedAt }  deps.applySettings(partial, updatedBy)
function decide(id, { acceptKeys = [], decidedBy = '', expectedVersion, note = '' } = {}, deps, now = Date.now()) {
  const req = getRequest(id);
  if (!req) return { ok: false, code: 'not_found', error: '依頼が見つかりません' };
  if (req.status !== 'pending') return { ok: false, code: 'not_pending', error: 'この依頼はすでに処理済みです' };
  const nowIso = new Date(now).toISOString();

  if (Date.parse(req.expiresAt) <= now) {
    _finish(id, 'expired', { decidedAt: nowIso, decidedBy: '', note: '承認前に期限切れ' });
    return { ok: false, code: 'expired', error: 'この依頼は期限切れです' };
  }
  if (!Array.isArray(acceptKeys) || acceptKeys.some(k => typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(req.changes, k))) {
    return { ok: false, code: 'bad_keys', error: '承認する項目が依頼の内容と一致しません' };
  }
  const accepted = Array.from(new Set(acceptKeys));
  const by = String(decidedBy || '教室PC管理者').slice(0, 100);

  // 自動適用済みの項目がある依頼は、残りを却下しても「一部のみ適用」として扱う。
  const auto = req.autoApplied || [];
  if (accepted.length === 0) {
    const st = auto.length > 0 ? 'partial' : 'rejected';
    _finish(id, st, { decidedAt: nowIso, decidedBy: by, appliedKeys: auto, note: String(note || '').slice(0, 300) });
    return { ok: true, status: st, appliedKeys: auto };
  }

  const current = deps.getSettings();
  // 画面を開いてから設定が書き換わっていたら、古い差分のまま承認させない。
  if (expectedVersion !== undefined && settingsVersion(current) !== expectedVersion) {
    return { ok: false, code: 'stale', error: '画面を開いたあとに運用設定が変更されました。差分を読み込み直して確認してください。' };
  }

  const partial = {};
  for (const k of accepted) {
    const def = REMOTE_SCHEMA[k];
    const n = normalizeValue(def, req.changes[k]);
    if (!n.ok) return { ok: false, code: 'invalid', error: `${def.label}: ${n.error}` };
    partial[k] = toSettingValue(def, n.value);
  }
  try {
    deps.applySettings(partial, `リモート設定の承認（依頼者: ${req.createdBy || '不明'} / 承認: ${by}）`);
  } catch (e) {
    return { ok: false, code: 'apply_failed', error: '設定の適用に失敗しました: ' + e.message };
  }
  const all = Object.keys(req.changes).length === accepted.length;
  const status = all ? 'applied' : 'partial';
  const appliedAll = auto.concat(accepted);
  _finish(id, status, { decidedAt: nowIso, decidedBy: by, appliedKeys: appliedAll, note: String(note || '').slice(0, 300) });
  return { ok: true, status, appliedKeys: appliedAll };
}

function _finish(id, status, { decidedAt, decidedBy, appliedKeys = [], note = '' }) {
  db.prepare(`
    UPDATE remote_settings_requests
    SET status = ?, decided_at = ?, decided_by = ?, applied_keys_json = ?, decision_note = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, decidedAt, decidedBy, JSON.stringify(appliedKeys), note, id);
}

function expireOld(now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const rows = db.prepare("SELECT id, expires_at FROM remote_settings_requests WHERE status = 'pending'").all();
  let n = 0;
  for (const r of rows) {
    if (Date.parse(r.expires_at) <= now) {
      _finish(r.id, 'expired', { decidedAt: nowIso, decidedBy: '', note: '承認されないまま期限切れ' });
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- GASへの報告
const REPORT_BATCH = 50;

// status → GASへ送る state。pending は「受信した」という確認(ack)として送る。
function _reportStateFor(status) { return status === 'pending' ? 'received' : status; }

function collectReports() {
  const rows = db.prepare(`
    SELECT * FROM remote_settings_requests
    WHERE report_state != status
    ORDER BY received_at ASC LIMIT ?
  `).all(REPORT_BATCH);
  return rows.map(r => {
    const req = _rowToRequest(r);
    return {
      id: req.id, state: _reportStateFor(req.status), decidedAt: req.decidedAt,
      decidedBy: req.decidedBy, appliedKeys: req.appliedKeys, note: req.decisionNote,
      _status: req.status
    };
  });
}

function markReported(results) {
  const stmt = db.prepare('UPDATE remote_settings_requests SET report_state = ? WHERE id = ? AND status = ?');
  for (const r of results) stmt.run(r._status, r.id, r._status);
}

// GAS側で取り消された依頼。承認待ちなら取り消し済みにし、未受信のIDは記録だけ残して報告対象にする。
function applyCancels(ids, now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  let n = 0;
  for (const id of Array.isArray(ids) ? ids.slice(0, 100) : []) {
    if (!ID_RE.test(String(id))) continue;
    const row = db.prepare('SELECT status FROM remote_settings_requests WHERE id = ?').get(id);
    if (!row) {
      _insert({ id, created_at: nowIso, created_by: '', expires_at: nowIso, note: '', changes_json: '{}',
        ignored_keys_json: '[]', received_at: nowIso, status: 'cancelled', decision_note: '受信前に依頼者が取り消し', decided_at: nowIso });
      n++;
    } else if (row.status === 'pending') {
      _finish(id, 'cancelled', { decidedAt: nowIso, decidedBy: '', note: '依頼者が取り消し' });
      n++;
    }
  }
  return n;
}

module.exports = {
  REMOTE_SCHEMA, MODES, FINAL_STATUSES, DEFAULT_AUTO_KEYS,
  normalizeValue, toSettingValue, fromSettingValue, settingsVersion,
  canonicalMessage, sign, verifySignature,
  getState, getPolicy, setConfig, recordPoll,
  ingestRequest, getRequest, listPending, listHistory, pendingCount, buildDiff,
  decide, expireOld, collectReports, markReported, applyCancels
};
