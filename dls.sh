#!/bin/bash
# ============================================================================
# 端末貸出管理システム 統合マスタースクリプト（Linux Mint 実機用）
#
# この1ファイルを実行すれば、セットアップ → 起動 → 停止 → 設定変更まで
# すべて対話式のメニューで操作できます。
#
#   ./dls.sh            対話式メニューを開く
#   ./dls.sh <コマンド> 引数指定で直接実行（非対話的な環境でも安全に使える）
#     setup      セットアップ（インストール／再インストール）
#     start      起動
#     stop       停止
#     restart    再起動（停止してから起動）
#     config     設定の変更（install.sh の設定ウィザードのみ）
#     status     サーバー／キオスクの状態確認
#     logs       ログの表示
#     uninstall  アンインストール
#     help       この使い方を表示
#
# 内部で利用する実体スクリプトは scripts/ フォルダに、設定の元テンプレートは
# scripts/templates/ フォルダにまとめてあります。
# ============================================================================
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

# --- 共通UIライブラリ（配色・記号・スピナー・対話ウィジェット） ---
source "${PROJECT_DIR}/scripts/ui-lib.sh"

CMD="${1:-}"
CONFIG_FILE="${PROJECT_DIR}/config.env"

# ============================================================================
# 個別コマンドの実体
# ============================================================================
do_setup()    { bash "${PROJECT_DIR}/scripts/install.sh"; }
do_start()    { bash "${PROJECT_DIR}/scripts/start.sh"; }
do_stop()     { bash "${PROJECT_DIR}/scripts/stop.sh"; }
do_config()   { bash "${PROJECT_DIR}/scripts/install.sh" --config-only; }
do_uninstall(){
  if ui_is_tty; then
    if ui_yesno "本当にアンインストールしますか？（設定とデータは削除されません）" no; then
      bash "${PROJECT_DIR}/scripts/uninstall.sh"
    else
      info "アンインストールを中止しました"
    fi
  else
    bash "${PROJECT_DIR}/scripts/uninstall.sh"
  fi
}

do_restart() {
  ui_header "端末貸出管理システム" "再起動"
  echo ""
  bash "${PROJECT_DIR}/scripts/stop.sh"
  echo ""
  bash "${PROJECT_DIR}/scripts/start.sh"
}

