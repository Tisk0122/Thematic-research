'use strict';
// /api/remote-settings* の処理。HTTP(認証・CORS)は server.js 側が担当し、
// ここは「メソッド・パス・本文」を受けて {status, body} を返すだけにして単体テストしやすくする。

const RS = require('./remote_settings');

function publicSchema() {
  return Object.keys(RS.REMOTE_SCHEMA).map(key => {
    const d = RS.REMOTE_SCHEMA[key];
    return { key, label: d.label, group: d.group, type: d.type, unit: d.unit || '', options: d.options || null };
  });
}

function summarize(req) {
  return Object.keys(req.changes).map(k => (RS.REMOTE_SCHEMA[k] || {}).label || k);
}

function createRemoteSettingsApi({ getSettings, applySettings, audit, logger = console, job, gasConfigured, intervalMs, snapshotBefore }) {
  // getSettings(): { settings, updatedAt }
  async function handle(method, pathname, bodyText) {
    try {
      if (method === 'GET' && pathname === '/api/remote-settings') {
        RS.expireOld();
        const cur = getSettings();
        const state = RS.getState();
        return {
          status: 200,
          body: {
            ok: true,
            mode: state.mode,
            lockedKeys: state.lockedKeys,
            autoKeys: state.autoKeys,
            schema: publicSchema(),
            settingsVersion: RS.settingsVersion(cur),
            pending: RS.listPending().map(r => ({ ...r, rows: RS.buildDiff(r, cur.settings) })),
            history: RS.listHistory(30).map(r => ({ ...r, labels: summarize(r) })),
            poll: {
              gasConfigured: !!gasConfigured, intervalMs: intervalMs || null,
              lastPollAt: state.lastPollAt, lastOkAt: state.lastOkAt, lastError: state.lastError
            }
          }
        };
      }

      if (method === 'GET' && pathname === '/api/remote-settings/summary') {
        RS.expireOld();
        return { status: 200, body: { ok: true, pending: RS.pendingCount(), mode: RS.getState().mode } };
      }

      if (method === 'POST' && pathname === '/api/remote-settings/decision') {
        let b;
        try { b = JSON.parse(bodyText || '{}'); } catch (_) { return { status: 400, body: { ok: false, error: 'リクエスト形式が不正です' } }; }
        if (!b || typeof b.id !== 'string') return { status: 400, body: { ok: false, error: '依頼IDが必要です' } };
        const before = RS.getRequest(b.id);
        // 適用前の設定を復元用に残す（失敗しても承認処理は止めない）。
        if (snapshotBefore && Array.isArray(b.acceptKeys) && b.acceptKeys.length > 0) {
          try { await snapshotBefore(); } catch (_) { }
        }
        const result = RS.decide(b.id, {
          acceptKeys: Array.isArray(b.acceptKeys) ? b.acceptKeys : [],
          decidedBy: '教室PC管理画面',
          expectedVersion: b.expectedVersion === undefined ? undefined : b.expectedVersion,
          note: typeof b.note === 'string' ? b.note : ''
        }, { getSettings, applySettings });
        if (!result.ok) {
          const status = ['stale', 'expired', 'not_pending'].includes(result.code) ? 409 : (result.code === 'not_found' ? 404 : 400);
          return { status, body: { ok: false, code: result.code, error: result.error } };
        }
        const labels = (result.appliedKeys || []).map(k => RS.REMOTE_SCHEMA[k].label).join('、');
        await audit('remote_settings_decision',
          `リモート設定の依頼 ${b.id}（依頼者: ${before ? before.createdBy || '不明' : '不明'}）を${
            result.status === 'applied' ? '承認' : result.status === 'partial' ? '一部承認' : '却下（ローカルのまま）'}${labels ? '：' + labels : ''}`,
          b.id);
        logger.info && logger.info(`[remote-settings] 依頼 ${b.id}: ${result.status}`);
        if (job) { Promise.resolve().then(() => job.runOnce({ force: true })).catch(() => { }); }
        return { status: 200, body: { ok: true, status: result.status, appliedKeys: result.appliedKeys } };
      }

      if (method === 'POST' && pathname === '/api/remote-settings/config') {
        let b;
        try { b = JSON.parse(bodyText || '{}'); } catch (_) { return { status: 400, body: { ok: false, error: 'リクエスト形式が不正です' } }; }
        const before = RS.getState();
        let state;
        try { state = RS.setConfig({ mode: b.mode, lockedKeys: b.lockedKeys, autoKeys: b.autoKeys }); }
        catch (e) { return { status: 400, body: { ok: false, error: e.message } }; }
        await audit('remote_settings_config',
          `リモート設定の受信設定を変更: モード ${before.mode}→${state.mode} / ローカル固定 ${state.lockedKeys.length}項目 / 自動適用 ${state.autoKeys.map(k => RS.REMOTE_SCHEMA[k].label).join('、') || 'なし'}`, '');
        return { status: 200, body: { ok: true, mode: state.mode, lockedKeys: state.lockedKeys, autoKeys: state.autoKeys } };
      }

      if (method === 'POST' && pathname === '/api/remote-settings/poll-now') {
        if (!job) return { status: 200, body: { ok: false, error: 'リモート設定の取得は無効です' } };
        const r = await job.runOnce({ force: true });
        return { status: 200, body: { ok: !!r.success, skipped: !!r.skipped, received: r.received || 0, error: r.success ? undefined : r.message } };
      }
    } catch (e) {
      logger.warn && logger.warn(`[remote-settings] API エラー: ${e.message}`);
      return { status: 500, body: { ok: false, error: 'サーバーエラー: ' + e.message } };
    }
    return { status: 404, body: { ok: false, error: '見つかりません' } };
  }
  return { handle };
}

module.exports = { createRemoteSettingsApi };
