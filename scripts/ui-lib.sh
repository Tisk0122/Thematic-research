#!/bin/bash
# ============================================================================
# 端末貸出管理システム - 共通ターミナルUIライブラリ
# ----------------------------------------------------------------------------
# install.sh / start.sh / stop.sh / uninstall.sh / kiosk-autostart.sh /
# run-server.sh から共通で読み込まれる。配色・記号・スピナー・進捗バーの
# 見た目をここ一箇所にまとめることで、全スクリプトの表示に一貫性を持たせる。
#
# 使い方（各スクリプトの先頭付近）:
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ui-lib.sh"
#
# 非対応端末（パイプ出力・dumb端末・UTF-8非対応ロケール）では自動的に
# 色や記号をプレーンテキストへフォールバックする。
# ============================================================================

# 二重読み込み防止
if [ -n "${UI_LIB_LOADED:-}" ]; then return 0 2>/dev/null || exit 0; fi
UI_LIB_LOADED=1

# --- UTF-8対応判定（非対応ロケールでは記号をASCIIに落とす） ---
UI_UTF8=1
case "${LC_ALL:-}${LC_CTYPE:-}${LANG:-}" in
  *[Uu][Tt][Ff]8*|*[Uu][Tt][Ff]-8*) UI_UTF8=1 ;;
  "") UI_UTF8=1 ;;
  *) UI_UTF8=0 ;;
esac

# --- 端末幅（罫線の長さに使用。CJK文字幅計算の破綻を避けるため罫線は
#     固定長のシンプルな横線のみとし、箱囲みの右辺揃えは行わない） ---
ui_rule() {
  local n="${1:-56}"
  local line
  printf -v line '%*s' "$n" ''
  printf '%s' "${line// /${I_BOX_H}}"
}

# --- カラー定義（非対話端末・パイプ・dumb端末では自動無効化） ---
# 256色を無条件に前提にすると、256色に対応していない端末
#（Linuxコンソール/tty・一部のSSHクライアント・古いターミナルエミュレータ等）
# ではエスケープシーケンスが正しく解釈されず、色が薄すぎて見えない・
# 意図しない色になる等「見にくい」原因になる。そのため実際の色数を
# tput colors で確認し、256色対応時のみ拡張パレットを使い、
# それ以外は標準16色+太字の組み合わせにフォールバックする
# （どんなカラー端末でも確実に視認できる、最も安全な組み合わせ）。
if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${NO_COLOR:-}" ]; then
  UI_COLOR=1
  UI_COLOR_N=8
  if command -v tput >/dev/null 2>&1; then
    _ui_ncolors=$(tput colors 2>/dev/null || echo 8)
    [[ "$_ui_ncolors" =~ ^[0-9]+$ ]] && UI_COLOR_N="$_ui_ncolors"
  fi
else
  UI_COLOR=0
  UI_COLOR_N=0
fi

