'use strict';

let _navSeq = 0;
let _sysSettings = { checkoutFields: 'email_dob', returnVerify: true, idleTimeoutEnabled: true, returnDeadlineHour: 16, returnDeadlineMinute: 0, logoutCameraCheckEnabled: true };

function dlog(...args) {
  if (_sysSettings.enableDebugLogs === true) console.log(...args);
}

let _doorPollTimer = null;
let _doorPollTimeout = null;
let _doorEventSource = null;
let _doorNotOpenedTimer = null;
let _doorOpenWarningTimer = null;
const DOOR_OPEN_WARNING_MS = 30000;

const _connState = {
  server: true,       // ローカルNodeサーバー
  gas: true,          // GAS（インターネット）
  arduino: true,      // Arduinoシリアル
  serverUpdated: null,  // Date
  gasUpdated: null,
};
let _connCheckInterval = null;

const CACHE_KEYS = {
  loans: 'cache_loans',
  failures: 'cache_failures',
  doorStatus: 'cache_door_status',
  doorConnected: 'cache_door_connected',
};
function _saveCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch (_) { }
}
function _loadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (_) { return null; }
}

let _arduinoStateKnown = false;
let _arduinoAlertHideTimer = null;

function _setConnState(service, ok) {
  if (service === 'server') {
    _connState.server = ok;
    if (ok) _connState.serverUpdated = new Date();
  } else if (service === 'gas') {
    _connState.gas = ok;
    if (ok) _connState.gasUpdated = new Date();
  } else if (service === 'arduino') {
    const prevKnownValue = _arduinoStateKnown ? _connState.arduino : null;
    _connState.arduino = !!ok;
    _arduinoStateKnown = true;
    _updateArduinoAlertBar(!!ok, prevKnownValue);
  }
}

// Arduino（施錠装置）の接続・切断・再接続を、画面上部のバナーで
// はっきりと知らせる。切断中は赤で常時表示し続け、再接続した瞬間だけ
// 緑のバナーを数秒間表示して自動的に消える。
// prevKnownValue が null の場合（起動直後でまだ一度も状態を把握していない場合）は、
// 「再接続した」という演出は行わず、単に現在の状態をそのまま反映するだけにする
// （起動直後に毎回「再接続しました」が出てしまうのを防ぐため）。
function _updateArduinoAlertBar(connected, prevKnownValue) {
  _updateArduinoDownScreen(connected);

  const bar = document.getElementById('arduino-alert-bar');
  if (!bar) return;
  const titleEl = document.getElementById('arduino-alert-bar-title');
  const descEl = document.getElementById('arduino-alert-bar-desc');

  if (_arduinoAlertHideTimer) { clearTimeout(_arduinoAlertHideTimer); _arduinoAlertHideTimer = null; }

  if (!connected) {
    bar.classList.remove('is-reconnected');
    bar.classList.add('is-visible');
    document.body.classList.add('has-arduino-alert');
    if (titleEl) titleEl.textContent = 'Arduino（施錠装置）が切断されています';
    if (descEl) descEl.textContent = '扉の自動解錠ができないため、貸出（端末の受け取り）を停止しています。係の先生にお知らせください。';
  } else if (prevKnownValue === false) {
    // 切断 → 再接続 の変化を検知した場合のみ、成功バナーを一時的に表示する
    bar.classList.add('is-visible', 'is-reconnected');
    document.body.classList.add('has-arduino-alert');
    if (titleEl) titleEl.textContent = 'Arduino（施錠装置）が再接続されました';
    if (descEl) descEl.textContent = '扉の自動解錠が復旧しました。貸出を再開できます。';
    _arduinoAlertHideTimer = setTimeout(() => {
      bar.classList.remove('is-visible');
      document.body.classList.remove('has-arduino-alert');
    }, 5000);
  } else {
    bar.classList.remove('is-visible', 'is-reconnected');
    document.body.classList.remove('has-arduino-alert');
  }
}

// Arduino（施錠装置）との接続が切れている間、キオスク画面全体を覆う
// 「システム停止画面」を表示する。解錠指示そのものが物理的に届かない
// 以上、貸出・返却の一部だけを止めても中途半端な状態を招くだけなので、
// 操作そのものを全面的に止め、原因（Arduino切断）をはっきり伝える。
// 進行中の待機系オーバーレイ（チュートリアル・無操作タイムアウト）は
// 表示していても意味が無いため、この画面を出す際に一緒に閉じる。
function _updateArduinoDownScreen(connected) {
  const overlay = document.getElementById('arduino-down-overlay');
  if (!overlay) return;

  if (!connected) {
    overlay.style.display = 'flex';
    document.body.classList.add('has-arduino-down-overlay');

    const tutorial = document.getElementById('tutorial-overlay');
    if (tutorial) tutorial.remove();
    if (typeof hideIdleCountdown === 'function') hideIdleCountdown();
  } else {
    overlay.style.display = 'none';
    document.body.classList.remove('has-arduino-down-overlay');
  }
}

function _isAnyConnected() {
  return _connState.server || _connState.gas;
}
function _isFullyConnected() {
  return _connState.server && _connState.gas;
}

const IDLE_TIMEOUT_SEC = 90; // 合計タイムアウト
const IDLE_COUNTDOWN_SEC = 15; // カウントダウン表示時間
let _idleTimer = null;
let _idleCountdownInterval = null;

