'use strict';
// ローカルSQLite → Googleスプレッドシートへの一方向ミラー同期。
//
// 設計方針:
// - 失敗してもキオスクの主要機能(貸出・返却・解錠)には一切影響しない
//   (呼び出し側は結果を待たない。エラーは記録するだけ)
// - 学校規模(端末12台程度)を前提に、差分計算はせず毎回スナップショットを
//   丸ごと送る。件数が少ないうちはこれが一番壊れにくい。
// - 書き込み系アクションの直後に「早めに1回」実行(数秒デバウンス)しつつ、
//   バックストップとして一定間隔でも実行する。

const db = require('./db');

// 【重要】./lending をファイル先頭でrequireしてはいけない。
// 依存関係が lending.js → email_queue.js → sync.js → lending.js という
// 循環(circular require)になっており、起動時にこのファイルの先頭で
// require('./lending') を評価すると、lending.js がまだ読み込み途中
// (module.exports代入前)のため、getLoans等を含まない空オブジェクトを
// 掴んでしまう(Node.jsの循環require特有の挙動)。
// その空オブジェクトはlending.jsの読み込み完了後も更新されないため、
// gatherSnapshot()実行時に毎回「L.getLoans is not a function」で
// 同期が失敗し続ける(GASに一切到達しない)原因になっていた。
// 実際に呼び出される関数の中でrequireすることで、その時点では
// lending.jsの読み込みが完了しており、正しいエクスポートを取得できる
// (2回目以降はrequireキャッシュが効くのでコストもほぼ無い)。
function gatherSnapshot() {
  const L = require('./lending');
  const active = L.getLoans().loans.filter(loan => !loan.isPrepared);
  const history = L.getHistory().history;
  const failures = L.getFailures().failures;
  const blacklist = db.prepare(`
    SELECT email, name, reason, created_at as createdAt, expiry, violations
    FROM blacklist
  `).all();
  const users = db.prepare(`
    SELECT email, name, overdue_count as overdueCount, penalty_count as penaltyCount, restricted_until as restrictedUntil
    FROM users
  `).all();
  const settings = L.getSettings().settings;
  return { active, history, blacklist, failures, users, settings };
}

// GASのWebアプリはPOSTへの応答として302リダイレクト(実データは
// script.googleusercontent.com側)を返すことがある。これは正常な挙動なので、
// server.jsのproxyToGasと同様にfetch({ redirect: 'follow' })でリダイレクトを
// 自動追従する。Node標準のhttp/httpsモジュールを直接使うとリダイレクトを
// 追わずに「HTTP 302」を失敗として扱ってしまうため、あえてfetchを使う。
async function postJson(urlStr, bodyObj, timeoutMs) {
  const body = JSON.stringify(bodyObj);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);
  let res;
  let text;
  try {
    res = await fetch(urlStr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'follow',
      signal: controller.signal
    });
    // レスポンスボディの読み取り中もタイムアウトを有効に保つ。
    // 旧実装はヘッダ受信までしかタイムアウトが効かず、ボディが滞留すると
    // runOnce()が永久に終わらず running=true のまま同期ジョブ全体が停止した。
    text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('レスポンスの解析に失敗しました: ' + e.message);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('タイムアウトしました');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function recordSuccess(recordCount) {
  const row = db.prepare('SELECT last_nonempty_count FROM sync_state WHERE id = 1').get();
  const prevBaseline = row ? row.last_nonempty_count : 0;
  // recordCountが0の同期(例: 現在の貸出0件など通常の状態)では、
  // 「最後に確認できた実データ件数」の基準値は据え置く。
  const newBaseline = recordCount > 0 ? recordCount : prevBaseline;
  db.prepare(`
    INSERT INTO sync_state (id, last_ok_at, last_error, last_error_at, consecutive_failures, last_nonempty_count, empty_sync_blocked)
    VALUES (1, ?, NULL, NULL, 0, ?, 0)
    ON CONFLICT(id) DO UPDATE SET last_ok_at = excluded.last_ok_at, last_error = NULL, consecutive_failures = 0, last_nonempty_count = excluded.last_nonempty_count, empty_sync_blocked = 0
  `).run(new Date().toISOString(), newBaseline);
}

function recordFailure(message) {
  const row = db.prepare('SELECT consecutive_failures FROM sync_state WHERE id = 1').get();
  const failures = (row ? row.consecutive_failures : 0) + 1;
  db.prepare(`
    INSERT INTO sync_state (id, last_error, last_error_at, consecutive_failures) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at, consecutive_failures = excluded.consecutive_failures
  `).run(message, new Date().toISOString(), failures);
  return failures;
}

