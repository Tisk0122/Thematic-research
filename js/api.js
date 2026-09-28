'use strict';

const store = { loans: [], failures: [] };

// 生徒画面で使う貸出・返却と参照はSQLiteで処理する。
// 外部GAS向けクールダウンの対象から分け、GASの4xx応答でローカル操作を止めない。
const LOCAL_API_ACTIONS = new Set([
  'getLoans', 'getFailures',
  'checkoutPrepare', 'checkoutCommit', 'checkoutCancel',
  'returnVerify', 'returnComplete'
]);

let _gasCooldownUntil = 0;       // この時刻(ms)まで GAS 呼び出しをスキップ
let _gasConsecutiveFailures = 0; // 連続失敗回数
const GAS_COOLDOWN_BASE_MS = 30_000;   // 初回クールダウン: 30秒
const GAS_COOLDOWN_MAX_MS = 300_000;   // 最大クールダウン: 5分

function _isGasOnCooldown() {
  return Date.now() < _gasCooldownUntil;
}

function _extendGasCooldown() {
  _gasConsecutiveFailures++;
  const delay = Math.min(
    GAS_COOLDOWN_BASE_MS * Math.pow(2, _gasConsecutiveFailures - 1),
    GAS_COOLDOWN_MAX_MS
  );
  _gasCooldownUntil = Date.now() + delay;
}

function _resetGasCooldown() {
  _gasConsecutiveFailures = 0;
  _gasCooldownUntil = 0;
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError = null;
  const method = String(options.method || 'GET').toUpperCase();
  const retryable = method === 'GET' || method === 'HEAD';

  for (let attempt = 0; attempt <= (retryable ? maxRetries : 0); attempt++) {
    if (attempt > 0) {
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.warn(`[API] リトライ ${attempt}/${maxRetries}: ${url}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    let timeoutId;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒タイムアウト

      const res = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      if (!res.ok) {
        // エラー応答でもJSONボディ({ok:false, error, connected}等)が
        // 返ってくることが多いため、可能な限り読み取ってerrに保持しておく。
        // これにより呼び出し側は「サーバーに届いたが失敗した」のか
        // 「サーバーにすら届かなかった」のかを正確に区別できる。
        let body = null;
        try { body = await res.clone().json(); } catch (_) { /* JSONでない/読めない場合は無視 */ }
        const err = new Error((body && body.error) || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastError = e;
      if (!retryable && !e.status) {
        const uncertainError = new Error('通信結果を確認できませんでした。処理済みの可能性があります。画面を更新して状態を確認してください。');
        uncertainError.cause = e;
        uncertainError.uncertain = true;
        throw uncertainError;
      }
      if (e.status >= 400 && e.status < 500) throw e; // クライアントエラーはリトライしない
      if (attempt === maxRetries) throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  throw lastError;
}

// 個人情報（氏名・メールアドレス・生年月日など）を含みうるアクションは
// GETのクエリ文字列に載せない。サーバーのアクセスログやブラウザ履歴、
// 経路上のプロキシ・CDNのログに平文で残ってしまうのを避けるため、
// 管理画面側(js/admin.js の GAS_WRITE_ACTIONS)と同じ方針でPOSTに送る。
// server.js の /api/gas は GET・POST どちらでも同じアクションを
// 受け付けるようになっているため、ここを直すだけで安全になる。
// GAS_WRITE_ACTIONS は js/config.js または admin.js から共有される定数を使用
// ここでは重複定義を避け、admin.js の定義を参照する

async function gasCall(action, params = {}) {
  if (LOCAL_API_ACTIONS.has(action)) {
    if (GAS_WRITE_ACTIONS.has(action)) {
      return localCall('/api/gas', {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action }, params))
      });
    }
    const query = new URLSearchParams(Object.assign({ action }, params));
    return localCall(`/api/gas?${query.toString()}`, { method: 'GET' });
  }

  if (!navigator.onLine) {
    if (typeof _setConnState === 'function') _setConnState('gas', false);
    throw new Error('現在オフラインです。インターネット接続を確認してください。');
  }

  if (_isGasOnCooldown()) {
    if (typeof _setConnState === 'function') _setConnState('gas', false);
    const remain = Math.ceil((_gasCooldownUntil - Date.now()) / 1000);
    const err = new Error(`GAS エラー多発のため ${remain} 秒待機中`);
    err._gasCooldown = true;
    throw err;
  }

  try {
    let data;
    if (GAS_WRITE_ACTIONS.has(action)) {
      const url = `${ARDUINO_SERVER}/api/gas`;
      data = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, params))
      });
    } else {
      const url = new URL(`${ARDUINO_SERVER}/api/gas`);
      url.searchParams.set('action', action);
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      data = await fetchWithRetry(url.toString(), { method: 'GET' });
    }
    _resetGasCooldown();
    if (typeof _setConnState === 'function') _setConnState('gas', true);
    return data;
  } catch (e) {
    if (typeof _setConnState === 'function') _setConnState('gas', false);
    if (e.status >= 400 && e.status < 500) {
      _extendGasCooldown();
    }
    console.error(`[GAS] ${action} 失敗:`, e);
    throw e;
  }
}

async function localCall(path, options = {}) {
  const url = `${ARDUINO_SERVER}${path}`;
  const defaultOptions = {
    method: 'GET',
    headers: {}
  };

  // バグ修正: 以前は localStorage.getItem('admin_token') を参照していたが、
  // 書き込み側（js/ui.js の管理者手動解錠ダイアログ）を sessionStorage に
  // 統一したことに合わせる。localStorage のままだとタブ/ブラウザを閉じても
  // トークンが消えず、キオスク端末に管理者権限が意図せず残留してしまう。
  const token = sessionStorage.getItem('admin_token');
  if (token) {
    defaultOptions.headers['Authorization'] = `Bearer ${token}`;
  }

  const mergedOptions = {
    ...defaultOptions,
    ...options,
    headers: { ...defaultOptions.headers, ...options.headers }
  };

  if (mergedOptions.body && !mergedOptions.headers['Content-Type']) {
    mergedOptions.headers['Content-Type'] = 'application/json';
  }

  try {
    const data = await fetchWithRetry(url, mergedOptions);
    if (typeof _setConnState === 'function') _setConnState('server', true);
    return data;
  } catch (e) {
    if (typeof _setConnState === 'function') _setConnState('server', false);
    console.error(`[Local] ${path} 失敗:`, e);
    throw e;
  }
}