function goTo(name, _force) {
  if (_navLocked && !_force) {
    showFlash('top', 'error', '扉の操作が完了するまでお待ちください');
    return;
  }
  if (_force) _navLocked = false;

  if (name !== 'checkout-door' && isPageActive('checkout-door')
    && window._pendingCheckoutLoanId && window._pendingCheckoutSessionId
    && typeof gasCall === 'function') {
    const loanId = window._pendingCheckoutLoanId;
    const sessionId = window._pendingCheckoutSessionId;
    window._pendingCheckoutLoanId = null;
    window._pendingCheckoutSessionId = null;
    gasCall('checkoutCancel', { loanId, sessionId }).catch(e => {
      console.error('貸出予約を解除できませんでした:', e);
    });
  }
  _navSeq++;
  hideLoading();
  cancelAutoReturn();
  cancelManualCompleteAutoReturn(); // ページ遷移時は「手動完了待ち」の自動復帰タイマーも解除
  stopDoorPolling(); // ページ遷移時は扉ポーリングを停止
  stopIdleTimer();   // 遷移時は一度タイマーを止める

  if (typeof CameraModule !== 'undefined' && CameraModule.abortIfOrphan) {
    CameraModule.abortIfOrphan(name);
  }

  if (typeof LogoutCheck !== 'undefined') {
    LogoutCheck.stop();
  }

  // ログアウト確認のカメラ・ポーリング・タイマー類を一括停止する。
  // これを怠るとページを離れた後もバックグラウンドでカメラ確認が走り続ける
  // （モデル読み込み待ちのポーリングが再開してカメラを起動してしまう）。
  if (typeof _cleanupLogoutSession === 'function') {
    _cleanupLogoutSession();
  }

  if (typeof closeLogoutExampleModal === 'function') {
    closeLogoutExampleModal();
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById('page-' + name);
  if (!page) { console.error('Page not found: page-' + name); return; }
  page.classList.add('active');
  const scrollArea = document.querySelector('.scroll-area');
  if (scrollArea) scrollArea.scrollTop = 0;

  if (typeof applySettingsToUI === 'function') {
    applySettingsToUI();
  }

  if (name === 'top') {
    if (typeof resetCheckoutForm === 'function') {
      resetCheckoutForm({
        doc: document,
        resetDobPickerInput,
        resetGradeSelection,
        resetNameKeyboardMode,
      });
    }
    if (typeof resetDobPickerInput === 'function') {
      resetDobPickerInput('rc-dob');
    }
    if (typeof clearDoorTileHighlight === 'function') clearDoorTileHighlight();

    const _seq = _navSeq;
    Promise.resolve().then(() => {
      if (_seq === _navSeq) updateTopPageInBackground();
    });
  }

  startIdleTimer();

  if (name === 'return-select') loadReturnList();
  if (name === 'return-done') startAutoReturn();
  if (name === 'checkout-warning') startWarnAutoReturn();
}

function showLoading(label, sub, type = 'default', progress = null) {
  stopIdleTimer(); // ローディング中はタイマーを停止

  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;

  if (label) { const el = document.getElementById('loading-label'); if (el) el.textContent = label; }
  if (sub !== undefined) { const el = document.getElementById('loading-sub'); if (el) el.textContent = sub; }

  const barEl = document.getElementById('loading-progress-bar');
  const pctEl = document.getElementById('loading-percentage');
  if (barEl && pctEl) {
    const p = Number(progress);
    if (progress === null || isNaN(p)) {
      barEl.style.width = '';
      barEl.classList.add('indeterminate');
      pctEl.textContent = '';
    } else {
      const val = Math.max(0, Math.min(100, p));
      barEl.classList.remove('indeterminate');
      barEl.style.width = val + '%';
      pctEl.textContent = Math.round(val) + '%';
    }
  }

  document.body.style.pointerEvents = 'none';
  overlay.classList.add('show');

  if (window._loadingSafetyTimer) clearTimeout(window._loadingSafetyTimer);
  window._loadingSafetyTimer = setTimeout(() => {
    if (overlay.classList.contains('show')) {
      hideLoading();
      showFlash('top', 'error', 'ローディングがタイムアウトしました。もう一度お試しください');
    }
  }, 30000);
}

function hideLoading() {
  if (window._loadingSafetyTimer) { clearTimeout(window._loadingSafetyTimer); window._loadingSafetyTimer = null; }
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.remove('show');
  document.body.style.pointerEvents = '';

  startIdleTimer();
}

function showFlash(_page, type, msg) {
  showToast(msg, type === 'success' ? 'success' : (type === 'error' ? 'error' : 'info'));
  // エラー時は、現在表示中のページカード（.page-inner）を軽くシェイクして、
  // トーストの文字だけでなく画面の動きでも「うまくいかなかった」ことを伝える。
  if (type === 'error') {
    const activePage = document.querySelector('.page.active .page-inner') || document.querySelector('.page.active');
    if (activePage) _shakeElement(activePage);
  }
}

function startClock() {
  if (window._clockInterval) clearInterval(window._clockInterval);
  const el = document.getElementById('header-clock');
  if (!el) return;
  const update = () => {
    const now = new Date();
    el.textContent =
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0');
  };
  update();
  window._clockInterval = setInterval(update, 1_000);
}

const AUTO_RETURN_SEC = 5;
let _autoReturnTimer = null;
let _autoReturnTick = null;

function startAutoReturn() {
  cancelAutoReturn();
  const fill = document.getElementById('auto-return-fill');
  const label = document.getElementById('auto-return-label');
  if (!fill || !label) return;

  fill.style.transition = 'none';
  fill.style.transform = 'scaleX(1)';

  let remaining = AUTO_RETURN_SEC;
  label.textContent = remaining + '秒後に自動でトップへ戻ります';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.transition = `transform ${AUTO_RETURN_SEC * 1000}ms linear`;
      fill.style.transform = 'scaleX(0)';
    });
  });

  _autoReturnTick = setInterval(() => {
    remaining--;
    if (remaining > 0) label.textContent = remaining + '秒後に自動でトップへ戻ります';
    else clearInterval(_autoReturnTick);
  }, 1000);

  _autoReturnTimer = setTimeout(() => { goTo('top'); }, AUTO_RETURN_SEC * 1000);
}

function cancelAutoReturn() {
  if (_autoReturnTimer) { clearTimeout(_autoReturnTimer); _autoReturnTimer = null; }
  if (_autoReturnTick) { clearInterval(_autoReturnTick); _autoReturnTick = null; }
  const fill = document.getElementById('auto-return-fill');
  if (fill) { fill.style.transition = 'none'; fill.style.transform = 'scaleX(1)'; }
}

const WARN_AUTO_SEC = 12; // 延滞・ブラックリストの案内文は情報量が多いため、通常の確認画面より長めに確保
let _warnAutoTimer = null;
let _warnAutoTick = null;

function startWarnAutoReturn() {
  cancelWarnAutoReturn();
  const bar = document.getElementById('warn-progress-bar');
  const label = document.getElementById('warn-timer-label');
  if (!bar || !label) return;

  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';

  let remaining = WARN_AUTO_SEC;
  label.textContent = remaining + '秒後にトップへ戻ります';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bar.style.transition = `transform ${WARN_AUTO_SEC * 1000}ms linear`;
      bar.style.transform = 'scaleX(0)';
    });
  });

  _warnAutoTick = setInterval(() => {
    remaining--;
    if (remaining > 0) label.textContent = remaining + '秒後にトップへ戻ります';
    else clearInterval(_warnAutoTick);
  }, 1000);

  _warnAutoTimer = setTimeout(() => { goTo('top'); }, WARN_AUTO_SEC * 1000);
}

function cancelWarnAutoReturn() {
  if (_warnAutoTimer) { clearTimeout(_warnAutoTimer); _warnAutoTimer = null; }
  if (_warnAutoTick) { clearInterval(_warnAutoTick); _warnAutoTick = null; }
  const bar = document.getElementById('warn-progress-bar');
  if (bar) { bar.style.transition = 'none'; bar.style.transform = 'scaleX(1)'; }
}

// 「手動で完了する」ボタンが表示された状態（扉が閉まったことを検知できない、
// またはロック装置に接続できない場合）で、生徒がその場を離れてしまうと、
// 画面が固定されたままになり次の利用者がキオスクを使えなくなる。
// これを防ぐため、ボタン表示から一定時間操作がなければ自動的にトップへ戻す。
// なお、貸出・返却の記録（active_loans等）自体はこの時点で既にDBに保持されて
// おり、トップに戻っても消えない。放置された記録は管理画面の「貸出・履歴」
// タブから「強制返却」等で管理者が事後的に解消できる。
const MANUAL_COMPLETE_AUTO_RETURN_SEC = 240; // 4分
let _manualCompleteAutoTimer = null;
let _manualCompleteAutoTick = null;

function startManualCompleteAutoReturn(kind) {
  cancelManualCompleteAutoReturn();
  const hint = document.getElementById(`${kind}-manual-auto-hint`);
  if (!hint) return;

  let remaining = MANUAL_COMPLETE_AUTO_RETURN_SEC;
  const render = () => {
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    hint.textContent = `このまま操作がない場合、あと${min}分${sec}秒でトップ画面に戻ります（記録は保持されます）`;
  };
  render();

  _manualCompleteAutoTick = setInterval(() => {
    remaining--;
    if (remaining > 0) render();
    else clearInterval(_manualCompleteAutoTick);
  }, 1000);

  _manualCompleteAutoTimer = setTimeout(() => {
    dlog(`[ManualComplete] ${MANUAL_COMPLETE_AUTO_RETURN_SEC}秒間操作がなかったため、トップへ自動的に戻ります`);
    if (typeof deferDoorCompletion === 'function') deferDoorCompletion();
    else goTo('top', true);
  }, MANUAL_COMPLETE_AUTO_RETURN_SEC * 1000);
}

function cancelManualCompleteAutoReturn() {
  if (_manualCompleteAutoTimer) { clearTimeout(_manualCompleteAutoTimer); _manualCompleteAutoTimer = null; }
  if (_manualCompleteAutoTick) { clearInterval(_manualCompleteAutoTick); _manualCompleteAutoTick = null; }
}

window.addEventListener('online', () => {
  dlog('[Network] オンライン復帰');
  showFlash('checkout', 'success', 'インターネットに接続されました');
  showFlash('return-select', 'success', 'インターネットに接続されました');
  if (isPageActive('top')) updateTopPageInBackground();
  if (typeof _retryPendingReturns === 'function') _retryPendingReturns();
});

window.addEventListener('offline', () => {
  console.warn('[Network] オフライン');
  showFlash('checkout', 'error', 'オフラインになりました。一部の機能が制限されます。');
  showFlash('return-select', 'error', 'オフラインになりました。一部の機能が制限されます。');
});

function showLoanSkeleton(container, count) {
  const n = count || 4;
  container.innerHTML = Array(n).fill(0).map(() => `
    <div class="loan-skeleton">
      <div class="skel skel-badge"></div>
      <div style="flex:1">
        <div class="skel skel-line"></div>
        <div class="skel skel-line sm"></div>
      </div>
    </div>
  `).join('');
}

function _fmtTime(date) {
  if (!date) return '';
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return h + ':' + m;
}

