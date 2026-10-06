#!/bin/bash
# ログイン時に自動実行され、サーバーの起動を待ってから
# ブラウザをキオスク（全画面・操作制限）モードで開く。
# ~/.config/autostart/ の .desktop エントリから呼ばれる想定。
# 出力はセッションの標準出力へ出る（自動起動時は .desktop 側の
# StandardOutput、手動実行時は直接ターミナルに表示される）。
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
source "${PROJECT_DIR}/scripts/ui-lib.sh"
ui_header "端末貸出管理システム" "キオスク自動起動"

# --- 出力は .desktop 側で logs/kiosk.log にリダイレクトされる
#（kiosk-autostart.desktop.template の Exec 参照。dls.sh の「ログの表示」
# から確認できる）。手動実行時はターミナルにそのまま出る。
# リダイレクト先のディレクトリが無いと起動自体が失敗するため、念のため用意。
mkdir -p "${PROJECT_DIR}/logs" 2>/dev/null || true

# --- ブラウザ終了要求フラグ ---
# exit-kiosk.sh（管理者の Ctrl+Alt+Shift+Q または管理画面 API）が作成する。
# スーパーバイザーはブラウザ終了時にこのフラグを見て、管理者の意図した
# 終了なら再起動せずに停止する。クラッシュ等の異常終了なら自動で復旧する。
KIOSK_EXIT_FLAG="${PROJECT_DIR}/logs/kiosk-exit-requested.flag"
rm -f "${KIOSK_EXIT_FLAG}"

# --- kiosk.log / systemd.log ローテーション ---
# どちらも「>> / append:」で追記し続ける（リダイレクト元が fd を掴み続ける）ため、
# mv ではリダイレクト先が付いたまま古いファイルへ書かれ続ける。そのため
# copy-truncate（コピーして空にする）方式でローテーションする。
# 直前の1世代分が *.1 に残る。systemd.log は server.js の全stdout(systemd運用時)が
# 出力され続けるため、同じく上限チェックの対象とする。
KIOSK_LOG_FILE="${PROJECT_DIR}/logs/kiosk.log"
SYSTEMD_LOG_FILE="${PROJECT_DIR}/logs/systemd.log"
KIOSK_LOG_MAX_BYTES=$((10 * 1024 * 1024))   # 上限 10MB（超えたらローテーション）
rotate_append_log() {
  local _target="$1" _size
  _size=$(stat -c %s "${_target}" 2>/dev/null) || return 0
  [ "${_size:-0}" -lt "$KIOSK_LOG_MAX_BYTES" ] && return 0
  cp -f "${_target}" "${_target}.1" 2>/dev/null || true
  : > "${_target}" 2>/dev/null || true
  echo "$(basename "${_target}") がサイズ上限(${KIOSK_LOG_MAX_BYTES}バイト)を超えたためローテーションしました"
}
rotate_kiosk_log() { rotate_append_log "${KIOSK_LOG_FILE}"; }
rotate_systemd_log() { rotate_append_log "${SYSTEMD_LOG_FILE}"; }
# 起動時にも1回チェック（前回終了時に上限を超えていたケースの後始末）。
rotate_kiosk_log
rotate_systemd_log

# 定期チェック: ブラウザが長時間クラッシュせず動き続けてもログを上限以下に
# 保つため、10分ごとにローテーション判定を行うバックグラウンドループ。
# （異常終了時のチェックだけでは、長期安定稼働中に無制限に育つ可能性が残るため）
# スーパーバイザー（このスクリプト自身）が死ぬとループも自動停止する。
KIOSK_LOG_CHECK_INTERVAL_SEC=600
(
  while kill -0 "$$" 2>/dev/null; do
    sleep "$KIOSK_LOG_CHECK_INTERVAL_SEC"
    rotate_kiosk_log
    rotate_systemd_log
  done
) &

# --- 連続クラッシュ検知 ---
# 短時間に何度も異常終了したら警告ファイル(logs/kiosk-crash-warning.json)
# を作成する。サーバーの統合ヘルスチェック(GET /api/health-status)と
# dls.sh status がこのファイルを読み、管理画面に警告バナーを表示する。
# 長時間(復旧判定秒数)安定稼働した後のクラッシュは単発とみなし、警告を解除する。
CRASH_WINDOW_SEC=900        # この秒数以内のクラッシュを「短時間に連続」とみなす(15分)
CRASH_THRESHOLD=3           # しきい値(回数)
CRASH_RECOVER_SEC=600       # この秒数以上連続稼働した後のクラッシュは単発扱い(10分)
CRASH_EVENTS_FILE="${PROJECT_DIR}/logs/kiosk-crash-events"
CRASH_WARNING_FILE="${PROJECT_DIR}/logs/kiosk-crash-warning.json"

