'use strict';

/**
 * ブラウザナビゲーション抑制（キオスク画面・管理者画面 共通）
 * -------------------------------------------------------
 * このスクリプトは index.html（<body data-page="kiosk">）と
 * admin.html（<body data-page="admin">）の両方で読み込まれる。
 * どちらの画面でも、横スワイプ等による「戻る/進む」操作を抑制する。
 *
 * 目的:
 * - 生徒が誤って（あるいは意図的に）左右にスワイプした際、ブラウザの
 *   「戻る/進む」（履歴ナビ）が発動して、キオスク画面から管理者画面
 *   （パスワード入力画面を含む）へ、あるいはその逆へ飛んでしまうのを防ぐ。
 * - ブラウザの戻るボタン・Alt+←/→ 等の「戻る/進む」操作を抑制する。
 * - タッチパネルの横方向スワイプで、画面内の意図しない横スクロール等が
 *   起きないようにする。
 *
 * 注意点（仕様の意図）:
 * - 縦方向のスクロール（返却チェックリストや管理者画面の一覧など）は許可する。
 *   ここでは「横方向の移動が支配的」なジェスチャだけを無効化するため、
 *   縦スクロールはそのまま機能する。
 * - Ctrl+W / Alt+Tab など、ブラウザや OS が直接処理するキー操作は、
 * Web ページ側の JavaScript では原理的に防げないため対象外
 * （これらは Chrome ポリシー・WM設定・X11設定の別レイヤーで対処済み）。
 * - 管理者（先生）側もブラウザの「戻る/進む」操作が制限される仕様として
 *   意図的にこの抑制を admin.html にも適用している。管理者画面内の画面
 *   遷移はタブ切り替え等アプリ側のUIで完結する設計のため、実運用上の
 *   支障はない想定。
 */
(function () {
  const PAGE_ATTR = document.body && document.body.getAttribute('data-page');

  // キオスク画面・管理者画面のどちらでもない場合は何もしない。
  if (PAGE_ATTR !== 'kiosk' && PAGE_ATTR !== 'admin') return;

  // -------------------------------------------------------------------
  // 1. オーバースクロール（左右エッジ）による履歴ナビの抑制
  //    CSS の overscroll-behavior-x:none は、タッチパネル・トラックパッドの
  //    左右オーバースクロール（戻る/進む）をブラウザ標準で抑制する。
  //    <html> と最上位スクロールコンテナに適用する。
  // -------------------------------------------------------------------
  try {
    document.documentElement.style.overscrollBehaviorX = 'none';
    document.documentElement.style.touchAction = 'pan-y pinch-zoom';
  } catch (_) { }

  function applyNoOverscrollX() {
    // .scroll-area / .page / .page-inner はキオスク画面（index.html）、
    // .main / .sidebar は管理者画面（admin.html）のスクロールコンテナ。
    document.querySelectorAll('body, .scroll-area, .page, .page-inner, .main, .sidebar').forEach((el) => {
      if (el) {
        el.style.overscrollBehaviorX = 'none';
        el.style.touchAction = 'pan-y pinch-zoom';
      }
    });
  }
  applyNoOverscrollX();
  // 動的に生成される要素にも効くよう、MutationObserver で監視する。
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => applyNoOverscrollX());
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 履歴に現在ページの番兵を置き、ブラウザー戻る/進む操作が来ても
  // 同じ画面（キオスク or 管理者）に留まる。SPA内の画面切り替えはURL履歴を使わない。
  function restoreNavigationLockHistoryEntry() {
    try {
      const currentState = history.state;
      const state = currentState && typeof currentState === 'object' ? currentState : {};
      history.pushState({ ...state, __navigationLock: true }, '', location.href);
    } catch (_) { }
  }
  restoreNavigationLockHistoryEntry();
  window.addEventListener('popstate', restoreNavigationLockHistoryEntry, true);

  // -------------------------------------------------------------------
  // 2. タッチパネルのスワイプ（戻る/進む・横スクロール）の抑制
  //    横向きの移動が支配的なジェスチャだけを preventDefault する。
  //    縦スクロール（縦の移動が支配的）はそのまま許可する。
  // -------------------------------------------------------------------
  const THRESHOLD_RATIO = 1.2; // 横移動が縦移動の何倍で「横スワイプ」とみなすか
  const MIN_SWIPE_PX = 30;     // 有効とみなす最小移動量(px)。誤タッチ防止
  let touchStartX = null;
  let touchStartY = null;
  let touchActive = false;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { touchActive = false; return; }
    touchActive = true;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!touchActive || e.touches.length !== 1 || touchStartX === null) return;

    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    // 横移動が支配的な場合のみブロックする（縦スクロールは許可）。
    if (absX > MIN_SWIPE_PX && absX > absY * THRESHOLD_RATIO) {
      touchActive = false; // このジェスチャは横スワイプと確定
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('touchend', () => { touchActive = false; }, { passive: true });
  document.addEventListener('touchcancel', () => { touchActive = false; }, { passive: true });

  // -------------------------------------------------------------------
  // 3. その他の「戻る/進む」操作の抑制
  //    - Alt+←  / Alt+→　：ブラウザ履歴の戻る/進む
  //    - Alt+↑  / Alt+↓　：フォーム送信等（保険）
  //    ブラウザの「戻る」ボタンそのものを JS から無効化することはできない
  //    が、キオスク画面は全画面（--kiosk）でアドレスバー・ボタンが無い
  //    ため、実運用上はキーボードショートカットが主な経路になる。
  // -------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'BrowserBack' || e.key === 'BrowserForward') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // ブラウザの「戻る」相当のマウスボタン（4=戻る、5=進む）を無効化する。
  // 実際の履歴ナビはブラウザが内部で行うため、完全には防げない場合があるが、
  // 多くの場合 mousedown の preventDefault で発動を抑止できる。
  ['mousedown', 'mouseup', 'auxclick'].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      if (e.button === 4 || e.button === 5) {
        e.preventDefault();
      }
    }, true);
  });
})();
