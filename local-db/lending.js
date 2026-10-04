'use strict';
// Code.gs のビジネスロジックをSQLiteに移植したもの。
//
// 重要: better-sqlite3 は同期APIで、Node.jsは基本シングルスレッドで
// リクエストを処理するため、db.transaction() で括った範囲は
// 他のリクエストの処理が割り込むことはない。GASの LockService.waitLock()
// が担っていた「同時書き込み事故の防止」は、これで代替できる
// （待ち時間なし・タイムアウトなしで、むしろ確実になる）。

const crypto = require('crypto');
const db = require('./db');
const { normalizeEmail, normalizeName, normalizeDob } = require('./normalize');
const emailQueue = require('./email_queue');

const ALL_DEVICES = require('../js/devices');

const DEFAULT_SETTINGS = {
  emailPatterns: [
    { label: '1年生', template: '2026_6043_{{input}}@g.miyazaki-c.ed.jp', length: 4, inputType: 'digits' },
    { label: '2年生', template: '6043_2025_{{input}}@g.miyazaki-c.ed.jp', length: 4, inputType: 'digits' },
    { label: '3年生', template: '6043_2024_{{input}}@g.miyazaki-c.ed.jp', length: 5, inputType: 'digits' }
  ],
  checkoutFields: 'all',
  returnVerify: true,
  idleTimeoutEnabled: true,
  blThreshold: 3,
  blDuration: 1,
  blReoffense: 'double',
  maintenanceMode: false,
  lendingSuspended: false,
  enableDebugLogs: false,
  returnDeadlineHour: 16,
  returnDeadlineMinute: 0,
  gracePeriodMinutes: 0,
  recordingRetentionDays: 30,
  // 録画の自動削除（日数超過分）を実行するかどうか。既定は有効(true)。
  // 管理画面の「運用設定」のトグルと連動し、無効時はサーバーの自動削除も停止する。
  recordingRetentionEnabled: true,
  // 自動選定(お任せ)時の端末選びに使う設定。
  // ・12台の使用回数をなるべく均等にするため、履歴上の累計貸出回数が
  //   少ない端末を優先する
  // ・返却直後の端末が充電不十分なまま再び貸し出されるのを防ぐため、
  //   返却からこの分数が経過していない端末は選定候補から除外する
  // 　(全端末が該当時間内で1台も選べない場合は、フェイルセーフ優先の
  // 　設計方針に従い、返却から最も時間が経っている＝最も充電が進んで
  // 　いる端末を例外的に選び、貸出自体は止めない)
  deviceRestMinutes: 30,
  // 返却時のログアウト確認をカメラで自動で行うかどうか。
  // カメラ自動確認はChromebookのログアウト画面を機械学習で判定するため、
  // ChromeOSの更新などで画面の見た目(デザイン)が変わると認識できなくなる。
  // そのような場合は管理者がこの設定をオフにし、「手動で確認しました」方式に切り替えられる。
  // 既定はオン(true)。
  logoutCameraCheckEnabled: true,
  // 扉ごとの電磁ロック解錠通電時間(ms)。Arduino の doorUnlockMs[] に反映される。
  // Arduinoスケッチの既定値と合わせ、全扉1000msを既定とする。
  // 有効範囲は100〜15000ms（updateSettingsでクランプ）。
  doorUnlockDurations: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  // 即時アラート・先生向け定期レポートは既定で無効。管理者が設定画面で
  // 明示的にONにするまでメールは一切送信されない。ONにした場合、宛先
  // (notifyEmailAddress)を未設定のままにしておくと、このGASプロジェクトの
  // オーナー(デプロイした先生のGoogleアカウント)へ自動的に届く
  // (Code.gs側の _resolveNotifyRecipients/_resolveTeacherReportRecipients を参照)。
  // 実際のメール送信・スケジュール判定はすべてGAS側で行われるため、
  // ここで有効にした設定が反映されるにはスプレッドシート同期(SYNC_TOKEN)
  // が有効である必要がある。
  notifyEmailEnabled: false,
  notifyEmailAddress: '',
  notifyOnOverdue: true,
  notifyOnFailure: true,
  notifyOnBlacklist: true,
  teacherReportEnabled: false,
  teacherReportAddress: '',
  teacherReportTimes: ['08:30', '16:30'],
  // 借りた本人・返した本人へ確認メールを送るかどうか(先生宛の即時アラートとは別系統)。
  // 送信先はその生徒自身が貸出時に入力/選択したメールアドレス。
  // メールアドレスが未入力の貸出（名前のみ）の場合は、送る宛先が無いため単にスキップされる。
  // こちらも既定は無効。
  notifyUserOnCheckout: false,
  notifyUserOnReturn: false,
  // --- サブモニター表示（拡張ディスプレイ管理者ボード） ---
  // HDMI等で2台目のディスプレイが接続された際に自動表示される、
  // 管理者向けの「今の貸出状況」スライドショー画面(board.html)の設定。
  // 生徒側の操作には一切影響しない、閲覧専用の別画面。
  boardEnabled: true,
  // 各スライドの表示時間(秒)。3〜60の範囲にクランプされる(updateSettings参照)。
  boardSlideIntervalSec: 8,
  // 貸出制限中(ブラックリスト)の利用者をボードに表示するかどうか。
  // 生徒の氏名が人目につく場所のディスプレイに表示されることになるため、
  // プライバシーに配慮して既定はオフ(件数のみ表示)。
  boardShowBlacklist: false
};

const PASSCODE_MAX_ATTEMPTS = 5;
const PASSCODE_LOCKOUT_SEC = 600;

// サーバー(server.js)側で管理者パスコードそのものを検証済みの場合に
// true を渡す運用を踏襲する(GAS版もサーバーから送られた時点で検証済み
// という前提で「passcodeがあればOK」としていた)。
function verifyPasscodeWithLockout(passcodeProvided) {
  const row = db.prepare('SELECT * FROM passcode_state WHERE id = 1').get();
  const now = Date.now();

  if (row && row.locked_until) {
    const lockedUntil = new Date(row.locked_until).getTime();
    const remainingSec = Math.ceil((lockedUntil - now) / 1000);
    if (remainingSec > 0) {
      const remainingMin = Math.ceil(remainingSec / 60);
      return { ok: false, message: `パスコードの試行回数上限に達しました。${remainingMin}分後に再試行してください。` };
    }
    db.prepare('UPDATE passcode_state SET fail_count = 0, locked_until = \'\' WHERE id = 1').run();
    // ロックアウト解除後も row（= ロック前の状態を保持したままの変数）を
    // そのまま使うと、直後の fail_count 加算が古い値(>=5)を起点にして
    // 再ロックアウトが発生するため、メモリ上の値もリセットする。
    row.fail_count = 0;
    row.locked_until = '';
  }

  if (passcodeProvided) {
    db.prepare(`
      INSERT INTO passcode_state (id, fail_count, locked_until) VALUES (1, 0, '')
      ON CONFLICT(id) DO UPDATE SET fail_count = 0
    `).run();
    return { ok: true };
  }

  const currentCount = row ? row.fail_count : 0;
  const newCount = currentCount + 1;

  if (newCount >= PASSCODE_MAX_ATTEMPTS) {
    const lockedUntilIso = new Date(now + PASSCODE_LOCKOUT_SEC * 1000).toISOString();
    db.prepare(`
      INSERT INTO passcode_state (id, fail_count, locked_until) VALUES (1, 0, ?)
      ON CONFLICT(id) DO UPDATE SET fail_count = 0, locked_until = excluded.locked_until
    `).run(lockedUntilIso);
    return { ok: false, message: `パスコードの試行回数上限に達しました。${Math.ceil(PASSCODE_LOCKOUT_SEC / 60)}分後に再試行してください。` };
  }

  db.prepare(`
    INSERT INTO passcode_state (id, fail_count, locked_until) VALUES (1, ?, '')
    ON CONFLICT(id) DO UPDATE SET fail_count = excluded.fail_count
  `).run(newCount);
  return { ok: false, message: 'パスコードが正しくありません' };
}

