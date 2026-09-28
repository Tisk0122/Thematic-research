#!/bin/bash
# 端末貸出管理システム 起動スクリプト（Linux Mint 実機用）
set -e
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

# --- 共通UIライブラリ（配色・記号・スピナー） ---
source "${PROJECT_DIR}/scripts/ui-lib.sh"

# --- 引数解析（起動モードの指定） ---
NOBROWSER=0
FOREGROUND=0
usage() {
  cat <<'USAGE'
使い方: ./start.sh [オプション]
  （何も指定しない場合: ターミナル上で起動モードを対話式に選択できます）

  --no-browser     サーバーは起動するがブラウザを開かない
  --foreground     サーバーを前面で実行しログをライブ表示（開発用。Ctrl+Cで終了）
  -h, --help       このヘルプを表示
USAGE
}
for _arg in "$@"; do
  case "$_arg" in
    --no-browser|--headless) NOBROWSER=1 ;;
    --foreground|--dev) FOREGROUND=1 ;;
    -h|--help) usage; exit 0 ;;
    *) warn "不明なオプションです（無視します）: ${_arg}" ;;
  esac
done

# --- アプリアイコン（Terminal=false）から起動した場合、この端末の出力は
#     誰にも見えない。失敗時にターミナル/ログを開かなくても分かるように、
#     画面にダイアログを出す。zenity が無ければ自動で入れておく想定
#     （install.sh 側）だが、無い場合は notify-send → 最終手段としてブラウザで
#     エラー内容を直接開く、の順にフォールバックする。
#     一方、ターミナルで直接実行している場合（人が画面を見ている場合）は、
#     ターミナルの表示で十分伝わるため、二重にダイアログを出さない。 ---
_DIALOG_TOOL=""
if [ -t 1 ]; then
  # 対話的なターミナルから実行されている＝出力は人に見えているので、
  # ポップアップダイアログは出さない。
  :
elif command -v zenity >/dev/null 2>&1; then
  _DIALOG_TOOL="zenity"
elif command -v kdialog >/dev/null 2>&1; then
  _DIALOG_TOOL="kdialog"
fi

show_fail_dialog() {
  # 対話的ターミナルで実行している場合は、ターミナル上のエラー表示で
  # 十分伝わるため、ポップアップやブラウザでの二重通知はしない。
  if [ -t 1 ]; then
    return 0
  fi
  local title="$1"
  local body="$2"
  case "$_DIALOG_TOOL" in
    zenity)
      zenity --error --title="${title}" --text="${body}" --width=480 2>/dev/null &
      ;;
    kdialog)
      kdialog --title "${title}" --error "${body}" 2>/dev/null &
      ;;
    *)
      if command -v notify-send >/dev/null 2>&1; then
        notify-send -u critical "${title}" "${body}" 2>/dev/null || true
      fi
      # notify-send は数秒で消えて見逃しやすいため、最終手段として
      # エラー内容そのものをブラウザ画面に直接表示する（ログを開かなくて済む）。
      local errhtml="${PROJECT_DIR}/logs/last-start-error.html"
      mkdir -p "${PROJECT_DIR}/logs"
      {
        echo "<!doctype html><meta charset=\"utf-8\">"
        echo "<title>${title}</title>"
        echo "<body style=\"font-family:sans-serif;background:#1e293b;color:#f1f5f9;padding:40px;white-space:pre-wrap;line-height:1.6\">"
        echo "<h1 style=\"color:#f87171\">${title}</h1>"
        echo "<pre>${body}</pre>"
        echo "</body>"
      } > "${errhtml}"
      for bin in xdg-open google-chrome google-chrome-stable chromium-browser chromium; do
        command -v "$bin" >/dev/null 2>&1 || continue
        nohup "$bin" "${errhtml}" >/dev/null 2>&1 & disown
        break
      done
      ;;
  esac
}

# 失敗時、ログを手で開かなくて良いように、直近のログを要約してダイアログに含める
fail_with_log() {
  local title="$1"
  local extra_msg="$2"
  local tail_log=""
  if [ -f "logs/launcher.log" ]; then
    tail_log="$(tail -n 25 logs/launcher.log 2>/dev/null)"
  fi
  local body="${extra_msg}"
  if [ -n "$tail_log" ]; then
    body="${body}

--- 直近のログ（logs/launcher.log） ---
${tail_log}"
  fi
  show_fail_dialog "端末貸出管理システム - 起動エラー" "${body}"
}

