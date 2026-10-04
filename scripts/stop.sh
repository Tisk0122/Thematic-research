#!/bin/bash
# 端末貸出管理システム 停止スクリプト

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

# --- 共通UIライブラリ（配色・記号・スピナー） ---
source "${PROJECT_DIR}/scripts/ui-lib.sh"

# --- 設定読み込み ---
if [ -f "config.env" ]; then
  set -a; source "config.env"; set +a
fi

PORT="${PORT:-3000}"

# --- PIDファイル ---
PID_FILE="${PROJECT_DIR}/logs/server.pid"
LOCK_FILE="${PROJECT_DIR}/logs/server.lock"

# --- ヘッダー ---
ui_header "端末貸出管理システム" "停止中…"
echo ""

# ============================================================================
# キオスク画面・サブモニター（拡張ディスプレイ）画面を自動で閉じる
#
# 以前はサーバープロセスだけを停止し、キオスク用ブラウザや拡張ディスプレイの
# ボード画面はそのまま画面に残り続けていた（サーバーが止まっているのに
# ブラウザだけ表示され続け、エラー表示のまま固まって見える状態）。
# 停止操作をしたら画面もまとめて閉じるようにし、見た目にも分かりやすくする。
# ============================================================================
close_kiosk_windows() {
  # 1. 生徒側の貸出・返却キオスク画面（index.html を --app= で開いているプロセス）
  #    pgrep -f は部分一致するため、board.html（拡張ディスプレイ用の別ウィンドウ）
  #    を巻き込まないよう明示的に除外する。
  local _kiosk_pids="" _p _cmdline
  for _p in $(pgrep -f -- "app=http://localhost:${PORT}/" 2>/dev/null); do
    _cmdline="$(tr '\0' ' ' < "/proc/${_p}/cmdline" 2>/dev/null)"
    case "$_cmdline" in
      *board.html*) continue ;;
      *) _kiosk_pids="${_kiosk_pids} ${_p}" ;;
    esac
  done
  _kiosk_pids="${_kiosk_pids# }"

  if [ -n "$_kiosk_pids" ]; then
    info "キオスク画面を閉じています..."
    kill -TERM $_kiosk_pids 2>/dev/null || true
    for _ in 1 2 3 4; do
      local _alive=""
      for _p in $_kiosk_pids; do kill -0 "$_p" 2>/dev/null && _alive=1 && break; done
      [ -z "$_alive" ] && break
      sleep 0.5
    done
    kill -KILL $_kiosk_pids 2>/dev/null || true
    success "キオスク画面を閉じました"
  fi

  # 2. サブモニター（拡張ディスプレイ）に表示中のボード画面（board.html）の
  #    ブラウザプロセスだけを閉じる。
  #    board-watch.sh 監視デーモン自体はここでは止めない
  #    （ログイン時自動起動の常駐プロセスであり、「サーバーを停止する」操作の
  #    たびに監視まで止めてしまうと、次にサブモニターを挿し直しても自動検出が
  #    働かなくなってしまうため）。サーバーが止まっている間はボード画面自体が
  #    表示するデータを取得できないので、監視は動いたままでも実害はなく、
  #    再度 start すれば自然にボード画面も復帰する。
  local _board_browser_pids
  _board_browser_pids="$(pgrep -f -- "--user-data-dir=${HOME}/.config/device-lending-board-profile" 2>/dev/null || true)"

  if [ -n "$_board_browser_pids" ]; then
    info "サブモニター（拡張ディスプレイ）表示を閉じています..."
    kill -TERM $_board_browser_pids 2>/dev/null || true
    for _ in 1 2 3 4; do
      local _alive=""
      for _p in $_board_browser_pids; do
        kill -0 "$_p" 2>/dev/null && _alive=1 && break
      done
      [ -z "$_alive" ] && break
      sleep 0.5
    done
    kill -KILL $_board_browser_pids 2>/dev/null || true
    success "サブモニター表示を閉じました"
  fi
}

close_kiosk_windows
echo ""

# --- PORT の検証 ---
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  error "無効なポート番号: ${PORT}"
  exit 1
fi

# --- systemdサービスが登録されていればそちらを停止 ---
if command -v systemctl >/dev/null 2>&1 \
   && systemctl --user list-unit-files device-lending-system.service >/dev/null 2>&1; then
  if systemctl --user is-active --quiet device-lending-system.service; then
    warn "systemdサービスを停止します"
    systemctl --user stop device-lending-system.service
    success "サーバーを停止しました"
  else
    info "起動中のサーバーは見つかりませんでした（ポート ${PORT}）"
  fi
  rm -f "$PID_FILE" "$LOCK_FILE"
  echo ""
  exit 0
fi

# --- プロセス検索（systemd未使用の場合のフォールバック） ---
PIDS=""

# 1. PIDファイルから確認
if [ -f "$PID_FILE" ]; then
  _PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$_PID" ] && kill -0 "$_PID" 2>/dev/null; then
    PIDS="$_PID"
  else
    rm -f "$PID_FILE"
  fi
fi

# 2. プロセス検索でフォールバック
if [ -z "$PIDS" ]; then
  PIDS=$(pgrep -f "node .*server\.js.*--port $PORT" 2>/dev/null || true)
fi

if [ -z "$PIDS" ]; then
  info "起動中のサーバーは見つかりませんでした（ポート ${PORT}）"
  rm -f "$PID_FILE" "$LOCK_FILE"
  echo ""
  exit 0
fi

warn "以下のプロセスを停止します: PID ${PIDS}"
info "ポート: ${PORT}"

# --- 停止 ---
kill $PIDS 2>/dev/null

# --- 停止確認（最大5秒） ---
for i in $(seq 1 10); do
  if ! kill -0 $PIDS 2>/dev/null; then
    break
  fi
  ui_spin_line "停止を待っています" "$((i / 2))" "$i"
  sleep 0.5
done
ui_spin_clear

# --- 結果 ---
if kill -0 $PIDS 2>/dev/null; then
  warn "プロセスがまだ生きています。強制終了します..."
  kill -9 $PIDS 2>/dev/null
  sleep 0.5
fi

if ! kill -0 $PIDS 2>/dev/null; then
  success "サーバーを停止しました"
  rm -f "$PID_FILE" "$LOCK_FILE"
else
  error "サーバーの停止に失敗しました: PID ${PIDS}"
  exit 1
fi

echo ""
