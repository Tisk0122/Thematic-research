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
    document.documentElement.style.overscrollBehavior = 'none';
    document.documentElement.style.overscrollBehaviorX = 'none';
    document.documentElement.style.overscrollBehaviorY = 'none';
    document.documentElement.style.touchAction = 'pan-y';
  } catch (_) { }

  function applyNoOverscrollX() {
    // .scroll-area / .page / .page-inner はキオスク画面（index.html）、
    // .main / .sidebar は管理者画面（admin.html）のスクロールコンテナ。
    document.querySelectorAll('body, .scroll-area, .page, .page-inner, .main, .sidebar').forEach((el) => {
      if (el) {
        el.style.overscrollBehavior = 'none';
        el.style.overscrollBehaviorX = 'none';
        el.style.overscrollBehaviorY = 'none';
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
  const MIN_SWIPE_PX = 8;      // ブロックとみなす最小の横移動量(px)。誤タッチ防止
  const EDGE_GUARD_PX = 24;    // 画面左右端のこの幅内で始まったタッチは即ブロック対象
  let touchStartX = null;
  let touchStartY = null;
  let touchActive = false;
  // この一連のタッチで横スワイプと確定したかどうか。確定後は、指が離れる
  // （touchend / touchcancel）まで後続の touchmove もすべて preventDefault する。
  // ここで touchActive を false にしてしまうと、以降の touchmove が
  // 「ジェスチャ未追跡」として素通りし、preventDefault されずに履歴ナビが
  // 発動してしまう（ゆっくり滑るスワイプほど抜けやすい）。
  let touchBlocked = false;

  // 横スクロールが許可されている要素（管理画面の一覧テーブルなど）の内側は、
  // 意図した横スクロールを妨げないためブロック対象から外す。
  function isHorizontalScroller(el) {
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style && (style.overflowX === 'auto' || style.overflowX === 'scroll')) return true;
      node = node.parentElement;
    }
    return false;
  }

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { touchActive = false; touchBlocked = false; return; }
    touchActive = true;
    touchBlocked = false;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    // 画面左右の端から始まったタッチは、それ自体が Chromium の
    // 「戻る」ジェスチャの起点になる。開始時点ではまだ水平移動量が
    // 0 なので、この時点でブロック確定として扱っておき、
    // 最初の touchmove を待たずに preventDefault できるようにする。
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    if (vw > 0 && (touchStartX <= EDGE_GUARD_PX || touchStartX >= vw - EDGE_GUARD_PX)) {
      touchBlocked = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    // 一度横スワイプと確定したジェスチャは、残りの移動もすべてブロックする。
    if (touchBlocked) {
      e.preventDefault();
      return;
    }
    if (!touchActive || e.touches.length !== 1 || touchStartX === null) return;

    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    // 縦移動が支配的でない場合（= 横移動が支配的な場合）のみブロックする。
    // 判定を「縦が支配的 → 許可」に倒すことで、最初の 1 回目の touchmove から
    // preventDefault できる。旧実装にあった「閾値(30px)を捨てるまで
    // preventDefault しない」待ち時間を無くし、
    // 指が高速で移動した場合に最初の touchmove が素通りする穴を塞ぐ。
    if (absY >= absX) return;
    if (absX <= MIN_SWIPE_PX) return;
    if (isHorizontalScroller(e.target)) return;

    touchBlocked = true; // この一連のタッチは横スワイプとして確定（指を離れるまで維持）
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => { touchActive = false; touchBlocked = false; }, { passive: true });
  document.addEventListener('touchcancel', () => { touchActive = false; touchBlocked = false; }, { passive: true });

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

  // -------------------------------------------------------------------
  // 4. ページ内で起こりうる脱出口の封鎖
  //    OS側(apply-desktop-lockdown.sh / Chromiumポリシー)を塞いっても、
  //    「ページ上で完結する操作」までは止められない。そのためChromium内部の
  //    操作（コンテキストメニュー・ショートカット・別タブ遷移）も併せて塞ぐ。
  // -------------------------------------------------------------------

  // 4-1. コンテキストメニュー（右クリック・タッチの「長押し」）
  //      Chromium のコンテキストメニューには「戻る」「進む」「再読み込み」
  //      「名前を付けて保存」「印刷」「リンクを新しいタブで開く」等があり、
  //      タッチキオスクでは長押し一つで開いてしまう。
  //      メニュー自体を出さないことが確実な対策。
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); }, true);

  // 4-2. テキスト選択・ドラッグの抑止
  //      -sel をドラッグして別タブへ持ち出す経路と、
  //      文字列の選択状態からコンテキストメニューを開く経路を塞ぐ。
  ['selectstart', 'dragstart'].forEach((evt) => {
    document.addEventListener(evt, (e) => { e.preventDefault(); }, true);
  });

  // 4-3. ファイル/URL のドロップ抑止
  //      デスクトップやファイルマネージャーからウィンドウへファイルを
  //      投げると、Chromium がそれを開いて別のページとして表示してしまう。
  ['dragover', 'drop'].forEach((evt) => {
    document.addEventListener(evt, (e) => { e.preventDefault(); }, true);
  });

  // 4-4. 新規ウィンドウ・外部ページへの遷移抑止
  //      window.open と target="_blank" を無効化する。
  //      Chromium ポリシーの URLBlocklist 側でも封じているが、
  //      about:blank などの特殊スキームにはポリシーが効かないため二重で塞ぐ。
  window.open = function () { return null; };
  document.addEventListener('click', (e) => {
    const anchor = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!anchor) return;
    const target = anchor.getAttribute('target');
    if (target && target !== '_self') {
      e.preventDefault();
      return;
    }
    const href = anchor.getAttribute('href') || '';
    // javascript: や data: など、ページ内だけで実行されるスキームは止める。
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) {
      e.preventDefault();
    }
  }, true);

  // 4-5. Chromium 内部ショートカット（DevTools・新規タブ・全画面解除など）
  //      OS側のショートカットを無効にしても、Chromium が自前で処理する
  //      ショートカットは有効です。ここではキー入力自体を奪うのではなく、
  //      該当キーの既定動作だけを止める（入力欄の文字入力は妨げない）。
  const _BLOCKED_KEYS = new Set([
    'F5', 'F11', 'F12',                      // 再読み込み・全画面・DevTools
    'PrintScreen',                           // 画面キャプチャ
  ]);
  document.addEventListener('keydown', (e) => {
    if (_BLOCKED_KEYS.has(e.key)) {
      e.preventDefault();
      return;
    }
    // Ctrl / Cmd + (T W N L D O S P J I C ...) のうち、
    // ページ移動・閲覧履歴・DevTools に関わる組み合わせを止める。
    const accel = e.ctrlKey || e.metaKey;
    if (!accel) return;
    const k = (e.key || '').toLowerCase();
    // 新規タブ・新規ウィンドウ・履歴・ブックマーク・ファイルを開く・印刷・
    // ダウンロード・ソース表示。単独の Ctrl/Cmd 押下で発火する。
    // Ctrl+C / Ctrl+X / Ctrl+V（コピー・切り取り・貼り付け）は
    // 管理者画面の入力欄で使う可能性があるため、ここでは止めない。
    if (['t', 'n', 'w', 'l', 'd', 'o', 's', 'p', 'j', 'h', 'u'].indexOf(k) !== -1) {
      e.preventDefault();
      return;
    }
    // 開発者ツール（Ctrl+Shift+I / J / C）と
    // 閉じたタブの復元・ウィンドウを閉じる（Ctrl+Shift+T / N / W / Q）。
    if (e.shiftKey && ['i', 'j', 'c', 't', 'n', 'w', 'q'].indexOf(k) !== -1) {
      e.preventDefault();
    }
  }, true);

  // 4-6. 「キオスクの画面にいる」ことの継続的な保証
  //      ブラウザ側の履歴ナビゲーション（back/forward）や外部リンクは、
  //      上記の抑止でも稀に通り抜ける（Android の
  //      edge-swipe など、DOM イベントを介さずブラウザプロセスが
  //      実行する経路）。そのため、独立した経路として自前の監視を置く。
  //
  //      方針: このスクリプトが読み込まれたときの origin と、
  //      キオスクとして許容するパスだけを有効とし、それ以外の
  //      場所に一度でも留まっていた場合は即座にキオスクへ戻す。
  //      同一オリジン( admin.html )は仕様どおり許可する。
  const KIOSK_ORIGIN = location.origin;
  const KIOSK_PATHS = ['/', '/index.html', '/admin.html'];
  // file:// で開かれた場合、location.origin は "null" という文字列になる。
  // その状態では復帰先の URL を組み立てられないため、監視自体を止める。
  const _originUsable = !!KIOSK_ORIGIN && KIOSK_ORIGIN !== 'null';
  const _isKioskLocation = () => (
    _originUsable &&
    location.origin === KIOSK_ORIGIN &&
    KIOSK_PATHS.indexOf(location.pathname) !== -1
  );
  const _returnToKiosk = () => {
    if (!_originUsable || _isKioskLocation()) return;
    try {
      location.replace(KIOSK_ORIGIN + '/');
    } catch (_) {
      try { location.href = KIOSK_ORIGIN + '/'; } catch (__) { /* 差し替え不可 */ }
    }
  };
  // bfcache（戻る／進むからの復帰）やプロセスリスタート復帰でも
  // 判定を1度走らせる。
  window.addEventListener('pageshow', _returnToKiosk);
  window.addEventListener('popstate', _returnToKiosk);
  // 定期監視。1秒間隔でも十分（脱出してから戻るまでの露出は1秒未満）。
  setInterval(_returnToKiosk, 1000);
})();