if [ "$UI_COLOR" = "1" ] && [ "$UI_COLOR_N" -ge 256 ]; then
  # 256色対応端末: はっきり見分けやすいよう主要な色は太字を基本にする
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'; C_UNDER='\033[4m'; C_REV='\033[7m'
  C_RED='\033[1;38;5;203m';    C_GREEN='\033[1;38;5;114m'; C_YELLOW='\033[1;38;5;221m'
  C_BLUE='\033[1;38;5;75m';    C_CYAN='\033[1;38;5;80m';    C_PURPLE='\033[1;38;5;141m'
  C_WHITE='\033[1;97m';        C_GRAY='\033[38;5;250m';     C_GRAY_DIM='\033[38;5;244m'
elif [ "$UI_COLOR" = "1" ]; then
  # 16色までしか無い端末: 256色前提のコードをそのまま送ると文字化けたり
  # 極端に薄く見える場合があるため、必ず標準色(30-37系)に切り替える
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'; C_UNDER='\033[4m'; C_REV='\033[7m'
  C_RED='\033[1;31m';   C_GREEN='\033[1;32m';  C_YELLOW='\033[1;33m'
  C_BLUE='\033[1;34m';  C_CYAN='\033[1;36m';   C_PURPLE='\033[1;35m'
  C_WHITE='\033[1;37m'; C_GRAY='\033[37m';     C_GRAY_DIM='\033[2;37m'
else
  UI_COLOR=0
  C_RESET=''; C_BOLD=''; C_DIM=''; C_UNDER=''; C_REV=''
  C_RED=''; C_GREEN=''; C_YELLOW=''
  C_BLUE=''; C_CYAN=''; C_PURPLE=''
  C_WHITE=''; C_GRAY=''; C_GRAY_DIM=''
fi

# 互換性のため（既存スクリプトが参照していた変数名）
DIVIDER="$(printf '%56s' '' | tr ' ' '─')"

# --- 記号・スピナー・進捗バー用文字 ---
if [ "$UI_UTF8" = "1" ]; then
  I_OK="✓"; I_ERR="✗"; I_WARN="⚠"; I_INFO="ℹ"; I_ARROW="❯"; I_BULLET="・"
  I_DIAMOND="◆"; I_BOX_H="─"; I_PIPE="│"; I_DOT="●"
  I_RAIL="┆"; MARK_ON="●"; MARK_OFF="○"
  SPIN_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
  BAR_FULL="█"; BAR_EMPTY="░"
else
  I_OK="OK"; I_ERR="NG"; I_WARN="!"; I_INFO="i"; I_ARROW=">"; I_BULLET="-"
  I_DIAMOND="#"; I_BOX_H="-"; I_PIPE="|"; I_DOT="*"
  I_RAIL="|"; MARK_ON="[x]"; MARK_OFF="[ ]"
  SPIN_FRAMES=('|' '/' '-' '\')
  BAR_FULL="#"; BAR_EMPTY="."
fi
UI_SPIN_LEN=${#SPIN_FRAMES[@]}

# ============================================================================
# 基本メッセージ関数
# ============================================================================
ui_header() {
  # ui_header "タイトル" "サブタイトル"
  local title="$1" subtitle="$2"
  echo ""
  if [ -n "$subtitle" ]; then
    echo -e "${C_CYAN}${C_BOLD}${I_DIAMOND} ${title}${C_RESET}  ${C_PURPLE}${subtitle}${C_RESET}"
  else
    echo -e "${C_CYAN}${C_BOLD}${I_DIAMOND} ${title}${C_RESET}"
  fi
  echo -e "${C_GRAY}$(ui_rule 56)${C_RESET}"
}

ui_kv() {
  # ui_kv "ラベル" "値"
  printf "${C_DIM}  %-12s${C_RESET} ${C_CYAN}%s${C_RESET}\n" "$1" "$2"
}

info()    { echo -e "  ${C_DIM}$1${C_RESET}"; }
success() { echo -e "  ${C_GREEN}${I_OK}${C_RESET} $1"; }
warn()    { echo -e "  ${C_YELLOW}${I_WARN}${C_RESET} ${C_YELLOW}$1${C_RESET}"; }
error()   { echo -e "  ${C_RED}${I_ERR}${C_RESET} ${C_RED}$1${C_RESET}" >&2; }

# 旧関数名との互換エイリアス（各スクリプトの既存呼び出しを壊さないため）
step_done()  { success "$1"; }
step_warn()  { warn "$1"; }
step_error() { error "$1"; }
step_skip()  { echo -e "  ${C_GRAY}${I_BULLET}${C_RESET} ${C_DIM}$1${C_RESET}"; }

ui_success_banner() {
  echo ""
  echo -e "${C_GREEN}${C_BOLD}${I_OK} $1${C_RESET}"
  echo -e "${C_GRAY}$(ui_rule 56)${C_RESET}"
}

ui_error_banner() {
  echo ""
  echo -e "${C_RED}${C_BOLD}${I_ERR} $1${C_RESET}"
  echo -e "${C_GRAY}$(ui_rule 56)${C_RESET}"
}

# ============================================================================
# ステップ表示（進捗バー付き）
#   step <現在> <合計> "ラベル"
# ============================================================================
ui_bar() {
  local current="$1" total="$2" width="${3:-16}"
  [ "$total" -le 0 ] && total=1
  local filled=$(( current * width / total ))
  [ "$filled" -gt "$width" ] && filled=$width
  [ "$filled" -lt 0 ] && filled=0
  local empty=$(( width - filled ))
  local bar="" i
  for ((i = 0; i < filled; i++)); do bar+="${BAR_FULL}"; done
  for ((i = 0; i < empty; i++)); do bar+="${BAR_EMPTY}"; done
  printf '%s' "$bar"
}

step() {
  local current="$1" total="$2" label="$3"
  local bar; bar="$(ui_bar "$current" "$total" 16)"
  echo ""
  echo -e "${C_GRAY}[${C_CYAN}${bar}${C_GRAY}]${C_RESET} ${C_GRAY_DIM}${current}/${total}${C_RESET}  ${C_CYAN}${C_BOLD}${I_ARROW}${C_RESET} ${C_BOLD}${label}${C_RESET}"
}

# ============================================================================
# スピナー
#   ui_spin_char <index>  -> 現在フレームの文字を返す
#   ui_spin_line "ラベル" <経過秒> <index> ["補足"]  -> 1行その場更新で描画
# ============================================================================
ui_spin_char() {
  echo "${SPIN_FRAMES[$(( $1 % UI_SPIN_LEN ))]}"
}

ui_spin_line() {
  local label="$1" elapsed="$2" idx="$3" hint="$4"
  local frame; frame="$(ui_spin_char "$idx")"
  if [ -n "$hint" ]; then
    printf "\r\033[K  ${C_CYAN}%s${C_RESET} ${C_DIM}%s${C_RESET} ${C_GRAY_DIM}%ss${C_RESET}  ${C_GRAY_DIM}(%s)${C_RESET}" "$frame" "$label" "$elapsed" "$hint"
  else
    printf "\r\033[K  ${C_CYAN}%s${C_RESET} ${C_DIM}%s${C_RESET} ${C_GRAY_DIM}%ss${C_RESET}" "$frame" "$label" "$elapsed"
  fi
}

ui_spin_clear() { printf "\r\033[K"; }

# ============================================================================
# ログ行の色付き引用出力（tail表示用）
# ============================================================================
ui_print_log_tail() {
  local log_file="$1" from_line="$2" line
  tail -n +"${from_line}" "${log_file}" 2>/dev/null | while IFS= read -r line; do
    echo -e "  ${C_GRAY}${I_PIPE}${C_RESET} ${line}"
  done
}

# ============================================================================
# server.jsonl（1行1JSON: {"ts":...,"level":...,"msg":...}）を、
# 人が読みやすい1行テキストへ整形して出力する。
#   ui_print_jsonl_tail <ファイル> <件数> [レベルフィルタ(カンマ区切り)]
# レベルフィルタ例: "エラー,警告" のように日本語表示名で指定する
# （情報/警告/エラー/デバッグ）。空なら全件。
# 依存: python3（無い場合は生のJSON行をそのまま簡易表示にフォールバックする）
# ============================================================================
ui_print_jsonl_tail() {
  local log_file="$1" count="${2:-30}" filter="${3:-}"
  [ -f "$log_file" ] || return 0

  if command -v python3 >/dev/null 2>&1; then
    UI_JSONL_COLOR="$UI_COLOR" UI_JSONL_FILTER="$filter" python3 - "$log_file" "$count" <<'PYEOF'
import json, sys, os

path, count = sys.argv[1], int(sys.argv[2])
use_color = os.environ.get("UI_JSONL_COLOR") == "1"
filt = os.environ.get("UI_JSONL_FILTER", "").strip()
allowed = set(x.strip() for x in filt.split(",") if x.strip()) if filt else None

COLORS = {
    "エラー": "\033[1;31m", "警告": "\033[1;33m",
    "情報": "\033[1;32m", "デバッグ": "\033[1;36m",
}
RESET = "\033[0m"
GRAY = "\033[90m"

rows = []
try:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            lv = obj.get("level", "")
            if allowed is not None and lv not in allowed:
                continue
            rows.append(obj)
except FileNotFoundError:
    sys.exit(0)

rows = rows[-count:]
if not rows:
    print("  （該当するログはありません）")
    sys.exit(0)

for obj in rows:
    ts = obj.get("ts", "")
    # ISO8601 → "MM-DD HH:MM:SS" に短縮（日付を跨ぐ運用でも月日だけは分かるようにする）
    ts_short = ts
    if "T" in ts:
        d, t = ts.split("T", 1)
        t = t.split(".")[0].split("Z")[0]
        ts_short = f"{d[5:]} {t}"
    lv = obj.get("level", "")
    msg = obj.get("msg", "")
    if use_color:
        c = COLORS.get(lv, "")
        print(f"  {GRAY}{ts_short}{RESET} {c}[{lv:^4}]{RESET} {msg}")
    else:
        print(f"  {ts_short} [{lv}] {msg}")
PYEOF
  else
    # python3が無い環境向けの簡易フォールバック（整形はできないがエラーにはしない）
    tail -n "$count" "$log_file" 2>/dev/null | while IFS= read -r line; do
      echo -e "  ${C_GRAY}${I_PIPE}${C_RESET} ${line}"
    done
  fi
}

# ============================================================================
# 対話型ウィジェット（Opencode風メニュー・チェックリスト・入力）
# ----------------------------------------------------------------------------
# ターミナル(TTY)上ではカーソルキー(↑↓/PgUp/PgDn)で操作できる選択UIを表示し、
# 非TTY(パイプ・自動実行・デスクトップアイコン起動)では番号入力へ自動フォールバック
# する。これによりinstall.sh等を「何も見えない環境」から呼んでも固まらない。
#
# 使い方:
#   ui_clean_opts
#   ui_opt "<値>" "<表示ラベル>" "<補足(省略可)>"
#   ui_menu "タイトル" ["中止ラベル"] [既定インデックス]
#       -> UI_RESULT(選択値) / UI_RESULT_IDX(-1=中止)
#   ui_checkboxes "タイトル" ["中止ラベル"]
#       -> UI_RESULT_SEL(選択インデックス列) / UI_RESULT_ITEMS(選択値の列・空白区切り)
#   ui_yesno "質問文" [yes|no]    # 0=はい / 1=いいえ
#   ui_input "ラベル" [既定値] [検証regex] [エラー文]
#       -> UI_RESULT(入力値。Escまたは3回エラーで既定値に戻る)
#   ui_password "ラベル" [既定値] [検証regex] [エラー文]
#       -> UI_RESULT(既定値はマスク表示)
#   ui_number "ラベル" [既定値] [min] [max] -> UI_RESULT
# ============================================================================

UI_OPTIONS=(); UI_LABELS=(); UI_DESC=()
UI_RESULT=''; UI_RESULT_IDX=-1
UI_RESULT_SEL=''; UI_RESULT_ITEMS=''

ui_clean_opts() { UI_OPTIONS=(); UI_LABELS=(); UI_DESC=(); }

ui_opt() {
  UI_OPTIONS+=("$1")
  UI_LABELS+=("$2")
  UI_DESC+=("${3:-}")
}

ui_is_tty() { [ -t 0 ] && [ -t 1 ]; }

UI_COLS=80
if command -v tput >/dev/null 2>&1; then
  _ui_tcols=$(tput cols 2>/dev/null || echo 80)
  if [[ "$_ui_tcols" =~ ^[0-9]+$ ]] && [ "$_ui_tcols" -ge 40 ]; then
    UI_COLS="$_ui_tcols"
  fi
fi

UI_MENU_MAX_ROWS=8

# --- キー入力の単一文字取得（矢印・Enter・Space・q等を識別） ---
ui_read_key() {
  local c seq2
  IFS= read -rsn1 c 2>/dev/null || { printf 'none'; return; }
  [ -z "$c" ] && { printf 'enter'; return; }
  case "$c" in
    $'\e')
      if IFS= read -rsn2 -t 0.03 seq2 2>/dev/null; then
        case "$seq2" in
          '[A'|'OA') printf 'up' ;;
          '[B'|'OB') printf 'down' ;;
          '[C'|'OC') printf 'right' ;;
          '[D'|'OD') printf 'left' ;;
          '[5~') printf 'pgup' ;;
          '[6~') printf 'pgdn' ;;
          *) printf 'other:%s' "$seq2" ;;
        esac
      else
        printf 'esc'
      fi
      ;;
    $'\r'|$'\n') printf 'enter' ;;
    ' ') printf 'space' ;;
    $'\x7f'|$'\x08') printf 'backspace' ;;
    a|A) printf 'all' ;;
    n|N) printf 'none' ;;
    q|Q) printf 'q' ;;
    *) printf 'char:%s' "$c" ;;
  esac
}