function getSettings() {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  if (!row) return { success: true, settings: DEFAULT_SETTINGS, updatedAt: null, updatedBy: '' };
  try {
    const stored = JSON.parse(row.data_json);
    const merged = Object.assign({}, DEFAULT_SETTINGS, stored);
    const legacyUnlockDefaults = [500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 1000];
    if (stored && Array.isArray(stored.doorUnlockDurations) &&
      stored.doorUnlockDurations.length === legacyUnlockDefaults.length &&
      stored.doorUnlockDurations.every((value, index) => Number(value) === legacyUnlockDefaults[index])) {
      merged.doorUnlockDurations = DEFAULT_SETTINGS.doorUnlockDurations.slice();
    }
    return { success: true, settings: merged, updatedAt: row.updated_at, updatedBy: row.updated_by || '' };
  } catch (e) {
    return { success: false, message: '保存済み設定の読み込みに失敗しました: ' + e.message };
  }
}

// GASにあった Apps Script のトリガー再設定(_syncOverdueEmailTrigger等)は
// ここでは行わない。通知メール送信自体はGAS側が同期後のスプレッドシートを
// 見て判断するので、ローカルは「設定を保存するだけ」でよい。
function _clampSettingInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function updateSettings({ passcode, data, updatedBy } = {}) {
  const check = verifyPasscodeWithLockout(passcode);
  if (!check.ok) return { success: false, message: check.message };
  if (!data) return { success: false, message: '設定データがありません' };

  let incoming;
  try {
    incoming = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (e) {
    return { success: false, message: '設定データの形式が不正です: ' + e.message };
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { success: false, message: '設定データはオブジェクトで指定してください' };
  }
  if (incoming.emailPatterns !== undefined) {
    if (!Array.isArray(incoming.emailPatterns)) {
      return { success: false, message: 'メールアドレス形式は配列で指定してください' };
    }
    const invalidPattern = incoming.emailPatterns.some(pattern =>
      !pattern || typeof pattern !== 'object' || Array.isArray(pattern)
      || typeof pattern.label !== 'string' || !pattern.label.trim()
      || typeof pattern.template !== 'string'
      || (pattern.template.match(/\{\{input\}\}/g) || []).length !== 1
      || !Number.isInteger(Number(pattern.length)) || Number(pattern.length) < 1 || Number(pattern.length) > 10
      || !['digits', 'text'].includes(pattern.inputType)
    );
    if (invalidPattern) {
      return { success: false, message: 'メールアドレス形式の項目が不正です' };
    }
  }
  for (const key of ['returnVerify', 'idleTimeoutEnabled', 'maintenanceMode', 'lendingSuspended',
    'recordingRetentionEnabled', 'logoutCameraCheckEnabled', 'notifyEmailEnabled',
    'teacherReportEnabled', 'notifyUserOnCheckout', 'notifyUserOnReturn', 'boardEnabled',
    'boardShowBlacklist']) {
    if (incoming[key] !== undefined && typeof incoming[key] !== 'boolean') {
      return { success: false, message: `設定項目 ${key} は true または false で指定してください` };
    }
  }

  const current = getSettings().settings || {};
  const merged = Object.assign({}, DEFAULT_SETTINGS, current, incoming);

  // 数値項目は、キーボード直接入力等でHTML側のmin/maxを回避されても
  // 業務ロジック（延滞判定・自動ブラックリスト登録）に不整合が生じないよう、
  // 保存前に必ず有効範囲へクランプする（updateUser()と同様の考え方）。
  merged.blThreshold = _clampSettingInt(merged.blThreshold, 1, 10, DEFAULT_SETTINGS.blThreshold);
  merged.blDuration = _clampSettingInt(merged.blDuration, 1, 12, DEFAULT_SETTINGS.blDuration);
  merged.returnDeadlineHour = _clampSettingInt(merged.returnDeadlineHour, 0, 23, DEFAULT_SETTINGS.returnDeadlineHour);
  merged.returnDeadlineMinute = _clampSettingInt(merged.returnDeadlineMinute, 0, 59, DEFAULT_SETTINGS.returnDeadlineMinute);
  merged.gracePeriodMinutes = _clampSettingInt(merged.gracePeriodMinutes, 0, 60, DEFAULT_SETTINGS.gracePeriodMinutes);
  merged.deviceRestMinutes = _clampSettingInt(merged.deviceRestMinutes, 0, 240, DEFAULT_SETTINGS.deviceRestMinutes);
  merged.boardSlideIntervalSec = _clampSettingInt(merged.boardSlideIntervalSec, 3, 60, DEFAULT_SETTINGS.boardSlideIntervalSec);
  // 録画の自動削除日数も同様に、管理画面の入力範囲(1〜365日)へクランプする。
  merged.recordingRetentionDays = _clampSettingInt(merged.recordingRetentionDays, 1, 365, DEFAULT_SETTINGS.recordingRetentionDays);

  // 扉別解錠時間は必ず12要素の配列（各100〜15000ms）に正規化する。
  // 不足・不正な値は既定1000msで補完し、12を超える分は切り捨てる。
  if (!Array.isArray(merged.doorUnlockDurations)) {
    merged.doorUnlockDurations = DEFAULT_SETTINGS.doorUnlockDurations.slice();
  } else {
    const arr = merged.doorUnlockDurations.slice(0, 12);
    while (arr.length < 12) arr.push(DEFAULT_SETTINGS.doorUnlockDurations[arr.length]);
    merged.doorUnlockDurations = arr.map((v, i) => _clampSettingInt(v, 100, 15000, DEFAULT_SETTINGS.doorUnlockDurations[i]));
  }

  const updatedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO settings (id, data_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(JSON.stringify(merged), updatedAt, updatedBy || '(不明)');

  return { success: true, message: '設定を保存しました', updatedAt, settings: merged };
}

function _modeBlockMessage(kind) {
  const settings = getSettings().settings || DEFAULT_SETTINGS;
  if (settings.maintenanceMode) {
    return 'ただいまシステムメンテナンス中のため、貸出・返却はご利用いただけません。';
  }
  if (settings.lendingSuspended) {
    return kind === 'return'
      ? '現在、端末の返却を休止しています。しばらくお待ちください。'
      : '現在、端末の貸出を休止しています。しばらくお待ちください。';
  }
  return null;
}

function getFailedDevices() {
  const rows = db.prepare(`SELECT device_id FROM failures WHERE status = '故障中'`).all();
  return new Set(rows.map(r => r.device_id));
}

// 空いている端末の中から、自動選定(お任せ)で貸し出す1台を選ぶ。
// 目的は2つ:
//  (1) 12台の使用回数をなるべく均等にする(番号の若い順に偏らせない)
//  (2) 返却直後で充電が不十分な可能性がある端末を、他に選べる端末が
//      あるうちは避ける
// 手動で端末番号を指定する貸出(checkout に deviceId を明示指定するケース)
// には一切影響しない。あくまで「お任せ」選定だけを対象とする。
function _pickBestDevice(freeDevices) {
  if (freeDevices.length === 0) return null;
  if (freeDevices.length === 1) return freeDevices[0];

  const settings = getSettings().settings || DEFAULT_SETTINGS;
  const restMinutes = Number.isFinite(settings.deviceRestMinutes)
    ? settings.deviceRestMinutes
    : DEFAULT_SETTINGS.deviceRestMinutes;
  const now = Date.now();

  // history は返却後も残る全履歴なので、ここから
  // ・端末ごとの累計貸出回数(usageCount)
  // ・端末ごとの最終返却時刻(lastReturnAt。まだ一度も返却されていなければ null)
  // をまとめて取得する。
  const placeholders = freeDevices.map(() => '?').join(',');
  const stats = db.prepare(`
    SELECT device_id AS deviceId,
           COUNT(*) AS usageCount,
           MAX(CASE WHEN return_time != '' THEN return_time END) AS lastReturnAt
    FROM history
    WHERE device_id IN (${placeholders})
    GROUP BY device_id
  `).all(...freeDevices);
  const statMap = new Map(stats.map(s => [s.deviceId, s]));

  const info = freeDevices.map(deviceId => {
    const s = statMap.get(deviceId);
    const usageCount = s ? s.usageCount : 0;
    const lastReturnAt = s && s.lastReturnAt ? new Date(s.lastReturnAt).getTime() : null;
    // 一度も返却履歴が無い(＝棚に入ったまま一度も使われていない等)端末は
    // 十分休んでいるとみなし、休憩時間を無限大として扱う。
    const restedMinutes = lastReturnAt === null ? Infinity : (now - lastReturnAt) / 60000;
    return { deviceId, usageCount, restedMinutes };
  });

  // 返却からdeviceRestMinutes以上経過している(＝充電が進んでいるはずの)端末
  const rested = info.filter(d => d.restedMinutes >= restMinutes);

  // フェイルセーフ優先: 該当する端末が1台もない(＝全端末が返却直後で埋まって
  // いる)場合でも貸出自体は止めず、その中で最も休んでいる端末を選ぶ。
  const pool = rested.length > 0 ? rested : info;

  // 使用回数が少ない端末を優先(均等化)。同数の場合は休んでいる時間が
  // 長い方(＝より充電が進んでいる方)を優先。
  pool.sort((a, b) => {
    if (a.usageCount !== b.usageCount) return a.usageCount - b.usageCount;
    return b.restedMinutes - a.restedMinutes;
  });

  return pool[0].deviceId;
}

function getAvailableDevice() {
  const used = new Set(db.prepare('SELECT device_id FROM active_loans').all().map(r => r.device_id));
  const failed = getFailedDevices();
  const free = ALL_DEVICES.filter(d => !used.has(d) && !failed.has(d));
  if (free.length === 0) return { success: false, message: '空き端末がありません' };
  return { success: true, deviceId: _pickBestDevice(free) };
}

// GASの _sweepStalePreparations 相当: checkoutPrepare だけされて
// checkoutCommit されないまま30分経過した仮予約を削除する。
const STALE_MINUTES = 30;

// 壊れた日時文字列が DB に入っていても RangeError でAPIが死なないようにする。
// lending.js 内の各所は new Date(x).toISOString() を直接呼んでいるため、
// x が不正値だと RangeError: Invalid time value が投げられてしまう。
// toISOString → この関数へ置き換えることで、不正値は '' に丸める。
function _safeISO(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toISOString(); } catch (_) { return ''; }
}

function _sweepStalePreparations() {
  const histIds = new Set(db.prepare('SELECT id FROM history').all().map(r => r.id));
  const now = Date.now();
  const rows = db.prepare('SELECT id, checkout_time, unlock_authorized FROM active_loans').all();
  const stale = [];
  const staleUnlockGhost = [];
  for (const r of rows) {
    if (histIds.has(r.id)) continue;
    // バグ修正: checkout_time が不正値だと new Date().getTime() が NaN になり、
    // return diffMin >= STALE_MINUTES が恒 false のため、仮予約が回収不能に
    // なっていた。不正日付は「記録として信用できない高齢仮予約」として回収対象に
    // する（unlock_authorized=0 は未解錠＝実物は棚に残っているため削除しても安全）。
    const ts = new Date(r.checkout_time).getTime();
    const invalidDate = Number.isNaN(ts);
    if (Number(r.unlock_authorized) === 1) {
      // 解錠済み(＝板を持ち出した可能性)の仮予約は、物理的二重貸出を防ぐため
      // 自動削除しない。ただし放置されることを防ぐため、長期間(6h)超はログで
      // 管理者に気付かせる（手動での確定/強制返却が必要）。
      const ghostMs = (now - (invalidDate ? now : ts));
      if (!invalidDate && ghostMs >= STALE_UNLOCK_GHOST_MS) {
        staleUnlockGhost.push({ id: r.id, ageMs: ghostMs });
      }
      continue;
    }
    const diffMin = (invalidDate ? Infinity : (now - ts) / 60000);
    if (diffMin >= STALE_MINUTES) stale.push(r);
  }
  if (stale.length > 0) {
    const del = db.prepare('DELETE FROM active_loans WHERE id = ?');
    const tx = db.transaction((ids) => { ids.forEach(id => del.run(id)); });
    tx(stale.map(r => r.id));
  }
  if (staleUnlockGhost.length > 0) {
    for (const g of staleUnlockGhost) {
      console.warn(`[staleUnlockGhost] 解錠済みだが確定されていない貸出が6時間以上経過しています: id=${g.id} (${Math.round(g.ageMs / 60000)}分前) - 実物の所在と履歴を確認し、必要なら手動確定してください`);
    }
  }
}

// 解錠済み(unlock_authorized=1)ゴーストを WARN で通知する閾値(6時間)。
const STALE_UNLOCK_GHOST_MS = 6 * 60 * 60 * 1000;

function getLoans() {
  _sweepStalePreparations();
  const rows = db.prepare('SELECT * FROM active_loans ORDER BY rowid ASC').all();
  // 延滞判定は getLoanDeadline / isOverdueLoan の単一実装を使う（画面ごとに
  // 別の式を持つと、ボード・管理画面・キオスクで延滞の見え方がずれるため）。
  const settings = getSettings().settings || DEFAULT_SETTINGS;
  const now = new Date();
  const loans = rows.map(r => {
    const base = {
      id: r.id,
      name: r.name,
      email: normalizeEmail(r.email),
      deviceId: r.device_id,
      returnVerifyRequired: Number(r.return_verify_required) === 1,
      unlockAuthorized: Number(r.unlock_authorized) === 1,
      isPrepared: !db.prepare('SELECT 1 FROM history WHERE id = ?').get(r.id),
      checkoutTime: r.checkout_time ? _safeISO(r.checkout_time) : '',
      sessionId: r.session_id || ''
    };
    const due = getLoanDeadline(base, settings);
    base.dueTime = due ? due.toISOString() : '';
    base.overdue = isOverdueLoan(base, settings, now);
    return base;
  });
  return { success: true, loans };
}

function _isReturnVerificationRequired(loan, settings) {
  return !!loan && !!settings && settings.returnVerify === true
    && Number(loan.return_verify_required) === 1;
}

function getHistory() {
  const rows = db.prepare('SELECT * FROM history ORDER BY rowid DESC').all(); // 新しい順
  const history = rows.map(r => ({
    id: r.id,
    name: r.name,
    email: normalizeEmail(r.email),
    deviceId: r.device_id,
    dob: r.dob,
    checkoutTime: r.checkout_time ? _safeISO(r.checkout_time) : '',
    sessionId: r.session_id || '',
    returnTime: r.return_time ? _safeISO(r.return_time) : '',
    status: r.status
  }));
  return { success: true, history };
}

function clearData({ passcode, target } = {}) {
  const check = verifyPasscodeWithLockout(passcode);
  if (!check.ok) return { success: false, message: check.message };

  if (target !== 'active' && target !== 'history') {
    return { success: false, message: '無効なターゲットです' };
  }

  // バグ修正: どちらのターゲットでも「貸出中」の記録が残っている状態での
  // 削除を許可していたため、履歴を消すと返却処理が永久に失敗し
  // (returnComplete は history の行が無いと active_loans を消せない)、
  // 貸出中だけを消すと history 側の行が「貸出中」のまま戻せなくなる。
  // どちらかが孤立状態になるのを防ぐため、貸出中の記録がある間は
  // 処理させず、管理者に「返却 or 強制返却」を先に求める。
  const activeCount = db.prepare('SELECT COUNT(*) c FROM active_loans').get().c;
  if (activeCount > 0) {
    return {
      success: false,
      message: `貸出中の記録が${activeCount}件あるため削除できません。`
        + '先に全生徒を返却させるか、管理画面の「強制返却」で終了させてください'
    };
  }

  if (target === 'active') {
    db.prepare('DELETE FROM active_loans').run();
  } else {
    db.prepare('DELETE FROM history').run();
  }
  return { success: true, message: 'データを初期化しました' };
}

// ブラックリスト照合。期限切れの登録は照会のたびに自動削除される(GASと同じ)。
function isBlacklisted(name, email) {
  const now = new Date();
  const rows = db.prepare('SELECT * FROM blacklist').all();
  const nName = normalizeName(name);

  let foundReason = null;
  const expiredRowIds = [];

  for (const row of rows) {
    const bEmail = normalizeEmail(row.email);
    const bName = normalizeName(row.name);
    const expiry = row.expiry;

    if (expiry && expiry !== 'PERMANENT') {
      const expiryDate = new Date(expiry);
      if (!isNaN(expiryDate) && expiryDate < now) {
        expiredRowIds.push(row.row_id);
        continue;
      }
    }

    if (foundReason === null) {
      let match = false;
      if (email && bEmail) {
        match = normalizeEmail(email) === bEmail;
      } else if (nName && bName) {
        match = nName === bName;
      }

      if (match) {
        let msg = 'あなたは現在、端末の貸出が制限されています。';
        if (expiry === 'PERMANENT') {
          msg += '（無期限の制限）';
        } else if (expiry) {
          const d = new Date(expiry);
          if (!isNaN(d)) {
            const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
            msg += `（制限解除予定日: ${y}/${m}/${day}）`;
          }
        }
        foundReason = msg;
      }
    }
  }

  if (expiredRowIds.length > 0) {
    const del = db.prepare('DELETE FROM blacklist WHERE row_id = ?');
    const tx = db.transaction((ids) => { ids.forEach(id => del.run(id)); });
    tx(expiredRowIds);
  }

  return foundReason;
}

// 借りた本人・返した本人への確認メールをキューに積む。
// 宛先メールアドレスが無い(名前のみで貸出した)場合は何もしない。
// 設定でOFFにしている場合も何もしない。この関数自体は例外を投げない
// (呼び出し元の貸出・返却処理を絶対に失敗させないため)。
function _enqueueUserEmail(kind, { name, email, deviceId, checkoutTime, returnTime, isLate }) {
  try {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return; // 送り先が無い

    const settings = getSettings().settings || DEFAULT_SETTINGS;
    if (kind === 'checkout' && settings.notifyUserOnCheckout === false) return;
    if (kind === 'return' && settings.notifyUserOnReturn === false) return;

    emailQueue.enqueue(kind, {
      name: name || '',
      email: normalizedEmail,
      deviceId: deviceId || '',
      checkoutTime: checkoutTime || '',
      returnTime: returnTime || '',
      isLate: !!isLate
    });
  } catch (e) {
    console.error(`[_enqueueUserEmail] ${kind}確認メールのキュー登録でエラー(貸出・返却処理には影響ありません): ` + e.message);
  }
}

// 貸出の2段階方式（仮登録）。確認画面で内容を確定した時点で active_loans へ
// 仮予約として即時書き込み、貸出番号(loanId)と割当端末(deviceId)を返す。
// 本登録(checkoutCommit)は扉が閉まったタイミングで行う。
// 以前はここが実装されておらず LOGAL_ACTIONS 経由で「不明なアクション」と
// 判定され、貸出フローが常に失敗していた。GASの checkoutPrepare と同じ
// 意味論で、ローカルSQLiteに直接反映する（解錠許可の照合は server.js が
// この仮予約を参照する）。
function checkoutPrepare(params) {
  _sweepStalePreparations();
  const blockMsg = _modeBlockMessage('checkout');
  if (blockMsg) return { success: false, message: blockMsg };

  const { name, email, dob, sessionId } = params || {};
  const settings = getSettings().settings || DEFAULT_SETTINGS;
  const returnVerifyRequired = settings.returnVerify === true ? 1 : 0;
  const normalizedDob = dob ? normalizeDob(dob) : '';
  if (!name && !email) return { success: false, message: '名前またはメールアドレスが必要です' };
  if (returnVerifyRequired && !normalizedDob) {
    return { success: false, message: '生年月日認証が有効です。貸出時に生年月日を入力してください' };
  }

  const blacklistReason = isBlacklisted(name, email);
  if (blacklistReason) return { success: false, message: '【貸出制限】' + blacklistReason };

  return db.transaction(() => {
    const nName = normalizeName(name);
    const activeRows = db.prepare('SELECT * FROM active_loans').all();
    for (const row of activeRows) {
      const existingEmail = normalizeEmail(row.email);
      const existingName = normalizeName(row.name);
      if (email && existingEmail && existingEmail === normalizeEmail(email)) {
        return { success: false, message: `あなたはすでに端末を借りています（端末: ${row.device_id}）。1人1台までです。` };
      }
      if ((!email || !existingEmail) && nName && existingName === nName) {
        return { success: false, message: `あなたはすでに端末を借りています（端末: ${row.device_id}）。1人1台までです。` };
      }
    }

    const used = new Set(activeRows.map(r => r.device_id));
    const failed = getFailedDevices();
    const free = ALL_DEVICES.filter(d => !used.has(d) && !failed.has(d));
    if (free.length === 0) {
      const msg = failed.size > 0 ? '現在利用可能な端末がありません（貸出中または故障中）。' : '現在すべての端末が貸出中です。';
      return { success: false, message: msg };
    }

    const deviceId = _pickBestDevice(free);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO active_loans (id, name, email, device_id, dob, checkout_time, session_id, return_verify_required)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name || '', email || '', deviceId, normalizedDob, now, sessionId || '', returnVerifyRequired);

    return { success: true, loanId: id, deviceId };
  })();
}

