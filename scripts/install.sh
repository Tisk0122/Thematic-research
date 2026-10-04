#!/bin/bash
# 端末貸出管理システム セットアップスクリプト（Linux Mint 実機用）
# ----------------------------------------------------------------------------
# 対話式セットアップ（Opencode風のターミナルUIで選択できる）:
#   1) 利用シーンのプロファイルを選択（キオスク本番 / 先生用PC / 開発用）
#   2) インストールする項目をチェックリストで選択（Spaceで切替）
#   3) 設定ウィザードで config.env の主要項目を編集
#   4) プランを確認してから実行
#
# 自動実行（無人インストール）:
#   ./install.sh --profile kiosk --yes          # 全項目・確認なし
#   ./install.sh --profile dev --skip-wizard    # 開発構成・設定編集なし
# ----------------------------------------------------------------------------
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
LINUX_APP_DIR="$PROJECT_DIR"
TPL_DIR="${PROJECT_DIR}/scripts/templates"
# GAS_URL の既定値は持たない（設定漏れの端末が特定のスプレッドシートへ
# まとまって書き込む事故を防ぐため、未設定なら「未設定」のまま起動する）

# --- 共通UIライブラリ（配色・記号・スピナー・進捗バー・対話ウィジェット） ---
source "${PROJECT_DIR}/scripts/ui-lib.sh"

# --- ログファイル ---
LOG_FILE="${PROJECT_DIR}/logs/install.log"
mkdir -p "${PROJECT_DIR}/logs"
: > "${LOG_FILE}"

# --- トラップ（エラー時ログ出力） ---
on_error() {
  echo ""
  step_error "インストール中にエラーが発生しました"
  info "ログを確認してください: ${LOG_FILE}"
}
trap on_error ERR

# --- 変数検証ヘルパー ---
# バグ修正: これらの変数は `sudo bash -c "..."` の二重引用符内に直接埋め込まれる。
# ユーザー名やポート番号にシェルメタ文字(' " $ () ` 空白等)が含まれていると、
# root権限のコマンド文字列を任意に変更できてしまう（権限昇格の余地）。
# 埋め込む前に必ず検証し、不正なら続行を止める。
#
# 検証に使う正規表現:
#   _V_USERNAME_RE  : POSIXユーザー名(先頭は英小文字または _、以降は英数 _ -)
#   _V_PORT_RE      : 数値(1〜65535)
_V_USERNAME_RE='[a-z_][a-z0-9_-]*$'
_V_PORT_RE='^[0-9]+$'

# ユーザー名を検証して返す。不正なら空文字を返す。
validate_username() {
  local _name="${1:-$(whoami)}"
  case "${_name}" in
    ''|*[!a-z0-9_-]*|'-'*) echo ""; return 1 ;;
    [0-9]*) echo ""; return 1 ;;
  esac
  echo "${_name}"
}

# ポート番号を検証して返す。不正なら空文字を返す。
validate_port() {
  local _port="${1:-}"
  if [[ "${_port}" =~ ^[0-9]+$ ]] && [ "${_port}" -ge 1 ] 2>/dev/null && [ "${_port}" -le 65535 ] 2>/dev/null; then
    echo "${_port}"
  else
    echo ""
  fi
}

# --- 引数解析 ---
PROFILE=""
SKIP_WIZARD=0
INSTALL_ALL=0
ASSUME_YES=0
CONFIG_ONLY=0
usage() {
  cat <<'USAGE'
使い方: ./install.sh [オプション]
  （何も指定しない場合: 対話式で実行します）

  --profile <kiosk|teacher|dev>  利用シーンのプロファイルを指定
  --install-all                  インストール項目をすべて選択（確認なし）
  --skip-wizard                  設定ウィザードを開かず config.env をそのまま使う
  --config-only                  インストールは行わず、設定ウィザードのみを実行
  -y, --yes                      すべての入力を省略して既定構成で実行
  -h, --help                     このヘルプを表示

※ 通常は手動の ./dls.sh メニューから実行します。
USAGE
}
while [ $# -gt 0 ]; do
  case "$1" in
    --profile=*) PROFILE="${1#*=}" ;;
    --profile) shift; PROFILE="${1:-}" ;;
    --skip-wizard) SKIP_WIZARD=1 ;;
    --install-all) INSTALL_ALL=1 ;;
    --config-only) CONFIG_ONLY=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) warn "不明なオプションです（無視します）: $1" ;;
  esac
  shift
done

# ============================================================================
# ユーティリティ関数
# ============================================================================
# 配色・記号・info/success/warn/error・step()（進捗バー付き）・対話ウィジェットは
# ui-lib.sh 側で定義済み。ここではこのスクリプト固有のものだけを定義する。
print_header() {
  ui_header "端末貸出管理システム" "セットアップ"
  ui_kv "プロジェクト" "${PROJECT_DIR}"
  ui_kv "ログ" "${LOG_FILE}"
  echo -e "${C_GRAY_DIM}  時間のかかる処理中は ${C_RESET}${C_CYAN}v${C_RESET}${C_GRAY_DIM} キーで詳細ログを表示できます${C_RESET}"
  echo ""
}

# ログファイルの指定行以降を、色付きプレフィックス付きで出力する。
# sed の置換文字列にエスケープシーケンス（\033 等）を渡すと、sed が
# \0 をバックリファレンスとして誤解釈し出力が化けるバグがあったため、
# シェルの while read ループで1行ずつ組み立てる安全な方式にしている。
print_log_tail() {
  ui_print_log_tail "${LOG_FILE}" "$1"
}

# --- 時間のかかるコマンドの実行ラッパー ---
# バックグラウンドでコマンドを実行しつつ、経過時間スピナーを表示する。
# 実行中に v キー（または l キー）を押すと、詳細ログのライブ表示に
# その場で切り替えられる。もう一度押すとスピナー表示に戻る。
#
# 使い方: run_step "表示するラベル" -- コマンド 引数...
#   例: run_step "npm install を実行中" -- npm install --loglevel=warn
run_step() {
  local label="$1"; shift
  if [ "$1" = "--" ]; then shift; fi

  local log_start_line
  log_start_line=$(wc -l < "${LOG_FILE}" 2>/dev/null || echo 0)

  # sudo を含むコマンドは、バックグラウンド化する前にパスワード入力を
  # 済ませておく。そうしないと、パスワード入力待ちのままスピナーだけが
  # 回り続け、何も起きていないように見えてしまう。
  if [[ "$1" == "sudo" ]] && command -v sudo >/dev/null 2>&1; then
    if ! sudo -n true 2>/dev/null; then
      printf "\r\033[K  ${C_DIM}%s${C_RESET} ${C_YELLOW}(管理者パスワードの入力が必要です)${C_RESET}\n" "$label"
      sudo -v || { step_error "管理者権限の認証に失敗しました"; return 1; }
    fi
  fi

  ("$@" >> "${LOG_FILE}" 2>&1; echo $? > "${LOG_FILE}.exitcode") &
  local cmd_pid=$!

  local view_mode="spinner"   # "spinner" | "log"
  local start_ts=$SECONDS
  local log_tail_lines=0
  local spin_idx=0
  local old_stty=""
  if [ -t 0 ]; then
    old_stty=$(stty -g 2>/dev/null || echo "")
    stty -icanon -echo min 0 time 0 2>/dev/null || true
  fi

  while kill -0 "$cmd_pid" 2>/dev/null; do
    local elapsed=$((SECONDS - start_ts))

    # キー入力チェック（ノンブロッキング）
    if [ -t 0 ]; then
      local key=""
      key=$(dd bs=1 count=1 2>/dev/null <&0)
      if [ "$key" = "v" ] || [ "$key" = "l" ] || [ "$key" = "V" ] || [ "$key" = "L" ]; then
        if [ "$view_mode" = "spinner" ]; then
          view_mode="log"
          ui_spin_clear
          echo -e "  ${C_GRAY}${I_BOX_H}${I_BOX_H} 詳細ログ（${label}） ${C_GRAY_DIM}v キーで戻る${C_RESET}${C_GRAY} $(ui_rule 34)${C_RESET}"
          log_tail_lines=$(wc -l < "${LOG_FILE}" 2>/dev/null || echo 0)
        else
          view_mode="spinner"
          echo -e "  ${C_GRAY}$(ui_rule 40)${C_RESET}"
        fi
      fi
    fi

    if [ "$view_mode" = "log" ]; then
      local current_lines
      current_lines=$(wc -l < "${LOG_FILE}" 2>/dev/null || echo 0)
      if [ "$current_lines" -gt "$log_tail_lines" ]; then
        print_log_tail "$((log_tail_lines + 1))"
        log_tail_lines=$current_lines
      fi
    else
      ui_spin_line "$label" "$elapsed" "$spin_idx" "v キーで詳細ログ表示"
      spin_idx=$((spin_idx + 1))
    fi

    sleep 0.2
  done

  if [ -n "$old_stty" ]; then
    stty "$old_stty" 2>/dev/null || true
  fi

  if [ "$view_mode" = "log" ]; then
    local current_lines
    current_lines=$(wc -l < "${LOG_FILE}" 2>/dev/null || echo 0)
    if [ "$current_lines" -gt "$log_tail_lines" ]; then
      print_log_tail "$((log_tail_lines + 1))"
    fi
    echo -e "  ${C_GRAY}$(ui_rule 40)${C_RESET}"
  else
    ui_spin_clear
  fi

  wait "$cmd_pid" 2>/dev/null
  local exit_code
  exit_code=$(cat "${LOG_FILE}.exitcode" 2>/dev/null || echo 1)
  rm -f "${LOG_FILE}.exitcode"
  return "$exit_code"
}