# --- 選択リスト補助 ---
ui_sel_contains() {
  local i="$1"; shift
  for w in "$@"; do [ "$w" = "$i" ] && return 0; done
  return 1
}

ui_toggle_sel() {
  local i="$1" s="$2" out='' w found=0
  for w in $s; do
    if [ "$w" = "$i" ]; then found=1; else out="$out $w"; fi
  done
  if [ "$found" -eq 1 ]; then
    printf '%s' "${out# }"
  else
    printf '%s' "${s:+$s $i}"
  fi
}

ui_all_sel() {
  local o='' i
  for ((i = 0; i < "$1"; i++)); do o="$o $i"; done
  printf '%s' "${o# }"
}

# --- メニュー/チェックリストの共通描画 ---
# 再描画のたびに「直前に描画した行数だけカーソルを上へ戻し、そこから
# 画面下端まで消去してから描き直す」方式にしている。
# 以前は ANSI のカーソル位置保存/復元（\e[s / \e[u）を使っていたが、
# \e[s が保存するのは画面バッファ上の絶対座標のため、描画中に端末が
# 1行でもスクロールすると復元先がずれてしまい、選択を変えるたびに
# 描画が一段ずつ下にずれて残り続ける（＝メニューがどんどん複製されて
# 見え続ける）不具合があった。実際に描画した行数を毎回数えて記録し、
# 次回はその行数分だけ相対的にカーソルを上へ戻すことで、スクロールの
# 有無に関わらず必ず直前の描画位置に正しく戻れるようにしている。
UI_PICKER_DRAWN_LINES=0