function updateStatusBanner() {
  const banner = document.getElementById('status-banner');
  const dotEl = document.getElementById('status-dot');
  const textEl = document.getElementById('status-text');
  if (!banner || !textEl) return;

  const online = navigator.onLine !== false;
  const fullyConnected = _isFullyConnected();
  const anyConnected = _isAnyConnected();

  const total = (typeof ALL_DEVICES !== 'undefined') ? ALL_DEVICES.length : 12;
  const inUse = (typeof store !== 'undefined' && store.loans) ? store.loans.length : 0;
  const failed = (typeof store !== 'undefined' && store.failures) ? store.failures.filter(f => f.status === '故障中').length : 0;
  const avail = total - inUse - failed;
  const now = new Date();
  const timeStr = _fmtTime(now);

  if (!online) {
    if (dotEl) { dotEl.style.background = 'var(--gray-400)'; dotEl.style.animation = 'none'; }
    const cached = _loadCache(CACHE_KEYS.loans);
    const cacheTime = cached ? _fmtTime(new Date(cached.ts)) : '';
    const availText = cacheTime
      ? `<strong>${avail} 台</strong> が利用可能（キャッシュ: ${cacheTime} 時点）`
      : '<strong>オフライン</strong>';
    textEl.innerHTML = `${availText}<span class="status-sync-time" style="color:var(--red)">接続なし</span>`;
  } else if (typeof _isGasOnCooldown === 'function' && _isGasOnCooldown()) {
    if (dotEl) { dotEl.style.background = 'var(--orange)'; dotEl.style.animation = 'none'; }
    const remainSec = Math.max(0, Math.ceil((_gasCooldownUntil - Date.now()) / 1000));
    textEl.innerHTML = `<strong>スプレッドシート連携を一時停止中</strong>（通信エラーが続いたため。貸出・返却は利用できます）<span class="status-sync-time" style="color:var(--orange)">あと約${remainSec}秒</span>`;
  } else if (!anyConnected) {
    if (dotEl) { dotEl.style.background = 'var(--orange)'; dotEl.style.animation = 'none'; }
    const cached = _loadCache(CACHE_KEYS.loans);
    const cacheTime = cached ? _fmtTime(new Date(cached.ts)) : '';
    const availText = cacheTime
      ? `<strong>${avail} 台</strong>（キャッシュ: ${cacheTime} 時点）`
      : '<strong>サーバーに接続できません</strong>';
    textEl.innerHTML = `${availText}<span class="status-sync-time" style="color:var(--orange)">未接続</span>`;
  } else if (avail <= 0) {
    if (dotEl) { dotEl.style.background = 'var(--red)'; dotEl.style.animation = 'none'; }
    const failText = failed > 0 ? ` / 故障 ${failed}` : '';
    textEl.innerHTML = `<strong>利用可能なし</strong>（貸出中 ${inUse}${failText} / ${total} 台）<span class="status-sync-time">${escHtml(timeStr)} 更新</span>`;
  } else {
    if (dotEl) { dotEl.style.background = 'var(--green)'; dotEl.style.animation = ''; }
    const failText = failed > 0 ? ` / 故障 ${failed}` : '';
    textEl.innerHTML = `<strong>${avail} 台</strong> が利用可能（貸出中 ${inUse}${failText} / ${total} 台）<span class="status-sync-time">${escHtml(timeStr)} 更新</span>`;
  }
}

function _updateActionCards() {
  const online = navigator.onLine !== false;
  const serverOk = _connState.server;
  const gasOk = _connState.gas;
  const arduinoOk = _connState.arduino !== false; // 未確定(true)の間は塞き止めない
  const canOperate = online && serverOk && gasOk;

  const maint = !!_sysSettings.maintenanceMode;
  const susp = !!_sysSettings.lendingSuspended;

  const checkoutCard = document.getElementById('action-checkout');
  const returnCard = document.getElementById('action-return');
  const checkoutBadge = document.getElementById('suspended-badge');
  const returnBadge = document.getElementById('return-suspended-badge');

  // 貸出（チェックアウト）は、扉の電磁ロックをArduino経由で解錠できることが
  // 前提の操作のため、Arduinoが切断されている間は新規の貸出を開始できない
  // ようにする。返却は物理的な解錠が失敗しても手動完了フローで運用継続
  // できる設計のため、ここでは対象外とする。
  const checkoutDisabled = !canOperate || susp || maint || !arduinoOk;
  const returnDisabled = !canOperate || susp || maint;

  if (checkoutCard) {
    checkoutCard.classList.toggle('disabled', checkoutDisabled);
    _setActionCardBadge(checkoutBadge, canOperate, maint, susp, '貸出休止中', !arduinoOk);
  }

  if (returnCard) {
    returnCard.classList.toggle('disabled', returnDisabled);
    _setActionCardBadge(returnBadge, canOperate, maint, susp, '返却休止中', false);
  }
}

function _setActionCardBadge(badgeEl, canOperate, maint, susp, suspendedLabel, arduinoDisconnected) {
  if (!badgeEl) return;
  if (!canOperate) {
    badgeEl.textContent = '接続できません';
    badgeEl.style.display = 'block';
  } else if (maint) {
    badgeEl.textContent = 'メンテナンス中';
    badgeEl.style.display = 'block';
  } else if (susp) {
    badgeEl.textContent = suspendedLabel;
    badgeEl.style.display = 'block';
  } else if (arduinoDisconnected) {
    badgeEl.textContent = 'Arduino未接続のため停止中';
    badgeEl.style.display = 'block';
  } else {
    badgeEl.style.display = 'none';
  }
}


async function sendArduinoCommand(action, deviceId, loanId, retry = 0) {
  if (action !== 'open') return { ok: false, arduinoConnected: false };
  const t0 = Date.now();

  const activePage = document.querySelector('.page.active')?.id || '';
  const textId = activePage.includes('checkout') ? 'checkout-door-wait-text' : 'return-door-wait-text';
  const textEl = document.getElementById(textId);
  if (textEl) textEl.textContent = '解錠しています...';

  if (!loanId) {
    console.warn('[Arduino] loanIdが指定されていないため解錠できません');
    if (textEl) textEl.textContent = '解錠に失敗しました。もう一度お試しください';
    return { ok: false, arduinoConnected: true };
  }

  try {
    await localCall('/arduino/authorize', {
      method: 'POST',
      body: JSON.stringify({ loanId, deviceId }),
    });
  } catch (authErr) {
    console.warn(`[Arduino] 解錠許可取得失敗: ${authErr.message}`);
    if (textEl) textEl.textContent = '解錠許可の取得に失敗しました。もう一度お試しください';
    // サーバーから connected フィールド付きの応答が返っていればそれを信頼する。
    // 応答自体が得られなかった（ネットワーク断・タイムアウト等）場合のみ、
    // HTTPステータスの有無から「サーバーに到達できたか」を推測する。
    const connected = authErr.body && typeof authErr.body.connected === 'boolean'
      ? authErr.body.connected
      : typeof authErr.status === 'number';
    return { ok: false, arduinoConnected: connected, error: authErr.message };
  }

  try {
    await localCall('/arduino/open', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    });
    dlog(`[Arduino] 解錠成功: ${deviceId} (${Date.now() - t0}ms)`);
    if (textEl) textEl.textContent = '解錠されました。扉を開けてください';
    return { ok: true, arduinoConnected: true };
  } catch (e) {
    // /arduino/open はサーバーに到達できた場合、成功時のみ200を返し、
    // 失敗時は常に非2xxステータス + JSONボディ({ok:false, error, connected})を
    // 返す実装になっている。fetchWithRetry はエラー時にそのJSONを e.body に
    // 保持しているので、ここで実際の接続状況・失敗理由を正確に判定する。
    const connected = e.body && typeof e.body.connected === 'boolean'
      ? e.body.connected
      : typeof e.status === 'number'; // ステータス付き応答＝サーバーには到達できている
    const reason = (e.body && e.body.error) || e.message;
    console.warn(`[Arduino] 解錠失敗: ${reason} (接続: ${connected})`);
    if (connected && retry === 0 && /err|拒否|使用中|busy/i.test(reason)) {
      if (textEl) textEl.textContent = 'ロックの復帰を待って再試行しています...';
      await new Promise(resolve => setTimeout(resolve, 1200));
      return sendArduinoCommand(action, deviceId, loanId, retry + 1);
    }
    if (textEl) {
      textEl.textContent = connected
        ? '解錠に失敗しました。もう一度お試しください'
        : '接続できませんでした。手動で操作してください';
    }
    return { ok: false, arduinoConnected: connected, error: reason };
  }
}

