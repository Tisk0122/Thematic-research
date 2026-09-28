'use strict';
/* ============================================================
   端末貸出管理システム — 管理者パネル ロジック
   ============================================================ */

// ARDUINO_SERVER は config.js で既に定義されている（window.location.origin）。
const SESSION_KEY = 'admin_session_token';

let sessionToken = null;
try { sessionToken = sessionStorage.getItem(SESSION_KEY); } catch (e) { }

let doorPollTimer = null;
let doorPollEnabled = false;
let overviewSSE = null;
let overviewPollTimer = null;
let adminIdleTimer = null;
const ADMIN_IDLE_LOCK_MS = 5 * 60 * 1000;

/* ============================================================
   API層
   すべての書き込み操作はPOSTで送信する（GETのクエリ文字列に
   個人情報を載せない）。認証トークンも常にAuthorizationヘッダーで
   送り、URLには決して含めない。
   ============================================================ */

async function apiFetch(path, options) {
  options = options || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (sessionToken) headers['Authorization'] = 'Bearer ' + sessionToken;
  const res = await fetch(ARDUINO_SERVER + path, Object.assign({}, options, { headers }));
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (body && body.error === '認証されていません') {
      handleSessionExpired();
    }
  }
  return res;
}

async function apiJson(path, options) {
  const res = await apiFetch(path, options);
  let body;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok && !(body && (body.ok || body.success))) {
    const msg = (body && (body.error || body.message)) || `サーバーエラー (${res.status})`;
    const err = new Error(msg);
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * ローカルAPI (/api/gas) を呼び出す。
 * 書き込みを伴うアクションは常にPOST、参照のみは常にGETで送る。
 * どちらもURLクエリに個人情報を載せることはない
* (書き込みはbody、読み取りはactionパラメータのみ)。
  */
// GAS_WRITE_ACTIONS は config.js で定義済み

async function gasAction(action, params) {
  params = params || {};
  if (GAS_WRITE_ACTIONS.has(action)) {
    return apiJson('/api/gas', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ action }, params))
    });
  }
  const qs = new URLSearchParams(Object.assign({ action }, params)).toString();
  return apiJson('/api/gas?' + qs, { method: 'GET' });
}

function clearAdminBackgroundTasks() {
  if (adminIdleTimer) { clearTimeout(adminIdleTimer); adminIdleTimer = null; }
  if (doorPollTimer) { clearInterval(doorPollTimer); doorPollTimer = null; }
  if (overviewSSE) { try { overviewSSE.close(); } catch (e) { } overviewSSE = null; }
  if (overviewPollTimer) { clearInterval(overviewPollTimer); overviewPollTimer = null; }
  if (viewRefreshTimer) { clearInterval(viewRefreshTimer); viewRefreshTimer = null; }
  if (storagePollTimer) { clearInterval(storagePollTimer); storagePollTimer = null; }
  if (migrateFloatTimer) { clearInterval(migrateFloatTimer); migrateFloatTimer = null; }
}

function handleSessionExpired() {
  sessionToken = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
  // セッション失効時もログアウトと同様にバックグラウンドのタイマー/SSEを
  // 停止する（以前は放置され、401/403を返すAPIを呼び続けてトーストが
  // 繰り返し表示されることがあった）。
  clearAdminBackgroundTasks();
  showLoginScreen();
  showToast('セッションの有効期限が切れました。再度ログインしてください。', 'error');
}

// 改善: 離席時などに管理者が任意のタイミングでセッションを終了できるように、
// 明示的なログアウト機能を追加する(以前は無く、sessionStorageのトークンが
// 残っている間はパスワード再入力なしで管理画面へ再アクセスできてしまっていた)。
async function logoutAdmin() {
  const ok = await showConfirm('ログアウト', '管理画面からログアウトします。よろしいですか？', { okLabel: 'ログアウトする', danger: false });
  if (!ok) return;
  try {
    const res = await apiFetch('/admin/logout', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
  catch (e) {
    console.error('管理者セッションの終了に失敗しました:', e);
    showToast('ログアウトできませんでした。通信状態を確認して、もう一度お試しください。', 'error');
    return;
  }
  sessionToken = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
  clearAdminBackgroundTasks();
  showLoginScreen();
}

// 全画面から抜け出すための明示的な終了（トップバーの「全画面を終了」ボタン）。
// Chromium の --kiosk ウィンドウはページ側の Fullscreen API では解除できない
// ため、管理者セッション認証済みのサーバー API (/api/kiosk/exit) を経由して
// キオスク用ブラウザを閉じ、デスクトップを表示させる（サーバー・データは停止しない）。
// 加えて、万一ページレベル(HTML5)の全画面になっている環境向けに
// document.exitFullscreen() も直接試す。
async function exitAdministratorFullscreen() {
  const ok = await showConfirm('全画面を終了', 'キオスク画面（ブラウザ）を閉じて、デスクトップを表示します。よろしいですか？', { okLabel: '終了する', danger: false });
  if (!ok) return;

  try {
    const res = await apiFetch('/api/kiosk/exit', { method: 'POST' });
    if (!res.ok) {
      showToast('キオスク画面を終了できませんでした', 'error');
      return;
    }
    showToast('キオスク画面を終了しています…');
  } catch (e) {
    showToast('キオスク画面を終了できませんでした', 'error');
  }

  // 保険: ページレベル(HTML5)の全画面になっている場合は直接解除する
  try { if (document.exitFullscreen) document.exitFullscreen(); } catch (e) { }
}

/* ============================================================
   ログイン画面
   バグ修正: パスワードは6〜12桁を許容する。旧実装では
   ログインキーパッドが6桁で自動送信されてしまい、7桁以上の
   パスワードに変更すると二度とログインできなくなっていた。
   ここでは「送信」は明示的なボタン押下でのみ行い、6桁時点でも
   自動送信しない。
   ============================================================ */
const PIN_MAX_LEN = 12;
const PIN_MIN_LEN = 6;
let pinBuffer = '';
let loginBusy = false;

function renderPinDots() {
  const wrap = document.getElementById('pin-dots');
  const len = Math.max(pinBuffer.length, PIN_MIN_LEN);
  wrap.innerHTML = '';
  for (let i = 0; i < Math.max(len, PIN_MIN_LEN); i++) {
    const dot = document.createElement('span');
    // 直前に打った1桁だけ「ポン」と弾むアニメーションを付ける（それ以前の桁は静止させる）
    const isNew = i === pinBuffer.length - 1;
    dot.className = 'pin-dot' + (i < pinBuffer.length ? ' is-filled' : '') + (isNew ? ' is-new' : '');
    wrap.appendChild(dot);
  }
  const btn = document.getElementById('login-submit-btn');
  const canSubmit = pinBuffer.length >= PIN_MIN_LEN && !loginBusy;
  btn.disabled = !canSubmit;
  btn.textContent = pinBuffer.length > PIN_MIN_LEN || pinBuffer.length === PIN_MIN_LEN
    ? 'ログイン'
    : `ログイン（あと${PIN_MIN_LEN - pinBuffer.length}桁）`;
}

function pinShakeError(message) {
  const wrap = document.getElementById('pin-dots');
  const mark = document.getElementById('login-mark');
  wrap.classList.add('is-shake');
  if (mark) mark.classList.add('is-error');
  document.querySelectorAll('.pin-dot').forEach(d => d.classList.add('is-error'));
  document.getElementById('login-error').textContent = message || 'パスワードが違います';
  setTimeout(() => {
    wrap.classList.remove('is-shake');
    if (mark) mark.classList.remove('is-error');
  }, 450);
}

/* 認証成功時：鍵が開く→ドットが波打つ→パネルがふわっと退場、の順で見せてから
   実際の管理画面表示に進む。演出はダミーではなく、成功が確定した後にのみ
   呼ばれるため、実処理の完了を待たせるようなことはしない。 */
function playLoginSuccess() {
  return new Promise((resolve) => {
    const mark = document.getElementById('login-mark');
    const dots = document.getElementById('pin-dots');
    const panel = document.querySelector('.login-panel');
    const sub = document.getElementById('login-sub');
    if (mark) mark.classList.add('is-success');
    if (dots) dots.classList.add('is-success');
    if (sub) sub.textContent = 'ログインしました';
    document.getElementById('login-error').textContent = '';
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const holdMs = reduceMotion ? 80 : 520;
    setTimeout(() => {
      if (panel) panel.classList.add('is-leaving');
      setTimeout(resolve, reduceMotion ? 0 : 230);
    }, holdMs);
  });
}

function initLoginKeypad() {
  const pad = document.getElementById('pin-pad');
  pad.addEventListener('click', (e) => {
    const btn = e.target.closest('.pin-key');
    if (!btn || loginBusy) return;
    const key = btn.dataset.key;
    if (key === 'clear') {
      pinBuffer = '';
    } else if (key === 'back') {
      pinBuffer = pinBuffer.slice(0, -1);
    } else if (/^[0-9]$/.test(key)) {
      if (pinBuffer.length < PIN_MAX_LEN) pinBuffer += key;
    }
    document.getElementById('login-error').textContent = '';
    renderPinDots();
  });

  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('login-screen').classList.contains('is-open') || loginBusy) return;
    if (/^[0-9]$/.test(e.key)) {
      if (pinBuffer.length < PIN_MAX_LEN) pinBuffer += e.key;
      renderPinDots();
    } else if (e.key === 'Backspace') {
      pinBuffer = pinBuffer.slice(0, -1);
      renderPinDots();
    } else if (e.key === 'Enter' && pinBuffer.length >= PIN_MIN_LEN) {
      submitLogin();
    }
  });

  renderPinDots();
}

async function submitLogin() {
  if (pinBuffer.length < PIN_MIN_LEN || loginBusy) return;
  loginBusy = true;
  const btn = document.getElementById('login-submit-btn');
  setBtnLoading(btn);
  try {
    const res = await fetch(ARDUINO_SERVER + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pinBuffer })
    });
    const body = await res.json().catch(() => ({}));
    if (body && body.ok && body.token) {
      sessionToken = body.token;
      try { sessionStorage.setItem(SESSION_KEY, sessionToken); } catch (e) { }
      pinBuffer = '';
      await playLoginSuccess();
      hideLoginScreen();
      await bootAdminApp();
    } else {
      pinBuffer = '';
      renderPinDots();
      pinShakeError(body && body.error ? body.error : 'パスワードが違います');
    }
  } catch (e) {
    pinShakeError('サーバーに接続できません');
  } finally {
    loginBusy = false;
    resetBtn(btn);
    renderPinDots();
  }
}

function showLoginScreen() {
  document.getElementById('login-screen').classList.add('is-open');
  pinBuffer = '';
  renderPinDots();
  document.getElementById('login-error').textContent = '';
  // 前回のログイン成功演出の跡（開いた鍵・退場アニメーション等）を必ずリセットする
  const mark = document.getElementById('login-mark');
  const dots = document.getElementById('pin-dots');
  const panel = document.querySelector('.login-panel');
  const sub = document.getElementById('login-sub');
  if (mark) mark.classList.remove('is-success', 'is-error');
  if (dots) dots.classList.remove('is-success');
  if (panel) panel.classList.remove('is-leaving');
  if (sub) sub.textContent = 'パスワードを入力してください（6〜12桁）';
}
function hideLoginScreen() {
  document.getElementById('login-screen').classList.remove('is-open');
}

async function verifyExistingSession() {
  if (!sessionToken) return false;
  try {
    const res = await apiFetch('/api/security-status');
    return res.ok;
  } catch (e) {
    return false;
  }
}

/* ============================================================
   ビュー切り替え
   バグ修正: 「設定画面で何か入力欄にフォーカスがあるだけ」では
   離脱確認を出さない。実際に値が変更された場合のみ確認する。
   ============================================================ */
let settingsDirty = false;
let settingsSnapshot = null;
const VIEW_LOADERS = {
  overview: loadOverview,
  loans: () => loadLoansData(false),
  recordings: loadRecordings,
  failures: loadFailures,
  blacklist: loadBlacklist,
  users: loadUsers,
  arduino: loadArduinoView,
  settings: loadSettingsView,
  gas: loadBackupsView,
  stats: loadStats,
  audit: loadAuditLog,
  docs: loadDocsView
};

async function showView(id, opts) {
  opts = opts || {};
  if (!opts.force && document.getElementById('view-settings').classList.contains('active') && id !== 'settings' && settingsDirty) {
    const ok = await showConfirm('保存されていない変更があります', '設定画面には保存されていない変更があります。移動すると変更は破棄されます。移動してもよろしいですか？', { okLabel: '破棄して移動' });
    if (!ok) return;
    settingsDirty = false;
  }

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => b.classList.remove('active'));
  const view = document.getElementById('view-' + id);
  if (!view) return;
  view.classList.add('active');
  const navBtn = document.querySelector(`.nav-btn[data-view="${id}"]`);
  if (navBtn) navBtn.classList.add('active');

  document.getElementById('main-scroll').scrollTop = 0;

  if (id !== 'arduino' && doorPollEnabled) toggleDoorPoll(false);
  if (id !== 'recordings') stopStoragePoll();

  const loader = VIEW_LOADERS[id];
  if (loader) {
    try { await loader(); } catch (e) { console.error(e); showToast('データの読み込みに失敗しました: ' + e.message, 'error'); }
  }
}

/* ============================================================
   起動処理
   ============================================================ */
function bindPasswordTouchKeypad(root, focusFirstInput = false) {
  const keypad = root.querySelector('.password-touch-keypad');
  const targetLabel = keypad?.querySelector('[data-keypad-target]');
  if (!keypad || !targetLabel) return;

  let activeInput = root.querySelector('[data-touch-keypad-input]');
  const selectInput = (input) => {
    activeInput = input;
    targetLabel.textContent = `入力先: ${input.dataset.keypadLabel}`;
  };

  root.addEventListener('focusin', (event) => {
    if (event.target.matches('[data-touch-keypad-input]')) selectInput(event.target);
  });
  keypad.addEventListener('click', (event) => {
    const button = event.target.closest('[data-keypad-key]');
    if (!button || !activeInput) return;

    const key = button.dataset.keypadKey;
    if (/^\d$/.test(key)) {
      if (activeInput.maxLength < 0 || activeInput.value.length < activeInput.maxLength) {
        activeInput.value += key;
      }
    } else if (key === 'backspace') {
      activeInput.value = activeInput.value.slice(0, -1);
    } else if (key === 'clear') {
      activeInput.value = '';
    }

    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeInput.focus({ preventScroll: true });
  });

  if (focusFirstInput) activeInput?.focus({ preventScroll: true });
}