# ERR トラップ: set -e でスクリプトが途中終了した場合も、無言で終わらず必ず
# 画面に何か表示する（原因不明の失敗を潰さないための最終防衛ライン）。
_on_unexpected_error() {
  local exit_code=$?
  fail_with_log "予期しないエラーで起動に失敗しました" "起動処理が途中で失敗しました（終了コード: ${exit_code}）。"
}
trap _on_unexpected_error ERR

# --- ユーティリティ関数 ---
# info/success/warn は ui-lib.sh の共通定義をそのまま使う。
# error() だけは、アイコン起動（Terminal=false）で誰にも見えないターミナル
# 出力を補うため、画面ダイアログも併せて出すようここで上書きする。
print_header() {
  ui_header "端末貸出管理システム" "起動中…"
}

error() {
  echo -e "  ${C_RED}${I_ERR}${C_RESET} ${C_RED}$1${C_RESET}" >&2
  fail_with_log "端末貸出管理システム - 起動エラー" "$1"
}

# --- PIDファイル管理 ---
PID_FILE="${PROJECT_DIR}/logs/server.pid"
LOCK_FILE="${PROJECT_DIR}/logs/server.lock"

cleanup_lock() {
  rm -f "$LOCK_FILE"
}

# 既存サーバーのPIDを取得（PIDファイル or プロセス検索）
get_server_pid() {
  # 1. PIDファイルから確認
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    # PIDファイルが古い場合は削除
    rm -f "$PID_FILE"
  fi
  # 2. プロセス検索でフォールバック
  pgrep -f "node .*server\.js.*--port ${PORT}" 2>/dev/null | head -1
}