# クラッシュを1件記録し、しきい値に達していたら警告ファイルを作成する。
record_crash_warning() {
  local now cutoff n iso
  now=$(date +%s)
  printf '%s\n' "$now" >> "${CRASH_EVENTS_FILE}"
  # 窓の外の古いイベントを除去
  cutoff=$((now - CRASH_WINDOW_SEC))
  [ -f "${CRASH_EVENTS_FILE}" ] && \
    awk -v c="$cutoff" '$1 >= c' "${CRASH_EVENTS_FILE}" > "${CRASH_EVENTS_FILE}.tmp" 2>/dev/null && \
    mv "${CRASH_EVENTS_FILE}.tmp" "${CRASH_EVENTS_FILE}" 2>/dev/null || true
  n=$(wc -l < "${CRASH_EVENTS_FILE}" 2>/dev/null || echo 0)
  n="${n//[[:space:]]/}"
  if [ "$n" -ge "$CRASH_THRESHOLD" ]; then
    iso=$(date -Iseconds 2>/dev/null || date)
    printf '{"code":"kiosk_browser_crashing","crashCount":%s,"windowMinutes":%s,"lastCrashAt":"%s"}\n' \
      "${n:-0}" "$((CRASH_WINDOW_SEC / 60))" "$iso" > "${CRASH_WARNING_FILE}" 2>/dev/null || true
    warn "キオスク画面が短時間に${n}回異常終了しています。管理画面のヘルスチェックに警告を表示しました"
  fi
}

# 安定稼働が確認できた時点で警告・イベントを解除する。
clear_crash_warning() {
  rm -f "${CRASH_WARNING_FILE}" "${CRASH_EVENTS_FILE}" 2>/dev/null || true
}

if [ -f "config.env" ]; then
  set -a
  source "config.env"
  set +a
fi
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}/"

# systemdサービスは自動起動されているはずだが、ログイン直後は
# まだ起動しきっていない可能性があるので、応答するまで待つ
# （最大60秒。それ以上待たせるのは何かがおかしいと判断して諦める）。
info "サーバーの起動を待っています... (${URL})"
_READY=0
for i in $(seq 1 120); do
  if curl -s -o /dev/null -m 1 "$URL"; then
    _READY=1
    break
  fi
  ui_spin_line "起動を待っています" "$((i / 2))" "$i"
  sleep 0.5
done
ui_spin_clear
if [ "$_READY" -eq 1 ]; then
  success "サーバーの起動を確認しました"
else
  warn "60秒待ちましたがサーバーの応答が確認できませんでした。キオスク画面は表示を試みます"
fi

# 画面がスリープ/スクリーンセーバーで消えないようにする
# （常時掲示するキオスク用途のため）
xset s off -dpms 2>/dev/null || true

# デスクトップ環境自体の操作制限は適用しない。パネルや端末、
# 仮想端末への切り替えは復旧手段として常に利用できる状態にする。
# この補助スクリプトはCinnamonでUSBを挿したときにNemoが開くことだけを防ぐ。
bash "${PROJECT_DIR}/scripts/apply-desktop-lockdown.sh" 2>/dev/null || true

BROWSER_BIN=""
# キオスクは常にChromiumに固定する（Google Chromeとは別バイナリ・別ポリシー
# ディレクトリにして、キオスク用のURL制限ポリシーが日常ブラウザのChromeに
# 漏れ出さないようにするため。install.shのポリシー配置もChromium専用）。
for b in chromium chromium-browser; do
  if command -v "$b" >/dev/null 2>&1; then
    BROWSER_BIN="$b"
    break
  fi
done

if [ -z "$BROWSER_BIN" ]; then
  # Chromiumが見つからない場合は諦めて通常のstart.shに任せる
  warn "Chromiumが見つかりませんでした（'sudo apt install chromium' でインストールしてください）。start.sh にフォールバックします"
  exec bash "${PROJECT_DIR}/scripts/start.sh"
fi

info "キオスクモードでブラウザを起動しています (${BROWSER_BIN})"

# キオスク用の起動オプションは lib-kiosk-browser-args.sh に一本化してある
# （start.sh の手動起動でも同じフラグを使い、挙動がずれないようにするため）。
source "${PROJECT_DIR}/scripts/lib-kiosk-browser-args.sh"

# 画面端からのスワイプで履歴ナビ（前のページへ戻る）が起きるのを、
# コマンドライン引数だけでなくプロファイル設定でも封じる。
# 引数が他の経路で失効しても、Preferences 側の設定が効いて履歴ナビを止める。
case "$BROWSER_BIN" in
  chromium)          kiosk_prepare_overscroll_pref "${HOME}/.config/chromium" ;;
  chromium-browser)  kiosk_prepare_overscroll_pref "${HOME}/.config/chromium" ;;
  google-chrome)     kiosk_prepare_overscroll_pref "${HOME}/.config/google-chrome" ;;
esac