let _doorWaitStartTime = null;

function startDoorPolling(onClosed, onTimeout, deviceId = null, onNotOpened = null) {
  stopDoorPolling();

  // 扉イラストを初期状態（閉扉・機器なし）にリセットしてから開扉待ちを開始する
  ['checkout-door-illust', 'return-door-illust'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('is-open', 'show-device', 'pulse-ok');
  });

  _doorWaitStartTime = Date.now();
  let closedStartTime = null;
  let hasOpened = false; // 一度扉が開いたかどうかのフラグ
  let _settled = false; // この開始サイクルで完了(閉確認/タイムアウト)済みか
  const REQUIRED_CLOSED_MS = 2000; // 2.0秒間継続（確実な検知のため）

  // onClosed/onTimeout はこのサイクルで一度だけ実行する。
  // SSE と200msポーリングが並行して動作するため、両方が閉扉を観測すると
  // onClosed が二重に発火して checkoutCommit 等が重複実行されていた。
  // また、進行中の非同期ポーリングが停止後に再帰タイマーを再生成して
  // ゾンビ化する事態も防ぐ。
  function _finish() {
    if (_settled) return;
    _settled = true;
    stopDoorPolling();
  }

  if (!!window.EventSource) {
    _doorEventSource = new EventSource(`${ARDUINO_SERVER}/arduino/stream`);
    _doorEventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'door_change') {
          if (!deviceId || data.deviceId === deviceId) {
            dlog(`[SSE] Door change detected: ${data.deviceId} -> ${data.state}`);
            processDoorState(data.state === 'closed');
          }
        }
      } catch (err) { console.error('SSE Error:', err); }
    };
    _doorEventSource.onerror = () => {
      _doorEventSource.close();
      _doorEventSource = null;
      if (_settled) return;
      console.warn('SSE connection lost. Reconnecting in 3s...');
      setTimeout(() => {
        if (_settled) return;
        try {
          _doorEventSource = new EventSource(`${ARDUINO_SERVER}/arduino/stream`);
          _doorEventSource.onmessage = (e2) => {
            try {
              const d = JSON.parse(e2.data);
              if (d.type === 'door_change' && (!deviceId || d.deviceId === deviceId)) {
                dlog(`[SSE] Door change detected: ${d.deviceId} -> ${d.state}`);
                processDoorState(d.state === 'closed');
              }
            } catch (err2) { console.error('SSE Error:', err2); }
          };
        } catch (_) { }
      }, 3000);
    };
  }

  if (onNotOpened) {
    _doorNotOpenedTimer = setTimeout(() => {
      if (!hasOpened) {
        const active = document.querySelector('.page.active')?.id || '';
        if (active === 'checkout-door' || active === 'return-door') {
          console.warn('[DoorPoll] 15秒間扉が開かれませんでした');
          onNotOpened();
        } else {
          dlog('[DoorPoll] notOpenedTimer skipped; active page changed:', active);
        }
      }
    }, 15000);
  }

  _doorPollTimeout = setTimeout(() => {
    _finish();
    console.warn('[DoorPoll] タイムアウト');
    if (onTimeout) onTimeout();
  }, DOOR_CLOSE_TIMEOUT_MS);

  function getDoorWarningEl() {
    const activePage = document.querySelector('.page.active')?.id || '';
    const warnId = activePage.includes('checkout') ? 'checkout-door-open-warning' : 'return-door-open-warning';
    return document.getElementById(warnId);
  }

  function processDoorState(isCurrentlyClosed) {
    if (_settled) return false;
    const activePage = document.querySelector('.page.active')?.id || '';
    const isCheckout = activePage.includes('checkout');
    const progId = isCheckout ? 'checkout-door-progress' : 'return-door-progress';
    const textId = isCheckout ? 'checkout-door-wait-text' : 'return-door-wait-text';
    const progEl = document.getElementById(progId);
    const textEl = document.getElementById(textId);
    const warnEl = getDoorWarningEl();
    const illustEl = document.getElementById(isCheckout ? 'checkout-door-illust' : 'return-door-illust');

    if (!isCurrentlyClosed) {
      const justOpened = !hasOpened;
      hasOpened = true;
      closedStartTime = null;
      if (progEl) {
        progEl.classList.remove('indeterminate');
        progEl.style.width = '0%';
      }
      if (textEl) {
        textEl.textContent = isCheckout
          ? '扉が開いています。取り出したら閉めてください'
          : '扉が開いています。入れたら閉めてください';
      }
      if (illustEl && justOpened) {
        illustEl.classList.remove('pulse-ok');
        illustEl.classList.add('is-open');
        if (isCheckout) {
          // 貸出: 扉が開いたらChromebookがそこにある演出
          setTimeout(() => illustEl.classList.add('show-device'), 320);
        }
      }
      if (!_doorOpenWarningTimer) {
        _doorOpenWarningTimer = setTimeout(() => {
          _doorOpenWarningTimer = null;
          if (warnEl) warnEl.style.display = 'flex';
        }, DOOR_OPEN_WARNING_MS);
      }
    } else {
      if (!hasOpened) {
        if (progEl) progEl.classList.add('indeterminate');
        if (textEl) {
          const waitedMs = Date.now() - _doorWaitStartTime;
          textEl.textContent = waitedMs > 20000
            ? 'ゆっくりで大丈夫です。準備ができたら扉を開けてください'
            : '扉が開くのを待っています...';
        }
      } else {
        if (progEl) progEl.classList.remove('indeterminate');
        const now = Date.now();
        if (closedStartTime === null) {
          closedStartTime = now;
        }

        const elapsed = now - closedStartTime;
        const pct = Math.min(100, (elapsed / REQUIRED_CLOSED_MS) * 100);
        if (progEl) progEl.style.width = pct + '%';
        if (textEl) textEl.textContent = '扉が閉じられました。確認中...';

        if (elapsed >= REQUIRED_CLOSED_MS) {
          _finish();
          if (progEl) progEl.style.width = '100%';
          if (illustEl) {
            illustEl.classList.remove('is-open');
            illustEl.classList.add('pulse-ok');
            // 貸出: 取り出されたので機器を消す / 返却: 収納されたので機器を表示する
            if (isCheckout) illustEl.classList.remove('show-device');
            else illustEl.classList.add('show-device');
          }
          onClosed();
          return true; // 終了
        }
      }
      if (warnEl) warnEl.style.display = 'none';
      if (_doorOpenWarningTimer) { clearTimeout(_doorOpenWarningTimer); _doorOpenWarningTimer = null; }
    }
    return false;
  }

  let _pollFailCount = 0;
  const POLL_FAIL_WARN_THRESHOLD = 10; // 200ms間隔 × 10 ≒ 2秒 通信できなければ表示

  async function poll() {
    try {
      let isCurrentlyClosed = false;
      let connected = true;
      if (deviceId) {
        const data = await localCall('/arduino/status/all');
        connected = !!data.connected;
        if (data.connected) {
          const doorState = data.doors && data.doors[deviceId];
          isCurrentlyClosed = (doorState === 'closed');
        }
      } else {
        const data = await localCall('/arduino/status');
        connected = !!data.connected;
        if (data.connected) {
          isCurrentlyClosed = !!data.closed;
        }
      }

      _pollFailCount = 0;

      if (!connected) {
        const textEl = document.getElementById(
          (document.querySelector('.page.active')?.id || '').includes('checkout')
            ? 'checkout-door-wait-text' : 'return-door-wait-text'
        );
        if (textEl) textEl.textContent = 'ロック機器と通信できません。接続を確認しています...';
      } else if (processDoorState(isCurrentlyClosed)) {
        return;
      }

    } catch (e) {
      dlog('[DoorPoll] 通信エラー（継続）:', e.message);
      closedStartTime = null;
      _pollFailCount++;

      if (_pollFailCount >= POLL_FAIL_WARN_THRESHOLD) {
        const textEl = document.getElementById(
          (document.querySelector('.page.active')?.id || '').includes('checkout')
            ? 'checkout-door-wait-text' : 'return-door-wait-text'
        );
        if (textEl) textEl.textContent = 'サーバーとの通信が不安定です。しばらくお待ちください...（自動で再試行しています）';
      }
    }
    if (_settled) return;
    _doorPollTimer = setTimeout(poll, DOOR_POLL_INTERVAL_MS);
  }

  poll();
}

