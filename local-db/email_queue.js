'use strict';
// 生徒本人宛メール（貸出確認・返却確認）の送信キュー。
//
// 【2026-09 GAS経由に復帰】
// 実際のメール送信は、以前(2026-06〜)Node側でnodemailerを使いSMTP経由で
// 直接行っていたが、config.envのSMTP設定(SMTP_USER/SMTP_PASS)を教員側で
// 正しく用意する必要があり、サンプル値のまま起動してしまう等の設定ミスで
// メールが届かないトラブルが発生した。GAS(Code.gs)側は先生向け通知
// (即時アラート・定期レポート)を以前からMailApp.sendEmail()で問題なく
// 送信できているため、生徒本人宛メールもGAS経由に統一し、SMTP設定自体を
// 不要にした。メール本文の組み立て(HTMLテンプレート)もGAS側(Code.gsの
// _buildCheckoutMail/_buildReturnMail)で行う。Node側はキューの管理と
// GASへのPOSTだけを担当する。
//
// - 貸出・返却の確定処理そのものはこのキューへの登録が失敗しても
//   絶対に失敗させない(enqueueは同期的にSQLiteへ書くだけなので
//   ほぼ失敗しないが、念のためtry/catchで包んで呼び出す)。
// - GAS呼び出しが失敗した場合(オフライン・GAS障害・同期トークン不一致等)は、
//   指数バックオフで自動的に再試行する。プロセスを再起動しても
//   SQLiteに残った未送信分は再開時に再試行される。
// - 「同じ貸出/返却について何度も再送してしまう」事故を防ぐため、
//   1件ごとに独立したキュー行として管理し、成功したら sent_at を記録する//   (送信済み行は監査のため一定期間そのまま残すが、無期限に残し続ける
//    わけではない。pruneSentEmails() がSENT_RETENTION_DAYS(30日)を超えた
//    行を自動削除しているため、SQLiteが肥大化することはない)。

const db = require('./db');
const { postJson } = require('./sync');

// リトライ間隔(ミリ秒)。1回目失敗→30秒後、2回目→2分後...と伸ばし、
// 上限30分に達したらそれ以降は30分おきに永続的にリトライし続ける。
const RETRY_SCHEDULE_MS = [
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000
];
function nextDelayMs(attempts) {
  const idx = Math.max(0, Math.min(attempts - 1, RETRY_SCHEDULE_MS.length - 1));
  return RETRY_SCHEDULE_MS[idx];
}

// --- 送信制限・レート制限対策 ---
// Googleの1日の送信上限(MailApp)やGAS側の呼び出し制限に触れないための設定。
const EMAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 未送信のまま7日超は古すぎるため破棄
const SEND_GAP_MS = 1500;                          // 1通ごとの送信間隔(GASへの連続呼び出しを避ける)
const BATCH_LIMIT = 10;                            // 1サイクルで処理する最大件数
const QUOTA_PAUSE_MS = 60 * 60 * 1000;             // 1日上限に達したら1時間キュー全体を停止
const RATE_PAUSE_MS = 10 * 60 * 1000;              // HTTP 429等のレート制限時は10分停止
const MAX_TRANSIENT_FAILS_PER_CYCLE = 3;           // 1サイクル内で一時失敗が続いたら中断(障害時にGASを叩き続けない)
const QUOTA_RE = /上限|quota|too many times|invoked too many|service invoked|exceeded maximum/i;
const RATE_RE = /HTTP 429|HTTP 503|rate limit/i;
const PERMANENT_RE = /invalid email|invalid recipient|宛先が不正/i;

