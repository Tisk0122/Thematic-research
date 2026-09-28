-- ============================================================
-- 端末貸出管理システム SQLiteスキーマ
-- GAS(Code.gs)の5シート構成と1:1対応させている。
-- 「貸出中」「貸出記録」は別テーブルに分離せず、GASと同じく
-- active(進行中)とhistory(全履歴)の二重持ちを踏襲する。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 貸出中（GASの「貸出中」シート相当）
CREATE TABLE IF NOT EXISTS active_loans (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL DEFAULT '',
  device_id      TEXT NOT NULL,
  dob            TEXT NOT NULL DEFAULT '',       -- 'YYYY-MM-DD' 正規化済み
  checkout_time  TEXT NOT NULL,                  -- ISO8601
  session_id     TEXT NOT NULL DEFAULT '',
  return_verify_required INTEGER NOT NULL DEFAULT 0,
  unlock_authorized INTEGER NOT NULL DEFAULT 0,
  return_verified_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_active_device ON active_loans(device_id);
CREATE INDEX IF NOT EXISTS idx_active_email  ON active_loans(email);

-- 貸出記録（GASの「貸出記録」シート相当、返却後も残る全履歴）
CREATE TABLE IF NOT EXISTS history (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL DEFAULT '',
  device_id      TEXT NOT NULL,
  dob            TEXT NOT NULL DEFAULT '',
  checkout_time  TEXT NOT NULL,
  session_id     TEXT NOT NULL DEFAULT '',
  return_time    TEXT NOT NULL DEFAULT '',
  return_session_id TEXT NOT NULL DEFAULT '',
  return_verify_required INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT '貸出中'   -- 貸出中 / 返却済 / 延滞返却
);
CREATE INDEX IF NOT EXISTS idx_history_email ON history(email);
-- 端末ごとの使用回数集計・最終返却時刻の取得（自動選定ロジック）を高速化する
CREATE INDEX IF NOT EXISTS idx_history_device ON history(device_id);

-- ブラックリスト
CREATE TABLE IF NOT EXISTS blacklist (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  expiry      TEXT NOT NULL DEFAULT '',   -- '' | 'PERMANENT' | ISO8601
  violations  INTEGER NOT NULL DEFAULT 0
);

-- ユーザー管理（延滞回数・ペナルティ回数の集計。GASの「ユーザー管理」シート相当）
CREATE TABLE IF NOT EXISTS users (
  row_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL DEFAULT '',
  overdue_count  INTEGER NOT NULL DEFAULT 0,
  penalty_count  INTEGER NOT NULL DEFAULT 0,
  restricted_until TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 故障一覧
CREATE TABLE IF NOT EXISTS failures (
  row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    TEXT NOT NULL,
  reported_at  TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  resolved_at  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '故障中',  -- 故障中 / 完了
  loan_id      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_failures_device ON failures(device_id);

-- 運用設定（1行のみ。GASの PropertiesService 相当）
CREATE TABLE IF NOT EXISTS settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data_json   TEXT NOT NULL,
  updated_at  TEXT,
  updated_by  TEXT NOT NULL DEFAULT ''
);

-- パスコード試行のロックアウト状態（GASの CacheService 相当）
CREATE TABLE IF NOT EXISTS passcode_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  fail_count     INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT NOT NULL DEFAULT ''  -- ISO8601、空なら未ロック
);

-- 延滞アラートの直近送信状態（重複送信防止用。GASの ScriptProperties 相当）
CREATE TABLE IF NOT EXISTS notify_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  overdue_ids_json TEXT NOT NULL DEFAULT '[]',
  last_sent_at     TEXT NOT NULL DEFAULT ''
);

-- Googleスプレッドシートへの同期状況（監視用）
CREATE TABLE IF NOT EXISTS sync_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  last_ok_at             TEXT,
  last_error             TEXT,
  last_error_at          TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  last_nonempty_count    INTEGER NOT NULL DEFAULT 0,
  empty_sync_blocked     INTEGER NOT NULL DEFAULT 0
);

-- 生徒本人宛メール（貸出確認・返却確認）の送信キュー。
-- 実際の送信はGAS経由で行う。失敗しても貸出・返却本体の
-- 処理には一切影響しない(永続化して再試行する)。
CREATE TABLE IF NOT EXISTS email_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,           -- 'checkout' | 'return'
  payload_json   TEXT NOT NULL,           -- GASへ渡すパラメータ一式
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,          -- ISO8601。この時刻以降にリトライ対象とする
  last_error     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  sent_at        TEXT NOT NULL DEFAULT '' -- 送信成功したら記録。30日後に自動削除(email_queue.js:pruneSentEmails)
);
CREATE INDEX IF NOT EXISTS idx_email_queue_pending ON email_queue(next_attempt_at) WHERE sent_at = '';
