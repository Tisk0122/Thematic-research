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
exec "$BROWSER_BIN" "${KIOSK_CHROME_ARGS[@]}" --app="$URL"