// 失敗の種類を判定する。'quota'(日次上限) | 'rate'(短期レート制限) |
// 'permanent'(再送しても成功しない宛先不正) | 'transient'(通常のリトライ対象)
function classifyFailure(err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = String((err && err.message) || err || '');
  if (code === 'QUOTA' || QUOTA_RE.test(msg)) return 'quota';
  if (code === 'INVALID_RECIPIENT' || PERMANENT_RE.test(msg)) return 'permanent';
  if (RATE_RE.test(msg)) return 'rate';
  return 'transient';
}
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// kind: 'checkout' | 'return'
// payload: GASにそのまま渡すパラメータ
//          (name, email, deviceId, checkoutTime, returnTime, isLate など)
function enqueue(kind, payload) {
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO email_queue (kind, payload_json, attempts, next_attempt_at, created_at)
      VALUES (?, ?, 0, ?, ?)
    `).run(kind, JSON.stringify(payload || {}), now, now);
  } catch (e) {
    // キュー登録自体が失敗しても、貸出・返却本体には絶対に影響させない。
    console.error('[email_queue] キューへの登録に失敗しました(貸出・返却処理には影響ありません): ' + e.message);
  }
}

// gasUrl: GAS WebアプリのURL(server.jsのGAS_URLと同じもの)
// token: 同期用トークン(GAS側でsyncFromLocalと共通のペアリング済みトークンとして検証される)
function createEmailQueueWorker({ gasUrl, token, logger = console, pollIntervalMs = 10 * 1000 } = {}) {
  let timer = null;
  let running = false;
  let _cycleCount = 0;
  let pausedUntil = 0;

  const gasConfigured = !!(gasUrl && token);

  async function processOne(row) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (e) {
      // 壊れたペイロードは再試行しても直らないので送信済み扱いにして捨てる。
      db.prepare(`UPDATE email_queue SET sent_at = ?, last_error = ? WHERE id = ?`)
        .run(new Date().toISOString(), 'payload_json解析エラーのため破棄: ' + e.message, row.id);
      return;
    }

    const recipient = payload.email;
    if (!recipient) {
      // 宛先が無い場合は再試行しても直らないので送信済み扱いにして捨てる。
      db.prepare(`UPDATE email_queue SET sent_at = ?, last_error = ? WHERE id = ?`)
        .run(new Date().toISOString(), '宛先メールアドレスが無いため破棄', row.id);
      return;
    }

    try {
      const result = await postJson(gasUrl, Object.assign(
        {
          action: 'sendUserActionEmail',
          token,
          kind: row.kind,
          idempotencyKey: `${row.id}:${row.created_at}`
        },
        payload
      ), 25000);
      if (!result || result.success !== true) {
        const err = new Error((result && result.message) || 'GAS(success:true)');
        err.code = result && result.errorCode;
        throw err;
      }
      db.prepare(`UPDATE email_queue SET sent_at = ?, last_error = '' WHERE id = ?`)
        .run(new Date().toISOString(), row.id);
      return 'sent';
    } catch (e) {
      const type = classifyFailure(e);
      if (type === 'permanent') {
        // 宛先不正などは再送しても成功しないため、無限リトライせず破棄する。
        db.prepare(`UPDATE email_queue SET sent_at = ?, last_error = ? WHERE id = ?`)
          .run(new Date().toISOString(), '宛先不正のため破棄: ' + e.message, row.id);
        logger.warn && logger.warn(`[email_queue] 宛先不正のため破棄しました(kind=${row.kind}): ${e.message}`);
        return 'permanent';
      }
      if (type === 'quota' || type === 'rate') {
        // 上限に達した状態で全行が再試行し続けるとGAS実行回数を無駄に消費するため、
        // キュー全体を一定時間止める。行は失われず、再開後に古い順から送られる。
        const pauseMs = type === 'quota' ? QUOTA_PAUSE_MS : RATE_PAUSE_MS;
        pausedUntil = Date.now() + pauseMs;
        db.prepare(`UPDATE email_queue SET next_attempt_at = ?, last_error = ? WHERE id = ?`)
          .run(new Date(pausedUntil).toISOString(), e.message, row.id);
        logger.warn && logger.warn(
          `[email_queue] 送信制限に達しました(${type})。${Math.round(pauseMs / 60000)}分間送信を停止します: ${e.message}`
        );
        return type;
      }
      const attempts = row.attempts + 1;
      const delay = nextDelayMs(attempts);
      const nextAttemptAt = new Date(Date.now() + delay).toISOString();
      db.prepare(`
        UPDATE email_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?
      `).run(attempts, nextAttemptAt, e.message, row.id);
      if (attempts === 1 || attempts % 5 === 0) {
        logger.warn && logger.warn(
          `[email_queue] (${attempts}, kind=${row.kind}): ${e.message}${Math.round(delay / 1000)}`
        );
      }
      return 'transient';
    }
  }

  async function runOnce() {
    if (!gasConfigured) return; // GAS
    if (running) return;
    if (Date.now() < pausedUntil) return; // 送信上限/レート制限による停止中
    running = true;
    try {
      const now = new Date().toISOString();
      // 古すぎる未送信メール(7日超)は破棄。永久リトライと古い通知の送信を防ぐ。
      const expired = db.prepare(`
        UPDATE email_queue
        SET sent_at = ?, last_error = '期限切れ(7日超)のため破棄: ' || last_error
        WHERE sent_at = '' AND created_at < ?
      `).run(now, new Date(Date.now() - EMAIL_MAX_AGE_MS).toISOString());
      if (expired.changes > 0) {
        logger.warn && logger.warn(`[email_queue] 期限切れの未送信メール ${expired.changes} 件を破棄しました`);
      }

      const rows = db.prepare(`
        SELECT * FROM email_queue WHERE sent_at = '' AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?
      `).all(now, BATCH_LIMIT);
      let transientFails = 0;
      for (let i = 0; i < rows.length; i++) {
        const outcome = await processOne(rows[i]);
        if (outcome === 'quota' || outcome === 'rate') break;
        if (outcome === 'transient' && ++transientFails >= MAX_TRANSIENT_FAILS_PER_CYCLE) break;
        if (i < rows.length - 1) await _sleep(SEND_GAP_MS);
      }
      _cycleCount++;
      if (_cycleCount % 1000 === 0) pruneSentEmails();
    } catch (e) {
      logger.error && logger.error('[email_queue] : ' + e.message);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;

    if (!gasConfigured) {
      logger.warn && logger.warn(
        '[email_queue] GAS連携(GAS_URL/SYNC_TOKEN)が未設定のため、メール送信機能は無効です。スプレッドシート同期が使えていれば自動的に解消します。'
      );
    }

    runOnce();
    timer = setInterval(runOnce, pollIntervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, runOnce };
}

// 送信済みキュー行の自動掃除。監査のため一定期間は残すが、
// それ以降はSQLiteの肥大化を防ぐため削除する。
const SENT_RETENTION_DAYS = 30;
function pruneSentEmails() {
  try {
    const threshold = new Date(Date.now() - SENT_RETENTION_DAYS * 86400000).toISOString();
    const result = db.prepare(
      "DELETE FROM email_queue WHERE sent_at != '' AND sent_at < ?"
    ).run(threshold);
    if (result.changes > 0) {
      console.log(`[email_queue] 送信済みキュー ${result.changes} 件を削除しました（${SENT_RETENTION_DAYS}日超）`);
    }
  } catch (e) {
    console.error('[email_queue] 送信済みキューの掃除に失敗しました: ' + e.message);
  }
}

module.exports = { enqueue, createEmailQueueWorker, classifyFailure };