async function requirePasswordChange() {
  const status = await apiJson('/api/security-status');
  if (!status.adminPasswordIsDefault) return false;

  const overlay = document.createElement('div');
  overlay.className = 'initial-password-overlay';
  overlay.innerHTML = `
    <form id="initial-password-form" class="initial-password-panel" role="dialog" aria-modal="true" aria-labelledby="initial-password-title">
      <h2 id="initial-password-title">初期パスワードを変更してください</h2>
      <p>安全のため、初期パスワードは早めに変更してください。</p>
      <label>現在のパスワード<input class="input" id="initial-password-current" data-touch-keypad-input data-keypad-label="現在のパスワード" type="password" inputmode="none" autocomplete="current-password" maxlength="12" required></label>
      <label>新しいパスワード（数字6〜12桁）<input class="input" id="initial-password-new" data-touch-keypad-input data-keypad-label="新しいパスワード" type="password" inputmode="none" autocomplete="new-password" minlength="6" maxlength="12" required></label>
      <label>新しいパスワード（確認）<input class="input" id="initial-password-confirm" data-touch-keypad-input data-keypad-label="パスワードの確認" type="password" inputmode="none" autocomplete="new-password" minlength="6" maxlength="12" required></label>
      <div class="password-touch-keypad" role="group" aria-label="数字パッド">
        <div class="password-touch-keypad-status" data-keypad-target aria-live="polite"></div>
        <div class="password-touch-keypad-grid">
          <button type="button" class="password-touch-key" data-keypad-key="1">1</button>
          <button type="button" class="password-touch-key" data-keypad-key="2">2</button>
          <button type="button" class="password-touch-key" data-keypad-key="3">3</button>
          <button type="button" class="password-touch-key" data-keypad-key="4">4</button>
          <button type="button" class="password-touch-key" data-keypad-key="5">5</button>
          <button type="button" class="password-touch-key" data-keypad-key="6">6</button>
          <button type="button" class="password-touch-key" data-keypad-key="7">7</button>
          <button type="button" class="password-touch-key" data-keypad-key="8">8</button>
          <button type="button" class="password-touch-key" data-keypad-key="9">9</button>
          <button type="button" class="password-touch-key password-touch-key-action" data-keypad-key="clear">全消去</button>
          <button type="button" class="password-touch-key" data-keypad-key="0">0</button>
          <button type="button" class="password-touch-key password-touch-key-action" data-keypad-key="backspace">1文字削除</button>
        </div>
      </div>
      <div id="initial-password-error" class="initial-password-error" role="alert"></div>
      <div class="initial-password-actions">
        <button class="btn btn-ghost" id="initial-password-skip" type="button">後で続行</button>
        <button class="btn btn-primary" type="submit">変更して続行</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);
  bindPasswordTouchKeypad(overlay, true);
  overlay.querySelector('#initial-password-skip').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#initial-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = overlay.querySelector('#initial-password-current').value;
    const next = overlay.querySelector('#initial-password-new').value;
    const confirm = overlay.querySelector('#initial-password-confirm').value;
    const error = overlay.querySelector('#initial-password-error');
    if (!/^\d{6,12}$/.test(next)) {
      error.textContent = '新しいパスワードは数字6〜12桁で入力してください。';
      return;
    }
    if (next !== confirm) {
      error.textContent = '確認用パスワードが一致しません。';
      return;
    }
    try {
      await apiJson('/api/change-admin-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
      overlay.remove();
      sessionToken = null;
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
      showLoginScreen();
      showToast('パスワードを変更しました。新しいパスワードでログインしてください。');
    } catch (e) {
      error.textContent = e.message;
    }
  });
  return false;
}

async function bootAdminApp() {
  if (await requirePasswordChange()) return;
  startAdminIdleLock();
  initSettingsGroups();
  await Promise.all([
    refreshHealthStatus(),
    loadOverview()
  ]);
  setupClickableTiles();
  startOverviewLiveUpdates();
  startViewAutoRefresh();
  startMigrateFloatMonitor();
}

function startAdminIdleLock() {
  if (!sessionToken) return;
  const reset = () => {
    if (adminIdleTimer) clearTimeout(adminIdleTimer);
    adminIdleTimer = setTimeout(async () => {
      try {
        const res = await apiFetch('/admin/logout', { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      catch (e) { console.error('管理者の自動ログアウトに失敗しました:', e); }
      sessionToken = null;
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
      clearAdminBackgroundTasks();
      showLoginScreen();
      showToast('無操作のため管理画面をロックしました。再度ログインしてください。');
    }, ADMIN_IDLE_LOCK_MS);
  };
  if (!window.__adminIdleLockBound) {
    ['pointerdown', 'keydown', 'input', 'change', 'touchstart'].forEach(type =>
      document.addEventListener(type, () => {
        if (sessionToken) reset();
      }, { passive: true })
    );
    window.__adminIdleLockBound = true;
  }
  reset();
}

async function initAdmin() {
  initLoginKeypad();
  bindPasswordTouchKeypad(document.getElementById('admin-password-card'));
  const valid = await verifyExistingSession();
  if (valid) {
    hideLoginScreen();
    await bootAdminApp();
  } else {
    sessionToken = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
    showLoginScreen();
  }
  // 初回描画・初回データ取得がすべて完了してから、はじめて演出用の
  // アニメーション（接続状態バナー等）を有効にする。これより前は
  // CSS側でトランジションを無効化してあるため、状態確定前のチラつきが
  // 目立たない（= 画面が読み込まれてから初めてアニメーションする）。
  document.body.classList.add('is-app-ready');
}
document.addEventListener('DOMContentLoaded', initAdmin);

/* ============================================================
   接続状況・ヘルスチェック
   ============================================================ */
function setTopbarStatus(state, text) {
  const dot = document.getElementById('topbar-conn-dot');
  const label = document.getElementById('topbar-conn-text');
  dot.className = 'topbar-status-dot' + (state ? ' is-' + state : '');
  label.textContent = text;
}

async function refreshHealthStatus() {
  try {
    const body = await apiJson('/api/health-status');
    renderHealthBanners(body.warnings || [], body.healthy);
    updateHealthTiles(body.warnings || []);
    const hasDanger = (body.warnings || []).some(w => w.level === 'danger');
    const hasWarn = (body.warnings || []).some(w => w.level === 'warning');
    if (hasDanger) setTopbarStatus('danger', '要対応の項目があります');
    else if (hasWarn) setTopbarStatus('warn', '確認事項があります');
    else setTopbarStatus('ok', '正常に稼働中');
  } catch (e) {
    setTopbarStatus('danger', 'サーバーに接続できません');
  }
}

function renderHealthBanners(warnings, healthy) {
  const wrap = document.getElementById('health-banners');
  if (!warnings.length) {
    wrap.innerHTML = `<div class="banner banner-ok"><svg class="banner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg><div><div class="banner-title">正常に稼働しています</div>現在、対応が必要な項目はありません。</div></div>`;
    return;
  }
  wrap.innerHTML = warnings.map(w => {
    const cls = w.level === 'danger' ? 'banner-danger' : (w.level === 'warning' ? 'banner-warn' : '');
    const style = w.level === 'info' ? 'background:var(--surface-sunken);border-color:var(--border);color:var(--text-sub);' : '';
    const icon = w.level === 'info'
      ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
      : '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
    const view = healthCodeToView(w.code);
    const gotoAttr = view ? ` data-goto="${view}" role="button" tabindex="0"` : '';
    return `<div class="banner ${cls}${view ? ' clickable' : ''}" style="${style}"${gotoAttr}><svg class="banner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${icon}</svg><div>${escHtml(w.message)}</div></div>`;
  }).join('');
}

/* 警告コード → 遷移先ビュー */
const HEALTH_VIEW_MAP = {
  default_admin_password: 'settings',
  gas_configuration: 'gas',
  time_unsynchronized: 'settings',
  camera_unavailable: 'settings',
  sync_blocked_empty: 'settings',
  sync_failing: 'settings',
  backup_stale: 'gas',
  arduino_disconnected: 'arduino',
  notifications_disabled: 'settings',
  notifications_need_sync: 'settings'
};
function healthCodeToView(code) {
  return HEALTH_VIEW_MAP[code] || null;
}

/* ============================================================
   クリックで対象ビューへ遷移（data-goto 属性の委譲）
   ============================================================ */
document.addEventListener('click', (e) => {
  const el = e.target && e.target.closest ? e.target.closest('[data-goto]') : null;
  if (!el) return;
  const view = el.getAttribute('data-goto');
  if (view) showView(view);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (!t || !t.closest) return;
  const el = t.closest('[data-goto]');
  if (!el) return;
  e.preventDefault();
  const view = el.getAttribute('data-goto');
  if (view) showView(view);
});

/* 概要・統計タイルにクリック遷移を設定 */
function setupClickableTiles() {
  const map = {
    'stat-arduino': 'arduino',
    'stat-loaned': 'loans',
    'stat-failures': 'failures',
    'stats-today-loans': 'loans',
    'stats-week-loans': 'loans',
    'stats-month-loans': 'loans',
    'stats-overdue-count': 'users',
    'stats-failed-count': 'failures',
    'stats-bl-count': 'blacklist'
  };
  Object.keys(map).forEach((id) => {
    const inner = document.getElementById(id);
    if (!inner) return;
    const tile = inner.closest('.tile');
    if (tile && !tile.getAttribute('data-goto')) {
      tile.setAttribute('data-goto', map[id]);
      tile.classList.add('clickable');
      tile.setAttribute('role', 'button');
      tile.setAttribute('tabindex', '0');
    }
  });
}

function updateHealthTiles(warnings) {
  const serverOk = true; // health-statusが取得できた時点でサーバーは応答している
  document.getElementById('stat-server').textContent = serverOk ? '稼働中' : '停止中';
  document.getElementById('stat-server').style.color = serverOk ? 'var(--ok-strong)' : 'var(--danger-strong)';
  document.getElementById('stat-server-sub').textContent = serverOk ? '応答しています' : '応答がありません';
  document.getElementById('tile-server-icon').style.background = serverOk ? 'var(--ok-dim)' : 'var(--danger-dim)';
  document.getElementById('tile-server-icon').style.color = serverOk ? 'var(--ok-strong)' : 'var(--danger-strong)';

  const arduinoWarn = warnings.find(w => w.code === 'arduino_disconnected');
  const arduinoOk = !arduinoWarn;
  document.getElementById('stat-arduino').textContent = arduinoOk ? '接続済み' : '未接続';
  document.getElementById('stat-arduino').style.color = arduinoOk ? 'var(--ok-strong)' : 'var(--warn-strong)';
  document.getElementById('stat-arduino-sub').textContent = arduinoOk ? '扉の自動解錠が有効です' : '扉の自動解錠は行われません';
  document.getElementById('tile-arduino-icon').style.background = arduinoOk ? 'var(--ok-dim)' : 'var(--warn-dim)';
  document.getElementById('tile-arduino-icon').style.color = arduinoOk ? 'var(--ok-strong)' : 'var(--warn-strong)';
  updateGlobalArduinoAlert(arduinoOk);
}

/* ============================================================
   Arduino接続状態のグローバルバナー
   ------------------------------------------------------------
   どのタブを見ていても切断中はずっと知らせ続け、再接続した瞬間だけ
   緑のバナーを数秒間だけ表示して自動的に消える。SSE経由の即時更新
   (updateGlobalArduinoAlertFromSse)と、/api/health-statusの取得結果
   (こちらのupdateHealthTiles経由)の両方から呼ばれ、常に最新の状態に
   正確に同期される。
   ============================================================ */
let _arduinoConnKnown = false;
let _arduinoConnected = true;
let _arduinoAlertHideTimer = null;

function updateGlobalArduinoAlert(connected) {
  const el = document.getElementById('global-arduino-alert');
  if (!el) return;
  const prevKnownValue = _arduinoConnKnown ? _arduinoConnected : null;
  _arduinoConnKnown = true;
  _arduinoConnected = !!connected;

  if (_arduinoAlertHideTimer) { clearTimeout(_arduinoAlertHideTimer); _arduinoAlertHideTimer = null; }

  const titleEl = document.getElementById('global-arduino-alert-title');
  const descEl = document.getElementById('global-arduino-alert-desc');

  if (!connected) {
    el.classList.remove('is-reconnected');
    el.classList.add('is-visible');
    document.body.classList.add('has-arduino-alert');
    if (titleEl) titleEl.textContent = 'Arduino（施錠装置）が切断されています';
    if (descEl) descEl.textContent = 'キオスク端末での貸出を停止しています。扉の自動解錠も行われません。';
  } else if (prevKnownValue === false) {
    el.classList.add('is-visible', 'is-reconnected');
    document.body.classList.add('has-arduino-alert');
    if (titleEl) titleEl.textContent = 'Arduino（施錠装置）が再接続されました';
    if (descEl) descEl.textContent = '扉の自動解錠が復旧しました。キオスク端末で貸出を再開できます。';
    _arduinoAlertHideTimer = setTimeout(() => {
      el.classList.remove('is-visible');
      document.body.classList.remove('has-arduino-alert');
    }, 5000);
  } else {
    el.classList.remove('is-visible', 'is-reconnected');
    document.body.classList.remove('has-arduino-alert');
  }
}

/* ============================================================
   概要画面
   ============================================================ */