function stopDoorPolling() {
  if (_doorPollTimer) { clearTimeout(_doorPollTimer); _doorPollTimer = null; }
  if (_doorPollTimeout) { clearTimeout(_doorPollTimeout); _doorPollTimeout = null; }
  if (_doorNotOpenedTimer) { clearTimeout(_doorNotOpenedTimer); _doorNotOpenedTimer = null; }
  if (_doorOpenWarningTimer) { clearTimeout(_doorOpenWarningTimer); _doorOpenWarningTimer = null; }
  if (_doorEventSource) { _doorEventSource.close(); _doorEventSource = null; }
  if (typeof _clearDoorHelpEscalation === 'function') _clearDoorHelpEscalation();
  ['checkout-door-progress', 'return-door-progress'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('indeterminate');
  });
  ['checkout-door-open-warning', 'return-door-open-warning'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}


let _dialogAlertHandler = null;
function showCustomAlert(title, message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('custom-dialog');
    if (!overlay) { resolve(); return; }
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-msg');
    const btnArea = overlay.querySelector('.dialog-buttons');
    const okBtn = document.getElementById('dialog-ok-btn');

    if (_dialogAlertHandler) okBtn.removeEventListener('click', _dialogAlertHandler);

    titleEl.textContent = title;
    msgEl.textContent = message;
    btnArea.classList.add('alert');
    overlay.style.display = 'flex';

    _dialogAlertHandler = () => {
      okBtn.removeEventListener('click', _dialogAlertHandler);
      _dialogAlertHandler = null;
      overlay.style.display = 'none';
      btnArea.classList.remove('alert');
      resolve();
    };
    okBtn.addEventListener('click', _dialogAlertHandler);
  });
}

let _dialogConfirmOkHandler = null;
let _dialogConfirmCancelHandler = null;
function showCustomConfirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('custom-dialog');
    if (!overlay) { resolve(false); return; }
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-msg');
    const btnArea = overlay.querySelector('.dialog-buttons');
    const okBtn = document.getElementById('dialog-ok-btn');
    const canBtn = document.getElementById('dialog-cancel-btn');

    if (_dialogConfirmOkHandler) okBtn.removeEventListener('click', _dialogConfirmOkHandler);
    if (_dialogConfirmCancelHandler) canBtn.removeEventListener('click', _dialogConfirmCancelHandler);

    titleEl.textContent = title;
    msgEl.textContent = message;
    btnArea.classList.remove('alert');
    overlay.style.display = 'flex';

    const cleanup = () => {
      if (_dialogConfirmOkHandler) { okBtn.removeEventListener('click', _dialogConfirmOkHandler); _dialogConfirmOkHandler = null; }
      if (_dialogConfirmCancelHandler) { canBtn.removeEventListener('click', _dialogConfirmCancelHandler); _dialogConfirmCancelHandler = null; }
      overlay.style.display = 'none';
    };

    _dialogConfirmOkHandler = () => { cleanup(); resolve(true); };
    _dialogConfirmCancelHandler = () => { cleanup(); resolve(false); };

    okBtn.addEventListener('click', _dialogConfirmOkHandler);
    canBtn.addEventListener('click', _dialogConfirmCancelHandler);
  });
}


function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { }
}

// 要素に「クラス付与→アニメーション終了で除去」を安全に行う共通ヘルパー。
// 短いアニメーションを何度も連続で再トリガーできるよう、既存のクラスを
// 一度剥がしてから reflow を挟んで付け直す（同じクラス名のままだと
// ブラウザがアニメーションを再開してくれないため）。
function _retriggerAnimation(el, className) {
  if (!el) return;
  el.classList.remove(className);
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth; // reflowを強制してアニメーションを再始動可能にする
  el.classList.add(className);
}

// エラー発生時などに要素を軽くシェイクさせる。入力欄のクリアやエラー表示など、
// 「操作が失敗した／内容が変わった」ことを画面の動きとしても伝えるために使う。
function _shakeElement(el) {
  if (!el) return;
  _retriggerAnimation(el, 'shake-on-error');
  el.addEventListener('animationend', () => el.classList.remove('shake-on-error'), { once: true });
}

// 扉閉め完了ステップ（checkout-door-step3-num / return-door-step3-num）の
// 「3」という数字を、チェックマークへふわっとモーフィングさせる。
// 以前は className を 'step-num done' にして textContent を「完了」という
// 文字列に変えるだけだったが、他の完了表現（done-icon等）と揃え、
// ポップ＋チェックマーク描画のアニメーションにする。
function _markStepDone(el) {
  if (!el) return;
  el.className = 'step-num done is-morphing';
  el.innerHTML = `<svg class="step-check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path class="step-check-path" d="M20 6L9 17l-5-5"/></svg>`;
  el.addEventListener('animationend', () => el.classList.remove('is-morphing'), { once: true });
}


let _toastSeq = 0;
const TOAST_MAX_VISIBLE = 3;

function showToast(msg, type) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const kind = (type === 'error' || type === 'success') ? type : 'info';

  const duration = kind === 'error' ? 4600 : 3200;

  const existing = container.querySelectorAll('.toast-item');
  if (existing.length >= TOAST_MAX_VISIBLE) {
    _dismissToast(existing[0]);
  }

  const el = document.createElement('div');
  el.className = `toast-item ${kind}`;
  el.setAttribute('role', 'status');
  el.id = `toast-${++_toastSeq}`;
  el.innerHTML = `
    <span class="toast-dot"></span>
    <span class="toast-msg"></span>
  `;
  el.querySelector('.toast-msg').textContent = msg;
  container.appendChild(el);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('show'));
  });

  const timer = setTimeout(() => _dismissToast(el), duration);
  el._toastTimer = timer;

  el.addEventListener('click', () => _dismissToast(el));
}

function _dismissToast(el) {
  if (!el || el._dismissing) return;
  el._dismissing = true;
  clearTimeout(el._toastTimer);
  el.classList.remove('show');
  el.classList.add('hide');
  const remove = () => el.remove();
  el.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 320); // transitionendが発火しない場合のフォールバック
}

function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mo}/${da} ${h}:${mi}`;
}

function setBtnLoading(btn, label) {
  if (!btn) return;
  btn.disabled = true;
  btn._origHTML = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span>${label || '処理中...'}`;
}

function resetBtn(btn, html) {
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = html || btn._origHTML || '';
}

// ============================================================
// 端末番号の表示（即時反映）
// door-checkout-num / door-return-num に使う。
// 値が変わったときだけ即時反映する。
function flipDeviceNum(el, newText) {
  if (!el) return;
  const text = String(newText == null ? '' : newText);
  if (el.textContent === text) return;
  el.textContent = text;
  el.dataset.flipValue = text;
}

// 生年月日入力（数字キーパッド直接入力方式）
// ------------------------------------------------------------
// 以前はドラムロール（縦スクロールのホイールピッカー）だったが、
// 画面タップのみのキオスク運用に合わせて、学籍番号入力と同じ
// 「数字キーパッドで8桁（YYYYMMDD）を直接入力」方式に統一する。
// idPrefixには 'co-dob' または 'rc-dob' を渡す想定。
const _dobInputs = {};

function _dobFormatDisplay(digits) {
  // 入力途中でも読みやすいよう、桁数に応じて YYYY年MM月DD日 の形に区切って表示する。
  const y = digits.slice(0, 4), m = digits.slice(4, 6), d = digits.slice(6, 8);
  let out = y;
  if (digits.length > 4) out += '/' + m;
  if (digits.length > 6) out += '/' + d;
  return out;
}

function initDobPicker(idPrefix) {
  if (_dobInputs[idPrefix]) return;
  const inputEl = document.getElementById(`${idPrefix}-part`);
  if (!inputEl) return;
  _dobInputs[idPrefix] = { digits: '' };
  inputEl.value = '';
}

function _dobRefreshDisplay(idPrefix) {
  const state = _dobInputs[idPrefix];
  const inputEl = document.getElementById(`${idPrefix}-part`);
  if (!state || !inputEl) return;
  inputEl.value = _dobFormatDisplay(state.digits);
  const group = document.getElementById(`${idPrefix}-input-group`);
  if (group) group.classList.toggle('dob-input-group--full', state.digits.length >= 8);
}