do_status() {
  ui_header "端末貸出管理システム" "状態の確認"
  echo ""

  # --- 設定の読み込み ---
  PORT=3000
  if [ -f "$CONFIG_FILE" ]; then
    _p=$(grep '^PORT=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2-)
    _p="${_p:-3000}"
    if [[ "$_p" =~ ^[0-9]+$ ]] && [ "$_p" -ge 1 ] && [ "$_p" -le 65535 ]; then
      PORT="$_p"
    fi
  else
    warn "config.env がありません。初期セットアップ（./dls.sh setup）を実行してください"
  fi

  # --- サーバーの生死 ---
  if curl -s "http://localhost:${PORT}/" >/dev/null 2>&1; then
    success "サーバーは稼働中です（ポート ${PORT}）"
  else
    warn "サーバーは停止しています（ポート ${PORT}）"
  fi

  # --- PID ---
  if [ -f "${PROJECT_DIR}/logs/server.pid" ]; then
    _PID=$(cat "${PROJECT_DIR}/logs/server.pid" 2>/dev/null || true)
    if [ -n "$_PID" ] && kill -0 "$_PID" 2>/dev/null; then
      ui_kv "プロセスPID" "$_PID"
    else
      ui_kv "プロセスPID" "（記録ファイルのみ。プロセスは停止中）"
    fi
  fi

  # --- systemd 管理 ---
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet device-lending-system.service 2>/dev/null; then
    ui_kv "systemd管理" "有効（device-lending-system.service が稼働中）"
  else
    ui_kv "systemd管理" "なし（scripts/start.sh 直接起動）"
  fi

  # --- キオスク画面 ---
  # 注意: pgrep -f はコマンドライン文字列の部分一致なので、
  # "app=http://localhost:PORT/" は --app=.../board.html（拡張ディスプレイ用の
  # サブモニター表示）にも一致してしまう。ここでは生徒側の貸出・返却
  # キオスク画面（index.html）だけを正しく検出するため、board.html を
  # 使っているプロセスは除外する。
  _KIOSK_PID=""
  for _p in $(pgrep -f -- "app=http://localhost:${PORT}/" 2>/dev/null); do
    _cmdline="$(tr '\0' ' ' < "/proc/${_p}/cmdline" 2>/dev/null)"
    case "$_cmdline" in
      *board.html*) continue ;;
      *) _KIOSK_PID="$_p"; break ;;
    esac
  done
  if [ -n "$_KIOSK_PID" ]; then
    ui_kv "キオスク画面" "表示中"
  else
    ui_kv "キオスク画面" "非表示"
  fi

  # --- キオスク画面の短時間連続クラッシュ警告 ---
  # kiosk-autostart.sh（スーパーバイザー）が自動復旧を繰り返した記録。
  # 管理画面のヘルスチェックにも同じ内容が表示される。
  if [ -f "${PROJECT_DIR}/logs/kiosk-crash-warning.json" ]; then
    _CRASH_COUNT=$(grep -o '"crashCount"[[:space:]]*:[[:space:]]*[0-9]*' "${PROJECT_DIR}/logs/kiosk-crash-warning.json" 2>/dev/null | grep -o '[0-9]*$')
    _CRASH_AT=$(grep -o '"lastCrashAt"[[:space:]]*:[[:space:]]*"[^"]*"' "${PROJECT_DIR}/logs/kiosk-crash-warning.json" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
    warn "⚠ キオスク画面が短時間に${_CRASH_COUNT:-?}回異常終了しています（直近: ${_CRASH_AT:-不明}）。自動復旧は動作していますが、logs/kiosk.log を確認してください"
  fi

  # --- Arduino ---
  if ls /dev/ttyACM* /dev/ttyUSB* /dev/ttyAMA* 2>/dev/null | grep -q .; then
    ui_kv "Arduinoシリアル" "$(ls /dev/ttyACM* /dev/ttyUSB* /dev/ttyAMA* 2>/dev/null | tr '\n' ' ')"
  else
    ui_kv "Arduinoシリアル" "未検出（未接続／権限なし）"
  fi

  # --- サブモニター表示（貸出状況ボード） ---
  if [ -f "${HOME}/.config/autostart/device-lending-board.desktop" ]; then
    if pgrep -f "scripts/board-watch.sh" >/dev/null 2>&1; then
      if pgrep -f -- "--user-data-dir=${HOME}/.config/device-lending-board-profile" >/dev/null 2>&1; then
        ui_kv "サブモニター表示" "自動検出 有効・拡張ディスプレイに表示中"
      else
        ui_kv "サブモニター表示" "自動検出 有効・拡張ディスプレイ未検出（待機中）"
      fi
    elif ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
      ui_kv "サブモニター表示" "登録済みですがChromiumが見つからないため動作していません（'sudo apt install chromium' 後に再ログインしてください）"
    else
      ui_kv "サブモニター表示" "自動検出は登録済みですが監視プロセスが動いていません（次回ログインで開始、または ./scripts/board-watch.sh & で今すぐ起動）"
    fi
  else
    ui_kv "サブモニター表示" "未設定（./dls.sh setup で「サブモニター表示の自動検出」を選ぶと使えます）"
  fi

  echo ""
  if ui_is_tty; then
    ui_pause
  fi
}

