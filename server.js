'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');
const { safeDecodePath } = require('./lib/safe-decode');
const LDB = require('./local-db/lending');
const { createSyncJob, getSyncStatus, resetEmptyGuard } = require('./local-db/sync');
const { createEmailQueueWorker } = require('./local-db/email_queue');
const {
  runBackup, listBackups, inspectBackup, prepareDatabaseRestore, createBackupJob, BACKUP_NAME_RE,
  saveSettingsBackup, pruneOldSettingsBackups, listSettingsBackups,
  setBackupTargetDirs, getBackupDir, getSettingsBackupDir, SETTINGS_BACKUP_NAME_RE,
  resolveBackupPath
} = require('./local-db/backup');
const externalStorage = require('./external-storage');
const ALL_DEVICES = require('./js/devices');
const { parseGasUrl } = require('./lib/gas-url');
const gasUrlConfig = parseGasUrl(process.env.GAS_URL);
const GAS_URL = gasUrlConfig.url;
const GAS_URL_ERROR = gasUrlConfig.error;

// ---------------------------------------------------------------------------
// スプレッドシート同期(syncFromLocal)用の認証トークン
// ---------------------------------------------------------------------------
// GAS_URLが設定されている場合のみトークンを生成し、config.envに保存する。
// GAS側は初回リクエストを信用しないため、導入時に管理者が同じ値を
// スクリプトプロパティへ事前登録する。URLが未設定なら固定の既定URLを使う。
function _ensureSyncToken() {
  if (process.env.SYNC_TOKEN) return process.env.SYNC_TOKEN;

  const configPath = path.join(__dirname, 'config.env');
  let token = '';
  try {
    if (fs.existsSync(configPath)) {
      const already = fs.readFileSync(configPath, 'utf8');
      const m = already.match(/^SYNC_TOKEN=(\S+)/m);
      if (m && m[1]) token = m[1];
    }
  } catch (e) {
    slog('WARN', `SYNC_TOKENをconfig.envから読み込めませんでした: ${e.message}`);
  }
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    try {
      if (fs.existsSync(configPath)) {
        const already = fs.readFileSync(configPath, 'utf8');
        if (!/^SYNC_TOKEN=/m.test(already)) {
          fs.appendFileSync(configPath, `\n# スプレッドシート同期のペアリング用トークン（自動生成・変更不要）\nSYNC_TOKEN=${token}\n`);
        }
      }
    } catch (e) {
      slog('WARN', `SYNC_TOKENをconfig.envへ保存できませんでした（次回起動時に再生成されます）: ${e.message}`);
    }
  }
  process.env.SYNC_TOKEN = token;
  return token;
}
const SYNC_TOKEN = GAS_URL ? _ensureSyncToken() : '';

// これらのアクションはローカルSQLiteで処理する(GASには転送しない)。
// 貸出・返却・解錠可否といった「今すぐ動く必要がある」処理は、
// ネットワークやGASの調子に一切左右されなくなる。
// GASへは scheduleSync() が別途バックグラウンドでミラーを反映する。
const LOCAL_READ_ACTIONS = new Set([
  'getLoans', 'getHistory', 'getBlacklist', 'getFailures',
  'getSettings', 'getAvailableDevice', 'getUsers'
]);
const LOCAL_WRITE_ACTIONS = new Set([
  'checkoutPrepare', 'checkoutCancel', 'checkoutCommit', 'checkout', 'checkoutAuto',
  'returnVerify', 'returnComplete',
  'addBlacklist', 'removeBlacklist', 'clearData', 'updateSettings',
  'forceReturnLoan', 'editHistoryEntry', 'deleteHistoryEntry',
  'updateUser', 'deleteUser',
  // バグ修正: addFailure/resolveFailure は local-db/lending.js に完全な
  // ローカル実装(failuresテーブル)が既に存在していたにもかかわらず、
  // このセットへの登録漏れにより常にGASへのネットワーク転送に頼っていた。
  // そのため、GAS同期が止まっている環境（オフライン運用時など）では
  // 「故障端末管理」機能そのものが完全に使用不能になっていた。
  // フェイルセーフ設計の原則（ローカルDBを正として即座に動作する）に
  // 沿って、他の書き込みアクションと同様にローカル実行対象に加える。
  'addFailure', 'resolveFailure'
]);
const LOCAL_ACTIONS = new Set([...LOCAL_READ_ACTIONS, ...LOCAL_WRITE_ACTIONS]);

// このアクションが呼ばれた後は、ミラー(スプレッドシート)を
// 早めに追いつかせたいもの。sync.js 実装後にここへフックする。
const SYNC_TRIGGER_ACTIONS = new Set([
  'checkoutCommit', 'checkout', 'checkoutAuto', 'returnComplete',
  'addBlacklist', 'removeBlacklist', 'clearData', 'updateSettings',
  'forceReturnLoan', 'editHistoryEntry', 'deleteHistoryEntry',
  'updateUser', 'deleteUser', 'addFailure', 'resolveFailure'
]);
function scheduleSync(action) {
  if (SYNC_TRIGGER_ACTIONS.has(action)) {
    syncJob.requestSync();
  }
}

const syncJob = createSyncJob({
  gasUrl: GAS_URL,
  token: SYNC_TOKEN,
  intervalMs: Number(process.env.SYNC_INTERVAL_MS) || 3 * 60 * 1000,
  logger: { warn: (msg) => slog('WARN', msg) }
});

// 借りた本人・返した本人への確認メールの送信キュー処理。
// GAS(Code.gsのsendUserActionEmail)経由でMailApp.sendEmail()により送信する。
// スプレッドシート同期(SYNC_TOKEN)と共通のGAS_URL/トークンをそのまま使うため、
// SMTP設定は不要(GAS_URLとSYNC_TOKENが用意できていれば自動的に動く)。
// GASへの送信が失敗しても指数バックオフで自動的に再試行し続ける。
// 貸出・返却本体の動作には一切影響しない(失敗してもキオスクは通常通り使える)。
const emailQueueWorker = createEmailQueueWorker({
  gasUrl: GAS_URL,
  token: SYNC_TOKEN,
  pollIntervalMs: Number(process.env.EMAIL_QUEUE_POLL_INTERVAL_MS) || 10 * 1000,
  logger: {
    info: (msg) => slog('INFO', msg),
    warn: (msg) => slog('WARN', msg),
    error: (msg) => slog('ERROR', msg)
  }
});

// ローカルDB(貸出履歴・ブラックリスト等の実データ)の自動バックアップ。
// スプレッドシート同期が(未設定・GAS障害などの理由で)機能していない
// 場合でも、これだけで最低限のデータ保全ができるようにしておく。
const backupJob = createBackupJob({
  intervalMs: Number(process.env.BACKUP_INTERVAL_MS) || 6 * 60 * 60 * 1000,
  retentionDays: Number(process.env.BACKUP_RETENTION_DAYS) || 30,
  maxBackups: Number(process.env.BACKUP_MAX_COUNT) || 60,
  logger: { info: (msg) => slog('INFO', msg), warn: (msg) => slog('WARN', msg) }
});

function callLocalAction(action, params, { sessionVerified } = {}) {
  const fn = LDB[action];
  if (typeof fn !== 'function') {
    return { success: false, message: '不明なアクション: ' + action };
  }
  // GASのpasscode検証は、こちらではserver.jsのセッション確認(verifySession)に
  // 置き換わっている。管理者操作はここに来る前に呼び出し側で確認済みなので、
  // lending.js には「確認済みである」ことだけを伝える。
  if (LDB.DEFAULT_SETTINGS && ['addBlacklist', 'removeBlacklist', 'clearData', 'updateSettings'].includes(action)) {
    params = Object.assign({}, params, { passcode: sessionVerified ? 'authenticated' : '' });
  }
  const result = fn(params || {});
  if (action === 'clearData' && result && result.success) {
    // 管理者が意図的にデータを初期化した場合は、直後の同期が
    // 「空になった＝事故」と誤判定されてブロックされないようにする。
    try { resetEmptyGuard(); } catch (_) { /* 基準値のリセットに失敗しても同期自体は継続してよい */ }
  }
  scheduleSync(action);
  return result;
}

const argv = process.argv.slice(2);
function getArg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const PORT = parseInt(getArg('--port', '3000'), 10);
const SERIAL_PORT_ARG = getArg('--serial', null);
// SERIAL_PORT は表示用(pingレスポンス等)。明示指定がなければ自動検出モードで
// あることが分かるようにしておく(実際の検出は serial-bridge.js が行う)。
let SERIAL_PORT = SERIAL_PORT_ARG || '(自動検出)';
const SERIAL_BAUD = parseInt(getArg('--baud', '9600'), 10);
const _DEFAULT_ADMIN_PASSWORD = '735657';

// --- config.env の読み書き ---
// start.sh が起動時に config.env を source して環境変数/起動引数として
// server.js に渡す。管理画面からパスワードを変更した際は、メモリ上の
// 変数を書き換えるだけでなく config.env ファイル自体も更新することで、
// サーバー再起動(PC再起動・電源復旧を含む)後も変更が引き継がれるようにする。
const CONFIG_ENV_PATH = path.join(__dirname, 'config.env');

function readConfigEnvRaw() {
  try {
    return fs.readFileSync(CONFIG_ENV_PATH, 'utf8');
  } catch (e) {
    return null; // config.env がまだ存在しない場合(初回起動前など)
  }
}

// KEY=VALUE 形式の1行を安全に更新する。該当キーの行が既にあれば置き換え、
// なければ末尾に追記する。コメント行や他のキーはそのまま保持する。
function writeConfigEnvValue(key, value) {
  try {
    let content = readConfigEnvRaw();
    if (content === null) {
      content = `# このファイルはサーバーによって自動生成されました\n`;
    }
    const lines = content.split('\n');
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linePattern = new RegExp(`^${escapedKey}=`);
    let found = false;
    const newLines = lines.map((line) => {
      if (linePattern.test(line)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) {
      // 末尾が空行でない場合は改行してから追記する
      if (newLines.length > 0 && newLines[newLines.length - 1] !== '') {
        newLines.push('');
      }
      newLines.push(`${key}=${value}`);
    }
    fs.writeFileSync(CONFIG_ENV_PATH, newLines.join('\n'), { mode: 0o600 });
    return true;
  } catch (e) {
    slog('WARN', `config.env への書き込みに失敗しました(${key}): ${e.message}`);
    return false;
  }
}

// 起動時: 明示的な --admin-pw 引数がなければ、config.env の ADMIN_PW
// (start.sh が環境変数として渡している)を優先する。それも無ければ
// デフォルトパスワードを使う。
let ADMIN_PASSWORD = getArg('--admin-pw', null) || process.env.ADMIN_PW || _DEFAULT_ADMIN_PASSWORD;

let FFMPEG_AVAILABLE = false;
let FFMPEG_VERSION = null;

function checkFFmpegSync() {
  try {
    const out = child_process.execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    const first = out.split('\n')[0] || '';
    const m = first.match(/ffmpeg version ([^\s,]+)/i);
    FFMPEG_AVAILABLE = true;
    FFMPEG_VERSION = m ? m[1] : first;
    return { ok: true, version: FFMPEG_VERSION };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// 外部ストレージ（USBメモリ・SDカード）の自動検出と保存先の切替
// ---------------------------------------------------------------------------
// 録画データ・DBバックアップ・設定バックアップの保存先を、外部USB/SDが
// 差し込まれている間は外部へ、無い場合は内部へと自動で切り替える。
// external-storage.js が検出し、ここで REC_DIR とバックアップ保存先を
// 反映する。API互換のため、外部使用中フラグは従来名 _usingSdCard を
// 引き続き使う。
const INTERNAL_REC_DIR = path.join(__dirname, 'recordings');
const INTERNAL_BACKUPS_DIR = path.join(__dirname, 'data', 'backups');
const INTERNAL_SETTINGS_BACKUPS_DIR = path.join(__dirname, 'data', 'settings-backups');

let EXTERNAL_ROOT = null; // 現在の外部ストレージのルート（null = 内部ストレージ）
let REC_DIR = INTERNAL_REC_DIR; // 録画の現在の保存先
let _usingSdCard = false; // 外部ストレージ使用中か

// 起動直後: lsblkを使わない高速同期検出で初期保存先を決める
try {
  const _initialExt = externalStorage.detectSync();
  if (_initialExt.found) {
    EXTERNAL_ROOT = _initialExt.root;
    _usingSdCard = true;
    setBackupTargetDirs({
      backupsDir: path.join(EXTERNAL_ROOT, 'backups'),
      settingsBackupsDir: path.join(EXTERNAL_ROOT, 'settings-backups'),
    });
  }
} catch (e) { }
if (!EXTERNAL_ROOT) {
  REC_DIR = INTERNAL_REC_DIR;
} else {
  REC_DIR = path.join(EXTERNAL_ROOT, 'recordings');
}

// 外部/内部の切替を検出・適用する。戻り値: 切り替わった場合は true。
async function refreshStorageTarget(initial) {
  let det;
  try {
    det = await externalStorage.detect({ root: EXTERNAL_ROOT });
  } catch (e) {
    slog('WARN', `外部ストレージの検出に失敗しました: ${e.message}`);
    return false;
  }
  const nextRoot = det.found ? det.root : null;
  if (nextRoot === EXTERNAL_ROOT) return false; // 変化なし

  const prevRoot = EXTERNAL_ROOT;
  EXTERNAL_ROOT = nextRoot;
  _usingSdCard = !!nextRoot;

  if (nextRoot) {
    REC_DIR = path.join(nextRoot, 'recordings');
    setBackupTargetDirs({
      backupsDir: path.join(nextRoot, 'backups'),
      settingsBackupsDir: path.join(nextRoot, 'settings-backups'),
    });
  } else {
    REC_DIR = INTERNAL_REC_DIR;
    setBackupTargetDirs({
      backupsDir: INTERNAL_BACKUPS_DIR,
      settingsBackupsDir: INTERNAL_SETTINGS_BACKUPS_DIR,
    });
  }

  try {
    await fsp.mkdir(REC_DIR, { recursive: true });
    await fsp.mkdir(getBackupDir(), { recursive: true });
    await fsp.mkdir(getSettingsBackupDir(), { recursive: true });
  } catch (e) {
    slog('ERROR', `保存先ディレクトリの作成に失敗しました: ${e.message}`);
    if (nextRoot) {
      // 外部として採択したのに作成できなかった → 内部へ戻す
      slog('ERROR', '外部ストレージへの書き込みに失敗したため、内部ストレージへ戻します');
      EXTERNAL_ROOT = null;
      _usingSdCard = false;
      REC_DIR = INTERNAL_REC_DIR;
      setBackupTargetDirs({
        backupsDir: INTERNAL_BACKUPS_DIR,
        settingsBackupsDir: INTERNAL_SETTINGS_BACKUPS_DIR,
      });
      try { await fsp.mkdir(REC_DIR, { recursive: true }); } catch (_) { }
    }
  }

  // 内部(フォールバック) → 外部 への切り替え時は、内部に退避されていた
  // データ（録画・バックアップ）を外部ストレージへ移行する
  if (!prevRoot && nextRoot) {
    await _migrateInternalToExternal();
  }

  if (!initial) {
    slog('INFO', `保存先ストレージの状態が変化しました: ${prevRoot ? prevRoot + '（外部）' : '内部'} → ${nextRoot ? nextRoot + '（外部）' : '内部'}`);
    // 管理画面が開いていれば、次の定期ポーリングを待たずに即座に
    // 再取得させる（詳細な値は流さず「変化した」という合図のみ。
    // /arduino/stream は現状セッション認証をかけていないため、パスや
    // 空き容量など内部情報そのものは載せない）。
    _broadcastSse({ type: 'storage_status' });
  }
  return true;
}

// USB/SDの抜き差しをudev経由で即座に検知したときの処理。
// udevイベントは「デバイスが現れた/消えた」通知であり、udisks2等による
// 実際のマウント/アンマウント完了より先に届くことがあるため、少し
// 待ってから実際のマウント状態を確認する（短いデバウンスも兼ねる）。
let _hotplugRecheckTimer = null;
function _onHotplugEvent() {
  if (_hotplugRecheckTimer) return; // 既に確認予約済みなら重複させない
  _hotplugRecheckTimer = setTimeout(() => {
    _hotplugRecheckTimer = null;
    refreshStorageTarget(false).catch(e => slog('WARN', `外部ストレージの即時再検出エラー: ${e.message}`));
  }, 800);
}

const LOG_DIR = path.join(__dirname, 'logs');
const DATA_DIR = path.join(__dirname, 'data');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const LOG_FILE = path.join(LOG_DIR, 'server.jsonl');
const LOCAL_CONFIG_FILE = path.join(DATA_DIR, 'local-config.json');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.jsonl');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

async function _pruneLogFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_LOG_SIZE) return;
    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const half = Math.floor(lines.length / 2);
    await fsp.writeFile(filePath, lines.slice(half).join('\n') + '\n', 'utf8');
    slog('INFO', `ログファイルを圧縮しました: ${path.basename(filePath)} (${lines.length}行 → ${lines.length - half}行)`);
  } catch (e) {
  }
}
const MAX_VIDEO_SIZE = 300 * 1024 * 1024;
let _enableDebugLogs = false;

const _adminSessions = new Map();
const _loginAttempts = new Map();
setInterval(() => {
  const now = new Date();
  for (const [ip, entry] of _loginAttempts) {
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      _loginAttempts.delete(ip);
    } else if (!entry.lockedUntil && Date.now() - (entry._ts || 0) > LOCKOUT_MS * 2) {
      _loginAttempts.delete(ip);
    }
  }
}, 60000).unref();

const SESSION_TTL = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30 * 1000;

const _activeFFmpegTasks = new Set();

const _sseClients = new Set();
let _cameraStatus = { state: 'unknown', message: '', updatedAt: null };