# カメラ/マイクの許可ダイアログを毎回出さず自動許可する設定は、コマンド
# ラインフラグ(--use-fake-ui-for-media-stream)ではなく、Chromiumの企業向け
# 管理者ポリシー(VideoCaptureAllowedUrls / AudioCaptureAllowedUrls、
# install.shが /etc/chromium/policies/managed/ に配置)で行っている。
# 上記フラグはChromium側で「危険なフラグ」として警告バー表示の対象に
# なっており、以前はこれを使っていたため常に警告が出てしまっていた。
# ポリシー側で許可URLをこのアプリ(localhost)に限定しているため、
# 外部サイトへの意図しない許可は発生しない。
# --incognito は使わない:
#   本システムは返却待ちキュー等をlocalStorageに保持しているため、
#   シークレットモードにするとブラウザ再起動のたびにデータが消えてしまう。
#
# ============================================================================
# キオスク・スーパーバイザーループ
#
# 以前は exec で「このスクリプトを Chromium そのものに置き換えて」いたため、
# ブラウザがクラッシュ・終了すると画面が真っ黒になり、ロックダウン済みとは
# いえデスクトップ（壁面・右クリックメニュー等）がむき出しになっていた。
# そこで、ブラウザを子プロセスとして起動し、終了を待ち受ける。
#   - 異常終了（クラッシュ等）   → 自動でキオスク画面を再起動（復旧）
#   - 管理者の終了要求（フラグ） → 再起動せず停止（メンテナンス可能にする）
# ============================================================================
launch_browser() {
  # app-guard.sh は「監視対象のキオスクPIDが死ぬと自分も止まる」設計のため、
  # 起動のたびにブラウザの実PIDを渡して新しい監視を立てる。
  "$BROWSER_BIN" "${KIOSK_CHROME_ARGS[@]}" --app="$URL" &
  local _bpid=$!
  bash "${PROJECT_DIR}/scripts/app-guard.sh" "$_bpid" >/dev/null 2>&1 &
  echo "キオスク画面を起動しました（PID: ${_bpid}）"
  wait "$_bpid"
  local _st=$?
  echo "キオスク画面が終了しました（終了コード: ${_st}）"
  return "$_st"
}

# 検証用の子プロセスは初回起動の直後に1回だけ実行する。
(
  sleep 3
  _kiosk_pid="$(pgrep -f -- "app=${URL}" 2>/dev/null | while read -r _p; do
    _cmdline="$(tr '\0' ' ' < "/proc/${_p}/cmdline" 2>/dev/null)"
    case "$_cmdline" in *board.html*) continue ;; *) echo "$_p"; break ;; esac
  done)"
  if [ -z "$_kiosk_pid" ] || ! kiosk_verify_overscroll_flag "$_kiosk_pid"; then
    echo "  [警告] Chromium に --overscroll-history-navigation=0 が渡っていません。" >&2
    echo "  [警告] 画面の隅をスワイプすると「前のページへ戻る」が動作します。" >&2
    echo "  [警告] ${PROJECT_DIR}/scripts/lib-kiosk-browser-args.sh を確認してください。" >&2
  fi
) >/dev/null 2>&1 &

while :; do
  _SESSION_START=$(date +%s)
  launch_browser
  _SESSION_END=$(date +%s)
  if [ -f "${KIOSK_EXIT_FLAG}" ]; then
    # フラグ残留対策: このブラウザセッション開始より前に作成されたフラグは
    # 過去の終了要求の取り残し（終了に失敗した等）なので「管理者終了」とは
    # 認めず、無視して通常どおり復旧する。
    _FLAG_MTIME=$(stat -c %Y "${KIOSK_EXIT_FLAG}" 2>/dev/null || echo 0)
    if [ "${_FLAG_MTIME}" -ge "${_SESSION_START}" ]; then
      rm -f "${KIOSK_EXIT_FLAG}"
      success "管理者による終了要求のため、キオスク画面の再起動を止めます"
      info "再表示はデスクトップアイコン／ターミナル（start.sh）または再ログインで行えます"
      break
    fi
    rm -f "${KIOSK_EXIT_FLAG}"
    warn "終了要求フラグが本セッション開始前の古いものだったため無視して復旧します"
  fi
  # 長時間安定稼働した後の終了は単発クラッシュの可能性が高いので、
  # 次の記録の前に警告を一旦解除する（復旧済み扱い）。
  _DURATION=$(( _SESSION_END - _SESSION_START ))
  if [ "$_DURATION" -ge "$CRASH_RECOVER_SEC" ]; then
    clear_crash_warning
  fi
  record_crash_warning
  rotate_kiosk_log
  rotate_systemd_log
  warn "キオスク画面が異常終了しました。5秒後に自動復旧します"
  sleep 5
  # CinnamonでUSB自動起動の設定だけを再適用する。
  bash "${PROJECT_DIR}/scripts/apply-desktop-lockdown.sh" 2>/dev/null || true
done

exit 0