function checkoutCancel({ loanId, sessionId } = {}) {
  if (!loanId || !sessionId) return { success: false, message: '貸出予約の識別情報が不足しています' };
  return db.transaction(() => {
    const row = db.prepare('SELECT id, session_id FROM active_loans WHERE id = ?').get(loanId);
    if (!row) return { success: true, message: '貸出予約は既に解除されています' };
    if (row.session_id !== sessionId) return { success: false, message: 'この貸出予約を解除する権限がありません' };
    if (db.prepare('SELECT 1 FROM history WHERE id = ?').get(loanId)) {
      return { success: false, message: '確定済みの貸出は予約解除できません' };
    }
    const unlock = db.prepare('SELECT unlock_authorized FROM active_loans WHERE id = ?').get(loanId);
    if (unlock && Number(unlock.unlock_authorized) === 1) {
      return { success: false, message: '解錠を試みた貸出予約は安全のため解除できません。管理者に確認してください。' };
    }
    db.prepare('DELETE FROM active_loans WHERE id = ?').run(loanId);
    return { success: true, message: '貸出予約を解除しました' };
  })();
}

function markCheckoutUnlockAuthorized({ loanId, deviceId } = {}) {
  if (!loanId || !deviceId) return { success: false, message: '貸出予約の識別情報が不足しています' };
  const result = db.prepare(`
    UPDATE active_loans SET unlock_authorized = 1
    WHERE id = ? AND device_id = ?
  `).run(loanId, deviceId);
  if (result.changes === 1) return { success: true };
  return { success: false, message: '解錠対象の貸出予約が見つかりません' };
}