# --- 事前チェック ---
check_prereqs() {
  local errors=0

  if ! command -v sudo >/dev/null 2>&1; then
    step_warn "sudo コマンドが見つかりません。管理者権限が必要な処理で問題が発生する可能性があります"
  fi

  if ! curl -s --max-time 5 https://deb.nodesource.com >/dev/null 2>&1; then
    step_warn "ネットワークに接続できません。Node.js のインストールで問題が発生する可能性があります"
  fi

  if [ ! -f "${LINUX_APP_DIR}/config.env.example" ]; then
    step_error "config.env.example が見つかりません。プロジェクトが正しくダウンロードされていない可能性があります"
    errors=$((errors + 1))
  fi

  if [ ! -f "${TPL_DIR}/device-lending-system.desktop" ]; then
    step_warn "device-lending-system.desktop テンプレートが見つかりません。デスクトップエントリの登録をスキップします"
  fi

  if [ ! -f "${LINUX_APP_DIR}/scripts/stop.sh" ]; then
    step_warn "stop.sh が見つかりません。停止スクリプトなしで起動されます"
  fi

  return $errors
}

get_node_version() {
  if command -v node >/dev/null 2>&1; then
    node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
  fi
}

# ============================================================================
# インストール項目の定義（チェックリスト用）
# ============================================================================
CONFIG_FILE="${PROJECT_DIR}/config.env"
ITEMS=(); ITEM_LABEL=(); ITEM_DESC=()
add_item() { ITEMS+=("$1"); ITEM_LABEL+=("$2"); ITEM_DESC+=("${3:-}"); }

ensure_manual_server_timezone() {
  if [ ! -f "$CONFIG_FILE" ]; then
    : > "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
  fi
  local tmp="${PROJECT_DIR}/.config.env.timezone.$$"
  awk '!/^[[:space:]]*TZ[[:space:]]*=/' "$CONFIG_FILE" > "$tmp"
  printf 'TZ=Asia/Tokyo\n' >> "$tmp"
  mv "$tmp" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
}

build_item_defs() {
  add_item node     "Node.js 18+ の確認・導入"         "なければ NodeSource 20.x を自動導入"
  add_item syspkgs  "システムパッケージ"               "build-essential / python3 / ffmpeg / curl / zenity"
  add_item fonts    "日本語フォント（fonts-noto-cjk）" "ウィンドウタイトル等の「豆腐文字」を防止"
  add_item browser  "ブラウザの確認 / Chromium 導入"    "キオスク画面の表示に使用"
  add_item npm      "依存パッケージの導入（npm install）" "アプリ本体の動作に必須"
  add_item perms    "スクリプトへの実行権限付与"        "start.sh / stop.sh / uninstall.sh 等"
  add_item arduino  "Arduino シリアル権限と udev 規則"  "dialout グループ + 安定したポート名"
  add_item config   "設定ウィザード（config.env）"      "パスワード・ポート・シリアル・GAS 等を対話で設定"
  add_item desktop  "アプリランチャーへの登録"           "「端末貸出管理システム」をアプリ一覧に追加"
  add_item systemd  "自動再起動サービス（systemd）"     "クラッシュ・再起動後の自動復旧 + linger"
  add_item autokiosk "自動ログイン + キオスク自動起動"  "電源ON→全自動でキオスク画面を表示"
  add_item boardwatch "サブモニター表示の自動検出"     "HDMI接続時、拡張ディスプレイに貸出状況ボードを自動表示"
  add_item lockdown "キオスク画面のロックダウン"        "URL制限 / ショートカット無効 / VT切替無効 / 緊急脱出"
}

# 実行順序（チェックリストの表示順とは独立に、依存関係が正しい順で実行する）
ORDER=(node syspkgs fonts browser npm perms arduino config desktop systemd autokiosk boardwatch lockdown)

# プロファイル別の既定選択（後からユーザーが自由に変更できる）
KIOSK_LIST="node syspkgs fonts browser npm perms arduino config desktop systemd autokiosk boardwatch lockdown"
TEACHER_LIST="node syspkgs fonts browser npm perms config desktop"
DEV_LIST="node syspkgs fonts browser npm perms config"

SELECTED=""
apply_profile() {
  case "$PROFILE" in
    teacher) SELECTED="$TEACHER_LIST" ;;
    dev)     SELECTED="$DEV_LIST" ;;
    *)       SELECTED="$KIOSK_LIST" ;;
  esac
}

# 選択項目ヘルパー
is_sel() {
  local id="$1" w
  for w in $SELECTED; do [ "$w" = "$id" ] && return 0; done
  return 1
}
idx_of() {
  local id="$1" i
  for i in "${!ITEMS[@]}"; do [ "${ITEMS[$i]}" = "$id" ] && { printf '%s' "$i"; return; }; done
  printf '%s' "-1"
}
item_label() {
  local id="$1" i
  for i in "${!ITEMS[@]}"; do [ "${ITEMS[$i]}" = "$id" ] && { printf '%s' "${ITEM_LABEL[$i]}"; return; }; done
  printf '%s' "$id"
}
selstr_of_selected() {
  local s='' i
  for id in $SELECTED; do
    i=$(idx_of "$id")
    [ "$i" -ge 0 ] 2>/dev/null && s="$s $i"
  done
  printf '%s' "${s# }"
}
selected_of_selstr() {
  local s='' idx
  for idx in $UI_RESULT_SEL; do s="$s ${ITEMS[$idx]}"; done
  printf '%s' "${s# }"
}

