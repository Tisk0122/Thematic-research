'use strict';
// ローカルSQLite(data/app.db)の自動バックアップ。
//
// スプレッドシート同期はあくまで「閲覧用のミラー」であり、GAS側の
// 障害・同期停止・トークン未生成などの理由で当てにできないことがある。
// そのため、貸出履歴やブラックリストといった実データの保険は
// このローカルバックアップだけで完結するようにしておく。
//
// better-sqlite3 の db.backup() はSQLite公式のオンラインバックアップAPIを
// 使っており、WALモードで稼働中のDBに対しても安全に(サービス停止なしで)
// 一貫性のあるコピーを取得できる。

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const BACKUP_DIR = process.env.LOCAL_DB_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BACKUPS = 60; // 日数と件数の両方で上限を掛ける(1日に何度も走らせても際限なく溜まらないように)

// バックアップファイル名の正規表現。
// - 新形式: 端末貸出バックアップ_自動/手動_2026年09月03日_11時30分00秒.db
// - 旧形式(互換性維持のため引き続き認識): app-20260903-113000.db
// このパターンは server.js の /backups/download・/backups のファイル名検証にも
// 使うため、ここで一元管理し、module.exports で公開する。
const _JP_BACKUP_RE = /^端末貸出バックアップ_(自動|手動)_\d{4}年\d{2}月\d{2}日_\d{2}時\d{2}分\d{2}秒\.db$/;
const _OLD_BACKUP_RE = /^app-\d{8}-\d{6}\.db$/;
const BACKUP_NAME_RE = new RegExp(`(${_JP_BACKUP_RE.source}|${_OLD_BACKUP_RE.source})`);

// ---------------------------------------------------------------------------
// 保存先の動的切替（外部ストレージ対応）
// ---------------------------------------------------------------------------
// BACKUP_DIR / SETTINGS_BACKUP_DIR は「内部ストレージ」の既定値そのもの。
// 外部USB/SDが検出されたときは server.js が setBackupTargetDirs() で上書きし、
// 以降のバックアップは外部ストレージ側に作られる。外れたときは null 相当で
// 内部に戻る。書き込み・一覧・削除すべてこの解決関数経由で行われる。
let _targetOverrides = {
  backupsDir: null,       // null = 内部(BACKUP_DIR)を使う
  settingsBackupsDir: null, // null = 内部(SETTINGS_BACKUP_DIR)を使う
};

function _getBackupsDir() {
  return _targetOverrides.backupsDir || BACKUP_DIR;
}

function _getSettingsBackupsDir() {
  return _targetOverrides.settingsBackupsDir || SETTINGS_BACKUP_DIR;
}

// opts = { backupsDir?, settingsBackupsDir? }。undefined/nullは内部既定へ戻す。
function setBackupTargetDirs(opts) {
  _targetOverrides.backupsDir = opts && opts.backupsDir ? opts.backupsDir : null;
  _targetOverrides.settingsBackupsDir = opts && opts.settingsBackupsDir ? opts.settingsBackupsDir : null;
}