function appendDobDigit(idPrefix, ch) {
  const state = _dobInputs[idPrefix];
  if (!state) return;
  if (state.digits.length >= 8) { vibrate(15); return; }
  state.digits += ch;
  _dobRefreshDisplay(idPrefix);
  vibrate(8);
}

function deleteDobDigit(idPrefix) {
  const state = _dobInputs[idPrefix];
  if (!state || !state.digits) return;
  state.digits = state.digits.slice(0, -1);
  _dobRefreshDisplay(idPrefix);
  vibrate(8);
}

function clearDobInput(idPrefix) {
  const state = _dobInputs[idPrefix];
  if (!state || !state.digits) return;
  state.digits = '';
  _dobRefreshDisplay(idPrefix);
  vibrate([10, 20, 10]);
}

function initDobKeypad(idPrefix) {
  const pad = document.getElementById(`${idPrefix}-keypad`);
  if (!pad || pad.dataset.bound) return;
  pad.dataset.bound = '1';
  pad.innerHTML = `
    <div class="onkey-row">
      <button type="button" class="onkey-key" data-ch="1">1</button>
      <button type="button" class="onkey-key" data-ch="2">2</button>
      <button type="button" class="onkey-key" data-ch="3">3</button>
    </div>
    <div class="onkey-row">
      <button type="button" class="onkey-key" data-ch="4">4</button>
      <button type="button" class="onkey-key" data-ch="5">5</button>
      <button type="button" class="onkey-key" data-ch="6">6</button>
    </div>
    <div class="onkey-row">
      <button type="button" class="onkey-key" data-ch="7">7</button>
      <button type="button" class="onkey-key" data-ch="8">8</button>
      <button type="button" class="onkey-key" data-ch="9">9</button>
    </div>
    <div class="onkey-row">
      <button type="button" class="onkey-key onkey-key--ghost" data-action="clear">全消去</button>
      <button type="button" class="onkey-key" data-ch="0">0</button>
      <button type="button" class="onkey-key" data-action="del">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>
        </svg>
      </button>
    </div>
  `;
  pad.addEventListener('click', e => {
    const keyBtn = e.target.closest('.onkey-key');
    if (!keyBtn) return;
    if (keyBtn.dataset.action === 'del') { deleteDobDigit(idPrefix); return; }
    if (keyBtn.dataset.action === 'clear') { clearDobInput(idPrefix); return; }
    const ch = keyBtn.dataset.ch;
    if (ch !== undefined) appendDobDigit(idPrefix, ch);
  });
}

function resetDobPickerInput(idPrefix) {
  const state = _dobInputs[idPrefix];
  if (!state) return;
  state.digits = '';
  _dobRefreshDisplay(idPrefix);
}

// digitsが妥当な日付（実在する年月日）かどうかを検証する。
// ドラムロール時代は候補自体が存在する日にしか選べなかったため、
// 直接入力になったことでここでの検証が必要になった。
function _dobDigitsToValue(digits) {
  if (digits.length !== 8) return '';
  const y = parseInt(digits.slice(0, 4), 10);
  const m = parseInt(digits.slice(4, 6), 10);
  const d = parseInt(digits.slice(6, 8), 10);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const daysInMonth = new Date(y, m, 0).getDate();
  if (d > daysInMonth) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function getDobValue(idPrefix) {
  const state = _dobInputs[idPrefix];
  if (!state) return '';
  return _dobDigitsToValue(state.digits);
}



// 管理者画面への隠しトリガー：トップ画面の端末一覧(「扉の開閉状態」グリッド、
// door-status-grid)のタイルを決まった順番でタップする方式。
// (以前はアイコンの長押し→四隅タップと変遷したが、既存の画面要素を使う
//  ことで見た目を一切変えずに済み、生徒には「ただの状態表示」にしか見えない)
//
// 【並び順を変更したい場合】
// 下のADMIN_DEVICE_SEQUENCEを、ALL_DEVICES(config.js)にある端末IDの中から
// 好きな順番・好きな個数(3〜5個程度を推奨)で書き換えてください。
// 同じ端末を連続で含めることもできます(例: ['CB-01','CB-01','CB-12'])。
const ADMIN_DEVICE_SEQUENCE = ['CB-04', 'CB-11', 'CB-02', 'CB-09'];
// 前のタップからこの時間内に次をタップしないと最初からやり直しになる。
// 生徒が普段の待ち時間にグリッドをあちこち触っただけでは揃わないようにする猶予。
const ADMIN_TAP_TIMEOUT_MS = 4000;
let _deviceTapProgress = [];
let _deviceTapResetTimer = null;

function initAdminTrigger() {
  const grid = document.getElementById('door-status-grid');
  if (!grid) return;

  const resetProgress = () => {
    _deviceTapProgress = [];
    if (_deviceTapResetTimer) { clearTimeout(_deviceTapResetTimer); _deviceTapResetTimer = null; }
  };

  const handleTap = (deviceId) => {
    if (_deviceTapResetTimer) clearTimeout(_deviceTapResetTimer);
    _deviceTapResetTimer = setTimeout(resetProgress, ADMIN_TAP_TIMEOUT_MS);

    const expected = ADMIN_DEVICE_SEQUENCE[_deviceTapProgress.length];
    if (deviceId === expected) {
      _deviceTapProgress.push(deviceId);
      if (_deviceTapProgress.length === ADMIN_DEVICE_SEQUENCE.length) {
        resetProgress();
        vibrate([40, 30, 40]);
        showAdminPasswordDialog();
      }
    } else {
      // 間違った端末を押したらやり直し。ただし今回のタップがシーケンスの
      // 1手目と一致するなら、そこから仕切り直せるようにする。
      _deviceTapProgress = (deviceId === ADMIN_DEVICE_SEQUENCE[0]) ? [deviceId] : [];
    }
  };

  // door-status-grid の中身は状態更新のたびに innerHTML ごと再描画されるため、
  // 個々のタイルに直接リスナーを付けず、変わらない親要素に委譲する。
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.door-tile');
    if (!tile) return;
    const deviceId = tile.dataset.deviceId;
    if (!deviceId) return;
    handleTap(deviceId);
  });
}

