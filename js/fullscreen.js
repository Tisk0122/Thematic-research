'use strict';

/**
 * キオスク画面の自動全画面化
 * - 起動時に全画面化を試みる
 * - 全画面でない状態でのタップ/クリックをきっかけに全画面化する
 *   （ブラウザのユーザー操作要件を満たすため）
 * - 生徒画面（index.html）・管理者画面（admin.html）ともにこの端末専用の
 *   単一キオスク運用のため、原則として常時・例外なく全画面を維持する。
 *   （管理者画面から生徒画面に戻ったとき、またはその逆でも同様に維持する）
 * - 唯一の例外は、OS標準の画面キーボードでの自由入力に依存する項目
 *   （text/email/number等のinput、textarea、contenteditable要素）。
 *   フォーカス中に全画面状態の変化（リサイズ扱い）が起きると画面キーボードが
 *   閉じてしまう環境があり、それを避けるためだけに全画面化を一時的にスキップする。
 *   管理者画面には検索欄・編集フォームなど多数の入力欄があるため、
 *   個別のID指定ではなく要素の種類で汎用的に判定する。
 *   ボタン・カスタムキーパッド・ドラムロール選択などは対象外（＝全画面を妨げない）。
 * - 管理者の退避手段: 本運用は Chromium の --kiosk 起動のため、ページ側の
 *   Fullscreen API からウィンドウを解除することは原理的にできない。
 *   そのため実際の「全画面を終了」は管理者セッション認証済みのサーバー API
 *   （POST /api/kiosk/exit → exit-kiosk.sh）でキオスク用ブラウザを閉じて行う
 *   （admin.html のトップバー／ログイン画面から操作する）。閉じた画面の再表示は
 *   start.sh や再ログインで行う。
 * - Escキーなどで全画面が解除された場合も、次の操作で自動的に復帰する。
 * - タブ/ウィンドウ切り替えから戻った際（visibilitychange/focus）も復帰する。
 * - ページ遷移（生徒画面⇔管理者画面など）の直後は、ブラウザのユーザー操作要件に
 *   より自動再全画面化が失敗することがあるが、その場合も最初のタップ/クリックで
 *   即座に復帰する。
 * - F11・F12・DevTools系ショートカットなど、ページ側でpreventDefault可能な
 *   キー操作はここでブロックする（Ctrl+W/Alt+Tab等、OS/ブラウザが直接処理する
 *   ものはJSでは防げないため、別レイヤー(Chromeポリシー・WM設定・X11設定)で対処）。
 */