// 時刻を「2026年09月03日_11時30分00秒」のような読みやすい形式にする。
function _timestampForFilename(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日_${pad(d.getHours())}時${pad(d.getMinutes())}分${pad(d.getSeconds())}秒`;
}

// kind: 'auto'(定期) | 'manual'(管理画面から手動)
async function runBackup({ kind = 'auto', logger = console } = {}) {
  try {
    await fsp.mkdir(_getBackupsDir(), { recursive: true });
    const now = new Date();
    const kindLabel = kind === 'manual' ? '手動' : '自動';
    const filename = `端末貸出バックアップ_${kindLabel}_${_timestampForFilename(now)}.db`;
    const destPath = path.join(_getBackupsDir(), filename);

    await db.backup(destPath);

    logger.info && logger.info(`[backup] DBバックアップを作成しました: ${filename}`);
    return { success: true, path: destPath, filename };
  } catch (e) {
    logger.warn && logger.warn(`[backup] DBバックアップに失敗しました: ${e.message}`);
    return { success: false, message: e.message };
  }
}

// ---------------------------------------------------------------------------
// ディレクトリ横断ユーティリティ(内部⇔外部ストレージ共通)
// ---------------------------------------------------------------------------
// 外部USB/SDが使用中でも、まだ内部ストレージから移行し切れていない
// バックアップ(server.js の _migrateInternalToExternal() 参照)が
// 一時的に残ることがある。一覧・整理(prune)の両方でこれを漏らさず
// 扱えるよう、「今アクティブなディレクトリ」と「内部ディレクトリ」を
// 横断するための共通ヘルパーをここに集約する。

// 指定ディレクトリ内の該当ファイルを、統計情報付きで列挙する。
async function _statFilesIn(dir, nameRe) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return []; // ディレクトリがまだ無い場合は「0件」として扱う
  }
  const files = entries.filter(e => e.isFile() && nameRe.test(e.name));
  const withStats = await Promise.all(files.map(async (e) => {
    const fullPath = path.join(dir, e.name);
    try {
      const st = await fsp.stat(fullPath);
      return { name: e.name, fullPath, sizeBytes: st.size, mtimeMs: st.mtimeMs, createdAt: new Date(st.mtimeMs).toISOString() };
    } catch (err) {
      return null;
    }
  }));
  return withStats.filter(Boolean);
}

// 「今アクティブなディレクトリ」と「内部ディレクトリ」の両方を、
// location('internal' | 'external')タグ付きで横断列挙し、重複を除去する。
// activeDir と internalDir が同じ(＝外部未使用)場合は internal 扱いの1回だけ。
async function _statFilesAcross(activeDir, internalDir, nameRe) {
  const usingExternal = path.resolve(activeDir) !== path.resolve(internalDir);
  const active = (await _statFilesIn(activeDir, nameRe))
    .map(f => Object.assign({}, f, { location: usingExternal ? 'external' : 'internal' }));

  if (!usingExternal) return active;

  const seen = new Set(active.map(f => f.name));
  const internal = (await _statFilesIn(internalDir, nameRe))
    .filter(f => !seen.has(f.name)) // 同名が両方にあるのは通常起きないが、念のため外部側を優先
    .map(f => Object.assign({}, f, { location: 'internal' }));

  return active.concat(internal);
}

// 指定ディレクトリ1つ分の世代整理(保持件数・保持日数)を行う共通処理。
async function _pruneDir(dir, nameRe, { retentionDays, maxBackups, logger, label }) {
  const files = await _statFilesIn(dir, nameRe);
  const validStats = files.slice().sort((a, b) => b.mtimeMs - a.mtimeMs); // 新しい順

  const threshold = Date.now() - retentionDays * 86400000;
  const toDelete = [];
  validStats.forEach((f, idx) => {
    if (idx >= maxBackups || f.mtimeMs < threshold) toDelete.push(f);
  });

  for (const f of toDelete) {
    try {
      await fsp.unlink(f.fullPath);
      logger.info && logger.info(`[backup] 古いバックアップを削除${label ? `(${label})` : ''}: ${f.name}`);
    } catch (e) {
      logger.warn && logger.warn(`[backup] バックアップ削除に失敗${label ? `(${label})` : ''}: ${f.name} - ${e.message}`);
    }
  }
  return { deleted: toDelete.length, remaining: validStats.length - toDelete.length };
}

// 保持件数・保持日数の両方を超えた古いバックアップを削除する。
// 外部ストレージ使用中で、内部側に移行待ちの取り残しがある場合は、
// そちらにも同じ保持ルールを独立して適用する(内部側が無制限に
// 溜まり続けるのを防ぐため。詳細はファイル末尾の設計メモを参照)。
async function pruneOldBackups({ retentionDays = DEFAULT_RETENTION_DAYS, maxBackups = DEFAULT_MAX_BACKUPS, logger = console } = {}) {
  try {
    const activeDir = _getBackupsDir();
    const usingExternal = path.resolve(activeDir) !== path.resolve(BACKUP_DIR);

    const activeResult = await _pruneDir(activeDir, BACKUP_NAME_RE, { retentionDays, maxBackups, logger, label: usingExternal ? '外部' : null });
    let deleted = activeResult.deleted;
    let remaining = activeResult.remaining;

    if (usingExternal) {
      const internalResult = await _pruneDir(BACKUP_DIR, BACKUP_NAME_RE, { retentionDays, maxBackups, logger, label: '内部・移行待ち' });
      deleted += internalResult.deleted;
      remaining += internalResult.remaining;
    }

    return { success: true, deleted, remaining };
  } catch (e) {
    logger.warn && logger.warn(`[backup] バックアップ整理に失敗しました: ${e.message}`);
    return { success: false, message: e.message };
  }
}

// 一覧表示用。外部ストレージ使用中は、内部に残っている移行待ちのバックアップも
// location:'internal' として一緒に返す(取りこぼしなく、かつどちらの保存先に
// あるかが管理画面で見分けられるようにするため)。
async function listBackups() {
  try {
    const files = await _statFilesAcross(_getBackupsDir(), BACKUP_DIR, BACKUP_NAME_RE);
    return files
      .map(f => {
        // 新形式のファイル名から自動/手動を抽出。旧形式(app-*.db)では不明扱い。
        const kindMatch = f.name.match(/^端末貸出バックアップ_(自動|手動)_/);
        const kind = kindMatch ? (kindMatch[1] === '手動' ? 'manual' : 'auto') : '';
        return { name: f.name, kind, sizeBytes: f.sizeBytes, createdAt: f.createdAt, location: f.location };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (e) {
    return [];
  }
}

// name(+location)から実ファイルパスを安全に解決する。
// location:'internal' が明示された場合のみ内部ディレクトリを見る。
// それ以外(未指定 / 'external' / 'active' 等)は、常に「今アクティブな
// ディレクトリ」を見る(移行完了後に外部へ動いたファイルを、古いlocation
// 指定のまま内部ディレクトリで探してしまう事故を避けるため)。
function resolveBackupPath(name, location) {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) {
    throw new Error('不正なバックアップ名です');
  }
  const dir = location === 'internal' ? BACKUP_DIR : _getBackupsDir();
  return path.join(dir, name);
}

// バックアップ(.db)の中身を確認する機能。
// バックアップファイルをそのまま(読み取り専用で)SQLiteとして開き、
// 主要テーブルの件数と、直近の代表的なレコードのプレビューを返す。
// 現行の app.db に一切触れないため、稼働中のサービスには影響しない。
// 古い世代のバックアップではテーブル/列が異なる可能性があるため、
// クエリ単位で失敗を握りつぶし、値が取れない項目は null / 空配列にする。
function _safeGet(conn, sql) {
  try {
    return conn.prepare(sql).get() || null;
  } catch (e) {
    return null;
  }
}
function _safeAll(conn, sql) {
  try {
    return conn.prepare(sql).all();
  } catch (e) {
    return [];
  }
}

async function inspectBackup(name, location) {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) {
    throw new Error('不正なバックアップ名です');
  }
  const fullPath = resolveBackupPath(name, location);
  await fsp.access(fullPath); // 無ければここでENOENTを投げる

  const Database = require('better-sqlite3');
  // 万一破損したバックアップでもサーバー全体を巻き込まないよう、
  // 呼び出し側(server.js)でもtry/catchするが、ここでも確実にconnを閉じる。
  const conn = new Database(fullPath, { readonly: true, fileMustExist: true });
  try {
    const num = (row) => (row ? Number(row.c) : null);

    const counts = {
      activeLoans: num(_safeGet(conn, 'SELECT COUNT(*) c FROM active_loans')),
      history: num(_safeGet(conn, 'SELECT COUNT(*) c FROM history')),
      blacklist: num(_safeGet(conn, 'SELECT COUNT(*) c FROM blacklist')),
      users: num(_safeGet(conn, 'SELECT COUNT(*) c FROM users')),
      failuresOpen: num(_safeGet(conn, "SELECT COUNT(*) c FROM failures WHERE status = '故障中'")),
      failuresTotal: num(_safeGet(conn, 'SELECT COUNT(*) c FROM failures')),
      emailQueuePending: num(_safeGet(conn, "SELECT COUNT(*) c FROM email_queue WHERE sent_at = ''")),
      emailQueueSent: num(_safeGet(conn, "SELECT COUNT(*) c FROM email_queue WHERE sent_at != ''"))
    };

    const settingsRow = _safeGet(conn, 'SELECT updated_at, updated_by FROM settings WHERE id = 1');
    const settings = settingsRow ? { updatedAt: settingsRow.updated_at || '', updatedBy: settingsRow.updated_by || '' } : null;

    const preview = {
      activeLoans: _safeAll(conn, 'SELECT name, email, device_id, checkout_time FROM active_loans ORDER BY checkout_time DESC LIMIT 10'),
      history: _safeAll(conn, 'SELECT name, device_id, checkout_time, return_time, status FROM history ORDER BY checkout_time DESC LIMIT 10'),
      blacklist: _safeAll(conn, 'SELECT name, email, reason, created_at, expiry, violations FROM blacklist ORDER BY created_at DESC LIMIT 10'),
      failuresOpen: _safeAll(conn, "SELECT device_id, reported_at, name, status FROM failures WHERE status = '故障中' ORDER BY reported_at DESC LIMIT 10")
    };

    return { counts, settings, preview };
  } finally {
    conn.close();
  }
}

function _inspectRestoreDatabase(filePath) {
  const Database = require('better-sqlite3');
  const conn = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = conn.pragma('integrity_check');
    if (!Array.isArray(integrity) || integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      const detail = Array.isArray(integrity) ? integrity.map(row => row.integrity_check).join('; ') : '結果を取得できません';
      const error = new Error(`SQLite整合性検査に失敗しました: ${detail}`);
      error.code = 'INVALID_RESTORE_DATABASE';
      throw error;
    }

    const requiredTables = ['active_loans', 'history', 'blacklist', 'users', 'failures', 'settings'];
    const availableTables = new Set(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const missingTables = requiredTables.filter(name => !availableTables.has(name));
    if (missingTables.length) {
      const error = new Error(`必要なテーブルがありません: ${missingTables.join(', ')}`);
      error.code = 'INVALID_RESTORE_DATABASE';
      throw error;
    }

    return {
      activeLoans: Number(conn.prepare('SELECT COUNT(*) AS count FROM active_loans').get().count)
    };
  } finally {
    conn.close();
  }
}

async function prepareDatabaseRestore(name, location, logger = console) {
  const sourcePath = resolveBackupPath(name, location);
  await fsp.access(sourcePath);

  const currentActiveCount = Number(db.prepare('SELECT COUNT(*) AS count FROM active_loans').get().count);
  if (currentActiveCount > 0) {
    return {
      success: false,
      message: `現在、貸出中または準備中の記録が${currentActiveCount}件あるため復元できません。先に全件を返却してください。`
    };
  }

  const sourceInfo = _inspectRestoreDatabase(sourcePath);
  if (sourceInfo.activeLoans > 0) {
    return {
      success: false,
      message: `選択したバックアップには貸出中の記録が${sourceInfo.activeLoans}件あるため復元できません。別のバックアップを選んでください。`
    };
  }

  const safetyBackup = await runBackup({ kind: 'manual', logger });
  if (!safetyBackup.success) {
    return {
      success: false,
      message: `復元前の現在DBバックアップを作成できませんでした。復元を中止しました: ${safetyBackup.message}`
    };
  }

  const dbPath = path.resolve(db.__dbFilePath);
  const stagingPath = path.join(
    path.dirname(dbPath),
    `.${path.basename(dbPath)}.restore-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  let activated = false;

  try {
    await fsp.copyFile(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
    const stagedInfo = _inspectRestoreDatabase(stagingPath);
    if (stagedInfo.activeLoans > 0) {
      const error = new Error('復元用コピーに貸出中の記録が含まれているため中止しました');
      error.code = 'INVALID_RESTORE_DATABASE';
      throw error;
    }
  } catch (e) {
    try { await fsp.unlink(stagingPath); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') logger.warn(`[restore] 一時ファイルを削除できません: ${cleanupError.message}`);
    }
    throw e;
  }

  function cleanup() {
    if (activated) return;
    try { fs.unlinkSync(stagingPath); }
    catch (e) {
      if (e.code !== 'ENOENT') logger.warn(`[restore] 一時ファイルを削除できません: ${e.message}`);
    }
  }

  function activate() {
    if (activated) throw new Error('このDB復元はすでに実行されています');

    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();

    try {
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }

      // Linux上の同一ファイルシステム内renameは置換が原子的。旧DBを
      // 先に別名へ移動してDBパスを空にする時間帯を作らず、停電時も
      // 起動時に「空のDB」が新規作成される状態を避ける。
      fs.renameSync(stagingPath, dbPath);
      activated = true;
    } finally {
      cleanup();
    }
  }

  return {
    success: true,
    filename: name,
    safetyBackupFilename: safetyBackup.filename,
    activate,
    cleanup
  };
}