# ============================================================================
# 1) プロファイル選択
# ============================================================================
choose_profile() {
  if [ -n "$PROFILE" ]; then apply_profile; return 0; fi

  ui_clean_opts
  ui_opt kiosk   "キオスクPC（本番運用）"   "全機能オン: 自動ログインからロックダウンまで完全自動化"
  ui_opt teacher "先生用PC（管理画面用途）" "サーバーと管理画面のみ。生徒向けのロックダウンは行わない"
  ui_opt dev     "開発・テスト用"          "最小構成。自動起動・ロックダウンを含めない"
  ui_menu "セットアップ対象（利用シーン）の選択" "中止" 0

  case "${UI_RESULT:-}" in
    kiosk|teacher|dev) PROFILE="$UI_RESULT" ;;
    *) warn "中止しました。何も変更していません。"; exit 0 ;;
  esac
  apply_profile
}

# ============================================================================
# 2) インストール項目のチェックリスト選択
# ============================================================================
choose_items() {
  if [ "$INSTALL_ALL" -eq 1 ] || [ "$ASSUME_YES" -eq 1 ]; then
    SELECTED="$KIOSK_LIST"
    return 0
  fi
  apply_profile
  [ -z "$SELECTED" ] && SELECTED="$KIOSK_LIST"

  # 非TTY（自動実行・CI）では既定構成のまま先へ進める
  if ! ui_is_tty; then return 0; fi

  ui_clean_opts
  local i
  for i in "${!ITEMS[@]}"; do
    ui_opt "${ITEMS[$i]}" "${ITEM_LABEL[$i]}" "${ITEM_DESC[$i]}"
  done
  ui_checkboxes "実行する手順を選択（Space=切替  a=全選択  n=解除  Enter=決定）" "中止"

  if [ -z "${UI_RESULT_SEL:-}" ]; then
    warn "中止しました。何も変更していません。"
    exit 0
  fi
  SELECTED="$(selected_of_selstr)"
}

# ============================================================================
# 3) 設定ウィザード（config.env）
# ============================================================================
cfg_get() {
  local key="$1" v
  [ -f "$CONFIG_FILE" ] || { printf ''; return; }
  v=$(awk -F= -v k="${key}" '
    { line=$0 }
    line !~ /^[[:space:]]*#/ && line ~ ("^" k "=") { v=line; sub(/^[^=]*=/,"",v); gsub(/\r$/,"",v) }
    END { print v }' "$CONFIG_FILE")
  printf '%s' "$v"
}

load_wizard_defaults() {
  W_PORT="$(cfg_get PORT)";               [ -n "$W_PORT" ] || W_PORT="3000"
  W_ADMIN_PW="$(cfg_get ADMIN_PW)";       [ -n "$W_ADMIN_PW" ] || W_ADMIN_PW="735657"
  W_SERIAL="$(cfg_get SERIAL_PORT)"
  W_GAS="$(cfg_get GAS_URL)"
  W_SYNC_INT="$(cfg_get SYNC_INTERVAL_MS)";  [ -n "$W_SYNC_INT" ] || W_SYNC_INT="180000"
  W_BACK_INT="$(cfg_get BACKUP_INTERVAL_MS)"; [ -n "$W_BACK_INT" ] || W_BACK_INT="21600000"
  W_BACK_DAYS="$(cfg_get BACKUP_RETENTION_DAYS)"; [ -n "$W_BACK_DAYS" ] || W_BACK_DAYS="30"
  W_BACK_MAX="$(cfg_get BACKUP_MAX_COUNT)";     [ -n "$W_BACK_MAX" ] || W_BACK_MAX="60"
  W_EXT="$(cfg_get EXTERNAL_STORAGE_DIR)"
}

# 既存config.env（コメントや SYNC_TOKEN 等の未知キー）はそのまま残しつつ、
# ウィザードが管理する項目だけを一括で書き換える。
apply_config_env() {
  local tmp="${PROJECT_DIR}/.config.env.new.$$"
  if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "${PROJECT_DIR}/config.env.example" ]; then
      cp "${PROJECT_DIR}/config.env.example" "$CONFIG_FILE"
    else
      : > "$CONFIG_FILE"
    fi
  fi
  grep -vE '^(PORT|ADMIN_PW|SERIAL_PORT|GAS_URL|SYNC_INTERVAL_MS|BACKUP_INTERVAL_MS|BACKUP_RETENTION_DAYS|BACKUP_MAX_COUNT|EXTERNAL_STORAGE_DIR)=' "$CONFIG_FILE" > "$tmp" || true
  {
    echo ""
    echo "# ---------- 以下はセットアップウィザードで生成・更新された設定 ----------"
    echo "PORT=${W_PORT:-3000}"
    echo "ADMIN_PW=${W_ADMIN_PW:-735657}"
    if [ -n "${W_SERIAL:-}" ]; then
      echo "SERIAL_PORT=${W_SERIAL}"
    else
      echo "# SERIAL_PORT=（自動検出）"
    fi
    if [ -n "${W_GAS:-}" ]; then
      echo "GAS_URL=${W_GAS}"
    else
      echo "# GAS_URL=（未設定）"
    fi
    echo "SYNC_INTERVAL_MS=${W_SYNC_INT:-180000}"
    echo "BACKUP_INTERVAL_MS=${W_BACK_INT:-21600000}"
    echo "BACKUP_RETENTION_DAYS=${W_BACK_DAYS:-30}"
    echo "BACKUP_MAX_COUNT=${W_BACK_MAX:-60}"
    if [ -n "${W_EXT:-}" ]; then
      echo "EXTERNAL_STORAGE_DIR=${W_EXT}"
    else
      echo "# EXTERNAL_STORAGE_DIR=（自動検出）"
    fi
  } >> "$tmp"
  mv "$tmp" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
}

show_effective_config() {
  ui_subtitle "現在の設定"
  ui_kv "管理者パスワード" "$(ui_mask "$(cfg_get ADMIN_PW)")"
  ui_kv "ポート" "$(cfg_get PORT)"
  if [ -n "$(cfg_get SERIAL_PORT)" ]; then
    ui_kv "シリアルポート" "$(cfg_get SERIAL_PORT)"
  else
    ui_kv "シリアルポート" "自動検出"
  fi
  if [ -n "$(cfg_get GAS_URL)" ]; then
    ui_kv "GAS_URL" "$(cfg_get GAS_URL)"
  else
    ui_kv "GAS_URL" "既定URL（スプレッドシート同期ON）"
  fi
  if [ -n "$(cfg_get EXTERNAL_STORAGE_DIR)" ]; then
    ui_kv "外部ストレージ" "$(cfg_get EXTERNAL_STORAGE_DIR)"
  else
    ui_kv "外部ストレージ" "自動検出（USB/SD）"
  fi
  ui_kv "同期間隔" "$(cfg_get SYNC_INTERVAL_MS) ms"
  ui_kv "バックアップ" "$(cfg_get BACKUP_INTERVAL_MS) ms / $(cfg_get BACKUP_RETENTION_DAYS)日 / 最大$(cfg_get BACKUP_MAX_COUNT)件"
}

