// ============================================================
// 端末貸出管理システム - Google Apps Script (GAS) 側
// ------------------------------------------------------------
// 【スプレッドシート同期(syncFromLocal)について】
// ローカルサーバー(server.js)は、貸出・返却などの実データを
// SQLiteに保存しつつ、一定間隔でこのGASへスナップショットを
// 送ってスプレッドシートをミラーする。
//
// 【認証方式：事前ペアリング】
// GASは全員アクセス可で公開されるため、最初のリクエストを信用すると
// URLを知った第三者が先にペアリングできます。ローカルのconfig.envで
// 自動生成されたSYNC_TOKENを、GASのスクリプトプロパティにも事前登録し、
// 完全一致するリクエストだけを受け入れます。
//
// 【再ペアリングが必要な場合】
// トークンを変更するときは、GASとconfig.envの両方を管理者が更新します。
// 初回リクエストによる自動ペアリングは行いません。
// ============================================================


const SS_ID         = '1-1kE9wXfBegCu-94b_xSVn_J04T1lXQ4ihMWaqZJzmE';
const SHEET_HISTORY   = '貸出記録';
const SHEET_ACTIVE    = '貸出中';
const SHEET_BLACKLIST = 'ブラックリスト';
const SHEET_USERS     = 'ユーザー管理';
const SHEET_FAILURES  = '故障一覧';

const ALL_DEVICES = [
  'CB-01','CB-02','CB-03','CB-04','CB-05',
  'CB-06','CB-07','CB-08','CB-09','CB-10',
  'CB-11','CB-12'
];

const SETTINGS_PROP_KEY = 'REMOTE_APP_SETTINGS';

// ローカルサーバー(server.js)からの要求を認証するトークン。
// 固定値や先着自動ペアリングは使わず、導入担当者がスクリプトプロパティ
// に登録した値と完全一致するリクエストだけ許可する。
const SYNC_TOKEN_PROP_KEY = 'SYNC_TOKEN';

// トークンを変更する場合は、スクリプトエディタからこの関数を実行して
// 既存値を削除し、新しい値をスクリプトプロパティへ手動登録する。
// 再登録が完了するまで、GASへの要求はすべて拒否される。
function resetSyncPairing() {
  PropertiesService.getScriptProperties().deleteProperty(SYNC_TOKEN_PROP_KEY);
}

// 共有シークレットの比較を、通常の === ではなく定数時間で行う。
// Apps ScriptにはNodeのcrypto.timingSafeEqualに相当するAPIがないため、
// 全文字をXORして差分を蓄積する方式で手動実装する。
// 長さが異なる場合も、入力側の長さ分だけは必ずループを回してから
// falseを返すことで、長さの違いが時間差として外部に漏れないようにする。
function _timingSafeStringEqual(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length === sb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < sa.length ? sa.charCodeAt(i) : 0;
    const cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// 事前設定された同期トークンと一致しない要求は全て拒否する。
function _authorizeRequest(action, params) {
  const provided = params ? params.token : null;
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty(SYNC_TOKEN_PROP_KEY);
  if (!stored) return { success: false, message: 'GAS側のSYNC_TOKENが未設定です。導入手順に従って事前登録してください' };
  return _timingSafeStringEqual(provided, stored)
    ? null
    : { success: false, message: '同期トークンが一致しません。GASとconfig.envの設定を確認してください' };
}

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
  // 返却時のログアウト確認をカメラで自動で行うかどうか。
  // ChromeOSの更新でログアウト画面の見た目が変わると機械学習による自動認識が
  // できなくなるため、管理者がオフにして手動確認方式へ切り替えられる。既定はオン。
  logoutCameraCheckEnabled: true,

  // --- 即時アラート（故障報告・ブラックリスト登録・延滞発生のたびにGmailで通知） ---
  // 既定で無効。管理者が設定画面で明示的にONにするまでメールは送信されない。
  // ONにした場合、宛先(notifyEmailAddress)を未設定のままにしておくと、
  // このGASプロジェクトのオーナー(デプロイした先生のGoogleアカウント)へ
  // 自動的に届く。個別に宛先を設定したい場合のみ入力すればよい。
  notifyEmailEnabled: false,
  notifyEmailAddress: '',
  notifyOnOverdue: true,
  notifyOnFailure: true,
  notifyOnBlacklist: true,

  // --- 先生向け定期レポート（管理者が指定した時刻に、現在の返却状況や故障台数などをまとめて送信） ---
  // 既定で無効。即時アラートと同様、宛先未設定時はGASオーナーへ自動フォールバックする。
  teacherReportEnabled: false,
  teacherReportAddress: '',
  teacherReportTimes: ['08:30', '16:30'],

  // --- 生徒本人宛の貸出・返却確認メール ---
  // 先生向けの通知とは別系統。宛先は生徒自身が入力/選択したメールアドレスのみで、
  // GASオーナーへのフォールバックは行わない(本人のアドレスが無ければ送らない)。
  // こちらも既定は無効。
  notifyUserOnCheckout: false,
  notifyUserOnReturn: false
};

const COLOR = {
  headerHistory: '#1d4ed8',  // 濃い青（貸出記録シート）
  headerActive:  '#15803d',  // 濃い緑（貸出中シート）
  headerText:    '#ffffff',  // 白文字

  rowEven:       '#f8fafc',  // ほぼ white
  rowOdd:        '#ffffff',  // white

  statusLoan:    '#dbeafe',  // 薄青（貸出中）
  statusReturn:  '#dcfce7',  // 薄緑（返却済）
  statusLoanText:   '#1e40af',
  statusReturnText: '#14532d',

  deviceBg:      '#eff6ff',
  deviceText:    '#1d4ed8',

  border:        '#e2e8f0',
  borderOuter:   '#cbd5e1',
  headerBorder:  '#1e3a8a',
};

function createJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let result;
  try {
    let action, params;
    const ct = (e.postData && e.postData.type) ? e.postData.type : '';
    if (ct.indexOf('application/json') !== -1) {
      const body = JSON.parse(e.postData.contents);
      action = body.action || e.parameter.action;
      params = body;
    } else {
      action = e.parameter.action;
      params = {};
      if (e.parameter.params) {
        try { params = JSON.parse(e.parameter.params); } catch (_) {
          return createJsonResponse({ success: false, message: 'リクエストパラメータの形式が不正です' });
        }
      }
    }
    result = _authorizeRequest(action, params) || dispatch(action, params);
  } catch (err) {
    result = { success: false, message: 'サーバーエラー: ' + err.message };
  }
  return createJsonResponse(result);
}

function doGet(e) {
  const action = e.parameter.action;

  if (!action) {
    return createJsonResponse({
      success: false,
      message: 'このURLはAPIエンドポイントです。action パラメータを指定してください。'
    });
  }

  let result;
  try {
    const params = Object.assign({}, e.parameter);
    result = _authorizeRequest(action, params) || dispatch(action, params);
  } catch (err) {
    result = { success: false, message: 'サーバーエラー: ' + err.message };
  }
  return createJsonResponse(result);
}

function dispatch(action, params) {
  switch (action) {
    case 'getLoans':           return getLoans();
    case 'getHistory':         return getHistory();
    case 'getBlacklist':       return getBlacklist();
    case 'addBlacklist':       return addBlacklist(params);
    case 'removeBlacklist':    return removeBlacklist(params);
    case 'getFailures':        return getFailures();
    case 'addFailure':         return addFailure(params);
    case 'resolveFailure':     return resolveFailure(params);
    case 'getAvailableDevice': return getAvailableDevice();
    case 'clearData':          return clearData(params);
    case 'forceReturnLoan':    return forceReturnLoan(params);
    case 'editHistoryEntry':   return editHistoryEntry(params);
    case 'deleteHistoryEntry': return deleteHistoryEntry(params);
    case 'getUsers':           return getUsers(params);
    case 'updateUser':         return updateUser(params);
    case 'deleteUser':         return deleteUser(params);
    case 'checkoutAuto':       return checkoutAuto(params);
    case 'checkoutPrepare':    return checkoutPrepare(params);
    case 'checkoutCommit':     return checkoutCommit(params);
    case 'checkout':           return checkout(params);
    case 'returnVerify':       return returnVerify(params);
    case 'returnComplete':     return returnComplete(params);
    case 'getSettings':        return getRemoteSettings(params);
    case 'updateSettings':     return updateRemoteSettings(params);
    case 'sendTestEmail':      return sendTestEmail(params);
    case 'sendUserActionEmail': return sendUserActionEmail(params);
    case 'syncFromLocal':      return syncFromLocal(params);
    default:
      return { success: false, message: '不明なアクション: ' + action };
  }
}


const PASSCODE_MAX_ATTEMPTS = 5;       // ロックアウトまでの許容失敗回数
const PASSCODE_LOCKOUT_SEC = 600;      // ロックアウト時間（秒）: 10分
const PASSCODE_ATTEMPT_KEY = 'PASSCODE_FAIL_COUNT';
const PASSCODE_LOCK_KEY = 'PASSCODE_LOCKED_UNTIL';

/**
 * パスコードを検証する。ブルートフォース対策として、一定回数連続で
 * 失敗すると一時的にロックアウトする（CacheServiceのプロセス間で共有される
 * キャッシュを用いるため、GASの複数同時実行にまたがっても機能する）。
 * 戻り値: { ok: true } または { ok: false, message: string }
 */
function verifyPasscodeWithLockout(passcode) {
  const cache = CacheService.getScriptCache();

  const lockedUntilRaw = cache.get(PASSCODE_LOCK_KEY);
  if (lockedUntilRaw) {
    const lockedUntil = parseInt(lockedUntilRaw, 10);
    const remainingSec = Math.ceil((lockedUntil - Date.now()) / 1000);
    if (remainingSec > 0) {
      const remainingMin = Math.ceil(remainingSec / 60);
      return { ok: false, message: `パスコードの試行回数上限に達しました。${remainingMin}分後に再試行してください。` };
    }
    // ロック期限切れ: カウンタをクリアして続行
    cache.remove(PASSCODE_LOCK_KEY);
    cache.remove(PASSCODE_ATTEMPT_KEY);
  }

  // サーバーから送信されたパスコードを受け入れる（サーバー側で認証済み）
  if (passcode) {
    cache.remove(PASSCODE_ATTEMPT_KEY);
    return { ok: true };
  }

  const currentCountRaw = cache.get(PASSCODE_ATTEMPT_KEY);
  const currentCount = currentCountRaw ? parseInt(currentCountRaw, 10) : 0;
  const newCount = currentCount + 1;

  if (newCount >= PASSCODE_MAX_ATTEMPTS) {
    cache.put(PASSCODE_LOCK_KEY, String(Date.now() + PASSCODE_LOCKOUT_SEC * 1000), PASSCODE_LOCKOUT_SEC);
    cache.remove(PASSCODE_ATTEMPT_KEY);
    return { ok: false, message: `パスコードの試行回数上限に達しました。${Math.ceil(PASSCODE_LOCKOUT_SEC / 60)}分後に再試行してください。` };
  }

  cache.put(PASSCODE_ATTEMPT_KEY, String(newCount), PASSCODE_LOCKOUT_SEC);
  return { ok: false, message: 'パスコードが正しくありません' };
}

function getRemoteSettings() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(SETTINGS_PROP_KEY);

  if (!raw) {
    return { success: true, settings: DEFAULT_SETTINGS, updatedAt: null, updatedBy: '' };
  }
  try {
    const wrapper = JSON.parse(raw);
    const merged = Object.assign({}, DEFAULT_SETTINGS, wrapper.settings || {});
    return { success: true, settings: merged, updatedAt: wrapper.updatedAt || null, updatedBy: wrapper.updatedBy || '' };
  } catch (e) {
    return { success: false, message: '保存済み設定の読み込みに失敗しました: ' + e.message };
  }
}

function updateRemoteSettings(params) {
  const { passcode, data, updatedBy } = params || {};

  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) {
    return { success: false, message: passcodeCheck.message };
  }
  if (!data) {
    return { success: false, message: '設定データがありません' };
  }

  let incoming;
  try {
    incoming = JSON.parse(data);
  } catch (e) {
    return { success: false, message: '設定データの形式が不正です: ' + e.message };
  }

  const props = PropertiesService.getScriptProperties();
  let current = {};
  const raw = props.getProperty(SETTINGS_PROP_KEY);
  if (raw) {
    try { current = JSON.parse(raw).settings || {}; } catch (e) { current = {}; }
  }

  const merged = Object.assign({}, DEFAULT_SETTINGS, current, incoming);

  const wrapper = {
    settings: merged,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || '(不明)'
  };

  props.setProperty(SETTINGS_PROP_KEY, JSON.stringify(wrapper));

  try {
    _syncOverdueEmailTrigger(merged);
  } catch (e) {
    console.error('[updateRemoteSettings] 延滞アラートのトリガー設定エラー: ' + e.message);
  }
  try {
    _syncTeacherReportTriggers(merged);
  } catch (e) {
    console.error('[updateRemoteSettings] 先生向けレポートのトリガー設定エラー: ' + e.message);
  }

  return { success: true, message: '設定を保存しました', updatedAt: wrapper.updatedAt, settings: merged };
}

// ============================================================
// ローカルサーバー(server.js / local-db)からのミラー同期
// ------------------------------------------------------------
// server.js 側の local-db/sync.js が、書き込み系操作の直後および
// 一定間隔ごとに、SQLite上の全データのスナップショットをまるごと
// POSTしてくる。差分計算はせず、各シートのヘッダー行を残したまま
// データ行を全て削除してから書き直す「丸ごと置き換え」方式にする
// (件数が少ない学校規模の運用では、これが最も壊れにくい)。
//
// 認証は初回ペアリング方式のトークンで行う（上部の説明を参照）。
// スクリプトプロパティに記録済みのトークンとリクエストのtokenが
// 完全一致した場合のみ書き込みを行う。
// まだ誰ともペアリングされておらず、かつトークンが送られてこなかった
// 場合は、事故防止のため常に拒否する。
//
// ロックについて: 通常運用では貸出・返却はローカルサーバー(SQLite)側で
// 完結するため、ここで取得するGASのScriptLockが生徒の操作をブロックする
// ことはない。ロックが競合しうるのは「ローカルサーバーがダウンしていて
// GASへ直接貸出リクエストが飛んでいる」という緊急フォールバック運用時
// のみで、その場合も待機は最大20秒に留めている。
// ============================================================
function syncFromLocal(params) {
  const expectedToken = PropertiesService.getScriptProperties().getProperty(SYNC_TOKEN_PROP_KEY);

  if (!expectedToken || !params || !_timingSafeStringEqual(params.token, expectedToken)) {
    return { success: false, message: '同期トークンが一致しません（ペアリングされていないか、トークンが変わっています）' };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { success: false, message: '他の同期処理が実行中のため待機がタイムアウトしました' };
  }

  try {
    const errors = [];

    try { _replaceActiveSheet(params.active || []); }
    catch (e) { errors.push('貸出中: ' + e.message); }

    try { _replaceHistorySheet(params.history || []); }
    catch (e) { errors.push('貸出記録: ' + e.message); }

    try { _replaceBlacklistSheet(params.blacklist || []); }
    catch (e) { errors.push('ブラックリスト: ' + e.message); }

    try { _replaceUsersSheet(params.users || []); }
    catch (e) { errors.push('ユーザー管理: ' + e.message); }

    try { _replaceFailuresSheet(params.failures || []); }
    catch (e) { errors.push('故障一覧: ' + e.message); }

    if (params.settings) {
      try {
        const wrapper = {
          settings: Object.assign({}, DEFAULT_SETTINGS, params.settings),
          updatedAt: new Date().toISOString(),
          updatedBy: '(ローカル端末からの同期)'
        };
        PropertiesService.getScriptProperties().setProperty(SETTINGS_PROP_KEY, JSON.stringify(wrapper));
      } catch (e) {
        errors.push('設定: ' + e.message);
      }
    }

    if (errors.length > 0) {
      return { success: false, message: '一部の同期に失敗しました: ' + errors.join(' / ') };
    }
    return { success: true, message: '同期しました', syncedAt: new Date().toISOString() };
  } finally {
    lock.releaseLock();
  }
}

