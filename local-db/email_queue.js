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
//   1件ごとに独立したキュー行として管理し、成功したら sent_at を記録する
//   (行は監査のため残す。古いものは他のバックアップ機構と同様に
//   将来的に掃除してもよいが、量が少ないため今は特に削除しない)。

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
        throw new Error((result && result.message) || 'GAS側でのメール送信に失敗しました(応答がsuccess:trueではありません)');
      }
      db.prepare(`UPDATE email_queue SET sent_at = ?, last_error = '' WHERE id = ?`)
        .run(new Date().toISOString(), row.id);
    } catch (e) {
      const attempts = row.attempts + 1;
      const delay = nextDelayMs(attempts);
      const nextAttemptAt = new Date(Date.now() + delay).toISOString();
      db.prepare(`
        UPDATE email_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?
      `).run(attempts, nextAttemptAt, e.message, row.id);
      if (attempts === 1 || attempts % 5 === 0) {
        logger.warn && logger.warn(
          `[email_queue] ユーザー宛メール送信に失敗しました(${attempts}回目, kind=${row.kind}): ${e.message}。${Math.round(delay / 1000)}秒後に再試行します。`
        );
      }
    }
  }

  async function runOnce() {
    if (!gasConfigured) return; // GAS未設定時はメール送信自体が使えないためスキップ
    if (running) return;
    running = true;
    try {
      const now = new Date().toISOString();
      const rows = db.prepare(`
        SELECT * FROM email_queue WHERE sent_at = '' AND next_attempt_at <= ? ORDER BY id ASC LIMIT 20
      `).all(now);
      for (const row of rows) {
        await processOne(row);
      }
      _cycleCount++;
      if (_cycleCount % 1000 === 0) pruneSentEmails();
    } catch (e) {
      logger.error && logger.error('[email_queue] ワーカー実行中にエラー: ' + e.message);
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

module.exports = { enqueue, createEmailQueueWorker };
