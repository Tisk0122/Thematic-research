#!/bin/bash
# 端末貸出管理システム: キオスク画面（Chromium --kiosk ウィンドウ）を閉じる
#
# Chromium を --kiosk モードで起動している場合、ページ側の JavaScript
# （HTML5 Fullscreen API）からはウィンドウを閉じたり全画面を解除したりする
# ことが原理的にできない。そのため、このスクリプトは次の2つの経路から
# 呼び出される。
#   (1) 管理者画面の「全画面を終了」ボタン → 管理者セッション認証済みの
#       サーバー API (POST /api/kiosk/exit) 経由。サーバーが生きていることが前提。
#   (2) install.sh が登録するCinnamonのキーボードショートカット
#       （Ctrl+Alt+Shift+Q）→ OSから直接このスクリプトを実行。
#       サーバー（node server.js）がクラッシュ・フリーズして(1)が使えない
#       場合の唯一の脱出手段として用意している。
# どちらの経路でも、サーバー（node server.js）やデータは一切停止しない。
# 再表示は start.sh（デスクトップアイコン／ターミナル）または再ログインで行える。

set -u

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

# --- 設定読み込み ---
if [ -f "${PROJECT_DIR}/config.env" ]; then
  set -a; source "${PROJECT_DIR}/config.env"; set +a
fi

# ポートはサーバーから渡される環境変数/引数を最優先する
PORT="${1:-${KIOSK_EXIT_PORT:-${PORT:-3000}}}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "無効なPORT: ${PORT}" >&2
  exit 1
fi

# キオスク用ブラウザのプロセス（起動コマンドに --app=http://localhost:PORT/ を含む
# もの）を探す。普段使いの Chromium（--app 無し）や node server.js は対象外。
# 注意: pgrep -f は部分一致するため、--app=http://localhost:PORT/board.html
# （拡張ディスプレイ側のサブモニター表示。board-watch.sh が管理する別ウィンドウ）
# にも一致してしまう。この関数はあくまで「生徒側の貸出・返却キオスク画面」
# だけを終了させる想定のため、board.html を使っているプロセスは明示的に除外する。
PIDS="$(pgrep -f -- "app=http://localhost:${PORT}/" 2>/dev/null | while read -r _p; do
  _cmdline="$(tr '\0' ' ' < "/proc/${_p}/cmdline" 2>/dev/null)"
  case "$_cmdline" in
    *board.html*) continue ;;
    *) echo "$_p" ;;
  esac
done)"

if [ -z "$PIDS" ]; then
  echo "キオスク画面のプロセスは見つかりませんでした（起動されていない可能性）"
  exit 0
fi

# キオスク・スーパーバイザー（kiosk-autostart.sh）への「管理者が意図して
# 終了させた」合図。これが無い場合、スーパーバイザーはブラウザの終了を
# クラッシュとみなして自動復旧（再起動）する。
# フラグはスーパーバイザー側で消費（削除）されるため、残留しない。
touch "${PROJECT_DIR}/logs/kiosk-exit-requested.flag" 2>/dev/null || true

echo "キオスク画面を閉じます（終了対象PID: ${PIDS}）"

# まず通常終了(SIGTERM)を送る。Chromiumは SIGTERM でウィンドウを閉じて終了する
kill -TERM $PIDS 2>/dev/null || true

# 終了確認（最大2秒、終わらなければ強制終了）
for _ in 1 2 3 4; do
  _ALIVE=""
  for p in $PIDS; do
    if kill -0 "$p" 2>/dev/null; then _ALIVE="$p"; break; fi
  done
  if [ -z "$_ALIVE" ]; then
    echo "キオスク画面は正常に終了しました"
    exit 0
  fi
  sleep 0.5
done

kill -KILL $PIDS 2>/dev/null || true
echo "SIGTERM で終了しなかったため強制終了しました: ${PIDS}"
exit 0