// シートのヘッダー行(1行目)だけを残し、データ行を全削除する。
function _clearSheetRows(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, sh.getLastColumn() || 1).clearContent();
  }
}

function _replaceActiveSheet(rows) {
  const sh = getSheet(SHEET_ACTIVE);
  _clearSheetRows(sh);
  if (!rows.length) return;
  const values = rows.map(r => [
    r.id || '',
    sheetSafeText(r.name),
    r.email ? "'" + r.email : '',
    r.deviceId || '',
    r.dob || '',
    r.checkoutTime ? new Date(r.checkoutTime) : '',
    r.sessionId || ''
  ]);
  sh.getRange(2, 1, values.length, values[0].length).setValues(values);
  _formatActiveSheet(sh);
}

function _replaceHistorySheet(rows) {
  const sh = getSheet(SHEET_HISTORY);
  _clearSheetRows(sh);
  if (!rows.length) return;
  const values = rows.map(r => [
    r.id || '',
    sheetSafeText(r.name),
    r.email ? "'" + r.email : '',
    r.deviceId || '',
    r.dob || '',
    r.checkoutTime ? new Date(r.checkoutTime) : '',
    r.sessionId || '',
    r.returnTime ? new Date(r.returnTime) : '',
    r.status || ''
  ]);
  const requiredRows = values.length + 1;
  const currentRows = sh.getMaxRows();
  if (currentRows < requiredRows) {
    sh.insertRowsAfter(currentRows, requiredRows - currentRows);
  }
  const batchSize = 2000;
  for (let offset = 0; offset < values.length; offset += batchSize) {
    const batch = values.slice(offset, offset + batchSize);
    sh.getRange(offset + 2, 1, batch.length, values[0].length).setValues(batch);
  }
  _formatHistorySheet(sh);
}

function _replaceBlacklistSheet(rows) {
  const sh = getSheet(SHEET_BLACKLIST);
  _clearSheetRows(sh);
  if (!rows.length) return;
  const values = rows.map(r => [
    r.email ? "'" + r.email : '',
    sheetSafeText(r.name),
    r.reason || '',
    r.createdAt ? new Date(r.createdAt) : '',
    r.expiry || '',
    r.violations || 0
  ]);
  sh.getRange(2, 1, values.length, values[0].length).setValues(values);
  _formatBlacklistSheet(sh);
}

function _replaceUsersSheet(rows) {
  const sh = getSheet(SHEET_USERS);
  _clearSheetRows(sh);
  if (!rows.length) return;
  const values = rows.map(r => [
    r.email ? "'" + r.email : '',
    sheetSafeText(r.name),
    r.overdueCount || 0,
    r.penaltyCount || 0,
    r.restrictedUntil || ''
  ]);
  sh.getRange(2, 1, values.length, values[0].length).setValues(values);
  _formatUsersSheet(sh);
}

function _replaceFailuresSheet(rows) {
  const sh = getSheet(SHEET_FAILURES);
  _clearSheetRows(sh);
  if (!rows.length) return;
  const values = rows.map(r => [
    r.deviceId || '',
    r.reportedAt ? new Date(r.reportedAt) : '',
    sheetSafeText(r.name),
    r.email ? "'" + r.email : '',
    r.resolvedAt ? new Date(r.resolvedAt) : '',
    r.status || '',
    r.loanId || ''
  ]);
  sh.getRange(2, 1, values.length, values[0].length).setValues(values);
  _formatFailuresSheet(sh);
}