let _overviewLoading = false; // 二重取得防止（SSEイベントと定期更新が同時に走っても一度に1本だけ）
async function loadOverview() {
  if (_overviewLoading) return;
  _overviewLoading = true;
  try {
    const [loansRes, failuresRes, devicesRes] = await Promise.all([
      gasAction('getLoans'),
      gasAction('getFailures'),
      apiJson('/api/devices').catch(() => ({ devices: [] }))
    ]);
    const loans = (loansRes && loansRes.loans) || [];
    const failures = ((failuresRes && failuresRes.failures) || []).filter(f => !f.resolvedAt && !f.resolved_at);
    const allDeviceIds = (devicesRes && devicesRes.devices) || [];

    const updEl = document.getElementById('overview-updated');
    if (updEl) updEl.textContent = '最終更新: ' + fmtDateTime(new Date().toISOString());

    document.getElementById('stat-loaned').textContent = loans.length;
    document.getElementById('stat-total-devices').textContent = allDeviceIds.length || '—';
    document.getElementById('stat-failures').textContent = failures.length;

    const failedIds = new Set(failures.map(f => f.deviceId || f.device_id));
    const loanByDevice = {};
    loans.forEach(l => { loanByDevice[l.deviceId] = l; });

    const grid = document.getElementById('overview-device-grid');
    if (!allDeviceIds.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><span class="empty-state-text">端末情報を取得できませんでした</span></div>`;
      return;
    }
    grid.innerHTML = allDeviceIds.map(id => {
      const failed = failedIds.has(id);
      const loan = loanByDevice[id];
      let cls = 'door-tile--closed', label = '利用可能', sub = '';
      if (failed) { cls = ''; label = '故障中'; }
      else if (loan) { cls = 'door-tile--open'; label = '貸出中'; sub = escHtml(loan.name || ''); }
      const iconColor = failed ? 'var(--danger-strong)' : (loan ? 'var(--warn-strong)' : 'var(--ok-strong)');
      return `<div class="door-tile ${cls}" ${failed ? 'style="border-color:var(--danger-border);background:var(--danger-dim);"' : ''}>
        <div class="door-tile-id">${escHtml(id)}</div>
        <div class="door-tile-state" style="color:${iconColor}">${label}</div>
        ${sub ? `<div class="door-tile-state" style="font-size:10px;">${sub}</div>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    showToast('概要情報の取得に失敗しました', 'error');
  } finally {
    _overviewLoading = false;
  }
}

function startOverviewLiveUpdates() {
  // SSEが使えればそれを使い、使えなければ定期ポーリングにフォールバックする
  try {
    if (overviewSSE) overviewSSE.close();
    overviewSSE = new EventSource(ARDUINO_SERVER + '/arduino/stream');
    overviewSSE.onmessage = (e) => {
      if (document.getElementById('view-overview').classList.contains('active')) loadOverview();
      if (document.getElementById('view-arduino').classList.contains('active')) fetchAllDoorStatus();

      // Arduinoの接続・切断・再接続はどの画面を見ていてもすぐ反映する
      // （以前は30秒ポーリングでしか更新されず、切断/再接続に気づくのが遅れていた）
      try {
        const data = JSON.parse(e.data);
        if (data && data.type === 'arduino_status') {
          // SSEイベント自身が持つ最新の接続状態を、ネットワーク往復を待たず
          // 即座にグローバルバナーへ反映する（正確さはrefreshHealthStatus側の
          // /api/health-status取得で追って再確認・同期される）。
          updateGlobalArduinoAlert(!!data.connected);
          refreshHealthStatus();
        } else if (data && data.type === 'storage_status') {
          // 外部USB/SDの抜き差しをサーバー側(udev)が検知した合図。
          // どの画面を見ていても、次の定期ポーリングを待たずに
          // 即座に最新の保存先状態を取得して全表示箇所へ反映する。
          pollStorageStatus();
        }
      } catch (_) { }
    };
    overviewSSE.onerror = () => { /* ブラウザが自動再接続するため何もしない */ };
  } catch (e) { /* SSE非対応環境では何もしない（手動更新ボタンで代替） */ }

  if (overviewPollTimer) clearInterval(overviewPollTimer);
  overviewPollTimer = setInterval(() => {
    // ヘルス状態（トップバーの接続状況・警告バナー）はどのタブを見ていても
    // 常に最新でなければならないため、アクティブなビューに関わらず毎回
    // 更新する。以前はここで「概要タブを見ている時だけ」に限定していた
    // ため、他のタブ(貸出一覧・設定など)を開いている間はトップバーの
    // 警告状態が更新されず古いまま固まってしまっていた。
    refreshHealthStatus();
    // 概要データ自体(貸出件数などの集計)は、実際に画面に出ている
    // 「概要」タブでのみ再取得すれば十分（負荷軽減のため）。
    if (!document.getElementById('view-overview').classList.contains('active')) return;
    loadOverview().catch((e) => console.error('概要の定期更新に失敗しました:', e));
  }, 15000);
}

/* ============================================================
   表示中のビューを自動更新（リアルタイム反映）
   overview は上記の SSE + 定期ポーリングで更新されるため対象外。
   settings(編集中の入力が消えないように)・docs(静的)・
   arduino(SSE・扉の自動更新で対応)も対象外。
   ============================================================ */
const VIEW_AUTO_REFRESH_IDS = ['loans', 'recordings', 'failures', 'blacklist', 'users', 'stats', 'gas', 'audit'];
const VIEW_AUTO_REFRESH_INTERVAL = 20000;
const VIEW_REFRESH_IDLE_MS = 10000;
let viewRefreshTimer = null;
let _viewLastActionAt = {};

// ビュー内でユーザーが操作(入力・選択・クリック)したら最終操作時刻を記録。
// 直近 VIEW_REFRESH_IDLE_MS の間に操作があったビューは自動更新をスキップし、
// 編集中や一括選択中の内容を壊さないようにする。
const VIEW_ACTIVITY_EVENTS = ['pointerdown', 'input', 'change', 'keydown', 'click'];

function startViewAutoRefresh() {
  if (viewRefreshTimer) clearInterval(viewRefreshTimer);

  // 各ビューでの操作を監視（イベント委譲で一元管理）
  if (!window.__viewActivityBound) {
    VIEW_ACTIVITY_EVENTS.forEach((type) => {
      document.addEventListener(type, (ev) => {
        const view = ev.target && ev.target.closest ? ev.target.closest('.view') : null;
        if (view && view.id) _viewLastActionAt[view.id.replace('view-', '')] = Date.now();
      });
    });
    window.__viewActivityBound = true;
  }

  viewRefreshTimer = setInterval(() => {
    const now = Date.now();
    for (const id of VIEW_AUTO_REFRESH_IDS) {
      const view = document.getElementById('view-' + id);
      if (!view || !view.classList.contains('active')) continue;
      if ((_viewLastActionAt[id] || 0) > now - VIEW_REFRESH_IDLE_MS) continue; // 操作中はスキップ
      const loader = VIEW_LOADERS[id];
      if (!loader) continue;
      loader().catch((e) => console.error('自動更新に失敗しました: ' + id, e));
    }
  }, VIEW_AUTO_REFRESH_INTERVAL);
}

/* ============================================================
   貸出・履歴
   ============================================================ */
let _activeLoansCache = [];
let _historyCache = [];

async function loadLoansData(forceRefresh) {
  try {
    const [loansRes, historyRes] = await Promise.all([
      gasAction('getLoans'),
      gasAction('getHistory')
    ]);
    _activeLoansCache = (loansRes && loansRes.loans) || [];
    // バグ修正: 供給元(server.js / GAS)はどちらも「新しい順」で履歴を返すため、
    // ここで再度 reverse() すると古い順に戻り、slice(0,300) が最古300件だけを
    // 掴んで最新の記録が画面に表示されなくなっていた。反転せず新しい順のまま持つ。
    _historyCache = ((historyRes && historyRes.history) || []).slice();
    document.getElementById('loans-stat-active').textContent = _activeLoansCache.length;
    document.getElementById('loans-stat-history').textContent = _historyCache.length;
    document.getElementById('loans-cache-time').textContent = '最終更新: ' + fmtDateTime(new Date().toISOString());
    applyActiveFilter();
    applyHistoryFilter();
  } catch (e) {
    showToast('貸出データの取得に失敗しました: ' + e.message, 'error');
  }
}

function _remainingTimeLabel(checkoutTime) {
  // 返却期限は設定依存のため、ここでは経過時間の目安のみを示す簡易表示にする
  const d = new Date(checkoutTime);
  if (isNaN(d.getTime())) return '—';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins}分経過`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}時間経過`;
  return `${Math.floor(hrs / 24)}日経過`;
}

function applyActiveFilter() {
  const q = (document.getElementById('active-search').value || '').trim().toLowerCase();
  const body = document.getElementById('active-table-body');
  const list = _activeLoansCache.filter(l => {
    if (!q) return true;
    return [l.deviceId, l.name, l.email].some(v => (v || '').toLowerCase().includes(q));
  });
  document.getElementById('active-filter-count').textContent = `${list.length} / ${_activeLoansCache.length} 件`;
  document.getElementById('active-empty').style.display = list.length ? 'none' : 'flex';
  document.getElementById('active-empty-text').textContent = _activeLoansCache.length ? '条件に一致する貸出がありません' : '現在貸出中の端末はありません';

  body.innerHTML = list.map(l => `
    <tr>
      <td class="mono">${escHtml(l.deviceId)}</td>
      <td>${escHtml(l.name)}${l.isPrepared ? '<div class="chip chip-warn" style="margin-top:4px;">貸出処理中・記録未確定</div>' : ''}</td>
      <td class="text-sub">${escHtml(l.email)}</td>
      <td>${fmtDateTime(l.checkoutTime)}</td>
      <td class="text-sub">${_remainingTimeLabel(l.checkoutTime)}</td>
      <td style="text-align:right">
        <button class="btn btn-danger btn-sm" onclick="forceReturnLoanById('${escHtml(l.id)}', this)">強制返却</button>
        ${l.isPrepared && l.unlockAuthorized ? `<button class="btn btn-primary btn-sm" onclick="completePreparedCheckoutById('${escHtml(l.id)}', this)">貸出記録を確定</button>` : ''}
      </td>
    </tr>`).join('');
}

function _historyStatusChip(status) {
  if (status === '延滞返却') return `<span class="chip chip-warn"><span class="chip-dot"></span>延滞返却</span>`;
  if (status === '返却済') return `<span class="chip chip-ok"><span class="chip-dot"></span>返却済</span>`;
  return `<span class="chip chip-neutral"><span class="chip-dot"></span>貸出中</span>`;
}

function applyHistoryFilter() {
  const q = (document.getElementById('history-search').value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('history-status-filter').value;
  const body = document.getElementById('history-table-body');
  const list = _historyCache.filter(h => {
    if (statusFilter && h.status !== statusFilter) return false;
    if (!q) return true;
    return [h.deviceId, h.name, h.email].some(v => (v || '').toLowerCase().includes(q));
  }).slice(0, 300);
  document.getElementById('history-filter-count').textContent = `${list.length} / ${_historyCache.length} 件（最大300件表示）`;
  document.getElementById('history-empty').style.display = list.length ? 'none' : 'flex';

  body.innerHTML = list.map(h => `
    <tr>
      <td class="mono">${escHtml(h.deviceId)}</td>
      <td>${escHtml(h.name)}</td>
      <td>${_historyStatusChip(h.status)}</td>
      <td class="text-sub">${fmtDateTime(h.checkoutTime)}</td>
      <td class="text-sub">${h.returnTime ? fmtDateTime(h.returnTime) : '—'}</td>
      <td style="text-align:right">
        <button class="icon-btn" style="width:28px;height:28px;" onclick="openEditHistoryById('${escHtml(h.id)}')" aria-label="編集"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="icon-btn" style="width:28px;height:28px;color:var(--danger-strong);" onclick="deleteHistoryEntry('${escHtml(h.id)}', this)" aria-label="削除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </td>
    </tr>`).join('');
}

async function forceReturnLoan(id, deviceId, name, btn) {
  const ok = await showConfirm('強制返却の確認', `${deviceId}（${name}）を記録上で返却済みにします。実物が棚に戻っていない場合、貸出状況と記録が食い違います。まず実物の所在を確認してください。`, { okLabel: '次へ' });
  if (!ok) return;
  const verified = await showConfirm('最終確認', '端末の実物が戻っている、または管理責任者が所在を確認した場合に限り実行してください。', { okLabel: '強制返却を実行' });
  if (!verified) return;
  setBtnLoading(btn);
  try {
    await gasAction('forceReturnLoan', { id });
    await postAudit('強制返却', `${deviceId} (${name})`);
    showToast('強制返却しました');
    await loadLoansData(true);
    loadOverview();
  } catch (e) {
    showToast('強制返却に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

function forceReturnLoanById(id, btn) {
  const loan = _activeLoansCache.find(x => x.id === id);
  if (loan) return forceReturnLoan(loan.id, loan.deviceId, loan.name || '', btn);
}

async function completePreparedCheckoutById(id, btn) {
  const loan = _activeLoansCache.find(item => item.id === id && item.isPrepared && item.unlockAuthorized);
  if (!loan) return;
  const confirmed = await showConfirm(
    '未確定の貸出を復旧',
    `${loan.deviceId} は解錠を試みた後、貸出記録が未確定です。実物が生徒へ渡っていることを確認してから貸出記録を確定してください。`,
    { okLabel: '実物を確認して確定する' }
  );
  if (!confirmed) return;
  setBtnLoading(btn);
  try {
    await gasAction('checkoutCommit', { loanId: loan.id, adminRecovery: true });
    await postAudit('貸出復旧', `${loan.deviceId} (${loan.name})`);
    showToast('貸出記録を確定しました');
    await loadLoansData(true);
    loadOverview();
  } catch (e) {
    showToast('貸出記録の復旧に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function deleteHistoryEntry(id, btn) {
  const ok = await showConfirm('履歴を削除', 'この履歴を削除します。この操作は取り消せません。', { okLabel: '削除する' });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await gasAction('deleteHistoryEntry', { id });
    await postAudit('履歴削除', id);
    showToast('履歴を削除しました');
    await loadLoansData(true);
  } catch (e) {
    showToast('削除に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

function openEditHistory(h) {
  document.getElementById('eh-id').value = h.id;
  document.getElementById('eh-name').value = h.name || '';
  document.getElementById('eh-email').value = h.email || '';
  document.getElementById('eh-device').value = h.deviceId || '';
  document.getElementById('eh-status').value = h.status || '貸出中';
  openDialog('edit-history-overlay');
}

function openEditHistoryById(id) {
  const h = _historyCache.find(x => x.id === id);
  if (h) openEditHistory(h);
}

async function submitEditHistory(btn) {
  const id = document.getElementById('eh-id').value;
  setBtnLoading(btn);
  try {
    await gasAction('editHistoryEntry', {
      id,
      name: document.getElementById('eh-name').value.trim(),
      email: document.getElementById('eh-email').value.trim(),
      deviceId: document.getElementById('eh-device').value.trim(),
      status: document.getElementById('eh-status').value
    });
    await postAudit('履歴編集', id);
    showToast('履歴を更新しました');
    closeDialog('edit-history-overlay');
    await loadLoansData(true);
  } catch (e) {
    showToast('更新に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function confirmClearData(target) {
  const label = target === 'active' ? '貸出中データ' : '全履歴';
  const ok = await showConfirm(`${label}を削除`, `${label}をすべて削除します。この操作は取り消せません。\n※ 貸出中の記録が1件でもあると削除できません。`, { okLabel: target === 'history' ? '次へ' : '削除する' });
  if (!ok) return;
  if (target === 'history') {
    const finalOk = await showConfirm(
      '全履歴削除の最終確認',
      '実行前にサーバーがDBの安全バックアップを作成します。バックアップ作成に失敗した場合は削除されません。それでも全履歴を削除しますか？',
      { okLabel: 'バックアップ後に削除', danger: true }
    );
    if (!finalOk) return;
  }
  try {
    await gasAction('clearData', { target });
    await postAudit('データ初期化', `${label} をクリア`);
    showToast(`${label}を削除しました`);
    loadLoansData(true);
    loadOverview();
  } catch (e) {
    showToast('削除に失敗しました: ' + e.message, 'error');
  }
}

/* ============================================================
   故障端末管理
   ============================================================ */
let _failuresCache = [];
let _failuresSelected = new Set();

async function loadFailures() {
  try {
    const [failRes, devicesRes] = await Promise.all([
      gasAction('getFailures'),
      apiJson('/api/devices').catch(() => ({ devices: [] }))
    ]);
    _failuresCache = (failRes && failRes.failures) || [];

    // バグ修正: 再読込(修理完了後や画面再表示)時も選択状態が残っていた。
    // ブラックリスト側(loadBlacklist の _blSelected.clear())と同等に、
    // 選択セット・件数表示・バッチバー・全選択チェックボックスを初期化する。
    _failuresSelected.clear();
    const fbar = document.getElementById('fail-batch-bar');
    if (fbar) fbar.style.display = 'none';
    const fcount = document.getElementById('fail-selected-count');
    if (fcount) fcount.textContent = '0 件選択中';
    const fsel = document.getElementById('fail-select-all');
    if (fsel) fsel.checked = false;

    const select = document.getElementById('fail-input-device');
    const devices = (devicesRes && devicesRes.devices) || [];
    select.innerHTML = devices.map(id => `<option value="${escHtml(id)}">${escHtml(id)}</option>`).join('');

    applyFailuresFilter();
    updateFailuresBadge();
  } catch (e) {
    showToast('故障情報の取得に失敗しました: ' + e.message, 'error');
  }
}

function updateFailuresBadge() {
  const activeCount = _failuresCache.filter(f => !(f.resolvedAt || f.resolved_at)).length;
  const badge = document.getElementById('badge-failures');
  if (activeCount > 0) { badge.style.display = 'block'; badge.textContent = activeCount; }
  else { badge.style.display = 'none'; }
}

function applyFailuresFilter() {
  const q = (document.getElementById('fail-search').value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('fail-status-filter').value;
  const body = document.getElementById('fail-table-body');
  const list = _failuresCache.filter(f => {
    const resolved = !!(f.resolvedAt || f.resolved_at);
    if (statusFilter === 'active' && resolved) return false;
    if (statusFilter === 'resolved' && !resolved) return false;
    if (!q) return true;
    return [f.deviceId, f.name, f.email].some(v => (v || '').toLowerCase().includes(q));
  });
  document.getElementById('fail-filter-count').textContent = `${list.length} / ${_failuresCache.length} 件`;
  document.getElementById('fail-empty').style.display = list.length ? 'none' : 'flex';
  document.getElementById('fail-empty-text').textContent = _failuresCache.length ? '条件に一致する故障記録がありません' : '現在故障中の端末はありません';

  body.innerHTML = list.map(f => {
    const resolved = !!(f.resolvedAt || f.resolved_at);
    const fid = f.id || f.rowId || (f.deviceId + f.reportedAt);
    const checked = !resolved && _failuresSelected.has(fid) ? 'checked' : '';
    return `<tr>
      <td><input type="checkbox" class="checkbox fail-row-check" data-id="${escHtml(fid)}" ${resolved ? 'disabled' : ''} ${checked} onchange="toggleFailureSelect('${escHtml(fid)}', this.checked)"></td>
      <td class="mono">${escHtml(f.deviceId)}</td>
      <td>${resolved ? '<span class="chip chip-ok"><span class="chip-dot"></span>修理済</span>' : '<span class="chip chip-danger"><span class="chip-dot"></span>故障中</span>'}</td>
      <td>${escHtml(f.name || '—')}</td>
      <td class="text-sub">${escHtml(f.email || '—')}</td>
      <td class="text-sub">${fmtDateTime(f.reportedAt || f.reported_at)}</td>
      <td class="text-sub">${resolved ? fmtDateTime(f.resolvedAt || f.resolved_at) : '—'}</td>
      <td style="text-align:right">
        ${resolved ? '' : `<button class="btn btn-primary btn-sm" onclick="resolveFailure('${escHtml(f.deviceId)}', this)">修理完了</button>`}
      </td>
    </tr>`;
  }).join('');
}

function toggleFailureSelect(id, checked) {
  if (checked) _failuresSelected.add(id); else _failuresSelected.delete(id);
  const bar = document.getElementById('fail-batch-bar');
  bar.style.display = _failuresSelected.size ? 'flex' : 'none';
  document.getElementById('fail-selected-count').textContent = `${_failuresSelected.size} 件選択中`;
}

function toggleAllFailures(checkbox) {
  document.querySelectorAll('.fail-row-check:not(:disabled)').forEach(cb => {
    cb.checked = checkbox.checked;
    toggleFailureSelect(cb.dataset.id, checkbox.checked);
  });
}

async function addFailureManual(btn) {
  const deviceId = document.getElementById('fail-input-device').value;
  if (!deviceId) { showToast('対象端末を選択してください', 'error'); return; }
  const ok = await showConfirm('故障として登録', `${deviceId} を故障中として登録します。登録後も現在の貸出記録は残り、端末は返却されるまで貸出中のままです。`, { okLabel: '故障を登録する' });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await gasAction('addFailure', { deviceId, name: '管理者', email: 'admin' });
    // バグ修正: 旧実装では故障の新規登録だけ監査ログに記録されず、
    // 解除だけ記録される不整合があった。登録時も必ず記録する。
    await postAudit('故障登録', `${deviceId} を故障として登録`);
    showToast(`${deviceId} を故障として登録しました`);
    await loadFailures();
    loadOverview();
  } catch (e) {
    showToast('登録に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function resolveFailure(deviceId, btn) {
  const ok = await showConfirm('修理完了にする', `${deviceId} を修理完了として、貸出可能な状態に戻します。`, { okLabel: '修理完了にする', danger: false });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await gasAction('resolveFailure', { deviceId });
    await postAudit('故障解除', `${deviceId} の故障状態を解除`);
    showToast(`${deviceId} を修理完了にしました`);
    await loadFailures();
    loadOverview();
  } catch (e) {
    showToast('処理に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function batchResolveFailures() {
  const ids = Array.from(_failuresSelected);
  if (!ids.length) return;
  const targets = _failuresCache.filter(f => ids.includes(f.id || f.rowId || (f.deviceId + f.reportedAt)));
  const ok = await showConfirm('選択した端末を修理完了にする', `選択した ${targets.length} 件を修理完了として、貸出可能な状態に戻します。`, { okLabel: '実行する', danger: false });
  if (!ok) return;

  // バグ修正: 旧実装は for ループで逐次 await しており、途中で失敗しても
  // 「どこまで成功したか」が分からなかった。Promise.allSettled で全件の
  // 結果を個別に把握し、部分失敗を正確に報告する。
  const results = await Promise.allSettled(targets.map(f => gasAction('resolveFailure', { deviceId: f.deviceId })));
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.length - succeeded;

  if (succeeded > 0) {
    await postAudit('故障一括解除', `${succeeded} 件を修理完了にしました${failed ? `（${failed}件失敗）` : ''}`);
  }
  if (failed === 0) showToast(`${succeeded} 件を修理完了にしました`);
  else showToast(`${succeeded} 件成功、${failed} 件失敗しました`, failed === results.length ? 'error' : undefined);

  await loadFailures();
  loadOverview();
}

/* ============================================================
   ブラックリスト管理
   ============================================================ */
let _blacklistCache = [];
let _blSelected = new Set();

async function loadBlacklist() {
  try {
    const res = await gasAction('getBlacklist');
    _blacklistCache = (res && res.blacklist) || [];
    _blSelected.clear();
    const bbar = document.getElementById('bl-batch-bar');
    if (bbar) bbar.style.display = 'none';
    const bcount = document.getElementById('bl-selected-count');
    if (bcount) bcount.textContent = '0 件選択中';
    const bsel = document.getElementById('bl-select-all');
    if (bsel) bsel.checked = false;
    renderBlacklist();
  } catch (e) {
    showToast('ブラックリストの取得に失敗しました: ' + e.message, 'error');
  }
}

function renderBlacklist() {
  const body = document.getElementById('bl-table-body');
  document.getElementById('bl-empty').style.display = _blacklistCache.length ? 'none' : 'flex';
  body.innerHTML = _blacklistCache.map(b => `
    <tr>
      <td><input type="checkbox" class="checkbox bl-row-check" data-id="${escHtml(b.rowId)}" onchange="toggleBlSelect('${escHtml(b.rowId)}', this.checked)"></td>
      <td>${escHtml(b.name)}</td>
      <td class="text-sub">${escHtml(b.email)}</td>
      <td class="text-sub">${escHtml(b.reason || '—')}</td>
      <td class="text-sub">${fmtDate(b.createdAt)}</td>
      <td class="text-sub">${b.expiry === 'PERMANENT' ? '<span class="chip chip-danger"><span class="chip-dot"></span>永久</span>' : (b.expiry ? fmtDate(b.expiry) : '—')}</td>
      <td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="removeBlacklistById('${escHtml(b.rowId)}', this)">解除</button></td>
    </tr>`).join('');
}

function toggleBlSelect(rowId, checked) {
  if (checked) _blSelected.add(String(rowId)); else _blSelected.delete(String(rowId));
  const bar = document.getElementById('bl-batch-bar');
  bar.style.display = _blSelected.size ? 'flex' : 'none';
  document.getElementById('bl-selected-count').textContent = `${_blSelected.size} 件選択中`;
}
function toggleAllBlacklist(checkbox) {
  document.querySelectorAll('.bl-row-check').forEach(cb => {
    cb.checked = checkbox.checked;
    toggleBlSelect(cb.dataset.id, checkbox.checked);
  });
}

async function addBlacklist(btn) {
  const email = document.getElementById('bl-input-email').value.trim();
  const name = document.getElementById('bl-input-name').value.trim();
  const reason = document.getElementById('bl-input-reason').value.trim();
  if (!email || !name) { showToast('メールアドレスと氏名を入力してください', 'error'); return; }
  const ok = await showConfirm('ブラックリストに登録', `${name}（${email}）を貸出制限対象として登録します。`, { okLabel: '登録する' });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await gasAction('addBlacklist', { email, name, reason });
    await postAudit('BL追加', `${name} (${email})`, reason);
    showToast('ブラックリストに登録しました');
    document.getElementById('bl-input-email').value = '';
    document.getElementById('bl-input-name').value = '';
    document.getElementById('bl-input-reason').value = '';
    await loadBlacklist();
  } catch (e) {
    showToast('登録に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function removeBlacklist(rowId, btn) {
  const record = _blacklistCache.find(item => String(item.rowId) === String(rowId));
  if (!record) return;
  const ok = await showConfirm('ブラックリストを解除', `${record.name}（${record.email || 'メールアドレス未登録'}）の貸出制限を解除します。`, { okLabel: '解除する', danger: false });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await gasAction('removeBlacklist', { rowId: record.rowId });
    await postAudit('BL削除', `${record.name} (${record.email})`);
    showToast('解除しました');
    await loadBlacklist();
  } catch (e) {
    showToast('解除に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

function removeBlacklistById(rowId, btn) {
  removeBlacklist(rowId, btn);
}

async function batchRemoveBlacklist() {
  const rowIds = Array.from(_blSelected);
  if (!rowIds.length) return;
  const targets = _blacklistCache.filter(b => rowIds.includes(String(b.rowId)));
  const ok = await showConfirm('選択した利用者を解除', `選択した ${targets.length} 件のブラックリストを解除します。`, { okLabel: '解除する', danger: false });
  if (!ok) return;

  const results = await Promise.allSettled(targets.map(b => gasAction('removeBlacklist', { rowId: b.rowId })));
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.length - succeeded;

  if (succeeded > 0) {
    await postAudit('BL一括削除', `${succeeded} 件を解除しました${failed ? `（${failed}件失敗）` : ''}`);
  }
  if (failed === 0) showToast(`${succeeded} 件を解除しました`);
  else showToast(`${succeeded} 件成功、${failed} 件失敗しました`, failed === results.length ? 'error' : undefined);

  await loadBlacklist();
}

/* ============================================================
   延滞・ペナルティ（ユーザー管理）
   ============================================================ */
let _usersCache = [];

async function loadUsers() {
  try {
    const res = await gasAction('getUsers');
    _usersCache = (res && res.users) || [];
    renderUsers();
  } catch (e) {
    showToast('利用者データの取得に失敗しました: ' + e.message, 'error');
  }
}

function renderUsers() {
  const body = document.getElementById('users-table-body');
  document.getElementById('users-empty').style.display = _usersCache.length ? 'none' : 'flex';
  body.innerHTML = _usersCache.map(u => `
    <tr>
      <td>${escHtml(u.name)}</td>
      <td class="text-sub">${escHtml(u.email)}</td>
      <td>${u.overdueCount > 0 ? `<span class="chip chip-warn"><span class="chip-dot"></span>${u.overdueCount}回</span>` : '0回'}</td>
      <td>${u.penaltyCount > 0 ? `<span class="chip chip-danger"><span class="chip-dot"></span>${u.penaltyCount}回</span>` : '0回'}</td>
      <td class="text-sub">${u.restrictedUntil ? fmtDate(u.restrictedUntil) : '—'}</td>
      <td style="text-align:right">
        <button class="icon-btn" style="width:28px;height:28px;" onclick="openEditUserById('${u.rowId}')" aria-label="編集"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="icon-btn" style="width:28px;height:28px;color:var(--danger-strong);" onclick="deleteUserRecordById('${u.rowId}', this)" aria-label="削除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </td>
    </tr>`).join('');
}

function openEditUser(u) {
  document.getElementById('eu-rowid').value = u.rowId;
  document.getElementById('eu-name').value = u.name || '';
  document.getElementById('eu-email').value = u.email || '';
  document.getElementById('eu-overdue').value = u.overdueCount || 0;
  document.getElementById('eu-penalty').value = u.penaltyCount || 0;
  document.getElementById('eu-restricted').value = u.restrictedUntil ? u.restrictedUntil.slice(0, 10) : '';
  openDialog('edit-user-overlay');
}

function openEditUserById(rowId) {
  const u = _usersCache.find(x => String(x.rowId) === String(rowId));
  if (u) openEditUser(u);
}

function deleteUserRecordById(rowId, btn) {
  const u = _usersCache.find(x => String(x.rowId) === String(rowId));
  deleteUserRecord(rowId, (u && u.name) || '', btn);
}

async function submitEditUser(btn) {
  const rowId = document.getElementById('eu-rowid').value;
  const name = document.getElementById('eu-name').value;
  const email = document.getElementById('eu-email').value;
  setBtnLoading(btn);
  try {
    await gasAction('updateUser', {
      rowId,
      overdueCount: Number(document.getElementById('eu-overdue').value) || 0,
      penaltyCount: Number(document.getElementById('eu-penalty').value) || 0,
      restrictedUntil: document.getElementById('eu-restricted').value || ''
    });
    await postAudit('延滞情報編集', `${name} (${email})`);
    showToast('更新しました');
    closeDialog('edit-user-overlay');
    await loadUsers();
  } catch (e) {
    showToast('更新に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function deleteUserRecord(rowId, name, btn) {
  const ok = await showConfirm('記録を削除', `${name} の延滞・ペナルティ記録を削除します。`, { okLabel: '削除する' });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await gasAction('deleteUser', { rowId });
    await postAudit('延滞情報削除', name);
    showToast('削除しました');
    await loadUsers();
  } catch (e) {
    showToast('削除に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

/* ============================================================
   録画データ管理
   ============================================================ */
let _recordingsCache = [];

async function loadRecordings() {
  try {
    const [recRes, storageRes] = await Promise.all([
      apiJson('/recordings'),
      apiJson('/recordings/storage-status').catch(() => null)
    ]);
    _recordingsCache = (recRes && recRes.recordings) || [];
    renderRecordings();
    if (storageRes) renderStorageStatus(storageRes);
    startStoragePoll(); // 保存先・移行進捗のライブ表示を開始（タブを離れると停止）
  } catch (e) {
    showToast('録画データの取得に失敗しました: ' + e.message, 'error');
  }
}

// どの管理画面タブにいても保存先の表示（内部/外部ストレージ・移行待ち件数）が
// 常に最新・一致した状態になるよう、storage-status系のAPIを取得したら
// 存在する全ての表示箇所へまとめて反映する。タブごとに個別取得すると
// 「開いた時点のスナップショットのまま古くなる」「タブ間で表示がずれる」
// 問題が起きるため、この関数を唯一の反映ロジックとする。
function applyStorageStatusEverywhere(s) {
  if (!s) return;
  // 録画データタブ
  if (document.getElementById('storage-status-body')) renderStorageStatus(s);
  // バックアップタブ
  const backupLabel = document.getElementById('backup-storage-label');
  if (backupLabel) {
    const loc = s.location || (s.externalStorage ? '外部ストレージ（USB / SD）' : '内部ストレージ');
    backupLabel.textContent = `バックアップの保存先: ${loc}`;
  }
  const backupPending = document.getElementById('backup-storage-pending');
  if (backupPending) backupPending.innerHTML = pendingMigrationHtml(s);
}

function renderStorageStatus(s) {
  const el = document.getElementById('storage-status-body');
  if (!s || typeof s.freeBytes !== 'number') { el.textContent = '保存容量の情報を取得できませんでした'; return; }
  const usedPct = s.totalBytes ? Math.round(((s.totalBytes - s.freeBytes) / s.totalBytes) * 100) : null;
  const chip = s.externalStorage
    ? `<span class="chip" style="background:var(--ok-dim);color:var(--ok-strong);border:1px solid var(--ok-border);">外部USB / SD</span>`
    : `<span class="chip chip-neutral">内部ストレージ</span>`;
  el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${chip}<span>保存先: ${escHtml(s.location || (s.externalStorage ? '外部ストレージ' : '内部ストレージ'))}</span><span class="text-dim">・</span><span>空き容量: ${fmtBytes(s.freeBytes)}${s.totalBytes ? ` / ${fmtBytes(s.totalBytes)}（使用率 ${usedPct}%）` : ''}</span></div>${pendingMigrationHtml(s)}`;
}

// 「内部ストレージに一時保存されたまま、まだ外部USB/SDへ移り切っていない
// データが何件あるか」を見える化する小さな注記。外部ストレージ未使用時や
// 移行待ちが0件のときは何も表示しない(平常時に余計な情報を増やさないため)。
// 通常は30秒以内の監視サイクルで自動的に0件へ戻るため、常時表示され続ける
// 場合はUSBの空き容量・ファイルシステム(FAT32等)を確認するよう案内する。
function pendingMigrationHtml(s) {
  const p = s && s.pendingMigration;
  if (!s.externalStorage || !p || !p.total) return '';
  const parts = [];
  if (p.recordings) parts.push(`録画 ${p.recordings}件`);
  if (p.dbBackups) parts.push(`DBバックアップ ${p.dbBackups}件`);
  if (p.settingsBackups) parts.push(`設定バックアップ ${p.settingsBackups}件`);
  return `<div class="field-hint" style="margin-top:6px;">
    <span class="chip" style="background:var(--warn-dim);color:var(--warn-strong);border:1px solid var(--warn-border);">外部へ移行待ち</span>
    ${escHtml(parts.join('・'))}を内部ストレージから外部USB/SDへ移行中です（30秒ごとに自動で再試行します。長時間残る場合はUSBの空き容量をご確認ください）。
  </div>`;
}

/* ============================================================
   外部USB/SDへの移行進捗のライブ表示
   ------------------------------------------------------------
   サーバー側の移行処理(_migrateInternalToExternal)と保存先の切替を、
   /recordings/migration-status を2秒ごとにポーリングしてリアルタイムに
   反映する。録画データタブを開いている間だけポーリングする(他タブでは
   サーバーに余計な負荷をかけない)。USBの差し込み・取り外しと移行完了は
   グローバルなトーストでも通知する。
   ============================================================ */
let storagePollTimer = null;
let _lastStorageExternal = null;
let _lastMigrateRunning = null;

async function pollStorageStatus() {
  try {
    const s = await apiJson('/recordings/migration-status');
    applyStorageStatusEverywhere(s);
    renderMigrationProgress(s.migration);

    // 保存先が変わったら（どのタブを見ていても）トーストで通知する
    if (s.externalStorage !== _lastStorageExternal) {
      if (_lastStorageExternal !== null) {
        showToast(
          s.externalStorage
            ? '外部USB / SD を検出しました。保存先を外部ストレージに切り替えました'
            : '外部USB / SD が取り外されました。内部ストレージに保存しています',
          s.externalStorage ? 'success' : 'info'
        );
      }
      _lastStorageExternal = s.externalStorage;
    }

    // 移行が完了した瞬間に要約をトーストで通知する
    const m = s.migration;
    if (m && _lastMigrateRunning === true && m.running === false && m.summary) {
      showToast('外部ストレージへの移行が完了しました: ' + m.summary, m.failed ? 'warn' : 'success');
    }
    _lastMigrateRunning = m ? m.running : null;
  } catch (e) {
    // 一時的な取得失敗は無視（次回のポーリングで自然に回復する）
  }
}

function startStoragePoll() {
  if (storagePollTimer) { pollStorageStatus(); return; } // ポーリング中は継続（状態リセットしない）
  _lastStorageExternal = null;
  _lastMigrateRunning = null;
  pollStorageStatus();
  storagePollTimer = setInterval(pollStorageStatus, 2000);
}

function stopStoragePoll() {
  if (storagePollTimer) { clearInterval(storagePollTimer); storagePollTimer = null; }
}

// 移行中の進捗バーを描画する。完了後はしばらく要約を表示してから自動で隠す。
function renderMigrationProgress(m) {
  const card = document.getElementById('storage-progress-card');
  if (!card) return;
  const fresh = m && (m.running || (m.finishedAt && Date.now() - m.finishedAt < 60 * 1000));
  if (!fresh) { card.style.display = 'none'; return; }
  card.style.display = '';

  const title = document.getElementById('storage-progress-title');
  const detail = document.getElementById('storage-progress-detail');
  const current = document.getElementById('storage-progress-current');
  const meta = document.getElementById('storage-progress-meta');
  const done = document.getElementById('storage-progress-done');
  const bar = document.getElementById('storage-progress-bar');

  if (m.running) {
    title.textContent = '外部ストレージへ移行中';
    detail.textContent = m.phaseLabel || '';
    current.textContent = m.current
      ? (m.currentKind === 'recording' ? `処理中: 録画 ${m.current}` : `処理中: バックアップ ${m.current}`)
      : '';
    current.style.color = '';
    const pct = m.total > 0 ? Math.min(100, Math.round((m.done / m.total) * 100)) : 0;
    bar.style.width = pct + '%';
    meta.textContent = `${m.done} / ${m.total} 件を処理済み`;
    done.textContent = `スキップ ${m.skipped}件${m.failed ? ` ・ 失敗 ${m.failed}件` : ''}`;
  } else {
    title.textContent = m.failed ? '移行は一部失敗しました' : '移行が完了しました';
    detail.textContent = '';
    current.textContent = '';
    bar.style.width = '100%';
    meta.textContent = m.summary || '';
    done.textContent = '';
  }
}

/* ------------------------------------------------------------
   全タブ共通の浮遊プログレス（#migrate-float）
   録画データタブを開いていないときに移行が走った場合でも、
   画面下部に「移行中・何をしているか・進捗」を常に表示する。
   録画タブの2秒ポーリングと同じトースト条件を共有しており、
   移行完成や保存先切替の通知が二重にならない。
   ------------------------------------------------------------ */
let migrateFloatTimer = null;

function startMigrateFloatMonitor() {
  if (migrateFloatTimer) return;
  pollMigrateFloat();
  migrateFloatTimer = setInterval(pollMigrateFloat, 3000);
}

async function pollMigrateFloat() {
  const floatEl = document.getElementById('migrate-float');
  if (!floatEl) return;
  try {
    const s = await apiJson('/recordings/migration-status');
    const m = s.migration || {};
    applyStorageStatusEverywhere(s);

    // 進行中、または完了してから4秒以内は浮遊プログレスを表示する
    const justFinished = !m.running && m.finishedAt && Date.now() - m.finishedAt < 4000;
    if (m.running || justFinished) {
      floatEl.style.display = '';
      document.getElementById('migrate-float-detail').textContent =
        m.running ? (m.phaseLabel || '') : (m.failed ? '移行は一部失敗しました' : '移行が完了しました');
      document.getElementById('migrate-float-current').textContent = m.running && m.current
        ? `処理中: ${m.currentKind === 'recording' ? '録画 ' : 'バックアップ '}${m.current}`
        : (m.running ? '' : (m.summary || ''));
      const pct = m.running && m.total > 0 ? Math.min(100, Math.round((m.done / m.total) * 100)) : 0;
      document.getElementById('migrate-float-bar').style.width = m.running ? pct + '%' : '100%';
      document.getElementById('migrate-float-meta').textContent =
        m.running ? `${m.done} / ${m.total} 件を処理済み` : '';
    } else {
      floatEl.style.display = 'none';
    }

    // 保存先の切替と移行完了のトースト（tabポーリングと状態を共有して二重通知を防ぐ）
    if (s.externalStorage !== _lastStorageExternal) {
      if (_lastStorageExternal !== null) {
        showToast(
          s.externalStorage
            ? '外部USB / SD を検出しました。保存先を外部ストレージに切り替えました'
            : '外部USB / SD が取り外されました。内部ストレージに保存しています',
          s.externalStorage ? 'success' : 'info'
        );
      }
      _lastStorageExternal = s.externalStorage;
    }
    if (m && _lastMigrateRunning === true && m.running === false && m.summary) {
      showToast('外部ストレージへの移行が完了しました: ' + m.summary, m.failed ? 'warn' : 'success');
    }
    _lastMigrateRunning = m ? m.running : null;
  } catch (e) {
    // 一時的な取得失敗は無視（次回のポーリングで自然に回復する）
  }
}

function renderRecordings() {
  const body = document.getElementById('rec-table-body');
  document.getElementById('rec-empty').style.display = _recordingsCache.length ? 'none' : 'flex';
  body.innerHTML = _recordingsCache.map(r => {
    const meta = r.meta || {};
    return `<tr>
      <td>${escHtml(meta.name || '—')}<div class="text-dim" style="font-size:10.5px;">${escHtml(r.sessionId || '')}</div></td>
      <td class="text-sub">${escHtml(meta.action === 'return' ? '返却' : '貸出')}</td>
      <td class="mono">${escHtml(meta.deviceId || '—')}</td>
      <td class="text-sub">${fmtDateTime(meta.timestamp || r.createdAt)}</td>
      <td style="text-align:right">
        <button class="btn btn-ghost btn-sm" onclick="playRecording('${escHtml(r.sessionId)}')">再生</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRecording('${escHtml(r.sessionId)}', this)">削除</button>
      </td>
    </tr>`;
  }).join('');
}

function playRecording(sessionId) {
  // 動画は <video src> で読み込むため、ブラウザの仕様上トークンを
  // Authorizationヘッダーではなくクエリパラメータで渡さざるを得ない。
  // 別タブを開かず、ダッシュボード内のダイアログで再生することで
  // リンクが他所にコピーされるリスクを下げる。
  const url = `${ARDUINO_SERVER}/recording/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(sessionToken || '')}`;
  const video = document.getElementById('video-player-el');
  const status = document.getElementById('video-player-status');

  status.style.display = 'none';
  status.classList.remove('is-error');
  video.style.display = '';
  video.pause();
  video.removeAttribute('src');
  video.load();

  const onError = () => {
    video.style.display = 'none';
    status.textContent = '録画データを再生できませんでした。データが破損しているか、期限切れの可能性があります。';
    status.classList.add('is-error');
    status.style.display = '';
  };
  video.onerror = onError;

  video.src = url;
  openDialog('video-player-overlay');
  video.play().catch(() => { /* 自動再生に失敗しても再生ボタンから再生可能なため無視 */ });
}

function closeVideoPlayer() {
  const video = document.getElementById('video-player-el');
  video.pause();
  video.removeAttribute('src');
  video.onerror = null;
  video.load();
  closeDialog('video-player-overlay');
}

async function deleteRecording(sessionId, btn) {
  const ok = await showConfirm('録画データを削除', 'この録画データを完全に削除します。この操作は取り消せません。', { okLabel: '削除する' });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await apiJson('/recording', {
      method: 'DELETE',
      body: JSON.stringify({ sessionId, reason: 'admin' })
    });
    showToast('削除しました');
    await loadRecordings();
  } catch (e) {
    showToast('削除に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

function showMaintenanceDialog() {
  openDialog('maintenance-overlay');
}

async function submitMaintenance(btn) {
  const days = Number(document.getElementById('maint-days').value) || 30;
  setBtnLoading(btn);
  try {
    const res = await apiJson(`/recordings/old?days=${days}`, { method: 'DELETE' });
    showToast(`${(res && res.deletedCount) || 0} 件の録画データを削除しました`);
    closeDialog('maintenance-overlay');
    await loadRecordings();
  } catch (e) {
    showToast('削除に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

/* ============================================================
   扉・鍵の状態（Arduino）
   改善: 旧実装には手動解錠の導線が一切なく、扉が開かない
   緊急時に管理者がその場で対処する手段がなかった。
   サーバー側の /arduino/open は管理者セッションがあれば
   任意のdeviceIdを解錠できる実装だったため、UIを追加する。
   ============================================================ */
async function loadArduinoView() {
  await fetchAllDoorStatus();
  // 実運用では扉の開閉状態を即時に把握したいため、既定で1秒ごとの
  // 自動更新を有効にする（ボタンでいつでも手動更新に戻せる）。
  // 他のタブへ移動すると showView() 側で自動停止する。
  if (!doorPollEnabled) toggleDoorPoll(true);
}

async function fetchAllDoorStatus() {
  const grid = document.getElementById('admin-door-grid');
  try {
    const res = await apiJson('/arduino/status/all');
    const doors = res.doors || {};
    document.getElementById('door-connection-sub').textContent = res.connected ? 'Arduinoに接続されています' : 'Arduino未接続（状態は取得できません）';
    document.getElementById('door-last-update').textContent = fmtDateTime(new Date().toISOString());

    const entries = Object.entries(doors);
    if (!entries.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><span class="empty-state-text">端末情報がありません</span></div>`;
      return;
    }
    grid.innerHTML = entries.map(([id, state]) => {
      // state: サーバーからは Arduino の生の文字列 'open' / 'closed' がそのまま
      // 届く（null=未取得/不明）。以前は真偽値(true/false)と比較していたため、
      // 実際には一致せず常に「状態不明」と表示されてしまっていた。
      let cls = 'door-tile--unknown', label = '状態不明';
      if (state === 'open') { cls = 'door-tile--open'; label = '開いています'; }
      else if (state === 'closed') { cls = 'door-tile--closed'; label = '閉じています'; }
      const disabled = !res.connected;
      return `<div class="door-tile ${cls}">
        <div class="door-tile-id">${escHtml(id)}</div>
        <div class="door-tile-state">${label}</div>
        <button class="door-tile-unlock-btn" ${disabled ? 'disabled' : ''} onclick="manualUnlockDoor('${escHtml(id)}', this)">手動解錠</button>
      </div>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><span class="empty-state-text">状態を取得できませんでした</span></div>`;
    document.getElementById('door-connection-sub').textContent = '取得エラー';
  }
}

async function manualUnlockDoor(deviceId, btn) {
  const ok = await showConfirm('手動で解錠', `${deviceId} を今すぐ解錠します。生徒の操作を経ないため、貸出・返却の記録は変わりません。実際に何が起きているか確認したうえで実行してください。`, { okLabel: '解錠する' });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await apiJson('/arduino/open', { method: 'POST', body: JSON.stringify({ deviceId }) });
    await postAudit('手動解錠', `${deviceId} を管理画面から手動解錠`);
    showToast(`${deviceId} を解錠しました`);
    setTimeout(fetchAllDoorStatus, 800);
  } catch (e) {
    showToast('解錠に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function openAllDoors(btn) {
  if (!Array.isArray(ALL_DEVICES) || !ALL_DEVICES.length) {
    showToast('端末情報が読み込まれていません', 'error');
    return;
  }

  const ok = await showConfirm(
    'すべての扉を開く',
    `全${ALL_DEVICES.length}台の扉を1つずつ順番に解錠します。電力の関係で一括解錠はできません。処理中は操作をしないでください。`,
    { okLabel: '解錠開始' }
  );
  if (!ok) return;

  const badge = document.getElementById('door-poll-badge');
  const prevBadgeText = badge.textContent;
  const prevBtnHtml = btn.innerHTML;
  btn.disabled = true;
  badge.textContent = '解錠処理中...';

  let successCount = 0;
  let failCount = 0;

  try {
    for (let i = 0; i < ALL_DEVICES.length; i++) {
      const deviceId = ALL_DEVICES[i];
      badge.textContent = `解錠中... ${i + 1}/${ALL_DEVICES.length}`;
      btn.innerHTML = `解錠中... ${i + 1}/${ALL_DEVICES.length}`;

      try {
        await apiJson('/arduino/open', { method: 'POST', body: JSON.stringify({ deviceId }) });
        successCount++;
      } catch (e) {
        failCount++;
      }

      if (i < ALL_DEVICES.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    showToast(`すべての扉の解錠が完了しました（成功: ${successCount}台、失敗: ${failCount}台）`);
    setTimeout(fetchAllDoorStatus, 800);
  } catch (e) {
    showToast('解錠処理中にエラーが発生しました: ' + e.message, 'error');
  } finally {
    postAudit('全扉一括解錠', `すべての扉を解錠しました（成功: ${successCount}台、失敗: ${failCount}台）`).catch(() => { });
    btn.innerHTML = prevBtnHtml;
    btn.disabled = false;
    badge.textContent = prevBadgeText;
  }
}

function toggleDoorPoll(forceState) {
  doorPollEnabled = typeof forceState === 'boolean' ? forceState : !doorPollEnabled;
  const btn = document.getElementById('btn-door-poll');
  const badge = document.getElementById('door-poll-badge');
  if (doorPollTimer) { clearInterval(doorPollTimer); doorPollTimer = null; }
  if (doorPollEnabled) {
    btn.textContent = '自動更新を停止';
    badge.textContent = '1秒ごとに自動更新中';
    doorPollTimer = setInterval(fetchAllDoorStatus, 1000);
  } else {
    btn.textContent = '自動更新を開始';
    badge.textContent = '手動更新';
  }
}

/* ============================================================
   運用設定
   ============================================================ */
let _emailPatterns = [];
let _teacherReportTimes = [];

function updateSettingsUI() {
  const checkedRadio = document.querySelector('input[name="set-checkout-fields"]:checked');
  const checkoutFields = checkedRadio ? checkedRadio.value : 'all';
  const verifyCheck = document.getElementById('set-return-verify');
  const verifyText = document.getElementById('text-return-verify');
  const verifyHint = document.getElementById('hint-return-verify');

  if (checkoutFields === 'name') {
    verifyCheck.checked = false;
    verifyCheck.disabled = true;
    verifyText.style.opacity = '0.5';
    verifyHint.style.display = 'block';
  } else {
    verifyCheck.disabled = false;
    verifyText.style.opacity = '1';
    verifyHint.style.display = 'none';
  }

  document.getElementById('email-dob-instruction').style.display = (checkoutFields === 'email_dob') ? 'flex' : 'none';

  const notifyOn = document.getElementById('set-notify-email-enabled').checked;
  document.getElementById('set-notify-email-address').disabled = !notifyOn;
  ['set-notify-on-failure', 'set-notify-on-blacklist', 'set-notify-on-overdue'].forEach(id => {
    document.getElementById(id).disabled = !notifyOn;
  });
  document.getElementById('notify-email-trigger-hint').textContent = notifyOn
    ? '保存すると、延滞チェック用の15分ごとのトリガーが自動的に設定されます。'
    : '';

  const teacherOn = document.getElementById('set-teacher-report-enabled').checked;
  document.getElementById('set-teacher-report-address').disabled = !teacherOn;
  document.querySelectorAll('#teacher-report-times-list input, #teacher-report-times-list button')
    .forEach(el => { el.disabled = !teacherOn; });

  markSettingsDirty();
}

function markSettingsDirty() {
  settingsDirty = true;
  refreshUnsavedUI();
}

/* ============================================================
   運用設定: 未保存表示・検索・読込中・バリデーション
   ============================================================ */
function refreshUnsavedUI() {
  const dirty = !!settingsDirty;
  const badge = document.getElementById('badge-settings-unsaved');
  const saveBtn = document.getElementById('save-settings-btn');
  const sticky = document.getElementById('save-sticky');
  if (badge) badge.hidden = !dirty;
  if (saveBtn) saveBtn.classList.toggle('is-dirty', dirty);
  if (sticky) sticky.classList.toggle('is-visible', dirty);
}

function setSettingsLoading(on) {
  const view = document.getElementById('view-settings');
  if (!view) return;
  view.classList.toggle('is-loading', !!on);
}

function filterSettings(query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  const view = document.getElementById('view-settings');
  const searchWrap = document.querySelector('.settings-search');
  if (searchWrap) searchWrap.classList.toggle('has-query', q.length > 0);
  let anyMatch = !q;
  document.querySelectorAll('#view-settings .settings-group').forEach(g => {
    let groupHas = false;
    g.querySelectorAll('.settings-group-body-inner > .card').forEach(card => {
      const match = !q || (card.textContent || '').toLowerCase().includes(q);
      card.classList.toggle('is-filtered-out', !match);
      if (match) groupHas = true;
    });
    g.classList.toggle('has-match', groupHas);
    if (q && groupHas) {
      g.classList.add('is-open');
      const head = g.querySelector('.settings-group-head');
      if (head) head.setAttribute('aria-expanded', 'true');
    }
    if (groupHas) anyMatch = true;
  });
  view.classList.toggle('is-filtering', !!q);
  if (!q) initSettingsGroups();
  const empty = document.getElementById('settings-no-results');
  if (empty) {
    empty.style.display = (q && !anyMatch) ? '' : 'none';
    if (q && !anyMatch) {
      const qEl = document.getElementById('settings-no-results-query');
      if (qEl) qEl.textContent = q;
    }
  }
}

function clearSettingsSearch() {
  const input = document.getElementById('settings-search');
  if (input) { input.value = ''; filterSettings(''); input.focus(); }
}

function validateSettingsPayload(payload) {
  clearSettingsInvalid();
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const okEmailList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean).every(e => emailRe.test(e));
  const invalids = [];
  if (payload.notifyEmailEnabled && !okEmailList(payload.notifyEmailAddress)) {
    invalids.push(['set-notify-email-address', '即時アラートの通知先メールアドレスを入力してください（例: teacher@g.miyazaki-c.ed.jp）']);
  }
  if (payload.teacherReportEnabled && !okEmailList(payload.teacherReportAddress)) {
    invalids.push(['set-teacher-report-address', '定期レポートの送信先メールアドレスを入力してください（例: teachers@g.miyazaki-c.ed.jp）']);
  }
  invalids.forEach(([id, msg]) => {
    const el = document.getElementById(id);
    if (el) { el.classList.add('is-invalid'); el.title = msg; }
  });
  return invalids;
}

function clearSettingsInvalid() {
  document.querySelectorAll('#view-settings .input.is-invalid').forEach(el => {
    el.classList.remove('is-invalid');
    el.title = '';
  });
}

/* ============================================================
   運用設定: カテゴリ折りたたみグループ
   ------------------------------------------------------------
   view-settings 内の設定カードをカテゴリごとに折りたたみ可能にします。
   開閉状態は localStorage に保存します（初回は「ルール」のみ開く）。
   ============================================================ */
const SETTINGS_GROUPS_DEFAULT_OPEN = new Set(['rules']);

function initSettingsGroups() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('settings_groups_collapsed') || '{}') || {}; } catch (e) { }
  document.querySelectorAll('.settings-group').forEach(g => {
    const id = g.dataset.settingsGroup;
    const open = saved[id] !== undefined ? !saved[id] : SETTINGS_GROUPS_DEFAULT_OPEN.has(id);
    g.classList.toggle('is-open', open);
    const head = g.querySelector('.settings-group-head');
    if (head) head.setAttribute('aria-expanded', String(open));
  });
}

function toggleSettingsGroup(id) {
  const g = document.querySelector(`.settings-group[data-settings-group="${id}"]`);
  if (!g) return;
  const open = g.classList.toggle('is-open');
  const head = g.querySelector('.settings-group-head');
  if (head) head.setAttribute('aria-expanded', String(open));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('settings_groups_collapsed') || '{}') || {}; } catch (e) { }
  saved[id] = !open;
  try { localStorage.setItem('settings_groups_collapsed', JSON.stringify(saved)); } catch (e) { }
}

function setAllSettingsGroups(open) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('settings_groups_collapsed') || '{}') || {}; } catch (e) { }
  document.querySelectorAll('.settings-group').forEach(g => {
    g.classList.toggle('is-open', open);
    const head = g.querySelector('.settings-group-head');
    if (head) head.setAttribute('aria-expanded', String(open));
    if (g.dataset.settingsGroup) saved[g.dataset.settingsGroup] = !open;
  });
  try { localStorage.setItem('settings_groups_collapsed', JSON.stringify(saved)); } catch (e) { }
}

function openAllSettingsGroups() { setAllSettingsGroups(true); }
function closeAllSettingsGroups() { setAllSettingsGroups(false); }

function renderEmailPatterns() {
  const wrap = document.getElementById('email-patterns-list');
  wrap.innerHTML = _emailPatterns.map((p, i) => `
    <div class="row" style="background:var(--surface-sunken);padding:12px;border-radius:var(--r-md);align-items:flex-end;" data-idx="${i}">
      <div class="field" style="max-width:110px;"><span class="field-label">表示名</span><input type="text" class="input ep-label" value="${escHtml(p.label)}" oninput="collectEmailPatterns();markSettingsDirty()"></div>
      <div class="field" style="flex:2;"><span class="field-label">テンプレート（{{input}}が入力箇所）</span><input type="text" class="input ep-template" value="${escHtml(p.template)}" oninput="collectEmailPatterns();markSettingsDirty()"></div>
      <div class="field" style="max-width:75px;"><span class="field-label">桁数</span><input type="number" class="input ep-length" min="1" max="10" value="${p.length}" oninput="collectEmailPatterns();markSettingsDirty()"></div>
      <button class="icon-btn" style="color:var(--danger-strong);" onclick="removeEmailPattern(${i})" aria-label="削除"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
    </div>`).join('');
}
function collectEmailPatterns() {
  document.querySelectorAll('#email-patterns-list > div').forEach((row, i) => {
    _emailPatterns[i] = {
      label: row.querySelector('.ep-label').value,
      template: row.querySelector('.ep-template').value,
      length: Number(row.querySelector('.ep-length').value) || 4,
      inputType: 'digits'
    };
  });
}
function addEmailPatternUI() {
  _emailPatterns.push({ label: '新しいパターン', template: '{{input}}@example.com', length: 4, inputType: 'digits' });
  renderEmailPatterns();
  markSettingsDirty();
}
function removeEmailPattern(i) {
  _emailPatterns.splice(i, 1);
  renderEmailPatterns();
  markSettingsDirty();
}

// 生徒本人宛メール(貸出確認・返却確認)の送信状況を、運用設定タブに表示する。
// このメールはスプレッドシート同期と共通のGAS連携(GAS_URL/SYNC_TOKEN)を使って
// GoogleアカウントのMailApp経由で送信されるため、SMTPの個別設定は不要。
// 「通知トグルはONなのにメールが届かない」の主因になりがちな、GAS連携未設定/
// 送信エラー等に管理者が気づけるようにするため。
function renderEmailStatusBox(status) {
  const box = document.getElementById('email-status-box');
  if (!box) return;
  if (!status) { box.innerHTML = ''; return; }

  if (!status.gasConfigured) {
    box.innerHTML = `
      <div style="color:var(--text-sub,#64748b);font-weight:700;">スプレッドシート連携が未設定です</div>
      <div style="margin-top:4px;">生徒本人宛メールは、スプレッドシート同期と共通のGoogle Apps Script連携を使って送信されます。
      「同期」タブでスプレッドシート連携が有効になっているかご確認ください。
      上記のON/OFF設定は保存されますが、連携が有効になるまでメールは送信されません。</div>`;
    return;
  }

  const parts = [`送信済み ${status.sent ?? 0} 件`, `送信待ち ${status.pending ?? 0} 件`];
  if (status.failing) parts.push(`うち失敗中 ${status.failing} 件`);
  let html = `<div style="color:var(--text-sub,#64748b);">送信方式: Google Apps Script経由（スプレッドシート同期と共通）／ ${parts.join(' ・ ')}</div>`;

  if (status.lastError) {
    html += `
      <div style="margin-top:6px;color:var(--danger-strong,#b91c1c);font-weight:700;">⚠ 直近の送信エラー（${status.lastError.attempts}回失敗・${escHtml(status.lastError.kind === 'checkout' ? '貸出確認' : '返却確認')}）</div>
      <div style="margin-top:2px;font-family:monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;">${escHtml(status.lastError.message)}</div>
      <div style="margin-top:4px;">「同期」タブでスプレッドシート同期自体が成功しているかご確認ください。同期が失敗している場合、原因は多くの場合こちらと共通です。</div>`;
  }
  box.innerHTML = html;
}

function renderTeacherReportTimes() {
  const wrap = document.getElementById('teacher-report-times-list');
  const disabled = !document.getElementById('set-teacher-report-enabled').checked;
  wrap.innerHTML = _teacherReportTimes.map((t, i) => `
    <div class="flex-row">
      <input type="time" class="input" style="width:140px;" value="${escHtml(t)}" ${disabled ? 'disabled' : ''} onchange="_teacherReportTimes[${i}]=this.value;markSettingsDirty()">
      <button class="icon-btn" style="color:var(--danger-strong);" ${disabled ? 'disabled' : ''} onclick="removeTeacherReportTime(${i})" aria-label="削除">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
}
function addTeacherReportTimeUI() {
  if (_teacherReportTimes.length >= 6) { showToast('送信時刻は最大6件までです', 'error'); return; }
  _teacherReportTimes.push('08:30');
  renderTeacherReportTimes();
  markSettingsDirty();
}
function removeTeacherReportTime(i) {
  _teacherReportTimes.splice(i, 1);
  renderTeacherReportTimes();
  markSettingsDirty();
}

function populateSettingsForm(s) {
  _emailPatterns = (s.emailPatterns || []).map(p => Object.assign({}, p));
  renderEmailPatterns();
  const radio = document.querySelector(`input[name="set-checkout-fields"][value="${s.checkoutFields || 'all'}"]`);
  if (radio) radio.checked = true;
  document.getElementById('set-return-verify').checked = !!s.returnVerify;
  document.getElementById('set-logout-camera-check').checked = s.logoutCameraCheckEnabled !== false;
  document.getElementById('set-idle-timeout').checked = !!s.idleTimeoutEnabled;
  document.getElementById('set-bl-threshold').value = s.blThreshold ?? 3;
  document.getElementById('set-bl-duration').value = s.blDuration ?? 1;
  const reoffRadio = document.querySelector(`input[name="set-bl-reoffense"][value="${s.blReoffense || 'double'}"]`);
  if (reoffRadio) reoffRadio.checked = true;
  document.getElementById('set-debug-logs').checked = !!s.enableDebugLogs;
  document.getElementById('set-deadline-hour').value = s.returnDeadlineHour ?? 16;
  document.getElementById('set-deadline-minute').value = s.returnDeadlineMinute ?? 0;
  document.getElementById('set-grace-period').value = s.gracePeriodMinutes ?? 0;
  document.getElementById('set-device-rest-minutes').value = s.deviceRestMinutes ?? 30;
  document.getElementById('set-notify-email-enabled').checked = !!s.notifyEmailEnabled;
  document.getElementById('set-notify-email-address').value = s.notifyEmailAddress || '';
  document.getElementById('set-notify-on-failure').checked = !!s.notifyOnFailure;
  document.getElementById('set-notify-on-blacklist').checked = !!s.notifyOnBlacklist;
  document.getElementById('set-notify-on-overdue').checked = !!s.notifyOnOverdue;
  document.getElementById('set-teacher-report-enabled').checked = !!s.teacherReportEnabled;
  document.getElementById('set-teacher-report-address').value = s.teacherReportAddress || '';
  _teacherReportTimes = (s.teacherReportTimes || []).slice();
  renderTeacherReportTimes();
  document.getElementById('set-notify-user-on-checkout').checked = s.notifyUserOnCheckout !== false;
  document.getElementById('set-notify-user-on-return').checked = s.notifyUserOnReturn !== false;
  renderEmailStatusBox(s.emailStatus);
  document.getElementById('set-board-enabled').checked = s.boardEnabled !== false;
  document.getElementById('set-board-slide-interval').value = s.boardSlideIntervalSec ?? 8;
  document.getElementById('set-board-show-blacklist').checked = !!s.boardShowBlacklist;
  document.getElementById('set-recording-retention-enabled').checked = !!s.recordingRetentionEnabled;
  document.getElementById('set-recording-retention-days').value = s.recordingRetentionDays ?? 30;
  const DEFAULT_DOOR_UNLOCK_DURATIONS = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
  const durations = (s.doorUnlockDurations && s.doorUnlockDurations.length === 12)
    ? s.doorUnlockDurations
    : DEFAULT_DOOR_UNLOCK_DURATIONS;
  const grid = document.getElementById('door-unlock-durations-grid');
  if (grid) {
    grid.innerHTML = durations.map((ms, i) => `
      <div class="field" style="width:110px;">
        <span class="field-label">CB-${String(i + 1).padStart(2, '0')}</span>
        <input type="number" class="input" style="width:100%;" min="100" max="15000" step="50"
               value="${Number(ms) || DEFAULT_DOOR_UNLOCK_DURATIONS[i]}" id="set-door-unlock-${i + 1}" oninput="markSettingsDirty()">
      </div>`).join('');
  }
  updateSettingsUI();
}

function collectSettingsPayload() {
  collectEmailPatterns();
  const checkedRadio = document.querySelector('input[name="set-checkout-fields"]:checked');
  const reoffRadio = document.querySelector('input[name="set-bl-reoffense"]:checked');
  const clampInt = (value, min, max, fallback) => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    emailPatterns: _emailPatterns,
    checkoutFields: checkedRadio ? checkedRadio.value : 'all',
    returnVerify: document.getElementById('set-return-verify').checked,
    logoutCameraCheckEnabled: document.getElementById('set-logout-camera-check').checked,
    idleTimeoutEnabled: document.getElementById('set-idle-timeout').checked,
    blThreshold: clampInt(document.getElementById('set-bl-threshold').value, 1, 10, 3),
    blDuration: clampInt(document.getElementById('set-bl-duration').value, 1, 12, 1),
    blReoffense: reoffRadio ? reoffRadio.value : 'double',
    enableDebugLogs: document.getElementById('set-debug-logs').checked,
    returnDeadlineHour: clampInt(document.getElementById('set-deadline-hour').value, 0, 23, 16),
    returnDeadlineMinute: clampInt(document.getElementById('set-deadline-minute').value, 0, 59, 0),
    gracePeriodMinutes: clampInt(document.getElementById('set-grace-period').value, 0, 60, 0),
    deviceRestMinutes: clampInt(document.getElementById('set-device-rest-minutes').value, 0, 240, 30),
    notifyEmailEnabled: document.getElementById('set-notify-email-enabled').checked,
    notifyEmailAddress: document.getElementById('set-notify-email-address').value.trim(),
    notifyOnFailure: document.getElementById('set-notify-on-failure').checked,
    notifyOnBlacklist: document.getElementById('set-notify-on-blacklist').checked,
    notifyOnOverdue: document.getElementById('set-notify-on-overdue').checked,
    teacherReportEnabled: document.getElementById('set-teacher-report-enabled').checked,
    teacherReportAddress: document.getElementById('set-teacher-report-address').value.trim(),
    teacherReportTimes: _teacherReportTimes,
    notifyUserOnCheckout: document.getElementById('set-notify-user-on-checkout').checked,
    notifyUserOnReturn: document.getElementById('set-notify-user-on-return').checked,
    boardEnabled: document.getElementById('set-board-enabled').checked,
    boardSlideIntervalSec: clampInt(document.getElementById('set-board-slide-interval').value, 3, 60, 8),
    boardShowBlacklist: document.getElementById('set-board-show-blacklist').checked,
    recordingRetentionEnabled: document.getElementById('set-recording-retention-enabled').checked,
    recordingRetentionDays: Number(document.getElementById('set-recording-retention-days').value) || 30,
    doorUnlockDurations: Array.from({ length: 12 }, (_, i) =>
      clampInt(document.getElementById('set-door-unlock-' + (i + 1)).value, 100, 15000, 1000))
  };
}

// 「全扉に一括適用」ボタン: 個別入力欄すべてに同じ値を反映する
function applyDoorUnlockAll() {
  const raw = document.getElementById('set-door-unlock-all').value;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) { showToast('100〜15000 の数値を入力してください', 'error'); return; }
  const clamped = Math.min(15000, Math.max(100, n));
  for (let i = 1; i <= 12; i++) {
    document.getElementById('set-door-unlock-' + i).value = clamped;
  }
  markSettingsDirty();
  showToast(`全扉の解錠時間を ${clamped}ms に設定しました`);
}

async function loadSettingsView() {
  setSettingsLoading(true);
  try {
    const res = await gasAction('getSettings');
    populateSettingsForm(res.settings || {});
    settingsSnapshot = JSON.stringify(collectSettingsPayload());
    settingsDirty = false;
    refreshUnsavedUI();
  } catch (e) {
    showToast('設定の取得に失敗しました: ' + e.message, 'error');
  } finally {
    setSettingsLoading(false);
  }
  loadCloudSyncStatus();
}

async function loadCloudSyncStatus() {
  const dot = document.getElementById('cloud-sync-dot');
  const text = document.getElementById('cloud-sync-text');
  text.textContent = '設定の保存状況を確認中...';
  dot.style.background = 'var(--text-dim)';
  try {
    const res = await apiJson('/settings/meta');
    if (res.offline) {
      dot.style.background = 'var(--warn-strong)';
      text.textContent = '設定を読み込めなかったため、直前に取得できた設定で動作しています';
    } else if (!res.updatedAt) {
      dot.style.background = 'var(--text-dim)';
      text.textContent = 'まだ誰も設定を保存していません（既定値で動作中）';
    } else {
      dot.style.background = 'var(--ok-strong)';
      text.textContent = `この端末に設定が保存されています（最終更新: ${fmtDateTime(res.updatedAt)} ／更新者: ${res.updatedBy || '不明'}）`;
    }
  } catch (e) {
    dot.style.background = 'var(--danger-strong)';
    text.textContent = '通信エラーが発生しました';
  }
}

async function saveSettings(btn) {
  const view = document.getElementById('view-settings');
  if (view && view.classList.contains('is-loading')) return;
  const payload = collectSettingsPayload();
  const invalids = validateSettingsPayload(payload);
  if (invalids.length) {
    const first = document.getElementById(invalids[0][0]);
    if (first) {
      first.focus({ preventScroll: true });
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    showToast('保存内容にエラーがあります（赤字の項目を確認してください）', 'error');
    return;
  }
  setBtnLoading(btn);
  try {
    await apiJson('/settings', { method: 'POST', body: JSON.stringify(payload) });
    await postAudit('設定変更', 'システム設定を更新しました');
    settingsDirty = false;
    settingsSnapshot = JSON.stringify(payload);
    refreshUnsavedUI();
    showToast('設定を保存しました');
    loadCloudSyncStatus();
  } catch (e) {
    showToast('保存に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function discardSettingsChanges() {
  const ok = await showConfirm('変更を破棄', 'この画面で行った未保存の変更を破棄し、保存されている設定を再読み込みします。よろしいですか？', { okLabel: '破棄する', danger: false });
  if (!ok) return;
  await loadSettingsView();
  showToast('保存されている設定を再読み込みしました');
}

async function exportSettings(btn) {
  // バグ修正: 旧実装は window.open で開いており、Authorizationヘッダーを
  // 付けられないため常に403になっていた。DBバックアップのダウンロード
  // (downloadBackup)と同じ、fetch + Blob によるトークン付きダウンロードに修正。
  setBtnLoading(btn);
  try {
    const res = await apiFetch('/api/settings/export');
    if (!res.ok) throw new Error('ダウンロードに失敗しました');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'settings-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast('ダウンロードに失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function importSettings(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  // バグ修正: 旧実装は確認ダイアログなしで即座に全設定を上書きしていた。
  // 他の破壊的操作（データ削除等）と同様に確認を挟む。
  const ok = await showConfirm('設定を復元', `「${file.name}」の内容で現在の設定をすべて上書きします。この操作は取り消せません。`, { okLabel: '復元する' });
  if (!ok) { evt.target.value = ''; return; }
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    await apiJson('/api/settings/import', { method: 'POST', body: JSON.stringify(json) });
    await postAudit('設定復元', `${file.name} から設定を復元しました`);
    showToast('設定を復元しました');
    await loadSettingsView();
  } catch (e) {
    showToast('復元に失敗しました: ' + e.message, 'error');
  } finally {
    evt.target.value = '';
  }
}

/* ============================================================
   設定(JSON)バックアップの一覧選択による復元
   バグ修正: 旧実装はファイル選択(input[type=file])しかなく、
   「いつの・どんな内容のバックアップか」が選ぶ前に分からなかった。
   サーバー側に保存されている設定バックアップを一覧表示し、
   中身を確認してから選べるダイアログに変更する。
   ============================================================ */
let _settingsBackupsCache = [];

function summarizeSettingsBackupContent(c) {
  if (!c || typeof c !== 'object') return ['内容を読み取れませんでした'];
  const yn = (v) => (v ? '有効' : '無効');
  const items = [];
  items.push(`貸出時の入力項目: ${c.checkoutFields === 'all' ? '氏名・端末番号など全項目' : (c.checkoutFields || '—')}`);
  items.push(`返却時の本人確認: ${yn(c.returnVerify)}`);
  if (c.logoutCameraCheckEnabled !== undefined) {
    items.push(`返却時のログアウト確認（カメラ自動）: ${yn(c.logoutCameraCheckEnabled)}`);
  }
  if (c.blThreshold !== undefined || c.blDuration !== undefined) {
    items.push(`ブラックリスト基準: ${c.blThreshold ?? '—'}回で${c.blDuration ?? '—'}か月停止`);
  }
  items.push(`故障・延滞などの通知メール: ${yn(c.notifyEmailEnabled)}${c.notifyEmailEnabled && c.notifyEmailAddress ? `（${c.notifyEmailAddress}）` : ''}`);
  items.push(`先生向け定期レポート: ${yn(c.teacherReportEnabled)}`);
  items.push(`録画の自動削除: ${c.recordingRetentionEnabled ? `${c.recordingRetentionDays ?? '—'}日で削除` : '無効'}`);
  return items;
}

async function openSettingsRestoreDialog() {
  openDialog('settings-restore-overlay');
  const listEl = document.getElementById('settings-restore-list');
  const confirmBtn = document.getElementById('settings-restore-confirm-btn');
  confirmBtn.disabled = true;
  listEl.innerHTML = `<p class="text-sub" style="padding:8px 2px;">読み込み中...</p>`;
  try {
    const res = await apiJson('/api/settings/backups');
    _settingsBackupsCache = (res && res.backups) || [];
    if (!_settingsBackupsCache.length) {
      listEl.innerHTML = `<p class="text-sub" style="padding:8px 2px;">保存されているバックアップがまだありません。「今すぐバックアップを保存」を押すか、下のリンクからファイルで復元してください。</p>`;
      return;
    }
    listEl.innerHTML = _settingsBackupsCache.map((b, idx) => {
      const kindBadge = b.kind === 'manual'
        ? '<span class="chip" style="background:var(--surface-sunken);color:var(--text);">手動</span>'
        : (b.kind === 'auto' ? '<span class="chip chip-neutral">自動</span>' : '');
      const locBadge = b.location === 'internal'
        ? '<span class="chip" style="background:var(--warn-dim);color:var(--warn-strong);border:1px solid var(--warn-border);" title="外部USB/SDへまだ移行できていません。しばらくすると自動的に移行されます。">内部・移行待ち</span>'
        : '';
      const summary = summarizeSettingsBackupContent(b.content);
      const raw = escHtml(JSON.stringify(b.content, null, 2));
      return `
      <label class="radio-card" style="align-items:flex-start;">
        <input type="radio" name="settings-restore-pick" value="${idx}" onchange="document.getElementById('settings-restore-confirm-btn').disabled = false;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            ${kindBadge}${locBadge}
            <span class="radio-card-title">${fmtDateTime(b.createdAt)}</span>
            <span class="text-sub" style="font-size:11.5px;">（${fmtBytes(b.sizeBytes)}）</span>
          </div>
          <ul style="margin:6px 0 0;padding-left:18px;font-size:11.5px;color:var(--text-sub);line-height:1.65;">
            ${summary.map(s => `<li>${escHtml(s)}</li>`).join('')}
          </ul>
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="event.preventDefault(); this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none';">JSONの詳細を見る</button>
          <pre style="display:none;margin-top:6px;max-height:220px;overflow:auto;font-size:11px;background:var(--surface-sunken);padding:8px;border-radius:var(--r-md);white-space:pre-wrap;word-break:break-all;">${raw}</pre>
        </div>
      </label>`;
    }).join('');
  } catch (e) {
    listEl.innerHTML = `<p class="text-sub" style="padding:8px 2px;">バックアップ一覧の取得に失敗しました: ${escHtml(e.message)}</p>`;
  }
}

async function restoreSelectedSettingsBackup(btn) {
  const picked = document.querySelector('input[name="settings-restore-pick"]:checked');
  if (!picked) return;
  const backup = _settingsBackupsCache[Number(picked.value)];
  if (!backup || !backup.content) {
    showToast('バックアップの内容を読み取れませんでした', 'error');
    return;
  }
  const ok = await showConfirm('設定を復元', `「${fmtDateTime(backup.createdAt)}」時点のバックアップの内容で、現在の設定をすべて上書きします。この操作は取り消せません。`, { okLabel: '復元する' });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    await apiJson('/api/settings/import', { method: 'POST', body: JSON.stringify(backup.content) });
    await postAudit('設定復元', `バックアップ(${fmtDateTime(backup.createdAt)} / ${backup.name})から設定を復元しました`);
    showToast('設定を復元しました');
    closeDialog('settings-restore-overlay');
    await loadSettingsView();
  } catch (e) {
    showToast('復元に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function runSettingsBackupNow(btn) {
  setBtnLoading(btn);
  try {
    await apiJson('/api/settings/backups/run', { method: 'POST' });
    await postAudit('バックアップ', '設定のバックアップを手動作成しました');
    showToast('設定のバックアップを保存しました');
  } catch (e) {
    showToast('バックアップの保存に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function sendTestEmailUI(type, btn) {
  const resultEl = document.getElementById(`test-email-result-${type}`);
  setBtnLoading(btn);
  resultEl.textContent = '';
  try {
    const payload = collectSettingsPayload();
    const res = await apiJson('/api/gas', {
      method: 'POST',
      body: JSON.stringify({ action: 'sendTestEmail', type, settings: payload })
    });
    resultEl.textContent = (res && res.message) || '送信しました';
    resultEl.style.color = 'var(--ok-strong)';
  } catch (e) {
    resultEl.textContent = '送信に失敗しました: ' + e.message;
    resultEl.style.color = 'var(--danger-strong)';
  } finally {
    resetBtn(btn);
  }
}

/* ---------------- パスワード変更 ---------------- */
async function changeAdminPassword() {
  const current = document.getElementById('pw-current-admin').value;
  const next = document.getElementById('pw-new-admin').value.trim();
  const confirm = document.getElementById('pw-confirm-admin').value.trim();
  const resultEl = document.getElementById('pw-admin-result');
  resultEl.textContent = '';

  if (next.length < PIN_MIN_LEN || next.length > PIN_MAX_LEN) {
    resultEl.textContent = `新しいパスワードは${PIN_MIN_LEN}〜${PIN_MAX_LEN}桁で入力してください`;
    resultEl.style.color = 'var(--danger-strong)';
    return;
  }
  if (!/^\d+$/.test(next)) {
    resultEl.textContent = '新しいパスワードは数字のみで入力してください';
    resultEl.style.color = 'var(--danger-strong)';
    return;
  }
  if (next !== confirm) {
    resultEl.textContent = '確認用パスワードが一致しません';
    resultEl.style.color = 'var(--danger-strong)';
    return;
  }
  try {
    const res = await apiJson('/api/change-admin-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: current, newPassword: next })
    });
    await postAudit('パスワード変更', '管理者パスワードを変更しました');
    resultEl.textContent = (res && res.message) || 'パスワードを変更しました';
    resultEl.style.color = 'var(--ok-strong)';
    document.getElementById('pw-current-admin').value = '';
    document.getElementById('pw-new-admin').value = '';
    document.getElementById('pw-confirm-admin').value = '';
  } catch (e) {
    resultEl.textContent = e.message;
    resultEl.style.color = 'var(--danger-strong)';
  }
}

/* ============================================================
   バックアップ・データ管理
   バグ修正: ダウンロードURLに認証トークンをクエリで晒さない。
   fetch + Blob でダウンロードする。
   ============================================================ */
async function loadBackupsView() {
  try {
    const [res, storageRes, syncStatus] = await Promise.all([
      apiJson('/backups'),
      apiJson('/recordings/storage-status').catch(() => null),
      apiJson('/api/sync-status').catch(() => null)
    ]);
    renderSpreadsheetSyncStatus(syncStatus);
    if (storageRes) {
      applyStorageStatusEverywhere(storageRes);
    } else {
      const storageLabel = document.getElementById('backup-storage-label');
      if (storageLabel) storageLabel.textContent = 'バックアップの保存先: 取得できませんでした';
    }
    const backups = (res && res.backups) || [];
    const body = document.getElementById('backup-table-body');
    if (!backups.length) {
      body.innerHTML = `<tr><td colspan="3" class="table-empty-cell">まだバックアップがありません</td></tr>`;
      return;
    }
    body.innerHTML = backups.map(b => {
      const kindBadge = b.kind === 'manual'
        ? '<span class="chip" style="background:var(--surface-sunken);color:var(--text);">手動</span>'
        : (b.kind === 'auto' ? '<span class="chip chip-neutral">自動</span>' : '');
      const locBadge = b.location === 'internal'
        ? '<span class="chip" style="background:var(--warn-dim);color:var(--warn-strong);border:1px solid var(--warn-border);" title="外部USB/SDへまだ移行できていません。しばらくすると自動的に移行されます。">内部・移行待ち</span>'
        : '';
      const display = b.name;
      const loc = escHtml(b.location || '');
      return `
      <tr>
        <td><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${kindBadge}${locBadge}${escHtml(display)}</div></td>
        <td class="text-sub">${fmtBytes(b.sizeBytes)}</td>
        <td style="text-align:right">
          <button class="btn btn-ghost btn-sm" onclick="inspectBackupUI('${escHtml(b.name)}', '${loc}', this)">内容を見る</button>
          <button class="btn btn-warn-solid btn-sm" onclick="restoreDatabaseBackup('${escHtml(b.name)}', '${loc}', this)">復元</button>
          <button class="btn btn-danger btn-sm" onclick="deleteBackup('${escHtml(b.name)}', '${loc}', this)">削除</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    showToast('バックアップ一覧の取得に失敗しました: ' + e.message, 'error');
  }
}

function renderSpreadsheetSyncStatus(status) {
  const statusEl = document.getElementById('spreadsheet-sync-status');
  const detailEl = document.getElementById('spreadsheet-sync-detail');
  const errorEl = document.getElementById('spreadsheet-sync-error');
  const button = document.getElementById('spreadsheet-sync-now-btn');
  if (!statusEl || !detailEl || !errorEl || !button) return;

  if (!status) {
    statusEl.textContent = '同期状態を取得できませんでした';
    detailEl.textContent = 'サーバーとの接続を確認して、状態を更新してください。';
    errorEl.textContent = '';
    button.disabled = true;
    return;
  }

  button.disabled = !status.enabled;
  if (!status.enabled) {
    statusEl.textContent = 'スプレッドシート連携は無効です';
    detailEl.textContent = status.configurationError || 'GAS_URLとSYNC_TOKENを設定してサーバーを再起動すると、同期できます。';
  } else if (status.blockedEmpty) {
    statusEl.textContent = '安全のため同期を停止しています';
    detailEl.textContent = `最後に正常同期した時点では${status.lastNonemptyCount || 0}件のデータがありました。データ初期化が意図的でない場合は、導入担当者に確認してください。`;
  } else if (status.consecutiveFailures > 0) {
    statusEl.textContent = `同期エラー（連続 ${status.consecutiveFailures} 回）`;
    detailEl.textContent = status.lastOkAt
      ? `最終成功: ${fmtDateTime(status.lastOkAt)}`
      : 'この端末からの同期成功記録はありません。';
  } else {
    statusEl.textContent = '同期は正常です';
    detailEl.textContent = status.lastOkAt
      ? `最終成功: ${fmtDateTime(status.lastOkAt)}`
      : 'まだ同期成功の記録がありません。';
  }
  errorEl.textContent = status.lastError || '';
}

async function loadSpreadsheetSyncStatus() {
  const statusEl = document.getElementById('spreadsheet-sync-status');
  if (statusEl) statusEl.textContent = '同期状態を確認中...';
  try {
    const status = await apiJson('/api/sync-status');
    renderSpreadsheetSyncStatus(status);
  } catch (e) {
    renderSpreadsheetSyncStatus(null);
    showToast('同期状態の取得に失敗しました: ' + e.message, 'error');
  }
}

async function runManualSpreadsheetSync(btn) {
  const statusEl = document.getElementById('spreadsheet-sync-status');
  const detailEl = document.getElementById('spreadsheet-sync-detail');
  const errorEl = document.getElementById('spreadsheet-sync-error');
  setBtnLoading(btn);
  if (statusEl) statusEl.textContent = 'スプレッドシートへ同期しています...';
  if (detailEl) detailEl.textContent = '完了するまでこの画面を閉じずにお待ちください。';
  if (errorEl) errorEl.textContent = '';
  try {
    const result = await apiJson('/api/sync-now', { method: 'POST' });
    await postAudit('手動同期', result.queued ? '同期中のため再実行を予約しました' : 'スプレッドシートへの同期を実行しました');
    showToast(result.message || '同期を開始しました');
    await loadSpreadsheetSyncStatus();
    if (result.queued) setTimeout(loadSpreadsheetSyncStatus, 3000);
  } catch (e) {
    if (statusEl) statusEl.textContent = '手動同期に失敗しました';
    if (detailEl) detailEl.textContent = '設定とGASの状態を確認してから、もう一度お試しください。';
    if (errorEl) errorEl.textContent = e.message;
    showToast('スプレッドシート同期に失敗しました: ' + e.message, 'error');
    await loadSpreadsheetSyncStatus();
  } finally {
    resetBtn(btn);
  }
}

async function runManualBackup() {
  const msgEl = document.getElementById('backup-status-msg');
  msgEl.textContent = 'バックアップを作成しています...';
  try {
    const res = await apiJson('/backups/run', { method: 'POST' });
    await postAudit('バックアップ', `手動バックアップを作成: ${res.filename || ''}`);
    msgEl.textContent = 'バックアップを作成しました';
    msgEl.style.color = 'var(--ok-strong)';
    await loadBackupsView();
  } catch (e) {
    msgEl.textContent = '作成に失敗しました: ' + e.message;
    msgEl.style.color = 'var(--danger-strong)';
  }
}

async function restoreDatabaseBackup(name, location, btn) {
  const firstConfirm = await showConfirm(
    'データベースを復元',
    `「${name}」の内容で現在のデータベース全体を置き換えます。復元後、復元時点より新しい記録は失われます。復元前のDBは自動バックアップされます。続けますか？`,
    { okLabel: '次へ進む' }
  );
  if (!firstConfirm) return;

  const secondConfirm = await showConfirm(
    '復元してサーバーを再起動',
    '現在と選択したバックアップの両方に貸出中・準備中の記録がない場合のみ実行できます。復元中は操作できず、サーバーが再起動します。実行しますか？',
    { okLabel: '復元して再起動' }
  );
  if (!secondConfirm) return;

  setBtnLoading(btn);
  const msgEl = document.getElementById('backup-status-msg');
  msgEl.textContent = '復元前バックアップとデータベースを検証しています...';
  msgEl.style.color = 'var(--text-sub)';
  try {
    const result = await apiJson('/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ name, location })
    });
    msgEl.textContent = `復元前の退避先: ${result.safetyBackupFilename || 'バックアップ一覧を確認してください'}。サーバーを再起動しています...`;
    msgEl.style.color = 'var(--warn-strong)';
    showToast('データベースを復元しました。サーバーの再起動を待っています。');
    setTimeout(() => window.location.reload(), 5000);
  } catch (e) {
    msgEl.textContent = `復元できませんでした: ${e.message}`;
    msgEl.style.color = 'var(--danger-strong)';
    showToast('データベースを復元できませんでした: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function downloadBackup(name, location, btn) {
  setBtnLoading(btn);
  try {
    const qs = '?name=' + encodeURIComponent(name) + (location ? '&location=' + encodeURIComponent(location) : '');
    const res = await apiFetch('/backups/download' + qs);
    if (!res.ok) throw new Error('ダウンロードに失敗しました');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast('ダウンロードに失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function deleteBackup(name, location, btn) {
  const ok = await showConfirm('バックアップを削除', `「${name}」を削除します。この操作は取り消せません。`, { okLabel: '削除する' });
  if (!ok) return;
  setBtnLoading(btn);
  try {
    const qs = '?name=' + encodeURIComponent(name) + (location ? '&location=' + encodeURIComponent(location) : '');
    await apiJson('/backups' + qs, { method: 'DELETE' });
    await postAudit('バックアップ', `バックアップを削除: ${name}`);
    showToast('削除しました');
    await loadBackupsView();
  } catch (e) {
    showToast('削除に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

/* ============================================================
   DBバックアップ(.db)の中身を確認する
   ------------------------------------------------------------
   バックアップファイルを読み取り専用で開き、各テーブルの件数と
   代表的なテーブルの直近レコードをプレビュー表示する。
   稼働中のapp.dbには一切触れない。
   ============================================================ */
function _dbBackupPreviewTable(rows, columns) {
  if (!rows || !rows.length) {
    return '<p class="text-sub" style="font-size:12px;">データがありません</p>';
  }
  const head = columns.map(c => `<th>${escHtml(c.label)}</th>`).join('');
  const body = rows.map(r => {
    const cells = columns.map(c => {
      let v = r[c.key];
      if (c.type === 'datetime' && v) v = fmtDateTime(v);
      if (v === undefined || v === null || v === '') v = c.emptyText || '—';
      return `<td>${escHtml(String(v))}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="table" style="font-size:12px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function inspectBackupUI(name, location, btn) {
  openDialog('db-backup-inspect-overlay');
  document.getElementById('db-backup-inspect-title').textContent = `バックアップの中身: ${name}`;
  const bodyEl = document.getElementById('db-backup-inspect-body');
  bodyEl.innerHTML = '<p class="text-sub">読み込み中...</p>';
  if (btn) setBtnLoading(btn);
  try {
    const qs = '?name=' + encodeURIComponent(name) + (location ? '&location=' + encodeURIComponent(location) : '');
    const res = await apiJson('/backups/inspect' + qs);
    const c = res.counts || {};
    const s = res.settings;
    const p = res.preview || {};

    const countChip = (label, value) => `
      <div style="background:var(--surface-sunken);border-radius:var(--r-md);padding:8px 12px;min-width:120px;">
        <div class="text-sub" style="font-size:11.5px;">${escHtml(label)}</div>
        <div style="font-size:18px;font-weight:600;">${value === null || value === undefined ? '—' : value}${typeof value === 'number' ? '件' : ''}</div>
      </div>`;

    const countsHtml = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${countChip('貸出中', c.activeLoans)}
        ${countChip('貸出履歴（累計）', c.history)}
        ${countChip('ブラックリスト', c.blacklist)}
        ${countChip('ユーザー管理', c.users)}
        ${countChip('故障中', c.failuresOpen)}
        ${countChip('故障履歴（累計）', c.failuresTotal)}
        ${countChip('メール送信待ち', c.emailQueuePending)}
        ${countChip('メール送信済み', c.emailQueueSent)}
      </div>
      <p class="text-sub" style="font-size:12px;margin-top:8px;">設定の最終更新: ${s && s.updatedAt ? fmtDateTime(s.updatedAt) : '不明'}${s && s.updatedBy ? `（${escHtml(s.updatedBy)}）` : ''}</p>
    `;

    const activeLoansTable = _dbBackupPreviewTable(p.activeLoans, [
      { key: 'name', label: '氏名' }, { key: 'device_id', label: '端末番号' },
      { key: 'email', label: 'メール' }, { key: 'checkout_time', label: '貸出日時', type: 'datetime' }
    ]);
    const historyTable = _dbBackupPreviewTable(p.history, [
      { key: 'name', label: '氏名' }, { key: 'device_id', label: '端末番号' },
      { key: 'checkout_time', label: '貸出日時', type: 'datetime' },
      { key: 'return_time', label: '返却日時', type: 'datetime', emptyText: '未返却' },
      { key: 'status', label: '状態' }
    ]);
    const blacklistTable = _dbBackupPreviewTable(p.blacklist, [
      { key: 'name', label: '氏名' }, { key: 'email', label: 'メール' }, { key: 'reason', label: '理由' },
      { key: 'created_at', label: '登録日時', type: 'datetime' }, { key: 'expiry', label: '期限', emptyText: '無期限' }
    ]);
    const failuresTable = _dbBackupPreviewTable(p.failuresOpen, [
      { key: 'device_id', label: '端末番号' }, { key: 'name', label: '報告者' },
      { key: 'reported_at', label: '報告日時', type: 'datetime' }, { key: 'status', label: '状態' }
    ]);

    bodyEl.innerHTML = `
      ${countsHtml}
      <details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;">貸出中（最新10件）</summary><div style="margin-top:6px;">${activeLoansTable}</div></details>
      <details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;">貸出履歴（最新10件）</summary><div style="margin-top:6px;">${historyTable}</div></details>
      <details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;">ブラックリスト（最新10件）</summary><div style="margin-top:6px;">${blacklistTable}</div></details>
      <details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;">故障中（最新10件）</summary><div style="margin-top:6px;">${failuresTable}</div></details>
    `;
  } catch (e) {
    bodyEl.innerHTML = `<p class="text-sub">中身の取得に失敗しました: ${escHtml(e.message)}</p>`;
  } finally {
    if (btn) resetBtn(btn);
  }
}

/* ============================================================
   使用統計
   ※履歴が多い場合の重さについては将来的な改善課題として
   サーバー側に集計エンドポイントを設けることが望ましい。
   ここではクライアント集計件数に上限を設けて過負荷を避ける。
   ============================================================ */
async function loadStats() {
  try {
    const res = await gasAction('getHistory');
    const all = (res && res.history) || [];
    const history = all.slice(-5000); // 過負荷防止のため直近5000件に制限

    const now = new Date();
    const todayStr = now.toDateString();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const monthAgo = new Date(now.getTime() - 30 * 86400000);

    let todayCount = 0, weekCount = 0, monthCount = 0;
    const hourly = new Array(24).fill(0);
    const dailyMap = {};

    history.forEach(h => {
      const d = new Date(h.checkoutTime);
      if (isNaN(d.getTime())) return;
      if (d.toDateString() === todayStr) todayCount++;
      if (d >= weekAgo) weekCount++;
      if (d >= monthAgo) {
        monthCount++;
        hourly[d.getHours()]++;
      }
      const dayKey = d.toISOString().slice(0, 10);
      dailyMap[dayKey] = (dailyMap[dayKey] || 0) + 1;
    });

    document.getElementById('stats-today-loans').textContent = todayCount;
    document.getElementById('stats-week-loans').textContent = weekCount;
    document.getElementById('stats-month-loans').textContent = monthCount;

    const [failRes, blRes] = await Promise.all([gasAction('getFailures'), gasAction('getBlacklist')]);
    const failures = (failRes && failRes.failures) || [];
    const bl = (blRes && blRes.blacklist) || [];
    document.getElementById('stats-overdue-count').textContent = history.filter(h => h.status === '延滞返却').length;
    document.getElementById('stats-failed-count').textContent = failures.filter(f => !(f.resolvedAt || f.resolved_at)).length;
    document.getElementById('stats-bl-count').textContent = bl.length;

    renderBarChart('stats-hourly-bars', 'stats-hourly-labels', hourly.map((v, i) => ({ label: i % 3 === 0 ? String(i) : '', value: v })));

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, value: dailyMap[key] || 0 });
    }
    renderBarChart('stats-daily-bars', 'stats-daily-labels', days);
  } catch (e) {
    showToast('統計の取得に失敗しました: ' + e.message, 'error');
  }
}

function renderBarChart(barsId, labelsId, data) {
  const max = Math.max(1, ...data.map(d => d.value));
  document.getElementById(barsId).innerHTML = data.map(d =>
    `<div class="bar-chart-col" style="height:${Math.max(2, (d.value / max) * 100)}%" title="${d.value}件"></div>`
  ).join('');
  document.getElementById(labelsId).innerHTML = data.map(d => `<span>${escHtml(d.label)}</span>`).join('');
}

/* ============================================================
   操作ログ（監査ログ）
   ============================================================ */
let _auditCache = [];
let _auditActionFilter = '';

async function postAudit(action, detail, target) {
  try {
    await apiJson('/api/audit', { method: 'POST', body: JSON.stringify({ action, detail, target }) });
  } catch (e) {
    console.warn('監査ログの記録に失敗しました', e);
  }
}

async function loadAuditLog() {
  const btn = document.getElementById('audit-refresh-btn');
  setBtnLoading(btn);
  try {
    const res = await apiJson('/api/audit');
    _auditCache = (res && res.logs) || [];
    document.getElementById('audit-count-label').textContent = `${_auditCache.length} 件の記録`;
    renderAuditFilterChips();
    filterAuditLog();
  } catch (e) {
    showToast('操作ログの取得に失敗しました: ' + e.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

function renderAuditFilterChips() {
  const actions = Array.from(new Set(_auditCache.map(l => l.action))).sort();
  const row = document.getElementById('audit-filter-row');
  row.innerHTML = ['<button class="chip ' + (!_auditActionFilter ? 'chip-ok' : 'chip-neutral') + '" onclick="setAuditFilter(\'\')" style="cursor:pointer;border:none;">すべて</button>']
    .concat(actions.map(a => `<button class="chip ${_auditActionFilter === a ? 'chip-ok' : 'chip-neutral'}" onclick="setAuditFilter('${escHtml(a)}')" style="cursor:pointer;border:none;">${escHtml(a)}</button>`))
    .join('');
}
function setAuditFilter(action) {
  _auditActionFilter = action;
  renderAuditFilterChips();
  filterAuditLog();
}

function filterAuditLog() {
  const q = (document.getElementById('audit-search-input').value || '').trim().toLowerCase();
  const list = _auditCache.filter(l => {
    if (_auditActionFilter && l.action !== _auditActionFilter) return false;
    if (!q) return true;
    return [l.action, l.detail, l.target].some(v => (v || '').toLowerCase().includes(q));
  });
  const wrap = document.getElementById('audit-list');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state"><span class="empty-state-text">記録がありません</span></div>`;
    return;
  }
  wrap.innerHTML = list.map(l => `
    <div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:flex-start;">
      <span class="chip chip-neutral" style="flex-shrink:0;margin-top:1px;">${escHtml(l.action)}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;">${escHtml(l.detail || '')}</div>
        ${l.target ? `<div class="text-dim" style="font-size:11.5px;margin-top:2px;">${escHtml(l.target)}</div>` : ''}
      </div>
      <div class="text-dim" style="font-size:11.5px;white-space:nowrap;">${fmtDateTime(l.timestamp || l.createdAt)}</div>
    </div>`).join('');
}

/* ============================================================
   ドキュメント（仕様書・ガイド）表示
   ------------------------------------------------------------
   marked はローカル配信 (js/vendor/marked.min.js)。見出しに
   アンカーIDを付与し、目次・スクロール追従・アンカー移動・
   コードコピーなどを提供する。
   ============================================================ */
let _docsActive = '';
let _docsCache = {};          // 文書名 -> 本文HTML（marked 出力）
let _docsScrollPos = {};      // 文書名 -> #main-scroll のスクロール位置
let _docsTabEl = null;
let _docsHeadingSeen = null;  // 見出しIDの重複判定用（文書ごとにリセット）
let _docsTocLinks = [];
let _docsTocHeadings = [];
let _docsMarkedInit = false;
let _docsScrollBound = false;
let _docsEventsBound = false;

function _docsSlug(text) {
  let s = String(text).toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (!s) s = 'section';
  const base = s; let i = 1;
  while (_docsHeadingSeen.has(s)) s = base + '-' + (i++);
  _docsHeadingSeen.add(s);
  return s;
}

function _docsInitMarked() {
  if (_docsMarkedInit || !window.marked) return;
  _docsMarkedInit = true;
  marked.setOptions({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      heading(token) {
        const level = Math.min(Math.max(token.depth, 1), 6);
        const contentHtml = this.parser.parseInline(token.tokens);
        const text = contentHtml.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
        const id = _docsSlug(text);
        return '<h' + level + ' id="' + id + '">' + contentHtml +
          '<a class="docs-anchor" href="#' + id + '" aria-label="この見出しへのリンク" tabindex="-1"><span aria-hidden="true">#</span></a>' +
          '</h' + level + '>\n';
      },
      code(token) {
        const lang = (token.lang || '').trim().replace(/[^a-zA-Z0-9+#.-]/g, '') || 'code';
        const codeHtml = escHtml(token.text);
        return '<div class="docs-code"><div class="docs-code-bar"><span class="docs-code-lang">' + escHtml(lang) + '</span><button type="button" class="docs-copy">コピー</button></div><pre><code class="language-' + lang + '">' + codeHtml + '</code></pre></div>\n';
      }
    }
  });
}

function _docsHeadingLabel(heading) {
  return Array.from(heading.childNodes)
    .filter(n => n.nodeType !== Node.ELEMENT_NODE || !n.classList || !n.classList.contains('docs-anchor'))
    .map(n => n.textContent || '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function _docsUpdateScrollSpy() {
  const main = document.getElementById('main-scroll');
  if (!main) return;
  const viewTop = main.scrollTop + main.clientHeight * 0.28;
  let activeIndex = -1;
  for (let i = 0; i < _docsTocHeadings.length; i++) {
    const heading = _docsTocHeadings[i];
    if (!heading) continue;
    const pos = heading.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    if (pos <= viewTop) activeIndex = i;
  }
  _docsTocLinks.forEach((link, i) => link.classList.toggle('is-active', i === activeIndex));
  if (activeIndex >= 0) {
    const active = _docsTocLinks[activeIndex];
    const nav = active.closest('.docs-toc-list');
    if (nav) {
      const top = active.offsetTop - nav.clientHeight / 2;
      nav.scrollTop = Math.max(0, Math.min(top, nav.scrollHeight - nav.clientHeight));
    }
  }
}

function _docsUpdateProgressBar() {
  const main = document.getElementById('main-scroll');
  const article = document.querySelector('.docs-article');
  const bar = document.getElementById('docs-progress-bar');
  if (!main || !article || !bar) return;
  const total = article.offsetHeight - main.clientHeight;
  const pct = total > 0 ? Math.min(100, Math.max(0, (main.scrollTop / total) * 100)) : 100;
  bar.style.width = pct + '%';
}

function _docsOnMainScroll() {
  requestAnimationFrame(() => { _docsUpdateScrollSpy(); _docsUpdateProgressBar(); });
}

function _docsBindScroll() {
  const main = document.getElementById('main-scroll');
  if (!main || _docsScrollBound) return;
  _docsScrollBound = true;
  main.addEventListener('scroll', _docsOnMainScroll, { passive: true });
}

/* ------------------------------------------------------------
   所要時間の目安（日本語の技術文書として控えめな 400字/分で概算）
   ------------------------------------------------------------ */
function _docsUpdateReadingTime(article) {
  const label = document.getElementById('docs-reading-time');
  if (!label || !article) return;
  const chars = (article.textContent || '').replace(/\s+/g, '').length;
  const minutes = Math.max(1, Math.round(chars / 400));
  label.textContent = '目安 約' + minutes + '分・' + chars.toLocaleString('ja-JP') + '文字';
}

/* ------------------------------------------------------------
   ページ内検索（本文中をハイライトし、前後にジャンプする）
   ------------------------------------------------------------ */
let _docsSearchHits = [];
let _docsSearchIndex = -1;
let _docsSearchQuery = '';

function _docsSearchClearHighlights() {
  const article = document.querySelector('.docs-article');
  if (!article) return;
  article.querySelectorAll('mark.docs-search-hit').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  _docsSearchHits = [];
  _docsSearchIndex = -1;
}

function _docsSearchUpdateNav() {
  const count = document.getElementById('docs-search-count');
  const prevBtn = document.getElementById('docs-search-prev');
  const nextBtn = document.getElementById('docs-search-next');
  const clearBtn = document.getElementById('docs-search-clear');
  if (!count || !prevBtn || !nextBtn || !clearBtn) return;

  clearBtn.style.display = _docsSearchQuery ? 'flex' : 'none';

  if (!_docsSearchQuery) {
    count.textContent = '';
    count.className = 'docs-search-count';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }
  if (_docsSearchHits.length === 0) {
    count.textContent = '0件';
    count.className = 'docs-search-count no-hits';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }
  count.textContent = (_docsSearchIndex + 1) + ' / ' + _docsSearchHits.length;
  count.className = 'docs-search-count has-hits';
  prevBtn.disabled = false;
  nextBtn.disabled = false;
}

function _docsSearchApply(query) {
  _docsSearchClearHighlights();
  _docsSearchQuery = query;
  if (!query) { _docsSearchUpdateNav(); return; }

  const article = document.querySelector('.docs-article');
  if (!article) return;
  const needle = query.toLowerCase();

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (p && (p.closest('.docs-code') || p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);

  targets.forEach((textNode) => {
    const text = textNode.nodeValue;
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let idx;
    while ((idx = lower.indexOf(needle, cursor)) !== -1) {
      if (idx > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
      const mark = document.createElement('mark');
      mark.className = 'docs-search-hit';
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      _docsSearchHits.push(mark);
      cursor = idx + query.length;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    textNode.parentNode.replaceChild(frag, textNode);
  });

  _docsSearchIndex = _docsSearchHits.length ? 0 : -1;
  _docsSearchGoTo(_docsSearchIndex);
  _docsSearchUpdateNav();
}

function _docsSearchGoTo(index) {
  if (!_docsSearchHits.length) return;
  _docsSearchHits.forEach((m) => m.classList.remove('is-current'));
  _docsSearchIndex = ((index % _docsSearchHits.length) + _docsSearchHits.length) % _docsSearchHits.length;
  const current = _docsSearchHits[_docsSearchIndex];
  current.classList.add('is-current');
  const main = document.getElementById('main-scroll');
  if (main) {
    const top = current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    main.scrollTo({ top: Math.max(0, top - main.clientHeight * 0.35), behavior: 'smooth' });
  }
  _docsSearchUpdateNav();
}

function _docsSearchNext() { if (_docsSearchHits.length) _docsSearchGoTo(_docsSearchIndex + 1); }
function _docsSearchPrev() { if (_docsSearchHits.length) _docsSearchGoTo(_docsSearchIndex - 1); }

function _docsSearchBindOnce() {
  const input = document.getElementById('docs-search-input');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';

  let debounceTimer = null;
  input.addEventListener('input', () => {
    window.clearTimeout(debounceTimer);
    const value = input.value.trim();
    debounceTimer = window.setTimeout(() => _docsSearchApply(value), 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) _docsSearchPrev(); else _docsSearchNext();
    } else if (e.key === 'Escape') {
      input.value = '';
      _docsSearchApply('');
      input.blur();
    }
  });
  document.getElementById('docs-search-next').addEventListener('click', _docsSearchNext);
  document.getElementById('docs-search-prev').addEventListener('click', _docsSearchPrev);
  document.getElementById('docs-search-clear').addEventListener('click', () => {
    input.value = '';
    _docsSearchApply('');
    input.focus();
  });

  // 「/」キーでドキュメント内検索欄へフォーカス（他の入力欄にフォーカス中は無効）
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const view = document.getElementById('view-docs');
    if (!view || !view.classList.contains('active') && getComputedStyle(view).display === 'none') return;
    const active = document.activeElement;
    const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (isTyping) return;
    e.preventDefault();
    input.focus();
  });
}

function _docsBindEvents() {
  if (_docsEventsBound) return;
  _docsEventsBound = true;
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.docs-toc-toggle');
    if (toggle) {
      const aside = toggle.closest('.docs-toc');
      if (aside) {
        const collapsed = aside.classList.toggle('is-collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
      }
      return;
    }
    const copyBtn = e.target.closest('.docs-copy');
    if (copyBtn) {
      const codeEl = copyBtn.closest('.docs-code').querySelector('pre code');
      const text = codeEl ? codeEl.innerText : '';
      const finish = (ok) => {
        copyBtn.textContent = ok ? 'コピーしました' : 'コピー失敗';
        window.setTimeout(() => { copyBtn.textContent = 'コピー'; }, 1500);
      };
      if (!text) { finish(false); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => finish(true), () => finish(false));
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (err) { }
        ta.remove();
        finish(ok);
      }
      return;
    }
    const topBtn = e.target.closest('.docs-top');
    if (topBtn) {
      const main = document.getElementById('main-scroll');
      if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
}

function _docsBuildLayout(name, contentEl, articleHtml) {
  const main = document.getElementById('main-scroll');

  const layout = document.createElement('div');
  layout.className = 'docs-layout';

  const aside = document.createElement('aside');
  aside.className = 'docs-toc';
  aside.setAttribute('aria-label', '目次');
  aside.innerHTML =
    '<div class="docs-toc-head">' +
    '<span class="docs-toc-title">目次</span>' +
    '<button type="button" class="docs-toc-toggle" title="目次の表示/非表示" aria-expanded="true">' +
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
    '</button>' +
    '</div>' +
    '<nav class="docs-toc-list" aria-label="このページの目次"></nav>';

  const article = document.createElement('article');
  article.className = 'docs-article';
  article.innerHTML = articleHtml;

  const topBtn = document.createElement('button');
  topBtn.type = 'button';
  topBtn.className = 'docs-top';
  topBtn.title = 'ページの先頭へ戻る';
  topBtn.setAttribute('aria-label', 'ページの先頭へ戻る');
  topBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>';

  layout.append(aside, article, topBtn);
  contentEl.textContent = '';
  contentEl.appendChild(layout);

  // 「> **注意** ／ **設計メモ**」 などで始まる引用を、種別に応じたコールアウトにする
  article.querySelectorAll('blockquote').forEach((bq) => {
    const strongEl = bq.querySelector(':scope > p > strong');
    if (!strongEl) return;
    const label = strongEl.textContent.trim();
    let kind = 'info';
    if (/注意|警告|やめて/.test(label)) kind = 'danger';
    else if (/設計メモ|メモ|ヒント|参考|補足/.test(label)) kind = 'memo';
    bq.classList.add('docs-note', 'docs-note--' + kind);
  });

  // 見出し(h2〜h4)から目次を生成する
  const tocNav = aside.querySelector('.docs-toc-list');
  const items = [];
  article.querySelectorAll('h1, h2, h3, h4').forEach((heading) => {
    const id = heading.id;
    if (!id) return;
    const level = parseInt(heading.tagName.charAt(1), 10);
    if (level < 2) return; // 記事タイトル(h1)は目次の外
    items.push({ level: level, id: id, label: _docsHeadingLabel(heading) });
  });
  _docsTocLinks = items.map((item) => {
    const link = document.createElement('a');
    link.className = 'docs-toc-link';
    link.href = '#' + item.id;
    link.dataset.id = item.id;
    link.dataset.level = item.level;
    link.textContent = item.label;
    link.title = item.label;
    return link;
  });
  _docsTocLinks.forEach((link) => tocNav.appendChild(link));
  _docsTocHeadings = _docsTocLinks.map((link) => document.getElementById(link.dataset.id));

  // 目次クリックで本文側をスムーズスクロール
  tocNav.addEventListener('click', (e) => {
    const link = e.target.closest('.docs-toc-link');
    if (!link) return;
    e.preventDefault();
    const heading = document.getElementById(link.dataset.id);
    if (!heading || !main) return;
    const top = heading.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    main.scrollTo({ top: Math.max(0, top - 4), behavior: 'smooth' });
  });

  _docsBindEvents();
  _docsBindScroll();
  _docsSearchBindOnce();
  _docsUpdateReadingTime(article);
  const searchInput = document.getElementById('docs-search-input');
  if (searchInput) searchInput.value = '';
  _docsSearchApply('');
  _docsUpdateScrollSpy();
  if (main) main.scrollTop = _docsScrollPos[name] || 0;
  _docsUpdateProgressBar();
}

async function loadDocsView() {
  if (!_docsActive) {
    loadDoc('SPECIFICATION', document.getElementById('docs-tab-spec'));
    return;
  }
  const btn = document.getElementById('docs-tab-' + _docsActive.toLowerCase());
  setDocsActiveTab(btn);
  const contentEl = document.getElementById('docs-content');
  if (contentEl && _docsCache[_docsActive]) {
    _docsBuildLayout(_docsActive, contentEl, _docsCache[_docsActive]);
  } else {
    _docsUpdateScrollSpy();
  }
}

function setDocsActiveTab(btn) {
  document.querySelectorAll('#docs-tabs .btn').forEach((b) => b.classList.remove('is-active'));
  if (btn) btn.classList.add('is-active');
}

async function loadDoc(name, btn) {
  const main = document.getElementById('main-scroll');

  // 切り替え元の文書のスクロール位置を退避してから新文書へ移る
  if (_docsActive && name !== _docsActive && main) {
    _docsScrollPos[_docsActive] = main.scrollTop;
  }

  setDocsActiveTab(btn);
  _docsActive = name;
  _docsTabEl = btn || null;

  const contentEl = document.getElementById('docs-content');
  if (!contentEl) return;

  if (_docsCache[name]) {
    _docsBuildLayout(name, contentEl, _docsCache[name]);
    return;
  }

  const loader = document.createElement('div');
  loader.className = 'docs-loading';
  loader.innerHTML = '<span class="docs-loading-spinner" aria-hidden="true"></span><span>読み込み中...</span>';
  contentEl.textContent = '';
  contentEl.appendChild(loader);

  try {
    const res = await fetch('/api/docs/' + name + '.md');
    if (!res.ok) throw new Error('ドキュメントを取得できませんでした (HTTP ' + res.status + ')');
    const md = await res.text();

    if (!window.marked) {
      throw new Error('マークダウンライブラリ(marked)の読み込みに失敗しました。通信環境を確認してください。');
    }
    _docsHeadingSeen = new Set();
    _docsInitMarked();
    const html = marked.parse(md);
    _docsCache[name] = html;
    _docsBuildLayout(name, contentEl, html);
  } catch (e) {
    contentEl.textContent = '';
    contentEl.innerHTML = '<div class="empty-state"><span class="empty-state-text">ドキュメントの読み込みに失敗しました: ' + escHtml(e.message) + '</span></div>';
  }
}
