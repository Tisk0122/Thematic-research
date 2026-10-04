'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.LOCAL_DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// 既存DBへのマイグレーション: CREATE TABLE IF NOT EXISTS では既存テーブルに
// 新しい列が追加されないため、起動のたびに不足している列だけを補う。
// 「列が既にある」エラーは無視してよい(冪等)。
function ensureColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}
ensureColumn('sync_state', 'last_nonempty_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('sync_state', 'empty_sync_blocked', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('active_loans', 'return_verify_required', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('history', 'return_verify_required', 'INTEGER NOT NULL DEFAULT 0');
const activeLoanColumns = new Set(db.pragma('table_info(active_loans)').map(row => row.name));
if (!activeLoanColumns.has('unlock_authorized')) {
  ensureColumn('active_loans', 'unlock_authorized', 'INTEGER NOT NULL DEFAULT 0');
  // 既存の準備中レコードは、すでに解錠を試みている可能性があるため保持する。
  db.exec(`UPDATE active_loans SET unlock_authorized = 1
           WHERE NOT EXISTS (SELECT 1 FROM history WHERE history.id = active_loans.id)`);
}
ensureColumn('active_loans', 'return_verified_at', "TEXT NOT NULL DEFAULT ''");

// マイグレーション: active_loans.device_id にDBレベルのUNIQUE制約を追加する。
// アプリケーション層のトランザクションでも二重貸出を防いでいるが、
// DBレベルでも保証することで、将来の手動操作やスキーマ変更時の事故を防ぐ。
// SQLiteはALTER TABLE ADD CONSTRAINTを持たないため、UNIQUE INDEXで代替する。
// 既にUNIQUEインデックスが存在する場合は冪等（何もしない）。
// 既存データに重複がある場合はエラーにせず警告のみ（運用を止めないため）。
(function _ensureActiveLoansDeviceUnique() {
  try {
    const idxList = db.pragma('index_list(active_loans)');
    const alreadyUnique = idxList.some(idx => idx.unique === 1 && (() => {
      const info = db.pragma(`index_info(${idx.name})`);
      return info.length === 1 && info[0].name === 'device_id';
    })());
    if (alreadyUnique) return;
    // 重複チェック（安全確認）
    const dup = db.prepare(
      'SELECT device_id, COUNT(*) c FROM active_loans GROUP BY device_id HAVING c > 1'
    ).all();
    if (dup.length > 0) {
      console.error('[db.js] active_loans に device_id の重複があるためUNIQUEインデックスを作成できません:', dup);
      return;
    }
    // 既存の非UNIQUEインデックスを削除してUNIQUEインデックスに置き換える
    db.exec('DROP INDEX IF EXISTS idx_active_device');
    db.exec('CREATE UNIQUE INDEX idx_active_device ON active_loans(device_id)');
  } catch (e) {
    console.error('[db.js] active_loans の UNIQUE インデックス作成に失敗しました（無視して続行）:', e.message);
  }
})();

// バックアップ機構(server.js側)がDBファイルの実体パスを参照できるように
// しておく。呼び出し側の使い方(require('./db') がそのままdbインスタンス)
// を壊さないよう、インスタンスのプロパティとして生やす形にする。
db.__dbFilePath = DB_PATH;

module.exports = db;