function _modeBlockMessage(kind) {
  const current = getRemoteSettings();
  const settings = (current && current.settings) || DEFAULT_SETTINGS;

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

function getSpreadsheet() {
  if (SS_ID) return SpreadsheetApp.openById(SS_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name) {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    console.warn('[getSheet] シートが見つからないため新規作成: ' + name);
    sh = ss.insertSheet(name);
    initSheetHeader(sh, name);
    applySheetFormat(sh, name);
  }
  return sh;
}

function initSheetHeader(sh, name) {
  if (name === SHEET_HISTORY) {
    sh.appendRow(['記録ID','名前','メールアドレス','端末番号','生年月日','貸出日時','セッションID','返却日時','状態']);
  } else if (name === SHEET_ACTIVE) {
    sh.appendRow(['記録ID','名前','メールアドレス','端末番号','生年月日','貸出日時','セッションID']);
  } else if (name === SHEET_BLACKLIST) {
    sh.appendRow(['メールアドレス','名前','理由','登録日時','解除予定日','違反歴']);
  } else if (name === SHEET_USERS) {
    sh.appendRow(['メールアドレス','名前','延滞回数','ペナルティ回数','最終ペナルティ解除日']);
  } else if (name === SHEET_FAILURES) {
    sh.appendRow(['端末番号', '報告日時', '名前', 'メールアドレス', '完了日時', '状態', '記録ID']);
  }
}

function applySheetFormat(sh, name) {
  if (name === SHEET_HISTORY) {
    _formatHistorySheet(sh);
  } else if (name === SHEET_ACTIVE) {
    _formatActiveSheet(sh);
  } else if (name === SHEET_BLACKLIST) {
    _formatBlacklistSheet(sh);
  } else if (name === SHEET_USERS) {
    _formatUsersSheet(sh);
  } else if (name === SHEET_FAILURES) {
    _formatFailuresSheet(sh);
  }
}

// ------------------------------------------------------------
// 【手動実行用】既存シートのデザイン・列幅を最新版に再適用する
// ------------------------------------------------------------
// applySheetFormat() は getSheet() がシートを「新規作成」した時にしか
// 呼ばれないため、Code.gs の列幅・配色を変更しても、既にできあがって
// いるスプレッドシート（本番で運用中のシート）には自動では反映されない。
// このスプレッドシートの見た目を最新のデザインに更新したい場合は、
// スクリプトエディタの関数選択プルダウンから rebuildAllSheetFormats を
// 選び、実行ボタンを押すこと（データ自体は一切変更・削除されない。
// 書式・列幅・行の高さ・ヘッダー配色などの見た目だけが更新される）。
function rebuildAllSheetFormats() {
  const targets = [
    SHEET_HISTORY,
    SHEET_ACTIVE,
    SHEET_BLACKLIST,
    SHEET_USERS,
    SHEET_FAILURES,
  ];

  targets.forEach(name => {
    const sh = getSheet(name); // 既存シートを取得（無ければヘッダー付きで新規作成）
    applySheetFormat(sh, name);
  });

  SpreadsheetApp.flush();
  console.log('全シートのデザイン・列幅を最新の設定で再適用しました。');
}

// 記録ID・セッションID・メールアドレスは、生成規則(UUIDの桁数、メール
// ドメインの長さ)が変わっても常に1行で全文が読める幅を保つため、固定幅
// ではなく実際のセル内容に合わせて自動調整する。ただしヘッダーだけで
// データ行が無い（初回作成直後など）場合に幅が縮みすぎないよう、
// colWidths側で設定した値を下限としても使う。
function _autoResizeColumnsMinWidth(sh, cols, minWidth) {
  cols.forEach(col => {
    try {
      sh.autoResizeColumn(col);
      if (sh.getColumnWidth(col) < minWidth) {
        sh.setColumnWidth(col, minWidth);
      }
    } catch (e) {
      // 万一自動調整に失敗しても、colWidthsで設定済みの固定幅のまま
      // 書式適用処理全体を止めないようにする。
    }
  });
}

// ------------------------------------------------------------
// 【共通ヘルパー】罫線・フィルタ・保護・入力規則・見出し注記
// ------------------------------------------------------------
// 各シートの _format*Sheet() 関数から呼び出す共通パーツ。
// setHiddenGridlines(true) と組み合わせることで、スプレッドシート
// 既定の薄いグレー罫線ではなく、意図して引いた罫線だけが見える
// 「デザインされた表」の見た目になる。
function _applyTableBorders(sh, totalCols, dataRowCount) {
  const totalRows = 1 + Math.max(dataRowCount, 1);
  const range = sh.getRange(1, 1, totalRows, totalCols);

  // 外枠は太め、内側の縦線・横線は薄めにして情報の主従を分ける。
  range.setBorder(true, true, true, true, true, true,
                   COLOR.border, SpreadsheetApp.BorderStyle.SOLID);
  range.setBorder(true, true, true, true, null, null,
                   COLOR.borderOuter, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // ヘッダー行の下側だけは、本文との境界がひと目でわかるよう強調する。
  sh.getRange(1, 1, 1, totalCols)
    .setBorder(null, null, true, null, null, null,
               COLOR.headerBorder, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

// 既存のベーシックフィルタを一度外してから同じ範囲に張り直す。
// rebuildAllSheetFormats() を何度実行してもエラーにならないようにするため。
function _setupBasicFilter(sh, totalCols) {
  const existing = sh.getFilter();
  if (existing) existing.remove();
  const rows = Math.max(sh.getMaxRows(), 2);
  sh.getRange(1, 1, rows, totalCols).createFilter();
}

// ヘッダー行を「警告つきで保護」する。スクリプト(このGAS自身)からの
// 書き込みは常に許可されるため同期処理には一切影響しない。手作業で
// ヘッダーを誤って書き換えそうになった時にだけ、担当の先生に警告を
// 表示して一呼吸置いてもらうためのもの。
function _protectHeaderRow(sh, totalCols) {
  const existing = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  existing.forEach(p => { if (p.getDescription() === 'HEADER_ROW_GUARD') p.remove(); });

  const protection = sh.getRange(1, 1, 1, totalCols).protect();
  protection.setDescription('HEADER_ROW_GUARD');
  protection.setWarningOnly(true); // ブロックはせず、警告ダイアログのみ表示
}

// 状態列などをドロップダウン選択式にし、手入力による表記ゆれ
// （例:「返却済み」「返却済 」など）を防いで集計・条件付き書式が
// 常に正しく機能するようにする。
function _setStatusValidation(sh, col, values) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(false)
    .setHelpText('次のいずれかを選択してください: ' + values.join(' / '))
    .build();
  sh.getRange(2, col, Math.max(sh.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

// 内部的な列（記録ID・セッションIDなど）のヘッダーに注記を付け、
// 見慣れない担当者でも役割と「手で編集しない方がよい列」がひと目で
// わかるようにする（セルにマウスを乗せると表示される）。
function _setHeaderNote(sh, col, note) {
  sh.getRange(1, col).setNote(note);
}

function _formatHistorySheet(sh) {
  const totalCols = 9;
  const usedRows = Math.max(1, sh.getLastRow());

  const hdr = sh.getRange(1, 1, 1, totalCols);
  hdr.setBackground(COLOR.headerHistory)
     .setFontColor(COLOR.headerText)
     .setFontWeight('bold')
     .setFontSize(11)
     .setHorizontalAlignment('center')
     .setVerticalAlignment('middle')
     .setBorder(true, true, true, true, false, false,
                COLOR.headerBorder, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.setRowHeight(1, 40);

  // 記録ID・セッションIDはともにUUID（例: 550e8400-e29b-41d4-a716-446655440000,
  // 36文字）、メールアドレスは学校のメール規則（ドメインを含めて30文字台後半に
  // なることがある）が、途中で切れずに1行で表示できる幅を確保する。
  // この固定値はデータが無い（シート作成直後）場合の最低幅として使われ、
  // 実際のデータ投入後は _autoResizeColumnsMinWidth() が内容に合わせて
  // 自動的に幅を広げる（メールドメインの変更などにも追従できる）。
  const colWidths = [250, 150, 300, 100, 110, 160, 250, 160, 110];
  colWidths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  _autoResizeColumnsMinWidth(sh, [1, 7], 250);  // 記録ID・セッションID
  _autoResizeColumnsMinWidth(sh, [3], 300);     // メールアドレス
  sh.getRange(1, 1, usedRows, 1).setHorizontalAlignment('left');   // 記録ID
  sh.getRange(1, 2, usedRows, 1).setHorizontalAlignment('left');   // 名前
  sh.getRange(1, 3, usedRows, 1).setHorizontalAlignment('left')
                                       .setNumberFormat('@');           // メールアドレス（文字列として保持）
  sh.getRange(1, 4, usedRows, 1).setHorizontalAlignment('center'); // 端末番号
  sh.getRange(1, 5, usedRows, 1).setHorizontalAlignment('center'); // 生年月日
  sh.getRange(1, 6, usedRows, 1).setHorizontalAlignment('center'); // 貸出日時
  sh.getRange(1, 7, usedRows, 1).setHorizontalAlignment('left');   // セッションID
  sh.getRange(1, 8, usedRows, 1).setHorizontalAlignment('center'); // 返却日時
  sh.getRange(1, 9, usedRows, 1).setHorizontalAlignment('center'); // 状態

  if (usedRows > 1) {
    sh.getRange(2, 6, usedRows - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');
    sh.getRange(2, 8, usedRows - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');
  }

  sh.setFrozenRows(1);
  sh.setFrozenColumns(2); // 記録ID・名前は横スクロールしても常に見える

  sh.getRange(1, 1, usedRows, totalCols)
    .setFontFamily('Noto Sans JP, Arial, sans-serif')
    .setFontSize(11)
    .setVerticalAlignment('middle');

  if (usedRows > 1) {
    sh.setRowHeightsForced(2, usedRows - 1, 34);
  }

  sh.setHiddenGridlines(true);
  _applyTableBorders(sh, totalCols, usedRows - 1);
  _setupBasicFilter(sh, totalCols);
  _protectHeaderRow(sh, totalCols);
  _setStatusValidation(sh, 9, ['貸出中', '返却済']);
  _setHeaderNote(sh, 1, 'システムが自動採番する内部ID。手動で編集・削除しないでください。');
  _setHeaderNote(sh, 7, '貸出セッションを識別する内部ID。手動で編集しないでください。');
  sh.setTabColor(COLOR.headerHistory);

  _refreshHistoryRowStyles(sh);
}

function _formatBlacklistSheet(sh) {
  const totalCols = 6;
  const tabColor = '#991b1b'; // 濃い赤

  const hdr = sh.getRange(1, 1, 1, totalCols);
  hdr.setBackground(tabColor)
     .setFontColor(COLOR.headerText)
     .setFontWeight('bold')
     .setFontSize(11)
     .setHorizontalAlignment('center')
     .setVerticalAlignment('middle')
     .setBorder(true, true, true, true, false, false,
                '#7f1d1d', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.setRowHeight(1, 40);

  // メールアドレスはドメインを含めて長くなりうるため、実際の内容に合わせて自動調整する。
  const colWidths = [300, 150, 340, 165, 140, 110];
  colWidths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  _autoResizeColumnsMinWidth(sh, [1], 300); // メールアドレス
  sh.getRange(1, 1, sh.getMaxRows(), 1).setHorizontalAlignment('left')
                                       .setNumberFormat('@');           // メールアドレス（文字列として保持）
  sh.getRange(1, 2, sh.getMaxRows(), 1).setHorizontalAlignment('left');
  sh.getRange(1, 3, sh.getMaxRows(), 1).setHorizontalAlignment('left')
                                       .setWrap(true);                 // 理由（長文でも折り返して全文表示）
  sh.getRange(1, 4, sh.getMaxRows(), 1).setHorizontalAlignment('center');
  sh.getRange(1, 5, sh.getMaxRows(), 1).setHorizontalAlignment('center');
  sh.getRange(1, 6, sh.getMaxRows(), 1).setHorizontalAlignment('center');

  sh.getRange(2, 4, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');
  sh.getRange(2, 5, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy/MM/dd');

  sh.setFrozenRows(1);
  sh.setFrozenColumns(1); // メールアドレスは横スクロールしても常に見える

  sh.getRange(1, 1, sh.getMaxRows(), totalCols)
    .setFontFamily('Noto Sans JP, Arial, sans-serif')
    .setFontSize(11)
    .setVerticalAlignment('middle');

  if (sh.getMaxRows() > 1) {
    sh.setRowHeightsForced(2, sh.getMaxRows() - 1, 34);
  }

  sh.setHiddenGridlines(true);
  _applyTableBorders(sh, totalCols, sh.getMaxRows() - 1);
  _setupBasicFilter(sh, totalCols);
  _protectHeaderRow(sh, totalCols);
  _setHeaderNote(sh, 1, '生徒を一意に識別するメールアドレス（キー列）。');
  sh.setTabColor(tabColor);

  _refreshBlacklistRowStyles(sh);
}

function _refreshBlacklistRowStyles(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  for (let i = 0; i < lastRow - 1; i++) {
    const row    = i + 2;
    const isEven = (i % 2 === 0);
    const rowBg  = isEven ? COLOR.rowEven : COLOR.rowOdd;
    sh.getRange(row, 1, 1, 6).setBackground(rowBg);
  }
}

function _formatUsersSheet(sh) {
  const totalCols = 5;
  const tabColor = '#334155';

  const hdr = sh.getRange(1, 1, 1, totalCols);
  hdr.setBackground(tabColor)
     .setFontColor(COLOR.headerText)
     .setFontWeight('bold')
     .setFontSize(11)
     .setHorizontalAlignment('center')
     .setVerticalAlignment('middle')
     .setBorder(true, true, true, true, false, false,
                '#0f172a', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.setRowHeight(1, 40);

  // 「最終ペナルティ解除日」「ペナルティ回数」まで含めて、ヘッダー文字列が
  // 折り返さずに収まる幅を確保する。メールアドレスは実際の内容に合わせて自動調整する。
  const colWidths = [300, 150, 110, 150, 190];
  colWidths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  _autoResizeColumnsMinWidth(sh, [1], 300); // メールアドレス

  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@').setHorizontalAlignment('left'); // メールアドレス
  sh.getRange(1, 2, sh.getMaxRows(), 1).setHorizontalAlignment('left');                       // 名前
  sh.getRange(1, 3, sh.getMaxRows(), 2).setHorizontalAlignment('center');                     // 延滞回数・ペナルティ回数
  sh.getRange(1, 5, sh.getMaxRows(), 1).setHorizontalAlignment('center');                     // 最終ペナルティ解除日
  sh.getRange(2, 5, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy/MM/dd'); // 時刻に意味は無いため日付のみ表示

  sh.setFrozenRows(1);
  sh.setFrozenColumns(1); // メールアドレスは横スクロールしても常に見える

  sh.getRange(1, 1, sh.getMaxRows(), totalCols)
    .setFontFamily('Noto Sans JP, Arial, sans-serif')
    .setFontSize(11)
    .setVerticalAlignment('middle');

  if (sh.getMaxRows() > 1) {
    sh.setRowHeightsForced(2, sh.getMaxRows() - 1, 34);
  }

  sh.setHiddenGridlines(true);
  _applyTableBorders(sh, totalCols, sh.getMaxRows() - 1);
  _setupBasicFilter(sh, totalCols);
  _protectHeaderRow(sh, totalCols);
  _setHeaderNote(sh, 1, '生徒を一意に識別するメールアドレス（キー列）。');
  sh.setTabColor(tabColor);

  _refreshUsersRowStyles(sh);
}

function _refreshUsersRowStyles(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  for (let i = 0; i < lastRow - 1; i++) {
    const row    = i + 2;
    const isEven = (i % 2 === 0);
    const rowBg  = isEven ? COLOR.rowEven : COLOR.rowOdd;
    sh.getRange(row, 1, 1, 5).setBackground(rowBg);
  }
}

function _formatFailuresSheet(sh) {
  const totalCols = 7;
  const tabColor = '#7c2d12'; // 濃いオレンジ/茶色

  const hdr = sh.getRange(1, 1, 1, totalCols);
  hdr.setBackground(tabColor)
     .setFontColor(COLOR.headerText)
     .setFontWeight('bold')
     .setFontSize(11)
     .setHorizontalAlignment('center')
     .setVerticalAlignment('middle')
     .setBorder(true, true, true, true, false, false,
                '#431407', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.setRowHeight(1, 40);

  // 記録ID列はUUID（36文字）が1行で収まる幅を確保する。メールアドレス・記録IDは
  // 実際の内容に合わせて自動調整する。
  const colWidths = [110, 170, 150, 300, 170, 120, 250];
  colWidths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  _autoResizeColumnsMinWidth(sh, [7], 250);  // 記録ID
  _autoResizeColumnsMinWidth(sh, [4], 300);  // メールアドレス

  sh.getRange(1, 1, sh.getMaxRows(), 1).setHorizontalAlignment('center'); // 端末番号
  sh.getRange(1, 2, sh.getMaxRows(), 1).setHorizontalAlignment('center'); // 報告日時
  sh.getRange(1, 3, sh.getMaxRows(), 1).setHorizontalAlignment('left');   // 名前
  sh.getRange(1, 4, sh.getMaxRows(), 1).setNumberFormat('@').setHorizontalAlignment('left'); // メールアドレス
  sh.getRange(1, 5, sh.getMaxRows(), 2).setHorizontalAlignment('center'); // 完了日時・状態
  sh.getRange(1, 7, sh.getMaxRows(), 1).setHorizontalAlignment('left');   // 記録ID

  sh.getRange(2, 2, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');
  sh.getRange(2, 5, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');

  sh.setFrozenRows(1);
  sh.setFrozenColumns(1); // 端末番号は横スクロールしても常に見える

  sh.getRange(1, 1, sh.getMaxRows(), totalCols)
    .setFontFamily('Noto Sans JP, Arial, sans-serif')
    .setFontSize(11)
    .setVerticalAlignment('middle');

  if (sh.getMaxRows() > 1) {
    sh.setRowHeightsForced(2, sh.getMaxRows() - 1, 34);
  }

  sh.setHiddenGridlines(true);
  _applyTableBorders(sh, totalCols, sh.getMaxRows() - 1);
  _setupBasicFilter(sh, totalCols);
  _protectHeaderRow(sh, totalCols);
  _setStatusValidation(sh, 6, ['故障中', '返却済']);
  _setHeaderNote(sh, 7, 'この故障に紐づく貸出記録の内部ID。手動で編集しないでください。');
  sh.setTabColor(tabColor);

  _refreshFailuresRowStyles(sh);
}

function _refreshFailuresRowStyles(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const dataRange = sh.getRange(2, 1, lastRow - 1, 7);
  const values    = dataRange.getValues();

  for (let i = 0; i < values.length; i++) {
    const row    = i + 2;
    const isEven = (i % 2 === 0);
    const rowBg  = isEven ? COLOR.rowEven : COLOR.rowOdd;
    const status = String(values[i][5]);

    sh.getRange(row, 1, 1, 7).setBackground(rowBg);
    
    const statusCell = sh.getRange(row, 6);
    if (status === '故障中') {
      statusCell.setBackground('#fee2e2').setFontColor('#991b1b').setFontWeight('bold');
    } else {
      statusCell.setBackground(COLOR.statusReturn).setFontColor(COLOR.statusReturnText).setFontWeight('bold');
    }
  }
}

function _formatActiveSheet(sh) {
  const totalCols = 7;

  const hdr = sh.getRange(1, 1, 1, totalCols);
  hdr.setBackground(COLOR.headerActive)
     .setFontColor(COLOR.headerText)
     .setFontWeight('bold')
     .setFontSize(11)
     .setHorizontalAlignment('center')
     .setVerticalAlignment('middle')
     .setBorder(true, true, true, true, false, false,
                '#14532d', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.setRowHeight(1, 40);

  // 記録ID・セッションIDはUUID（36文字）が1行で収まる幅を、貸出記録シートと同じ基準で確保する。
  // メールアドレスもドメインを含めて長くなりうるため、実際の内容に合わせて自動調整する。
  const colWidths = [250, 150, 300, 100, 110, 160, 250];
  colWidths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  _autoResizeColumnsMinWidth(sh, [1, 7], 250);  // 記録ID・セッションID
  _autoResizeColumnsMinWidth(sh, [3], 300);     // メールアドレス
  sh.getRange(1, 1, sh.getMaxRows(), 1).setHorizontalAlignment('left');
  sh.getRange(1, 2, sh.getMaxRows(), 1).setHorizontalAlignment('left');
  sh.getRange(1, 3, sh.getMaxRows(), 1).setHorizontalAlignment('left')
                                       .setNumberFormat('@');           // メールアドレス（文字列として保持）
  sh.getRange(1, 4, sh.getMaxRows(), 1).setHorizontalAlignment('center');
  sh.getRange(1, 5, sh.getMaxRows(), 1).setHorizontalAlignment('center');
  sh.getRange(1, 6, sh.getMaxRows(), 1).setHorizontalAlignment('center');
  sh.getRange(1, 7, sh.getMaxRows(), 1).setHorizontalAlignment('left');

  sh.getRange(2, 6, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');

  sh.setFrozenRows(1);
  sh.setFrozenColumns(2); // 記録ID・名前は横スクロールしても常に見える

  // 日本語の名前が正しく表示されるよう、貸出記録シートと同じフォントに統一
  // （旧設定の 'Arial, sans-serif' 単独指定だと和文フォールバックが
  // シートごとに変わり、デザインが不統一になっていた）。
  sh.getRange(1, 1, sh.getMaxRows(), totalCols)
    .setFontFamily('Noto Sans JP, Arial, sans-serif')
    .setFontSize(11)
    .setVerticalAlignment('middle');

  if (sh.getMaxRows() > 1) {
    sh.setRowHeightsForced(2, sh.getMaxRows() - 1, 34);
  }

  sh.setHiddenGridlines(true);
  _applyTableBorders(sh, totalCols, sh.getMaxRows() - 1);
  _setupBasicFilter(sh, totalCols);
  _protectHeaderRow(sh, totalCols);
  _setHeaderNote(sh, 1, 'システムが自動採番する内部ID。手動で編集・削除しないでください。');
  _setHeaderNote(sh, 7, '貸出セッションを識別する内部ID。手動で編集しないでください。');
  sh.setTabColor(COLOR.headerActive);

  _refreshActiveRowStyles(sh);
}

function _refreshHistoryRowStyles(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const dataRange = sh.getRange(2, 1, lastRow - 1, 9);
  const values    = dataRange.getValues();

  for (let i = 0; i < values.length; i++) {
    const row     = i + 2;
    const status  = String(values[i][8]); // I列「状態」
    const isEven  = (i % 2 === 0);
    const rowBg   = isEven ? COLOR.rowEven : COLOR.rowOdd;

    sh.getRange(row, 1, 1, 9).setBackground(rowBg);

    sh.getRange(row, 4)
      .setBackground(COLOR.deviceBg)
      .setFontColor(COLOR.deviceText)
      .setFontWeight('bold');

    const statusCell = sh.getRange(row, 9);
    if (status === '返却済') {
      statusCell
        .setBackground(COLOR.statusReturn)
        .setFontColor(COLOR.statusReturnText)
        .setFontWeight('bold');
    } else {
      statusCell
        .setBackground(COLOR.statusLoan)
        .setFontColor(COLOR.statusLoanText)
        .setFontWeight('bold');
    }

    sh.getRange(row, 1, 1, 9)
      .setBorder(false, false, true, false, false, false,
                 COLOR.border, SpreadsheetApp.BorderStyle.SOLID);
  }
}

function _refreshActiveRowStyles(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  for (let i = 0; i < lastRow - 1; i++) {
    const row    = i + 2;
    const isEven = (i % 2 === 0);
    const rowBg  = isEven ? COLOR.rowEven : COLOR.rowOdd;

    sh.getRange(row, 1, 1, 7).setBackground(rowBg);

    sh.getRange(row, 4)
      .setBackground(COLOR.deviceBg)
      .setFontColor(COLOR.deviceText)
      .setFontWeight('bold');

    sh.getRange(row, 1, 1, 7)
      .setBorder(false, false, true, false, false, false,
                 COLOR.border, SpreadsheetApp.BorderStyle.SOLID);
  }
}

function getFailedDevices() {
  const sh = getSheet(SHEET_FAILURES);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return new Set();
  
  const rows = sh.getRange(2, 1, lastRow - 1, 6).getValues();
  const failedSet = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][5] === '故障中') {
      failedSet.add(String(rows[i][0]));
    }
  }
  return failedSet;
}

function getAvailableDevice() {
  const sh = getSheet(SHEET_ACTIVE);
  const rows = sh.getDataRange().getValues();

  const usedSet = new Set();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][3]) usedSet.add(String(rows[i][3]));
  }
  
  const failedSet = getFailedDevices();

  const freeDevices = ALL_DEVICES.filter(d => !usedSet.has(d) && !failedSet.has(d));

  if (freeDevices.length === 0) {
    return { success: false, message: '空き端末がありません' };
  }

  return { success: true, deviceId: freeDevices[0] };
}

function getLoans() {
  _sweepStalePreparations();
  const sh = getSheet(SHEET_ACTIVE);
  const rows = sh.getDataRange().getValues();
  if (rows.length <= 1) return { success: true, loans: [] };

  const loans = rows.slice(1)
    .filter(r => r[0]) // IDがない行（空行）をスキップ
    .map(r => ({
      id:           String(r[0]),
      name:         r[1],
      email:        normalizeEmail(r[2]),
      deviceId:     r[3],
      checkoutTime: r[5] ? new Date(r[5]).toISOString() : '',
      sessionId:    String(r[6] || ''),
    }));

  return { success: true, loans };
}

function getHistory() {
  const sh = getSheet(SHEET_HISTORY);
  const rows = sh.getDataRange().getValues();
  if (rows.length <= 1) return { success: true, history: [] };

  const history = rows.slice(1)
    .filter(r => r[0])
    .reverse() // 新しい順
    .map(r => ({
      id:           String(r[0]),
      name:         r[1],
      email:        normalizeEmail(r[2]),
      deviceId:     r[3],
      dob:          r[4],
      checkoutTime: r[5] ? new Date(r[5]).toISOString() : '',
      sessionId:    String(r[6] || ''),
      returnTime:   r[7] ? new Date(r[7]).toISOString() : '',
      status:       r[8]
    }));

  return { success: true, history };
}

function clearData(params) {
  const { passcode, target } = params;
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) {
    return { success: false, message: passcodeCheck.message };
  }
  let sh;
  if (target === 'active') {
    sh = getSheet(SHEET_ACTIVE);
  } else if (target === 'history') {
    sh = getSheet(SHEET_HISTORY);
  } else {
    return { success: false, message: '無効なターゲットです' };
  }

  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.deleteRows(2, lastRow - 1);
  }
  return { success: true, message: 'データを初期化しました' };
}

// ============================================================
// 管理者による個別データ操作(GAS側フォールバック版)
// ------------------------------------------------------------
// server.js(ローカルサーバー)が起動している通常運用では、これらの
// 操作は local-db/lending.js の同名関数(forceReturnLoan等)が
// 使われる。ここにあるのは、ローカルサーバーがダウンしている間の
// 緊急メンテナンス用のフォールバックで、普段は使われない。
// いずれもパスコード確認(verifyPasscodeWithLockout)を必須とする。
// ============================================================

// 貸出中の1件を、生徒本人の操作を経ずに強制的に返却済みにする。
function forceReturnLoan(params) {
  const { passcode, id } = params;
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) return { success: false, message: passcodeCheck.message };
  if (!id) return { success: false, message: '記録IDが必要です' };

  const activeSh = getSheet(SHEET_ACTIVE);
  const activeRows = activeSh.getDataRange().getValues();
  let targetRow = -1;
  let loan = null;
  for (let i = 1; i < activeRows.length; i++) {
    if (String(activeRows[i][0]) === String(id)) {
      targetRow = i + 1;
      loan = { deviceId: activeRows[i][3], name: activeRows[i][1] };
      break;
    }
  }
  if (targetRow === -1) {
    return { success: false, message: '対象の貸出記録が見つかりません(既に返却済みの可能性があります)' };
  }

  const histSh = getSheet(SHEET_HISTORY);
  const histRows = histSh.getDataRange().getValues();
  for (let i = 1; i < histRows.length; i++) {
    if (String(histRows[i][0]) === String(id)) {
      histSh.getRange(i + 1, 8).setValue(new Date());               // 返却日時
      histSh.getRange(i + 1, 9).setValue('返却済(管理者による強制返却)'); // 状態
      break;
    }
  }

  activeSh.deleteRow(targetRow);
  return { success: true, message: `${loan.deviceId}(${loan.name})を強制的に返却済みにしました` };
}

// 履歴を1件だけ訂正する。渡されたフィールドだけを更新する。
function editHistoryEntry(params) {
  const { passcode, id, name, email, deviceId, checkoutTime, returnTime, status } = params;
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) return { success: false, message: passcodeCheck.message };
  if (!id) return { success: false, message: '記録IDが必要です' };

  const sh = getSheet(SHEET_HISTORY);
  const rows = sh.getDataRange().getValues();
  let targetRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { targetRow = i + 1; break; }
  }
  if (targetRow === -1) return { success: false, message: '対象の履歴が見つかりません' };

  if (name !== undefined && String(name).trim()) sh.getRange(targetRow, 2).setValue(String(name).trim());
  if (email !== undefined) sh.getRange(targetRow, 3).setValue(normalizeEmail(email));
  if (deviceId !== undefined && String(deviceId).trim()) sh.getRange(targetRow, 4).setValue(String(deviceId).trim());
  if (checkoutTime !== undefined) {
    const d = new Date(checkoutTime);
    if (!isNaN(d)) sh.getRange(targetRow, 6).setValue(d);
  }
  if (returnTime !== undefined) {
    sh.getRange(targetRow, 8).setValue(returnTime ? new Date(returnTime) : '');
  }
  if (status !== undefined && String(status).trim()) sh.getRange(targetRow, 9).setValue(String(status).trim());

  return { success: true, message: '履歴を更新しました' };
}

// 履歴を1件だけ削除する。
function deleteHistoryEntry(params) {
  const { passcode, id } = params;
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) return { success: false, message: passcodeCheck.message };
  if (!id) return { success: false, message: '記録IDが必要です' };

  const sh = getSheet(SHEET_HISTORY);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sh.deleteRow(i + 1);
      return { success: true, message: '履歴を削除しました' };
    }
  }
  return { success: false, message: '対象の履歴が見つかりません' };
}

// usersシート(延滞回数・ペナルティ回数)の一覧取得。
function getUsers(params) {
  const passcodeCheck = verifyPasscodeWithLockout(params && params.passcode);
  if (!passcodeCheck.ok) return { success: false, message: passcodeCheck.message };

  const sh = getSheet(SHEET_USERS);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return { success: true, users: [] };

  const rows = sh.getRange(2, 1, lastRow - 1, 5).getValues();
  const users = rows.map((r, i) => ({
    rowId: i + 2, // シート上の行番号をIDとして扱う(GAS版フォールバックのみで使用)
    email: normalizeEmail(r[0]),
    name: r[1],
    overdueCount: r[2] || 0,
    penaltyCount: r[3] || 0,
    restrictedUntil: r[4] || ''
  }));
  return { success: true, users };
}

// usersシートの1件を編集する(rowIdはシート上の行番号)。
function updateUser(params) {
  const { passcode, rowId, overdueCount, penaltyCount, restrictedUntil } = params;
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) return { success: false, message: passcodeCheck.message };
  if (!rowId) return { success: false, message: '対象のIDが必要です' };

  const sh = getSheet(SHEET_USERS);
  const row = Number(rowId);
  if (row < 2 || row > sh.getLastRow()) return { success: false, message: '対象のユーザーが見つかりません' };

  if (overdueCount !== undefined) sh.getRange(row, 3).setValue(Math.max(0, parseInt(overdueCount, 10) || 0));
  if (penaltyCount !== undefined) sh.getRange(row, 4).setValue(Math.max(0, parseInt(penaltyCount, 10) || 0));
  if (restrictedUntil !== undefined) sh.getRange(row, 5).setValue(String(restrictedUntil).trim());

  return { success: true, message: 'ユーザー情報を更新しました' };
}

// usersシートの1件を削除する(rowIdはシート上の行番号)。
function deleteUser(params) {
  const { passcode, rowId } = params;
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) return { success: false, message: passcodeCheck.message };
  if (!rowId) return { success: false, message: '対象のIDが必要です' };

  const sh = getSheet(SHEET_USERS);
  const row = Number(rowId);
  if (row < 2 || row > sh.getLastRow()) return { success: false, message: '対象のユーザーが見つかりません' };

  sh.deleteRow(row);
  return { success: true, message: 'ユーザー記録を削除しました' };
}

function isBlacklisted(name, email) {
  const sh = getSheet(SHEET_BLACKLIST);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return null;
  
  const rows = sh.getRange(2, 1, lastRow - 1, 6).getValues();
  const now = new Date();
  let foundReason = null;
  const rowsToDelete = [];

  const nName = normalizeName(name);

  for (let i = 0; i < rows.length; i++) {
    const bEmail = normalizeEmail(rows[i][0]);
    const bName = normalizeName(rows[i][1]);
    const expiry = rows[i][4];
    const rowNum = i + 2;

    if (expiry && expiry instanceof Date && expiry < now) {
      rowsToDelete.push(rowNum);
      continue;
    }

    if (foundReason === null) {
      let match = false;
      if (email && bEmail && normalizeEmail(email) === bEmail) match = true;
      if (!match && !email && !bEmail && nName && bName && nName === bName) match = true;

      if (match) {
        let msg = 'あなたは現在、端末の貸出が制限されています。';
        if (expiry && expiry instanceof Date) {
          msg += `（制限解除予定日: ${Utilities.formatDate(expiry, "GMT+9", "yyyy/MM/dd")}）`;
        } else if (expiry === 'PERMANENT') {
          msg += `（無期限の制限）`;
        }
        foundReason = msg;
      }
    }
  }

  for (let i = rowsToDelete.length - 1; i >= 0; i--) {
    sh.deleteRow(rowsToDelete[i]);
  }
  if (rowsToDelete.length > 0) {
    _refreshBlacklistRowStyles(sh);
  }

  return foundReason;
}

function _sweepStalePreparations() {
  const STALE_MINUTES = 30;
  try {
    const activeSh = getSheet(SHEET_ACTIVE);
    const activeRows = activeSh.getDataRange().getValues();
    if (activeRows.length <= 1) return;

    const histSh = getSheet(SHEET_HISTORY);
    const histRows = histSh.getDataRange().getValues();
    const histIds = new Set();
    for (let i = 1; i < histRows.length; i++) {
      if (histRows[i][0]) histIds.add(String(histRows[i][0]));
    }

    const now = new Date();
    const rowsToDelete = [];
    for (let i = activeRows.length - 1; i >= 1; i--) {
      const rowId = String(activeRows[i][0] || '');
      if (!rowId) continue;
      if (histIds.has(rowId)) continue;
      const checkoutTime = activeRows[i][5];
      if (!checkoutTime) continue;
      const diff = (now.getTime() - new Date(checkoutTime).getTime()) / 60000;
      if (diff >= STALE_MINUTES) {
        rowsToDelete.push(i + 1);
      }
    }

    for (let j = rowsToDelete.length - 1; j >= 0; j--) {
      activeSh.deleteRow(rowsToDelete[j]);
    }
    if (rowsToDelete.length > 0) {
      console.log('[Sweep] 期限切れの予約を %s 件削除しました', rowsToDelete.length);
      _refreshActiveRowStyles(activeSh);
    }
  } catch (e) {
    console.error('[Sweep] 期限切れ予約の掃除中にエラー: ' + e.message);
  }
}

function checkout(params) {
  _sweepStalePreparations();

  const blockMsg = _modeBlockMessage('checkout');
  if (blockMsg) return { success: false, message: blockMsg };

  const { name, email, dob, deviceId, sessionId } = params;

  if ((!name && !email) || !deviceId) {
    return { success: false, message: '名前またはメールアドレスが必要です' };
  }
  if (!ALL_DEVICES.includes(deviceId)) {
    return { success: false, message: '端末番号が不正です: ' + deviceId };
  }

  const blacklistReason = isBlacklisted(name, email);
  if (blacklistReason) {
    return {
      success: false,
      message: '【貸出制限】' + blacklistReason + '\n詳細は管理者に確認してください。'
    };
  }

  const failedSet = getFailedDevices();
  if (failedSet.has(deviceId)) {
    return {
      success: false,
      message: 'その端末は現在故障中のため貸出できません。他の端末を選択してください。'
    };
  }

  const normalizedDob = dob ? normalizeDob(dob) : '';

  // checkoutPrepare / checkoutAuto と同様にロックを取得し、同一端末が二重に
  // 貸出登録される競合状態（レースコンディション）を防ぐ。
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { success: false, message: 'サーバーが混雑しています。しばらくしてからもう一度お試しください' };
  }

  try {
    const activeSheet = getSheet(SHEET_ACTIVE);
    const activeRows  = activeSheet.getDataRange().getValues();
    const nName = normalizeName(name);

    for (let i = 1; i < activeRows.length; i++) {
      const existingName = normalizeName(activeRows[i][1]);
      const existingEmail = normalizeEmail(activeRows[i][2]);

      if (email && existingEmail === normalizeEmail(email)) {
        return {
          success: false,
          message: 'あなたはすでに端末を借りています（端末: ' + activeRows[i][3] + '）。1人1台までです。'
        };
      }
      if (!email && !existingEmail && nName && existingName === nName) {
        return {
          success: false,
          message: 'あなたはすでに端末を借りています（端末: ' + activeRows[i][3] + '）。1人1台までです。'
        };
      }

      if (activeRows[i][3] === deviceId) {
        return {
          success: false,
          message: 'その端末は現在使用中です。再度「貸出」から操作してください。'
        };
      }
    }

    const now = new Date();
    const id  = Utilities.getUuid();
    const sId = sessionId || '';

    try {
      const activeSh = getSheet(SHEET_ACTIVE);
      activeSh.appendRow([id, sheetSafeText(name), email ? "'" + email : "", deviceId, normalizedDob, now, sId]);
      const activeLastRow = activeSh.getLastRow();
      const isEvenA       = (activeLastRow % 2 === 0);
      activeSh.getRange(activeLastRow, 1, 1, 7)
        .setBackground(isEvenA ? COLOR.rowEven : COLOR.rowOdd)
        .setVerticalAlignment('middle')
        .setBorder(false, false, true, false, false, false,
                   COLOR.border, SpreadsheetApp.BorderStyle.SOLID);
      activeSh.getRange(activeLastRow, 4)
        .setBackground(COLOR.deviceBg)
        .setFontColor(COLOR.deviceText)
        .setFontWeight('bold');
      activeSh.setRowHeight(activeLastRow, 32);

      const histSh = getSheet(SHEET_HISTORY);
      histSh.appendRow([id, sheetSafeText(name), email ? "'" + email : "", deviceId, normalizedDob, now, sId, '', '貸出中']);
      const histLastRow = histSh.getLastRow();
      const isEvenH     = (histLastRow % 2 === 0);
      histSh.getRange(histLastRow, 1, 1, 9)
        .setBackground(isEvenH ? COLOR.rowEven : COLOR.rowOdd)
        .setVerticalAlignment('middle')
        .setBorder(false, false, true, false, false, false,
                   COLOR.border, SpreadsheetApp.BorderStyle.SOLID);
      histSh.getRange(histLastRow, 4)
        .setBackground(COLOR.deviceBg)
        .setFontColor(COLOR.deviceText)
        .setFontWeight('bold');
      histSh.getRange(histLastRow, 9)
        .setBackground(COLOR.statusLoan)
        .setFontColor(COLOR.statusLoanText)
        .setFontWeight('bold');
      histSh.getRange(histLastRow, 6, 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');
      histSh.getRange(histLastRow, 8, 1, 1).setNumberFormat('yyyy/MM/dd HH:mm');
      histSh.setRowHeight(histLastRow, 32);
    } catch (e) {
      console.error('[checkout] シート書込エラー: ' + e.message);
      return { success: false, message: 'データの保存に失敗しました: ' + e.message };
    }

    return { success: true, loanId: id, deviceId };
  } finally {
    lock.releaseLock();
  }
}

function checkoutPrepare(params) {
  _sweepStalePreparations();

  const blockMsg = _modeBlockMessage('checkout');
  if (blockMsg) return { success: false, message: blockMsg };

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    const { name, email, dob, sessionId } = params;

    if (!name && !email) {
      return { success: false, message: '名前またはメールアドレスが必要です' };
    }

    const blacklistReason = isBlacklisted(name, email);
    if (blacklistReason) {
      return { success: false, message: '【貸出制限】' + blacklistReason };
    }

    const sh = getSheet(SHEET_ACTIVE);
    const rows = sh.getDataRange().getValues();
    const nName = normalizeName(name);

    const usedSet = new Set();
    for (let i = 1; i < rows.length; i++) {
      const existingName = normalizeName(rows[i][1]);
      const existingEmail = normalizeEmail(rows[i][2]);
      if (email && existingEmail === normalizeEmail(email)) {
        return { success: false, message: 'あなたはすでに端末を借りています（端末: ' + rows[i][3] + '）。1人1台までです。' };
      }
      if (!email && !existingEmail && nName && existingName === nName) {
        return { success: false, message: 'あなたはすでに端末を借りています（端末: ' + rows[i][3] + '）。1人1台までです。' };
      }
      if (rows[i][3]) usedSet.add(String(rows[i][3]));
    }

    const failedSet = getFailedDevices();
    const freeDevices = ALL_DEVICES.filter(d => !usedSet.has(d) && !failedSet.has(d));
    if (freeDevices.length === 0) {
      const msg = failedSet.size > 0 ? '現在利用可能な端末がありません（貸出中または故障中）。' : '現在すべての端末が貸出中です。';
      return { success: false, message: msg };
    }

    const deviceId = freeDevices[0];
    const id = Utilities.getUuid();
    const now = new Date();
    const normalizedDob = dob ? normalizeDob(dob) : '';

    sh.appendRow([id, sheetSafeText(name), email ? "'" + email : "", deviceId, normalizedDob, now, sessionId || '']);
    
    const lastRow = sh.getLastRow();
    sh.getRange(lastRow, 1, 1, 7).setBackground((lastRow % 2 === 0) ? COLOR.rowEven : COLOR.rowOdd);
    sh.getRange(lastRow, 4).setBackground(COLOR.deviceBg).setFontColor(COLOR.deviceText).setFontWeight('bold');

    return { success: true, loanId: id, deviceId };

  } catch (e) {
    return { success: false, message: 'エラー: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

function checkoutCommit(params) {
  const { loanId } = params;
  if (!loanId) return { success: false, message: 'loanIdが必要です' };

  const activeSh = getSheet(SHEET_ACTIVE);
  const activeRows = activeSh.getDataRange().getValues();
  let loan = null;

  for (let i = 1; i < activeRows.length; i++) {
    if (String(activeRows[i][0]) === String(loanId)) {
      loan = {
        id: String(activeRows[i][0]),
        name: activeRows[i][1],
        email: activeRows[i][2],
        deviceId: activeRows[i][3],
        dob: activeRows[i][4],
        checkoutTime: activeRows[i][5],
        sessionId: activeRows[i][6]
      };
      break;
    }
  }

  if (!loan) return { success: false, message: '貸出予約が見つかりません' };

  const histSh = getSheet(SHEET_HISTORY);
  histSh.appendRow([loan.id, loan.name, loan.email, loan.deviceId, loan.dob, loan.checkoutTime, loan.sessionId, '', '貸出中']);
  
  const lastRow = histSh.getLastRow();
  histSh.getRange(lastRow, 1, 1, 9).setBackground((lastRow % 2 === 0) ? COLOR.rowEven : COLOR.rowOdd);
  histSh.getRange(lastRow, 9).setBackground(COLOR.statusLoan).setFontColor(COLOR.statusLoanText).setFontWeight('bold');

  return { success: true };
}

function checkoutAuto(params) {
  const blockMsg = _modeBlockMessage('checkout');
  if (blockMsg) return { success: false, message: blockMsg };

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    const sh = getSheet(SHEET_ACTIVE);
    const rows = sh.getDataRange().getValues();

    const usedSet = new Set();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][3]) usedSet.add(String(rows[i][3]));
    }

    const failedSet = getFailedDevices();
    const freeDevices = ALL_DEVICES.filter(d => !usedSet.has(d) && !failedSet.has(d));

    if (freeDevices.length === 0) {
      return {
        success: false,
        message: '現在すべての端末が貸出中です。返却されるまでお待ちください。'
      };
    }

    params.deviceId = freeDevices[0];
    return checkout(params);

  } catch (e) {
    console.error('[checkoutAuto] エラー: ' + e.message);
    return { success: false, message: '処理に失敗しました: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

function returnVerify(params) {
  const blockMsg = _modeBlockMessage('return');
  if (blockMsg) return { success: false, message: blockMsg };

  const { loanId, dob } = params;

  if (!loanId || !dob) {
    return { success: false, message: '必要な情報が不足しています' };
  }

  const sh   = getSheet(SHEET_ACTIVE);
  const rows = sh.getDataRange().getValues();
  let loan = null;
  let storedDob = '';

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(loanId)) {
      storedDob = String(rows[i][4]);
      loan = {
        id:           String(rows[i][0]),
        name:         rows[i][1],
        email:        normalizeEmail(rows[i][2]),
        deviceId:     rows[i][3],
        checkoutTime: rows[i][5] ? new Date(rows[i][5]).toISOString() : '',
      };
      break;
    }
  }

  if (!loan) {
    return { success: false, message: '貸出記録が見つかりません' };
  }

  const skipVerify = (dob === 'SKIP');
  const recordDob = normalizeDob(storedDob);

  if (!skipVerify) {
    const inputDob  = normalizeDob(dob);
      if (!recordDob || !inputDob || inputDob !== recordDob) {
      return { success: false, message: '生年月日が一致しません。もう一度確認してください' };
    }
  }

  return { success: true, loan };
}

function returnComplete(params) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, message: 'サーバーが混雑しています。しばらくしてからもう一度お試しください' };
  }

  try {
    const blockMsg = _modeBlockMessage('return');
    if (blockMsg) return { success: false, message: blockMsg };

    const { loanId } = params;
    if (!loanId) return { success: false, message: '記録IDが不足しています' };

    const sh   = getSheet(SHEET_ACTIVE);
    const rows = sh.getDataRange().getValues();
    let targetRow = -1;
    let loan = null;

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(loanId)) {
        targetRow = i + 1;
        loan = {
          name:      rows[i][1],
          email:     normalizeEmail(rows[i][2]),
          deviceId:  rows[i][3],
        };
        break;
      }
    }

    if (targetRow === -1) {
      return { success: false, message: '貸出記録が見つかりません' };
    }

    const now = new Date();
    let deadlineHour = DEFAULT_SETTINGS.returnDeadlineHour;
    let deadlineMinute = DEFAULT_SETTINGS.returnDeadlineMinute;
    let remote = null;
    try {
      remote = getRemoteSettings();
      if (remote && remote.success && remote.settings) {
        if (typeof remote.settings.returnDeadlineHour === 'number') deadlineHour = remote.settings.returnDeadlineHour;
        if (typeof remote.settings.returnDeadlineMinute === 'number') deadlineMinute = remote.settings.returnDeadlineMinute;
      }
    } catch (e) {
      console.error('[returnComplete] 返却期限設定の取得に失敗しました。既定値(16:00)を使用します: ' + e.message);
    }
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const grace = (remote && remote.success && remote.settings && typeof remote.settings.gracePeriodMinutes === 'number') ? remote.settings.gracePeriodMinutes : 0;
    const deadlineMinutes = deadlineHour * 60 + deadlineMinute + grace;
    const isLate = nowMinutes >= deadlineMinutes;

    try {
      if (isLate && (loan.email || loan.name)) {
        const s = (remote && remote.success && remote.settings) ? remote.settings : DEFAULT_SETTINGS;
        processOverdue(loan.name, loan.email, s);
      }
    } catch (e) {
      console.error('[returnComplete] processOverdue エラー: ' + e.message);
    }

    try {
      const histSheet = getSheet(SHEET_HISTORY);
      const histRows  = histSheet.getDataRange().getValues();
      let histFound = false;
      for (let i = 1; i < histRows.length; i++) {
        if (String(histRows[i][0]) === String(loanId)) {
          const histRow = i + 1;
          histSheet.getRange(histRow, 8).setValue(now).setNumberFormat('yyyy/MM/dd HH:mm');
          histSheet.getRange(histRow, 9).setValue(isLate ? '延滞返却' : '返却済')
            .setBackground(isLate ? '#fee2e2' : COLOR.statusReturn)
            .setFontColor(isLate ? '#991b1b' : COLOR.statusReturnText)
            .setFontWeight('bold');
          histFound = true;
          break;
        }
      }
      if (!histFound) {
        console.error('[returnComplete] 履歴シートに loanId=' + loanId + ' の行が見つかりません');
      }
    } catch (e) {
      console.error('[returnComplete] 履歴更新エラー: ' + e.message);
      return { success: false, message: '履歴の更新に失敗しました: ' + e.message };
    }

    sh.deleteRow(targetRow);
    _refreshActiveRowStyles(sh);

    try {
      if (params.isDamaged === true || params.isDamaged === 'true') {
        reportFailure({
          deviceId: loan.deviceId,
          name: loan.name,
          email: loan.email,
          loanId: loanId
        });
      }
    } catch (e) {
      console.error('[returnComplete] reportFailure エラー: ' + e.message);
    }

    return { success: true, deviceId: loan ? loan.deviceId : '', isLate };
  } finally {
    lock.releaseLock();
  }
}