(function () {
  function getFullscreenElement() {
    return document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null;
  }

  function isFullscreen() {
    return !!getFullscreenElement();
  }

  // OS標準の画面キーボードでの自由入力に依存する要素かどうかを汎用的に判定する。
  // ID列挙ではなく要素の種類で判定することで、生徒画面の「お名前」欄だけでなく、
  // 管理者画面の検索欄・編集フォームなど多数の入力欄にも自動的に対応できる。
  const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'email', 'tel', 'url', 'number', 'password', 'date',
    'datetime-local', 'month', 'time', 'week'
  ]);

  function needsNativeKeyboard(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return TEXT_INPUT_TYPES.has(type) && !el.disabled && !el.readOnly;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function requestFullscreen(el) {
    el = el || document.documentElement;
    try {
      if (el.requestFullscreen) {
        const pr = el.requestFullscreen();
        if (pr && typeof pr.catch === 'function') {
          pr.then(() => { _adminWasFullscreen = true; }).catch(() => {});
        }
        return pr;
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
        _adminWasFullscreen = true;
      } else if (el.mozRequestFullScreen) {
        el.mozRequestFullScreen();
        _adminWasFullscreen = true;
      } else if (el.msRequestFullscreen) {
        el.msRequestFullscreen();
        _adminWasFullscreen = true;
      }
    } catch (_) {
      // 全画面化に失敗しても致命的ではないため握りつぶす
    }
  }

  // evt を伴う場合はイベント発生元が、伴わない場合は現在フォーカス中の要素が
  // OS標準の画面キーボードに依存する入力欄なら、キーボード表示を妨げないよう
  // 全画面化を一時的にスキップする。
  //
  // 管理者画面（data-page="admin"）では、一度全画面を解除したら以後は
  // 自動で再全画面化しない（先生が手動で全画面のまま作業する、あるいは
  // Esc等で解除した状態を維持できるようにする）。初期表示時は従来通り
  // 全画面化してから、解除は操作に委ねる。
  const pageAttr = document.body && document.body.getAttribute('data-page');
  const IS_ADMIN = pageAttr === 'admin';
  let _adminUserLeftFullscreen = false;
  let _adminWasFullscreen = false;

  function tryEnterFullscreen(evt) {
    if (isFullscreen()) return;
    // 管理者画面で、一度全画面を解除された場合は、以後自動で再入しない。
    if (IS_ADMIN && _adminUserLeftFullscreen) return;
    if (evt && needsNativeKeyboard(evt.target)) return;
    if (needsNativeKeyboard(document.activeElement)) return;
    requestFullscreen();
  }

  // 起動直後・ページ遷移直後に試みる（DOMContentLoadedの方がloadより早く、
  // 直前の操作（例: 管理者画面への遷移リンクのクリック）の余韻が残っている
  // 状態に近いタイミングで試せるため、両方で試行する）。
  document.addEventListener('DOMContentLoaded', () => tryEnterFullscreen());
  window.addEventListener('load', () => tryEnterFullscreen());
  // bfcache（戻る/進むキャッシュ）からの復元時にも試みる
  window.addEventListener('pageshow', () => tryEnterFullscreen());

  // 全画面が解除されたことを検知
  //  - キオスク画面（生徒用）: 解除されたら即座に再全画面化する
  //  - 管理者画面: 一度でも全画面を解除されたら、以後は自動再入
  //    せず、解除された状態を維持する（Escやボタンで手動解除できるようにする）
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']
    .forEach(evt => document.addEventListener(evt, () => {
      if (isFullscreen()) {
        if (IS_ADMIN) _adminWasFullscreen = true;
        return;
      }
      // 全画面が解除された
      if (IS_ADMIN) {
        _adminUserLeftFullscreen = true;
        return; // 再入しない
      }
      tryEnterFullscreen();
    }));

  // ユーザーの操作（タップ／クリック）をきっかけに全画面化する
  // （フォーム部品への操作は除外し、フォーカス・スクリーンキーボードを優先する）
  ['pointerup', 'click'].forEach(evt => {
    document.addEventListener(evt, tryEnterFullscreen, { passive: true });
  });

  // 念のため定期的にも確認するが、入力欄にフォーカスがある間はスキップする
  setInterval(() => tryEnterFullscreen(), 5000);

  // 別ウィンドウ/タブへの切り替えから戻ってきたときの復帰
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tryEnterFullscreen();
  });
  window.addEventListener('focus', () => tryEnterFullscreen());

  // --- キー操作のブロック（最後の保険） ---
  // 注意: これはあくまで「ページ内でJSが検知できる範囲」の保険に過ぎない。
  // Ctrl+W / Ctrl+N / Alt+F4 / Alt+Tab / Ctrl+Alt+F1-F6 などはブラウザや
  // OSのウィンドウマネージャが直接処理するため、Webページ側のJavaScriptでは
  // 原理的にブロックできない。これらは
  //   ・kiosk-autostart.sh の --kiosk 起動 + Chrome企業ポリシー
  //   ・Cinnamonのショートカット無効化 (install.sh)
  //   ・X11のVTスイッチ無効化 (50-kiosk-no-vtswitch.conf)
  // という別レイヤーで対処している。ここではF11・F12・DevTools系ショートカット
  // など、ページ側で preventDefault が効くものだけを対象にする。
  document.addEventListener('keydown', (e) => {
    const key = e.key;
    if (key === 'F11' || key === 'F12') {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(key.toUpperCase())) {
      e.preventDefault(); // DevTools系ショートカット
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ['u', 'p'].includes(key.toLowerCase())) {
      e.preventDefault(); // view-source / print
    }
  }, true);
})();