function showAdminPasswordDialog() {
  const existing = document.getElementById('admin-pw-dialog');
  if (existing) existing.remove();

  let _entered = '';

  const overlay = document.createElement('div');
  overlay.id = 'admin-pw-dialog';
  overlay.innerHTML = `
    <div class="apw-backdrop"></div>
    <div class="apw-card" role="dialog" aria-modal="true" aria-label="管理者認証">
      <div class="apw-title">管理者認証</div>
      <div class="apw-sub">パスワードを入力してください</div>
      <div class="apw-dots" id="apw-dots">
        ${Array.from({ length: 12 }, (_, i) => `<span class="apw-dot" data-i="${i}"></span>`).join('')}
      </div>
      <div class="apw-error" id="apw-error"></div>
      <div class="apw-keypad">
        <button class="apw-key" data-val="1">1</button>
        <button class="apw-key" data-val="2">2</button>
        <button class="apw-key" data-val="3">3</button>
        <button class="apw-key" data-val="4">4</button>
        <button class="apw-key" data-val="5">5</button>
        <button class="apw-key" data-val="6">6</button>
        <button class="apw-key" data-val="7">7</button>
        <button class="apw-key" data-val="8">8</button>
        <button class="apw-key" data-val="9">9</button>
        <button class="apw-key apw-key-cancel" id="apw-cancel">取消</button>
        <button class="apw-key" data-val="0">0</button>
        <button class="apw-key apw-key-del" id="apw-del">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/>
            <line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>
          </svg>
        </button>
      </div>
      <button class="apw-key apw-key-submit" id="apw-submit" type="button">ログイン</button>
    </div>
  `;

  if (!document.getElementById('apw-style')) {
    const s = document.createElement('style');
    s.id = 'apw-style';
    s.textContent = `
      #admin-pw-dialog {
        /* システム停止画面(Arduino切断)やメンテナンス画面の上からでも
           管理者認証には必ずたどり着けるよう、あらゆるオーバーレイより
           手前に表示する。 */
        position: fixed; inset: 0; z-index: 999999;
        display: flex; align-items: center; justify-content: center;
      }
      .apw-backdrop {
        position: absolute; inset: 0;
        background: rgba(15,23,42,0.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
      }
      .apw-card {
        position: relative; z-index: 1;
        background: #fff;
        border-radius: 28px;
        padding: 28px 24px 24px;
        width: min(320px, calc(100vw - 40px));
        box-shadow: 0 24px 64px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.08);
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        animation: apw-in 220ms cubic-bezier(0.2,0,0,1) both;
      }
      @keyframes apw-in {
        from { opacity: 0; transform: scale(0.92) translateY(12px); }
        to   { opacity: 1; transform: scale(1) translateY(0); }
      }
      .apw-title {
        font-size: 18px; font-weight: 800;
        color: var(--gray-900); letter-spacing: -0.02em;
        align-self: flex-start;
      }
      .apw-sub {
        font-size: 13px; color: var(--gray-500);
        margin-top: -8px; align-self: flex-start;
      }
      .apw-dots {
        display: flex; gap: 8px; margin: 4px 0 0;
      }
      .apw-dot {
        width: 12px; height: 12px; border-radius: 50%;
        border: 2px solid var(--gray-300);
        background: transparent;
        transition: background 150ms, border-color 150ms, transform 120ms;
      }
      .apw-dot.filled {
        background: var(--blue);
        border-color: var(--blue);
        transform: scale(1.15);
      }
      .apw-dot.error {
        background: var(--red);
        border-color: var(--red);
      }
      .apw-dots.shake {
        animation: apw-shake 320ms ease;
      }
      @keyframes apw-shake {
        0%,100%{ transform: translateX(0); }
        20%    { transform: translateX(-8px); }
        40%    { transform: translateX(8px); }
        60%    { transform: translateX(-5px); }
        80%    { transform: translateX(5px); }
      }
      .apw-error {
        font-size: 12px; font-weight: 600;
        color: var(--red); min-height: 14px;
        align-self: flex-start;
        margin-top: -6px;
      }
      .apw-keypad {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        width: 100%;
      }
      .apw-key {
        height: 64px;
        border: 1.5px solid var(--gray-200);
        border-radius: 16px;
        background: var(--surface);
        font-size: 22px; font-weight: 700;
        font-family: inherit; color: var(--gray-900);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 1px 3px rgba(0,0,0,0.06);
        transition: transform 100ms, background 100ms, opacity 100ms;
        -webkit-tap-highlight-color: transparent;
        user-select: none;
      }
      .apw-key:active {
        transform: scale(0.93);
        background: var(--gray-100);
      }
      .apw-key-cancel {
        font-size: 13px; font-weight: 700;
        color: var(--gray-500);
        border-color: var(--gray-200);
      }
      .apw-key-del {
        color: var(--gray-600);
      }
    `;
    document.head.appendChild(s);
  }

  document.body.appendChild(overlay);

  const dotsEl = document.getElementById('apw-dots');
  const errorEl = document.getElementById('apw-error');
  const allDots = dotsEl.querySelectorAll('.apw-dot');
  const minLen = 6;
  const maxLen = 12;

  function renderDots() {
    allDots.forEach((d, i) => {
      d.classList.toggle('filled', i < _entered.length);
      d.classList.remove('error');
    });
  }

  function shakeError() {
    allDots.forEach(d => d.classList.add('error'));
    dotsEl.classList.remove('shake');
    void dotsEl.offsetWidth;
    dotsEl.classList.add('shake');
    dotsEl.addEventListener('animationend', () => {
      dotsEl.classList.remove('shake');
    }, { once: true });
    vibrate([30, 20, 30]);
  }

  async function attempt() {
    try {
      dotsEl.style.opacity = '0.4';
      const res = await fetch(`${ARDUINO_SERVER}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: _entered })
      });
      const d = await res.json();
      if (d.ok) {
        // バグ修正: 以前は localStorage に保存していたため、キオスク端末で
        // 管理者が一度この手動解錠ダイアログでログインすると、ブラウザを
        // 閉じても・別の生徒が使っても消えない管理者トークンが残り続け、
        // セッション有効期限(30分)が切れるまでの間、任意の端末を貸出/返却
        // 状態と無関係に解錠できてしまう状態になっていた。
        // このトークンは同じタブ内で完結する用途（手動解錠ダイアログ経由の
        // /arduino/open 呼び出し、および直後の admin.html 遷移）にしか
        // 使わないため、タブを閉じれば自動的に消える sessionStorage に統一する。
        try { sessionStorage.setItem('admin_token', d.token); } catch (e) { }
        // admin.html（管理者画面）は起動時に sessionStorage の 'admin_session_token'
        // を見て、有効なセッションがあればログイン画面をスキップする仕組みを持っている。
        // キオスク画面でのログインもここに同じトークンを保存しておくことで、
        // admin.html 遷移後にパスワードを再入力させられる問題を解消する。
        try { sessionStorage.setItem('admin_session_token', d.token); } catch (e) { }
        overlay.remove();
        // location.href だとブラウザ履歴に admin.html のエントリが積まれてしまい、
        // その後キオスク画面（index.html）に戻ってから生徒が横スワイプで「進む」
        // 操作をした際に、管理者画面へ到達できてしまう経路になる。
        // location.replace() は現在の履歴エントリを admin.html で置き換えるだけで
        // 新しいエントリを追加しないため、キオスク画面へ「進む」で戻れる先が
        // 履歴上に存在しなくなる。
        window.location.replace('admin.html');
      } else {
        dotsEl.style.opacity = '';
        errorEl.textContent = d.error || 'パスワードが違います';
        shakeError();
        setTimeout(() => {
          _entered = '';
          errorEl.textContent = '';
          renderDots();
        }, 700);
      }
    } catch (e) {
      dotsEl.style.opacity = '';
      errorEl.textContent = '通信エラーが発生しました';
      shakeError();
      setTimeout(() => {
        _entered = '';
        errorEl.textContent = '';
        renderDots();
      }, 1500);
    }
  }

  overlay.querySelector('.apw-keypad').addEventListener('click', e => {
    const key = e.target.closest('.apw-key');
    if (!key) return;

    const val = key.dataset.val;
    if (val !== undefined) {
      if (_entered.length < maxLen) {
        _entered += val;
        renderDots();
        vibrate(8);
      }
    }
  });

  document.getElementById('apw-del').addEventListener('click', () => {
    _entered = _entered.slice(0, -1);
    errorEl.textContent = '';
    renderDots();
    vibrate(8);
  });
  document.getElementById('apw-submit').addEventListener('click', () => {
    if (_entered.length >= minLen) attempt();
    else errorEl.textContent = `パスワードは${minLen}桁以上です`;
  });

  document.getElementById('apw-cancel').addEventListener('click', () => {
    overlay.remove();
  });

  overlay.querySelector('.apw-backdrop').addEventListener('click', () => {
    overlay.remove();
  });

  renderDots();
}


const NO_IDLE_TIMEOUT_PAGES = ['top', 'logout-guide', 'logout-verify', 'return-done', 'checkout-warning', 'checkout-door', 'return-door'];

// このシステムは index.html（生徒用キオスク画面）と admin.html（管理者画面）の
// 両方から js/ui.js を読み込んでいる。以下で定義する「利用者向け無操作タイマー」
// （IDLE_TIMEOUT_SEC 経過でトップ画面へ強制的に戻す機能）は、生徒がキオスクを
// 操作放棄した場合のためのものであり、管理者が設定画面やデータ一覧を確認して
// いる間に誤発火してはならない。
// admin.html には index.html にある #page-top 等のページ要素が存在しないため、
// これまでは無操作タイマーが管理者画面上でも誤って動作し続け、最終的に
// goTo('top') を呼び出して（index.html専用の要素が無いため）不整合な状態や
// ReferenceError の原因にもなっていた。
// <body data-page="admin"> / <body data-page="kiosk"> を見て、管理者画面では
// この関数群を確実に無効化する。管理者専用の別系統のセキュリティタイマー
// （admin.js の ADMIN_IDLE_LOCK_MS）はここでは一切変更しない。
function _isAdminPage() {
  return document.body && document.body.dataset.page === 'admin';
}

function startIdleTimer() {
  stopIdleTimer();
  if (_isAdminPage()) return;
  // 録画中のページは設定に関係なく無操作監視を行う
  // （貸出を途中で放棄したユーザーの録画データが残り続けるのを防ぐため。
  //   カウントダウンはタップで継続できるため、操作中のユーザーには影響しない）
  const recActive = (typeof CameraModule !== 'undefined') && CameraModule.isRecording && CameraModule.isRecording();
  if (_sysSettings.idleTimeoutEnabled !== true && !recActive) return;

  if (NO_IDLE_TIMEOUT_PAGES.some(p => isPageActive(p))) return;

  _idleStartTime = Date.now();
  _idleTimer = setTimeout(() => {
    showIdleCountdown();
  }, (IDLE_TIMEOUT_SEC - IDLE_COUNTDOWN_SEC) * 1000);
}

function stopIdleTimer() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  _idleStartTime = null;
  hideIdleCountdown();
}

let _idleStartTime = null;

function resetIdleTimer() {
  if (document.getElementById('loading-overlay')?.classList.contains('show')) return;
  startIdleTimer();
}

function isPageActive(name) {
  const el = document.getElementById('page-' + name);
  return el && el.classList.contains('active');
}

function showIdleCountdown() {
  let remaining = IDLE_COUNTDOWN_SEC;
  const existing = document.getElementById('idle-overlay');
  if (existing) existing.remove();
  let overlay = document.createElement('div');
  overlay.id = 'idle-overlay';
  overlay.innerHTML = `
      <div class="idle-bg"></div>
      <div class="idle-content">
        <div class="idle-ring-wrap">
          <svg class="idle-ring-svg" viewBox="0 0 120 120">
            <circle class="idle-ring-track" cx="60" cy="60" r="52"/>
            <circle class="idle-ring-bar" id="idle-ring-bar" cx="60" cy="60" r="52"/>
          </svg>
          <div class="idle-count-wrap">
            <span class="idle-count-num" id="idle-count">${remaining}</span>
          </div>
        </div>
        <div class="idle-title">操作が止まっています</div>
        <div class="idle-msg">画面をタップすると続けられます</div>
        <div class="idle-sub">タップがなければトップ画面に戻ります</div>
      </div>
    `;
  document.body.appendChild(overlay);

  if (!document.getElementById('idle-style')) {
    const s = document.createElement('style');
    s.id = 'idle-style';
    s.textContent = `
        #idle-overlay {
          position: fixed; inset: 0; z-index: 9999;
          display: flex; align-items: center; justify-content: center;
          opacity: 0; pointer-events: none;
          transition: opacity 400ms cubic-bezier(0.4,0,0.2,1);
          will-change: opacity;
        }
        #idle-overlay.show {
          opacity: 1; pointer-events: auto;
        }
        .idle-bg {
          position: absolute; inset: 0;
          background: radial-gradient(ellipse at center,
            rgba(15,23,42,0.72) 0%,
            rgba(7,10,24,0.85) 100%);
          backdrop-filter: blur(12px) saturate(120%);
          -webkit-backdrop-filter: blur(12px) saturate(120%);
        }
        .idle-content {
          position: relative; z-index: 1;
          display: flex; flex-direction: column;
          align-items: center; gap: 20px;
          padding: 40px 32px;
          text-align: center;
          animation: idle-content-in 500ms cubic-bezier(0.2,1,0.2,1) both;
        }
        @keyframes idle-content-in {
          from { opacity:0; transform: scale(0.88) translateY(24px); }
          to   { opacity:1; transform: scale(1) translateY(0); }
        }
        .idle-ring-wrap {
          position: relative;
          width: 160px; height: 160px;
          flex-shrink: 0;
        }
        .idle-ring-svg {
          width: 160px; height: 160px;
          transform: rotate(-90deg);
        }
        .idle-ring-track {
          fill: none;
          stroke: rgba(255,255,255,0.08);
          stroke-width: 8;
        }
        .idle-ring-bar {
          fill: none;
          stroke: url(#idle-gradient);
          stroke-width: 8;
          stroke-linecap: round;
          stroke-dasharray: 326.7;
          stroke-dashoffset: 0;
          transition: stroke-dashoffset 1s linear;
          will-change: stroke-dashoffset;
        }
        .idle-count-wrap {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .idle-count-num {
          font-size: 56px; font-weight: 900;
          color: white; letter-spacing: -0.04em;
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }
        .idle-title {
          font-size: 22px; font-weight: 800;
          color: white; letter-spacing: -0.02em;
          line-height: 1.2;
        }
        .idle-msg {
          font-size: 17px; font-weight: 600;
          color: rgba(255,255,255,0.65);
          line-height: 1.4;
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 100px;
          padding: 12px 28px;
        }
        .idle-sub {
          font-size: 13px; font-weight: 500;
          color: rgba(255,255,255,0.3);
          line-height: 1.5;
        }
      `;
    document.head.appendChild(s);
  }

  const svgDef = overlay.querySelector('.idle-ring-svg');
  svgDef.insertAdjacentHTML('afterbegin', `
      <defs>
        <linearGradient id="idle-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#60a5fa"/>
          <stop offset="100%" stop-color="#3b82f6"/>
        </linearGradient>
      </defs>
    `);

  const tapHandler = (e) => {
    e.stopPropagation();
    hideIdleCountdown();
    startIdleTimer();
  };
  overlay.addEventListener('click', tapHandler, { once: true });
  overlay.addEventListener('touchstart', tapHandler, { once: true, passive: true });

  overlay.classList.add('show');
  const countEl = document.getElementById('idle-count');
  const barEl = document.getElementById('idle-ring-bar');
  const CIRCUMFERENCE = 326.7;

  if (countEl) countEl.textContent = remaining;
  if (barEl) {
    barEl.style.transition = 'none';
    barEl.style.strokeDashoffset = '0';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        barEl.style.transition = `stroke-dashoffset ${IDLE_COUNTDOWN_SEC}s linear`;
        barEl.style.strokeDashoffset = CIRCUMFERENCE;
      });
    });
  }

  _idleCountdownInterval = setInterval(() => {
    remaining--;
    const el = document.getElementById('idle-count');
    if (el) el.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(_idleCountdownInterval);
      _idleCountdownInterval = null;
      overlay.classList.remove('show');
      goTo('top');
    }
  }, 1000);
}

function hideIdleCountdown() {
  const overlay = document.getElementById('idle-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    // 遷移終了後にオーバーレイ要素を完全に削除（メモリリーク防止）
    setTimeout(() => overlay.remove(), 400);
  }
  if (_idleCountdownInterval) {
    clearInterval(_idleCountdownInterval);
    _idleCountdownInterval = null;
  }
}

['mousedown', 'touchstart', 'keydown', 'input'].forEach(ev => {
  window.addEventListener(ev, (e) => {
    if (document.getElementById('idle-overlay')?.classList.contains('show')) {
      hideIdleCountdown();
    }
    resetIdleTimer();
  }, { passive: true });
});

window.addEventListener('error', e => {
  console.error('[GlobalError]', e.message, e.filename, e.lineno);
  fetch(`${ARDUINO_SERVER}/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      level: 'ERROR',
      msg: `[JS] ${e.message} at ${e.filename}:${e.lineno}`,
      stack: e.error ? e.error.stack : null,
      ua: navigator.userAgent
    })
  }).catch(() => { });
});