function processOverdue(name, email, settings) {
  const sh = getSheet(SHEET_USERS);
  const data = sh.getDataRange().getValues();
  let userRow = -1;
  let overdueCount = 0;
  let penaltyCount = 0;

  const nName = normalizeName(name);
  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][0]).trim();
    const rowName = normalizeName(data[i][1]);
    
    let match = false;
    if (email && rowEmail === String(email).trim()) match = true;
    else if (!email && !rowEmail && nName && rowName === nName) match = true;

    if (match) {
      userRow = i + 1;
      overdueCount = parseInt(data[i][2]) || 0;
      penaltyCount = parseInt(data[i][3]) || 0;
      break;
    }
  }

  overdueCount++;

  if (userRow === -1) {
    sh.appendRow([email ? "'" + email : "", sheetSafeText(name), overdueCount, penaltyCount, '']);
    userRow = sh.getLastRow();
  } else {
    sh.getRange(userRow, 3).setValue(overdueCount);
  }

  const threshold = settings.blThreshold || 3;
  if (overdueCount >= threshold) {
    penaltyCount++;
    sh.getRange(userRow, 4).setValue(penaltyCount);
    sh.getRange(userRow, 3).setValue(0);

    const durationMonths = settings.blDuration || 1;
    let finalDuration = durationMonths;
    let isPermanent = false;

    if (penaltyCount > 1) {
      if (settings.blReoffense === 'permanent') isPermanent = true;
      else finalDuration = durationMonths * 2;
    }

    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + finalDuration);
    sh.getRange(userRow, 5).setValue(expiry);

    addBlacklist({
      passcode: 'internal',
      email,
      name,
      reason: `無断延滞 ${threshold}回累積による自動登録`,
      expiry: isPermanent ? 'PERMANENT' : expiry,
      penaltyCount
    });
  }
}