const COLORS = {
  reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

function slog(level, ...args) {
  if (level === 'DEBUG' && !_enableDebugLogs) return;
  const ts = new Date().toISOString();
  const lvMap = { 'INFO': '情報', 'WARN': '警告', 'ERROR': 'エラー', 'DEBUG': 'デバッグ' };
  const displayLevel = lvMap[level] || level;
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = JSON.stringify({ ts, level: displayLevel, msg });
  let color = COLORS.reset;
  if (level === 'INFO') color = COLORS.green;
  else if (level === 'WARN') color = COLORS.yellow;
  else if (level === 'ERROR') color = COLORS.red;
  else if (level === 'DEBUG') color = COLORS.cyan;
  process.stdout.write(`${COLORS.gray}[${ts}]${COLORS.reset} ${color}[${displayLevel.padEnd(4)}]${COLORS.reset} ${msg}\n`);
  // 起動初期化中（_ensureSyncToken()等、LOG_FILE の const 初期化より前）にも
  // slog が呼ばれる可能性がある。その状態で LOG_FILE を参照すると TDZ の
  // ReferenceError でサーバーが起動できなくなるため、ここは try/catch で
  // 保護する（stdout への出力は済んでいるので、ファイル出力の失敗は許容する）。
  try {
    fsp.appendFile(LOG_FILE, line + '\n').catch(() => { });
  } catch (e) {
    // ログファイルが未初期化、または logs/ ディレクトリが無い場合は黙って諦める
  }
}

let _settingsCache = null;
let _settingsUpdatedAt = null;
let _settingsUpdatedBy = '';

function getCurrentSettings(force = false) {
  // ローカルSQLiteが正のデータなので、キャッシュもネットワーク往復も不要。
  // 同期関数だが呼び出し側は await getCurrentSettings() のままで問題ない
  // (Promiseでなくても await は値をそのまま通す)。
  const data = LDB.getSettings();
  _settingsCache = (data && data.settings) || LDB.DEFAULT_SETTINGS;
  _settingsUpdatedAt = (data && data.updatedAt) || null;
  _settingsUpdatedBy = (data && data.updatedBy) || '';
  _enableDebugLogs = _settingsCache.enableDebugLogs === true;
  return _settingsCache;
}

function pushSettingsLocal(partialSettings, updatedBy) {
  const base = getCurrentSettings();
  const merged = { ...base, ...partialSettings };
  delete merged._offline;

  const result = LDB.updateSettings({
    passcode: 'authenticated', // server.js側で既に管理者セッションを確認済みの前提で呼ばれる
    data: JSON.stringify(merged),
    updatedBy: updatedBy || '教室PC'
  });
  if (!result.success) throw new Error(result.message || '設定の保存に失敗しました');

  _settingsCache = result.settings || merged;
  _settingsUpdatedAt = result.updatedAt || new Date().toISOString();
  _settingsUpdatedBy = updatedBy || '教室PC';
  _enableDebugLogs = _settingsCache.enableDebugLogs === true;

  scheduleSync('updateSettings');

  // 扉別解錠時間が変わった場合はArduinoへ即時反映（未接続なら接続時に再送される）
  pushDoorUnlockDurationsToArduino().catch(() => { });

  return { settings: _settingsCache, updatedAt: _settingsUpdatedAt };
}

const DOOR_UNLOCK_DURATION_MIN_MS = 100;
const DOOR_UNLOCK_DURATION_MAX_MS = 15000;

// 保存されている扉別解錠時間(ms)を、必ず12要素の配列で返す。
// 設定未保存・要素不足・不正値の場合は既定1000msで補完し、プロトコル上の
// 有効範囲(100〜15000ms)へクランプする。
function getDoorUnlockDurations() {
  const DEFAULT_DURATIONS = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
  const settings = getCurrentSettings();
  const raw = settings && settings.doorUnlockDurations;
  if (!Array.isArray(raw)) return DEFAULT_DURATIONS.slice();
  const arr = raw.slice(0, 12);
  while (arr.length < 12) arr.push(DEFAULT_DURATIONS[arr.length]);
  return arr.map((v, i) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return DEFAULT_DURATIONS[i];
    return Math.min(DOOR_UNLOCK_DURATION_MAX_MS, Math.max(DOOR_UNLOCK_DURATION_MIN_MS, n));
  });
}

// 扉別解錠時間を Arduino へ送信する（'u<ms1>,<ms2>,...' 形式）。
// シリアルキュー経由なので、前後の解錠コマンドと直列化され順序が保たれる。
async function pushDoorUnlockDurationsToArduino({ allowNotReady = false } = {}) {
  if (!_serialReady && !allowNotReady) {
    slog('DEBUG', 'Arduino未接続のため扉別解錠時間の送信をスキップしました（接続時に再送されます）');
    return false;
  }
  const cmd = 'u' + getDoorUnlockDurations().join(',');
  slog('DEBUG', `扉別解錠時間をArduinoへ送信: ${cmd}`);
  try {
    const reply = await serialSendRecv(cmd, 2000, 2, { allowNotReady });
    if (reply !== 'ok') {
      slog('WARN', `扉別解錠時間の反映を確認できませんでした: "${reply}"`);
      return false;
    }
    slog('DEBUG', '扉別解錠時間をArduinoへ反映しました');
    return true;
  } catch (e) {
    slog('WARN', `扉別解錠時間の送信に失敗しました: ${e.message}`);
    return false;
  }
}

async function readLocalConfig() {
  try {
    if (fs.existsSync(LOCAL_CONFIG_FILE)) {
      return JSON.parse(await fsp.readFile(LOCAL_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    slog('WARN', 'ローカル設定の読み込みに失敗しました', e.message);
  }
  return { assetConfig: {} };
}

async function writeLocalConfig(cfg) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(LOCAL_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// /api/settings/export のダウンロード内容と、設定バックアップ(自動保存分)の
// 中身を同じ形式にそろえるための共通ヘルパー。
async function buildSettingsExportData() {
  const settings = await getCurrentSettings(true);
  const local = await readLocalConfig();
  return { ...settings, assetConfig: local.assetConfig || {}, captureDeviceId: local.captureDeviceId || '' };
}

// 設定が変わるたびに自動でスナップショットを保存しておく。
// バックアップ復元をファイル選択なしの「一覧から選ぶ」形式にするための土台。
// 失敗しても設定保存そのものは失敗させたくないので例外は握りつぶす。
async function snapshotSettingsBackup(kind) {
  try {
    const data = await buildSettingsExportData();
    await saveSettingsBackup(data, { kind, logger: { info: (m) => slog('INFO', m), warn: (m) => slog('WARN', m) } });
    await pruneOldSettingsBackups({ logger: { info: (m) => slog('INFO', m), warn: (m) => slog('WARN', m) } });
  } catch (e) {
    slog('WARN', '設定バックアップの自動保存に失敗しました', e.message);
  }
}

[REC_DIR, LOG_DIR, DATA_DIR, ASSETS_DIR].forEach(dir => {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      slog('DEBUG', `ディレクトリを作成しました: ${dir}`);
    }
  } catch (e) {
    if (dir === REC_DIR && _usingSdCard) {
      slog('ERROR', `外部ストレージへの書き込みに失敗しました。内部ストレージへ切り替えます: ${e.message}`);
      EXTERNAL_ROOT = null;
      REC_DIR = INTERNAL_REC_DIR;
      _usingSdCard = false;
      setBackupTargetDirs({
        backupsDir: INTERNAL_BACKUPS_DIR,
        settingsBackupsDir: INTERNAL_SETTINGS_BACKUPS_DIR,
      });
      if (!fs.existsSync(REC_DIR)) fs.mkdirSync(REC_DIR, { recursive: true });
    } else {
      slog('ERROR', `ディレクトリ作成に失敗しました: ${dir} - ${e.message}`);
    }
  }
});

function sanitizeFolderName(str) {
  if (!str) return 'unknown';
  return String(str)
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 80) || 'unknown';
}

function getRecordingTypeLabel(meta) {
  const text = `${(meta && meta.reason) || ''} ${(meta && meta.action) || ''}`;
  if (/checkout/i.test(text)) return '貸出';
  if (/return/i.test(text)) return '返却';
  return '記録';
}

function parseSessionTimestamp(sessionId) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/.exec(sessionId || '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return { date: `${y}-${mo}-${d}`, time: `${h}-${mi}-${s}` };
}

function getRecordingFolder(sessionId, deviceId, userName, meta) {
  const devicePart = sanitizeFolderName(deviceId || '_pending');
  const recordingGroup = 'recordings';
  if (meta) {
    const ts = parseSessionTimestamp(sessionId);
    const typeLabel = getRecordingTypeLabel(meta);
    const shortId = String(sessionId || '').split('_').pop() || sessionId;
    const label = ts
      ? `${ts.date}_${typeLabel}_${ts.time}-${shortId}`
      : `${typeLabel}_${sessionId}`;
    return path.join(REC_DIR, devicePart, recordingGroup, sanitizeFolderName(label));
  }
  return path.join(REC_DIR, devicePart, recordingGroup, sessionId);
}

async function findRecordingFolder(sessionId) {
  async function walk(dir, depth) {
    if (depth > 5) return null;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return null;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const fp = path.join(dir, ent.name);
      let files;
      try { files = await fsp.readdir(fp); } catch (e) { continue; }
      const hasSession = files.some(f =>
        f === `rec_${sessionId}_cam.webm` ||
        f === `rec_${sessionId}_cam.mp4` ||
        f === `rec_${sessionId}.json`
      );
      if (hasSession) return fp;
      const found = await walk(fp, depth + 1);
      if (found) return found;
    }
    return null;
  }
  let found = await walk(REC_DIR, 0);
  if (found) return found;
  // 外部ストレージ使用中でも、切替前に内部で録画したデータへアクセスできるようにする
  if (_usingSdCard && INTERNAL_REC_DIR !== REC_DIR) {
    return walk(INTERNAL_REC_DIR, 0);
  }
  return null;
}

const REQUEST_TIMEOUT_MS = 60_000;
const SYNC_REQUEST_TIMEOUT_MS = 150_000;

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9_\-]/g, '');
}

// パスワードや共有シークレットの比較には、通常の === ではなく
// 定数時間比較を使う(文字列の一致・不一致の判定にかかる時間差から
// 内容を推測される、タイミング攻撃のリスクを避けるため)。
// 長さが異なる場合も、それ自体が外部から観測できる時間差にならないよう
// 常に同じ長さのダミー比較を行ってから false を返す。
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bufB = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isPathSafe(base, target) {
  const t = target.startsWith('/') ? target.slice(1) : target;
  const resolved = path.resolve(base, t);
  const normalized = path.normalize(resolved);
  return normalized.startsWith(path.resolve(base) + path.sep) || normalized === path.resolve(base);
}

// パスのパーセントデコードは lib/safe-decode.js の safeDecodePath を使う
// (不正な % 列でHTTP 500にならないよう、呼び出し側で400を返す)。
const _SERVABLE_STATIC_EXTS = new Set(['.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.json', '.bin']);

function _isServableStaticPath(p) {
  const normalized = p.replace(/\\/g, '/');
  const ext = path.extname(normalized).toLowerCase();
  if (!_SERVABLE_STATIC_EXTS.has(ext)) return false;
  if (ext === '.html') {
    return /^\/[a-zA-Z0-9_\-\.]+\.html$/.test(normalized);
  }
  if (ext === '.json' || ext === '.bin') {
    return /^\/model\//.test(normalized) || /^\/assets\//.test(normalized);
  }
  return /^\/(css|js|img|fonts)\//.test(normalized);
}

function normalizeDate(dob) {
  if (!dob) return '';
  const s = String(dob).trim();
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return s;
}

// RFC4180相当の最低限のCSVパーサ。
// これまでの単純な split(',') では、Excel/Googleスプレッドシートから
// エクスポートした際に生じる「ダブルクォートで囲まれた、カンマや改行を含む値」
// (例: 氏名が "山田, 太郎" のように書き出された場合)を正しく扱えず、
// 列がずれて誤った氏名・メールとして読み込まれてしまう問題があった。
// ここでは1文字ずつ状態を追いながら、引用符の中のカンマ・改行・
// エスケープされた引用符("") を正しく1つのフィールドとして扱う。
// 改行コードは \r\n / \r / \n のいずれにも対応する。
function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = content.length;

  while (i < len) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      if (ch === '\r' && content[i + 1] === '\n') i += 2;
      else i++;
      continue;
    }
    field += ch;
    i++;
  }

  // 末尾に改行が無いままファイルが終わった場合の、最後の1行を回収する
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

async function loadStudentData() {
  const csvPath = path.join(DATA_DIR, 'students.csv');

  if (fs.existsSync(csvPath)) {
    try {
      const content = (await fsp.readFile(csvPath, 'utf8')).replace(/^\uFEFF/, '');
      const rows = parseCsv(content);
      const students = [];
      for (let i = 1; i < rows.length; i++) {
        const parts = rows[i].map(s => s.trim());
        const email = parts[0];
        const name = parts[1];
        if (email && name) {
          students.push({ email, name });
        }
      }
      return students;
    } catch (e) {
      slog('ERROR', 'students.csv の読み込みに失敗しました', e.message);
    }
  }

  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    const limit = 10 * 1024 * 1024;
    req.on('data', c => {
      if (settled) return;
      body += c;
      if (Buffer.byteLength(body, 'utf8') > limit) {
        settled = true;
        req.destroy(new Error('Request body too large'));
        reject(new Error('リクエストボディが大きすぎます'));
      }
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(body); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, X-Stream-Type, X-File-Ext, X-Meta, X-Filename, Authorization');
  // 多層防御用の最低限のセキュリティヘッダー。
  // このアプリはページをiframeで埋め込む使い方を一切しないため、
  // X-Frame-Options: DENY はクリックジャッキング対策として機能に
  // 影響なく付けられる。X-Content-Type-Options: nosniff は、ブラウザが
  // レスポンスの中身からContent-Typeを勝手に推測して実行してしまう
  // (MIME スニッフィング)ことを防ぐ。
  // 注意: Content-Security-Policy は今回あえて付けていない。
  // 全リソース(フォント・marked.js・TMモデル)はローカル配信に統一しているが、
  // js/admin.js が動的生成HTML内で onclick="..." 形式のインラインハンドラを
  // 多用しているため、安全に導入するには許可リストの整備とインラインハンドラの
  // 置き換えを伴う、もう少し大きめの見直しが必要。
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

async function proxyToGas(req, res, targetUrl, bodyText) {
  const t0 = Date.now();

  // GAS 側は全アクションを同期トークンで認証する(Code.gs の doGet / doPost)。
  // ここで付け忘れると、転送対象のアクションだけがトークン不一致で
  // 弾かれるため、必ずクエリまたは本文に含めてから送る。
  const target = new URL(targetUrl);
  if (SYNC_TOKEN) target.searchParams.set('token', SYNC_TOKEN);

  let sendBody = bodyText;
  if (bodyText !== undefined) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed === 'object' && SYNC_TOKEN) {
        parsed.token = SYNC_TOKEN;
        sendBody = JSON.stringify(parsed);
      }
    } catch (_) { /* JSONでない本文はそのまま転送する(側で拒否される) */ }
  }

  const headers = {};
  if (sendBody !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(target.toString(), {
    method: req.method,
    headers,
    body: sendBody,
    redirect: 'follow'
  });

  const raw = await response.text();
  const elapsed = Date.now() - t0;
  if (elapsed > 3000) slog('WARN', `GAS応答が遅延しました: ${elapsed}ms`);
  else slog('DEBUG', `GAS応答: ${elapsed}ms`);

  const contentType = response.headers.get('content-type') || 'application/json';
  res.writeHead(response.status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
  });
  res.end(raw);
}

function json(res, status, obj) {
  if (res.writableEnded) return;
  setCors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(JSON.stringify(obj));
}

let _serial = null;
let _serialReady = false;
let _lastDoorStatus = null;
let _doorCache = {};
let _pendingCallbacks = [];
let _serialQueue = [];
let _isProcessingQueue = false;

const _unlockAuthorizations = new Map();
const UNLOCK_AUTH_TTL_MS = 60 * 1000;

function _authorizeUnlock(deviceId) {
  if (!deviceId) return;
  _unlockAuthorizations.set(deviceId, { expires: new Date(Date.now() + UNLOCK_AUTH_TTL_MS) });
}

function _consumeUnlockAuthorization(deviceId) {
  const entry = _unlockAuthorizations.get(deviceId);
  _unlockAuthorizations.delete(deviceId);
  if (!entry) return false;
  return entry.expires >= new Date();
}

setInterval(() => {
  const now = new Date();
  for (const [deviceId, entry] of _unlockAuthorizations) {
    if (entry.expires < now) _unlockAuthorizations.delete(deviceId);
  }
}, 30000).unref();

let _serialGeneration = 0;
let _reconnecting = false;
let _reconnectTimer = null;
let _queueRunId = 0;
const RECONNECT_DELAY_MS = 8000;

function _broadcastSse(payload) {
  const msg = JSON.stringify(payload);
  _sseClients.forEach(c => {
    try { c.write(`data: ${msg}\n\n`); } catch (_) { _sseClients.delete(c); }
  });
}

function _flushPendingSerialState(reason) {
  const err = new Error(reason || 'Arduino接続がリセットされました');
  const pending = _pendingCallbacks.splice(0, _pendingCallbacks.length);
  pending.forEach(cb => {
    try { cb.reject ? cb.reject(err) : null; } catch (_) { }
  });
  const queued = _serialQueue.splice(0, _serialQueue.length);
  queued.forEach(item => {
    try { item.reject(err); } catch (_) { }
  });
  _isProcessingQueue = false;
  _queueRunId++;
}

// Arduinoとの実際のシリアル通信は、別プロセス（serial-bridge.js）に完全に
// 分離している。serialport のネイティブアドオンが未接続時などに万一
// クラッシュしても、影響はその子プロセスだけに閉じ込められ、この
// メインサーバー（＝キオスク画面そのもの）は絶対に巻き添えで落ちない。
// 詳細は serial-bridge.js 冒頭のコメントを参照。

function _teardownSerial(oldChild) {
  if (!oldChild) return Promise.resolve();
  try { oldChild.removeAllListeners(); } catch (_) { }
  return new Promise(resolve => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const safety = setTimeout(() => { try { oldChild.kill('SIGKILL'); } catch (_) { } finish(); }, 1500);
    try {
      oldChild.once('exit', () => { clearTimeout(safety); finish(); });
      oldChild.kill();
    } catch (_) {
      clearTimeout(safety);
      finish();
    }
  });
}