window.addEventListener('unhandledrejection', e => {
  console.error('[UnhandledPromise]', e.reason);
  fetch(`${ARDUINO_SERVER}/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      level: 'ERROR',
      msg: `[Promise] ${e.reason}`,
      stack: e.reason instanceof Error ? e.reason.stack : null,
      ua: navigator.userAgent
    })
  }).catch(() => { });
});

window.addEventListener('DOMContentLoaded', () => {
  initAdminTrigger();
  if (typeof _retryPendingReturns === 'function') _retryPendingReturns();
  initKeyboardAwareScroll();
});

/**
 * オンスクリーンキーボード対策：
 * Chromebookのタッチキーボードが下から出てくると、入力欄がその下に隠れて
 * 何を入力しているか見えなくなることがある。フォーム部品にフォーカスが
 * 当たったら、キーボードのせり上がりアニメーションが落ち着くのを少し待ってから
 * その要素を画面中央付近までスクロールして見えるようにする。
 */
function initKeyboardAwareScroll() {
  const FOCUSABLE_SELECTOR = 'input, select, textarea';
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || !el.matches || !el.matches(FOCUSABLE_SELECTOR)) return;
    setTimeout(() => {
      try {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (_) {
        el.scrollIntoView();
      }
    }, 300);
  }, true);
}