ui_picker_render() {
  local mode="$1" title="$2" cancel_lbl="$3" top="$4" sel="$5" rows="$6" selstr="$7"
  local n="${#UI_OPTIONS[@]}" i shown=0 idx label desc mk lines=0

  # 直前の描画行数だけ上へ戻り、そこから画面末尾までを消去する
  # （初回描画時は UI_PICKER_DRAWN_LINES=0 なので何もしない）。
  if [ "$UI_PICKER_DRAWN_LINES" -gt 0 ]; then
    printf '\r\e[%dA\e[0J' "$UI_PICKER_DRAWN_LINES"
  fi

  # 端末幅より長い行は折り返されて行数が想定とずれ、上の消去計算が
  # 壊れる原因になるため、ラベル・補足は実際の端末幅に収まる長さへ
  # 動的に切り詰める（固定の22/56文字ではなく UI_COLS を基準にする）。
  local avail=$((UI_COLS - 14)); [ "$avail" -lt 24 ] && avail=24
  local label_max=22
  local desc_max=$((avail - label_max)); [ "$desc_max" -lt 8 ] && desc_max=8

  printf "  ${C_GRAY}${I_RAIL}${C_RESET} ${C_CYAN}${C_BOLD}${I_DIAMOND}${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$title"; lines=$((lines + 1))
  printf "  ${C_GRAY}${I_RAIL}%s${C_RESET}\n" "$(ui_rule 52)"; lines=$((lines + 1))
  for ((i = top; i < n && shown < rows; i++, shown++)); do
    label="${UI_LABELS[$i]}"
    desc="${UI_DESC[$i]}"
    [ "${#label}" -gt "$label_max" ] && label="${label:0:label_max}"
    [ "${#desc}" -gt "$desc_max" ] && desc="${desc:0:desc_max}"

    if [ "$i" -eq "$sel" ]; then
      # 選択中の行は反転表示（背景と文字色を入れ替える）の1本の帯にする。
      # 色の濃淡ではなく「行全体の背景が変わる」ことで選択位置を示すため、
      # 色数の少ない端末や配色の相性が悪い環境でも確実に見分けられる。
      # 帯の内部では色を切り替えない（C_RESETを挟むと反転が解除されて
      # しまうため）。
      if [ "$mode" = "multi" ]; then
        if ui_sel_contains "$i" $selstr; then mk="${MARK_ON} "; else mk="${MARK_OFF} "; fi
      else
        mk=""
      fi
      printf "  ${C_GRAY}${I_RAIL}${C_RESET} ${C_REV}${C_BOLD} ${I_ARROW} %s%s" "$mk" "$label"
      [ -n "$desc" ] && printf "  %s" "$desc"
      printf " ${C_RESET}\n"
    else
      if [ "$mode" = "multi" ]; then
        if ui_sel_contains "$i" $selstr; then mk="${C_GREEN}${MARK_ON}${C_RESET} "; else mk="${C_GRAY_DIM}${MARK_OFF}${C_RESET} "; fi
      else
        mk="  "
      fi
      printf "  ${C_GRAY}${I_RAIL}${C_RESET}   ${mk}${label}"
      if [ -n "$desc" ] && [ "$mode" = "multi" ]; then
        printf "  ${C_GRAY_DIM}%s${C_RESET}" "$desc"
      fi
      printf "\n"
    fi
    lines=$((lines + 1))
  done
  for ((; shown < rows; shown++)); do printf "  ${C_GRAY}${I_RAIL}${C_RESET}\n"; lines=$((lines + 1)); done
  printf "  ${C_GRAY}${I_RAIL}%s${C_RESET}\n" "$(ui_rule 52)"; lines=$((lines + 1))
  if [ "$mode" = "multi" ]; then
    printf "  ${C_GRAY_DIM}${I_RAIL} ↑↓/PgUp/PgDn=移動  Space=切替  a=全選択  n=解除"
    [ -n "$cancel_lbl" ] && printf "  q=中止"
    printf "  Enter=決定${C_RESET}\n"
  else
    printf "  ${C_GRAY_DIM}${I_RAIL} ↑↓/PgUp/PgDn=移動  数字=ジャンプ  Enter=決定"
    [ -n "$cancel_lbl" ] && printf "  q=中止"
    printf "   [Esc=${cancel_lbl:-戻る}]${C_RESET}\n"
  fi
  lines=$((lines + 1))

  UI_PICKER_DRAWN_LINES="$lines"
}