async function initSerial() {
  if (_reconnecting) {
    slog('DEBUG', 'Arduino再接続は既に進行中のため、今回の呼び出しはスキップします');
    return;
  }
  _reconnecting = true;

  _flushPendingSerialState('Arduino再接続のため接続をリセットしました');

  const oldChild = _serial;
  _serial = null;
  _serialReady = false;
  await _teardownSerial(oldChild);
  await new Promise(r => setTimeout(r, 1200));

  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

  const myGeneration = ++_serialGeneration;
  const isCurrentGeneration = () => myGeneration === _serialGeneration;

  let child;
  try {
    child = child_process.fork(
      path.join(__dirname, 'serial-bridge.js'),
      [SERIAL_PORT_ARG || '', String(SERIAL_BAUD)],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    );
  } catch (e) {
    _reconnecting = false;
    slog('WARN', `シリアル通信プロセスの起動に失敗しました。Arduino機能は無効です: ${e.message}`);
    return;
  }

  _serial = child;

  child.on('message', async (msg) => {
    if (!isCurrentGeneration() || !msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'unavailable':
        _reconnecting = false;
        slog('WARN', `serialport モジュールが見つかりません。Arduino機能は無効です: ${msg.message || ''}`);
        slog('WARN', `有効化するには: npm install serialport`);
        break;

      case 'not_found':
        _reconnecting = false;
        slog('WARN', `Arduinoポートが見つかりません（未接続の可能性）: ${msg.message || ''}`);
        if (process.platform !== 'win32') {
          slog('INFO', 'Linuxでシリアルポートがあるのに開けない場合は dialout グループへの登録が必要です: sudo usermod -aG dialout $(whoami)');
        }
        _broadcastSse({ type: 'arduino_status', connected: false });
        _scheduleReconnect(myGeneration);
        break;

      case 'open':
        // 自動検出モードの場合、実際に開いたポート名で表示用の値を更新する
        // (管理画面の「Arduino接続」欄などに実ポート名が出るようにするため)。
        if (msg.path) SERIAL_PORT = msg.path;
        slog('INFO', `シリアルポートを開きました: ${msg.path || SERIAL_PORT}`);
        slog('DEBUG', 'Arduinoの初期化応答を待機中...');
        setTimeout(async () => {
          if (!isCurrentGeneration()) return;
          // シリアルポートが開いただけでは、MCP23017初期化まで完了したと
          // 判断できない。設定コマンドへの正常応答をArduinoの起動確認に使う。
          const initialized = await pushDoorUnlockDurationsToArduino({ allowNotReady: true });
          if (!isCurrentGeneration()) return;
          if (!initialized) {
            _serialReady = false;
            slog('ERROR', 'Arduinoの初期化応答を確認できません。未接続として再試行します。');
            _broadcastSse({ type: 'arduino_status', connected: false });
            _scheduleReconnect(myGeneration);
            return;
          }

          _serialReady = true;
          _reconnecting = false;
          slog('INFO', 'Arduinoの初期化応答を確認しました。解錠通信を開始します。');
          _broadcastSse({ type: 'arduino_status', connected: true });
          try {
            const status = await getAllDoorStatus();
            if (isCurrentGeneration() && status && status.doors) {
              _doorCache = status.doors;
              const anyOpen = Object.values(status.doors).some(v => v === 'open');
              _lastDoorStatus = anyOpen ? 'open' : 'closed';
              slog('DEBUG', '再接続後に扉状態を再取得し、キャッシュを最新化しました');
            }
          } catch (e) {
            slog('WARN', `再接続後の扉状態再取得に失敗しました: ${e.message}`);
          }
        }, 2000);
        break;

      case 'error':
        _serialReady = false;
        slog('WARN', `シリアルポートエラー: ${msg.message || ''}`);
        _flushPendingSerialState('Arduinoでシリアルポートエラーが発生しました: ' + (msg.message || ''));
        _broadcastSse({ type: 'arduino_status', connected: false });
        _scheduleReconnect(myGeneration);
        break;

      case 'close':
        _serialReady = false;
        slog('WARN', 'シリアルポートが閉じられました。再接続を試みます...');
        _flushPendingSerialState('Arduinoのシリアルポートが閉じられました');
        _broadcastSse({ type: 'arduino_status', connected: false });
        _scheduleReconnect(myGeneration);
        break;

      case 'line':
        _handleSerialLine(String(msg.data ?? ''));
        break;

      case 'write_error':
        slog('WARN', `Arduinoへの書き込みに失敗しました: ${msg.message || ''}`);
        break;
    }
  });

  // 子プロセスが（正常終了・クラッシュ問わず）落ちても、ここで検知して
  // 再接続を試みるだけ。メインプロセスには一切影響しない。
  child.on('exit', (code, signal) => {
    if (!isCurrentGeneration()) return;
    if (_serialReady || _reconnecting) {
      const reason = signal ? `シグナル ${signal} で終了` : `終了コード ${code}`;
      slog('WARN', `シリアル通信プロセスが終了しました（${reason}）。再接続します...`);
    }
    _serialReady = false;
    _flushPendingSerialState('シリアル通信プロセスが終了しました');
    _broadcastSse({ type: 'arduino_status', connected: false });
    _scheduleReconnect(myGeneration);
  });

  child.on('error', (err) => {
    if (!isCurrentGeneration()) return;
    slog('WARN', `シリアル通信プロセスでエラーが発生しました: ${err.message}`);
  });
}

function _scheduleReconnect(fromGeneration) {
  if (fromGeneration !== _serialGeneration) return;
  if (_reconnectTimer) return;
  _reconnecting = false;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    initSerial();
  }, RECONNECT_DELAY_MS);
}

function _handleSerialLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let finalMsg = trimmed;
  let isSpontaneous = false;
  let hasValidChecksum = false;
  if (/^\[SENSOR\]/.test(trimmed) || /ロック\d/.test(trimmed) || /GPB\d/.test(trimmed)) {
    finalMsg = trimmed;
    isSpontaneous = true;
  } else {
    const csMatch = trimmed.match(/^(.*):([0-9A-Fa-f])$/);
    if (csMatch) {
      const msg = csMatch[1];
      const checksum = csMatch[2].toUpperCase();
      let sum = 0;
      for (let i = 0; i < msg.length; i++) sum += msg.charCodeAt(i);
      const expected = (sum % 16).toString(16).toUpperCase();
      if (checksum !== expected) {
        slog('WARN', `Arduino受信チェックサム不一致: "${trimmed}" (期待: ${expected})`);
        return;
      }
      hasValidChecksum = true;
      finalMsg = msg.trim();
    }
  }

  slog('DEBUG', `Arduino受信: "${finalMsg}"`);

  if (finalMsg === 'closed' || finalMsg === 'open') {
    if (_lastDoorStatus !== finalMsg) {
      slog('DEBUG', `[Door] 全体状態が変化しました: ${finalMsg}`);
      _lastDoorStatus = finalMsg;
    }
  }

  if (/^\[ERROR\]/.test(finalMsg) || /^\[WARN\]/.test(finalMsg)) {
    const level = /^\[ERROR\]/.test(finalMsg) ? 'ERROR' : 'WARN';
    slog(level, `Arduinoからのハードウェア通知: ${finalMsg}`);
  }

  const m = finalMsg.match(/\[SENSOR\] ロック(\d{1,2}): (open|closed)/);
  if (m) {
    const lockNum = parseInt(m[1], 10);
    const state = m[2];
    const deviceId = ALL_DEVICES[lockNum - 1] || `CB-${String(lockNum).padStart(2, '0')}`;
    if (_doorCache[deviceId] !== state) {
      slog('DEBUG', `[Door] ${deviceId} の状態が変化しました: ${state}`);
      _doorCache[deviceId] = state;
      const msg = JSON.stringify({ type: 'door_change', deviceId, state });
      _sseClients.forEach(c => {
        try { c.write(`data: ${msg}\n\n`); } catch (_) { _sseClients.delete(c); }
      });
    }
  }

  if (hasValidChecksum && !isSpontaneous && _pendingCallbacks.length > 0) {
    const cb = _pendingCallbacks.shift();
    cb.resolve(finalMsg);
  }
}

function _rawSerialSendRecv(cmd, timeoutMs, allowNotReady = false) {
  return new Promise((resolve, reject) => {
    if ((!_serialReady && !allowNotReady) || !_serial) {
      return reject(new Error('Arduino未接続'));
    }

    const myGeneration = _serialGeneration;
    const targetSerial = _serial;

    let timer;
    let settled = false;

    const entry = {
      resolve: line => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (myGeneration !== _serialGeneration) {
          reject(new Error('Arduino再接続により応答を待てませんでした'));
          return;
        }
        resolve(line);
      },
      reject: err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    };

    timer = setTimeout(() => {
      if (settled) return;
      const idx = _pendingCallbacks.indexOf(entry);
      if (idx >= 0) _pendingCallbacks.splice(idx, 1);
      entry.reject(new Error('Arduinoの応答タイムアウト'));
    }, timeoutMs);

    _pendingCallbacks.push(entry);

    let sum = 0;
    for (let i = 0; i < cmd.length; i++) sum += cmd.charCodeAt(i);
    const checksum = (sum % 16).toString(16).toUpperCase();
    const finalCmd = `${cmd}:${checksum}\n`;

    // targetSerial は子プロセス（serial-bridge.js）。実際の書き込みは
    // IPC 経由で行う（ネイティブserialportの呼び出しは全て子プロセス側）。
    try {
      targetSerial.send({ type: 'write', data: finalCmd });
    } catch (err) {
      const idx = _pendingCallbacks.indexOf(entry);
      if (idx >= 0) _pendingCallbacks.splice(idx, 1);
      entry.reject(err);
    }
  });
}

