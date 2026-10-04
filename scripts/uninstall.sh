#!/bin/bash
# 端末貸出管理システム アンインストールスクリプト（Linux Mint 実機用）
set -e
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

# --- 共通UIライブラリ（配色・記号・進捗表示） ---
source "${PROJECT_DIR}/scripts/ui-lib.sh"

# --- 引数解析 ---
# --purge : config.env（管理者パスワード等）と data/（学生名簿・登録済み顔画像等）も削除する
# --yes   : 確認プロンプトを出さない（自動実行用）
PURGE=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h)
      echo "使い方: ./scripts/uninstall.sh [--purge] [--yes]"
      echo "  --purge  設定ファイル(config.env)とデータ(data/)も削除する（元に戻せません）"
      echo "  --yes    確認プロンプトを出さずに実行する"
      exit 0
      ;;
    *)
      warn "不明なオプションです（無視します）: $arg"
      ;;
  esac
done

confirm() {
  local msg="$1"
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  read -r -p "$(echo -e "  ${C_YELLOW}?${C_RESET} ${msg} [y/N]: ")" _ans
  case "$_ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

ui_header "端末貸出管理システム" "アンインストール"
echo ""
info "プロジェクト: ${PROJECT_DIR}"
if [ "$PURGE" -eq 1 ]; then
  warn "--purge が指定されています。設定・データもすべて削除します。"
fi
echo ""

if ! confirm "アンインストールを開始します。よろしいですか？"; then
  info "中止しました。何も変更していません。"
  exit 0
fi
echo ""

# --- 1. サーバーを停止 ---
if [ -f "${PROJECT_DIR}/scripts/stop.sh" ]; then
  info "サーバーを停止しています..."
  bash "${PROJECT_DIR}/scripts/stop.sh" >/dev/null 2>&1 || true
  step_done "サーバーを停止しました（起動していなかった場合も含む）"
else
  # stop.sh が無い場合の保険
  pkill -f "node .*server\.js" 2>/dev/null || true
  step_done "サーバープロセスを確認しました"
fi

# --- 1.5 systemdサービスの登録解除 ---
# これを忘れると、Restart=always の設定により、アプリ削除後も
# 存在しないスクリプトの再起動を無限に試み続けてしまう。
if command -v systemctl >/dev/null 2>&1 \
   && systemctl --user list-unit-files device-lending-system.service >/dev/null 2>&1; then
  systemctl --user disable --now device-lending-system.service >/dev/null 2>&1 || true
  rm -f "${HOME}/.config/systemd/user/device-lending-system.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  step_done "自動再起動サービス（systemd）の登録を解除しました"
else
  step_skip "systemdサービスの登録は見つかりませんでした（スキップ）"
fi

# --- 1.5.1 Arduino用 udev ルールの解除 ---
# install.sh で配置した 99-arduino.rules を削除する。
if [ -f /etc/udev/rules.d/99-arduino.rules ]; then
  sudo rm -f /etc/udev/rules.d/99-arduino.rules
  sudo udevadm control --reload-rules >/dev/null 2>&1 || true
  sudo udevadm trigger >/dev/null 2>&1 || true
  step_done "Arduino用 udev ルールを削除しました"
else
  step_skip "Arduino用 udev ルールは見つかりませんでした（スキップ）"
fi

# --- 1.6 キオスク自動起動・自動ログインの解除 ---
KIOSK_AUTOSTART="${HOME}/.config/autostart/device-lending-kiosk.desktop"
if [ -f "$KIOSK_AUTOSTART" ]; then
  rm -f "$KIOSK_AUTOSTART"
  step_done "キオスク自動起動の登録を解除しました"
else
  step_skip "キオスク自動起動の登録は見つかりませんでした（スキップ）"
fi

# --- 1.6b サブモニター表示（貸出状況ボード）自動検出の解除 ---
BOARD_AUTOSTART="${HOME}/.config/autostart/device-lending-board.desktop"
if [ -f "$BOARD_AUTOSTART" ]; then
  rm -f "$BOARD_AUTOSTART"
  step_done "サブモニター表示の自動検出を解除しました"
else
  step_skip "サブモニター表示の自動検出は見つかりませんでした（スキップ）"
fi
# 実行中のボード監視・ボードのブラウザウィンドウがあれば止める
pkill -f "scripts/board-watch.sh" >/dev/null 2>&1 || true
pkill -f -- "--user-data-dir=${HOME}/.config/device-lending-board-profile" >/dev/null 2>&1 || true
rm -rf "${HOME}/.config/device-lending-board-profile" 2>/dev/null || true

AUTOLOGIN_CONF="/etc/lightdm/lightdm.conf.d/60-device-lending-autologin.conf"
if [ -f "$AUTOLOGIN_CONF" ]; then
  if confirm "自動ログイン設定も解除しますか？（次回からログイン画面が表示されます）"; then
    sudo rm -f "$AUTOLOGIN_CONF"
    step_done "自動ログイン設定を解除しました"
  else
    step_skip "自動ログイン設定はそのまま残しました"
  fi
else
  step_skip "自動ログイン設定は見つかりませんでした（スキップ）"
fi

# --- 1.7 Chromium企業ポリシーの解除 ---
# install.shが配置したキオスク用URL制限ポリシーを削除する。
# 旧バージョンのinstall.shがGoogle Chrome側（/etc/opt/chrome/policies/managed/）
# にも誤って同じポリシーを配置していたことがあるため、そちらも念のため削除する
# （残っているとキオスク用途と無関係な普段使いのChromeまでURLがlocalhostに
# 制限されたままになってしまうため）。
CHROMIUM_POLICY="/etc/chromium/policies/managed/device-lending-kiosk.json"
CHROME_POLICY_LEGACY="/etc/opt/chrome/policies/managed/device-lending-kiosk.json"
_removed_policy=0
if [ -f "$CHROMIUM_POLICY" ]; then
  sudo rm -f "$CHROMIUM_POLICY"
  _removed_policy=1
fi
if [ -f "$CHROME_POLICY_LEGACY" ]; then
  sudo rm -f "$CHROME_POLICY_LEGACY"
  _removed_policy=1
  warn "旧バージョン由来のGoogle Chrome側ポリシーも見つかったため削除しました。Chromeを再起動すると通常通り使えるようになります"
fi
if [ "$_removed_policy" -eq 1 ]; then
  step_done "Chromiumキオスクポリシーを解除しました（ブラウザの再起動が必要です）"
else
  step_skip "Chromiumキオスクポリシーは見つかりませんでした（スキップ）"
fi

# --- 1.8 緊急脱出ショートカット（キオスク強制終了）の登録解除 ---
if command -v gsettings >/dev/null 2>&1; then
  _KEYBIND_ID="device-lending-kiosk-exit"
  _KEYBIND_PATH="/org/cinnamon/desktop/keybindings/custom-keybindings/${_KEYBIND_ID}/"
  _EXISTING_LIST=$(gsettings get org.cinnamon.desktop.keybindings custom-keybindings 2>/dev/null || echo "@as []")
  if echo "$_EXISTING_LIST" | grep -qF "$_KEYBIND_PATH"; then
    # このパス1件だけをリストから取り除く（他のカスタムショートカットは残す）。
    # 単独要素・先頭・途中/末尾のいずれの位置にあっても対応する。
    _NEW_LIST=$(echo "$_EXISTING_LIST" \
      | sed -e "s#\[ *'${_KEYBIND_PATH}' *\]#[]#" \
            -e "s#, *'${_KEYBIND_PATH}'##" \
            -e "s#'${_KEYBIND_PATH}', *##")
    gsettings set org.cinnamon.desktop.keybindings custom-keybindings "$_NEW_LIST" >/dev/null 2>&1 || true
    gsettings reset "org.cinnamon.desktop.keybindings.custom-keybinding:${_KEYBIND_PATH}" name >/dev/null 2>&1 || true
    gsettings reset "org.cinnamon.desktop.keybindings.custom-keybinding:${_KEYBIND_PATH}" command >/dev/null 2>&1 || true
    gsettings reset "org.cinnamon.desktop.keybindings.custom-keybinding:${_KEYBIND_PATH}" binding >/dev/null 2>&1 || true
    # USB挿入時のファイルマネージャ自動起動の抑制を元に戻す
    for _s in org.cinnamon.desktop.media-handling org.gnome.desktop.media-handling; do
      gsettings reset "$_s" automount-open >/dev/null 2>&1 || true
      gsettings reset "$_s" autorun-never >/dev/null 2>&1 || true
    done
    gsettings reset org.nemo.preferences media-automount-open >/dev/null 2>&1 || true
    gsettings reset org.nemo.preferences media-autorun-never >/dev/null 2>&1 || true
    # 他アプリ起動の無効化を元に戻す
    gsettings reset org.cinnamon.desktop.keybindings.wm panel-run-dialog >/dev/null 2>&1 || true
    gsettings reset org.cinnamon.desktop.keybindings looking-glass-keybinding >/dev/null 2>&1 || true
    for _k in show-desktop switch-group switch-group-backward switch-panels switch-panels-backward; do
      gsettings reset org.cinnamon.desktop.keybindings.wm "$_k" >/dev/null 2>&1 || true
    done
    for _k in terminal home www email calculator search help logout screensaver media player video-out rotate-video-lock screenshot window-screenshot area-screenshot screenshot-clip window-screenshot-clip area-screenshot-clip; do
      gsettings reset org.cinnamon.desktop.keybindings.media-keys "$_k" >/dev/null 2>&1 || true
    done
    gsettings reset org.cinnamon.desktop.lockdown disable-command-line >/dev/null 2>&1 || true
    gsettings reset org.cinnamon.desktop.lockdown disable-user-switching >/dev/null 2>&1 || true
    gsettings reset org.cinnamon hotcorner-layout >/dev/null 2>&1 || true
    step_done "緊急脱出ショートカット（Ctrl+Alt+Shift+Q）の登録を解除しました"
  else
    step_skip "緊急脱出ショートカットの登録は見つかりませんでした（スキップ）"
  fi
else
  step_skip "gsettings が見つかりませんでした（緊急脱出ショートカットの解除をスキップ）"
fi

# --- 2. ランチャー（アプリ一覧）からの登録解除 ---
DESKTOP_DST="${HOME}/.local/share/applications/device-lending-system.desktop"
if [ -f "$DESKTOP_DST" ]; then
  rm -f "$DESKTOP_DST"
  step_done "ランチャーからアプリを削除しました"
else
  step_skip "ランチャー登録は見つかりませんでした（スキップ）"
fi

# --- 3. ブラウザのアプリ専用プロファイルを削除 ---
if [ -d "${PROJECT_DIR}/.browser-profile" ]; then
  rm -rf "${PROJECT_DIR}/.browser-profile"
  step_done "ブラウザの専用プロファイルを削除しました"
else
  step_skip "ブラウザの専用プロファイルは見つかりませんでした（スキップ）"
fi

# --- 4. ログ・実行中フラグ類を削除 ---
if [ -d "${PROJECT_DIR}/logs" ]; then
  rm -rf "${PROJECT_DIR}/logs"
  step_done "ログファイルを削除しました"
else
  step_skip "ログは見つかりませんでした（スキップ）"
fi

# --- 5. 依存パッケージ（node_modules）を削除 ---
if [ -d "${PROJECT_DIR}/node_modules" ]; then
  rm -rf "${PROJECT_DIR}/node_modules"
  step_done "依存パッケージ（node_modules）を削除しました"
else
  step_skip "node_modules は見つかりませんでした（スキップ）"
fi

# --- 6. 録画データ（未対応のSDカード保存分は対象外）を削除するか確認 ---
if [ -d "${PROJECT_DIR}/recordings" ]; then
  if confirm "ローカルに保存された録画データ（recordings/）も削除しますか？"; then
    rm -rf "${PROJECT_DIR}/recordings"
    step_done "録画データを削除しました"
  else
    step_skip "録画データは残しました: ${PROJECT_DIR}/recordings"
  fi
else
  step_skip "録画データは見つかりませんでした（スキップ）"
fi

# --- 7. 設定・生徒データ（--purge 指定時のみ） ---
if [ "$PURGE" -eq 1 ]; then
  if [ -f "${PROJECT_DIR}/config.env" ]; then
    rm -f "${PROJECT_DIR}/config.env"
    step_done "設定ファイル（config.env）を削除しました"
  fi
  if [ -d "${PROJECT_DIR}/data" ]; then
    rm -rf "${PROJECT_DIR}/data"
    step_done "データ（生徒名簿・登録済み画像等）を削除しました"
  fi
else
  if [ -f "${PROJECT_DIR}/config.env" ] || [ -d "${PROJECT_DIR}/data" ]; then
    step_skip "設定（config.env）とデータ（data/）は残しました（削除するには --purge を付けて再実行）"
  fi
fi

# --- 8. システムパッケージについての案内（自動削除はしない） ---
# Node.js / Chromium / ffmpeg / zenity は他のアプリでも使われている可能性が
# あるため、このスクリプトでは自動削除しない。必要なら手動で。
echo ""
info "以下は他のアプリと共有されている可能性があるパッケージのため、"
info "このアプリ専用とは限らず、自動では削除していません。"
info "他で使っていないと確実にわかる場合のみ、必要に応じて手動で削除してください:"
echo -e "  ${C_CYAN}sudo apt-get remove nodejs chromium zenity${C_RESET}"
echo ""

# --- 完了 ---
ui_success_banner "アンインストール完了"
echo ""

if [ "$PURGE" -eq 0 ]; then
  info "設定ファイルとデータは残してあります。完全に削除したい場合は:"
  echo -e "  ${C_CYAN}./scripts/uninstall.sh --purge${C_RESET}"
  echo ""
fi

info "プロジェクトフォルダ自体（${PROJECT_DIR}）を削除する場合は、"
info "このスクリプトの外（ターミナルやファイラー）から手動で削除してください。"
info "例: Linuxターミナルから"
echo -e "  ${C_CYAN}rm -rf \"${PROJECT_DIR}\"${C_RESET}"
echo ""