# --- 共通選択ループ（single / multi） ---
ui_picker() {
  local mode="$1" title="$2" cancel_lbl="$3"
  local sel="${4:-0}" selstr="$5" n="${#UI_OPTIONS[@]}"
  local top=0 rows=$UI_MENU_MAX_ROWS key ch
  [ "$n" -eq 0 ] && return 1
  [ "$rows" -gt "$n" ] && rows="$n"
  [ "$sel" -ge "$n" ] && sel=0

  if ! ui_is_tty; then
    ui_picker_fallback "$mode" "$title" "$cancel_lbl" "$sel" "$selstr"
    return $?
  fi

  local old_stty
  old_stty=$(stty -g 2>/dev/null || true)
  stty -icanon -echo 2>/dev/null || true
  UI_PICKER_DRAWN_LINES=0

  while :; do
    ui_picker_render "$mode" "$title" "$cancel_lbl" "$top" "$sel" "$rows" "$selstr"
    key=$(ui_read_key)
    case "$key" in
      up)   [ "$sel" -gt 0 ] && sel=$((sel - 1)); [ "$sel" -lt "$top" ] && top="$sel" ;;
      down) [ "$sel" -lt "$((n - 1))" ] && sel=$((sel + 1)); if [ "$sel" -ge "$((top + rows))" ]; then top=$((sel - rows + 1)); fi ;;
      pgup) sel=$((sel - rows)); [ "$sel" -lt 0 ] && sel=0; top="$sel" ;;
      pgdn) sel=$((sel + rows)); [ "$sel" -ge "$n" ] && sel=$((n - 1)); if [ "$sel" -ge "$((top + rows))" ]; then top=$((sel - rows + 1)); fi ;;
      enter) break ;;
      space) [ "$mode" = "multi" ] && selstr=$(ui_toggle_sel "$sel" "$selstr") ;;
      all)   [ "$mode" = "multi" ] && selstr=$(ui_all_sel "$n") ;;
      none)  [ "$mode" = "multi" ] && selstr='' ;;
      q|esc) [ -n "$cancel_lbl" ] && { sel=-1; break; } ;;
      char:*)
        ch="${key#char:}"
        if [ "$mode" = "single" ] && [[ "$ch" =~ ^[1-9]$ ]] && [ "$ch" -le "$n" ]; then
          sel=$((ch - 1)); break
        fi
        ;;
    esac
  done

  stty "$old_stty" 2>/dev/null || true
  ui_picker_render "$mode" "$title" "$cancel_lbl" "$top" "$sel" "$rows" "$selstr"
  printf "\n"

  if [ "$sel" -lt 0 ]; then
    UI_RESULT=''; UI_RESULT_IDX=-1
    [ "$mode" = "multi" ] && { UI_RESULT_SEL=''; UI_RESULT_ITEMS=''; }
    return 0
  fi

  if [ "$mode" = "multi" ]; then
    UI_RESULT_SEL="$selstr"
    local v='' w
    for w in $selstr; do v="$v ${UI_OPTIONS[$w]}"; done
    UI_RESULT_ITEMS="${v# }"
    UI_RESULT=''; UI_RESULT_IDX=-1
    return 0
  fi

  UI_RESULT_IDX="$sel"
  UI_RESULT="${UI_OPTIONS[$sel]}"
  return 0
}

