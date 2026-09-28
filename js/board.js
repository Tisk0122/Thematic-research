'use strict';
/*
 * 貸出状況ボード（board.html）のロジック。
 *
 * このページは HDMI 等で接続された拡張ディスプレイに、
 * scripts/board-watch.sh によって自動で開かれる「閲覧専用」の画面。
 * 生徒側の貸出・返却フロー（index.html / js/app.js）や管理画面
 * （admin.html / js/admin.js）とは完全に独立しており、
 * このファイルは /api/board-status を定期的に取得して描画するだけの
 * 単純なポーリング表示に徹する（書き込み系API呼び出しは一切行わない）。
 */

const POLL_INTERVAL_MS = 5000;
const DEFAULT_SLIDE_INTERVAL_SEC = 8;
const FETCH_TIMEOUT_MS = 4000;
const OFFLINE_BANNER_AFTER_MS = 12000; // 直近取得からこれだけ経ったら「切断中」表示

let _lastGoodAt = null;
let _consecutiveFailures = 0;
let _latestData = null;

let _slideDefs = []; // 現在表示すべきスライドID配列（データに応じて可変）
let _slideIndex = 0;
let _slideTimer = null;
let _slideIntervalSec = DEFAULT_SLIDE_INTERVAL_SEC;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// 時計（データ取得とは独立に1秒ごとに更新する）
// ---------------------------------------------------------------------
function tickClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const timeEl = $('board-clock-time');
  if (timeEl) timeEl.textContent = `${hh}:${mm}`;

  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const dateEl = $('board-clock-date');
  if (dateEl) {
    dateEl.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${days[now.getDay()]}）`;
  }
}

// ---------------------------------------------------------------------
// データ取得
// ---------------------------------------------------------------------
async function fetchBoardStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/board-status', { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || data.ok !== true) throw new Error(data && data.error || '不明なエラー');
    onFetchSuccess(data);
  } catch (e) {
    clearTimeout(timer);
    onFetchFailure(e);
  }
}

function onFetchSuccess(data) {
  _lastGoodAt = new Date();
  _consecutiveFailures = 0;
  _latestData = data;
  setOfflineBannerVisible(false);
  $('board-boot').style.display = 'none';

  const enabled = data.settings && data.settings.boardEnabled !== false;
  if (!enabled) {
    $('board-shell').style.display = 'none';
    $('board-disabled').style.display = 'flex';
    stopSlideshow();
    return;
  }
  $('board-disabled').style.display = 'none';
  $('board-shell').style.display = 'flex';

  render(data);
  applySlideIntervalFromSettings(data);
}

function onFetchFailure(e) {
  _consecutiveFailures++;
  const sinceMs = _lastGoodAt ? (Date.now() - _lastGoodAt.getTime()) : null;
  // 初回起動でまだ一度も成功していない場合は起動オーバーレイのまま待つ
  if (!_lastGoodAt) return;
  if (sinceMs !== null && sinceMs > OFFLINE_BANNER_AFTER_MS) {
    setOfflineBannerVisible(true);
  }
}

function setOfflineBannerVisible(visible) {
  const el = $('board-offline-banner');
  if (!el) return;
  el.classList.toggle('is-visible', visible);
  if (visible) {
    const since = $('board-offline-since');
    if (since && _lastGoodAt) {
      const hh = String(_lastGoodAt.getHours()).padStart(2, '0');
      const mm = String(_lastGoodAt.getMinutes()).padStart(2, '0');
      const ss = String(_lastGoodAt.getSeconds()).padStart(2, '0');
      since.textContent = `${hh}:${mm}:${ss}`;
    }
  }
}

// ---------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------
function fmtTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtElapsed(iso, now) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const diffMin = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60000));
  if (diffMin < 60) return `${diffMin}分`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return `${h}時間${m > 0 ? m + '分' : ''}`;
}

function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function render(data) {
  const now = new Date(data.serverTime || Date.now());

  // --- 状態チップ ---
  setChip('chip-arduino', data.system && data.system.arduinoConnected, '施錠装置 接続中', '施錠装置 未接続');
  const syncOk = data.system && data.system.syncOk && !data.system.syncBlockedEmpty;
  setChip('chip-sync', syncOk, 'スプレッドシート同期 正常', 'スプレッドシート同期 要確認');

  // --- 概観タイル ---
  const devices = data.devices || { total: 12, inUse: 0, available: 12, broken: 0 };
  $('tile-total-devices').textContent = devices.total ?? 12;
  $('tile-inuse').textContent = devices.inUse ?? 0;
  $('tile-available').textContent = Math.max(0, devices.available ?? 0);

  const overdueCount = (data.loans || []).filter(l => l.overdue).length;
  $('tile-overdue').textContent = overdueCount;
  $('tile-overdue-card').classList.toggle('is-zero', overdueCount === 0);

  const brokenCount = devices.broken ?? (data.failures || []).length;
  $('tile-broken').textContent = brokenCount;
  $('tile-broken-card').classList.toggle('is-zero', brokenCount === 0);

  $('ov-today-checkouts').textContent = (data.today && data.today.checkouts) ?? 0;
  $('ov-today-returns').textContent = (data.today && data.today.returns) ?? 0;
  const lateCount = (data.today && data.today.lateReturns) || 0;
  $('ov-today-late').textContent = lateCount;
  $('ov-today-late-wrap').style.opacity = lateCount > 0 ? '1' : '0.45';

  // --- 端末ごとの利用・故障状態（氏名は表示しない） ---
  const deviceList = Array.isArray(data.deviceList) ? data.deviceList : [];
  $('devices-count-sub').textContent = `${deviceList.length}台`;
  const devicesGrid = $('devices-grid');
  const devicesEmpty = $('devices-empty');
  if (deviceList.length === 0) {
    devicesGrid.innerHTML = '';
    devicesGrid.style.display = 'none';
    devicesEmpty.style.display = 'flex';
  } else {
    devicesGrid.style.display = 'grid';
    devicesEmpty.style.display = 'none';
    devicesGrid.innerHTML = deviceList.map(device => {
      const isBroken = !!device.broken;
      const isInUse = !!device.inUse;
      const className = isBroken ? 'is-broken' : (isInUse ? 'is-in-use' : 'is-available');
      const status = isBroken
        ? (isInUse ? '故障中・貸出中' : '故障中')
        : (isInUse ? '貸出中' : '貸出可能');
      return `
        <div class="board-device-card ${className}${device.overdue ? ' is-overdue' : ''}">
          <div class="board-device-card-top">
            <span class="board-device-id">${escapeHtml(device.deviceId || '-')}</span>
            ${device.overdue ? '<span class="board-device-overdue">延滞</span>' : ''}
          </div>
          <div class="board-device-status">${status}</div>
        </div>
      `;
    }).join('');
  }

  // --- 貸出中一覧 ---
  const loans = data.loans || [];
  $('loans-count-sub').textContent = loans.length > 0 ? `${loans.length}台` : '';
  const loansGrid = $('loans-grid');
  const loansEmpty = $('loans-empty');
  if (loans.length === 0) {
    loansGrid.innerHTML = '';
    loansGrid.style.display = 'none';
    loansEmpty.style.display = 'flex';
  } else {
    loansGrid.style.display = 'grid';
    loansEmpty.style.display = 'none';
    loansGrid.innerHTML = loans.map(l => `
      <div class="board-loan-card ${l.overdue ? 'is-overdue' : ''}">
        <div class="board-loan-card-top">
          <span class="board-loan-device">${escapeHtml(l.deviceId || '-')}</span>
          ${l.overdue ? '<span class="board-loan-badge">延滞</span>' : ''}
        </div>
        <div class="board-loan-name">貸出中</div>
        <div class="board-loan-meta">
          <span>貸出 ${fmtTime(l.checkoutTime)}（${fmtElapsed(l.checkoutTime, now)}経過）</span>
          <span class="${l.overdue ? 'is-overdue-text' : ''}">期限 ${l.dueTime ? fmtTime(l.dueTime) : '-'}</span>
        </div>
      </div>
    `).join('');
  }

  // --- 故障端末 ---
  const failures = data.failures || [];
  $('failures-count-sub').textContent = failures.length > 0 ? `${failures.length}台` : '';
  $('failures-grid').innerHTML = failures.map(f => `
    <div class="board-fail-card">
      <div class="board-fail-device">${escapeHtml(f.deviceId || '-')}</div>
      <div class="board-fail-meta">報告日 ${fmtDateShort(f.reportedAt)} ${fmtTime(f.reportedAt)}</div>
    </div>
  `).join('');

  // --- ブラックリスト（設定で有効時のみデータが入っている） ---
  const blacklist = data.blacklist || [];
  const blCount = data.blacklistCount || 0;
  $('blacklist-count-sub').textContent = blCount > 0 ? `${blCount}名` : '';
  $('blacklist-grid').innerHTML = blacklist.map(b => `
    <div class="board-bl-card">
      <div class="board-bl-name">貸出制限中</div>
      <div class="board-bl-meta">${b.expiry === 'PERMANENT' ? '無期限' : ('〜' + fmtDateShort(b.expiry))}</div>
    </div>
  `).join('');

  $('board-updated-at').textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  updateSlideAvailability(data);
}

function setChip(id, ok, okText, warnText) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('is-ok', !!ok);
  el.classList.toggle('is-warn', !ok);
  const label = el.querySelector('.board-chip-label');
  if (label) label.textContent = ok ? okText : warnText;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------
// スライドショー制御
// ---------------------------------------------------------------------
function updateSlideAvailability(data) {
  const defs = ['overview', 'devices', 'loans'];
  if ((data.failures || []).length > 0) defs.push('failures');
  if (data.settings && data.settings.boardShowBlacklist && (data.blacklist || []).length > 0) defs.push('blacklist');

  const changed = JSON.stringify(defs) !== JSON.stringify(_slideDefs);
  _slideDefs = defs;
  renderDots();

  if (changed) {
    if (_slideIndex >= _slideDefs.length) _slideIndex = 0;
    showSlide(_slideIndex, false);
  }
}

function renderDots() {
  const wrap = $('board-dots');
  if (!wrap) return;
  wrap.innerHTML = _slideDefs.map((_, i) =>
    `<span class="board-dot-indicator ${i === _slideIndex ? 'is-active' : ''}"></span>`
  ).join('');
}

function showSlide(index, animate) {
  const sections = document.querySelectorAll('.board-slide');
  sections.forEach(sec => {
    const id = sec.getAttribute('data-slide');
    const shouldShow = _slideDefs[index] === id;
    if (shouldShow) {
      sec.classList.add('is-active');
      sec.classList.remove('is-leaving');
    } else {
      if (sec.classList.contains('is-active')) sec.classList.add('is-leaving');
      sec.classList.remove('is-active');
    }
  });
  renderDots();
}

function nextSlide() {
  if (_slideDefs.length <= 1) return;
  _slideIndex = (_slideIndex + 1) % _slideDefs.length;
  showSlide(_slideIndex, true);
}

function applySlideIntervalFromSettings(data) {
  const sec = (data.settings && data.settings.boardSlideIntervalSec) || DEFAULT_SLIDE_INTERVAL_SEC;
  if (sec === _slideIntervalSec && _slideTimer) return; // 変更なしなら張り直さない
  _slideIntervalSec = sec;
  startSlideshow();
}

function startSlideshow() {
  stopSlideshow();
  _slideTimer = setInterval(nextSlide, Math.max(3, _slideIntervalSec) * 1000);
}
function stopSlideshow() {
  if (_slideTimer) { clearInterval(_slideTimer); _slideTimer = null; }
}

// ---------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------
function init() {
  tickClock();
  setInterval(tickClock, 1000);

  showSlide(0, false);
  fetchBoardStatus();
  setInterval(fetchBoardStatus, POLL_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', init);