async function _processSerialQueue() {
  if (_isProcessingQueue || _serialQueue.length === 0) return;
  _isProcessingQueue = true;
  const myRunId = ++_queueRunId;

  while (_serialQueue.length > 0) {
    if (myRunId !== _queueRunId) return;

    const { cmd, timeoutMs, retries, allowNotReady, resolve, reject } = _serialQueue.shift();
    let attempt = 0;
    let success = false;
    let lastErr = null;

    while (attempt <= retries && !success) {
      try {
        const reply = await _rawSerialSendRecv(cmd, timeoutMs, allowNotReady);
        resolve(reply);
        success = true;
      } catch (e) {
        lastErr = e;
        attempt++;
        if (attempt <= retries) {
          slog('WARN', `Arduino通信リトライ (${attempt}/${retries}): ${e.message}`);
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }

    if (myRunId !== _queueRunId) return;

    if (!success) {
      reject(lastErr);
    }
  }

  _isProcessingQueue = false;
}

function serialSendRecv(cmd, timeoutMs = 2000, retries = 2, { allowNotReady = false } = {}) {
  return new Promise((resolve, reject) => {
    _serialQueue.push({ cmd, timeoutMs, retries, allowNotReady, resolve, reject });
    _processSerialQueue();
  });
}

async function getDoorStatus() {
  const line = await serialSendRecv('s', 1500);
  if (line === 'closed' || line === 'open') return line;
  throw new Error(`想定外の応答: ${line}`);
}

async function getAllDoorStatus() {
  const line = await serialSendRecv('d', 2000);
  try {
    const parsed = JSON.parse(line);
    if (parsed && parsed.doors) return parsed;
    throw new Error('doorsキーがありません');
  } catch (e) {
    throw new Error(`全扉状態のパース失敗: ${line}`);
  }
}

function execFFmpeg(args) {
  return new Promise((resolve, reject) => {
    let cmd = 'ffmpeg';
    let finalArgs = args;

    if (process.platform !== 'win32') {
      cmd = 'nice';
      finalArgs = ['-n', '15', 'ffmpeg', ...args];
    }

    const proc = child_process.spawn(cmd, finalArgs);
    const taskId = `ffmpeg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    _activeFFmpegTasks.add(taskId);

    let out = '', err = '';
    if (proc.stdout) proc.stdout.on('data', d => out += d.toString());
    if (proc.stderr) proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      _activeFFmpegTasks.delete(taskId);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`ffmpeg exited ${code}: ${err.split('\n').slice(-6).join('\n')}`));
    });
    proc.on('error', e => reject(e));
  });
}

async function _collectRecordingFoldersIn(root) {
  const results = [];
  async function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const fp = path.join(dir, ent.name);
      let inner;
      try { inner = await fsp.readdir(fp); } catch (e) { continue; }
      let sessionId = null;
      for (const f of inner) {
        let m = f.match(/^rec_(.+?)_cam\.(webm|mp4)$/);
        if (m) { sessionId = m[1]; break; }
        m = f.match(/^rec_(.+)\.json$/);
        if (m) { sessionId = m[1]; break; }
      }
      if (sessionId) {
        let mtime = 0;
        try {
          const stats = await Promise.all(inner.map(f => fsp.stat(path.join(fp, f))));
          mtime = Math.max(...stats.map(s => s.mtime.getTime()));
        } catch (e) { }
        results.push({ sessionId, folder: fp, mtime });
      } else {
        await walk(fp, depth + 1);
      }
    }
  }
  await walk(root, 0);
  return results;
}

async function _listAllRecordingFolders() {
  const results = [];
  // 外部ストレージ使用中でも、切替前に内部で録画したデータを一覧に含める
  const roots = [REC_DIR];
  if (_usingSdCard && INTERNAL_REC_DIR !== REC_DIR) roots.push(INTERNAL_REC_DIR);
  for (const root of roots) {
    const found = await _collectRecordingFoldersIn(root);
    results.push(...found);
  }

  // 同じセッションIDは新しい方を優先して重複を除去する
  const byId = new Map();
  for (const r of results) {
    const prev = byId.get(r.sessionId);
    if (!prev || r.mtime > prev.mtime) byId.set(r.sessionId, r);
  }
  return Array.from(byId.values());
}

async function _dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const ent of entries) {
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      total += await _dirSize(fp);
    } else {
      try { total += (await fsp.stat(fp)).size; } catch (e) { }
    }
  }
  return total;
}

// 直近この間更新されたファイルは「書き込み・変換中」とみなして移行を後回しにする
const MIGRATE_FRESH_MS = 60 * 1000;
let _migrating = new Set(); // 移行処理の二重実行防止(複数の非同期イベント対応)

// 移行処理の現在の進捗。管理画面(録画データタブ)が /recordings/migration-status
// 経由で2秒ごとにポーリングして、進行中の作業内容・件数・失敗を表示する。
let _migrateStats = {
  running: false,
  phase: '',          // 'prep' | 'recordings' | 'backups'
  phaseLabel: '',
  current: '',        // 現在処理中の項目名（録画フォルダのセッションID / バックアップファイル名）
  currentKind: '',    // 'recording' | 'backup'
  done: 0,
  total: 0,
  skipped: 0,
  failed: 0,
  summary: '',
  startedAt: 0,
  finishedAt: 0
};

const MIGRATE_PHASE_LABELS = {
  prep: '移行対象を調べています',
  recordings: '録画ファイルを移行中',
  backups: 'バックアップファイルを移行中'
};

async function _listStableBackupFiles(dir, nameRe) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !nameRe.test(ent.name)) continue;
    try {
      const st = await fsp.stat(path.join(dir, ent.name));
      // 移行後に保持日数(保持件数)ベースの自動削除が正しく働くよう、
      // 元の atime/mtime も保存する
      out.push({ name: ent.name, src: path.join(dir, ent.name), size: st.size, mtimeMs: st.mtimeMs, atime: st.atime, mtime: st.mtime });
    } catch (e) { }
  }
  return out;
}

// フォルダを再帰コピーする。fs.cp がある環境はタイムスタンプ毎に維持したまま。
// 古いNodeでは手動再帰にフォールバックする。
async function _copyTree(src, dest) {
  if (typeof fsp.cp === 'function') {
    await fsp.cp(src, dest, { recursive: true, preserveTimestamps: true });
    return;
  }
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      await _copyTree(s, d);
    } else {
      await fsp.copyFile(s, d);
      const st = await fsp.stat(s);
      await fsp.utimes(d, st.atime, st.mtime);
    }
  }
}

// 外部USB/SDが無い間に内部ストレージへ退避されたデータ（録画・DBバックアップ・
// 設定バックアップ）を、外部ストレージへ移行する。
// ・移行失敗したものは内部に残し（消さず）、次の監視タイミングで再試行する。
// ・コピー先に同名のデータがある場合はスキップ（既に外部にある）。
// ・書き込み・変換中（直近更新）のものは安全のため移行しない。
async function _migrateInternalToExternal() {
  if (_migrating.has('running')) return;
  if (!EXTERNAL_ROOT || REC_DIR !== path.join(EXTERNAL_ROOT, 'recordings')) return;
  _migrating.add('running');
  const now = Date.now();
  const movedDirs = [], movedFiles = [], failed = [];
  const skipNote = [];

  try {
    // 進捗表示を始める前に、まず処理対象があるかどうかを確認する。
    // ここで0件なら以降は一切触らずに抜ける（内部/外部どちらにも保存物が
    // 無いのに「移行中」の表示が一瞬でも出てしまう不具合を防ぐため。この
    // 関数は30秒ごとの定期監視からも呼ばれるが、対象0件なら画面には
    // 何の影響も与えない静かなチェックで終わる）。
    const folders = await _collectRecordingFoldersIn(INTERNAL_REC_DIR);
    const dbBackups = await _listStableBackupFiles(INTERNAL_BACKUPS_DIR, BACKUP_NAME_RE);
    const settingsBackups = await _listStableBackupFiles(INTERNAL_SETTINGS_BACKUPS_DIR, SETTINGS_BACKUP_NAME_RE);
    const total = folders.length + dbBackups.length + settingsBackups.length;
    if (total === 0) return;

    // --- ここでようやく進捗表示を開始する（対象が実際にある場合のみ） ---
    _migrateStats.running = true;
    _migrateStats.startedAt = now;
    _migrateStats.finishedAt = 0;
    _migrateStats.phase = 'prep';
    _migrateStats.phaseLabel = MIGRATE_PHASE_LABELS.prep;
    _migrateStats.current = '';
    _migrateStats.currentKind = '';
    _migrateStats.done = 0;
    _migrateStats.skipped = 0;
    _migrateStats.failed = 0;
    _migrateStats.summary = '';
    _migrateStats.total = total;

    const markStep = (kind, current) => {
      _migrateStats.currentKind = kind;
      _migrateStats.current = current;
      _migrateStats.done++;
    };

    // 1) 録画フォルダ
    if (folders.length) {
      _migrateStats.phase = 'recordings';
      _migrateStats.phaseLabel = MIGRATE_PHASE_LABELS.recordings;
    }
    for (const f of folders) {
      if (f.mtime > now - MIGRATE_FRESH_MS) {
        _migrateStats.skipped++;
        markStep('recording', f.sessionId);
        skipNote.push(`${f.sessionId}（書き込み中）`);
        continue;
      }
      const destFolder = path.join(REC_DIR, path.relative(INTERNAL_REC_DIR, f.folder));
      if (fs.existsSync(destFolder)) {
        _migrateStats.skipped++;
        markStep('recording', f.sessionId);
        skipNote.push(`${f.sessionId}（既に外部にある）`);
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(destFolder), { recursive: true });
        await _copyTree(f.folder, destFolder);
        const srcSize = await _dirSize(f.folder);
        const dstSize = await _dirSize(destFolder);
        if (srcSize === dstSize) {
          await fsp.rm(f.folder, { recursive: true, force: true });
          movedDirs.push(f.sessionId);
        } else {
          await fsp.rm(destFolder, { recursive: true, force: true }).catch(() => { });
          _migrateStats.failed++;
          failed.push(`${f.sessionId}（サイズ不一致）`);
        }
      } catch (e) {
        await fsp.rm(destFolder, { recursive: true, force: true }).catch(() => { });
        _migrateStats.failed++;
        failed.push(`${f.sessionId}（${e.message}）`);
      }
      markStep('recording', f.sessionId);
    }

    // 2) DBバックアップ
    if (dbBackups.length) {
      _migrateStats.phase = 'backups';
      _migrateStats.phaseLabel = MIGRATE_PHASE_LABELS.backups;
    }
    const moveBackupFile = async (file, isSettings) => {
      if (file.mtimeMs > now - MIGRATE_FRESH_MS) {
        _migrateStats.skipped++;
        markStep('backup', file.name);
        skipNote.push(`${file.name}（書き込み中）`);
        return;
      }
      const dest = path.join(getBackupDir(), file.name);
      if (fs.existsSync(dest)) {
        _migrateStats.skipped++;
        markStep('backup', file.name);
        skipNote.push(`${file.name}（既に外部にある）`);
        return;
      }
      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(file.src, dest);
        await fsp.utimes(dest, file.atime, file.mtime);
        const dstSt = await fsp.stat(dest);
        if (dstSt.size === file.size) {
          await fsp.unlink(file.src);
          movedFiles.push(file.name);
        } else {
          await fsp.unlink(dest).catch(() => { });
          _migrateStats.failed++;
          failed.push(`${file.name}（サイズ不一致）`);
        }
      } catch (e) {
        await fsp.unlink(dest).catch(() => { });
        _migrateStats.failed++;
        failed.push(`${file.name}（${e.message}）`);
      }
      markStep('backup', file.name);
    };
    for (const file of dbBackups) await moveBackupFile(file, false);
    for (const file of settingsBackups) await moveBackupFile(file, true);
  } finally {
    _migrating.delete('running');
  }

  const totalMoved = movedDirs.length + movedFiles.length;
  _migrateStats.running = false;
  _migrateStats.finishedAt = Date.now();
  _migrateStats.current = '';
  _migrateStats.summary =
    `録画 ${movedDirs.length}件 / バックアップ ${movedFiles.length}件を移行しました` +
    (_migrateStats.skipped ? `（スキップ ${_migrateStats.skipped}件）` : '') +
    (failed.length ? `（失敗 ${failed.length}件: ${failed.join(', ')}）` : '');
  if (totalMoved > 0 || failed.length > 0) {
    slog('INFO',
      `[Migrate] 外部ストレージへ移行しました: 録画 ${movedDirs.length}件 / バックアップ ${movedFiles.length}件` +
      (failed.length ? `（失敗 ${failed.length}件は内部に保持します: ${failed.join(', ')}）` : '')
    );
  }
}

// 管理画面（録画データ / バックアップ タブ）に「内部ストレージに残っていて
// まだ外部USB/SDへ移行できていない件数」を見せるための集計。
// _migrateInternalToExternal() 本体とは別に、読み取り専用で数えるだけの
// 軽量関数として分離する(バックグラウンドの30秒監視とは独立に、画面を
// 開いた時点の最新値をいつでも取得できるようにするため)。
async function _countPendingInternalMigration() {
  const zero = { recordings: 0, dbBackups: 0, settingsBackups: 0, total: 0 };
  // 外部ストレージを使っていない(内部が正の保存先の)ときは「移行待ち」という
  // 概念自体が存在しないため、常に0件を返す。
  if (!EXTERNAL_ROOT) return zero;

  try {
    const [folders, dbBackups, settingsBackups] = await Promise.all([
      _collectRecordingFoldersIn(INTERNAL_REC_DIR),
      _listStableBackupFiles(INTERNAL_BACKUPS_DIR, BACKUP_NAME_RE),
      _listStableBackupFiles(INTERNAL_SETTINGS_BACKUPS_DIR, SETTINGS_BACKUP_NAME_RE),
    ]);
    const recordings = folders.length;
    const total = recordings + dbBackups.length + settingsBackups.length;
    return { recordings, dbBackups: dbBackups.length, settingsBackups: settingsBackups.length, total };
  } catch (e) {
    slog('WARN', `[Migrate] 移行待ち件数の集計に失敗しました: ${e.message}`);
    return zero;
  }
}

async function _pruneOldRecordingsByRetention() {
  try {
    const settings = getCurrentSettings();
    // 管理画面の「録画の自動削除（日数超過分）」トグルと連動させる。
    // 無効にしているのに日数だけで削除が走るのを防ぐ。
    if (settings && settings.recordingRetentionEnabled === false) return;
    const days = settings && settings.recordingRetentionDays;
    if (!days || days <= 0) return;

    const folders = await _listAllRecordingFolders();
    const threshold = Date.now() - days * 86400000;
    let deletedCount = 0;
    for (const f of folders) {
      if (f.mtime && f.mtime < threshold) {
        try {
          await fsp.rm(f.folder, { recursive: true, force: true });
          deletedCount++;
          slog('DEBUG', `[Prune/日数] 古い録画を削除: ${f.sessionId} (${days}日超)`);
        } catch (e) {
          slog('WARN', `[Prune/日数] 削除失敗: ${f.sessionId} - ${e.message}`);
        }
      }
    }
    if (deletedCount > 0) slog('INFO', `[Prune/日数] ${days}日以上前の録画 ${deletedCount} 件を削除しました`);
  } catch (e) {
    slog('ERROR', `[Prune/日数] 削除エラー: ${e.message}`);
  }
}

const CAPACITY_MIN_FREE_BYTES = 500 * 1024 * 1024;
const CAPACITY_TARGET_FREE_BYTES = 1.5 * 1024 * 1024 * 1024;

async function _getFreeDiskBytes() {
  try {
    if (fs.promises.statfs) {
      const s = await fs.promises.statfs(REC_DIR);
      return s.bavail * s.bsize;
    }
  } catch (e) { }
  return null;
}

async function _pruneByCapacity() {
  try {
    const free = await _getFreeDiskBytes();
    if (free === null) return;
    if (free >= CAPACITY_MIN_FREE_BYTES) return;

    slog('WARN', `[Prune/容量] 空き容量が少なくなっています (${(free / 1024 / 1024).toFixed(0)}MB)。古い録画から削除します。`);

    const folders = await _listAllRecordingFolders();
    folders.sort((a, b) => a.mtime - b.mtime);

    let freed = 0;
    let deletedCount = 0;
    for (const f of folders) {
      const currentFree = free + freed;
      if (currentFree >= CAPACITY_TARGET_FREE_BYTES) break;
      const size = await _dirSize(f.folder);
      try {
        await fsp.rm(f.folder, { recursive: true, force: true });
        freed += size;
        deletedCount++;
        slog('DEBUG', `[Prune/容量] 容量確保のため削除: ${f.sessionId} (${(size / 1024 / 1024).toFixed(1)}MB)`);
      } catch (e) {
        slog('WARN', `[Prune/容量] 削除失敗: ${f.sessionId} - ${e.message}`);
      }
    }
    if (deletedCount > 0) {
      slog('INFO', `[Prune/容量] 容量不足のため古い録画 ${deletedCount} 件を削除しました（解放: ${(freed / 1024 / 1024).toFixed(0)}MB）`);
    } else {
      slog('WARN', '[Prune/容量] 空き容量が少ないですが、削除できる録画がありませんでした');
    }
  } catch (e) {
    slog('ERROR', `[Prune/容量] 削除エラー: ${e.message}`);
  }
}

// meta.json が無い（ファイナライズされていない）フォルダのうち、
// この時間以上更新がないものだけを孤立録画として削除する。
// 進行中の録画はチャンク追記でファイル更新時刻が新しいため誤削除されない。
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

async function _pruneOrphanRecordings() {
  try {
    const folders = await _listAllRecordingFolders();
    const now = Date.now();
    let orphanCount = 0;
    for (const f of folders) {
      let files;
      try { files = await fsp.readdir(f.folder); } catch (e) { continue; }
      const hasMeta = files.some(name => /^rec_.+\.json$/.test(name));
      if (!hasMeta) {
        try {
          // フォルダ内で最も新しいファイル更新時刻を確認する
          // （フォルダ自体の mtime はチャンク追記では更新されないため）
          let newest = 0;
          for (const name of files) {
            try {
              const st = await fsp.stat(path.join(f.folder, name));
              if (st.mtimeMs > newest) newest = st.mtimeMs;
            } catch (_) { }
          }
          if (newest && now - newest < ORPHAN_MIN_AGE_MS) continue;
          await fsp.rm(f.folder, { recursive: true, force: true });
          slog('DEBUG', `[Orphan] 孤立録画フォルダを削除: ${f.sessionId}`);
          orphanCount++;
        } catch (e) {
          slog('WARN', `[Orphan] 削除失敗: ${f.sessionId} - ${e.message}`);
        }
      }
    }
    if (orphanCount > 0) slog('DEBUG', `[Orphan] 孤立録画 ${orphanCount} 件を削除しました`);
    else slog('DEBUG', '[Orphan] 孤立録画なし');
  } catch (e) {
    slog('ERROR', `[Orphan] クリーンアップエラー: ${e.message}`);
  }
}

async function remuxAndConvert(sessionId, folderOverride) {
  if (!FFMPEG_AVAILABLE) {
    slog('DEBUG', `ffmpeg が利用できないため、動画の変換をスキップします (${sessionId})`);
    return;
  }
  try {
    const folder = folderOverride || await findRecordingFolder(sessionId) || REC_DIR;
    const srcMp4 = path.join(folder, `rec_${sessionId}_cam.mp4`);
    if (fs.existsSync(srcMp4)) {
      slog('DEBUG', `MP4録画済みのため変換をスキップ: ${path.basename(srcMp4)}`);
      return;
    }
    const src = path.join(folder, `rec_${sessionId}_cam.webm`);
    if (!fs.existsSync(src)) return;
    const tmp = src + '.fixed.webm';
    try {
      slog('DEBUG', `動画の修復を開始: ${path.basename(src)}`);
      await execFFmpeg(['-y', '-i', src, '-c', 'copy', tmp]);
      await fsp.rename(tmp, src);
      slog('DEBUG', `動画の修復が完了: ${path.basename(src)}`);
    } catch (e) {
      slog('WARN', `動画の修復に失敗 (${path.basename(src)}): ${e.message}`);
      try { if (fs.existsSync(tmp)) await fsp.unlink(tmp); } catch (_) { }
    }
    const outMp4 = path.join(folder, `rec_${sessionId}_cam.mp4`);
    try {
      slog('DEBUG', `MP4変換を開始: ${path.basename(outMp4)}`);
      await execFFmpeg(['-y', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outMp4]);
      slog('DEBUG', `MP4変換が完了: ${path.basename(outMp4)}`);
      try {
        await fsp.unlink(src);
        slog('DEBUG', `変換元webmを削除しました: ${path.basename(src)}`);
      } catch (e) {
        slog('WARN', `変換元webmの削除に失敗: ${e.message}`);
      }
    } catch (e) {
      slog('WARN', `MP4変換に失敗 (${path.basename(src)}): ${e.message}`);
      try { if (fs.existsSync(outMp4)) await fsp.unlink(outMp4); } catch (_) { }
    }
  } catch (e) {
    slog('ERROR', `動画処理中にエラーが発生しました (${sessionId}): ${e.message}`);
  }
}

function verifySession(req, queryToken, allowDefaultPassword = false) {
  const auth = req.headers['authorization'] || '';
  const headerToken = auth.replace('Bearer ', '');
  const token = headerToken || queryToken || '';
  if (!token || !_adminSessions.has(token)) return false;

  const session = _adminSessions.get(token);
  if (session.expires < new Date()) {
    _adminSessions.delete(token);
    return false;
  }

  session.expires = new Date(Date.now() + SESSION_TTL);
  return true;
}

let _restoreInProgress = false;
let _activeMutationRequests = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();
  const isRestoreRequest = method === 'POST' && url.pathname === '/backups/restore';

  setCors(res);

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (_restoreInProgress && isRestoreRequest) {
    return json(res, 409, { ok: false, error: '別のデータベース復元が進行中です' });
  }
  if (_restoreInProgress) {
    return json(res, 503, { ok: false, error: 'データベースを復元中です。サーバーの再起動後に再接続してください。' });
  }

  const isMutationRequest = method !== 'GET' && method !== 'HEAD';
  if (isMutationRequest) {
    _activeMutationRequests++;
    let completed = false;
    const markCompleted = () => {
      if (completed) return;
      completed = true;
      _activeMutationRequests--;
    };
    res.once('finish', markCompleted);
    res.once('close', markCompleted);
  }

  slog('DEBUG', `${method} ${url.pathname}`);

  // CSRF 対策。書き込み系のリクエストが別オリジンのページから飛んでいたら
  // ここで拒否する。Sec-Fetch-Site は JavaScript から偽装できないヘッダー
  // なので、iFrame や img タグで副作用だけを起こす手口も防げる。
  // 同一オリジンのキオスク操作は same-origin になり、curl などの
  // 外部ツールはヘッダーを持たないため、従来どおり通る。
  const _secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (method !== 'GET' && method !== 'HEAD' && _secFetchSite === 'cross-site') {
    slog('WARN', `別オリジンからの書き込み要求を拒否: ${method} ${url.pathname}`);
    return json(res, 403, { ok: false, error: 'このリクエストは受け付けられません' });
  }

  try {
    let _timedOut = false;
    const requestTimeout = url.pathname === '/api/sync-now'
      ? SYNC_REQUEST_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS;
    req.setTimeout(requestTimeout, () => {
      if (!res.writableEnded) {
        _timedOut = true;
        res.writeHead(408);
        res.end('Request Timeout');
      }
    });

    if (method === 'POST' && url.pathname === '/admin/login') {
      const rawIp = req.socket.remoteAddress || '';
      const ip = rawIp.replace(/^::ffff:/, '');
      const attempt = _loginAttempts.get(ip) || { count: 0, lockedUntil: null, _ts: Date.now() };

      if (attempt.lockedUntil && attempt.lockedUntil > new Date()) {
        const remaining = Math.ceil((attempt.lockedUntil - new Date()) / 1000);
        return json(res, 429, { ok: false, error: `安全のためログインを一時停止しています。約${remaining}秒後に再試行してください。` });
      }

      const body = await readBody(req);
      let password;
      try {
        ({ password } = JSON.parse(body));
      } catch (e) {
        slog('WARN', `管理者ログイン JSONパース失敗: ${ip} - ${e.message}`);
        return json(res, 400, { ok: false, error: 'リクエスト形式が不正です' });
      }

      if (!password) {
        return json(res, 400, { ok: false, error: 'パスワードを入力してください' });
      }

      if (timingSafeStringEqual(password, ADMIN_PASSWORD)) {
        const token = crypto.randomBytes(32).toString('hex');
        _adminSessions.set(token, { expires: new Date(Date.now() + SESSION_TTL) });
        _loginAttempts.delete(ip);
        slog('INFO', `管理者ログイン成功: ${ip}`);
        return json(res, 200, { ok: true, token });
      } else {
        attempt.count++;
        if (attempt.count >= MAX_ATTEMPTS) {
          attempt.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
          slog('WARN', `管理者ログイン失敗 (ロックアウト): ${ip}`);
        } else {
          slog('WARN', `管理者ログイン失敗 (${attempt.count}/${MAX_ATTEMPTS}): ${ip}`);
        }
        attempt._ts = Date.now();
        _loginAttempts.set(ip, attempt);
        return json(res, 401, { ok: false, error: 'パスワードが違います' });
      }
    }

    // 改善: 管理画面にセッションを明示的に終了する手段(ログアウト)が無く、
    // sessionStorageのトークンが残っている間(最大30分)は、共有端末で
    // 誰でもパスワード再入力なしに管理画面へ再アクセスできてしまっていた。
    // 離席時などに管理者が任意のタイミングでセッションを無効化できるようにする。
    if (method === 'POST' && url.pathname === '/admin/logout') {
      const auth = req.headers['authorization'] || '';
      const token = auth.replace('Bearer ', '');
      if (token) _adminSessions.delete(token);
      return json(res, 200, { ok: true });
    }

    // 管理者がキオスクの全画面ロックから抜け出すための明示的な終了。
    // Chromium の --kiosk ウィンドウはページ側の Fullscreen API では解除不能な
    // ため、サーバー（同一マシンの localhost）からキオスク用ブラウザの
    // プロセスだけを終了させる（exit-kiosk.sh）。サーバー・データは停止しない。
    // 再表示は start.sh や再ログインで行える。
    // 認証: 必ず admin セッションを要求する（生徒や未認証からの操作を防ぐ）。
    if (method === 'POST' && url.pathname === '/api/kiosk/exit') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const kioskExitScript = path.join(__dirname, 'scripts', 'exit-kiosk.sh');
      const exitPort = String(PORT);
      // 応答が画面に描画されてから閉じるよう、ブラウザ終了は少し遅らせる
      setTimeout(() => {
        child_process.execFile('/bin/bash', [kioskExitScript, exitPort], {
          timeout: 8000,
          env: Object.assign({}, process.env, { KIOSK_EXIT_PORT: exitPort })
        }, (err, stdout, stderr) => {
          if (err) slog('WARN', `キオスク終了スクリプトに失敗: ${err.message}`);
          if (stdout) slog('DEBUG', `キオスク終了出力: ${String(stdout).trim()}`);
          if (stderr) slog('WARN', `キオスク終了 stderr: ${String(stderr).trim()}`);
        });
      }, 400);
      slog('INFO', '管理者操作: キオスク画面の終了を実行');
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && url.pathname === '/api/change-admin-password') {
      // バグ修正: 他の管理系エンドポイントは全てverifySession()でセッションを
      // 確認しているが、このエンドポイントだけ確認が抜けていた。
      // 「現在のパスワード」の一致だけでは/admin/loginにある5回失敗で
      // 15分ロックアウトの仕組みを経由せずに総当たりを試行できてしまうため、
      // 他の管理APIと同様にログイン済みセッションを必須にする。
      if (!verifySession(req, undefined, true)) return json(res, 403, { ok: false, error: '認証されていません' });

      const rawIp = req.socket.remoteAddress || '';
      const ip = rawIp.replace(/^::ffff:/, '');
      const attempt = _loginAttempts.get(ip) || { count: 0, lockedUntil: null, _ts: Date.now() };
      if (attempt.lockedUntil && attempt.lockedUntil > new Date()) {
        const remaining = Math.ceil((attempt.lockedUntil - new Date()) / 1000);
        return json(res, 429, { ok: false, error: `安全のためパスワード変更を一時停止しています。約${remaining}秒後に再試行してください。` });
      }

      const body = await readBody(req);
      let currentPassword, newPassword;
      try {
        ({ currentPassword, newPassword } = JSON.parse(body));
      } catch (e) {
        return json(res, 400, { ok: false, error: 'リクエスト形式が不正です' });
      }

      if (!currentPassword || !newPassword) {
        return json(res, 400, { ok: false, error: 'パスワードを入力してください' });
      }

      if (!timingSafeStringEqual(currentPassword, ADMIN_PASSWORD)) {
        // バグ修正: 現在のパスワードの誤入力も、/admin/loginと同じ試行回数
        // カウンター(_loginAttempts)を共有してロックアウト対象にする
        // (このエンドポイント経由でのパスワード総当たりを防ぐため)。
        attempt.count++;
        if (attempt.count >= MAX_ATTEMPTS) {
          attempt.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
          slog('WARN', `管理者パスワード変更 現在のパスワード誤り (ロックアウト): ${ip}`);
        }
        attempt._ts = Date.now();
        _loginAttempts.set(ip, attempt);
        return json(res, 401, { ok: false, error: '現在のパスワードが違います' });
      }
      _loginAttempts.delete(ip);

      if (newPassword.length < 6 || newPassword.length > 12) {
        return json(res, 400, { ok: false, error: 'パスワードは6〜12桁で設定してください' });
      }

      // フロント側(js/admin.js)にも数字のみの入力チェックがあるが、
      // ここでもサーバー側で必ず検証する。ログイン画面はテンキー(0〜9)
      // でしか入力できないため、ここを通過させてしまうと、フロント側の
      // チェックをAPI直叩き等で回避された場合に、二度とログインできない
      // パスワードが設定されてしまう(管理者が完全にロックアウトされる)。
      if (!/^[0-9]+$/.test(newPassword)) {
        return json(res, 400, { ok: false, error: 'パスワードは数字のみで入力してください(ログイン画面はテンキーのため、数字以外は設定できません)' });
      }

      ADMIN_PASSWORD = newPassword;
      _adminSessions.clear();
      const persisted = writeConfigEnvValue('ADMIN_PW', newPassword);
      if (persisted) {
        slog('INFO', '管理者パスワードが変更されました(config.envに保存済み)');
        return json(res, 200, { ok: true, message: '管理者パスワードを変更しました' });
      } else {
        slog('WARN', '管理者パスワードは変更されましたが、config.envへの保存に失敗しました(次回起動時に元に戻る可能性があります)');
        return json(res, 200, {
          ok: true,
          message: '管理者パスワードを変更しました(注意: 設定ファイルへの保存に失敗したため、サーバー再起動後は元のパスワードに戻ります。手動でconfig.envのADMIN_PWを書き換えてください)',
          persistWarning: true
        });
      }
    }

    if (method === 'GET' && url.pathname === '/ffmpeg-status') {
      const info = FFMPEG_AVAILABLE ? {
        ok: true,
        version: FFMPEG_VERSION,
        activeTasks: _activeFFmpegTasks.size
      } : {
        ok: false,
        error: 'ffmpeg が見つかりません'
      };
      return json(res, 200, info);
    }


    if (method === 'POST' && url.pathname === '/students/lookup') {
      const body = await readBody(req);
      try {
        const { email } = JSON.parse(body);
        if (!email) {
          return json(res, 400, { ok: false, error: 'メールアドレスが必要です' });
        }

        const students = await loadStudentData();
        if (!students) {
          return json(res, 500, { ok: false, error: '学生データファイル (students.csv) が見つかりません' });
        }

        const student = students.find(s => String(s.email) === String(email));

        if (student) {
          slog('DEBUG', `[Lookup] 学生が見つかりました: ${student.name} (${email})`);
          return json(res, 200, { ok: true, name: student.name });
        } else {
          slog('WARN', `[Lookup] 一致する学生が見つかりません: Email=${email}`);
          return json(res, 404, { ok: false, error: 'メールアドレスが正しくありません。名簿に登録されていない可能性があります。' });
        }
      } catch (e) {
        return json(res, 400, { ok: false, error: 'リクエストの解析に失敗しました' });
      }
    }

    if (method === 'POST' && url.pathname === '/arduino/open') {
      if (!_serialReady) {
        slog('WARN', '解錠要求: Arduino未接続');
        return json(res, 503, { ok: false, error: 'Arduino未接続', connected: false });
      }
      const body = await readBody(req);
      let deviceId = '';
      try {
        const parsed = JSON.parse(body);
        deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : '';
      } catch (_) { }
      const lockIndex = ALL_DEVICES.indexOf(deviceId);
      if (lockIndex < 0) {
        return json(res, 400, { ok: false, error: '端末番号が不正です', connected: _serialReady });
      }

      const isAdmin = verifySession(req);
      const hasUnlockAuth = _consumeUnlockAuthorization(deviceId);
      if (!isAdmin && !hasUnlockAuth) {
        slog('WARN', `解錠要求を拒否しました（未認証・許可なし）: ${deviceId}`);
        return json(res, 403, { ok: false, error: '解錠が許可されていません', connected: _serialReady });
      }

      const cmd = `o${lockIndex + 1}`;

      try {
        const reply = await serialSendRecv(cmd, 3000);
        if (reply !== 'ok') {
          slog('ERROR', `解錠失敗: Arduinoが解錠を拒否しました (${deviceId}, 応答: "${reply}")`);
          return json(res, 502, { ok: false, error: `Arduinoが解錠を拒否しました: ${reply}`, connected: _serialReady });
        }
        slog('DEBUG', `解錠完了: ${deviceId} (送信コマンド: ${cmd}) → Arduino応答: "${reply}"`);
        return json(res, 200, { ok: true, reply });
      } catch (e) {
        slog('ERROR', `解錠失敗: ${e.message}`);
        return json(res, 500, { ok: false, error: e.message, connected: _serialReady });
      }
    }

    if (method === 'POST' && url.pathname === '/arduino/authorize') {
      if (!_serialReady) {
        return json(res, 503, {
          ok: false,
          error: 'Arduino未接続のため扉を解錠できません。貸出予約は安全のため残ります。管理者に確認してください。',
          connected: false
        });
      }
      const body = await readBody(req);
      let loanId = '', deviceId = '';
      try {
        const parsed = JSON.parse(body);
        loanId = parsed.loanId || '';
        deviceId = parsed.deviceId || '';
      } catch (_) { }

      if (!loanId || !deviceId || !ALL_DEVICES.includes(deviceId)) {
        return json(res, 400, { ok: false, error: '不正なリクエストです', connected: _serialReady });
      }

      // 貸出情報の照合は、必ずローカルSQLite(このリクエストが処理される
      // まさにこのプロセス内)に対して同期的に行う。
      //
      // 【重要】以前はここで GAS(Googleスプレッドシート)側の getLoans を
      // fetchしていたが、このシステムのアーキテクチャ上、checkoutPrepare/
      // checkoutCommit は「ローカルSQLiteへ即時書き込み → その後バックグラウンド
      // で(数秒デバウンス+ネットワーク往復を経て)スプレッドシートへミラー」
      // という順序になっている(LOCAL_WRITE_ACTIONS / syncJob.requestSync 参照)。
      // そのため、貸出直後にGAS側のgetLoansを見に行っても、ミラー同期が
      // 追いついておらず「まだ存在しない」ことが頻繁にあり、3回リトライ
      // (合計4.5秒)しても間に合わないケースが実運用で起きていた。
      // これが「貸出処理自体は成功して画面も進むのに、解錠許可だけが
      // 通らず扉が開かない」不具合の原因だった。
      // ローカルSQLiteは checkoutPrepare/Commit がこのプロセス内で同期的に
      // 書き込む「真の」データソースなので、ここを直接参照すれば
      // 待ち時間なし・タイムラグなしで正しく照合できる。
      try {
        const localLoans = (LDB.getLoans().loans) || [];
        const match = localLoans.some(l => String(l.id) === String(loanId) && String(l.deviceId) === String(deviceId));

        if (!match) {
          slog('WARN', `解錠許可を拒否しました（loanId不一致）: loanId=${loanId} deviceId=${deviceId}`);
          return json(res, 403, { ok: false, error: '貸出情報を確認できませんでした', connected: _serialReady });
        }

        const marked = LDB.markCheckoutUnlockAuthorized({ loanId, deviceId });
        if (!marked.success) {
          return json(res, 403, { ok: false, error: marked.message, connected: _serialReady });
        }
        _authorizeUnlock(deviceId);
        slog('DEBUG', `解錠許可を発行しました: ${deviceId} (loanId: ${loanId})`);
        return json(res, 200, { ok: true });
      } catch (e) {
        slog('ERROR', `解錠許可の検証に失敗しました: ${e.message}`);
        return json(res, 502, { ok: false, error: '貸出情報の確認に失敗しました', connected: _serialReady });
      }
    }

    if (method === 'GET' && url.pathname === '/arduino/status') {
      const isClosed = _lastDoorStatus === 'closed';
      return json(res, 200, {
        ok: true,
        connected: _serialReady,
        closed: isClosed,
        raw: _lastDoorStatus
      });
    }

    if (method === 'GET' && url.pathname === '/arduino/ping') {
      return json(res, 200, { ok: true, connected: _serialReady, port: SERIAL_PORT, baud: SERIAL_BAUD });
    }

    if (method === 'GET' && url.pathname === '/arduino/status/all') {
      // _doorCache は Arduino から届く生の文字列 'open' / 'closed' をそのまま
      // 保持している（js/app.js・js/ui.js は文字列のまま比較している）。
      // ここでは形式を変えずにそのまま返す。
      const doors = {};
      ALL_DEVICES.forEach(id => {
        doors[id] = _doorCache[id] || null;
      });
      return json(res, 200, {
        ok: true,
        connected: _serialReady,
        doors: doors
      });
    }

    if (method === 'GET' && url.pathname === '/arduino/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(':connected\n\n');
      _sseClients.add(res);
      req.on('close', () => {
        _sseClients.delete(res);
        res.destroy();
      });
      res.on('error', () => {
        _sseClients.delete(res);
      });
      return;
    }


    if (method === 'POST' && url.pathname === '/api/camera-alert') {
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body); } catch (_) { }
      const stripControlChars = (s) => String(s || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
      const message = stripControlChars(payload.message || 'カメラで問題が発生しました').slice(0, 300);
      const deviceContext = stripControlChars(payload.context || '').slice(0, 200);
      if (payload.status === 'ok') {
        _cameraStatus = { state: 'ok', message: '', updatedAt: new Date().toISOString() };
        slog('INFO', `キオスクカメラが利用可能です${deviceContext ? ' (' + deviceContext + ')' : ''}`);
      } else {
        _cameraStatus = { state: 'error', message, updatedAt: new Date().toISOString() };
        slog('WARN', `キオスク端末からカメラ異常の報告: ${message}${deviceContext ? ' (' + deviceContext + ')' : ''}`);
      }
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && url.pathname === '/upload') {
      const sessionId = sanitize(req.headers['x-session-id'] || '');
      const streamType = 'cam';
      const rawExt = (req.headers['x-file-ext'] || 'webm').replace(/[^a-z0-9]/g, '');
      const fileExt = (rawExt === 'mp4') ? 'mp4' : 'webm';
      if (!sessionId) {
        slog('WARN', 'セッションIDがありません。アップロードを拒否しました。');
        return json(res, 400, { ok: false, error: 'セッションIDが必要です' });
      }

      let folder = await findRecordingFolder(sessionId);
      if (!folder) folder = getRecordingFolder(sessionId, null, null);
      await fsp.mkdir(folder, { recursive: true });

      const filename = `rec_${sessionId}_${streamType}.${fileExt}`;
      const filepath = path.join(folder, filename);
      let existingSize = 0;
      try { existingSize = (await fsp.stat(filepath)).size; } catch (_) { }
      let received = 0;
      // 録画は MediaRecorder の timeslice(2秒毎)チャンクごとに /upload が複数回呼ばれ、
      // 同じセッションIDのファイルへ追記していく想定。'w' だと呼び出す度に上書きされ、
      // 最後の2秒分しか残らない致命的なバグになるため 'a'（追記）を使用する。
      const ws = fs.createWriteStream(filepath, { flags: 'a' });
      try {
        await new Promise((resolve, reject) => {
          req.on('data', chunk => {
            received += chunk.length;
            // MAX_VIDEO_SIZE は録画全体（既存の追記済みバイト数を含む）に対する上限。
            if (existingSize + received > MAX_VIDEO_SIZE) { ws.destroy(); reject(new Error('ファイルサイズ上限超過')); return; }
            ws.write(chunk);
          });
          req.on('end', () => { ws.end(); });
          req.on('error', reject);
          ws.on('error', reject);
          ws.on('finish', resolve);
        });
      } catch (e) {
        // 上限超過などで失敗した場合は、それまでに追記された録画全体を破棄する
        try { await fsp.rm(filepath, { force: true }); } catch (_) { }
        throw e;
      }
      return json(res, 200, { ok: true, filename, bytes: received });
    }

    if (method === 'POST' && url.pathname === '/finalize') {
      const body = await readBody(req);
      let sessionId, meta;
      try {
        ({ sessionId, meta } = JSON.parse(body));
      } catch (_) {
        return json(res, 400, { ok: false, error: 'リクエスト形式が不正です' });
      }
      const sid = sanitize(sessionId || '');
      if (!sid) return json(res, 400, { ok: false, error: 'セッションIDが必要です' });

      let folder = await findRecordingFolder(sid);
      if (!folder) folder = getRecordingFolder(sid, null, null);

      const targetFolder = getRecordingFolder(sid, meta && meta.deviceId, meta && meta.name, meta);
      if (folder !== targetFolder) {
        try {
          await fsp.mkdir(path.dirname(targetFolder), { recursive: true });
          await fsp.rename(folder, targetFolder);
          folder = targetFolder;
        } catch (e) {
          slog('WARN', `録画フォルダの移動に失敗しました（そのまま継続）: ${e.message}`);
        }
      }

      const metaFile = path.join(folder, `rec_${sid}.json`);
      await fsp.writeFile(metaFile, JSON.stringify({ ...meta, finalizedAt: new Date().toISOString() }, null, 2));
      slog('INFO', `録画を保存しました: ${meta.name || sid} (${folder})`);
      remuxAndConvert(sid, folder).catch(err => slog('ERROR', `変換処理エラー: ${err.message}`));
      _pruneOldRecordingsByRetention().catch(err => slog('ERROR', `[Prune] 自動削除エラー: ${err.message}`));
      _pruneByCapacity().catch(err => slog('ERROR', `[Prune] 容量不足による自動削除エラー: ${err.message}`));
      return json(res, 200, { ok: true });
    }

    if (method === 'DELETE' && url.pathname === '/recording') {
      const body = await readBody(req);
      let sessionId, reason;
      try {
        ({ sessionId, reason } = JSON.parse(body));
      } catch (_) {
        return json(res, 400, { ok: false, error: 'リクエスト形式が不正です' });
      }
      const sid = sanitize(sessionId || '');
      if (!sid) return json(res, 400, { ok: false, error: 'セッションIDが必要です' });

      if (reason === 'return') {
        slog('DEBUG', `[Recording] 返却完了のため録画は保持します（削除しません）: ${sid}`);
        return json(res, 200, { ok: true, deleted: [], kept: true });
      }

      const folder = await findRecordingFolder(sid);

      // 「保存済み（/finalize 済み = メタJSONあり）」の録画を消せるのは管理者操作のみ。
      // キオスク自身によるキャンセル/孤立録画の自己クリーンアップ（reason: cancel/orphan）は、
      // 貸出・返却フローの一部として常時発生するため、都度の管理者ログインを要求しない。
      // ただしその場合でも、対象が「まだ確定保存されていない録画」であることを
      // メタJSONの有無で確認し、保存済みの証拠映像を無認証で消せないようにする。
      let isFinalized = false;
      if (folder) {
        try {
          const files = await fsp.readdir(folder);
          isFinalized = files.some(f => f === `rec_${sid}.json`);
        } catch (_) { /* フォルダが読めない場合は未確定として扱う */ }
      }

      if (reason === 'admin' || isFinalized) {
        if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      }

      let deleted = [];
      if (folder) {
        try {
          const files = await fsp.readdir(folder);
          deleted = files;
          await fsp.rm(folder, { recursive: true, force: true });
        } catch (err) {
          slog('ERROR', `フォルダ削除失敗: ${folder}`, err.message);
        }
      }
      const msg = reason === 'cancel' ? 'キャンセルにより録画を削除' :
        reason === 'orphan' ? '孤立録画を削除' :
          reason === 'admin' ? '管理者操作により録画を削除' : '録画を削除';
      if (deleted.length > 0) {
        slog('INFO', `${msg}: ${sid}`);
      } else {
        slog('DEBUG', `${msg}（対象ファイルなし）: ${sid}`);
      }
      return json(res, 200, { ok: true, deleted });
    }

    if (method === 'GET' && url.pathname === '/logs') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証が必要です' });
      if (!fs.existsSync(LOG_FILE)) return json(res, 200, { ok: true, logs: [] });
      const raw = await fsp.readFile(LOG_FILE, 'utf8');
      const logs = raw.trim().split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      });
      return json(res, 200, { ok: true, logs });
    }

    if (method === 'GET' && url.pathname === '/api/sync-status') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証が必要です' });
      const s = getSyncStatus();
      return json(res, 200, {
        ok: true,
        enabled: !!(GAS_URL && SYNC_TOKEN),
        configurationError: GAS_URL_ERROR || '',
        lastOkAt: s.last_ok_at,
        lastError: s.last_error,
        lastErrorAt: s.last_error_at,
        consecutiveFailures: s.consecutive_failures,
        blockedEmpty: !!s.empty_sync_blocked,
        lastNonemptyCount: s.last_nonempty_count
      });
    }

    if (method === 'POST' && url.pathname === '/api/sync-now') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証が必要です' });
      if (!GAS_URL) {
        return json(res, 503, { ok: false, error: GAS_URL_ERROR || 'GAS_URLが未設定のためスプレッドシート同期は無効です' });
      }
      if (!SYNC_TOKEN) {
        return json(res, 503, { ok: false, error: 'SYNC_TOKENが未設定のためスプレッドシート同期は無効です' });
      }

      const result = await syncJob.runOnce();
      const current = getSyncStatus();
      if (!result.success && result.message === '実行中のため次回にまとめます') {
        return json(res, 202, {
          ok: true,
          queued: true,
          message: '同期処理中です。完了後にもう一度同期します。',
          lastOkAt: current.last_ok_at,
          consecutiveFailures: current.consecutive_failures
        });
      }
      if (!result.success) {
        return json(res, result.blocked ? 409 : 502, {
          ok: false,
          error: result.message || 'スプレッドシート同期に失敗しました',
          lastOkAt: current.last_ok_at,
          lastErrorAt: current.last_error_at,
          consecutiveFailures: current.consecutive_failures,
          blockedEmpty: !!current.empty_sync_blocked
        });
      }

      const updated = getSyncStatus();
      slog('INFO', '管理画面からスプレッドシートへの手動同期が完了しました');
      return json(res, 200, {
        ok: true,
        message: 'スプレッドシートへの同期が完了しました',
        lastOkAt: updated.last_ok_at,
        consecutiveFailures: updated.consecutive_failures
      });
    }

    if (method === 'POST' && url.pathname === '/logs') {
      const body = await readBody(req);
      try {
        const { level, msg, stack, ua } = JSON.parse(body);
        const logMsg = stack ? `${msg} | UA: ${ua} | STACK: ${stack}` : msg;
        slog(level || 'ERROR', logMsg);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { ok: false, error: 'Invalid JSON' });
      }
    }

    if (method === 'DELETE' && url.pathname === '/logs') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      if (fs.existsSync(LOG_FILE)) { await fsp.truncate(LOG_FILE, 0); slog('INFO', 'ログファイルをクリアしました'); }
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && url.pathname === '/settings') {
      const settings = { ...(await getCurrentSettings()) };

      // このエンドポイントは生徒キオスクからも認証なしで取得されるため、
      // 先生宛メールアドレス(通知先・定期レポート宛先)は含めない。
      // 管理画面は /api/gas の getSettings から取得する経路を利用している。
      delete settings.notifyEmailAddress;
      delete settings.teacherReportAddress;

      const local = await readLocalConfig();
      settings.assetConfig = local.assetConfig || {};
      settings.captureDeviceId = local.captureDeviceId || '';
      settings.isKiosk = true;
      settings.settingsUpdatedAt = _settingsUpdatedAt;
      settings.settingsUpdatedBy = _settingsUpdatedBy;

      // 生徒本人宛メール(貸出確認・返却確認)の送信状況。管理画面の運用設定タブで
      // GAS連携未設定・送信エラー等に気づけるようにする。
      // GAS_URL/SYNC_TOKENはスプレッドシート同期と共通のため、同期が動いていれば
      // 生徒宛メールも自動的に動く(SMTP設定は不要)。
      try {
        const queueStatus = LDB.getEmailQueueStatus();
        settings.emailStatus = {
          gasConfigured: !!(GAS_URL && SYNC_TOKEN),
          pending: queueStatus.pending,
          sent: queueStatus.sent,
          failing: queueStatus.failing,
          lastError: queueStatus.lastError
        };
      } catch (e) {
        settings.emailStatus = null;
      }

      return json(res, 200, settings);
    }

    if (method === 'GET' && url.pathname === '/settings/meta') {
      await getCurrentSettings(true);
      return json(res, 200, {
        ok: true,
        updatedAt: _settingsUpdatedAt,
        updatedBy: _settingsUpdatedBy,
        offline: !!(_settingsCache && _settingsCache._offline),
        adminPasswordLength: ADMIN_PASSWORD.length
      });
    }

    if (method === 'POST' && url.pathname === '/settings') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const body = await readBody(req);
      try {
        const incoming = JSON.parse(body);
        const { assetConfig, captureDeviceId, isKiosk, settingsUpdatedAt, settingsUpdatedBy, ...remoteFields } = incoming;

        const local = await readLocalConfig();
        if (assetConfig !== undefined) {
          local.assetConfig = assetConfig;
        }
        if (captureDeviceId !== undefined) {
          local.captureDeviceId = captureDeviceId;
        }
        await writeLocalConfig(local);

        const result = await pushSettingsLocal(remoteFields, '教室PC(管理画面)');
        slog('INFO', 'システム設定を更新しました（ローカルDBに保存、スプレッドシートへは順次同期）');
        snapshotSettingsBackup('auto'); // 復元用の世代を残す(結果は待たない)
        return json(res, 200, { ok: true, updatedAt: result.updatedAt });
      } catch (e) {
        slog('ERROR', '設定の保存に失敗しました', e.message);
        return json(res, 400, { ok: false, error: '設定の保存に失敗しました: ' + e.message });
      }
    }

    if (method === 'GET' && url.pathname === '/recordings') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const folders = await _listAllRecordingFolders();
      const recordings = [];
      for (const f of folders) {
        let files;
        try { files = await fsp.readdir(f.folder); } catch (e) { continue; }
        const metaFile = files.find(n => /^rec_.+\.json$/.test(n));
        let meta = {};
        if (metaFile) {
          try { meta = JSON.parse(await fsp.readFile(path.join(f.folder, metaFile), 'utf8')); } catch (_) { }
        }
        const streams = {};
        for (const name of files) {
          const m = name.match(/^rec_.+?_cam\.(webm|mp4)$/);
          if (!m) continue;
          const ext = m[1];
          const stat = await fsp.stat(path.join(f.folder, name));
          if (!streams.cam || ext === 'mp4') streams.cam = { size: stat.size, ext };
        }
        const relFolder = path.relative(REC_DIR, f.folder);
        recordings.push({
          sessionId: f.sessionId,
          createdAt: new Date(f.mtime || Date.now()).toISOString(),
          meta,
          streams,
          folder: relFolder
        });
      }
      recordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return json(res, 200, { ok: true, recordings });
    }

    if (method === 'DELETE' && url.pathname === '/recordings/old') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      // 日数はクエリパラメータ(?days=)で受け取る(管理画面 admin.js:1177 の仕様)。
      // 旧形式(JSONボディ)も後方互換のため引き続き受け付ける。
      let days = 30;
      const queryDays = url.searchParams.get('days');
      if (queryDays !== null) {
        days = Number(queryDays);
      } else {
        const body = await readBody(req);
        if (body) {
          try {
            const parsed = JSON.parse(body);
            if (parsed.days !== undefined) days = Number(parsed.days);
          } catch (_) {
            return json(res, 400, { ok: false, error: 'リクエスト形式が不正です' });
          }
        }
      }
      if (!Number.isFinite(days) || days <= 0) {
        return json(res, 400, { ok: false, error: '日数は1以上の数値で指定してください' });
      }
      const folders = await _listAllRecordingFolders();
      const threshold = Date.now() - days * 86400000;
      let deletedCount = 0;
      for (const f of folders) {
        if (f.mtime && f.mtime < threshold) {
          try { await fsp.rm(f.folder, { recursive: true, force: true }); deletedCount++; }
          catch (e) { slog('WARN', `[Maintenance] 削除失敗: ${f.sessionId} - ${e.message}`); }
        }
      }
      slog('DEBUG', `メンテナンス: ${days}日以上前の録画フォルダを削除 (${deletedCount}件)`);
      return json(res, 200, { ok: true, deletedCount });
    }

    // --- ローカルDBバックアップ ---
    if (method === 'GET' && url.pathname === '/backups') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const backups = await listBackups();
      return json(res, 200, { ok: true, backups, dir: getBackupDir() });
    }

    if (method === 'POST' && url.pathname === '/backups/run') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const result = await runBackup({ kind: 'manual', logger: { info: (m) => slog('INFO', m), warn: (m) => slog('WARN', m) } });
      if (!result.success) return json(res, 500, { ok: false, error: result.message });
      slog('INFO', `管理画面から手動バックアップを実行しました: ${result.filename}`);
      return json(res, 200, { ok: true, filename: result.filename });
    }

    if (method === 'POST' && url.pathname === '/backups/restore') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { return json(res, 400, { ok: false, error: 'リクエスト形式が不正です' }); }

      const name = body && typeof body.name === 'string' ? body.name : '';
      const location = body && typeof body.location === 'string' ? body.location : '';
      if (!BACKUP_NAME_RE.test(name) || !['internal', 'external'].includes(location)) {
        return json(res, 400, { ok: false, error: 'バックアップの指定が不正です' });
      }

      if (_restoreInProgress) {
        return json(res, 409, { ok: false, error: '別のデータベース復元が進行中です' });
      }
      _restoreInProgress = true;
      while (_activeMutationRequests > 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      let prepared;
      try {
        prepared = await prepareDatabaseRestore(name, location, {
          info: (message) => slog('INFO', message),
          warn: (message) => slog('WARN', message)
        });
      } catch (e) {
        _restoreInProgress = false;
        if (e && e.code === 'ENOENT') return json(res, 404, { ok: false, error: 'バックアップファイルが見つかりません' });
        if (e && e.code === 'INVALID_RESTORE_DATABASE') {
          return json(res, 400, { ok: false, error: `このバックアップは復元できません: ${e.message}` });
        }
        slog('ERROR', `DB復元の準備に失敗しました: ${e.message}`);
        return json(res, 500, { ok: false, error: `DB復元の準備に失敗しました: ${e.message}` });
      }
      if (!prepared.success) {
        _restoreInProgress = false;
        return json(res, 409, { ok: false, error: prepared.message });
      }

      slog('WARN', `管理画面からDB復元を開始します: ${name} (復元前バックアップ: ${prepared.safetyBackupFilename})`);
      json(res, 202, {
        ok: true,
        restarting: true,
        filename: prepared.filename,
        safetyBackupFilename: prepared.safetyBackupFilename
      });

      setTimeout(() => {
        server.close(() => {
          try {
            prepared.activate();
            slog('WARN', `DB復元が完了しました: ${prepared.filename}`);
            process.exit(0);
          } catch (e) {
            slog('ERROR', `DB復元に失敗しました。サービスを再起動して復旧します: ${e.message}`);
            prepared.cleanup();
            process.exit(1);
          }
        });
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, 1500);
      return;
    }

    if (method === 'GET' && url.pathname === '/backups/inspect') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const name = url.searchParams.get('name') || '';
      const location = url.searchParams.get('location') || '';
      if (!BACKUP_NAME_RE.test(name)) {
        return json(res, 400, { ok: false, error: '無効なファイル名です' });
      }
      try {
        const result = await inspectBackup(name, location);
        return json(res, 200, { ok: true, name, ...result });
      } catch (e) {
        if (e && e.code === 'ENOENT') return json(res, 404, { ok: false, error: 'バックアップファイルが見つかりません' });
        return json(res, 500, { ok: false, error: 'バックアップの中身を読み取れませんでした: ' + e.message });
      }
    }

    if (method === 'GET' && url.pathname === '/backups/download') {
      const queryToken = url.searchParams.get('token');
      if (!verifySession(req, queryToken)) return json(res, 403, { ok: false, error: '認証されていません' });
      const name = url.searchParams.get('name') || '';
      const location = url.searchParams.get('location') || '';
      // ディレクトリトラバーサル対策: ファイル名の形式を厳密に検証してから
      // resolveBackupPath() でトラバーサル不可能な安全なパスに解決する。
      // location('internal'/'external')は一覧表示(/backups)が返した値を
      // そのまま渡してもらうことで、移行待ちで内部に残っているファイルも
      // 「今どこにあるか」を取り違えずに正しく参照できる。
      let filePath;
      try {
        filePath = resolveBackupPath(name, location);
      } catch (e) {
        return json(res, 400, { ok: false, error: '無効なファイル名です' });
      }
      try {
        const stat = await fsp.stat(filePath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}; filename="${name}"`
        });
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => { try { res.destroy(); } catch (_) { } });
        stream.pipe(res);
        return;
      } catch (e) {
        return json(res, 404, { ok: false, error: 'バックアップファイルが見つかりません' });
      }
    }

    if (method === 'DELETE' && url.pathname === '/backups') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      // バグ修正: クライアント(js/admin.js の deleteBackup)は削除対象のファイル名を
      // クエリパラメータ(/backups?name=...)で送信しているが、以前はJSONボディからしか
      // 読んでいなかったため、name が常に undefined になり削除が必ず失敗していた。
      // ダウンロード(/backups/download)と同じくクエリパラメータを正としつつ、
      // ボディ経由での指定にも後方互換で対応する。
      let name = url.searchParams.get('name') || '';
      let location = url.searchParams.get('location') || '';
      if (!name) {
        const body = await readBody(req);
        try { ({ name, location } = JSON.parse(body || '{}')); name = name || ''; location = location || ''; } catch (e) {
          return json(res, 400, { ok: false, error: 'リクエスト形式が不正です' });
        }
      }
      if (!BACKUP_NAME_RE.test(name)) {
        return json(res, 400, { ok: false, error: '無効なファイル名です' });
      }
      try {
        await fsp.unlink(resolveBackupPath(name, location));
        slog('INFO', `管理画面からバックアップを削除しました: ${name}${location === 'internal' ? '(内部・移行待ち)' : ''}`);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 404, { ok: false, error: 'バックアップファイルが見つからないか、削除に失敗しました' });
      }
    }

    // 保存先ストレージの現在状態（USB/SD検出・空き容量・移行待ち件数）を組み立てる
    async function _buildStorageStatus() {
      const free = await _getFreeDiskBytes();
      const used = await _dirSize(REC_DIR).catch(() => null);
      let totalBytes = null;
      try {
        const st = await fsp.statfs(REC_DIR);
        totalBytes = st.blocks * st.bsize;
      } catch (_) { }
      const externalStorage = !!EXTERNAL_ROOT;
      const pendingMigration = await _countPendingInternalMigration();
      return {
        ok: true,
        usingSdCard: _usingSdCard,
        externalStorage,
        externalRoot: EXTERNAL_ROOT,
        recDir: REC_DIR,
        location: externalStorage ? '外部ストレージ（USB / SD）' : '内部ストレージ',
        backupsDir: getBackupDir(),
        settingsBackupsDir: getSettingsBackupDir(),
        freeBytes: free,
        totalBytes,
        recordingsUsedBytes: used,
        lowCapacityThresholdBytes: CAPACITY_MIN_FREE_BYTES,
        // 外部ストレージ使用中に限り意味を持つ値。内部使用中は常に0を返す
        // (すべてのデータがそのまま「内部が正」の状態のため「移行待ち」という概念がない)。
        pendingMigration
      };
    }

    if (method === 'GET' && url.pathname === '/recordings/storage-status') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      return json(res, 200, await _buildStorageStatus());
    }

    // 外部USB/SDへの移行などの進捗をリアルタイム表示するためのAPI。
    // storage-status と同じ内容に加えて、現在実行中の移行処理の進捗
    // (_migrateStats) を含む。管理画面はこのAPIを2秒ごとにポーリングする。
    if (method === 'GET' && url.pathname === '/recordings/migration-status') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const base = await _buildStorageStatus();
      return json(res, 200, Object.assign(base, { migration: _migrateStats }));
    }

    if (method === 'GET' && url.pathname.startsWith('/recording/')) {
      const queryToken = url.searchParams.get('token');
      if (!verifySession(req, queryToken)) {
        return json(res, 403, { ok: false, error: '認証されていません' });
      }
      const id = sanitize(url.pathname.replace('/recording/', ''));
      const folder = await findRecordingFolder(id) || REC_DIR;
      const candidates = [
        { path: path.join(folder, `rec_${id}_cam.mp4`), mime: 'video/mp4' },
        { path: path.join(folder, `rec_${id}_cam.webm`), mime: 'video/webm' },
      ];
      const found = candidates.find(c => fs.existsSync(c.path));
      if (!found) return json(res, 404, { ok: false, error: 'ファイルが見つかりません' });
      const { path: filepath, mime: contentType } = found;
      const stat = await fsp.stat(filepath);
      const fileSize = stat.size;
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (isNaN(start) || isNaN(end) || start < 0 || start >= fileSize || end < start || end >= fileSize) {
          res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
          res.end();
          return;
        }
        const chunksize = end - start + 1;
        const file = fs.createReadStream(filepath, { start, end });
        file.on('error', () => { try { res.destroy(); } catch (_) { } });
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': contentType });
        file.pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType });
        const stream = fs.createReadStream(filepath);
        stream.on('error', () => { try { res.destroy(); } catch (_) { } });
        stream.pipe(res);
      }
      return;
    }


    if (method === 'GET' && url.pathname === '/api/assets') {
      try {
        const files = await fsp.readdir(ASSETS_DIR);

        const local = await readLocalConfig();
        const assetConfig = local.assetConfig || {};

        const assets = await Promise.all(files.map(async f => {
          const stats = await fsp.stat(path.join(ASSETS_DIR, f));
          return {
            name: f,
            size: stats.size,
            mtime: stats.mtime,
            enabled: assetConfig[f] !== false
          };
        }));
        return json(res, 200, { ok: true, assets });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (method === 'POST' && url.pathname === '/api/assets/toggle') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const body = await readBody(req);
      try {
        const { name, enabled } = JSON.parse(body);
        if (!name) return json(res, 400, { ok: false, error: 'ファイル名が必要です' });

        const local = await readLocalConfig();
        if (!local.assetConfig) local.assetConfig = {};
        local.assetConfig[name] = !!enabled;
        await writeLocalConfig(local);
        slog('DEBUG', `アセットの状態を更新しました: ${name} (${enabled ? 'ON' : 'OFF'})`);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { ok: false, error: '設定の更新に失敗しました: ' + e.message });
      }
    }

    if (method === 'POST' && url.pathname === '/api/assets/upload') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const rawNameDecoded = safeDecodePath(req.headers['x-filename'] || 'upload_' + Date.now());
      if (!rawNameDecoded.ok) return json(res, 400, { ok: false, error: 'ファイル名のエンコードが不正です' });
      const rawName = rawNameDecoded.value;
      const ext = path.extname(rawName).toLowerCase();
      // 精査: 拡張子を許可リストで制限する。/assets/:name は拡張子に応じて
      // Content-Type を決めており(未知の拡張子はoctet-streamへフォールバックする
      // ため実害は小さいが)、想定外のファイル種別(.html等)がここから
      // アセット配信ディレクトリに置かれること自体を防いでおく方が安全。
      const ALLOWED_ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.webm', '.mp4']);
      if (!ALLOWED_ASSET_EXTS.has(ext)) {
        return json(res, 400, { ok: false, error: `対応していないファイル形式です(${ext || '拡張子なし'})。画像(png/jpg/webp/gif/svg)または動画(webm/mp4)のみアップロードできます。` });
      }
      const base = path.basename(rawName, ext);
      let sanitizedBase = sanitize(base);
      if (!sanitizedBase) sanitizedBase = 'asset_' + Date.now();
      const filename = sanitizedBase + ext;
      const filepath = path.join(ASSETS_DIR, filename);

      let received = 0;
      const ws = fs.createWriteStream(filepath);
      try {
        await new Promise((resolve, reject) => {
          req.on('data', chunk => {
            received += chunk.length;
            if (received > MAX_VIDEO_SIZE) { ws.destroy(); reject(new Error('ファイルサイズ上限超過')); return; }
            ws.write(chunk);
          });
          req.on('end', () => { ws.end(); });
          req.on('error', reject);
          ws.on('error', reject);
          ws.on('finish', resolve);
        });
        slog('DEBUG', `アセットをアップロードしました: ${filename}`);
        return json(res, 200, { ok: true, filename });
      } catch (e) {
        if (fs.existsSync(filepath)) await fsp.unlink(filepath).catch(() => { });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (method === 'DELETE' && url.pathname.startsWith('/api/assets/')) {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const nameDecoded = safeDecodePath(url.pathname.replace('/api/assets/', ''));
      if (!nameDecoded.ok) return json(res, 400, { ok: false, error: 'ファイル名のエンコードが不正です' });
      const name = nameDecoded.value;
      if (!isPathSafe(ASSETS_DIR, name)) {
        return json(res, 403, { ok: false, error: 'Access denied' });
      }
      const filepath = path.join(ASSETS_DIR, name);

      if (fs.existsSync(filepath)) {
        await fsp.unlink(filepath);
        slog('DEBUG', `アセットを削除しました: ${name}`);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false, error: 'ファイルが見つかりません' });
    }

    if (method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = url.pathname.replace('/assets/', '');
      if (!isPathSafe(ASSETS_DIR, name)) return json(res, 403, { ok: false, error: 'アクセスが拒否されました' });
      const filepath = path.join(ASSETS_DIR, name);

      if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
        const ext = path.extname(filepath).toLowerCase();
        const mimes = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.webm': 'video/webm', '.mp4': 'video/mp4'
        };
        const contentType = mimes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        const stream3 = fs.createReadStream(filepath);
        stream3.on('error', () => { try { res.destroy(); } catch (_) { } });
        stream3.pipe(res);
        return;
      }
      return json(res, 404, { ok: false, error: '見つかりません' });
    }

    if (method === 'OPTIONS' && url.pathname === '/api/gas') {
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/api/gas') {
      const params = new URL(req.url, 'http://localhost');
      const action = params.searchParams.get('action');
      if (!action) return json(res, 400, { ok: false, error: 'action が必要です' });

      // 認証なしで GET を許すのは、副作用を伴わない参照処理だけ。
      // 書き込み系を GET で許すと、URL を読み込んだだけで貸出・返却が
      // 実行できてしまう（CSRF）。管理者セッションがある場合は従来どおり
      // どちらのメソッドでも実行できる。
      const GAS_SAFE_GET_ACTIONS = new Set([
        'getLoans', 'getHistory', 'getBlacklist', 'getFailures',
        'getSettings', 'getAvailableDevice'
      ]);
      const sessionOk = verifySession(req);
      if (!GAS_SAFE_GET_ACTIONS.has(action) && !sessionOk) {
        return json(res, 403, { ok: false, error: '認証が必要です' });
      }

      if (LOCAL_ACTIONS.has(action)) {
        const actionParams = {};
        params.searchParams.forEach((value, key) => {
          if (key !== 'action') actionParams[key] = value;
        });
        try {
          const result = callLocalAction(action, actionParams, { sessionVerified: sessionOk });
          // 管理画面の「運用設定」タブで表示するメール送信状況(生徒本人宛)を付与する。
          // ローカル getSettings はDBのみを返すため、ここで /settings と同様の
          // emailStatus を合成する（これがないと renderEmailStatusBox が常に空になる）。
          if (action === 'getSettings' && result && result.settings) {
            try {
              const queueStatus = LDB.getEmailQueueStatus();
              result.settings.emailStatus = {
                gasConfigured: !!(GAS_URL && SYNC_TOKEN),
                pending: queueStatus.pending,
                sent: queueStatus.sent,
                failing: queueStatus.failing,
                lastError: queueStatus.lastError
              };
            } catch (e) {
              result.settings.emailStatus = null;
            }
          }
          return json(res, 200, result);
        } catch (e) {
          slog('ERROR', `[local:${action}] エラー: ${e.message}`);
          return json(res, 200, { success: false, message: 'サーバーエラー: ' + e.message });
        }
      }

      if (!GAS_URL) {
        return json(res, 503, { success: false, message: GAS_URL_ERROR || 'GAS_URLが未設定のためスプレッドシート連携は無効です' });
      }
      // ローカル未対応のアクション(sendTestEmailなど)は引き続きGASへ転送する。
      const target = new URL(GAS_URL);
      params.searchParams.forEach((value, key) => {
        if (key !== 'action') target.searchParams.set(key, value);
      });
      const GAS_PASSCODE_ACTIONS = new Set(['clearData', 'addBlacklist', 'removeBlacklist', 'updateSettings', 'sendTestEmail']);
      if (GAS_PASSCODE_ACTIONS.has(action)) {
        target.searchParams.set('passcode', ADMIN_PASSWORD);
      }
      target.searchParams.set('action', action);
      return proxyToGas(req, res, target.toString(), undefined);
    }

    if (method === 'POST' && url.pathname === '/api/gas') {
      const body = await readBody(req);
      let action = '';
      let parsedBody = {};
      try { parsedBody = JSON.parse(body); action = parsedBody.action || ''; } catch (_) { }

      const GAS_UNSAFE_POST_ACTIONS = new Set([
        'clearData', 'addBlacklist', 'removeBlacklist', 'updateSettings', 'sendTestEmail',
        'forceReturnLoan', 'editHistoryEntry', 'deleteHistoryEntry', 'updateUser', 'deleteUser',
        // バグ修正: 故障の登録・解除は管理操作であり認証が必要だが、
        // このセットへの登録漏れにより未認証でも実行できてしまっていた。
        'addFailure', 'resolveFailure'
      ]);
      const sessionOk = verifySession(req);
      if (GAS_UNSAFE_POST_ACTIONS.has(action) && !sessionOk) {
        return json(res, 403, { ok: false, error: '認証が必要です' });
      }

      if (LOCAL_ACTIONS.has(action)) {
        const actionParams = Object.assign({}, parsedBody);
        delete actionParams.action;
        if (action === 'checkoutCommit' && actionParams.adminRecovery === true && !sessionOk) {
          return json(res, 403, { ok: false, error: '貸出の復旧には管理者ログインが必要です' });
        }
        if (['checkoutPrepare', 'checkoutAuto', 'checkout'].includes(action) && !_serialReady) {
          return json(res, 503, {
            success: false,
            code: 'arduino_disconnected',
            message: '扉の施錠装置(Arduino)に接続できないため、新しい貸出を開始できません。接続が戻ってからもう一度お試しください。'
          });
        }
        if (action === 'clearData' && actionParams.target === 'history') {
          const loans = LDB.getLoans().loans || [];
          if (loans.length > 0) {
            return json(res, 409, { success: false, message: '貸出中または準備中の記録があるため、履歴を削除できません。' });
          }
          const safetyBackup = await runBackup({
            kind: 'manual',
            logger: { info: (message) => slog('INFO', message), warn: (message) => slog('WARN', message) }
          });
          if (!safetyBackup.success) {
            return json(res, 503, {
              success: false,
              message: `削除前の安全バックアップを作成できなかったため、履歴は削除していません: ${safetyBackup.message}`
            });
          }
          slog('WARN', `全履歴削除前の安全バックアップを作成しました: ${safetyBackup.filename}`);
        }
        try {
          const result = callLocalAction(action, actionParams, { sessionVerified: sessionOk });
          return json(res, 200, result);
        } catch (e) {
          slog('ERROR', `[local:${action}] エラー: ${e.message}`);
          return json(res, 200, { success: false, message: 'サーバーエラー: ' + e.message });
        }
      }

      if (!GAS_URL) {
        return json(res, 503, { success: false, message: GAS_URL_ERROR || 'GAS_URLが未設定のためスプレッドシート連携は無効です' });
      }
      // ローカル未対応のアクション(sendTestEmailなど)は引き続きGASへ転送する。
      let modifiedBody = body;
      if (GAS_UNSAFE_POST_ACTIONS.has(action)) {
        try {
          parsedBody.passcode = ADMIN_PASSWORD;
          modifiedBody = JSON.stringify(parsedBody);
        } catch (_) { }
      }
      return proxyToGas(req, res, GAS_URL, modifiedBody);
    }

    if (method === 'GET' && url.pathname === '/api/security-status') {
      if (!verifySession(req, undefined, true)) return json(res, 403, { ok: false, error: '認証されていません' });
      return json(res, 200, {
        ok: true,
        adminPasswordIsDefault: ADMIN_PASSWORD === _DEFAULT_ADMIN_PASSWORD,
      });
    }

    // 管理画面トップで一目確認できる統合ヘルスチェック。専門知識がなくても
    // 「今日も正常に動いているか」を一箇所で判断できるようにするためのもの。
    // 個々の詳細情報は既存のエンドポイント(/api/security-status, /backups,
    // /api/gas?action=getSettings 等)にもあるが、それらを毎回開かなくても
    // 済むよう、ここで警告が必要なものだけをまとめて返す。
    if (method === 'GET' && url.pathname === '/api/health-status') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });

      const warnings = [];

      // 1. 管理者パスワードが初期値のまま
      const adminPasswordIsDefault = ADMIN_PASSWORD === _DEFAULT_ADMIN_PASSWORD;
      if (adminPasswordIsDefault) {
        warnings.push({
          level: 'warning',
          code: 'default_admin_password',
          message: '管理者パスワードが初期値のままです。「運用設定」タブから変更してください。'
        });
      }

      if (GAS_URL_ERROR) {
        warnings.push({
          level: 'warning',
          code: 'gas_configuration',
          message: GAS_URL_ERROR + 'ローカルの貸出・返却は利用できますが、スプレッドシート同期とGAS経由のメールは停止しています。'
        });
      }

      // 2. スプレッドシート同期が有効なのに失敗が続いている
      //    (ローカルDBの主要データが全て空になったことによる安全停止は、
      //    連続失敗回数を待たずに即座に警告する)
      const syncEnabled = !!(GAS_URL && SYNC_TOKEN);
      const syncStatus = getSyncStatus();
      if (syncEnabled && syncStatus.empty_sync_blocked) {
        warnings.push({
          level: 'warning',
          code: 'sync_blocked_empty',
          message: syncStatus.last_error || 'ローカルDBの主要データが空になっているため、スプレッドシートへの同期を安全のため中断しています。'
        });
      } else if (syncEnabled && syncStatus.consecutive_failures >= 3) {
        warnings.push({
          level: 'warning',
          code: 'sync_failing',
          message: `スプレッドシートへの同期が${syncStatus.consecutive_failures}回連続で失敗しています(直近のエラー: ${syncStatus.last_error || '不明'})。貸出・返却自体には影響ありませんが、スプレッドシート上のデータが古いままになっています。GAS_URLとconfig.envのSYNC_TOKENを確認してください。トークンを変更した場合は、GAS側のスクリプトプロパティにも同じ値を手動で登録してください。`
        });
      }

      // 3. DBバックアップが直近作成されていない(24時間以上前、または一度もない)
      let backupWarningNeeded = false;
      let latestBackupAt = null;
      try {
        const backups = await listBackups();
        if (backups.length === 0) {
          backupWarningNeeded = true;
        } else {
          latestBackupAt = backups[0].createdAt;
          const ageMs = Date.now() - new Date(latestBackupAt).getTime();
          if (ageMs > 24 * 60 * 60 * 1000) backupWarningNeeded = true;
        }
      } catch (e) {
        backupWarningNeeded = true;
      }
      if (backupWarningNeeded) {
        warnings.push({
          level: 'warning',
          code: 'backup_stale',
          message: latestBackupAt
            ? `直近のDBバックアップが24時間以上前(${latestBackupAt})です。サーバーが起動し続けているか確認してください。`
            : 'DBバックアップがまだ一度も作成されていません。サーバーを起動してから6時間ほどお待ちいただくか、「バックアップ」タブから今すぐ実行できます。'
        });
      }

      // 4. Arduino未接続
      if (!_serialReady) {
        warnings.push({
          level: 'info',
          code: 'arduino_disconnected',
          message: 'Arduino(施錠装置)が未接続です。新しい貸出は安全のため開始できません。返却は実物を棚に戻したことを確認してから手動記録してください。'
            + ' 確認事項: ①USBケーブル(データ通信対応)で接続 ②Linuxでは dialoutグループにユーザーが属しているか'
            + ' (sudo usermod -aG dialout $(whoami) の後、ログアウト→再ログイン) ③互換基板(CH340等)はドライバが必要 ④多重接続時はSERIAL_PORTを指定'
        });
      }

      if (process.platform !== 'win32') {
        const ntpSynchronized = await new Promise(resolve => {
          child_process.execFile('timedatectl', ['show', '--property=NTPSynchronized', '--value'], { timeout: 1500 }, (error, stdout) => {
            resolve(error ? '' : String(stdout || '').trim());
          });
        });
        if (ntpSynchronized === 'no') {
          warnings.push({
            level: 'warning',
            code: 'time_unsynchronized',
            message: 'パソコンの時刻がインターネット時刻とまだ同期していません。貸出・返却は継続できますが、貸出期限や記録時刻がずれる可能性があります。ネットワーク復帰後に同期を待ち、日付と時刻が正しいことを確認してください。'
          });
        }
      }

      if (_cameraStatus.state === 'error') {
        warnings.push({
          level: 'info',
          code: 'camera_unavailable',
          message: `キオスクカメラを利用できません。貸出・返却は継続できますが、録画やカメラによる確認はできません。${_cameraStatus.message ? ` 詳細: ${_cameraStatus.message}` : ''}`
        });
      }

      // 5. 通知メール・先生向けレポートの状態
      // 実際のメール送信・スケジュール判定はすべてGAS側(Code.gs)が行うため、
      // ローカル側で有効にしていても、スプレッドシート同期(SYNC_TOKEN)が
      // 使えていないとGAS側に設定が伝わらず、実際には機能しない。
      let settings = null;
      try { settings = getCurrentSettings(); } catch (e) { settings = null; }
      if (settings) {
        const notifyOff = !settings.notifyEmailEnabled;
        const reportOff = !settings.teacherReportEnabled;
        if (notifyOff && reportOff) {
          warnings.push({
            level: 'info',
            code: 'notifications_disabled',
            message: '故障・延滞などの通知メール、および先生向け定期レポートがどちらも無効です。「運用設定」タブから有効にすると、異常が起きた時に自動でメールが届くようになります。'
          });
        } else if (!syncEnabled) {
          warnings.push({
            level: 'warning',
            code: 'notifications_need_sync',
            message: '通知メールまたは先生向けレポートが有効になっていますが、スプレッドシート同期用のトークンが生成できていないため、実際にはメールが送信されません。サーバーを再起動しても解消しない場合は、config.envの書き込み権限を確認してください。'
          });
        }
      }

      return json(res, 200, {
        ok: true,
        healthy: warnings.length === 0,
        warnings,
        checkedAt: new Date().toISOString()
      });
    }

    if (method === 'GET' && url.pathname === '/api/audit') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      if (!fs.existsSync(AUDIT_FILE)) return json(res, 200, { ok: true, logs: [] });
      const raw = await fsp.readFile(AUDIT_FILE, 'utf8');
      const logs = raw.trim().split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      }).reverse();
      return json(res, 200, { ok: true, logs });
    }

    if (method === 'POST' && url.pathname === '/api/audit') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const body = await readBody(req);
      try {
        const { action, detail, target } = JSON.parse(body);
        const entry = { ts: new Date().toISOString(), action, detail: detail || '', target: target || '' };
        await fsp.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n');
        slog('INFO', `監査: ${action} ${detail}`);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { ok: false, error: '監査ログの書き込みに失敗しました: ' + e.message });
      }
    }



    if (method === 'GET' && url.pathname === '/api/settings/export') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const data = JSON.stringify(await buildSettingsExportData(), null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="settings-backup.json"'
      });
      res.end(data);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/settings/import') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const body = await readBody(req);
      try {
        const incoming = JSON.parse(body);
        const { assetConfig, captureDeviceId, isKiosk, settingsUpdatedAt, settingsUpdatedBy, ...remoteFields } = incoming;
        // 復元(上書き)する前の状態を残しておく。一覧選択で違うものを選び直したい/
        // 誤って復元してしまった場合に、直前の状態へ戻せるようにするため。
        await snapshotSettingsBackup('auto');
        const local = await readLocalConfig();
        if (assetConfig !== undefined) {
          local.assetConfig = assetConfig;
        }
        if (captureDeviceId !== undefined) {
          local.captureDeviceId = captureDeviceId;
        }
        await writeLocalConfig(local);
        await pushSettingsLocal(remoteFields, '教室PC(インポート)');
        slog('INFO', '設定をインポートしました（ローカルDBに保存、スプレッドシートへは順次同期）');
        await snapshotSettingsBackup('auto'); // 復元後の状態も一覧に残す
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { ok: false, error: '設定のインポートに失敗しました: ' + e.message });
      }
    }

    if (method === 'GET' && url.pathname === '/api/settings/backups') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      const backups = await listSettingsBackups();
      return json(res, 200, { ok: true, backups });
    }

    if (method === 'POST' && url.pathname === '/api/settings/backups/run') {
      if (!verifySession(req)) return json(res, 403, { ok: false, error: '認証されていません' });
      try {
        const data = await buildSettingsExportData();
        const result = await saveSettingsBackup(data, { kind: 'manual' });
        if (!result.success) throw new Error(result.message || 'バックアップの作成に失敗しました');
        await pruneOldSettingsBackups();
        return json(res, 200, { ok: true, filename: result.filename });
      } catch (e) {
        return json(res, 400, { ok: false, error: 'バックアップの作成に失敗しました: ' + e.message });
      }
    }

    if (method === 'GET' && url.pathname === '/health') {
      let diskFreeMB = null;
      try { const st = await fsp.statfs(REC_DIR); diskFreeMB = Math.floor((st.bavail * st.bsize) / (1024 * 1024)); } catch (_) { }
      return json(res, 200, {
        ok: true,
        uptime: Math.floor(process.uptime()),
        arduino: _serialReady,
        gas: !!_settingsCache,
        diskFreeMB,
        recordingDir: REC_DIR,
        backupsDir: getBackupDir(),
        usingSdCard: _usingSdCard,
        externalStorage: !!EXTERNAL_ROOT,
        externalRoot: EXTERNAL_ROOT,
        ffmpegAvailable: FFMPEG_AVAILABLE,
        activeSessions: _adminSessions.size,
      });
    }

    if (method === 'GET' && url.pathname === '/api/devices') {
      return json(res, 200, { ok: true, devices: ALL_DEVICES });
    }

    // ---------------------------------------------------------------------
    // サブモニター表示用ボード（board.html）のデータ取得API。
    //
    // 意図的に認証なしで提供している。理由:
    // - サーバーは 127.0.0.1 のみにバインドされており(server.listen参照)、
    //   この端末上のブラウザ以外からは到達できない(/api/devices 等の
    //   既存の非認証GETエンドポイントと同じ信頼モデル)。
    // - board.htmlはHDMI接続時に自動で開かれる閲覧専用画面であり、
    //   人手を介さず起動するため、管理者パスコードでのログインを
    //   前提にできない(できてしまうとパスコードをスクリプトに
    //   平文で持たせることになり、かえって安全性が下がる)。
    // - 返す内容は「今どの端末が誰に貸し出されているか」という、
    //   もともと部室・職員室等の目の届く場所での掲示を想定した情報に
    //   限定している。氏名を含むため、設置場所は生徒が自由に閲覧できない
    //   場所(職員室・貸出カウンターの管理者側等)を推奨する。
    // - ブラックリスト等、より機微な情報は既定で含めない
    //   (boardShowBlacklist設定でも氏名と期限のみ・理由は含めない)。
    if (method === 'GET' && url.pathname === '/api/board-status') {
      try {
        const settings = getCurrentSettings();
        const now = new Date();

        const loansResult = LDB.getLoans();
        const failuresResult = LDB.getFailures();
        const historyResult = LDB.getHistory();

        const deadlineHour = Number.isFinite(settings.returnDeadlineHour) ? settings.returnDeadlineHour : 16;
        const deadlineMinute = Number.isFinite(settings.returnDeadlineMinute) ? settings.returnDeadlineMinute : 0;
        const graceMin = Number.isFinite(settings.gracePeriodMinutes) ? settings.gracePeriodMinutes : 0;

        // 期限計算はローカルDBの単一実装(LDB.getLoanDeadline)を正とする。
        // ここで別の式写在くと、盤面表示と返却記録の「延滞」判定がずれる。
        function deadlineFor(loan) {
          return LDB.getLoanDeadline(loan, { returnDeadlineHour: deadlineHour, returnDeadlineMinute: deadlineMinute, gracePeriodMinutes: graceMin });
        }

        const usedDevices = new Set();
        const loans = (loansResult.loans || []).map(l => {
          usedDevices.add(l.deviceId);
          const dl = deadlineFor(l);
          return {
            deviceId: l.deviceId,
            name: l.name || '',
            checkoutTime: l.checkoutTime || '',
            dueTime: dl ? dl.toISOString() : null,
            overdue: LDB.isOverdueLoan(l, { returnDeadlineHour: deadlineHour, returnDeadlineMinute: deadlineMinute, gracePeriodMinutes: graceMin }, now)
          };
        }).sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));

        const failures = (failuresResult.failures || [])
          .filter(f => f.status === '故障中')
          .map(f => ({ deviceId: f.deviceId, reportedAt: f.reportedAt || '' }))
          .sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));

        // 貸出中かつ故障中(貸出中に故障報告された端末)の二重減算を避けるため、
        // 「使用不可」を「貸出中」と「故障中」の和集合として数える。
        const unavailableSet = new Set(usedDevices);
        failures.forEach(f => unavailableSet.add(f.deviceId));
        const loansByDevice = new Map(loans.map(loan => [loan.deviceId, loan]));
        const failedDevices = new Set(failures.map(failure => failure.deviceId));
        const deviceList = ALL_DEVICES.map(deviceId => {
          const loan = loansByDevice.get(deviceId);
          return {
            deviceId,
            inUse: !!loan,
            broken: failedDevices.has(deviceId),
            overdue: !!(loan && loan.overdue)
          };
        });

        const isSameDay = (iso) => {
          if (!iso) return false;
          const d = new Date(iso);
          return !isNaN(d.getTime())
            && d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
        };
        const history = historyResult.history || [];
        const todayCheckouts = history.filter(h => isSameDay(h.checkoutTime)).length;
        const todayReturns = history.filter(h => h.status !== '貸出中' && isSameDay(h.returnTime)).length;
        const todayLateReturns = history.filter(h => h.status === '延滞返却' && isSameDay(h.returnTime)).length;

        let blacklistCount = 0;
        let blacklist = [];
        try {
          const blResult = LDB.getBlacklist();
          const blRows = blResult.blacklist || [];
          blacklistCount = blRows.length;
          if (settings.boardShowBlacklist) {
            blacklist = blRows.map(b => ({ name: b.name || '', expiry: b.expiry || '' }));
          }
        } catch (_) { /* ブラックリスト取得失敗はボード全体を止めない */ }

        const syncStatus = (() => { try { return getSyncStatus(); } catch (_) { return null; } })();

        return json(res, 200, {
          ok: true,
          serverTime: now.toISOString(),
          settings: {
            boardEnabled: settings.boardEnabled !== false,
            boardSlideIntervalSec: settings.boardSlideIntervalSec || 8,
            boardShowBlacklist: !!settings.boardShowBlacklist,
            returnDeadlineHour: deadlineHour,
            returnDeadlineMinute: deadlineMinute
          },
          devices: { total: ALL_DEVICES.length, inUse: usedDevices.size, available: ALL_DEVICES.length - unavailableSet.size, broken: failures.length },
          deviceList,
          loans,
          failures,
          today: { checkouts: todayCheckouts, returns: todayReturns, lateReturns: todayLateReturns },
          blacklistCount,
          blacklist,
          system: {
            arduinoConnected: !!_serialReady,
            syncOk: !syncStatus || (syncStatus.consecutive_failures || 0) === 0,
            syncBlockedEmpty: !!(syncStatus && syncStatus.empty_sync_blocked)
          }
        });
      } catch (e) {
        slog('ERROR', `/api/board-status でエラー: ${e.message}`);
        return json(res, 500, { ok: false, error: 'ボード情報の取得に失敗しました' });
      }
    }

    if (method === 'GET' && url.pathname.startsWith('/api/docs/')) {
      const docNameDecoded = safeDecodePath(url.pathname.replace('/api/docs/', ''));
      if (!docNameDecoded.ok) return json(res, 400, { ok: false, error: 'ファイル名のエンコードが不正です' });
      const docName = docNameDecoded.value;
      const allowedDocs = ['SPECIFICATION.md', 'GUIDE.md'];
      if (!allowedDocs.includes(docName)) {
        return json(res, 404, { ok: false, error: 'ドキュメントが見つかりません' });
      }
      const docPath = path.join(__dirname, docName);
      if (!isPathSafe(__dirname, docPath)) {
        return json(res, 403, { ok: false, error: 'アクセスが拒否されました' });
      }
      try {
        const content = await fsp.readFile(docPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(content);
      } catch (_) {
        return json(res, 404, { ok: false, error: 'ドキュメントが見つかりません' });
      }
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const pathDecoded = safeDecodePath(url.pathname);
      if (!pathDecoded.ok) return json(res, 400, { ok: false, error: 'URLのエンコードが不正です' });
      let p = pathDecoded.value;
      if (p === '/') p = '/index.html';

      const isServed = _isServableStaticPath(p);
      if (!isServed) {
        return json(res, 404, { ok: false, error: '見つかりません' });
      }

      if (!isPathSafe(__dirname, p)) return json(res, 403, { ok: false, error: 'アクセスが拒否されました' });
      const filepath = path.join(__dirname, p);
      let stat;
      try { stat = await fsp.stat(filepath); } catch (_) { stat = null; }
      if (stat && stat.isFile()) {
        const ext = path.extname(filepath).toLowerCase();
        // 日本語表示の保険: text系は charset=utf-8 を明示する（ブラウザ/環境依存の
        // 文字コード推測に頼らないため。<meta charset> 頼みにしない）。
        const mimes = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
          '.otf': 'font/otf'
        };
        const contentType = mimes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        const stream4 = fs.createReadStream(filepath);
        stream4.on('error', () => { try { res.destroy(); } catch (_) { } });
        stream4.pipe(res);
        return;
      }
    }

    json(res, 404, { ok: false, error: '見つかりません' });

  } catch (e) {
    slog('ERROR', e.message || e);
    json(res, 500, { ok: false, error: e.message });
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.stack || reason?.message || String(reason);
  slog('WARN', `未処理のPromise rejection:\n${msg}`);
});