# サーバーが起動中か確認
is_server_running() {
  if curl -s "http://localhost:${PORT}/" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# --- 事前チェック ---
if [ ! -f "${PROJECT_DIR}/server.js" ]; then
  error "server.js が見つかりません"
  info "プロジェクトフォルダが正しく設定されているか確認してください"
  exit 1
fi

# --- 設定読み込み ---
if [ -f "config.env" ]; then
  set -a
  source "config.env"
  set +a
fi

export TZ="${TZ:-Asia/Tokyo}"
PORT="${PORT:-3000}"
# SERIAL_PORTはconfig.envで明示指定されていない限り空のままにする。
# 空であればserver.js側がArduinoを自動検出する。
SERIAL_PORT="${SERIAL_PORT:-}"
ADMIN_PW="${ADMIN_PW:-}"

# --- PORT の検証 ---
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  error "無効なポート番号: ${PORT}"
  info "config.env で正しいPORTを指定してください（1-65535）"
  exit 1
fi

mkdir -p logs

# --- 起動モードの選択（対話的ターミナル限定。引数指定時はスキップ） ---
if [ -t 1 ] && [ "$NOBROWSER" -eq 0 ] && [ "$FOREGROUND" -eq 0 ]; then
  while :; do
    ui_clean_opts
    ui_opt "start"        "通常起動"             "サーバーを起動し、キオスク画面を開きます（既定）"
    ui_opt "server_only"  "サーバーのみ起動"     "ブラウザを開かず、サーバーだけ起動します"
    ui_opt "dev"          "開発モード"           "サーバーを前面で実行しログをライブ表示（Ctrl+Cで終了）"
    ui_opt "config"       "設定の確認"           "現在の config.env の内容を確認します"
    ui_opt "exit"         "中止"                 "何もせず終了します"
    ui_menu "起動モードを選択" "" 0
    case "${UI_RESULT:-}" in
      start) break ;;
      server_only) NOBROWSER=1; break ;;
      dev) FOREGROUND=1; break ;;
      config)
        ui_subtitle "現在の設定（${PROJECT_DIR}/config.env）"
        if [ ! -f "config.env" ]; then
          warn "config.env がまだありません。install.sh を実行して作成してください"
        else
          while IFS= read -r _line; do
            [[ "${_line}" =~ ^(|[[:space:]]*#) ]] && continue
            _key="${_line%%=*}"
            _val="${_line#*=}"
            [[ "${_key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
            case "${_key}" in
              ADMIN_PW|SYNC_TOKEN) ui_kv "${_key}" "$(ui_mask "${_val}")" ;;
              *) ui_kv "${_key}" "${_val}" ;;
            esac
          done < "config.env"
        fi
        ui_pause
        ;;
      *) exit 0 ;;
    esac
  done
fi

# --- 開発モード（フォアグラウンド実行） ---
if [ "$FOREGROUND" -eq 1 ]; then
  ui_header "端末貸出管理システム" "開発モード"
  echo ""
  info "サーバーを前面で実行します。終了するには ${C_CYAN}Ctrl+C${C_RESET} を押してください。"
  info "ブラウザは開きません。動作確認したい場合は別ターミナルで ${C_CYAN}http://localhost:${PORT}/${C_RESET} を開いてください。"
  echo ""
  DEV_ARGS=(--port "$PORT")
  if [ -n "$SERIAL_PORT" ]; then
    DEV_ARGS+=(--serial "$SERIAL_PORT")
  fi
  exec node server.js "${DEV_ARGS[@]}"
fi

# --- サーバー起動 ---
print_header

# systemdサービスが登録されていれば、そちらを優先する
# (クラッシュ時の自動再起動が効くため)。未登録なら従来のnohup方式にフォールバック。
USE_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 \
   && systemctl --user list-unit-files device-lending-system.service >/dev/null 2>&1; then
  USE_SYSTEMD=1
fi

if [ "$USE_SYSTEMD" -eq 1 ]; then
  if is_server_running; then
    success "サーバーは既に起動しています (ポート ${PORT}, systemd管理)"
  else
    info "サーバーを起動しています... (ポート ${PORT}, systemd管理)"
    if ! systemctl --user start device-lending-system.service 2>>"${PROJECT_DIR}/logs/launcher.log"; then
      error "systemdサービスの起動に失敗しました"
      info "ターミナルで次を実行して詳細を確認してください: systemctl --user status device-lending-system.service"
      exit 1
    fi

    for i in $(seq 1 40); do
      if is_server_running; then break; fi
      if ! systemctl --user is-active --quiet device-lending-system.service; then
        ui_spin_clear
        error "サーバープロセスが異常終了しました"
        info "ターミナルで次を実行して詳細を確認してください: systemctl --user status device-lending-system.service"
        info "または journalctl --user -u device-lending-system.service -n 50"
        exit 1
      fi
      ui_spin_line "起動を待っています" "$((i / 2))" "$i"
      sleep 0.5
    done
    ui_spin_clear
  fi

  if ! is_server_running; then
    error "サーバーの起動に失敗しました（20秒タイムアウト）"
    info "ログを確認してください: systemctl --user status device-lending-system.service"
    exit 1
  fi

  success "サーバー起動完了 (ポート ${PORT}, systemd管理)"
  _EFFECTIVE_PW="${ADMIN_PW:-735657}"
  echo ""
  info "管理者パスワード: ${C_CYAN}${_EFFECTIVE_PW}${C_RESET}"

else
# 既に起動しているか確認（curl + PIDファイルの両方で判定）
if is_server_running; then
  _PID=$(get_server_pid)
  success "サーバーは既に起動しています (ポート ${PORT}, PID ${_PID:-不明})"
else
  # 古いPIDファイルを確認してみる（プロセスが死んでいれば掃除）
  if [ -f "$PID_FILE" ]; then
    _OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$_OLD_PID" ] && ! kill -0 "$_OLD_PID" 2>/dev/null; then
      rm -f "$PID_FILE"
    fi
  fi

  # ポートが他のプロセスに使われていないか確認
  if command -v ss >/dev/null 2>&1; then
    if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
      error "ポート ${PORT} は別のプロセスが使用しています"
      info "config.env でPORTを変更するか、そのプロセスを停止してください"
      exit 1
    fi
  elif command -v netstat >/dev/null 2>&1; then
    if netstat -tlnp 2>/dev/null | grep -q ":${PORT} "; then
      error "ポート ${PORT} は別のプロセスが使用しています"
      info "config.env でPORTを変更するか、そのプロセスを停止してください"
      exit 1
    fi
  fi

  # ロックファイルで同時起動を防止
  if [ -f "$LOCK_FILE" ]; then
    _LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$_LOCK_PID" ] && kill -0 "$_LOCK_PID" 2>/dev/null; then
      warn "別の起動処理が実行中です (PID ${_LOCK_PID})。完了を待っています..."
      # ロックが解除されるまで待機（最大10秒）
      for i in $(seq 1 20); do
        if [ ! -f "$LOCK_FILE" ] || ! kill -0 "$(cat "$LOCK_FILE" 2>/dev/null)" 2>/dev/null; then
          break
        fi
        sleep 0.5
      done
      rm -f "$LOCK_FILE"
    else
      rm -f "$LOCK_FILE"
    fi
  fi

  # ロック取得
  echo $$ > "$LOCK_FILE"
  trap cleanup_lock EXIT

  info "サーバーを起動しています... (ポート ${PORT})"
  ARGS=(--port "$PORT")
  if [ -n "$SERIAL_PORT" ]; then
    ARGS+=(--serial "$SERIAL_PORT")
  fi
  # ADMIN_PW はコマンドライン引数では渡さない。
  # config.env を source した時点で環境変数としてエクスポート済みであり
  # (`set -a; source config.env; set +a`)、server.js 側も process.env.ADMIN_PW
  # を正しくフォールバックとして参照するため、これで十分動作する。
  # コマンドライン引数は同一マシン上の誰でも `ps aux` や
  # /proc/<pid>/cmdline から読めてしまうため、あえて渡さない。

  nohup node server.js "${ARGS[@]}" > logs/launcher.log 2>&1 &
  _SERVER_PID=$!
  disown

  # 起動直後にプロセスが即死していないか確認
  # (`if ! CMD & then` という書き方はbashの罠で常に失敗扱いになるため使わない。
  #  必ずバックグラウンド化してPIDを取得してから kill -0 で生死を確認する)
  sleep 0.3
  if ! kill -0 "$_SERVER_PID" 2>/dev/null; then
    error "サーバープロセスの起動に失敗しました"
    info "logs/launcher.log を確認してください"
    rm -f "$LOCK_FILE"
    exit 1
  fi

  # PIDファイルを書き込み
  echo "$_SERVER_PID" > "$PID_FILE"

  # 起動待機（スピナー表示）
  for i in $(seq 1 40); do
    if is_server_running; then
      break
    fi
    # 起動中にプロセスが死んでいないか確認
    if ! kill -0 "$_SERVER_PID" 2>/dev/null; then
      ui_spin_clear
      error "サーバープロセスが異常終了しました"
      info "logs/launcher.log を確認してください"
      rm -f "$PID_FILE" "$LOCK_FILE"
      exit 1
    fi
    ui_spin_line "起動を待っています" "$((i / 2))" "$i"
    sleep 0.5
  done
  ui_spin_clear

  # ロック解除
  rm -f "$LOCK_FILE"
fi

# 最終確認
if ! is_server_running; then
  error "サーバーの起動に失敗しました（20秒タイムアウト）"
  info "ログを確認してください: ${PROJECT_DIR}/logs/launcher.log"
  rm -f "$PID_FILE"
  exit 1
fi

_PID=$(get_server_pid)
success "サーバー起動完了 (ポート ${PORT}, PID ${_PID:-不明})"

# 使用中のパスワードを表示
_EFFECTIVE_PW="${ADMIN_PW:-735657}"
echo ""
info "管理者パスワード: ${C_CYAN}${_EFFECTIVE_PW}${C_RESET}"

fi
# ↑ USE_SYSTEMD の分岐ここまで（以降はどちらの方式でも共通処理）

URL="http://localhost:${PORT}/"

# --- ブラウザで開く ---
# 実機Linux(Linux Mint)なので、Crostini時代のような「ChromeOS本体への
# URL転送(garcon)」は不要。ブラウザ(Chromium/Chrome/Firefox)は
# カメラ・マイクへ直接アクセスできるので、素直に開けばよい。
#
# キオスク用途なので、既にキオスクモードで自動起動している場合は
# 二重に開かないよう先にチェックする。
open_browser() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1 || return 1
  case "$bin" in
    xdg-open)
      # xdg-openはURL以外の引数（--kiosk等）を受け付けない仕様のため、
      # 素のURLだけを渡す。キオスク（全画面ロックダウン）表示にはならないが、
      # 対応ブラウザが1つも見つからなかった場合の最終手段として使う。
      nohup "$bin" "$URL" >/dev/null 2>&1 &
      ;;
    firefox)
      # FirefoxはChrome系と違い、キオスクオプションが -kiosk（ハイフン1つ）。
      nohup "$bin" -kiosk "$URL" >/dev/null 2>&1 &
      ;;
    *)
      # google-chrome/chromium系。lib-kiosk-browser-args.sh の共通フラグを使い、
      # kiosk-autostart.sh（ログイン自動起動）で開いたときと同じ
      # 全画面・ロックダウン状態にする（手動起動だけ通常ウィンドウのまま、
      # という食い違いを防ぐため）。
      nohup "$bin" "${KIOSK_CHROME_ARGS[@]}" --app="$URL" >/dev/null 2>&1 &
      ;;
  esac
  disown
  return 0
}