function normalizeEmail(email) {
  return String(email || '').replace(/^'/, '').trim().toLowerCase();
}

// スプレッドシートのセルに書き込む前に、生徒が自由入力した文字列(氏名など)
// が「=」「+」「-」「@」で始まる場合、先頭に ' を付けてテキスト扱いを強制する。
// これを付けないと、例えば氏名欄に "=HYPERLINK(...)" のような値が入力された
// 場合、管理者がスプレッドシートを開いた時点でそれが実際の数式として評価
// されてしまう(いわゆる数式インジェクション)。email列では既にこの対策が
// 個別に入っていたが、name列(氏名)には抜けていたため、共通化して両方に適用する。
function sheetSafeText(value) {
  const s = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}

/* ==========================================================================
 * Gmailメール通知システム
 * --------------------------------------------------------------------------
 * 大きく2系統に分かれる、汎用的な通知の仕組み。
 *
 * 1) 即時アラート（notifyEmailEnabled）
 *    - 故障報告があった瞬間（reportFailure）
 *    - ブラックリストに登録された瞬間（addBlacklist。自動延滞BANも含む）
 *    - 返却期限を過ぎている貸出が新たに見つかったとき（15分ごとの巡回チェック）
 *    のそれぞれについて、個別にON/OFFを切り替えられる（notifyOnFailure /
 *    notifyOnBlacklist / notifyOnOverdue）。
 *
 * 2) 先生向け定期レポート（teacherReportEnabled）
 *    - 管理者が指定した時刻（複数可）に、現在の貸出・返却状況や故障台数
 *      などをまとめて送信する。
 *
 * どちらも「管理者ダッシュボード」の「テスト送信」ボタンから、実際に
 * 今の状態を使ったテストメールを送信して動作確認できる（sendTestEmail）。
 *
 * メール本文に載せるリンクは常にこのスプレッドシート自体のURL
 * （getSpreadsheetUrl）に固定しており、管理者が別途URLを入力する必要はない。
 * ========================================================================== */

function getSpreadsheetUrl() {
  try {
    return getSpreadsheet().getUrl();
  } catch (e) {
    return SS_ID ? ('https://docs.google.com/spreadsheets/d/' + SS_ID + '/edit') : '';
  }
}

function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _fmtDateTime(d) {
  if (!d) return '不明';
  try {
    return Utilities.formatDate(new Date(d), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  } catch (e) {
    return '不明';
  }
}

function _sendRecipients(recipients, subject, plainBody, htmlBody) {
  const recipientList = String(recipients || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .join(',');
  if (!recipientList) return false;

  // 生徒宛メール(sendUserActionEmail)と同じGoogleアカウントの1日送信上限を
  // 共有している。生徒宛メールが多い日は、こちら(先生向けの延滞/故障/
  // ブラックリストアラート・定期レポート)が上限切れで送れなくなる可能性が
  // あるため、事前にチェックしてログにはっきり残す(黙って失敗させない)。
  try {
    if (MailApp.getRemainingDailyQuota() <= 0) {
      console.error('[_sendRecipients] 本日のメール送信可能数の上限に達しているため送信をスキップしました: ' + subject);
      return false;
    }
  } catch (e) {
    // クォータ取得に失敗しても、それだけで送信をブロックしない
  }

  MailApp.sendEmail(recipientList, subject, plainBody, {
    htmlBody: htmlBody,
    name: '端末貸出管理システム'
  });
  return true;
}

/**
 * 見やすいHTMLメールの共通レイアウト。ヘッダーバナー・本文・
 * （任意で）スプレッドシートへのリンクボタン・フッターの4段構成で、
 * どの通知（即時アラート／定期レポート／テスト送信）でも共通して使う。
 */
function _emailWrapper(opts) {
  const accentColor = opts.accentColor || COLOR.headerHistory;
  const badge = opts.badge || '端末貸出管理システム';
  const title = opts.title || '';
  const subtitle = opts.subtitle || '';
  const bodyHtml = opts.bodyHtml || '';
  const linkUrl = opts.linkUrl || '';
  const linkLabel = opts.linkLabel || 'スプレッドシートで詳細を確認する';
  const footerNote = opts.footerNote || 'このメールは端末貸出管理システムから自動送信されています。返信はできません。';

  const linkBlock = linkUrl ? `
          <tr>
            <td class="ml-pad-h ml-pad-linkbottom">
              <a href="${_escHtml(linkUrl)}"
                 style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;
                        font-size:13px;font-weight:700;padding:13px 24px;border-radius:10px;
                        font-family:Arial,'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;">
                📊 ${_escHtml(linkLabel)} →
              </a>
            </td>
          </tr>` : '';

  // 実機/クライアントごとの違い:
  // - Gmail(PC/モバイルアプリ)・Apple Mail・モバイルSafari等は <style> 内のメディアクエリに対応するため、
  //   600px以下の画面では余白やフォントサイズを詰め、一覧テーブルをカード表示に切り替える。
  // - Outlook(Windows デスクトップ, Wordエンジン)はメディアクエリを解釈しないため、
  //   その場合でも下地のテーブルレイアウト自体はどの画面幅でも崩れない設計にしてある
  //   (width:100%+max-width指定によるプログレッシブエンハンスメント。メディアクエリが
  //   効かなくても致命的な見た目崩れにはならない)。
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table { border-collapse: collapse !important; }
  img { border: 0; line-height: 100%; outline: none; text-decoration: none; }
  body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }

  .ml-container { width: 600px; max-width: 600px; }
  .ml-pad-h { padding-left: 32px; padding-right: 32px; }
  .ml-pad-linkbottom { padding-top: 0; padding-bottom: 28px; }
  .ml-header { padding: 30px 32px; }
  .ml-body { padding: 30px 32px 8px 32px; }
  .ml-footer { padding: 18px 32px; }
  .ml-title { font-size: 21px; }
  .ml-list-table { display: table; width: 100%; }
  .ml-list-cards { display: none; }

  /* スマートフォン等、600px以下の狭い画面向けの調整。
     メディアクエリ非対応のクライアント(Outlookデスクトップ等)では単に無視され、
     上記の基本スタイルのまま表示される。 */
  @media only screen and (max-width: 600px) {
    .ml-container { width: 100% !important; max-width: 100% !important; border-radius: 0 !important; }
    .ml-pad-h { padding-left: 18px !important; padding-right: 18px !important; }
    .ml-pad-linkbottom { padding-bottom: 20px !important; }
    .ml-header { padding: 22px 18px !important; }
    .ml-body { padding: 22px 18px 6px 18px !important; }
    .ml-footer { padding: 16px 18px !important; }
    .ml-title { font-size: 18px !important; }
    /* 列数の多い一覧表はスマホでは横スクロールさせず、1行=1カードの縦積みに切り替える */
    .ml-list-table { display: none !important; }
    .ml-list-cards { display: block !important; }
    /* 3枚以上の数値サマリーカードは、狭い画面では横一列ではなく2列×折り返しにする。
       2枚以下はそのまま横一列で十分読めるサイズなので対象外。 */
    .ml-stat-row-switchable { display: none !important; }
    .ml-stat-cards-mobile { display: block !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" class="ml-container" cellpadding="0" cellspacing="0"
               style="width:600px;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;
                      box-shadow:0 8px 28px rgba(15,23,42,0.10);font-family:Arial,'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;">
          <tr>
            <td class="ml-header" style="background:${accentColor};">
              <div style="font-size:11px;letter-spacing:.08em;color:rgba(255,255,255,0.78);font-weight:700;text-transform:uppercase;margin-bottom:8px;">
                ${_escHtml(badge)}
              </div>
              <div class="ml-title" style="font-weight:800;color:#ffffff;line-height:1.4;">
                ${_escHtml(title)}
              </div>
              ${subtitle ? `<div style="font-size:13px;color:rgba(255,255,255,0.88);margin-top:8px;">${_escHtml(subtitle)}</div>` : ''}
            </td>
          </tr>
          <tr>
            <td class="ml-body" style="color:#0f172a;">
              ${bodyHtml}
            </td>
          </tr>
          ${linkBlock}
          <tr>
            <td class="ml-footer" style="background:#f8fafc;border-top:1px solid #e2e8f0;">
              <div style="font-size:11px;color:#94a3b8;line-height:1.7;">${_escHtml(footerNote)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body></html>`;
}

// 数値サマリーを横並びのカードで表示（貸出中○件／延滞○件、のような一覧性の高い見せ方）
function _statCardsHtml(cards) {
  const n = cards.length;
  // 2枚以下は横一列のままでも狭い画面で十分読める大きさになるため、
  // モバイル専用レイアウトへの切り替えは3枚以上の場合のみ行う。
  const needsMobileWrap = n >= 3;
  const rowClass = needsMobileWrap ? 'ml-stat-row ml-stat-row-switchable' : 'ml-stat-row';

  const cells = cards.map(c => `
    <td width="${Math.floor(100 / n)}%" style="padding:4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;">
        <tr><td style="padding:16px 8px;text-align:center;">
          <div style="font-size:26px;font-weight:800;color:${c.color || '#0f172a'};line-height:1;">${_escHtml(c.value)}</div>
          <div style="font-size:11px;color:#64748b;margin-top:8px;font-weight:700;">${_escHtml(c.label)}</div>
        </td></tr>
      </table>
    </td>`).join('');

  // 3枚以上ある場合のみ、狭い画面では2列×折り返しにする代替HTML。
  // メディアクエリが効くクライアントだけこちらに切り替わる。
  const mobileWrapBlock = needsMobileWrap ? `
    <div class="ml-stat-cards-mobile" style="display:none;text-align:left;">
      ${cards.map(c => `
      <div style="width:48%;box-sizing:border-box;display:inline-block;vertical-align:top;margin:0 0 8px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;">
          <tr><td style="padding:14px 6px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:${c.color || '#0f172a'};line-height:1;">${_escHtml(c.value)}</div>
            <div style="font-size:10.5px;color:#64748b;margin-top:6px;font-weight:700;">${_escHtml(c.label)}</div>
          </td></tr>
        </table>
      </div>`).join('')}
    </div>` : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="${rowClass}">
            <tr>${cells}</tr>
          </table>
          ${mobileWrapBlock}
          <div style="height:20px;"></div>`;
}

function _sectionHeadingHtml(text) {
  return `<div style="font-size:13px;font-weight:800;color:#0f172a;margin:0 0 10px;">${_escHtml(text)}</div>`;
}

// リスト表示用のテーブル（rowsの各セルは表示用HTML文字列を渡す。呼び出し側で必要に応じてエスケープ済みのこと）。
// PC/タブレットおよびメディアクエリ非対応クライアント(Outlookデスクトップ等)では
// 通常のテーブルとして表示される。スマートフォン等の狭い画面(600px以下)では、
// 列が多いと横スクロールが必要になり読みにくくなるため、1行=1項目のカード形式に
// 自動的に切り替わる(情報量はテーブル版と完全に同じで、レイアウトのみ変わる)。
function _listTableHtml(headers, rows, emptyText) {
  if (!rows || rows.length === 0) {
    return `<div style="padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;
                        color:#166534;font-size:13px;font-weight:700;text-align:center;">
              ✓ ${_escHtml(emptyText || '該当する項目はありません')}
            </div>`;
  }

  const headHtml = headers.map(h =>
    `<th style="text-align:left;font-size:11px;color:#64748b;padding:9px 10px;border-bottom:2px solid #e2e8f0;white-space:nowrap;">${_escHtml(h)}</th>`
  ).join('');
  const bodyHtml = rows.map((r, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    const cells = r.map(v => `<td style="font-size:12.5px;color:#0f172a;padding:9px 10px;border-bottom:1px solid #f1f5f9;">${v}</td>`).join('');
    return `<tr style="background:${bg};">${cells}</tr>`;
  }).join('');
  const tableHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="ml-list-table"
                             style="border-collapse:collapse;margin-bottom:20px;">
            <thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody>
          </table>`;

  // 列数が1〜2列程度の表(貸出確認メールの「端末番号・貸出日時」など)は、
  // スマホでも横スクロールなしで元々読みやすいため、カード変換は3列以上の場合のみ行う。
  if (headers.length < 3) {
    return tableHtml;
  }

  const cardsHtml = rows.map((r, i) => {
    const rowsHtml = headers.map((h, colIdx) => `
        <tr>
          <td style="font-size:10.5px;color:#94a3b8;font-weight:700;padding:6px 0 2px 0;width:38%;vertical-align:top;">${_escHtml(h)}</td>
          <td style="font-size:13px;color:#0f172a;padding:6px 0 2px 0;vertical-align:top;">${r[colIdx]}</td>
        </tr>`).join('');
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:${bg};border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;">
        <tr><td style="padding:8px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
        </td></tr>
      </table>`;
  }).join('');
  const cardsBlock = `<div class="ml-list-cards" style="display:none;margin-bottom:12px;">${cardsHtml}</div>`;

  return tableHtml + cardsBlock;
}

function _deviceBadgeHtml(deviceId) {
  return `<span style="display:inline-block;background:${COLOR.deviceBg};color:${COLOR.deviceText};
                       font-weight:800;padding:3px 9px;border-radius:6px;font-size:12px;">${_escHtml(deviceId)}</span>`;
}

function _statusBadgeHtml(text, kind) {
  const palette = {
    danger:  { bg: '#fee2e2', fg: '#991b1b' },
    warning: { bg: '#fef3c7', fg: '#92400e' },
    success: { bg: COLOR.statusReturn, fg: COLOR.statusReturnText },
    info:    { bg: COLOR.statusLoan, fg: COLOR.statusLoanText }
  };
  const c = palette[kind] || palette.info;
  return `<span style="display:inline-block;background:${c.bg};color:${c.fg};font-weight:800;
                       padding:3px 9px;border-radius:6px;font-size:11px;">${_escHtml(text)}</span>`;
}

/* -------------------- ① 即時アラート：延滞（15分ごとの巡回チェック） -------------------- */

// 通知先メールアドレスが未設定の場合、GASスクリプトのオーナー(このプロジェクトを
// デプロイした先生のGoogleアカウント)へ自動的にフォールバックする。
// これにより「メールアドレスを一度も設定していない」状態でも、専門知識なしで
// 異常が起きた時に誰か(少なくともシステムを作った本人)に通知が届くようにする。
// 明示的に notifyEmailAddress / teacherReportAddress を設定すれば、そちらが優先される。
function _resolveNotifyRecipients(settings) {
  const explicit = String((settings && settings.notifyEmailAddress) || '').trim();
  if (explicit) return explicit;
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

function _resolveTeacherReportRecipients(settings) {
  const explicit = String((settings && settings.teacherReportAddress) || '').trim();
  if (explicit) return explicit;
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

const NOTIFY_TRIGGER_HANDLER = 'checkAndNotifyOverdueOrFailures';
const NOTIFY_STATE_PROP_KEY = 'OVERDUE_NOTIFY_STATE';
const NOTIFY_TRIGGER_INTERVAL_MINUTES = 15;

// 設定保存時に呼ばれ、即時アラートが有効なら15分ごとのトリガーを作成、
// 無効ならこの機能用のトリガーを削除する。常に既存の同名トリガーは
// 一旦すべて削除してから必要な場合のみ作り直すため、多重登録は起きない。
//
// 宛先メールアドレスが未入力でも、_resolveNotifyRecipients() が
// GASオーナーのアドレスへ自動フォールバックするため、トリガー自体は
// 「有効フラグがオンかどうか」だけで判断する(宛先の有無では判断しない)。
function _syncOverdueEmailTrigger(settings) {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === NOTIFY_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
    }
  });

  if (settings && settings.notifyEmailEnabled && settings.notifyOnOverdue !== false) {
    ScriptApp.newTrigger(NOTIFY_TRIGGER_HANDLER)
      .timeBased()
      .everyMinutes(NOTIFY_TRIGGER_INTERVAL_MINUTES)
      .create();
  }
}

function _getNotifyState() {
  const raw = PropertiesService.getScriptProperties().getProperty(NOTIFY_STATE_PROP_KEY);
  if (!raw) return { overdueIds: [], lastSentAt: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      overdueIds: Array.isArray(parsed.overdueIds) ? parsed.overdueIds : [],
      lastSentAt: parsed.lastSentAt || null
    };
  } catch (e) {
    return { overdueIds: [], lastSentAt: null };
  }
}

function _setNotifyState(state) {
  PropertiesService.getScriptProperties().setProperty(NOTIFY_STATE_PROP_KEY, JSON.stringify(state));
}

function _findOverdueLoans(settings) {
  const loansResult = getLoans();
  const loans = (loansResult && loansResult.loans) || [];

  const dHour = typeof settings.returnDeadlineHour === 'number' ? settings.returnDeadlineHour : 16;
  const dMin = typeof settings.returnDeadlineMinute === 'number' ? settings.returnDeadlineMinute : 0;
  const grace = typeof settings.gracePeriodMinutes === 'number' ? settings.gracePeriodMinutes : 0;

  // 期限の規則はローカルDBの getLoanDeadline / isOverdueLoan と同一にする。
  // 貸出当日の returnDeadlineHour:returnDeadlineMinute を期限とし、
  // 貸出時刻より前なら翌日へ、猶予は最後に加算。
  function isOverdue(checkoutTimeIso) {
    if (!checkoutTimeIso) return false;
    const checkout = new Date(checkoutTimeIso);
    if (isNaN(checkout.getTime())) return false;
    const deadline = new Date(checkout);
    deadline.setHours(dHour, dMin, 0, 0);
    if (deadline <= checkout) deadline.setDate(deadline.getDate() + 1);
    deadline.setMinutes(deadline.getMinutes() + grace);
    return new Date() > deadline;
  }

  return loans.filter(l => isOverdue(l.checkoutTime));
}

// トリガーから15分ごとに呼ばれるエントリーポイント。
// 時間主導型トリガーはGASの実行者（オーナー）権限で動くため、
// MailApp.sendEmail はそのGoogleアカウントの権限で送信される。
function checkAndNotifyOverdueOrFailures() {
  const settingsResult = getRemoteSettings();
  const settings = (settingsResult && settingsResult.settings) || DEFAULT_SETTINGS;

  if (!settings.notifyEmailEnabled || settings.notifyOnOverdue === false) return;
  const recipients = _resolveNotifyRecipients(settings);
  if (!recipients) return;

  const overdueLoans = _findOverdueLoans(settings);
  const overdueIds = overdueLoans.map(l => l.id).sort();

  if (overdueIds.length === 0) {
    // 何もなければ状態をクリアしておく（次に延滞が発生したら改めて通知するため）
    _setNotifyState({ overdueIds: [], lastSentAt: null });
    return;
  }

  const prevState = _getNotifyState();
  const sameAsLastTime = JSON.stringify(overdueIds) === JSON.stringify(prevState.overdueIds);
  if (sameAsLastTime) {
    // 前回通知した内容から変化がなければ再送しない（スパム防止）
    return;
  }

  try {
    _sendOverdueAlertEmail(recipients, overdueLoans, false);
    _setNotifyState({ overdueIds, lastSentAt: new Date().toISOString() });
  } catch (e) {
    console.error('[checkAndNotifyOverdueOrFailures] メール送信エラー: ' + e.message);
  }
}

function _sendOverdueAlertEmail(recipients, overdueLoans, isTest) {
  const dateLabel = _fmtDateTime(new Date());
  const subject = `【端末貸出管理】${isTest ? '[テスト送信] ' : ''}延滞 ${overdueLoans.length}件のお知らせ`;

  const rows = overdueLoans.map(l => ([
    _deviceBadgeHtml(l.deviceId),
    _escHtml(l.name || '(氏名不明)'),
    _escHtml(l.checkoutTime ? _fmtDateTime(l.checkoutTime) + '〜' : '不明')
  ]));

  const bodyHtml = `
    <p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 18px;">
      返却期限を過ぎたまま返却されていない端末があります（${_escHtml(dateLabel)} 時点）。
    </p>
    ${_statCardsHtml([{ label: '延滞中の端末', value: overdueLoans.length, color: '#b91c1c' }])}
    ${_sectionHeadingHtml('延滞中の端末一覧')}
    ${_listTableHtml(['端末', '利用者', '貸出開始'], rows)}
  `;

  const html = _emailWrapper({
    accentColor: '#b91c1c',
    badge: isTest ? 'テスト送信・延滞アラート' : '延滞アラート',
    title: `延滞中の端末が ${overdueLoans.length} 件あります`,
    subtitle: dateLabel + ' 時点の状況',
    bodyHtml,
    linkUrl: getSpreadsheetUrl(),
    footerNote: '※ このメールは延滞状況に変化があった場合のみ自動送信されます。本メールへの返信はできません。'
  });

  const plainLines = overdueLoans.map(l => `・${l.deviceId} / ${l.name || '(氏名不明)'} / 貸出: ${_fmtDateTime(l.checkoutTime)}〜`);
  const plain = `延滞中の端末が ${overdueLoans.length} 件あります（${dateLabel} 時点）\n\n` +
    plainLines.join('\n') + '\n\n詳細: ' + getSpreadsheetUrl();

  _sendRecipients(recipients, subject, plain, html);
}

/* -------------------- ① 即時アラート：故障報告・ブラックリスト登録（イベント発生時） -------------------- */

function _sendFailureReportedEmail(recipients, failure) {
  const dateLabel = _fmtDateTime(failure.reportedAt);
  const subject = `【端末貸出管理】故障報告: ${failure.deviceId}`;

  const rows = [[
    _deviceBadgeHtml(failure.deviceId),
    _escHtml(failure.name || '(報告者不明)'),
    _escHtml(failure.email || '―'),
    _escHtml(dateLabel)
  ]];

  const bodyHtml = `
    <p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 18px;">
      端末の故障が新たに報告されました。この端末は自動的に「貸出不可」として扱われます。
    </p>
    ${_statCardsHtml([{ label: '報告された端末', value: failure.deviceId, color: '#c2410c' }])}
    ${_sectionHeadingHtml('故障報告の詳細')}
    ${_listTableHtml(['端末', '報告者', 'メールアドレス', '報告日時'], rows)}
  `;

  const html = _emailWrapper({
    accentColor: '#c2410c',
    badge: '故障報告アラート',
    title: `端末 ${failure.deviceId} の故障が報告されました`,
    subtitle: dateLabel + ' に報告',
    bodyHtml,
    linkUrl: getSpreadsheetUrl(),
    footerNote: '※ このメールは故障が報告されるたびに自動送信されます。本メールへの返信はできません。'
  });

  const plain = `端末 ${failure.deviceId} の故障が報告されました（${dateLabel}）\n` +
    `報告者: ${failure.name || '(報告者不明)'} ${failure.email ? '/ ' + failure.email : ''}\n\n` +
    '詳細: ' + getSpreadsheetUrl();

  _sendRecipients(recipients, subject, plain, html);
}

function _sendBlacklistAddedEmail(recipients, entry) {
  const dateLabel = _fmtDateTime(entry.createdAt);
  const displayName = entry.name || entry.email || '(氏名・メール不明)';
  const subject = `【端末貸出管理】ブラックリスト登録: ${displayName}`;

  const expiryLabel = !entry.expiry ? 'なし'
    : (entry.expiry === 'PERMANENT' ? '無期限' : _fmtDateTime(entry.expiry).slice(0, 10).replace(/-/g, '/'));

  const rows = [[
    _escHtml(displayName),
    _escHtml(entry.email || '―'),
    _escHtml(entry.reason || '理由なし'),
    _escHtml(expiryLabel)
  ]];

  const bodyHtml = `
    <p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 18px;">
      利用制限（ブラックリスト）に新しく登録されたユーザーがいます。
    </p>
    ${_sectionHeadingHtml('登録内容')}
    ${_listTableHtml(['氏名', 'メールアドレス', '理由', '解除予定'], rows)}
  `;

  const html = _emailWrapper({
    accentColor: '#991b1b',
    badge: 'ブラックリスト登録アラート',
    title: `${displayName} を利用制限に登録しました`,
    subtitle: dateLabel + ' に登録',
    bodyHtml,
    linkUrl: getSpreadsheetUrl(),
    footerNote: '※ このメールはブラックリストに新規登録されるたびに自動送信されます（延滞による自動登録を含む）。本メールへの返信はできません。'
  });

  const plain = `${displayName} を利用制限（ブラックリスト）に登録しました（${dateLabel}）\n` +
    `理由: ${entry.reason || '理由なし'} / 解除予定: ${expiryLabel}\n\n` +
    '詳細: ' + getSpreadsheetUrl();

  _sendRecipients(recipients, subject, plain, html);
}

/* -------------------- ①' 生徒本人宛：貸出・返却の確認メール -------------------- */
//
// 【2026-09 GASへ復帰】このメールは以前ここ(GAS/MailApp.sendEmail)から送信していたが、
// 一時期Node側(local-db/email_queue.js)からnodemailerでSMTPに直接送信する方式に
// 変更されていた。しかしSMTP設定(config.envのSMTP_USER/SMTP_PASS)を教員側で
// 正しく用意する必要があり、設定ミス(サンプル値のまま等)によりメールが届かない
// トラブルが発生したため、GoogleアカウントのMailApp経由に戻した。
// これによりconfig.env側でのSMTP設定は不要になる。
//
// 呼び出し元: server.js が checkoutCommit / returnComplete のたびに
// action='sendUserActionEmail' でこの関数を呼ぶ(syncFromLocalと同じ同期トークンで認証)。
// 送信失敗はここでエラーを返すのみで、呼び出し元(Node側)は貸出・返却本体には
// 一切影響させない(fire-and-forget的に扱う)。

const CONFIRMATION_ACCENT_COLOR = '#0f766e';

function _buildCheckoutMail(payload) {
  const name = payload.name || '';
  const displayName = name || '(氏名不明)';
  const deviceId = payload.deviceId || '';
  const checkoutTime = _fmtDateTime(payload.checkoutTime);
  const subject = '端末貸出確認';

  const text =
    `${name} 様\n` +
    `端末の貸出が完了しました。\n` +
    `- 端末番号: ${deviceId}\n` +
    `- 貸出日時: ${checkoutTime}\n` +
    `返却期限にご注意ください。\n`;

  const bodyHtml = `
    <p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 18px;">
      ${_escHtml(displayName)} さん、端末の貸出を受け付けました。返却期限までに返却してください。
    </p>
    ${_sectionHeadingHtml('貸出内容')}
    ${_listTableHtml(['端末番号', '貸出日時'], [[_deviceBadgeHtml(deviceId), _escHtml(checkoutTime)]])}
  `;

  const html = _emailWrapper({
    accentColor: CONFIRMATION_ACCENT_COLOR,
    badge: '貸出確認',
    title: `${deviceId} を貸し出しました`,
    subtitle: checkoutTime,
    bodyHtml,
    footerNote: 'このメールは端末を借りた本人宛に自動送信されています。心当たりがない場合は先生に連絡してください。本メールへの返信はできません。'
  });

  return { subject, text, html };
}

function _buildReturnMail(payload) {
  const name = payload.name || '';
  const displayName = name || '(氏名不明)';
  const deviceId = payload.deviceId || '';
  const returnTime = _fmtDateTime(payload.returnTime);
  const isLate = !!payload.isLate;
  const lateNote = isLate ? '延滞返却' : '返却済';
  const subject = '端末返却確認';

  const text =
    `${name} 様\n` +
    `端末の返却が完了しました。\n` +
    `- 端末番号: ${deviceId}\n` +
    `- 返却日時: ${returnTime}\n` +
    `- 期限超過: ${isLate ? 'あり' : 'なし'}\n`;

  const bodyHtml = `
    <p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 18px;">
      ${_escHtml(displayName)} さん、端末の返却を受け付けました。ご協力ありがとうございました。
    </p>
    ${_sectionHeadingHtml('返却内容')}
    ${_listTableHtml(
      ['端末番号', '返却日時', '状態'],
      [[_deviceBadgeHtml(deviceId), _escHtml(returnTime), _statusBadgeHtml(lateNote, isLate ? 'warning' : 'success')]]
    )}${isLate ? `
    <p style="font-size:12.5px;color:#92400e;line-height:1.7;margin:14px 0 0;">
      ※ 返却期限を過ぎての返却でした。回数が続くと利用制限の対象になる場合がありますので、次回以降は期限内の返却にご注意ください。
    </p>` : ''}
  `;

  const html = _emailWrapper({
    accentColor: isLate ? '#b45309' : CONFIRMATION_ACCENT_COLOR,
    badge: '返却確認',
    title: `${deviceId} の返却を受け付けました`,
    subtitle: returnTime,
    bodyHtml,
    footerNote: 'このメールは端末を返却した本人宛に自動送信されています。心当たりがない場合は先生に連絡してください。本メールへの返信はできません。'
  });

  return { subject, text, html };
}

// action: 'sendUserActionEmail'
// params: { token, idempotencyKey, kind: 'checkout'|'return', name, email, deviceId, checkoutTime, returnTime, isLate }
// 同期トークンで認証する(syncFromLocalと同じペアリング済みトークンを使い回す)。
const USER_EMAIL_IDEMPOTENCY_SHEET = 'メール送信重複防止';
const USER_EMAIL_IDEMPOTENCY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

function _userEmailIdempotencyHash(eventId) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(eventId),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

function _getUserEmailIdempotencySheet() {
  const sheet = getSheet(USER_EMAIL_IDEMPOTENCY_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(['イベントハッシュ', '記録日時(ms)']);
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function _pruneUserEmailIdempotencySheet(sheet, now) {
  const props = PropertiesService.getScriptProperties();
  const lastPrunedAt = Number(props.getProperty('USER_EMAIL_IDEMPOTENCY_LAST_PRUNED') || 0);
  if (now - lastPrunedAt < 24 * 60 * 60 * 1000) return;

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    const retained = rows.filter(row => {
      const createdAt = Number(row[1]);
      return Number.isFinite(createdAt) && now - createdAt <= USER_EMAIL_IDEMPOTENCY_RETENTION_MS;
    });
    if (retained.length !== rows.length) {
      sheet.getRange(2, 1, lastRow - 1, 2).clearContent();
      if (retained.length > 0) sheet.getRange(2, 1, retained.length, 2).setValues(retained);
    }
  }
  props.setProperty('USER_EMAIL_IDEMPOTENCY_LAST_PRUNED', String(now));
}

// GASはメール送信とHTTP応答の間で通信が切れることがある。処理前にイベントIDを
// スプレッドシートへ永続記録し、同じキュー行の再送ではメールを再送しない
// （重複より未送信の可能性を選ぶat-most-once保護）。送信失敗が例外として確定した
// 場合は記録行を消して再試行する。ScriptPropertiesの容量上限を避けるため専用シートを使う。
function _sendUserActionEmailOnce(eventId, sendEmail) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = _getUserEmailIdempotencySheet();
    const now = Date.now();
    _pruneUserEmailIdempotencySheet(sheet, now);
    const hash = _userEmailIdempotencyHash(eventId);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const match = sheet.getRange(2, 1, lastRow - 1, 1)
        .createTextFinder(hash)
        .matchEntireCell(true)
        .findNext();
      if (match) return { success: true, duplicate: true };
    }

    const row = sheet.getLastRow() + 1;
    sheet.appendRow([hash, now]);
    try {
      sendEmail();
      return { success: true };
    } catch (e) {
      sheet.deleteRow(row);
      throw e;
    }
  } finally {
    lock.releaseLock();
  }
}