run_wizard() {
  ui_subtitle "設定ウィザード"
  info "各項目は Enter を押すと現在の値のまま進めます。"

  # 管理者パスワードは「数字のみ・6〜12桁」でしか設定できない。
  # 管理画面（admin.html）のログインは0〜9のテンキー入力専用で、サーバー側
  # （/api/change-admin-password）も数字のみを必須としている。ここで数字以外を
  # 許すと、管理画面へ永久にログインできなくなる（管理者が
  # config.env を手編集するしかなくなる）ため、ウィザードでも同じ制約を掛ける。
  ui_password "管理者パスワード（ADMIN_PW）" "$W_ADMIN_PW" \
    '^[0-9]{6,12}$' "数字(0-9)のみで6〜12桁で入力してください（ログインはテンキー入力です）"
  W_ADMIN_PW="$UI_RESULT"

  # 既存config.envに数字以外・桁数外のパスワードが入っている場合は、
  # ここで止めて自行修正を促す（黙って上書きはしない）
  if ! [[ "$W_ADMIN_PW" =~ ^[0-9]{6,12}$ ]]; then
    step_error "現在の管理者パスワードが「数字のみ6〜12桁」の条件を満たしていません"
    step_error "管理画面（admin.html）のログインはテンキー入力のため、この設定ではログインできません"
    step_warn "config.env の ADMIN_PW を6〜12桁の数字に修正するか、上の入力欄で新しいパスワードを設定してください"
    exit 1
  fi

  while :; do
    ui_input "ポート番号（PORT）" "$W_PORT" '^[0-9]+$' "数値（1-65535）で入力してください"
    if [ "$UI_RESULT" -ge 1 ] && [ "$UI_RESULT" -le 65535 ]; then
      W_PORT="$UI_RESULT"; break
    fi
    printf "  ${C_YELLOW}${I_WARN}${C_RESET} ポート番号は 1〜65535 の範囲で入力してください\n"
  done

  # シリアルポート: 自動検出 / 検出結果から選択 / 手動入力
  local devs d
  devs=( $(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null) )
  ui_clean_opts
  ui_opt auto "自動検出（推奨）" "接続時にArduinoを自動で見つけます"
  for d in "${devs[@]}"; do ui_opt "$d" "$d" "検出されたシリアルポート"; done
  ui_opt manual "手動で入力" "ポート名を直接入力（例: /dev/ttyUSB0, COM3）"
  ui_menu "Arduino のシリアルポート指定" "中止" 0
  case "${UI_RESULT:-auto}" in
    auto) W_SERIAL="" ;;
    manual)
      ui_input "シリアルポート名" "" '^[A-Za-z0-9/._-]+$' "デバイスパスまたはCOM形式で入力"
      W_SERIAL="$UI_RESULT"
      ;;
    *) W_SERIAL="$UI_RESULT" ;;
  esac

  ui_input "Google Apps Script のウェブアプリ URL" "$W_GAS" '^(|https://script\.google\.com/macros/s/[^/[:space:]]+/exec/?([?#][^[:space:]]*)?)$' "https://script.google.com/macros/s/.../exec の形式で入力してください(未設定のままでも構いません)"
  W_GAS="$UI_RESULT"

  if ui_yesno "詳細設定（同期間隔・バックアップ方針など）も編集しますか？" no; then
    ui_number "同期間隔 SYNC_INTERVAL_MS（最小60000）" "$W_SYNC_INT" 60000 86400000
    W_SYNC_INT="$UI_RESULT"
    ui_number "バックアップ間隔 BACKUP_INTERVAL_MS（最小60000）" "$W_BACK_INT" 60000 86400000
    W_BACK_INT="$UI_RESULT"
    ui_number "バックアップ保持日数 BACKUP_RETENTION_DAYS" "$W_BACK_DAYS" 1 3650
    W_BACK_DAYS="$UI_RESULT"
    ui_number "バックアップ最大件数 BACKUP_MAX_COUNT" "$W_BACK_MAX" 1 1000
    W_BACK_MAX="$UI_RESULT"
    ui_input "外部ストレージ指定パス（空=自動検出）" "$W_EXT" '^(|/[^[:space:]]+)$' "絶対パス、または空欄"
    W_EXT="$UI_RESULT"
  fi

  apply_config_env
  ensure_manual_server_timezone
  step_done "config.env を更新しました（既存のSYNC_TOKEN等は保持）"
  show_effective_config
}

# ============================================================================
# 4) プラン確認
# ============================================================================
show_plan() {
  local i id
  ui_subtitle "セットアッププラン"
  printf "  ${C_GRAY_DIM}%s${C_RESET} ${C_CYAN}%s${C_RESET}\n" "プロファイル:" "${PROFILE:-kiosk}"
  printf "  実行する項目:\n"
  for i in "${!ITEMS[@]}"; do
    id="${ITEMS[$i]}"
    if is_sel "$id"; then
      printf "    ${C_GREEN}${MARK_ON}${C_RESET} ${ITEM_LABEL[$i]}\n"
    else
      printf "    ${C_GRAY_DIM}${MARK_OFF}${C_RESET} ${ITEM_LABEL[$i]}（スキップ）${C_RESET}\n"
    fi
  done
  echo ""
  ui_kv "管理者パスワード" "$(ui_mask "$(cfg_get ADMIN_PW)")"
  ui_kv "ポート" "$(cfg_get PORT)"

  if [ "$ASSUME_YES" -eq 0 ] && ui_is_tty; then
    if ui_yesno "この内容でセットアップを開始しますか？" yes; then
      return 0
    fi
    warn "中止しました。何も変更していません。"
    exit 0
  fi
}

# ============================================================================
# 各インストール項目の本体
# ============================================================================
run_time_reliability() {
  local timezone ntp_enabled synchronized

  ui_subtitle "パソコンの日付と時刻"
  if ! command -v timedatectl >/dev/null 2>&1; then
    step_warn "時刻設定を確認できません（timedatectl が見つかりません）。Linux Mint の標準機能を確認してください"
    return 0
  fi

  timezone=$(timedatectl show --property=Timezone --value 2>/dev/null || true)
  ntp_enabled=$(timedatectl show --property=NTP --value 2>/dev/null || true)

  if [ "$timezone" = "Asia/Tokyo" ]; then
    info "パソコンのタイムゾーン: 日本時間 (Asia/Tokyo)"
  else
    warn "パソコンのタイムゾーン: ${timezone:-確認できません}（日本時間 Asia/Tokyo ではありません）"
    if [ "$ASSUME_YES" -eq 0 ] && ui_is_tty; then
      if ui_yesno "パソコン全体のタイムゾーンを日本時間 (Asia/Tokyo) に変更しますか？" no; then
        if run_step "タイムゾーンを日本時間に変更中" -- sudo timedatectl set-timezone Asia/Tokyo; then
          timezone=$(timedatectl show --property=Timezone --value 2>/dev/null || true)
          if [ "$timezone" = "Asia/Tokyo" ]; then
            info "パソコンのタイムゾーンを日本時間に変更しました"
          fi
        else
          step_warn "タイムゾーンを変更できませんでした"
        fi
      fi
    fi
    if [ "$timezone" != "Asia/Tokyo" ]; then
      info "システムのタイムゾーンは変更していません。必要な場合は管理者に確認してください"
      info "変更する場合のコマンド: sudo timedatectl set-timezone Asia/Tokyo"
    fi
  fi

  if [ "$ntp_enabled" != "yes" ]; then
    info "インターネット時刻との自動同期が無効または未確認のため、有効化します..."
    if run_step "インターネット時刻との自動同期を有効化中" -- sudo timedatectl set-ntp true; then
      ntp_enabled=$(timedatectl show --property=NTP --value 2>/dev/null || true)
    else
      step_warn "自動時刻同期を有効にできませんでした。ネットワークまたは管理者設定を確認してください"
    fi
  fi
  if [ "$ntp_enabled" = "yes" ]; then
    info "インターネット時刻との自動同期: 有効"
  else
    step_warn "インターネット時刻との自動同期: 無効または確認できません"
    info "手動確認: timedatectl status"
  fi

  synchronized=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || true)
  if [ "$synchronized" = "yes" ]; then
    info "現在の時刻はインターネット時刻と同期済みです"
  else
    warn "時刻の同期はまだ確認できません。ネットワーク接続後に自動で同期されます"
  fi
  info "サーバーは、システム設定にかかわらず日本時間 (Asia/Tokyo) で動作します"
}