# ログ表示の実処理（do_logsから呼ばれる内部関数）
#   _render_logs <target: server|errwarn|launcher|kiosk|board|systemd|all> <count>
_render_logs() {
  local target="$1" count="${2:-30}"
  local server_log="${PROJECT_DIR}/logs/server.jsonl"
  local _found=0 _f _label

  _render_plain_log() {
    # _render_plain_log <ファイルパス> <表示名>
    local f="$1" label="$2" n="$3"
    if [ -f "$f" ]; then
      _found=1
      ui_subtitle "▼ ${label}（直近${n}件）"
      tail -n "$n" "$f" | sed 's/^/  /'
    fi
  }

  case "$target" in
    server)
      if [ -f "$server_log" ]; then
        _found=1
        ui_subtitle "▼ サーバーログ（logs/server.jsonl 直近${count}件）"
        ui_print_jsonl_tail "$server_log" "$count" ""
      fi
      ;;
    errwarn)
      if [ -f "$server_log" ]; then
        _found=1
        ui_subtitle "▼ サーバーログ（logs/server.jsonl エラー・警告のみ 直近${count}件）"
        ui_print_jsonl_tail "$server_log" "$count" "エラー,警告"
      fi
      ;;
    launcher) _render_plain_log "${PROJECT_DIR}/logs/launcher.log"    "logs/launcher.log（起動処理の詳細）" "$count" ;;
    kiosk)    _render_plain_log "${PROJECT_DIR}/logs/kiosk.log"       "logs/kiosk.log（キオスク自動起動）" "$count" ;;
    board)    _render_plain_log "${PROJECT_DIR}/logs/board-watch.log" "logs/board-watch.log（サブモニター自動検出）" "$count" ;;
    systemd)  _render_plain_log "${PROJECT_DIR}/logs/systemd.log"     "logs/systemd.log（systemd管理）" "$count" ;;
    all)
      if [ -f "$server_log" ]; then
        _found=1
        ui_subtitle "▼ サーバーログ（logs/server.jsonl 直近${count}件）"
        ui_print_jsonl_tail "$server_log" "$count" ""
        echo ""
      fi
      for _f in \
        "${PROJECT_DIR}/logs/launcher.log|logs/launcher.log（起動処理の詳細）" \
        "${PROJECT_DIR}/logs/kiosk.log|logs/kiosk.log（キオスク自動起動）" \
        "${PROJECT_DIR}/logs/board-watch.log|logs/board-watch.log（サブモニター自動検出）" \
        "${PROJECT_DIR}/logs/systemd.log|logs/systemd.log（systemd管理）"; do
        local _path="${_f%%|*}" _lbl="${_f#*|}"
        if [ -f "$_path" ]; then
          _render_plain_log "$_path" "$_lbl" 15
          echo ""
        fi
      done
      ;;
  esac

  if [ "$_found" -eq 0 ]; then
    warn "該当するログファイルがまだありません。サーバーを一度起動してください"
  fi
}

do_logs() {
  local _show_target="server" _show_count=30

  if ui_is_tty; then
    while :; do
      ui_header "端末貸出管理システム" "ログの確認"
      echo ""
      ui_clean_opts
      ui_opt "server"   "サーバーログ"                     "起動・貸出・返却・エラー等の動作ログ（logs/server.jsonl）"
      ui_opt "errwarn"  "サーバーログ（エラー・警告のみ）" "動作ログのうち、エラーと警告だけに絞って表示します"
      ui_opt "launcher" "起動ログ"                         "logs/launcher.log（起動処理の詳細）"
      ui_opt "kiosk"    "キオスクログ"                     "logs/kiosk.log（ログイン時のキオスク自動起動）"
      ui_opt "board"    "サブモニターログ"                 "logs/board-watch.log（拡張ディスプレイの自動検出）"
      ui_opt "systemd"  "systemdログ"                      "logs/systemd.log（systemd管理時のみ）"
      ui_opt "all"      "すべてまとめて表示"               "各ログファイルの末尾を続けて表示します"
      ui_opt "exit"     "戻る"                             ""
      ui_menu "表示するログを選択してください" "" 0
      case "${UI_RESULT:-}" in
        server|errwarn|launcher|kiosk|board|systemd|all) _show_target="${UI_RESULT}" ;;
        *) return 0 ;;
      esac

      if [ "$_show_target" != "all" ]; then
        ui_number "表示する件数" 30 5 500
        _show_count="$UI_RESULT"
      else
        _show_count=15
      fi

      ui_header "端末貸出管理システム" "ログの確認"
      echo ""
      _render_logs "$_show_target" "$_show_count"
      echo ""
      ui_pause
    done
  else
    # 非対話環境（例: dls.sh logs を自動実行）では、従来どおり主要ログを
    # まとめて一度に表示する（メニューを開けないため選択肢は出さない）。
    ui_header "端末貸出管理システム" "ログの確認"
    echo ""
    _render_logs "all" 15
  fi
}