function sendUserActionEmail(params) {
  const expectedToken = PropertiesService.getScriptProperties().getProperty(SYNC_TOKEN_PROP_KEY);
  if (!expectedToken || !params || !_timingSafeStringEqual(params.token, expectedToken)) {
    return { success: false, message: '同期トークンが一致しません（ペアリングされていないか、トークンが変わっています）' };
  }

  const kind = params.kind;
  const recipient = String(params.email || '').trim();
  if (!recipient) {
    return { success: false, message: '宛先メールアドレスがありません' };
  }
  if (kind !== 'checkout' && kind !== 'return') {
    return { success: false, message: '不明な種別です: ' + kind };
  }

  // Googleアカウントには1日のメール送信数に上限があり、超えると
  // MailApp.sendEmail() は例外を投げる。呼び出し元(email_queue.js)は
  // それを「一時的な失敗」として指数バックオフで延々リトライするが、
  // クォータは日付が変わるまで回復しないため、当日中はいくらリトライしても
  // 無駄になる。事前にクォータを確認し、切れている場合はその旨を明確な
  // メッセージで返すことで、管理画面のキュー状況やログからすぐ原因が
  // 分かるようにする(クォータ取得自体が失敗した場合は送信を試みる)。
  try {
    if (MailApp.getRemainingDailyQuota() <= 0) {
      return {
        success: false,
        message: '本日のメール送信可能数の上限に達しています（Googleアカウントの1日の送信上限）。日付が変わると自動的に回復します。'
      };
    }
  } catch (e) {
    // クォータ取得に失敗しても、それだけで送信をブロックしない
  }

  try {
    const mail = kind === 'checkout' ? _buildCheckoutMail(params) : _buildReturnMail(params);
    const sendEmail = () => MailApp.sendEmail(recipient, mail.subject, mail.text, {
      htmlBody: mail.html,
      name: '端末貸出管理システム'
    });
    if (params.idempotencyKey) {
      return _sendUserActionEmailOnce(params.idempotencyKey, sendEmail);
    }
    sendEmail();
    return { success: true };
  } catch (e) {
    return { success: false, message: 'メール送信に失敗しました: ' + e.message };
  }
}

