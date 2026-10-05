'use strict';
// GASの「リモート設定依頼」を定期的に取りに行くジョブ。
// 外向きHTTPS(GAS)のみを使い、教室PC側でポートを開けることはない。
// 取得した依頼は承認待ちとして保管するだけで、設定へは反映しない
// (反映は管理画面での承認操作でのみ行われる: remote_settings.decide)。

const RS = require('./remote_settings');

const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

// deps(任意): { applySettings(partial, by), snapshotBefore(), audit(action, detail, target) }
// deps を渡すと、自動適用に指定された項目は承認なしで即時適用される。渡さなければ全て承認待ちになる。
function createRemoteSettingsJob({ gasUrl, token, intervalMs = 3 * 60 * 1000, logger = console, post, onNewPending, deps } = {}) {
  const postJson = post || require('./sync').postJson;
  let timer = null;
  let running = false;
  let backoffUntil = 0;
  let fails = 0;

  async function runOnce({ force = false } = {}) {
    if (!gasUrl) return { success: false, skipped: true, message: 'GAS_URL未設定のためリモート設定の取得をスキップしました' };
    if (!token) return { success: false, skipped: true, message: 'SYNC_TOKEN未設定のためリモート設定の取得をスキップしました' };
    if (RS.getState().mode === 'off') return { success: false, skipped: true, message: 'リモート設定の受信は無効です（ローカルのみで運用中）' };
    if (!force && Date.now() < backoffUntil) return { success: false, skipped: true, message: '再試行待ち' };
    if (running) return { success: false, skipped: true, message: '実行中です' };

    running = true;
    try {
      RS.expireOld();
      const reports = RS.collectReports();
      const wire = reports.map(({ _status, ...rest }) => rest);
      // 現在のポリシー(受信モード・自動適用・ローカル固定)も毎回伝え、依頼画面に表示させる。
      const res = await postJson(gasUrl, { action: 'remoteSettingsSync', token, results: wire, policy: RS.getPolicy() }, 60000);
      if (!res || res.success !== true) {
        throw new Error((res && res.message) || 'リモート設定の取得に失敗しました（応答がsuccess:trueではありません）');
      }
      RS.markReported(reports);

      let stored = 0;
      const requests = Array.isArray(res.requests) ? res.requests.slice(0, 20) : [];
      const autoKeys = new Set(RS.getState().autoKeys);
      for (const raw of requests) {
        // 自動適用の対象が含まれていそうな依頼は、適用前の設定を復元用に残しておく。
        let autoDeps;
        if (deps && raw && raw.changes && typeof raw.changes === 'object' && Object.keys(raw.changes).some(k => autoKeys.has(k))) {
          autoDeps = deps;
          if (deps.snapshotBefore) { try { await deps.snapshotBefore(); } catch (_) { } }
        }
        const r = RS.ingestRequest(raw, { token, autoDeps });
        if (r.result === 'stored') stored++;
        if (r.result === 'stored' && r.autoApplied && r.autoApplied.length > 0) {
          const labels = r.autoApplied.map(k => RS.REMOTE_SCHEMA[k].label).join('、');
          logger.info && logger.info(`[remote-settings] 依頼 ${r.id} の ${labels} を自動適用しました${r.finished ? '' : '（残りは承認待ち）'}`);
          if (deps && deps.audit) {
            try { await deps.audit('remote_settings_auto_apply', `リモート設定を自動適用: ${labels}（依頼 ${r.id}）${r.finished ? '' : ' 残りの項目は承認待ち'}`, r.id); } catch (_) { }
          }
        }
        if (r.result === 'stored' && r.error) logger.warn && logger.warn(`[remote-settings] 自動適用に失敗したため承認待ちにしました (${r.id}): ${r.error}`);
        if (r.result === 'invalid') logger.warn && logger.warn(`[remote-settings] 検証に失敗した依頼を破棄しました (${r.id}): ${r.reason}`);
        if (r.result === 'skipped') logger.warn && logger.warn(`[remote-settings] 不正な依頼をスキップしました: ${r.reason}`);
      }
      RS.applyCancels(res.cancelIds);

      RS.recordPoll(true);
      fails = 0;
      backoffUntil = 0;
      if (stored > 0) {
        logger.info && logger.info(`[remote-settings] 新しい設定変更の依頼を${stored}件受信しました`);
        if (onNewPending) { try { onNewPending(stored); } catch (_) { } }
      }
      return { success: true, received: stored };
    } catch (e) {
      fails++;
      backoffUntil = Date.now() + Math.min(BACKOFF_BASE_MS * Math.pow(2, fails - 1), BACKOFF_MAX_MS);
      // GAS側が古い(remoteSettingsSync未追加)場合は、原因と対処が分かる文言にする。
      const message = /不明なアクション/.test(e.message)
        ? 'GAS側がリモート設定に未対応です。最新の gas/Code.gs を貼り付け、「新しいバージョンとしてデプロイ」してください。'
        : e.message;
      RS.recordPoll(false, message);
      if (fails === 1 || fails % 5 === 0) logger.warn && logger.warn(`[remote-settings] 取得に失敗しました(${fails}回連続): ${message}`);
      return { success: false, message };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    setTimeout(() => { runOnce(); }, 15 * 1000).unref();
    timer = setInterval(() => { runOnce(); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, runOnce };
}

module.exports = { createRemoteSettingsJob };
