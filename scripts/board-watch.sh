#!/bin/bash
# ============================================================================
# 端末貸出管理システム: サブモニター（貸出状況ボード）自動検出デーモン
#
# 目的:
#   HDMI等で2台目のディスプレイ（拡張ディスプレイ）が接続されたら、
#   そのディスプレイにだけ board.html（貸出状況ボード＝管理者向けの
#   閲覧専用スライドショー画面）を自動でキオスク表示する。
#   接続が外れたら、そのウィンドウだけを自動で閉じる。
#
#   生徒側の貸出・返却キオスク（kiosk-autostart.sh が開く index.html）や
#   管理画面には一切関与しない。あくまで「もう1画面あれば便利」という
#   補助的な表示で、この画面が無くてもシステムの動作に影響はない。
#
# 起動経路:
#   install.sh の「サブモニター表示の自動検出」項目を選ぶと、
#   ~/.config/autostart/device-lending-board.desktop 経由でログイン時に
#   自動起動される（常駐）。手動で今すぐ試したい場合は
#     ./scripts/board-watch.sh &
#   のようにバックグラウンドで実行すればよい。
#
# 仕組み:
#   xrandr --query を定期的に見て、「接続中かつ有効なモードを持つ出力」の
#   うち、キオスク（メイン）画面ではないものを「サブモニター」とみなす。
#   メイン画面の判定は、xrandr の primary フラグを最優先し、
#   無ければ最初に見つかった接続中の出力をメインとみなす
#   （＝この端末を最初にセットアップした時にキオスクを表示している方）。
# ============================================================================
set -u

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
source "${PROJECT_DIR}/scripts/ui-lib.sh"

mkdir -p "${PROJECT_DIR}/logs"
LOG_FILE="${PROJECT_DIR}/logs/board-watch.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

if ! command -v xrandr >/dev/null 2>&1; then
  log "xrandrが見つかりません。サブモニター自動検出を終了します（x11-xserver-utils を導入してください）"
  exit 1
fi

# --- 設定読み込み（サーバーのポート番号） ---
if [ -f "${PROJECT_DIR}/config.env" ]; then
  set -a
  source "${PROJECT_DIR}/config.env"
  set +a
fi
PORT="${PORT:-3000}"
BOARD_URL="http://localhost:${PORT}/board.html"

# ボード専用のブラウザプロファイル（生徒側キオスクや普段使いのブラウザとは
# 完全に分離する。uninstall.sh でこのディレクトリごと削除される）。
PROFILE_DIR="${HOME}/.config/device-lending-board-profile"

POLL_INTERVAL_SEC=3
# サーバー起動待ち（初回ログイン直後はサーバーがまだ立ち上がっていない可能性がある）
SERVER_WAIT_MAX_SEC=60

BROWSER_BIN=""
for b in chromium chromium-browser; do
  if command -v "$b" >/dev/null 2>&1; then
    BROWSER_BIN="$b"
    break
  fi
done
if [ -z "$BROWSER_BIN" ]; then
  # ここで何も表示せずログだけに書いて終了すると、メインのキオスク画面は
  # 正常に動いているため「サブモニター機能自体が無効になっている」ことに
  # 誰も気づけない（実際に、Firefoxが標準導入済みのLinux Mintでは
  # install.shの汎用ブラウザチェックがFirefoxで満足してしまいChromiumが
  # 入らないままになるケースがあった）。デスクトップ通知で目立たせる。
  log "Chromiumが見つかりません。サブモニター自動検出を終了します"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "端末貸出管理システム" \
      "サブモニター表示にはChromiumが必要です。'sudo apt install chromium' を実行し、再ログインしてください" \
      2>/dev/null || true
  fi
  exit 1
fi

source "${PROJECT_DIR}/scripts/lib-kiosk-browser-args.sh"

log "サブモニター自動検出を開始しました（監視間隔 ${POLL_INTERVAL_SEC}秒）"

_board_pid=""
_board_output=""

# ----------------------------------------------------------------------
# xrandr の出力一覧から「接続中かつ有効なモードを持つ」出力名と
# そのジオメトリ（WxH+X+Y）、primaryフラグの有無を1行ずつ返す。
#   例の出力行: "HDMI-1 connected primary 1920x1080+0+0 ..."
#              "HDMI-2 connected 1920x1080+1920+0 ..."
# ----------------------------------------------------------------------
list_active_outputs() {
  xrandr --query 2>/dev/null | awk '
    /^[A-Za-z0-9_-]+ connected/ {
      name = $1
      is_primary = ($3 == "primary") ? 1 : 0
      geom = ""
      for (i = 3; i <= NF; i++) {
        if ($i ~ /^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+$/) { geom = $i; break }
      }
      if (geom != "") print name "\t" is_primary "\t" geom
    }
  '
}