if [ "$NOBROWSER" -eq 1 ]; then
  success "サーバーは起動しました（ブラウザは開かない設定です）"
  echo ""
  info "画面を開くには以下のURLをブラウザで開いてください:"
  echo -e "  ${C_CYAN}${URL}${C_RESET}"
else
LAUNCHED=0
# --kiosk等の自動起動セッションで既にウィンドウが開いている場合は
# 二重起動になるため、既に同URLのウィンドウが存在するかを簡易チェックする。
#
# 注意: pgrep -f は「コマンドライン文字列の部分一致」なので、
#   "app=${URL}" （例: app=http://localhost:3000/）は
#   --app=http://localhost:3000/board.html （拡張ディスプレイ側の
#   サブモニター表示。board-watch.sh が別途起動する別ウィンドウ）にも
#   部分一致してしまっていた。これにより「拡張ディスプレイの画面しか
#   開いていないのに、キオスク（生徒側）画面は既に開いていると誤表示
#   され、肝心の貸出・返却キオスク画面が開かれない」という不具合が
#   起きていた。ここでは本来のキオスク（index.html）ウィンドウの
#   プロセスだけを拾い、board.html（サブモニター専用ページ）を明示的に
#   除外することで正しく検出する。
_EXISTING_KIOSK_PID="$(pgrep -f -- "app=${URL}" 2>/dev/null | while read -r _p; do
  _cmdline="$(tr '\0' ' ' < "/proc/${_p}/cmdline" 2>/dev/null)"
  case "$_cmdline" in
    *board.html*) continue ;;
    *"app=${URL}"*) echo "$_p"; break ;;
  esac
