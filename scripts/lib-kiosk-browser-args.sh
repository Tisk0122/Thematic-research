#!/bin/bash
# 端末貸出管理システム: Chrome/Chromiumをキオスク（全画面・操作制限）モードで
# 起動する際の共通オプション。
#
# kiosk-autostart.sh（ログイン時の自動起動）と start.sh（デスクトップアイコン／
# ターミナルからの手動起動）の両方から source して使う。
# 2箇所に別々にフラグを書くと片方だけ更新し忘れて挙動がずれる
# （＝手動起動だけ全画面にならない、等）事故が起きるため、ここに一本化する。
# 注意: 以前ここには --use-fake-ui-for-media-stream を含めていたが、これは
# Chromium側で「危険なコマンドラインフラグ」として明示的に警告対象に
# 登録されているフラグで、付与すると常に
#   「サポートされていないコマンドラインフラグ --use-fake-ui-for-media-stream
#    を使用しています。これにより、安全性とセキュリティが損なわれます。」
# という警告バーが（カメラを一切使わない拡張ディスプレイ側の画面を含め、
# このフラグを付けて起動した全てのウィンドウに）毎回表示されてしまっていた。
# カメラ/マイクの許可ダイアログをキオスク環境で自動許可したいだけであれば、
# 代わりに scripts/templates/kiosk-policy.json.template の
# VideoCaptureAllowedUrls / AudioCaptureAllowedUrls という
# Chromiumの企業向け管理者ポリシーで、このアプリのURLに対してのみ
# 許可することができる。こちらは正式にサポートされた仕組みのため、
# 警告バーは出ず、かつフラグのように「常に全サイトで自動許可」される
# 訳でもないためより安全（このアプリ以外のURLでは通常通り許可を求める）。
KIOSK_CHROME_ARGS=(
  --kiosk
  --noerrdialogs
  --disable-infobars
  --disable-session-crashed-bubble
  --disable-pinch
  --overscroll-history-navigation=0
  --autoplay-policy=no-user-gesture-required
  --disable-dev-tools
  --disable-translate
  # TouchpadOverscrollHistoryNavigation は Chromium 内部の
  # 「画面端からのスワイプで履歴を移動する」機能(features)である。
  # --overscroll-history-navigation=0 と同じ効果を feature 側からも
  # どちらかが効かない環境があっても、もう一方が効いて履歴ナビが起きるのを防ぐ。
  --disable-features=TranslateUI,TouchpadOverscrollHistoryNavigation
  --disable-component-update
  --no-first-run
)

# --kiosk を除いたもの。board-watch.sh（拡張ディスプレイへの表示）専用。
# --kiosk は「起動時点でフルスクリーン化」をウィンドウマネージャに要求するが、
# 環境によってはこの要求が --window-position/--window-size より優先されて
# しまい、指定した拡張ディスプレイではなくメイン（プライマリ）側でフル
# スクリーン化されてしまうことがある（＝拡張ディスプレイ自体は正しく拡張
# 表示になるのに、ボード画面はそこに現れない）。そのため board-watch.sh では
# 一旦 --kiosk 無しで指定位置・指定サイズのウィンドウとして開き、実際に
# そのモニター上へ配置されたのを確認してから、xdotoolでF11相当のフル
# スクリーン切り替えを送ってその場でフルスクリーン化する2段階方式を取る。
# KIOSK_CHROME_ARGS 本体を直接編集すれば、こちらにも自動的に反映される。
KIOSK_CHROME_ARGS_NO_KIOSK=()
for _kiosk_arg in "${KIOSK_CHROME_ARGS[@]}"; do
  [ "$_kiosk_arg" = "--kiosk" ] && continue
  KIOSK_CHROME_ARGS_NO_KIOSK+=("$_kiosk_arg")
done
unset _kiosk_arg

# ---------------------------------------------------------------------------
# 起動直前に「画面端スワイプでの履歴ナビ」を念のため二重で封じる
# ---------------------------------------------------------------------------
# Chromium の「画面端をスワイプすると前ページ/次ページへ移動する」機能は、
# ブラウザプロセス側で処理されるため、Web ページの preventDefault() では
# 原理的に止められない。第一防衛線は
#   --overscroll-history-navigation=0
# だが、これはコマンドライン引数であるため、
#   - (1) 他の起動経路(start.sh 等)で引数が落ちる
#   - (2) Chromium 側が未知の/管理外の引数として無視する
# のいずれかで静かに失効しうる。
# そこで、同じ設定をプロファイル(Preferences)にも書き込んでおく。
#   overscroll_history_navigation = 0
# 引数が失効してもこちらは効くため、二重で塞げる。
#
# 呼び出し例:
#   kiosk_prepare_overscroll_pref "$HOME/.config/chromium"
#   kiosk_prepare_overscroll_pref "$HOME/.config/google-chrome"
# 失敗してもキオスク起動自体は止めない（常に終了コード0）。
kiosk_prepare_overscroll_pref() {
  local user_data_dir="${1:-}"
  [ -n "$user_data_dir" ] || return 0
  local prefs="${user_data_dir}/Default/Preferences"

  # python3 が使える場合は JSON を壊さずに UPSERT する。
  if command -v python3 >/dev/null 2>&1; then
    mkdir -p "${user_data_dir}/Default" 2>/dev/null || return 0
    [ -f "$prefs" ] && { [ -f "${prefs}.kiosk.bak" ] || cp -p "$prefs" "${prefs}.kiosk.bak" 2>/dev/null; }
    python3 - "$prefs" <<'PYEOF' >/dev/null 2>&1 && return 0
import json, os, sys
path = sys.argv[1]
data = {}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        data = {}
if not isinstance(data, dict):
    data = {}
data["overscroll_history_navigation"] = 0
tmp = path + ".kiosk.tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh)
os.replace(tmp, path)
PYEOF
  fi

  # python3 が無い環境向けの簡易 UPSERT。
  # 既存 JSON を丸ごと壊さないよう、キーは文字列で完全一致させて置換する。
  mkdir -p "${user_data_dir}/Default" 2>/dev/null || return 0
  if [ -f "$prefs" ] && grep -q '"overscroll_history_navigation"[[:space:]]*:' "$prefs" 2>/dev/null; then
    sed -i 's/"overscroll_history_navigation"[[:space:]]*:[[:space:]]*\(true\|false\)/"overscroll_history_navigation":0/g' "$prefs" 2>/dev/null || true
  else
    if [ ! -f "$prefs" ]; then
      printf '{"overscroll_history_navigation":0}' > "$prefs" 2>/dev/null || true
    else
      sed -i "1s/^{/{\"overscroll_history_navigation\":0,/" "$prefs" 2>/dev/null || true
    fi
  fi
  return 0
}

# 起動した Chromium に「画面端スワイプ抑止」の引数が本当に乗っているかを
# 後から確認するための補助。使う側は kiosk-autostart.sh。
# 戻り値: 0 = 乗っている / 1 = 乗っていない（要調査）
kiosk_verify_overscroll_flag() {
  local pid="${1:-0}"
  [ "$pid" -gt 1 ] || return 1
  tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null \
    | grep -q -- '--overscroll-history-navigation=0'
}
