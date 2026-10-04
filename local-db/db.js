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

// バックアップ機構(server.js側)がDBファイルの実体パスを参照できるように
// しておく。呼び出し側の使い方(require('./db') がそのままdbインスタンス)
// を壊さないよう、インスタンスのプロパティとして生やす形にする。
db.__dbFilePath = DB_PATH;

module.exports = db;