// 「全データが消えている」ことを理由に同期を中断した場合の記録。
// last_nonempty_count はここでは書き換えない(次にrecordSuccessが
// 実データ付きで呼ばれるまで、基準値として保持し続ける)。
function recordBlockedEmpty(message) {
  const row = db.prepare('SELECT consecutive_failures FROM sync_state WHERE id = 1').get();
  const failures = (row ? row.consecutive_failures : 0) + 1;
  db.prepare(`
    INSERT INTO sync_state (id, last_error, last_error_at, consecutive_failures, empty_sync_blocked)
    VALUES (1, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at, consecutive_failures = excluded.consecutive_failures, empty_sync_blocked = 1
  `).run(message, new Date().toISOString(), failures);
  return failures;
}

// 管理者が「データ初期化」を意図的に実行した直後に呼ぶ。
// 空になったことを正常な基準値として採用し直し、次回の同期が
// (事故ではなく意図的な変更として)ブロックされないようにする。
function resetEmptyGuard() {
  db.prepare(`
    INSERT INTO sync_state (id, last_nonempty_count, empty_sync_blocked) VALUES (1, 0, 0)
    ON CONFLICT(id) DO UPDATE SET last_nonempty_count = 0, empty_sync_blocked = 0
  `).run();
}

function getSyncStatus() {
  return db.prepare('SELECT * FROM sync_state WHERE id = 1').get() || {
    last_ok_at: null, last_error: null, last_error_at: null, consecutive_failures: 0,
    last_nonempty_count: 0, empty_sync_blocked: 0
  };
}

function createSyncJob({ gasUrl, token, intervalMs = 3 * 60 * 1000, logger = console, failureWarnThreshold = 5 } = {}) {
  let timer = null;
  let running = false;
  let pendingRerun = false;
  let debounceTimer = null;

  async function runOnce() {
    if (!gasUrl) {
      return { success: false, message: 'GAS_URL未設定のためスプレッドシート同期をスキップしました' };
    }
    if (!token) {
      return { success: false, message: 'SYNC_TOKEN未設定のためスキップしました' };
    }
    if (running) { pendingRerun = true; return { success: false, message: '実行中のため次回にまとめます' }; }

    running = true;
    try {
      const snapshot = gatherSnapshot();
      // 「貸出中」は0件になるのが日常的にありうる(全端末返却済みの状態)ため
      // 対象から外し、時間経過で自然にゼロへ戻ることが基本的にない
      // 貸出記録・ブラックリスト・ユーザー管理・故障一覧の合計件数だけを見る。
      const recordCount = snapshot.history.length + snapshot.blacklist.length
        + snapshot.users.length + snapshot.failures.length;
      const status = getSyncStatus();

      if (recordCount === 0 && status.last_nonempty_count > 0) {
        // 直前まで実データがあったのに、今回は主要データが全て空。
        // ローカルDBが誤って初期化・破損した可能性が高いため、このまま
        // 送信してスプレッドシート側の既存データを消してしまわないよう、
        // 送信自体を中断する(意図的な削除は「データ初期化」機能から行う想定で、
        // その場合は resetEmptyGuard() が呼ばれてこの判定をリセットする)。
        const message = `ローカルDBの貸出記録・ブラックリスト・ユーザー管理・故障一覧が全て空になっているため、スプレッドシートへの同期を中断しました(直前の同期時点では${status.last_nonempty_count}件のデータがありました)。データベースが誤って初期化・破損した可能性があります。意図的にデータを削除した場合は、管理画面の「データ初期化」から実行してください。`;
        const failures = recordBlockedEmpty(message);
        if (failures === 1 || failures % failureWarnThreshold === 0) {
          logger.warn && logger.warn(`[sync] ${message}`);
        }
        return { success: false, message, blocked: true };
      }

      const result = await postJson(gasUrl, Object.assign({ action: 'syncFromLocal', token }, snapshot));
      if (!result || result.success !== true) {
        throw new Error((result && result.message) || '同期に失敗しました(応答がsuccess:trueではありません)');
      }
      recordSuccess(recordCount);
      return { success: true };
    } catch (e) {
      const failures = recordFailure(e.message);
      if (failures === 1 || failures % failureWarnThreshold === 0) {
        logger.warn && logger.warn(`[sync] スプレッドシートへの同期に失敗しました(${failures}回連続): ${e.message}`);
      }
      return { success: false, message: e.message };
    } finally {
      running = false;
      if (pendingRerun) {
        pendingRerun = false;
        setTimeout(() => { runOnce(); }, 2000);
      }
    }
  }

  function start() {
    if (timer) return;
    runOnce();
    timer = setInterval(runOnce, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  // 書き込み系アクションの直後に呼ぶ。連打されても数秒に1回にまとめる。
  function requestSync() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; runOnce(); }, 5000);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  return { start, stop, runOnce, requestSync };
}

// postJsonはemail_queue.js(GAS経由でのユーザー宛メール送信)からも再利用する。
module.exports = { createSyncJob, getSyncStatus, gatherSnapshot, resetEmptyGuard, postJson };