# --- 非TTY時のフォールバック（番号入力） ---
ui_picker_fallback() {
  local mode="$1" title="$2" cancel_lbl="$3" sel="$4" selstr="$5"
  local n="${#UI_OPTIONS[@]}" i ans out w idx
  printf "\n  ${C_BOLD}%s${C_RESET}\n" "$title"
  printf "  ${C_GRAY}%s${C_RESET}\n" "$(ui_rule 52)"
  for ((i = 0; i < n; i++)); do
    if [ "$mode" = "multi" ]; then
      if ui_sel_contains "$i" $selstr; then out="[x]"; else out="[ ]"; fi
    else
      [ "$i" -eq "$sel" ] && out=">" || out=" "
    fi
    printf "    %2d) %s %s\n" "$((i + 1))" "$out" "${UI_LABELS[$i]}"
    [ -n "${UI_DESC[$i]}" ] && printf "        ${C_GRAY_DIM}%s${C_RESET}\n" "${UI_DESC[$i]}"
  done
  printf "  ${C_GRAY}%s${C_RESET}\n" "$(ui_rule 52)"
  if [ "$mode" = "multi" ]; then
    printf "  選択する番号を入力（例: 1 3 5  /  a=全選択  /  空=現在のまま  /  q=中止）: "
  else
    printf "  番号を入力（空=既定:%d  /  q=中止）: " "$((sel + 1))"
  fi
  IFS= read -r ans || true
  ans=$(printf '%s' "$ans" | tr -d ' \t')
  case "$ans" in
    q|Q) sel=-1 ;;
    a|A) [ "$mode" = "multi" ] && selstr=$(ui_all_sel "$n") ;;
    *)
      if [ "$mode" = "multi" ]; then
        out=''
        for w in $ans; do
          if [[ "$w" =~ ^[0-9]+$ ]]; then
            idx=$((w - 1))
            [ "$idx" -ge 0 ] && [ "$idx" -lt "$n" ] && out="$out $idx"
          fi
        done
        [ -n "$out" ] && selstr=${out# }
      else
        if [[ "$ans" =~ ^[0-9]+$ ]]; then
          idx=$((ans - 1))
          [ "$idx" -ge 0 ] && [ "$idx" -lt "$n" ] && sel="$idx"
        fi
      fi
      ;;
  esac

  if [ "$sel" -lt 0 ]; then
    UI_RESULT=''; UI_RESULT_IDX=-1
    [ "$mode" = "multi" ] && { UI_RESULT_SEL=''; UI_RESULT_ITEMS=''; }
    return 0
  fi
  if [ "$mode" = "multi" ]; then
    UI_RESULT_SEL="$selstr"
    out=''
    for w in $selstr; do out="$out ${UI_OPTIONS[$w]}"; done
    UI_RESULT_ITEMS="${out# }"
    UI_RESULT=''; UI_RESULT_IDX=-1
    return 0
  fi
  UI_RESULT_IDX="$sel"
  UI_RESULT="${UI_OPTIONS[$sel]}"
  return 0
}

