#!/bin/bash
# systemdサービスから呼び出される起動ラッパー。
# start.sh の引数組み立てロジックと同じ内容を、GUIダイアログ等を挟まず
# 素のまま実行する(ログはsystemd側でファイルにリダイレクトされる)。
set -e
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
source "${PROJECT_DIR}/scripts/ui-lib.sh"

if [ -f "config.env" ]; then
  set -a
  source "config.env"
  set +a
fi

# systemd は StandardOutput=append: でファイルを開くが、ディレクトリは
# 作成されないため、logs/ が無いと systemctl start が失敗する
# （Restart=always のため失敗し続けてログを埋める）。保険として用意する。
mkdir -p "${PROJECT_DIR}/logs"

# --- Arduino(シリアルポート)アクセス権限の事前チェック ---
# シリアルポート(/dev/ttyACM0 /dev/ttyUSB0 等)は dialout(またはuucp) グループ
# のメンバーだけが読み書きできる。所属していないと Arduinoが接続されていても
# 「Permission denied」で開けず、アプリ上では「未接続」と表示されてしまう。
# ここで所属を確認し、未所属なら明確な警告をログに残す(install.shの手順を実行済み
# なら所属済み。初回セットアップ後はログアウト→ログインが必須)。
if [ -e /dev/ttyACM0 ] || [ -e /dev/ttyUSB0 ] || ls /dev/ttyACM* /dev/ttyUSB* >/dev/null 2>&1; then
  if ! id -nG 2>/dev/null | tr ' ' '\n' | grep -qxE 'dialout|uucp'; then
    warn "シリアルポートはありますが、現在のユーザーは dialout/uucp グループに属していません。" >&2
    warn "Arduinoが「未接続」と表示されている場合は、以下を実行してログアウト→再ログインしてください:" >&2
    warn "  sudo usermod -aG dialout \$(whoami)  (または  sudo usermod -aG uucp \$(whoami))" >&2
  fi
fi

info "サーバーを起動します (systemd管理, ポート ${PORT:-3000})"

PORT="${PORT:-3000}"
# systemdサービスからの起動でも、システム設定にかかわらず日本時間を使う。
export TZ=Asia/Tokyo
# SERIAL_PORTはconfig.envで明示指定されていない限り空のままにする。
# 空であればserver.js側がArduinoを自動検出する。
SERIAL_PORT="${SERIAL_PORT:-}"
ADMIN_PW="${ADMIN_PW:-}"

ARGS=(--port "$PORT")
if [ -n "$SERIAL_PORT" ]; then
  ARGS+=(--serial "$SERIAL_PORT")
fi
# ADMIN_PW はコマンドライン引数では渡さない(ps aux 等での露見防止)。
# config.env の source で環境変数にエクスポート済みなので、
# server.js 側の process.env.ADMIN_PW フォールバックで十分動作する。

exec node server.js "${ARGS[@]}"