// 定期実行ジョブ。書き込みの多い時間帯を避けるため、既定では6時間おき。
function createBackupJob({ intervalMs = 6 * 60 * 60 * 1000, retentionDays = DEFAULT_RETENTION_DAYS, maxBackups = DEFAULT_MAX_BACKUPS, logger = console } = {}) {
  let timer = null;

  async function runOnce() {
    await runBackup({ logger });
    await pruneOldBackups({ retentionDays, maxBackups, logger });
  }

  function start() {
    if (timer) return;
    // 起動直後は1分待ってから初回実行する(起動処理と競合してディスクI/Oが
    // 重なるのを避けるため)。
    setTimeout(() => { runOnce(); }, 60 * 1000);
    timer = setInterval(runOnce, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, runOnce };
}

/* ============================================================
   設定(JSON)のバックアップ
   ------------------------------------------------------------
   上記のDBバックアップ(.db)とは別に、管理画面の「設定」タブから
   保存・復元する設定JSONについても、同じ考え方で世代管理する。
   ・設定を保存する/インポートするたびに自動でスナップショットを
     残しておき、復元時はファイルを自分で探す必要がなく、
     「いつのバックアップか」を一覧から選んで中身を確認した上で
     選べるようにする。
   ============================================================ */

const SETTINGS_BACKUP_DIR = process.env.SETTINGS_BACKUP_DIR || path.join(__dirname, '..', 'data', 'settings-backups');
const DEFAULT_SETTINGS_RETENTION_DAYS = 30;
const DEFAULT_MAX_SETTINGS_BACKUPS = 60;

// 例: 設定バックアップ_自動_2026年09月08日_11時30分00秒.json
const SETTINGS_BACKUP_NAME_RE = /^設定バックアップ_(自動|手動)_\d{4}年\d{2}月\d{2}日_\d{2}時\d{2}分\d{2}秒\.json$/;

// kind: 'auto'(設定保存・復元時に自動作成) | 'manual'(管理画面から手動作成)
async function saveSettingsBackup(data, { kind = 'auto', logger = console } = {}) {
  try {
    await fsp.mkdir(_getSettingsBackupsDir(), { recursive: true });
    const now = new Date();
    const kindLabel = kind === 'manual' ? '手動' : '自動';
    const filename = `設定バックアップ_${kindLabel}_${_timestampForFilename(now)}.json`;
    const destPath = path.join(_getSettingsBackupsDir(), filename);

    await fsp.writeFile(destPath, JSON.stringify(data, null, 2), 'utf8');

    logger.info && logger.info(`[backup] 設定バックアップを作成しました: ${filename}`);
    return { success: true, path: destPath, filename };
  } catch (e) {
    logger.warn && logger.warn(`[backup] 設定バックアップの作成に失敗しました: ${e.message}`);
    return { success: false, message: e.message };
  }
}

// 保持件数・保持日数を超えた古い設定バックアップを削除する(DBバックアップと同じ方針)。
// 外部ストレージ使用中で内部側に移行待ちが残っている場合、そちらにも
// 同じ保持ルールを独立して適用する(DBバックアップのpruneOldBackupsと同様)。
async function pruneOldSettingsBackups({ retentionDays = DEFAULT_SETTINGS_RETENTION_DAYS, maxBackups = DEFAULT_MAX_SETTINGS_BACKUPS, logger = console } = {}) {
  try {
    const activeDir = _getSettingsBackupsDir();
    const usingExternal = path.resolve(activeDir) !== path.resolve(SETTINGS_BACKUP_DIR);

    const activeResult = await _pruneDir(activeDir, SETTINGS_BACKUP_NAME_RE, { retentionDays, maxBackups, logger, label: usingExternal ? '設定・外部' : '設定' });
    let deleted = activeResult.deleted;
    let remaining = activeResult.remaining;

    if (usingExternal) {
      const internalResult = await _pruneDir(SETTINGS_BACKUP_DIR, SETTINGS_BACKUP_NAME_RE, { retentionDays, maxBackups, logger, label: '設定・内部・移行待ち' });
      deleted += internalResult.deleted;
      remaining += internalResult.remaining;
    }

    return { success: true, deleted, remaining };
  } catch (e) {
    logger.warn && logger.warn(`[backup] 設定バックアップの整理に失敗しました: ${e.message}`);
    return { success: false, message: e.message };
  }
}

// 一覧表示用。中身をその場で確認できるよう、パース済みのJSONも一緒に返す。
// (設定JSONは高々数KB程度のため、一覧取得時にまとめて読み込んでも問題にならない)
// DBバックアップのlistBackups()と同様、外部ストレージ使用中は内部に残る
// 移行待ちの設定バックアップも location:'internal' として一緒に返す。
async function listSettingsBackups() {
  try {
    const files = await _statFilesAcross(_getSettingsBackupsDir(), SETTINGS_BACKUP_DIR, SETTINGS_BACKUP_NAME_RE);
    const withContent = await Promise.all(files.map(async (f) => {
      const kindMatch = f.name.match(/^設定バックアップ_(自動|手動)_/);
      const kind = kindMatch ? (kindMatch[1] === '手動' ? 'manual' : 'auto') : '';
      let content = null;
      try {
        content = JSON.parse(await fsp.readFile(f.fullPath, 'utf8'));
      } catch (parseErr) {
        content = null; // 壊れているファイルは中身なしとして一覧には出す
      }
      return { name: f.name, kind, sizeBytes: f.sizeBytes, createdAt: f.createdAt, location: f.location, content };
    }));
    return withContent.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (e) {
    return [];
  }
}

// name(+location)から実ファイルパスを安全に解決する。DBバックアップの
// resolveBackupPath()と同じ考え方(location:'internal'明示時のみ内部を見る)。
function resolveSettingsBackupPath(name, location) {
  if (typeof name !== 'string' || !SETTINGS_BACKUP_NAME_RE.test(name)) {
    throw new Error('不正なバックアップ名です');
  }
  const dir = location === 'internal' ? SETTINGS_BACKUP_DIR : _getSettingsBackupsDir();
  return path.join(dir, name);
}

// 復元実行時などピンポイントで1件だけ読みたい場合用。
// ファイル名はSETTINGS_BACKUP_NAME_REで検証し、ディレクトリトラバーサルを防ぐ。
async function readSettingsBackup(name, location) {
  const fullPath = resolveSettingsBackupPath(name, location);
  const raw = await fsp.readFile(fullPath, 'utf8');
  return JSON.parse(raw);
}

async function deleteSettingsBackup(name, location) {
  const fullPath = resolveSettingsBackupPath(name, location);
  await fsp.unlink(fullPath);
}

module.exports = {
  runBackup, pruneOldBackups, listBackups, inspectBackup, prepareDatabaseRestore, createBackupJob, BACKUP_DIR, BACKUP_NAME_RE,
  setBackupTargetDirs, getBackupDir: _getBackupsDir, getSettingsBackupDir: _getSettingsBackupsDir,
  saveSettingsBackup, pruneOldSettingsBackups, listSettingsBackups, readSettingsBackup, deleteSettingsBackup,
  resolveBackupPath, resolveSettingsBackupPath,
  SETTINGS_BACKUP_DIR, SETTINGS_BACKUP_NAME_RE
};