do_help() {
  cat <<'HELP'
使い方: ./dls.sh [コマンド]

  （何も指定しない場合: 対話式メニューを開きます）

  setup      セットアップ（インストール／再インストール）
  start      起動（対話式で起動モードを選択）
  stop       停止
  restart    再起動
  config     設定の変更
  status     サーバー／キオスクの状態確認
  logs       ログの表示
  uninstall  アンインストール
  help       この使い方を表示

補足:
  - セットアップは利用シーンのプロファイル（キオスク／先生用／開発用）を
    選び、インストール項目と設定内容を対話式に選んで進みます。
  - 各コマンドの実体は scripts/ フォルダにあります。
HELP
}

# ============================================================================
# コマンド引数が指定されている場合は直接実行する（非対話的な環境でも安全）
# ============================================================================
case "$CMD" in
  setup)     do_setup; exit 0 ;;
  start)     do_start; exit 0 ;;
  stop)      do_stop; exit 0 ;;
  restart)   do_restart; exit 0 ;;
  config)    do_config; exit 0 ;;
  status)    do_status; exit 0 ;;
  logs)      do_logs; exit 0 ;;
  uninstall) do_uninstall; exit 0 ;;
  help|-h|--help) do_help; exit 0 ;;
esac

# ============================================================================
# 引数なし → 対話式メニュー
# ============================================================================
if ! ui_is_tty; then
  do_help
  echo ""
  warn "対話的なターミナルから実行されていないため、メニューを開けません。"
  warn "コマンドを指定して実行してください（例: ./dls.sh status）"
  exit 1
fi

ui_header "端末貸出管理システム" "統合メニュー"
echo ""
if [ ! -f "$CONFIG_FILE" ]; then
  info "設定ファイル（config.env）がまだありません。まずセットアップしてください"
  echo ""
fi

while :; do
  ui_clean_opts
  ui_opt "setup"     "セットアップ"       "インストール／再インストールを実行します（利用シーンプロファイル選択・項目チェックリスト付き）"
  ui_opt "start"     "起動"               "サーバーを起動します（開始するモードを対話式に選択）"
  ui_opt "stop"      "停止"               "サーバーを停止します"
  ui_opt "restart"   "再起動"             "停止してから起動し直します"
  ui_opt "config"    "設定の変更"         "config.env の内容をウィザードで確認・変更します"
  ui_opt "status"    "状態の確認"         "サーバー／キオスク／Arduino の状態を表示します"
  ui_opt "logs"      "ログの表示"         "起動・systemd・キオスクのログを表示します"
  ui_opt "uninstall" "アンインストール"   "システムからアプリを削除します"
  ui_opt "exit"      "終了"               "メニューを終了します"
  ui_menu "操作を選択してください" "" 0
  case "${UI_RESULT:-}" in
    setup)     do_setup ;;
    start)     do_start ;;
    stop)      do_stop ;;
    restart)   do_restart ;;
    config)    do_config ;;
    status)    do_status ;;
    logs)      do_logs ;;
    uninstall) do_uninstall ;;
    *) break ;;
  esac
  echo ""
done

echo ""
info "メニューを終了しました。サーバーを起動中のまま放置しておけばキオスク用途として稼働し続けます"