# --- 単一選択メニュー ---
ui_menu() {
  local title="$1" cancel_lbl="${2:-}" default_sel="${3:-0}" n="${#UI_OPTIONS[@]}"
  [ "$n" -eq 0 ] && { UI_RESULT=''; UI_RESULT_IDX=-1; return 0; }
  ui_picker "single" "$title" "$cancel_lbl" "$default_sel" ''
}

# --- 複数選択チェックリスト ---
ui_checkboxes() {
  local title="$1" cancel_lbl="${2:-}" n="${#UI_OPTIONS[@]}"
  [ "$n" -eq 0 ] && { UI_RESULT_SEL=''; UI_RESULT_ITEMS=''; return 0; }
  ui_picker "multi" "$title" "$cancel_lbl" 0 ''
}

# --- はい/いいえ ---
ui_yesno() {
  local msg="$1" dflt="${2:-yes}" _ans
  if ! ui_is_tty; then
    read -r -p "$(printf "%s [y/N]: " "$msg")" _ans || true
    case "$_ans" in
      y|Y|yes|YES) return 0 ;;
      *) return 1 ;;
    esac
  fi
  local d=0
  [ "$dflt" = "no" ] && d=1
  ui_clean_opts
  ui_opt "yes" "はい" ""
  ui_opt "no"  "いいえ" ""
  ui_menu "$msg" "" "$d"
  [ "${UI_RESULT:-}" = "yes" ]
}

# --- パスワードのマスク表示 ---
ui_mask() {
  local s="$1"
  if [ "${#s}" -gt 2 ]; then
    if [ "$UI_UTF8" = "1" ]; then printf '••%s' "${s: -2}"; else printf '**%s' "${s: -2}"; fi
  else
    printf '••'
  fi
}

# --- 一行テキスト入力（カーソルキー不要の簡易エディタ） ---
ui_input() {
  local label="$1" prefill="${2:-}" pattern="${3:-}" errmsg="${4:-入力が無効です}"
  local buf="$prefill" key ch tries=0 done=0
  UI_RESULT=""
  if ! ui_is_tty; then
    printf "  %s [%s]: " "$label" "$prefill"
    IFS= read -r UI_RESULT || true
    [ -n "$UI_RESULT" ] || UI_RESULT="$prefill"
    return 0
  fi
  local old_stty
  old_stty=$(stty -g 2>/dev/null || true)
  stty -icanon -echo 2>/dev/null || true
  # ui_picker_render と同じ理由で \e[s / \e[u（絶対座標の保存/復元）は使わず、
  # 直前に描画した1行分だけ相対的にカーソルを上へ戻す方式にしている。
  # 入力エラーで警告文を挟んで再入力させる場合は、その警告行の下から
  # 新たに描き始める必要があるため、外側のループの周回ごとに
  # 「まだこの周では描画していない」状態へリセットする。
  while [ "$done" -eq 0 ]; do
    local _first_draw=1
    while :; do
      if [ "$_first_draw" -eq 1 ]; then
        _first_draw=0
      else
        printf '\r\e[1A\e[0J'
      fi
      printf "  ${C_CYAN}${I_ARROW}${C_RESET} ${C_BOLD}%s${C_RESET}${C_GRAY_DIM}: %s${C_RESET}  ${C_GRAY_DIM}(Enter=決定 Esc=戻る)${C_RESET}\n" "$label" "$buf"
      key=$(ui_read_key)
      case "$key" in
        enter) break ;;
        esc) buf="$prefill"; break ;;
        backspace) [ "${#buf}" -gt 0 ] && buf="${buf:0:$((${#buf} - 1))}" ;;
        'char:'*) ch="${key#char:}"; buf="$buf$ch" ;;
      esac
    done
    printf '\n'
    # 注意: ここは `printf '%s' "$buf" | grep -qE "$pattern"` のように
    # パイプ経由でgrepに渡してはいけない。buf が空文字の場合、grepに渡る
    # 行が0行になり、パターン側が空文字を許可していても「不一致」扱いに
    # なってしまうバグがあったため（GAS_URL等の「空欄可」項目で、空Enter
    # が常に弾かれ続ける原因になっていた）、bash組み込みの正規表現一致
    # （[[ =~ ]]）で直接 buf 文字列に対して判定する方式にしている。
    if [ -z "$pattern" ] || [[ "$buf" =~ $pattern ]]; then
      done=1
    else
      tries=$((tries + 1))
      printf "  ${C_YELLOW}${I_WARN}${C_RESET} ${errmsg}\n"
      if [ "$tries" -ge 3 ]; then
        printf "  ${C_GRAY_DIM}入力エラーが3回続いたため既定値に戻しました${C_RESET}\n"
        buf="$prefill"
        done=1
      fi
    fi
  done
  stty "$old_stty" 2>/dev/null || true
  UI_RESULT="$buf"
  return 0
}

