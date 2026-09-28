'use strict';
/* ============================================================
   共通UIユーティリティ（管理画面専用）
   ============================================================ */

function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ---------------- トースト ---------------- */
function showToast(msg, type) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' is-error' : '');
  el.innerHTML = `<span class="toast-dot"></span><span>${escHtml(msg)}</span>`;
  region.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, 3400);
}

/* ---------------- 確認ダイアログ（Promise化） ---------------- */
function showConfirm(title, message, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    okBtn.textContent = opts.okLabel || '実行する';
    okBtn.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger-solid');

    const cleanup = (result) => {
      overlay.classList.remove('is-open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === overlay) cleanup(false); };
    const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    overlay.classList.add('is-open');
    okBtn.focus();
  });
}

function showAlertDialog(title, message) {
  return new Promise(resolve => {
    const overlay = document.getElementById('alert-overlay');
    document.getElementById('alert-title').textContent = title;
    document.getElementById('alert-message').textContent = message;
    const okBtn = document.getElementById('alert-ok-btn');
    const cleanup = () => {
      overlay.classList.remove('is-open');
      okBtn.removeEventListener('click', onOk);
      overlay.removeEventListener('click', onBackdrop);
      resolve();
    };
    const onOk = () => cleanup();
    const onBackdrop = (e) => { if (e.target === overlay) cleanup(); };
    okBtn.addEventListener('click', onOk);
    overlay.addEventListener('click', onBackdrop);
    overlay.classList.add('is-open');
    okBtn.focus();
  });
}

function closeDialog(id) {
  document.getElementById(id).classList.remove('is-open');
}
function openDialog(id) {
  document.getElementById(id).classList.add('is-open');
}

/* ---------------- ボタンローディング状態 ---------------- */
function setBtnLoading(btn) {
  if (!btn) return;
  btn.dataset.prevHtml = btn.innerHTML;
  btn.classList.add('btn-loading');
  btn.disabled = true;
}
function resetBtn(btn) {
  if (!btn) return;
  if (btn.dataset.prevHtml !== undefined) btn.innerHTML = btn.dataset.prevHtml;
  btn.classList.remove('btn-loading');
  btn.disabled = false;
}

/* ---------------- テーマ切替 ---------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-icon-sun').style.display = theme === 'dark' ? 'block' : 'none';
  document.getElementById('theme-icon-moon').style.display = theme === 'dark' ? 'none' : 'block';
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    const label = theme === 'dark' ? 'ライトモードに切替' : 'ダークモードに切替';
    themeToggle.setAttribute('aria-label', label);
    themeToggle.title = label;
  }
  try { localStorage.setItem('admin-theme', theme); } catch (e) { }
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('admin-theme'); } catch (e) { }
  applyTheme(saved || 'dark');
})();