# メイン（キオスク）画面の出力名を決める: primaryフラグ優先、無ければ最初の1つ
pick_main_output() {
  local outputs="$1"
  local main
  main=$(echo "$outputs" | awk -F'\t' '$2 == 1 { print $1; exit }')
  if [ -z "$main" ]; then
    main=$(echo "$outputs" | head -n1 | cut -f1)
  fi
  echo "$main"
}

# メイン以外で最初に見つかった接続中の出力＝サブモニター候補
pick_sub_output() {
  local outputs="$1" main="$2"
  echo "$outputs" | awk -F'\t' -v main="$main" '$1 != main { print $0; exit }'
}

is_board_alive() {
  [ -n "$_board_pid" ] && kill -0 "$_board_pid" 2>/dev/null
}

close_board() {
  if is_board_alive; then
    log "サブモニター（${_board_output}）が切断されたため、ボード画面を閉じます（PID ${_board_pid}）"
    kill -TERM "$_board_pid" 2>/dev/null || true
    for _ in 1 2 3 4; do
      kill -0 "$_board_pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$_board_pid" 2>/dev/null || true
  fi
  _board_pid=""
  _board_output=""
}

open_board_on() {
  local output="$1" geom="$2"
  local w h x y
  w=$(echo "$geom" | sed -E 's/^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/\1/')
  h=$(echo "$geom" | sed -E 's/^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/\2/')
  x=$(echo "$geom" | sed -E 's/^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/\3/')
  y=$(echo "$geom" | sed -E 's/^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/\4/')

  # サーバー起動待ち（最大 SERVER_WAIT_MAX_SEC 秒）。
  local waited=0 ready=0
  while [ "$waited" -lt "$SERVER_WAIT_MAX_SEC" ]; do
    if curl -s -o /dev/null -m 1 "http://localhost:${PORT}/"; then
      ready=1
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$ready" -ne 1 ]; then
    log "サーバーの応答が確認できませんでした（${SERVER_WAIT_MAX_SEC}秒待機）。表示は試みます"
  fi

  mkdir -p "$PROFILE_DIR"
  log "サブモニター（${output}, ${geom}）を検出。ボード画面を表示します"

  # 実装メモ:
  #   --kiosk と --window-position/--window-size を同時に指定すると、環境に
  #   よっては「起動時点でフルスクリーン化」の要求が座標指定より優先されて
  #   しまい、指定した拡張ディスプレイ側ではなくメイン側でフルスクリーンに
  #   なってしまうことがある（拡張ディスプレイ自体は正しく拡張されるのに、
  #   ボード画面はそこに現れないように見える不具合の原因）。
  #   そのため、ここでは --kiosk を使わず、まず指定位置・指定サイズの通常
  #   ウィンドウとして開き（--class で専用のWM_CLASSを付けて後から確実に
  #   このウィンドウだけを見つけられるようにする）、実際にそのモニター上へ
  #   配置されたのを確認してから、xdotoolでF11（Chromium自身のフルスクリーン
  #   切り替え）を送ってその場でフルスクリーン化する。
  "$BROWSER_BIN" \
    "${KIOSK_CHROME_ARGS_NO_KIOSK[@]}" \
    --class="DeviceLendingBoard" \
    --user-data-dir="$PROFILE_DIR" \
    --window-position="${x},${y}" \
    --window-size="${w},${h}" \
    --app="$BOARD_URL" \
    >> "${PROJECT_DIR}/logs/board-watch.log" 2>&1 &
  _board_pid=$!
  _board_output="$output"
  log "ボード画面を起動しました（PID ${_board_pid}）"

  if command -v xdotool >/dev/null 2>&1 && command -v wmctrl >/dev/null 2>&1; then
    (
      local tries=0 winid=""
      while [ "$tries" -lt 20 ]; do
        winid="$(xdotool search --class "DeviceLendingBoard" 2>/dev/null | tail -n1)"
        if [ -n "$winid" ]; then
          # ウィンドウ配置が実際に反映されるのを少し待ってから、
          # ウィンドウマネージャ標準のEWMHプロトコル（_NET_WM_STATE_FULLSCREEN）
          # でフルスクリーン化する。すでに拡張ディスプレイ側へ配置された
          # "その場" でフルスクリーンになるため、--kiosk使用時のように
          # メイン側へ飛んでしまうことがない。
          sleep 0.5
          xdotool windowactivate --sync "$winid" 2>/dev/null || true
          wmctrl -i -r "$winid" -b add,fullscreen 2>/dev/null || true

          # EWMHでのフルスクリーン化がウィンドウマネージャによっては
          # 反映されないケースがあるため、確認してから必要ならF11
          # （Chromium自身のフルスクリーン切り替えショートカット）を
          # フォールバックとして送る。本キオスク画面（--kiosk起動）と
          # 見た目を完全に揃えるための保険。
          sleep 0.4
          local _state=""
          _state="$(wmctrl -l -G 2>/dev/null | awk -v id="$winid" '$1==id')"
          if command -v xprop >/dev/null 2>&1; then
            if ! xprop -id "$winid" _NET_WM_STATE 2>/dev/null | grep -q "_NET_WM_STATE_FULLSCREEN"; then
              xdotool key --window "$winid" F11 2>/dev/null || true
              log "EWMHフルスクリーン化を確認できなかったため、F11を送信しました（ウィンドウ ${winid}）"
            fi
          fi
          log "ボード画面を拡張ディスプレイ（${output}）上でフルスクリーン化しました"
          break
        fi
        sleep 0.3
        tries=$((tries + 1))
      done
      if [ -z "$winid" ]; then
        log "ボード画面のウィンドウが見つからず、フルスクリーン化できませんでした"
      fi
    ) &
  else
    log "xdotool/wmctrlが見つかりません（sudo apt install xdotool wmctrl 推奨）。フルスクリーン化・配置の確実性が下がります"
  fi
}