# --- パスワード入力（非表示 + 確認） ---
# ui_password "ラベル" [既定値] [検証regex] [エラー文]
#   検証regex を渡すと、確定前にそのパターンで検査する。
#   不一致なら確認入力を取る前に警告し、入力し直させます。
ui_password() {
  local label="$1" dflt="${2:-}" pattern="${3:-}" errmsg="${4:-入力が条件を満たしません}"
  UI_RESULT="$dflt"
  if ! ui_is_tty; then
    return 0
  fi
  local old_stty
  old_stty=$(stty -g 2>/dev/null || true)
  stty -echo 2>/dev/null || true
  printf "\n  ${C_CYAN}${I_ARROW}${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$label"
  printf "  ${C_GRAY_DIM}    現在の値のままの場合は何も入力せず Enter を押してください（入力は表示されません）${C_RESET}\n"
  while :; do
    printf "    新しい値 %s : " "$(ui_mask "$dflt")"
    IFS= read -r pw1 || true
    printf "\n"
    # 1回目を空Enterで済ませた＝「現在の値のまま」という意思表示なので、
    # ここで確定させる。確認入力まで要求すると、確認側も空Enterにした際に
    # 「新しい値(空→既定値に補完済み)」と「確認(空のまま)」が一致せず
    # 無限に再入力を求められてしまう不具合があったため、その場で確定する。
    if [ -z "$pw1" ]; then
      UI_RESULT="$dflt"
      break
    fi
    # パターン指定がある場合は、確認入力を取る前に検証する
    if [ -n "$pattern" ] && ! [[ "$pw1" =~ $pattern ]]; then
      printf "    ${C_YELLOW}${I_WARN}${C_RESET} ${errmsg}\n"
      continue
    fi
    printf "    確認のため再入力: "
    IFS= read -r pw2 || true
    printf "\n"
    if [ "$pw1" != "$pw2" ]; then
      printf "    ${C_YELLOW}${I_WARN}${C_RESET} 入力が一致しません。もう一度入力してください\n"
      continue
    fi
    UI_RESULT="$pw1"
    break
  done
  printf "\n"
  stty "$old_stty" 2>/dev/null || true
  return 0
}

# --- 整数入力（範囲チェック付き） ---
ui_number() {
  local label="$1" dflt="${2:-}" mn="${3:-}" mx="${4:-}"
  while :; do
    ui_input "$label" "$dflt" '^[0-9]+$' "整数（0〜999999999）で入力してください"
    if [ -n "$mn" ] && [ "$UI_RESULT" -lt "$mn" ]; then
      printf "  ${C_YELLOW}${I_WARN}${C_RESET} %s 以上で入力してください（下限: %s）\n" "$label" "$mn"
      continue
    fi
    if [ -n "$mx" ] && [ "$UI_RESULT" -gt "$mx" ]; then
      printf "  ${C_YELLOW}${I_WARN}${C_RESET} %s 以下で入力してください（上限: %s）\n" "$label" "$mx"
      continue
    fi
    break
  done
  return 0
}

# --- 小見出し（ウィザードの区切り等） ---
ui_subtitle() {
  printf "\n  ${C_CYAN}${C_BOLD}%s${C_RESET}\n  ${C_GRAY}%s${C_RESET}\n" "$1" "$(ui_rule 52)"
}

# --- 一時停止（Enter待ち） ---
ui_pause() {
  printf "  ${C_GRAY_DIM}続行するには Enter を押してください${C_RESET}"
  IFS= read -r _ || true
  printf "\n"
}