// 貸出の2段階方式（本登録）。checkoutPrepare で作った仮予約を貸出記録
// (history)として確定する。扉が閉まった時点で呼ばれ、手動完了フロー等で
// 再試行されても2重登録にならないよう冪等に実装する
// （historyに既に存在すれば何もせず成功を返す）。
function checkoutCommit(params) {
  const { loanId } = params || {};
  if (!loanId) return { success: false, message: 'loanIdが必要です' };

  const row = db.prepare('SELECT * FROM active_loans WHERE id = ?').get(loanId);
  if (!row) {
    // 仮予約が見当たらない場合も、既に確定済み(history側に存在)なら
    // 再試行として成功扱いにする（扉閉監視→手動完了の再試行フロー用）。
    const committed = db.prepare('SELECT id FROM history WHERE id = ?').get(loanId);
    if (committed) return { success: true };
    return { success: false, message: '貸出予約が見つかりません。もう一度操作してください。' };
  }
  if (!params.adminRecovery && String(params.sessionId || '') !== String(row.session_id || '')) {
    return { success: false, message: 'この貸出予約を確定する権限がありません' };
  }
  if (Number(row.unlock_authorized) !== 1) {
    return { success: false, message: '解錠を確認できないため貸出を確定できません。管理者に確認してください。' };
  }

  const result = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM history WHERE id = ?').get(loanId);
    let inserted = false;
    if (!existing) {
      inserted = true;
      db.prepare(`
        INSERT INTO history (id, name, email, device_id, dob, checkout_time, session_id, return_time, return_verify_required, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '貸出中')
      `).run(row.id, row.name, row.email || '', row.device_id, row.dob || '', row.checkout_time, row.session_id || '', row.return_verify_required ? 1 : 0);
    }
    return { success: true, inserted, loanId: row.id, deviceId: row.device_id, name: row.name, email: row.email || '', checkoutTime: row.checkout_time };
  })();

  // 再試行(既に確定済み)の場合は確認メールを二重に積まない
  if (result.success && result.inserted) {
    _enqueueUserEmail('checkout', {
      name: result.name,
      email: result.email,
      deviceId: result.deviceId,
      checkoutTime: result.checkoutTime
    });
  }

  return result;
}