# ----------------------------------------------------------------------
# ボード画面が生きている間、定期的にフルスクリーン状態を保証する。
# ウィンドウマネージャやディスプレイ設定変更の影響で、まれにフルスクリーンが
# 解除されてしまうケース（タスクバーが復活する等）へのセルフヒーリング。
# ----------------------------------------------------------------------
ensure_board_fullscreen() {
  command -v xdotool >/dev/null 2>&1 || return 0
  command -v wmctrl >/dev/null 2>&1 || return 0
  is_board_alive || return 0
  local winid
  winid="$(xdotool search --class "DeviceLendingBoard" 2>/dev/null | tail -n1)"
  [ -n "$winid" ] || return 0
  if command -v xprop >/dev/null 2>&1; then
    if ! xprop -id "$winid" _NET_WM_STATE 2>/dev/null | grep -q "_NET_WM_STATE_FULLSCREEN"; then
      wmctrl -i -r "$winid" -b add,fullscreen 2>/dev/null || true
      log "ボード画面のフルスクリーンが解除されていたため再適用しました（ウィンドウ ${winid}）"
    fi
  fi
}

# 画面がスリープ/スクリーンセーバーで消えないようにする
xset s off -dpms 2>/dev/null || true

# ----------------------------------------------------------------------
# メインループ
# ----------------------------------------------------------------------
trap 'close_board; log "サブモニター自動検出を終了します"; exit 0' TERM INT

while :; do
  outputs="$(list_active_outputs)"

  if [ -z "$outputs" ]; then
    sleep "$POLL_INTERVAL_SEC"
    continue
  fi

  main_output="$(pick_main_output "$outputs")"
  sub_line="$(pick_sub_output "$outputs" "$main_output")"

  if [ -z "$sub_line" ]; then
    # サブモニターなし。もし表示中なら閉じる
    if is_board_alive; then
      close_board
    fi
    sleep "$POLL_INTERVAL_SEC"
    continue
  fi

  sub_output="$(echo "$sub_line" | cut -f1)"
  sub_geom="$(echo "$sub_line" | cut -f3)"

  if is_board_alive; then
    if [ "$_board_output" != "$sub_output" ]; then
      # サブモニターが別の出力に切り替わった（配線し直した等）→ 開き直す
      close_board
      open_board_on "$sub_output" "$sub_geom"
    else
      # 表示中のまま＝定期的にフルスクリーン状態を保証する（セルフヒーリング）
      ensure_board_fullscreen
    fi
    # プロセスが死んでいないか（クラッシュ等）を確認
    if ! is_board_alive; then
      _board_pid=""
      _board_output=""
    fi
  else
    open_board_on "$sub_output" "$sub_geom"
  fi

  sleep "$POLL_INTERVAL_SEC"
done