run_node() {
  local NEED_NODE=1 NODE_VER
  NODE_VER=$(get_node_version)
  if [ -n "$NODE_VER" ] && [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
    NEED_NODE=0
    step_done "Node.js v$(node -v 2>/dev/null | sed 's/^v//') が検出されました"
  else
    if [ -n "$NODE_VER" ]; then
      info "Node.js v${NODE_VER} は v18 以上が必要です。更新します..."
    fi
    if run_step "Node.js 20.x をインストール中" -- bash -c \
        'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs'; then
      step_done "Node.js 20.x のインストール完了"
    else
      step_error "Node.js のインストールに失敗しました"
      info "ログを確認してください: ${LOG_FILE}"
      exit 1
    fi
  fi
}

run_syspkgs() {
  run_step "build-essential, python3, ffmpeg, curl, zenity, x11-xserver-utils, xdotool, wmctrl を確認中" -- \
    sudo bash -c 'apt-get update -qq && apt-get install -y -qq build-essential python3 ffmpeg curl zenity x11-xserver-utils xdotool wmctrl'
  step_done "システムパッケージの準備完了"
}

run_fonts() {
  # キオスク画面自体は自己ホストの Web フォントで日本語を表示するが、
  # ウィンドウタイトルバーや Web フォント読み込み失敗時のフォールバックの
  # ため、OS側にも日本語フォントを入れておく。
  if fc-list 2>/dev/null | grep -qi "noto sans cjk"; then
    step_done "日本語フォントは既に導入済みです"
  else
    if run_step "日本語フォント（fonts-noto-cjk）を導入中" -- \
        sudo bash -c 'apt-get install -y -qq fonts-noto-cjk && fc-cache -f'; then
      step_done "日本語フォント（fonts-noto-cjk）を導入しました"
    else
      step_warn "日本語フォントの導入に失敗しました。ウィンドウタイトル等の日本語表示が崩れる可能性があります"
    fi
  fi
}

run_browser() {
  if command -v xdg-open >/dev/null 2>&1; then
    step_done "xdg-open が利用可能です"
  else
    run_step "xdg-utils（xdg-open）をインストール中" -- sudo apt-get install -y -qq xdg-utils || true
  fi

  if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 \
     || command -v google-chrome >/dev/null 2>&1 || command -v firefox >/dev/null 2>&1; then
    step_done "ブラウザが見つかりました"
  else
    if run_step "ブラウザ（Chromium）をインストール中" -- \
        sudo bash -c 'apt-get install -y -qq chromium || apt-get install -y -qq chromium-browser'; then
      step_done "ブラウザのインストール完了"
    else
      step_warn "ブラウザのインストールに失敗しました。手動でインストールしてください"
    fi
  fi
}

run_npm() {
  if run_step "npm install を実行中" -- npm install --loglevel=warn; then
    step_done "依存パッケージのインストール完了"
  else
    step_error "npm install に失敗しました"
    info "ログを確認してください: ${LOG_FILE}"
    exit 1
  fi
}

run_perms() {
  chmod +x "${PROJECT_DIR}/dls.sh" 2>/dev/null
  chmod +x "${PROJECT_DIR}/scripts/start.sh" 2>/dev/null
  chmod +x "${PROJECT_DIR}/scripts/stop.sh" 2>/dev/null
  chmod +x "${PROJECT_DIR}/scripts/uninstall.sh" 2>/dev/null
  chmod +x "${PROJECT_DIR}/scripts/kiosk-autostart.sh" 2>/dev/null
  chmod +x "${PROJECT_DIR}/scripts/board-watch.sh" 2>/dev/null
  chmod +x "${PROJECT_DIR}/scripts/run-server.sh" 2>/dev/null
  chmod +x "${PROJECT_DIR}/scripts/install.sh" 2>/dev/null
  step_done "dls.sh / 各スクリプトに実行権限を付与"
}

run_arduino() {
  # シリアルポート(/dev/ttyACM0, /dev/ttyUSB0等)は既定では dialout グループの
  # メンバーしか読み書きできない。CH340/CP2102/FTDI 等の互換クローン基板は
  # カーネルの自動設定から漏れて権限が絞られることがあるため、udevルールでも
  # 明示的に有効化しておく。
  local _CURRENT_USER
  _CURRENT_USER="$(whoami)"
  # バグ修正: sudo bash -c に埋め込む前にユーザー名を検証する
  # （' や $() 等のシェルメタ文字を含む不正名を root コマンド文字列へ
  #  注入できてしまうため）。
  _CURRENT_USER="$(validate_username "${_CURRENT_USER}")"
  if [ -z "${_CURRENT_USER}" ]; then
    step_warn "ユーザー名が不正なため、Arduinoシリアルポートの権限設定をスキップしました（rootで直接実行していますか？）"
    return
  fi
  if run_step "Arduinoシリアルポートの権限を設定中" -- sudo bash -c "
    groupadd -f dialout
    id '$_CURRENT_USER' | grep -qE '(^| )dialout( |$)' || usermod -aG dialout '$_CURRENT_USER'

    mkdir -p /etc/udev/rules.d
    cat > /etc/udev/rules.d/99-arduino.rules <<'RULES'
# Arduino / 互換基板の権限と安定したport名。dialoutグループに限定する。
SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"2341\", GROUP=\"dialout\", MODE=\"0660\", SYMLINK+=\"arduino\"
SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"2a03\", GROUP=\"dialout\", MODE=\"0660\", SYMLINK+=\"arduino\"
SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"1b4e\", GROUP=\"dialout\", MODE=\"0660\", SYMLINK+=\"arduino\"
SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"1a86\", GROUP=\"dialout\", MODE=\"0660\", SYMLINK+=\"arduino\"
SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"10c4\", GROUP=\"dialout\", MODE=\"0660\", SYMLINK+=\"arduino\"
SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"0403\", GROUP=\"dialout\", MODE=\"0660\", SYMLINK+=\"arduino\"
SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"303a\", GROUP=\"dialout\", MODE=\"0660\", SYMLINK+=\"arduino\"
RULES
    udevadm control --reload-rules 2>/dev/null || true
    udevadm trigger 2>/dev/null || true
  "; then
    step_done "Arduinoシリアルポートの権限を設定しました"
    printf "  ${C_GRAY}│${C_RESET} ${C_DIM}※ 反映には、いったんログアウトして再度ログインが必要です（dialout グループ反映のため）${C_RESET}\n"
  else
    step_warn "Arduinoシリアルポートの権限設定に失敗しました。手動で dialout グループへの追加が必要な場合があります"
  fi
}

run_config() {
  if [ -f "$CONFIG_FILE" ]; then
    chmod 600 "$CONFIG_FILE" 2>/dev/null
    step_done "config.env は設定済みです"
  else
    if [ -f "${PROJECT_DIR}/config.env.example" ]; then
      cp "${PROJECT_DIR}/config.env.example" "$CONFIG_FILE"
      chmod 600 "$CONFIG_FILE"
      step_done "config.env を作成しました（雛形）"
    else
      step_warn "config.env.example が見つからないため、config.env を作成できませんでした"
    fi
  fi
}

run_desktop() {
  if [ -f "${TPL_DIR}/device-lending-system.desktop" ]; then
    mkdir -p ~/.local/share/applications
    DESKTOP_DST=~/.local/share/applications/device-lending-system.desktop
    sed \
      -e "s|__EXEC__|${PROJECT_DIR}/scripts/start.sh|g" \
      -e "s|__ICON__|${PROJECT_DIR}/img/icon.png|g" \
      -e "s|__DIR__|${PROJECT_DIR}|g" \
      "${TPL_DIR}/device-lending-system.desktop" > "${DESKTOP_DST}"
    chmod 644 "${DESKTOP_DST}"
    step_done "デスクトップエントリを登録しました"
  else
    step_warn "デスクトップテンプレートが見つかりません。スキップします"
  fi
}

run_systemd() {
  chmod +x "${PROJECT_DIR}/scripts/run-server.sh" 2>/dev/null
  if command -v systemctl >/dev/null 2>&1 && [ -f "${TPL_DIR}/device-lending-system.service.template" ]; then
    mkdir -p ~/.config/systemd/user
    SERVICE_DST=~/.config/systemd/user/device-lending-system.service
    sed "s|__DIR__|${PROJECT_DIR}|g" \
      "${TPL_DIR}/device-lending-system.service.template" > "${SERVICE_DST}"

    if run_step "systemdサービスを登録中" -- bash -c \
        "systemctl --user daemon-reload && systemctl --user enable device-lending-system.service && systemctl --user start device-lending-system.service"; then
      step_done "自動再起動サービスを登録しました（クラッシュ時・再起動後、自動で復旧します）"
      if run_step "バックグラウンド常駐(linger)を有効化中" -- loginctl enable-linger "$(whoami)"; then
        info "バックグラウンド常駐(linger)を有効にしました"
      else
        step_warn "linger の有効化に失敗しました（動作には支障ありませんが、ログイン前は起動しない可能性があります）"
      fi
    else
      step_warn "systemdサービスの登録に失敗しました。従来通りstart.sh経由での起動になります"
      info "ログを確認してください: ${LOG_FILE}"
    fi
  else
    step_warn "systemctlが見つかりません。従来通りstart.sh経由での起動になります"
  fi
}

run_autokiosk() {
  local _CURRENT_USER
  _CURRENT_USER="$(whoami)"
  # バグ修正: ユーザー名を検証してから sudo bash -c 内へ埋め込む。
  _CURRENT_USER="$(validate_username "${_CURRENT_USER}")"
  chmod +x "${PROJECT_DIR}/scripts/kiosk-autostart.sh" 2>/dev/null

  # ① LightDMの自動ログイン
  if [ -d /etc/lightdm ]; then
    if [ -z "${_CURRENT_USER}" ]; then
      step_warn "ユーザー名が不正なため、自動ログインの設定をスキップしました"
    elif run_step "自動ログインを設定中" -- sudo bash -c "
      groupadd -f autologin
      gpasswd -a '${_CURRENT_USER}' autologin
      mkdir -p /etc/lightdm/lightdm.conf.d
      printf '[Seat:*]\nautologin-user=%s\nautologin-user-timeout=0\n' '${_CURRENT_USER}' > /etc/lightdm/lightdm.conf.d/60-device-lending-autologin.conf
    "; then
      step_done "自動ログインを設定しました（ユーザー: ${_CURRENT_USER}）"
    else
      step_warn "自動ログインの設定に失敗しました。手動で「ログインウィンドウ」設定から有効にしてください"
    fi
  else
    step_warn "LightDM が見つかりません（別のログイン画面を使用中の可能性）。自動ログインは手動設定が必要です"
  fi

  # ② ログイン後、キオスク画面を自動起動
  mkdir -p ~/.config/autostart
  if [ -f "${TPL_DIR}/kiosk-autostart.desktop.template" ]; then
    sed \
      -e "s|__DIR__|${PROJECT_DIR}|g" \
      -e "s|__ICON__|${PROJECT_DIR}/img/icon.png|g" \
      "${TPL_DIR}/kiosk-autostart.desktop.template" > ~/.config/autostart/device-lending-kiosk.desktop
    step_done "ログイン後の自動起動を設定しました"
  else
    step_warn "キオスク自動起動テンプレートが見つかりません。スキップします"
  fi

  # ③ 画面のスリープ・スクリーンセーバー・自動ロックを無効化
  if command -v gsettings >/dev/null 2>&1; then
    gsettings set org.cinnamon.desktop.screensaver lock-enabled false >> "${LOG_FILE}" 2>&1 || true
    gsettings set org.cinnamon.desktop.session idle-delay 0 >> "${LOG_FILE}" 2>&1 || true
    gsettings set org.cinnamon.settings-daemon.plugins.power sleep-display-ac 0 >> "${LOG_FILE}" 2>&1 || true
    gsettings set org.cinnamon.settings-daemon.plugins.power sleep-display-battery 0 >> "${LOG_FILE}" 2>&1 || true
    step_done "画面のスリープ・自動ロックを無効化しました"
  else
    step_warn "gsettings が見つかりません（Cinnamon以外のデスクトップ環境の可能性）。手動で電源設定を確認してください"
  fi
}

run_boardwatch() {
  # HDMI等で拡張ディスプレイが接続された時に、貸出状況ボード(board.html)を
  # 自動でキオスク表示する常駐スクリプト(scripts/board-watch.sh)を
  # ログイン時自動起動に登録する。xrandrに依存するため、未導入なら警告のみ
  # 出してスキップする(syspkgs項目でx11-xserver-utilsを導入していれば通常は不要)。
  chmod +x "${PROJECT_DIR}/scripts/board-watch.sh" 2>/dev/null

  if ! command -v xrandr >/dev/null 2>&1; then
    step_warn "xrandrが見つかりません（x11-xserver-utils未導入の可能性）。サブモニター自動検出はスキップします"
    return
  fi

  # board-watch.sh はディスプレイごとの正確な位置指定（--window-position /
  # --window-size）にChromiumのフラグを使う設計のため、Chromium専用である。
  # 「browser」項目（run_browser）は Firefox 等が既にあれば素通りしてしまい
  # Chromiumを入れないことがあるが、Linux Mintは標準でFirefoxが入っている
  # ため、その場合ここでChromiumが入らないままになり、サブモニター機能が
  # （メインのキオスク画面は動いているのに）気づかれないまま無効化されて
  # しまう事故が起きていた。そのため、他のブラウザの有無に関わらず、この
  # 機能専用にChromiumの有無を確認し、無ければここで導入する。
  if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
    step_warn "サブモニター表示にはChromiumが必要です（Firefox等が入っていても、この機能には使えません）。導入します"
    if run_step "Chromiumをインストール中（サブモニター表示用）" -- \
        sudo bash -c 'apt-get install -y -qq chromium || apt-get install -y -qq chromium-browser'; then
      step_done "Chromiumのインストール完了"
    else
      step_warn "Chromiumのインストールに失敗しました。サブモニター表示の自動検出は動作しません"
      info "手動で 'sudo apt install chromium' を実行してから、この項目を再実行してください"
      return
    fi
  fi

  # xdotool / wmctrl: --kiosk と --window-position の同時指定はウィンドウ
  # マネージャによっては座標指定が無視されメイン側でフルスクリーン化されて
  # しまうため、「位置指定で開く→ウィンドウが実際にそこへ来たのを確認して
  # からwmctrlでその場をEWMHフルスクリーン化する」という2段階方式を取って
  # いる（scripts/board-watch.sh 参照）。これが無いと配置指定はできても
  # 自動フルスクリーン化ができず、確実性が下がる。
  for _pkg in xdotool wmctrl; do
    if ! command -v "$_pkg" >/dev/null 2>&1; then
      step_warn "${_pkg}が見つかりません。サブモニターへの確実な全画面表示のために導入します"
      if run_step "${_pkg}をインストール中" -- sudo apt-get install -y -qq "$_pkg"; then
        step_done "${_pkg}のインストール完了"
      else
        step_warn "${_pkg}のインストールに失敗しました。表示位置は合っても全画面化されない場合があります"
      fi
    fi
  done

  mkdir -p ~/.config/autostart
  if [ -f "${TPL_DIR}/board-watch-autostart.desktop.template" ]; then
    sed \
      -e "s|__DIR__|${PROJECT_DIR}|g" \
      -e "s|__ICON__|${PROJECT_DIR}/img/icon.png|g" \
      "${TPL_DIR}/board-watch-autostart.desktop.template" > ~/.config/autostart/device-lending-board.desktop

    # 「次回ログインから有効」だと、設定した本人が今すぐ試そうとした時に
    # 動いておらず「機能していない」と誤解される（実際に起きた事故）。
    # ログイン時自動起動の設定ファイルは、あくまで“次にログインした時”に
    # セッションマネージャーが読みに行くものであり、今のセッションには
    # 反映されない。そのため、設定した直後にこの場でも起動しておく。
    if pgrep -f "scripts/board-watch.sh" >/dev/null 2>&1; then
      step_done "サブモニター表示の自動検出を設定しました（既に起動済みです）"
    else
      nohup "${PROJECT_DIR}/scripts/board-watch.sh" >/dev/null 2>&1 &
      disown
      step_done "サブモニター表示の自動検出を設定し、今すぐ起動しました（次回以降もログイン時に自動起動します）"
    fi
  else
    step_warn "board-watch-autostart.desktop.template が見つかりません。スキップします"
  fi
}

run_lockdown() {
  # キオスク画面が全画面から抜けられないようにする4層のロックダウンを施す。
  #   1. Chromium企業ポリシー: 開発者ツール・印刷・URL遷移などを禁止
  #   2. Cinnamonのキーボードショートカット: Alt+Tab/Superキー等を無効化
  #   3. X11: Ctrl+Alt+F1-F6の仮想端末切替、Ctrl+Alt+Backspaceを無効化
  #   4. 緊急脱出: Ctrl+Alt+Shift+Q のみを明示的に残し、他は逃げ道を塞ぐ

  # ① Chromium企業ポリシーの配置（Google Chromeには適用しない）
  if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
    step_warn "Chromiumが見つかりません。'sudo apt install chromium' 等でインストールしてから再実行してください。Chromeポリシーの配置をスキップします"
  elif [ -f "${TPL_DIR}/kiosk-policy.json.template" ]; then
    local _KIOSK_PORT
    _KIOSK_PORT=$(grep '^PORT=' "${CONFIG_FILE}" 2>/dev/null | cut -d= -f2-)
    _KIOSK_PORT="${_KIOSK_PORT:-3000}"
    # バグ修正: config.env の PORT を検証してから sed の置換文字列へ渡す。
    # 数値以外（シェルメタ文字）が入ると root 権限の sed コマンドへ
    # 注入できてしまうため。
    _KIOSK_PORT="$(validate_port "${_KIOSK_PORT}")"
    if [ -z "${_KIOSK_PORT}" ]; then
      step_warn "config.env の PORT が不正なため、Chromiumポリシー（ポート置換）をスキップしました"
    elif run_step "Chromiumポリシーを配置中" -- sudo bash -c "
      mkdir -p /etc/chromium/policies/managed
      sed 's/__PORT__/${_KIOSK_PORT}/g' '${TPL_DIR}/kiosk-policy.json.template' > /etc/chromium/policies/managed/device-lending-kiosk.json
    "; then
      step_done "Chromiumポリシー（開発者ツール禁止・URL制限等）を配置しました（Google Chromeには一切適用されません）"
    else
      step_warn "Chromiumポリシーの配置に失敗しました。手動で /etc/chromium/policies/managed/ に配置してください"
    fi
  else
    step_warn "kiosk-policy.json.template が見つかりません。Chromiumポリシーの配置をスキップします"
  fi

  # ② Cinnamonのキーボードショートカットを無効化
  if command -v gsettings >/dev/null 2>&1; then
    gsettings set org.cinnamon.desktop.keybindings.wm switch-windows "[]" >> "${LOG_FILE}" 2>&1 || true
    gsettings set org.cinnamon.desktop.keybindings.wm switch-windows-backward "[]" >> "${LOG_FILE}" 2>&1 || true
    gsettings set org.cinnamon.desktop.keybindings.wm switch-to-workspace-left "[]" >> "${LOG_FILE}" 2>&1 || true
    gsettings set org.cinnamon.desktop.keybindings.wm switch-to-workspace-right "[]" >> "${LOG_FILE}" 2>&1 || true
    gsettings set org.cinnamon.desktop.keybindings.media-keys terminal "[]" >> "${LOG_FILE}" 2>&1 || true
    gsettings set org.cinnamon.muffin overlay-key "" >> "${LOG_FILE}" 2>&1 || true
    # USB挿入時にファイルマネージャが自動で開かないようにする(自動マウントは維持)
    bash "${PROJECT_DIR}/scripts/disable-usb-filemanager.sh" >> "${LOG_FILE}" 2>&1 || true
    # 他アプリを起動できるショートカット・ホットコーナー等の無効化
    bash "${PROJECT_DIR}/scripts/apply-desktop-lockdown.sh" >> "${LOG_FILE}" 2>&1 || true
    step_done "Cinnamonのショートカットキー（Alt+Tab・Superキー等）を無効化しました"
  else
    step_warn "gsettings が見つかりません。Cinnamonショートカットの無効化をスキップします"
  fi

  # ③ VTスイッチとZapを無効化
  if [ -f "${TPL_DIR}/50-kiosk-no-vtswitch.conf" ]; then
    if run_step "仮想端末切替を無効化中" -- sudo bash -c "
      mkdir -p /etc/X11/xorg.conf.d
      cp '${TPL_DIR}/50-kiosk-no-vtswitch.conf' /etc/X11/xorg.conf.d/50-kiosk-no-vtswitch.conf
    "; then
      step_done "仮想端末切替(Ctrl+Alt+F1等)を無効化しました（次回ログイン以降に有効）"
    else
      step_warn "仮想端末切替の無効化に失敗しました。手動で /etc/X11/xorg.conf.d/ に配置してください"
    fi
  else
    step_warn "50-kiosk-no-vtswitch.conf が見つかりません。VTスイッチ無効化をスキップします"
  fi

  # ④ 管理者用「キオスク強制終了」ショートカット（Ctrl+Alt+Shift+Q）
  if command -v gsettings >/dev/null 2>&1; then
    local _KEYBIND_ID="device-lending-kiosk-exit"
    local _KEYBIND_PATH="/org/cinnamon/desktop/keybindings/custom-keybindings/${_KEYBIND_ID}/"
    local _EXISTING_LIST _NEW_LIST
    _EXISTING_LIST=$(gsettings get org.cinnamon.desktop.keybindings custom-keybindings 2>/dev/null || echo "@as []")
    if echo "$_EXISTING_LIST" | grep -qF "$_KEYBIND_PATH"; then
      _NEW_LIST="$_EXISTING_LIST"
    elif [ "$_EXISTING_LIST" = "@as []" ] || [ "$_EXISTING_LIST" = "[]" ]; then
      _NEW_LIST="['${_KEYBIND_PATH}']"
    else
      _NEW_LIST=$(echo "$_EXISTING_LIST" | sed "s#]\$#, '${_KEYBIND_PATH}']#")
    fi
    gsettings set org.cinnamon.desktop.keybindings custom-keybindings "$_NEW_LIST" >> "${LOG_FILE}" 2>&1 || true
    gsettings set "org.cinnamon.desktop.keybindings.custom-keybinding:${_KEYBIND_PATH}" name "端末貸出管理システム: キオスク強制終了" >> "${LOG_FILE}" 2>&1 || true
    gsettings set "org.cinnamon.desktop.keybindings.custom-keybinding:${_KEYBIND_PATH}" command "/bin/bash ${PROJECT_DIR}/scripts/exit-kiosk.sh" >> "${LOG_FILE}" 2>&1 || true
    gsettings set "org.cinnamon.desktop.keybindings.custom-keybinding:${_KEYBIND_PATH}" binding "['<Primary><Alt><Shift>q']" >> "${LOG_FILE}" 2>&1 || true
    step_done "緊急脱出ショートカット（Ctrl+Alt+Shift+Q）を登録しました。サーバー停止中でもキオスク画面を閉じられます"
  else
    step_warn "gsettings が見つかりません。緊急脱出ショートカットの登録をスキップします（サーバー停止時にキオスク画面を閉じる手段がなくなります）"
  fi
}

# 自己ホスト日本語フォント（6ウェイト）の配置チェック
run_font_check() {
  local _FONT_OK=1 w f _SIZE
  info "自己ホスト日本語フォント（fonts/*.woff2）を確認中..."
  for w in 400 500 600 700 800 900; do
    f="${LINUX_APP_DIR}/fonts/noto-sans-jp-${w}.woff2"
    if [ ! -f "$f" ]; then
      step_warn "フォントファイルが見つかりません: fonts/noto-sans-jp-${w}.woff2"
      _FONT_OK=0
      continue
    fi
    _SIZE=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0)
    if [ "$_SIZE" -lt 100000 ]; then
      step_warn "フォントファイルのサイズが異常に小さいです（壊れているか、プレースホルダーの可能性）: fonts/noto-sans-jp-${w}.woff2 (${_SIZE} bytes)"
      _FONT_OK=0
    fi
  done
  if [ "$_FONT_OK" -eq 1 ]; then
    step_done "日本語フォント（自己ホスト6ファイル）は正しく配置されています"
  else
    step_warn "日本語フォントに問題があります。fonts/ ディレクトリ内の 6 つの woff2 ファイルを確認してください"
    info "この状態のまま起動すると、キオスク画面の日本語が □□□ のように表示されます"
  fi
}