done)"
if [ -n "$_EXISTING_KIOSK_PID" ]; then
  success "キオスク画面は既に開いています"
  LAUNCHED=1
else
  # 実ブラウザ本体を優先して試す。xdg-openは--kiosk等のオプションを
  # 渡せずキオスク（全画面ロック）表示にならないため、他が1つも
  # 見つからなかった場合の最終手段としてのみ使う。
  source "${PROJECT_DIR}/scripts/lib-kiosk-browser-args.sh" 2>/dev/null || KIOSK_CHROME_ARGS=(--kiosk)
  # キオスクはChromiumを優先する（install.shが配置するURL制限ポリシーは
  # Chromium専用にしてあり、日常使いのGoogle Chromeとは分離しているため）。
  # google-chromeは、Chromium/Firefoxがどちらも無い環境向けの最終手段としてのみ試す。
  for bin in chromium chromium-browser firefox google-chrome google-chrome-stable xdg-open; do
    if open_browser "$bin"; then
      LAUNCHED=1
      if [ "$bin" = "xdg-open" ]; then
        warn "Chromium/Firefox/Chromeが見つからなかったため、既定のブラウザで通常表示（全画面ロックなし）で開きました"
      elif [ "$bin" = "google-chrome" ] || [ "$bin" = "google-chrome-stable" ]; then
        warn "Chromiumが見つからなかったためGoogle Chromeでキオスク表示しました。URL制限ポリシーはChromium専用のためこの起動には適用されません。'sudo apt install chromium' の導入を推奨します"
      else
        success "ブラウザをキオスク（全画面）モードで開きました"
      fi
      break
    fi
  done
fi

if [ "$LAUNCHED" -eq 0 ]; then
  warn "ブラウザが見つかりませんでした"
  echo ""
  info "以下のURLをブラウザで開いてください:"
  echo -e "  ${C_CYAN}${URL}${C_RESET}"
  # サーバー自体は起動できているが、画面を開くブラウザが無いケース。
  # Terminal=false のアイコン起動だと、上のURL案内も誰にも見えないので
  # ダイアログでも案内する。
  show_fail_dialog "端末貸出管理システム - ブラウザが見つかりません" \
    "サーバーは正常に起動しています（${URL}）が、画面を開くブラウザが見つかりませんでした。
以下のURLを手動でブラウザに入力してください: ${URL}"
fi

echo ""

info "終了する場合は stop.sh を実行してください（または ./dls.sh からメニューを開けます）"
fi
# ↑ NOBROWSER の分岐ここまで