// 一括版(即時貸出)。確認画面を挟まない1ステップ方式。
function checkout(params) {
  _sweepStalePreparations();
  const blockMsg = _modeBlockMessage('checkout');
  if (blockMsg) return { success: false, message: blockMsg };

  const { name, email, dob, deviceId, sessionId } = params;
  const settings = getSettings().settings || DEFAULT_SETTINGS;
  const returnVerifyRequired = settings.returnVerify === true ? 1 : 0;
  const normalizedDob = dob ? normalizeDob(dob) : '';
  if ((!name && !email) || !deviceId) return { success: false, message: '名前またはメールアドレスが必要です' };
  if (returnVerifyRequired && !normalizedDob) {
    return { success: false, message: '生年月日認証が有効です。貸出時に生年月日を入力してください' };
  }
  if (!ALL_DEVICES.includes(deviceId)) return { success: false, message: '端末番号が不正です: ' + deviceId };

  const blacklistReason = isBlacklisted(name, email);
  if (blacklistReason) return { success: false, message: '【貸出制限】' + blacklistReason + '\n詳細は管理者に確認してください。' };

  const failed = getFailedDevices();
  if (failed.has(deviceId)) return { success: false, message: 'その端末は現在故障中のため貸出できません。他の端末を選択してください。' };

  const result = db.transaction(() => {
    const nName = normalizeName(name);
    const activeRows = db.prepare('SELECT * FROM active_loans').all();
    for (const row of activeRows) {
      const existingEmail = normalizeEmail(row.email);
      const existingName = normalizeName(row.name);
      if (email && existingEmail && existingEmail === normalizeEmail(email)) {
        return { success: false, message: `あなたはすでに端末を借りています（端末: ${row.device_id}）。1人1台までです。` };
      }
      if ((!email || !existingEmail) && nName && existingName === nName) {
        return { success: false, message: `あなたはすでに端末を借りています（端末: ${row.device_id}）。1人1台までです。` };
      }
      if (row.device_id === deviceId) {
        return { success: false, message: 'その端末は現在使用中です。再度「貸出」から操作してください。' };
      }
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const sId = sessionId || '';

    db.prepare(`
      INSERT INTO active_loans (id, name, email, device_id, dob, checkout_time, session_id, return_verify_required)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name || '', email || '', deviceId, normalizedDob, now, sId, returnVerifyRequired);

    db.prepare(`
      INSERT INTO history (id, name, email, device_id, dob, checkout_time, session_id, return_time, return_verify_required, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '貸出中')
    `).run(id, name || '', email || '', deviceId, normalizedDob, now, sId, returnVerifyRequired);

    return { success: true, loanId: id, deviceId, name: name || '', email: email || '', checkoutTime: now };
  })();

  if (result.success) {
    _enqueueUserEmail('checkout', {
      name: result.name,
      email: result.email,
      deviceId: result.deviceId,
      checkoutTime: result.checkoutTime
    });
  }

  return { success: result.success, message: result.message, loanId: result.loanId, deviceId: result.deviceId };
}

function checkoutAuto(params) {
  const blockMsg = _modeBlockMessage('checkout');
  if (blockMsg) return { success: false, message: blockMsg };

  const used = new Set(db.prepare('SELECT device_id FROM active_loans').all().map(r => r.device_id));
  const failed = getFailedDevices();
  const free = ALL_DEVICES.filter(d => !used.has(d) && !failed.has(d));
  if (free.length === 0) return { success: false, message: '現在すべての端末が貸出中です。返却されるまでお待ちください。' };

  return checkout(Object.assign({}, params, { deviceId: _pickBestDevice(free) }));
}

function returnVerify({ loanId, dob } = {}) {
  const blockMsg = _modeBlockMessage('return');
  if (blockMsg) return { success: false, message: blockMsg };
  if (!loanId) return { success: false, message: '貸出記録IDが不足しています' };

  const row = db.prepare('SELECT * FROM active_loans WHERE id = ?').get(loanId);
  if (!row) return { success: false, message: '貸出記録が見つかりません' };
  // 本人確認の要否はサーバー側の設定で確定させる。
  // 生徒画面の js/app.js は returnVerify がOFFのとき dob に 'SKIP' を
  // 送ってくるが、以往はサーバーの設定を見ずに 'SKIP' をそのまま信用して
  // 照合をスキップしていた。そのため、本人確認を「ON」にしている運用でも
  // API 直叩き（または生徒画面側の細工）で生年月日照合を回避できていた。
  const settings = getSettings().settings || DEFAULT_SETTINGS;
  const verifyRequired = _isReturnVerificationRequired(row, settings);
  if (verifyRequired && (!dob || dob === 'SKIP')) {
    return { success: false, message: '本人確認が有効になっているため、生年月日を入力してください' };
  }

  const skipVerify = !verifyRequired;
  const recordDob = normalizeDob(row.dob);

  if (!skipVerify) {
    const inputDob = normalizeDob(dob);
    if (!recordDob || !inputDob || inputDob !== recordDob) {
      return { success: false, message: '生年月日が一致しません。もう一度確認してください' };
    }
    db.prepare('UPDATE active_loans SET return_verified_at = ? WHERE id = ?')
      .run(new Date().toISOString(), loanId);
  }

  if (!db.prepare('SELECT 1 FROM history WHERE id = ?').get(loanId)) {
    if (Number(row.unlock_authorized) !== 1) {
      return { success: false, message: '扉の解錠を確認できない貸出予約です。管理者にお知らせください' };
    }
    db.prepare(`
      INSERT INTO history (id, name, email, device_id, dob, checkout_time, session_id,
        return_time, return_verify_required, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '貸出中')
    `).run(row.id, row.name, row.email || '', row.device_id, row.dob || '',
      row.checkout_time, row.session_id || '', Number(row.return_verify_required) === 1 ? 1 : 0);
  }

  return {
    success: true,
    loan: {
      id: row.id,
      name: row.name,
      email: normalizeEmail(row.email),
      deviceId: row.device_id,
      checkoutTime: _safeISO(row.checkout_time)
    }
  };
}

function processOverdue(name, email, settings) {
  const nName = normalizeName(name);
  const nEmail = normalizeEmail(email);
  const rows = db.prepare('SELECT * FROM users').all();
  let user = null;
  const expiredRowIds = [];
  const nowTs = Date.now();

  for (const row of rows) {
    const rowEmail = normalizeEmail(row.email);
    const rowName = normalizeName(row.name);
    let match = false;
    if (nEmail && rowEmail && nEmail === rowEmail) match = true;
    if (!match && !nEmail && !rowEmail && nName && rowName && nName === rowName) match = true;

    // 一致行はここで確定させる。ただし break すると後ろの行が期限切れ判定の
    // 走査対象から外れ、「他の生徒の期限切れ記録を削除する」処理が一致行の
    // 直後にあるさで止まってしまうため、走査は最後まで行う。
    if (match && !user) user = row;

    // 期限切れの登録は削除候補に集める。
    // バグ修正: users テーブルに expiry 列は存在しない（正しくは
    // restricted_until）。row.expiry は常に undefined だったため、
    // 制限期限を過ぎたユーザー行が削除されずに永久に残っていた。
    const expiry = row.restricted_until;
    if (expiry && expiry !== 'PERMANENT') {
      const expiryDate = new Date(expiry);
      if (!isNaN(expiryDate) && expiryDate.getTime() < nowTs) {
        // 今回延滞処理の対象になった行本人はこの直後に UPDATE する。
        // 先に削除されると UPDATE が 0 件で消え、延滞回数が保存されない
        // ため削除対象から除外する（期限切れの表示値は下の UPDATE で
        // 空に戻すので、管理画面の「貸出制限期限」も放置されない）。
        if (!match) expiredRowIds.push(row.row_id);
      }
    }
  }

  // 期限切れのユーザー行を削除
  if (expiredRowIds.length > 0) {
    const del = db.prepare('DELETE FROM users WHERE row_id = ?');
    db.transaction((ids) => { ids.forEach(id => del.run(id)); })(expiredRowIds);
  }

  let overdueCount = (user ? user.overdue_count : 0) + 1;
  let penaltyCount = user ? user.penalty_count : 0;

  if (!user) {
    const info = db.prepare(`
      INSERT INTO users (email, name, overdue_count, penalty_count, restricted_until)
      VALUES (?, ?, ?, ?, '')
    `).run(email || '', name, overdueCount, penaltyCount);
    user = { row_id: info.lastInsertRowid };
  } else {
    // 期限が過ぎているのに値が残っていた場合は空に戻して上書きする
    let keepRestriction = user.restricted_until || '';
    if (keepRestriction && keepRestriction !== 'PERMANENT') {
      const d = new Date(keepRestriction);
      if (!isNaN(d) && d.getTime() < nowTs) keepRestriction = '';
    }
    db.prepare('UPDATE users SET overdue_count = ?, restricted_until = ? WHERE row_id = ?')
      .run(overdueCount, keepRestriction, user.row_id);
  }

  const threshold = settings.blThreshold || 3;
  if (overdueCount >= threshold) {
    penaltyCount++;
    const durationMonths = settings.blDuration || 1;
    let finalDuration = durationMonths;
    let isPermanent = false;

    if (penaltyCount > 1) {
      if (settings.blReoffense === 'permanent') isPermanent = true;
      else finalDuration = durationMonths * 2;
    }

    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + finalDuration);
    const expiryIso = expiry.toISOString();

    db.prepare(`
      UPDATE users SET overdue_count = 0, penalty_count = ?, restricted_until = ?
      WHERE row_id = ?
    `).run(penaltyCount, isPermanent ? 'PERMANENT' : expiryIso, user.row_id);

    addBlacklist({
      passcode: 'internal',
      email,
      name,
      reason: `無断延滞 ${threshold}回累積による自動登録`,
      expiry: isPermanent ? 'PERMANENT' : expiryIso,
      penaltyCount
    });
  }
}

// 返却期限の算出。ローカルDBの返却記録・貸出状況盤(board-status)-
// GASの通知メール判定の3箇所が同じ規則を使うよう、ここに1か所だけ定義する。
// 規則: 貸出日当日の returnDeadlineHour:returnDeadlineMinute を期限とし、
// その時刻が貸出時刻より前になる場合は翌日へずらし、猶予(grace)を足す。
// GAS の _findOverdueLoans と同じ規則にそろえてある。
// 貸出時刻が読めない場合は期限を計算できないため、延滞とは扱わない。
function getLoanDeadline(loan, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const dHour = Number.isFinite(s.returnDeadlineHour) ? s.returnDeadlineHour : DEFAULT_SETTINGS.returnDeadlineHour;
  const dMin = Number.isFinite(s.returnDeadlineMinute) ? s.returnDeadlineMinute : DEFAULT_SETTINGS.returnDeadlineMinute;
  const grace = Number.isFinite(s.gracePeriodMinutes) ? s.gracePeriodMinutes : 0;

  const raw = loan && (loan.checkout_time || loan.checkoutTime);
  const checkout = new Date(raw || '');
  if (isNaN(checkout.getTime())) return null;

  const due = new Date(checkout);
  due.setHours(dHour, dMin, 0, 0);
  if (due.getTime() <= checkout.getTime()) due.setDate(due.getDate() + 1);
  due.setMinutes(due.getMinutes() + grace);
  return due;
}

function isOverdueLoan(loan, settings, now) {
  const due = getLoanDeadline(loan, settings);
  if (!due) return false;
  return (now || new Date()).getTime() > due.getTime();
}

function returnComplete(params = {}) {
  const blockMsg = _modeBlockMessage('return');
  if (blockMsg) return { success: false, message: blockMsg };

  const { loanId } = params;
  if (!loanId) return { success: false, message: '記録IDが不足しています' };

  const loan = db.prepare('SELECT * FROM active_loans WHERE id = ?').get(loanId);
  if (!loan) return { success: false, message: '貸出記録が見つかりません' };

  const settings = getSettings().settings || DEFAULT_SETTINGS;
  const now = new Date();
  if (_isReturnVerificationRequired(loan, settings) && !loan.return_verified_at) {
    return { success: false, message: '返却前に生年月日による本人確認を完了してください' };
  }
  const isLate = isOverdueLoan(loan, settings, now);

  const result = db.transaction(() => {
    const histRow = db.prepare('SELECT rowid FROM history WHERE id = ?').get(loanId);
    if (!histRow) {
      return { success: false, message: '履歴の更新に失敗しました: 履歴シートに対象の行が見つかりません' };
    }
    db.prepare(`
      UPDATE history SET return_time = ?, status = ? WHERE id = ?
    `).run(now.toISOString(), isLate ? '延滞返却' : '返却済', loanId);

    db.prepare('DELETE FROM active_loans WHERE id = ?').run(loanId);

    return { success: true, deviceId: loan.device_id, isLate, name: loan.name, email: normalizeEmail(loan.email) };
  })();

  if (!result.success) return result;

  if (isLate && (result.email || result.name)) {
    try { processOverdue(result.name, result.email, settings); }
    catch (e) { console.error('[returnComplete] processOverdue エラー: ' + e.message); }
  }

  if (params.isDamaged === true || params.isDamaged === 'true') {
    try { reportFailure({ deviceId: result.deviceId, name: result.name, email: result.email, loanId }); }
    catch (e) { console.error('[returnComplete] reportFailure エラー: ' + e.message); }
  }

  _enqueueUserEmail('return', {
    name: result.name,
    email: result.email,
    deviceId: result.deviceId,
    returnTime: now.toISOString(),
    isLate: result.isLate
  });

  return { success: true, deviceId: result.deviceId, isLate: result.isLate };
}

function getBlacklist() {
  const now = new Date();
  const rows = db.prepare('SELECT * FROM blacklist').all();
  const expiredIds = [];
  const kept = [];

  for (const row of rows) {
    if (row.expiry && row.expiry !== 'PERMANENT') {
      const d = new Date(row.expiry);
      if (!isNaN(d) && d < now) { expiredIds.push(row.row_id); continue; }
    }
    kept.push(row);
  }
  if (expiredIds.length > 0) {
    const del = db.prepare('DELETE FROM blacklist WHERE row_id = ?');
    db.transaction((ids) => ids.forEach(id => del.run(id)))(expiredIds);
  }

  const blacklist = kept.map(r => ({
    rowId: r.row_id,
    email: normalizeEmail(r.email),
    name: r.name,
    reason: r.reason,
    createdAt: _safeISO(r.created_at),
    expiry: r.expiry ? (r.expiry === 'PERMANENT' ? 'PERMANENT' : _safeISO(r.expiry)) : '',
    violations: r.violations || 0
  }));

  return { success: true, blacklist };
}

function addBlacklist(params = {}) {
  const { passcode, email, name, reason, expiry, penaltyCount } = params;
  const check = verifyPasscodeWithLockout(passcode);
  if (!check.ok) return { success: false, message: check.message };
  if (!email && !name) return { success: false, message: 'メールアドレスまたは名前が必要です' };

  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO blacklist (email, name, reason, created_at, expiry, violations)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email || '', name || '', reason || '理由なし', createdAt, expiry || '', penaltyCount || 0);

  return { success: true, message: 'ブラックリストに追加しました' };
}

function removeBlacklist({ passcode, rowId, email, name } = {}) {
  const check = verifyPasscodeWithLockout(passcode);
  if (!check.ok) return { success: false, message: check.message };

  const exactRowId = Number(rowId);
  if (Number.isInteger(exactRowId) && exactRowId > 0) {
    const result = db.prepare('DELETE FROM blacklist WHERE row_id = ?').run(exactRowId);
    if (result.changes > 0) return { success: true, message: 'ブラックリストから削除しました' };
    return { success: false, message: 'ブラックリストに該当するユーザーが見つかりません' };
  }

  const nName = normalizeName(name);
  const rows = db.prepare('SELECT * FROM blacklist').all();
  const toDelete = rows.filter(row => {
    const bEmail = normalizeEmail(row.email);
    const bName = normalizeName(row.name);
    if (email && bEmail) return bEmail === normalizeEmail(email);
    if (nName && bName) return bName === nName;
    return false;
  });

  if (toDelete.length === 0) return { success: false, message: 'ブラックリストに該当するユーザーが見つかりません' };

  const del = db.prepare('DELETE FROM blacklist WHERE row_id = ?');
  db.transaction((ids) => ids.forEach(id => del.run(id)))(toDelete.map(r => r.row_id));

  return { success: true, message: 'ブラックリストから削除しました' };
}

function getFailures() {
  const rows = db.prepare('SELECT * FROM failures ORDER BY rowid DESC').all();
  const failures = rows.map(r => ({
    deviceId: r.device_id,
    reportedAt: _safeISO(r.reported_at),
    name: r.name,
    email: normalizeEmail(r.email),
    resolvedAt: _safeISO(r.resolved_at),
    status: r.status,
    loanId: r.loan_id
  }));
  return { success: true, failures };
}

function reportFailure({ deviceId, name, email, loanId } = {}) {
  const already = db.prepare(`SELECT 1 FROM failures WHERE device_id = ? AND status = '故障中'`).get(deviceId);
  if (already) return { success: true, message: '既に故障報告済みです' };

  db.prepare(`
    INSERT INTO failures (device_id, reported_at, name, email, resolved_at, status, loan_id)
    VALUES (?, ?, ?, ?, '', '故障中', ?)
  `).run(deviceId, new Date().toISOString(), name || '', email || '', loanId || '');

  return { success: true, message: '故障を記録しました' };
}

function addFailure({ deviceId } = {}) {
  if (!ALL_DEVICES.includes(deviceId)) return { success: false, message: '端末番号が不正です' };
  const activeLoan = db.prepare('SELECT * FROM active_loans WHERE device_id = ?').get(deviceId);
  return reportFailure({
    deviceId,
    name: activeLoan ? activeLoan.name : '',
    email: activeLoan ? activeLoan.email : '',
    loanId: activeLoan ? activeLoan.id : ''
  });
}

function resolveFailure({ deviceId } = {}) {
  if (!ALL_DEVICES.includes(deviceId)) return { success: false, message: '端末番号が不正です' };
  const result = db.prepare(`
    UPDATE failures SET resolved_at = ?, status = '完了' WHERE device_id = ? AND status = '故障中'
  `).run(new Date().toISOString(), deviceId);

  if (result.changes > 0) return { success: true, message: '故障状態を解除しました' };
  return { success: false, message: '故障中の記録が見つかりません' };
}

// ============================================================
// 管理画面からの個別データ操作(SQLiteの中身を直接確認・修正・削除)
// ------------------------------------------------------------
// 通常の貸出・返却フローとは別の、管理者専用の操作。
// パスコード確認は呼び出し元(server.js)側の管理者セッション確認で
// 済んでいる前提で、ここでは追加のパスコード検証は行わない。
// ============================================================

// 貸出中の1件を、生徒本人の操作を経ずに強制的に返却済みにする。
// センサーの誤検知や、生徒が返却操作を忘れて帰ってしまった場合などに使う。
// 延滞判定や通知メールのトリガーは行わない(あくまで記録上の是正のため)。
function forceReturnLoan({ id } = {}) {
  if (!id) return { success: false, message: '記録IDが必要です' };

  const loan = db.prepare('SELECT * FROM active_loans WHERE id = ?').get(id);
  if (!loan) return { success: false, message: '対象の貸出記録が見つかりません(既に返却済みの可能性があります)' };

  const result = db.transaction(() => {
    const histRow = db.prepare('SELECT rowid FROM history WHERE id = ?').get(id);
    if (histRow) {
      db.prepare(`
        UPDATE history SET return_time = ?, status = '返却済(管理者による強制返却)' WHERE id = ?
      `).run(new Date().toISOString(), id);
    } else {
      db.prepare(`
        INSERT INTO history (id, name, email, device_id, dob, checkout_time, session_id,
          return_time, return_verify_required, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '準備中を管理者が解除')
      `).run(loan.id, loan.name, loan.email || '', loan.device_id, loan.dob || '',
        loan.checkout_time, loan.session_id || '', new Date().toISOString(),
        Number(loan.return_verify_required) === 1 ? 1 : 0);
    }
    db.prepare('DELETE FROM active_loans WHERE id = ?').run(id);
    return { deviceId: loan.device_id, name: loan.name };
  })();

  return { success: true, message: `${result.deviceId}(${result.name})を強制的に返却済みにしました` };
}

// 履歴を1件だけ訂正する。誤った氏名・メールアドレス・日時で記録されて
// しまった場合の修正用。渡されたフィールドだけを更新し、他は変更しない。
function editHistoryEntry({ id, name, email, deviceId, dob, checkoutTime, returnTime, status } = {}) {
  if (!id) return { success: false, message: '記録IDが必要です' };
  if (db.prepare('SELECT 1 FROM active_loans WHERE id = ?').get(id)) {
    return { success: false, message: '貸出中の記録は編集できません。先に返却処理を完了してください' };
  }

  const row = db.prepare('SELECT * FROM history WHERE id = ?').get(id);
  if (!row) return { success: false, message: '対象の履歴が見つかりません' };

  // バグ修正: 変換（toISOString）を先に行っていたため、壊れた日時文字列が
  // 渡ると「貸出日時の形式が正しくありません」という DESTROY ではなく
  // RangeError: Invalid time value が投げられ、APIが500になっていた。
  // 検証を先に行い、利用者向けのメッセージを返す。
  let nextCheckoutTime = row.checkout_time;
  if (checkoutTime !== undefined) {
    const d = new Date(checkoutTime);
    if (isNaN(d.getTime())) return { success: false, message: '貸出日時の形式が正しくありません' };
    nextCheckoutTime = d.toISOString();
  }
  let nextReturnTime = row.return_time;
  if (returnTime !== undefined) {
    if (returnTime) {
      const d = new Date(returnTime);
      if (isNaN(d.getTime())) return { success: false, message: '返却日時の形式が正しくありません' };
      nextReturnTime = d.toISOString();
    } else {
      nextReturnTime = '';
    }
  }

  const next = {
    name: name !== undefined ? String(name).trim() : row.name,
    email: email !== undefined ? normalizeEmail(email) : row.email,
    device_id: deviceId !== undefined ? String(deviceId).trim() : row.device_id,
    dob: dob !== undefined ? normalizeDob(dob) : row.dob,
    checkout_time: nextCheckoutTime,
    return_time: nextReturnTime,
    status: status !== undefined ? String(status).trim() : row.status
  };

  if (!next.name) return { success: false, message: '氏名は空にできません' };
  if (!next.device_id) return { success: false, message: '端末番号は空にできません' };
  if (isNaN(new Date(next.checkout_time).getTime())) return { success: false, message: '貸出日時の形式が正しくありません' };
  if (next.return_time && isNaN(new Date(next.return_time).getTime())) return { success: false, message: '返却日時の形式が正しくありません' };
  // バグ修正: status を検証せずにそのまま保存していたため、管理画面の
  // プルダウンに無い任意文字列を書き込めていた（表示・集計の不整合の元）。
  // GPIO 等で使われる status は以下の4値のみに限定する。
  const ALLOWED_HISTORY_STATUSES = new Set(['貸出中', '返却済', '延滞返却', '返却済(管理者による強制返却)', '準備中を管理者が解除']);
  // 既存の状態を変えない編集(氏名の訂正のみ等)は、過去の値が許可リスト外でも通す。
  if (next.status && next.status !== row.status && !ALLOWED_HISTORY_STATUSES.has(next.status)) {
    return { success: false, message: '状態は「貸出中」「返却済」「延滞返却」のいずれかで指定してください' };
  }

  db.prepare(`
    UPDATE history SET name = ?, email = ?, device_id = ?, dob = ?,
                        checkout_time = ?, return_time = ?, status = ?
    WHERE id = ?
  `).run(next.name, next.email, next.device_id, next.dob,
    next.checkout_time, next.return_time, next.status, id);

  return { success: true, message: '履歴を更新しました' };
}

// 履歴を1件だけ削除する。GASの手動削除に相当する操作で、通常は
// clearData(全削除)の代わりにこちらを使う想定。
function deleteHistoryEntry({ id } = {}) {
  if (!id) return { success: false, message: '記録IDが必要です' };
  if (db.prepare('SELECT 1 FROM active_loans WHERE id = ?').get(id)) {
    return { success: false, message: '貸出中の記録は削除できません。先に返却処理を完了してください' };
  }
  const result = db.prepare('DELETE FROM history WHERE id = ?').run(id);
  if (result.changes > 0) return { success: true, message: '履歴を削除しました' };
  return { success: false, message: '対象の履歴が見つかりません' };
}

// usersテーブル(延滞回数・ペナルティ回数・貸出制限期限)の一覧取得。
function getUsers() {
  const rows = db.prepare('SELECT * FROM users ORDER BY overdue_count DESC, penalty_count DESC').all();
  const users = rows.map(r => ({
    rowId: r.row_id,
    email: normalizeEmail(r.email),
    name: r.name,
    overdueCount: r.overdue_count || 0,
    penaltyCount: r.penalty_count || 0,
    restrictedUntil: r.restricted_until || ''
  }));
  return { success: true, users };
}

// usersテーブルの1件を編集する。延滞回数のリセットや、誤って記録された
// ペナルティの訂正に使う。
function updateUser({ rowId, overdueCount, penaltyCount, restrictedUntil } = {}) {
  if (!rowId) return { success: false, message: '対象のIDが必要です' };
  const row = db.prepare('SELECT * FROM users WHERE row_id = ?').get(rowId);
  if (!row) return { success: false, message: '対象のユーザーが見つかりません' };

  const nextOverdue = overdueCount !== undefined ? Math.max(0, parseInt(overdueCount, 10) || 0) : row.overdue_count;
  const nextPenalty = penaltyCount !== undefined ? Math.max(0, parseInt(penaltyCount, 10) || 0) : row.penalty_count;
  const nextRestricted = restrictedUntil !== undefined ? String(restrictedUntil).trim() : row.restricted_until;

  // バグ修正: restrictedUntil の形式を検証せずにそのまま保存していたため、
  // 不正な値（ゴミ文字列・巨大な文字列）を DB に書き込めていた。
  // 許容するのは「空(制限解除)」「PERMANENT(無期限)」「妥当な日時文字列」のみ。
  if (nextRestricted && nextRestricted !== 'PERMANENT') {
    if (String(nextRestricted).length > 40) {
      return { success: false, message: '貸出制限期限の形式が正しくありません' };
    }
    const parsed = new Date(nextRestricted);
    if (Number.isNaN(parsed.getTime())) {
      return { success: false, message: '貸出制限期限は日付（YYYY-MM-DD）で指定してください' };
    }
  }

  db.prepare(`
    UPDATE users SET overdue_count = ?, penalty_count = ?, restricted_until = ? WHERE row_id = ?
  `).run(nextOverdue, nextPenalty, nextRestricted, rowId);

  return { success: true, message: 'ユーザー情報を更新しました' };
}

// usersテーブルの1件を削除する(その生徒の延滞・ペナルティ履歴を
// リセットして、新規ユーザーと同じ扱いに戻す)。
function deleteUser({ rowId } = {}) {
  if (!rowId) return { success: false, message: '対象のIDが必要です' };
  const result = db.prepare('DELETE FROM users WHERE row_id = ?').run(rowId);
  if (result.changes > 0) return { success: true, message: 'ユーザー記録を削除しました' };
  return { success: false, message: '対象のユーザーが見つかりません' };
}

// 生徒本人宛メール(貸出確認・返却確認)の送信状況サマリー。
// 管理画面の「運用設定」タブで、SMTP未設定/認証エラー等に管理者が
// 気づけるようにするための参照専用関数(送信そのものはemail_queue.jsが行う)。
function getEmailQueueStatus() {
  const pending = db.prepare(`SELECT COUNT(*) c FROM email_queue WHERE sent_at = ''`).get().c;
  const sent = db.prepare(`SELECT COUNT(*) c FROM email_queue WHERE sent_at != ''`).get().c;
  const failing = db.prepare(`SELECT COUNT(*) c FROM email_queue WHERE sent_at = '' AND attempts > 0`).get().c;
  const lastError = db.prepare(`
    SELECT last_error, attempts, kind, created_at
    FROM email_queue
    WHERE sent_at = '' AND last_error != ''
    ORDER BY id DESC LIMIT 1
  `).get();
  return {
    pending,
    sent,
    failing,
    lastError: lastError ? {
      message: lastError.last_error,
      attempts: lastError.attempts,
      kind: lastError.kind,
      createdAt: lastError.created_at
    } : null
  };
}

module.exports = {
  ALL_DEVICES,
  DEFAULT_SETTINGS,
  verifyPasscodeWithLockout,
  getSettings,
  updateSettings,
  getEmailQueueStatus,
  getAvailableDevice,
  getFailedDevices,
  getLoans,
  getHistory,
  clearData,
  isBlacklisted,
  checkout,
  checkoutAuto,
  checkoutPrepare,
  checkoutCancel,
  markCheckoutUnlockAuthorized,
  checkoutCommit,
  returnVerify,
  returnComplete,
  getLoanDeadline,
  isOverdueLoan,
  getBlacklist,
  addBlacklist,
  removeBlacklist,
  getFailures,
  reportFailure,
  addFailure,
  resolveFailure,
  forceReturnLoan,
  editHistoryEntry,
  deleteHistoryEntry,
  getUsers,
  updateUser,
  deleteUser
};