finish_summary() {
  ui_success_banner "セットアップ完了"
  echo ""
  printf "  ${C_BOLD}現在の設定:${C_RESET}\n"
  printf "    ${C_CYAN}${I_DOT}${C_RESET} 管理者パスワード: ${C_CYAN}%s${C_RESET}\n" "$(ui_mask "$(cfg_get ADMIN_PW)")"
  printf "    ${C_CYAN}${I_DOT}${C_RESET} ポート: ${C_CYAN}%s${C_RESET}\n" "$(cfg_get PORT)"
  echo ""
  printf "  ${C_GRAY_DIM}    パスワードを忘れた場合は config.env の ADMIN_PW= を確認してください${C_RESET}\n"
  echo ""

  printf "  ${C_BOLD}起動方法:${C_RESET}\n"
  printf "    ${I_BULLET} ${C_CYAN}ランチャー（丸ボタン）${C_RESET} → 「端末貸出管理システム」を検索\n"
  printf "    ${I_BULLET} ${C_CYAN}ターミナル${C_RESET} → ./dls.sh（対話式メニューで起動/停止/設定を選べます）\n"
  echo ""
  printf "  ${C_BOLD}停止方法:${C_RESET}\n"
  printf "    ${I_BULLET} ${C_CYAN}ターミナル${C_RESET} → ./dls.sh のメニューから「停止」を選択\n"
  echo ""
  printf "  ${C_BOLD}アンインストール方法:${C_RESET}\n"
  printf "    ${I_BULLET} ${C_CYAN}ターミナル${C_RESET} → ./dls.sh のメニューから「アンインストール」を選択\n"
  echo ""
  printf "  ${C_BOLD}Arduino 使用時:${C_RESET}\n"
  printf "    USBケーブルで接続するだけでも認識されます。\n"
  printf "    初回セットアップ後は一度ログアウト→ログインしてください（dialout反映）\n"
  echo ""
  printf "  ${C_BOLD}メール・シート同期について:${C_RESET}\n"
  printf "    ${C_DIM}故障・延滞などの通知メールは既定ではOFFです（送信されません）。${C_RESET}\n"
  printf "    ${C_DIM}必要な場合のみ、管理画面の「設定」タブでONにしてください。${C_RESET}\n"
  if [ -n "$(cfg_get GAS_URL)" ]; then
    printf "    ${C_DIM}※ スプレッドシート同期: GAS_URL が設定済みなので有効です。${C_RESET}\n"
  else
    printf "    ${C_DIM}※ スプレッドシート同期: 既定のGAS_URLを使用します。${C_RESET}\n"
    printf "    ${C_DIM}   初回同期前に、GASスクリプトエディタで resetSyncPairing() を実行してください。${C_RESET}\n"
  fi
  echo ""
  printf "  ${C_BOLD}カメラについて:${C_RESET}\n"
  printf "    ${C_DIM}キオスク用のカメラ/マイク許可は Chromium の企業ポリシーで、${C_RESET}\n"
  printf "    ${C_DIM}このアプリ（localhost）に対してのみ自動許可されています。${C_RESET}\n"
  printf "    ${C_DIM}許可ダイアログは表示されないため、操作は必要ありません。${C_RESET}\n"
  echo ""
  printf "  ${C_DIM}インストールログ: ${LOG_FILE}${C_RESET}\n"
  echo ""
}