/* -------------------- ② 先生向け定期レポート（管理者が指定した時刻に自動送信） -------------------- */

const TEACHER_REPORT_TRIGGER_HANDLER = 'sendTeacherReport';
const TEACHER_REPORT_MAX_TIMES = 6; // 1日に設定できる送信時刻の上限（トリガー数の暴走防止）

function _parseHhMm(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

// 設定保存時に呼ばれ、先生向けレポートが有効なら指定された時刻ごとに
// 1日1回のトリガーを作成する（複数時刻を設定した場合はその数だけ作成）。
// 常に既存の同名トリガーを一旦すべて削除してから作り直すため多重登録は起きない。
//
// 宛先メールアドレスが未入力でも _resolveTeacherReportRecipients() が
// GASオーナーのアドレスへ自動フォールバックするため、トリガー自体は
// 有効フラグのみで判断する。
function _syncTeacherReportTriggers(settings) {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === TEACHER_REPORT_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
    }
  });

  if (!settings || !settings.teacherReportEnabled) return;

  const times = Array.isArray(settings.teacherReportTimes) ? settings.teacherReportTimes : [];
  const validTimes = times.map(_parseHhMm).filter(Boolean).slice(0, TEACHER_REPORT_MAX_TIMES);

  validTimes.forEach(t => {
    ScriptApp.newTrigger(TEACHER_REPORT_TRIGGER_HANDLER)
      .timeBased()
      .atHour(t.hour)
      .nearMinute(t.minute)
      .everyDays(1)
      .create();
  });
}

// 現在の貸出・返却・故障・ブラックリストの状況をまとめて取得する
// （先生向け定期レポートと、テスト送信の両方から共通で使う）。
function _gatherStatusReportPayload() {
  const settingsResult = getRemoteSettings();
  const settings = (settingsResult && settingsResult.settings) || DEFAULT_SETTINGS;

  const loansResult = getLoans();
  const loans = (loansResult && loansResult.loans) || [];
  const overdueLoans = _findOverdueLoans(settings);
  const overdueIdSet = new Set(overdueLoans.map(l => l.id));
  const onTimeCount = loans.length - overdueLoans.length;

  const failuresResult = getFailures();
  const allFailures = (failuresResult && failuresResult.failures) || [];
  const activeFailures = allFailures.filter(f => f.status === '故障中');

  const blacklistResult = getBlacklist();
  const blacklist = (blacklistResult && blacklistResult.blacklist) || [];

  const availableCount = Math.max(0, ALL_DEVICES.length - loans.length - activeFailures.length);

  return {
    generatedAt: new Date(),
    totalDevices: ALL_DEVICES.length,
    loans, overdueLoans, overdueIdSet, onTimeCount,
    activeFailures, blacklist, availableCount
  };
}

function _buildStatusReportBodyHtml(payload) {
  const loanRows = payload.loans.map(l => ([
    _deviceBadgeHtml(l.deviceId),
    _escHtml(l.name || '(氏名不明)'),
    _escHtml(l.checkoutTime ? _fmtDateTime(l.checkoutTime) : '不明'),
    payload.overdueIdSet.has(l.id) ? _statusBadgeHtml('延滞中', 'danger') : _statusBadgeHtml('貸出中', 'info')
  ]));

  const failureRows = payload.activeFailures.map(f => ([
    _deviceBadgeHtml(f.deviceId),
    _escHtml(f.reportedAt ? _fmtDateTime(f.reportedAt) : '不明'),
    _escHtml(f.name || '(報告者不明)')
  ]));

  const blacklistRows = payload.blacklist.slice(0, 20).map(b => ([
    _escHtml(b.name || b.email || '(氏名・メール不明)'),
    _escHtml(b.reason || '理由なし'),
    _escHtml(b.expiry === '無期限' ? '無期限' : (b.expiry ? _fmtDateTime(b.expiry).slice(0, 10).replace(/-/g, '/') : 'なし'))
  ]));
  const blacklistNote = payload.blacklist.length > 20
    ? `<div style="font-size:11px;color:#94a3b8;margin:-12px 0 20px;">他 ${payload.blacklist.length - 20} 件（スプレッドシートでご確認ください）</div>`
    : '';

  return `
    ${_statCardsHtml([
      { label: '貸出中', value: payload.loans.length, color: '#1d4ed8' },
      { label: 'うち延滞中', value: payload.overdueLoans.length, color: '#b91c1c' },
      { label: '故障中', value: payload.activeFailures.length, color: '#c2410c' },
      { label: '利用可能', value: payload.availableCount, color: '#15803d' }
    ])}
    ${_sectionHeadingHtml(`貸出中の端末一覧（全${payload.totalDevices}台中 ${payload.loans.length}台）`)}
    ${_listTableHtml(['端末', '利用者', '貸出開始', '状態'], loanRows, '現在貸出中の端末はありません')}
    ${_sectionHeadingHtml(`故障中の端末一覧（${payload.activeFailures.length}件）`)}
    ${_listTableHtml(['端末', '報告日時', '報告者'], failureRows, '現在故障中の端末はありません')}
    ${_sectionHeadingHtml(`ブラックリスト登録者（${payload.blacklist.length}件）`)}
    ${_listTableHtml(['氏名', '理由', '解除予定'], blacklistRows, '現在ブラックリストに登録されている利用者はいません')}
    ${blacklistNote}
  `;
}

function _sendStatusReportEmail(recipients, payload, opts) {
  const dateLabel = _fmtDateTime(payload.generatedAt);
  const isTest = !!(opts && opts.isTest);
  const subject = `【端末貸出システム】${isTest ? '[テスト送信] ' : ''}状況レポート（${dateLabel}）`;

  const bodyHtml = `
    <p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 18px;">
      現在の貸出・返却状況、故障台数、ブラックリストの登録状況をお知らせします（${_escHtml(dateLabel)} 時点）。
    </p>
    ${_buildStatusReportBodyHtml(payload)}
  `;

  const html = _emailWrapper({
    accentColor: opts && opts.accentColor || COLOR.headerHistory,
    badge: isTest ? 'テスト送信・状況レポート' : '定期状況レポート',
    title: '端末貸出・返却の状況レポート',
    subtitle: dateLabel + ' 時点',
    bodyHtml,
    linkUrl: getSpreadsheetUrl(),
    footerNote: isTest
      ? '※ これは管理者ダッシュボードから送信したテストメールです。実際のレポートも同じ形式で届きます。'
      : '※ このメールは管理者が設定した時刻に自動送信される定期レポートです。本メールへの返信はできません。'
  });

  const plain =
    `端末貸出・返却の状況レポート（${dateLabel} 時点）\n\n` +
    `貸出中: ${payload.loans.length}件（うち延滞中: ${payload.overdueLoans.length}件）\n` +
    `故障中: ${payload.activeFailures.length}件\n` +
    `ブラックリスト登録: ${payload.blacklist.length}件\n` +
    `利用可能な端末: ${payload.availableCount}台\n\n` +
    '詳細: ' + getSpreadsheetUrl();

  return _sendRecipients(recipients, subject, plain, html);
}

// 時間主導型トリガーから、管理者が設定した時刻に呼ばれるエントリーポイント。
function sendTeacherReport() {
  try {
    const settingsResult = getRemoteSettings();
    const settings = (settingsResult && settingsResult.settings) || DEFAULT_SETTINGS;
    if (!settings.teacherReportEnabled) return;

    const recipients = _resolveTeacherReportRecipients(settings);
    if (!recipients) return;

    const payload = _gatherStatusReportPayload();
    _sendStatusReportEmail(recipients, payload, { isTest: false, accentColor: '#0f172a' });
  } catch (e) {
    console.error('[sendTeacherReport] エラー: ' + e.message);
  }
}

/* -------------------- テスト送信（管理者ダッシュボードの「テストメール送信」ボタン） -------------------- */