// Arduino未接続時などに、想定外の同期エラー（例: シリアル関連コードの
// バグ）が起きても、キオスク全体（起動・貸出・返却UI）を巻き添えで
// 落とさないための最終防衛ライン。
// 通常はここに来ないはずだが、来た場合でも「無表示のまま落ちて開かない」
// を避け、ログに残した上でプロセスを継続する（Arduino機能だけが
// 使えなくなる程度に被害を留める）。
process.on('uncaughtException', (err) => {
  slog('ERROR', `未処理の例外が発生しましたが、サーバーは継続します:\n${err?.stack || err}`);
});

server.listen(PORT, '127.0.0.1', async () => {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  await _pruneLogFile(LOG_FILE);
  await _pruneLogFile(AUDIT_FILE);

  slog('INFO', `サーバーが起動しました: http://localhost:${PORT}`);
  slog('INFO', `録画の保存先: ${REC_DIR} (${_usingSdCard ? '外部ストレージ（USB / SD）' : '内部ストレージ'})`);
  if (!_usingSdCard) {
    slog('INFO', '外部ストレージ（USB / SD）は検出されていません。録画とバックアップは内部ストレージに保存されます。');
  }
  const ff = checkFFmpegSync();
  if (ff.ok) slog('INFO', `ffmpegを検出しました: ${FFMPEG_VERSION}`);
  else slog('WARN', 'ffmpegが見つかりません。動画の変換が制限されます。');

  getCurrentSettings(true);
  slog('INFO', '運用設定を読み込みました(ローカルDB)');

  await initSerial();

  if (SYNC_TOKEN) {
    syncJob.start();
    slog('INFO', 'スプレッドシートへの定期同期を開始しました');
  } else {
    slog('WARN', 'SYNC_TOKENが生成できなかったため、スプレッドシートへの同期は無効です(貸出・返却・解錠には影響しません)');
  }

  // 貸出・返却確認メールの送信キューはSMTP設定のみに依存する
  // (SYNC_TOKEN/スプレッドシート同期とは無関係)。SMTP未設定時は
  // ワーカー内部で自動的にスキップされる。
  emailQueueWorker.start();
  slog('INFO', '貸出・返却確認メールの送信キューを開始しました');

  backupJob.start();
  slog('INFO', `ローカルDBの自動バックアップを開始しました(保存先: ${getBackupDir()})`);

  // 外部ストレージ（USB / SD）の検出（lsblk含む）を確定し、
  // 以降は30秒ごとに監視して差し込み・取り外しに自動追従する。
  await refreshStorageTarget(true);
  // 起動時に既に外部ストレージが使える場合は、前回内部へ退避されたままの
  // データ（録画・バックアップ）も移行して外部に集約する。
  if (EXTERNAL_ROOT) {
    await _migrateInternalToExternal();
  }
  slog('INFO', `録画・バックアップの保存先: ${EXTERNAL_ROOT ? `外部ストレージ（${EXTERNAL_ROOT}）` : '内部ストレージ'}`);

  function _runStorageRefreshCycle() {
    return refreshStorageTarget(false)
      .then(() => {
        // 外部使用中は、前回の移行時に書き込み中だったデータ等、取り残しがあれば
        // 追加で移行する（実行中フラグで二重実行を防止）。
        if (EXTERNAL_ROOT) {
          _migrateInternalToExternal().catch(e => slog('WARN', `[Migrate] 定期移行エラー: ${e.message}`));
        }
      })
      .catch(e => slog('WARN', `外部ストレージの定期監視エラー: ${e.message}`));
  }

  // OS標準のUSBホットプラグ通知(Linux: udev)を使い、抜き差しの瞬間に
  // 即座に再検出する。udevadmが無い環境(Windows開発機等)では何も
  // 起動せず、以下の定期チェックだけにフォールバックする。
  const _hotplugWatcher = externalStorage.watchHotplug(_onHotplugEvent);
  process.on('exit', () => { try { _hotplugWatcher.stop(); } catch (_) { } });

  // 上記のudev通知が主経路。以下の定期チェックは、udevイベントを
  // 取りこぼした場合や、udevadmが使えない環境のための保険（セーフティ
  // ネット）として残す。そのため以前より短い周期にしても、常時
  // detect()を叩き続けるほどの負荷にはならない(readdir中心の軽い処理)。
  setInterval(_runStorageRefreshCycle, 10 * 1000).unref();

  setTimeout(async () => {
    if (_serialReady) {
      try {
        slog('DEBUG', '扉状態の初期キャッシュを構築中...');
        const status = await getAllDoorStatus();
        if (status && status.doors) {
          _doorCache = status.doors;
          const anyOpen = Object.values(status.doors).some(v => v === 'open');
          _lastDoorStatus = anyOpen ? 'open' : 'closed';
          slog('DEBUG', '扉状態の初期キャッシュ完了');
        }
      } catch (e) {
        slog('WARN', '扉状態の初期取得に失敗しました: ' + e.message);
      }
    }
  }, 3000);

  await _pruneOrphanRecordings();
  await _pruneOldRecordingsByRetention();
  await _pruneByCapacity();

  // 孤立録画（リロード・クラッシュ等でクライアントが削除できなかった
  // 未ファイナライズ録画）を定期的に掃除する
  setInterval(() => {
    _pruneOrphanRecordings().catch(e => slog('ERROR', `[Orphan] 定期クリーンアップエラー: ${e.message}`));
  }, 5 * 60 * 1000).unref();

  setInterval(async () => {
    if (_serialReady) {
      try {
        const status = await getAllDoorStatus();
        if (status && status.doors) {
          _doorCache = status.doors;
          const anyOpen = Object.values(status.doors).some(v => v === 'open');
          _lastDoorStatus = anyOpen ? 'open' : 'closed';
        }
      } catch (e) {
        slog('DEBUG', '定期的な扉状態の取得に失敗しました:', e.message);
      }
    }
  }, 10000);
});