# ============================================================================
# メイン処理
# ============================================================================

# --- 設定変更のみモード（インストールは行わない） ---
if [ "$CONFIG_ONLY" -eq 1 ]; then
  print_header
  if ! ui_is_tty; then
    warn "設定の変更は対話的なターミナルからのみ実行できます"
    exit 1
  fi
  load_wizard_defaults
  run_wizard
  echo ""
  info "変更内容は config.env に保存されました。次回起動時に反映されます。"
  exit 0
fi

build_item_defs
print_header

info "事前チェックを実行しています..."
if ! check_prereqs; then
  step_error "事前チェックに失敗しました。上記のエラーを確認してください"
  exit 1
fi
step_done "事前チェック完了"

choose_profile
choose_items

load_wizard_defaults
if [ "$ASSUME_YES" -eq 0 ] && is_sel config && [ "$SKIP_WIZARD" -eq 0 ] && ui_is_tty; then
  run_wizard
fi
if [ -z "$SELECTED" ]; then
  warn "実行する項目がありません。中止します。"
  exit 0
fi

show_plan
run_time_reliability

# --- 実行 ---
TOTAL_STEPS=0
for id in "${ORDER[@]}"; do is_sel "$id" && TOTAL_STEPS=$((TOTAL_STEPS + 1)); done
CUR=0
for id in "${ORDER[@]}"; do
  if is_sel "$id"; then
    CUR=$((CUR + 1))
    step "$CUR" "$TOTAL_STEPS" "$(item_label "$id")"
    # 言語依存を避けるため直接 run_${id} を呼ぶ（引数なし）
    case "$id" in
      node) run_node ;;
      syspkgs) run_syspkgs ;;
      fonts) run_fonts ;;
      browser) run_browser ;;
      npm) run_npm ;;
      perms) run_perms ;;
      arduino) run_arduino ;;
      config) run_config ;;
      desktop) run_desktop ;;
      systemd) run_systemd ;;
      autokiosk) run_autokiosk ;;
      boardwatch) run_boardwatch ;;
      lockdown) run_lockdown ;;
    esac
  else
    step_skip "スキップ: $(item_label "$id")"
  fi
done

# config項目が選択されていなくても、config.env が未作成なら雛形を作る
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "${PROJECT_DIR}/config.env.example" ]; then
    cp "${PROJECT_DIR}/config.env.example" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    step_done "config.env を作成しました（雛形）"
  fi
fi
ensure_manual_server_timezone
info "手動起動を含む Node.js サーバーのタイムゾーンを日本時間に設定しました"

run_font_check

finish_summary