// type: 'instant'（即時アラートの宛先へ）または 'teacherReport'（先生向けレポートの宛先へ）
// どちらも「架空のダミーデータ」ではなく、実際の現在の状態を使ってその場で送信することで、
// 本当にメールが正しく届くかを確認できるようにしている。
function sendTestEmail(params) {
  const { passcode, type } = params || {};
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) {
    return { success: false, message: passcodeCheck.message };
  }

  // 管理画面の「今すぐテストメールを送信」ボタンは、保存済み設定ではなく
  // 画面に今入力されている内容(未保存の下書き)をそのままテストしたい、
  // という意図で params.settings に現在のフォーム値を積んで送ってくる。
  // これを無視して保存済み設定だけを見てしまうと、「アドレスを入力した
  // 直後、保存ボタンを押す前にテスト送信」した場合に、古い(または未設定の)
  // アドレスへ送られてしまい、テスト結果と実際の動作が食い違う。
  // そのため、保存済み設定をベースに、下書きの値があればそちらで上書きする。
  const settingsResult = getRemoteSettings();
  const savedSettings = (settingsResult && settingsResult.settings) || DEFAULT_SETTINGS;
  const draftSettings = (params && params.settings && typeof params.settings === 'object') ? params.settings : null;
  const settings = draftSettings ? Object.assign({}, savedSettings, draftSettings) : savedSettings;

  try {
    if (type === 'teacherReport') {
      const recipients = _resolveTeacherReportRecipients(settings);
      if (!recipients) {
        return { success: false, message: '送信先メールアドレスを解決できませんでした（宛先未入力かつGASオーナーのアドレス取得にも失敗しました）。' };
      }
      const payload = _gatherStatusReportPayload();
      const sent = _sendStatusReportEmail(recipients, payload, { isTest: true, accentColor: '#0f172a' });
      if (!sent) return { success: false, message: '送信先メールアドレスの形式を確認してください。' };
      return { success: true, message: 'テストメール（先生向け定期レポート）を送信しました。送信先: ' + recipients };
    }

    if (type === 'overdue') {
      const recipients = _resolveNotifyRecipients(settings);
      if (!recipients) {
        return { success: false, message: '送信先メールアドレスを解決できませんでした（宛先未入力かつGASオーナーのアドレス取得にも失敗しました）。' };
      }
      const overdueLoans = _findOverdueLoans(settings);
      _sendOverdueAlertEmail(recipients, overdueLoans, true);
      return { success: true, message: 'テストメール（延滞アラート）を送信しました。送信先: ' + recipients + (overdueLoans.length === 0 ? '（現在延滞中の端末はありません）' : '') };
    }

    // type === 'instant'（既定）: 即時アラートの宛先へ、現在の状況スナップショットを送る
    const recipients = _resolveNotifyRecipients(settings);
    if (!recipients) {
      return { success: false, message: '送信先メールアドレスを解決できませんでした（宛先未入力かつGASオーナーのアドレス取得にも失敗しました）。' };
    }
    const payload = _gatherStatusReportPayload();
    const sent = _sendStatusReportEmail(recipients, payload, { isTest: true, accentColor: '#b91c1c' });
    if (!sent) return { success: false, message: '送信先メールアドレスの形式を確認してください。' };
    return { success: true, message: 'テストメール（即時アラート）を送信しました。送信先: ' + recipients };
  } catch (e) {
    return { success: false, message: 'メール送信に失敗しました: ' + e.message };
  }
}

function normalizeName(name) {
  if (!name) return '';
  let s = String(name).replace(/\s+/g, '');

  const kanaMap = {
    'ｶﾞ': 'ガ', 'ｷﾞ': 'ギ', 'ｸﾞ': 'グ', 'ｹﾞ': 'ゲ', 'ｺﾞ': 'ゴ',
    'ｻﾞ': 'ザ', 'ｼﾞ': 'ジ', 'ｽﾞ': 'ズ', 'ｾﾞ': 'ゼ', 'ｿﾞ': 'ゾ',
    'ﾀﾞ': 'ダ', 'ﾁﾞ': 'ヂ', 'ﾂﾞ': 'ヅ', 'ﾃﾞ': 'デ', 'ﾄﾞ': 'ド',
    'ﾊﾞ': 'バ', 'ﾋﾞ': 'ビ', 'ﾌﾞ': 'ブ', 'ﾍﾞ': 'ベ', 'ﾎﾞ': 'ボ',
    'ﾊﾟ': 'パ', 'ﾋﾟ': 'ピ', 'ﾌﾟ': 'プ', 'ﾍﾟ': 'ペ', 'ﾎﾟ': 'ポ',
    'ｳﾞ': 'ヴ', 'ﾜﾞ': 'ヷ', 'ｦﾞ': 'ヺ',
    'カﾞ': 'ガ', 'キﾞ': 'ギ', 'クﾞ': 'グ', 'ケﾞ': 'ゲ', 'コﾞ': 'ゴ',
    'サﾞ': 'ザ', 'シﾞ': 'ジ', 'スﾞ': 'ズ', 'セﾞ': 'ゼ', 'ソﾞ': 'ゾ',
    'タﾞ': 'ダ', 'チﾞ': 'ヂ', 'ツﾞ': 'ヅ', 'テﾞ': 'デ', 'トﾞ': 'ド',
    'ハﾞ': 'バ', 'ヒﾞ': 'ビ', 'フﾞ': 'ブ', 'ヘﾞ': 'ベ', 'ホﾞ': 'ボ',
    'ハﾟ': 'パ', 'ヒﾟ': 'ピ', 'フﾟ': 'プ', 'ヘﾟ': 'ペ', 'ホﾟ': 'ポ',
    'ｱ': 'ア', 'ｲ': 'イ', 'ｳ': 'ウ', 'ｴ': 'エ', 'ｵ': 'オ',
    'ｶ': 'カ', 'ｷ': 'キ', 'ｸ': 'ク', 'ｹ': 'ケ', 'ｺ': 'コ',
    'ｻ': 'サ', 'ｼ': 'シ', 'ｽ': 'ス', 'ｾ': 'セ', 'ｿ': 'ソ',
    'ﾀ': 'タ', 'ﾁ': 'チ', 'ﾂ': 'ツ', 'ﾃ': 'テ', 'ﾄ': 'ト',
    'ﾅ': 'ナ', 'ﾆ': 'ニ', 'ﾇ': 'ヌ', 'ﾈ': 'ネ', 'ﾉ': 'ノ',
    'ﾊ': 'ハ', 'ﾋ': 'ヒ', 'ﾌ': 'フ', 'ﾍ': 'ヘ', 'ﾎ': 'ホ',
    'ﾏ': 'マ', 'ﾐ': 'ミ', 'ﾑ': 'ム', 'ﾒ': 'メ', 'ﾓ': 'モ',
    'ﾔ': 'ヤ', 'ﾕ': 'ユ', 'ﾖ': 'ヨ',
    'ﾗ': 'ラ', 'ﾘ': 'リ', 'ﾙ': 'ル', 'ﾚ': 'レ', 'ﾛ': 'ロ',
    'ﾜ': 'ワ', 'ｦ': 'ヲ', 'ﾝ': 'ン',
    'ｧ': 'ァ', 'ｨ': 'ィ', 'ｩ': 'ゥ', 'ｪ': 'ェ', 'ｫ': 'ォ',
    'ｯ': 'ッ', 'ｬ': 'ャ', 'ｭ': 'ュ', 'ｮ': 'ョ',
    '｡': '。', '､': '、', 'ｰ': 'ー', '｢': '「', '｣': '」', '･': '・'
  };

  const sortedKeys = Object.keys(kanaMap).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    s = s.replace(new RegExp(key, 'g'), kanaMap[key]);
  }

  s = s.replace(/[！-～]/g, function (tmp) {
    return String.fromCharCode(tmp.charCodeAt(0) - 0xFEE0);
  });

  return s.trim();
}

function formatValidDob_(yearValue, monthValue, dayValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || year < 1 || year > 9999 ||
      !Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(day) || day < 1) return '';

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return '';

  return String(year).padStart(4, '0') + '-' +
    String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function normalizeDob(dob) {
  if (!dob) return '';

  if (dob instanceof Date) {
    if (!Number.isFinite(dob.getTime())) return '';
    return formatValidDob_(dob.getFullYear(), dob.getMonth() + 1, dob.getDate());
  }

  const s = String(dob).trim();
  if (!s) return '';

  const m1 = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:$|[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)$/);
  if (m1) return formatValidDob_(m1[1], m1[2], m1[3]);

  const monthMap = {
    Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
    Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'
  };
  const m2 = s.match(/^(?:[A-Za-z]{3}\s+)?([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})(?:\s+\d{2}:\d{2}:\d{2}(?:\s+GMT[+-]\d{4}(?:\s+\([^)]*\))?)?)?$/);
  if (m2) {
    const mo = monthMap[m2[1]];
    if (!mo) return '';
    return formatValidDob_(m2[3], mo, m2[2]);
  }

  return '';
}

function getBlacklist() {
  const sh = getSheet(SHEET_BLACKLIST);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return { success: true, blacklist: [] };

  const now = new Date();
  const range = sh.getRange(2, 5, lastRow - 1, 1);
  const expiryValues = range.getValues();
  const toDelete = [];
  
  for (let i = expiryValues.length - 1; i >= 0; i--) {
    const expiry = expiryValues[i][0];
    if (expiry && expiry instanceof Date && expiry < now) {
      toDelete.push(i + 2);
    }
  }
  
  if (toDelete.length > 0) {
    toDelete.sort((a, b) => b - a);
    for (const row of toDelete) {
      sh.deleteRow(row);
    }
    _refreshBlacklistRowStyles(sh);
  }

  const rows = sh.getDataRange().getValues();
  if (rows.length <= 1) return { success: true, blacklist: [] };

  const blacklist = rows.slice(1).map(r => ({
    email: normalizeEmail(r[0]),
    name: String(r[1]),
    reason: String(r[2]),
    createdAt: r[3] ? new Date(r[3]).toISOString() : '',
    expiry: r[4] ? (r[4] === 'PERMANENT' ? '無期限' : new Date(r[4]).toISOString()) : 'なし',
    violations: r[5] || 0
  }));

  return { success: true, blacklist };
}

function addBlacklist(params) {
  const { passcode, email, name, reason, expiry, penaltyCount } = params;
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) {
    return { success: false, message: passcodeCheck.message };
  }
  if (!email && !name) {
    return { success: false, message: 'メールアドレスまたは名前が必要です' };
  }

  const sh = getSheet(SHEET_BLACKLIST);
  const createdAt = new Date();
  sh.appendRow([
    email ? "'" + email : "", 
    name || '', 
    reason || '理由なし', 
    createdAt,
    expiry || '',
    penaltyCount || 0
  ]);
  _refreshBlacklistRowStyles(sh);

  try {
    const settingsResult = getRemoteSettings();
    const settings = (settingsResult && settingsResult.settings) || DEFAULT_SETTINGS;
    if (settings.notifyEmailEnabled && settings.notifyOnBlacklist !== false) {
      const recipients = _resolveNotifyRecipients(settings);
      if (recipients) {
        _sendBlacklistAddedEmail(recipients, {
          email: normalizeEmail(email || ''),
          name: name || '',
          reason: reason || '理由なし',
          createdAt: createdAt,
          expiry: expiry || ''
        });
      }
    }
  } catch (e) {
    console.error('[addBlacklist] 即時通知メールの送信に失敗しました: ' + e.message);
  }

  return { success: true, message: 'ブラックリストに追加しました' };
}

function removeBlacklist(params) {
  const { passcode, email, name } = params;
  const passcodeCheck = verifyPasscodeWithLockout(passcode);
  if (!passcodeCheck.ok) {
    return { success: false, message: passcodeCheck.message };
  }
  const sh = getSheet(SHEET_BLACKLIST);
  const rows = sh.getDataRange().getValues();
  const nName = normalizeName(name);
  let matched = false;
  
  for (let i = rows.length - 1; i >= 1; i--) {
    const bEmail = normalizeEmail(rows[i][0]);
    const bName = normalizeName(rows[i][1]);
    
    let match = false;
    if (email && bEmail === normalizeEmail(email)) match = true;
    if (!match && !email && !bEmail && nName && bName === nName) match = true;

    if (match) {
      sh.deleteRow(i + 1);
      matched = true;
    }
  }
  _refreshBlacklistRowStyles(sh);
  if (!matched) {
    return { success: false, message: 'ブラックリストに該当するユーザーが見つかりません' };
  }
  return { success: true, message: 'ブラックリストから削除しました' };
}

function getFailures() {
  const sh = getSheet(SHEET_FAILURES);
  const rows = sh.getDataRange().getValues();
  if (rows.length <= 1) return { success: true, failures: [] };

  const failures = rows.slice(1)
    .filter(r => r[0])
    .reverse() // 新しい順
    .map(r => ({
      deviceId:     String(r[0]),
      reportedAt:   r[1] ? new Date(r[1]).toISOString() : '',
      name:         r[2],
      email:        normalizeEmail(r[3]),
      resolvedAt:   r[4] ? new Date(r[4]).toISOString() : '',
      status:       r[5],
      loanId:       r[6]
    }));

  return { success: true, failures };
}

function reportFailure(params) {
  const { deviceId, name, email, loanId } = params;
  const sh = getSheet(SHEET_FAILURES);
  
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === deviceId && rows[i][5] === '故障中') {
      return { success: true, message: '既に故障報告済みです' };
    }
  }

  const reportedAt = new Date();
  sh.appendRow([
    deviceId,
    reportedAt,
    name || '',
    email ? "'" + email : "",
    '',
    '故障中',
    loanId || ''
  ]);
  
  _refreshFailuresRowStyles(sh);

  try {
    const settingsResult = getRemoteSettings();
    const settings = (settingsResult && settingsResult.settings) || DEFAULT_SETTINGS;
    if (settings.notifyEmailEnabled && settings.notifyOnFailure !== false) {
      const recipients = _resolveNotifyRecipients(settings);
      if (recipients) {
        _sendFailureReportedEmail(recipients, {
          deviceId: deviceId,
          name: name || '',
          email: normalizeEmail(email || ''),
          reportedAt: reportedAt
        });
      }
    }
  } catch (e) {
    console.error('[reportFailure] 即時通知メールの送信に失敗しました: ' + e.message);
  }

  return { success: true, message: '故障を記録しました' };
}

function addFailure(params) {
  const { deviceId } = params;
  if (!deviceId) return { success: false, message: '端末番号が必要です' };
  if (!ALL_DEVICES.includes(deviceId)) return { success: false, message: '端末番号が不正です' };

  const loansResult = getLoans();
  const loans = loansResult.loans || [];
  const activeLoan = loans.find(l => l.deviceId === deviceId);

  if (activeLoan) {
    return returnComplete({
      loanId: activeLoan.id,
      isDamaged: true
    });
  } else {
    return reportFailure({ deviceId });
  }
}

function resolveFailure(params) {
  const { deviceId } = params;
  if (!deviceId) return { success: false, message: '端末番号が必要です' };
  if (!ALL_DEVICES.includes(deviceId)) return { success: false, message: '端末番号が不正です' };

  const sh = getSheet(SHEET_FAILURES);
  const rows = sh.getDataRange().getValues();
  let found = false;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === deviceId && rows[i][5] === '故障中') {
      const row = i + 1;
      sh.getRange(row, 5).setValue(new Date());
      sh.getRange(row, 6).setValue('完了');
      found = true;
    }
  }

  if (found) {
    _refreshFailuresRowStyles(sh);
    return { success: true, message: '故障状態を解除しました' };
  } else {
    return { success: false, message: '故障中の記録が見つかりません' };
  }
}

function setup() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (spreadsheet) spreadsheet.setSpreadsheetTimeZone('Asia/Tokyo');
  const histSh   = getSheet(SHEET_HISTORY);
  const activeSh = getSheet(SHEET_ACTIVE);
  const blackSh  = getSheet(SHEET_BLACKLIST);
  const userSh   = getSheet(SHEET_USERS);
  const failSh   = getSheet(SHEET_FAILURES);
  applySheetFormat(histSh, SHEET_HISTORY);
  applySheetFormat(activeSh, SHEET_ACTIVE);
  applySheetFormat(blackSh, SHEET_BLACKLIST);
  applySheetFormat(userSh, SHEET_USERS);
  applySheetFormat(failSh, SHEET_FAILURES);
}