#!/bin/bash
# キオスク用: OS/デスクトップ層からキオスク画面を抜けられないようにする設定。
# install.sh(導入時)と kiosk-autostart.sh(ログインのたび)から呼ばれる。
# 存在しないキーは黙って飛ばす。常に終了コード0。
#
# 設計方針:
#   - ショートカットは「よく使うキーを1個ずつ無効化する」方式をやめ、
#     スキーマ内のキー配列型(as)のキーを全量 [] にする。キーの増減に漏れにくい。
#   - custom-keybindings は意図的に残す。
#     管理者の緊急脱出( Ctrl+Alt+Shift+Q )がここに登録されているため。
#   - Cinnamon の設定名・スキーマ名は Logical であり、OSの更新で変わる。
#     無効化できなかった場合は「黙ってfalseを返して素通りする」ため、
#     導入後は必ず `gsettings dump` で反映を確認すること。

command -v gsettings >/dev/null 2>&1 || exit 0
_has_key() { gsettings list-keys "$1" 2>/dev/null | grep -qx "$2"; }
_set() { _has_key "$1" "$2" && gsettings set "$1" "$2" "$3" >/dev/null 2>&1; return 0; }

# ---------------------------------------------------------------------------
# 1. キーボードショートカットの全量無効化
# ---------------------------------------------------------------------------
# 型が "as"(文字列配列) のキーだけがショートカット値を持つ。
# int/double などの設定値(例: switcher-duration)は書き換えると壊れるため、
# 型が一致するものだけを対象にする。
_wipe_keybindings() {
  local schema key
  for schema in "$@"; do
    gsettings list-keys "$schema" 2>/dev/null | while read -r key; do
      [ -n "$key" ] || continue
      [ "$(gsettings range "$schema" "$key" 2>/dev/null)" = "as" ] || continue
      gsettings set "$schema" "$key" "[]" >/dev/null 2>&1 || true
    done
  done
}

_wipe_keybindings \
  org.cinnamon.desktop.keybindings.wm \
  org.cinnamon.desktop.keybindings.wm.switcher \
  org.cinnamon.desktop.keybindings.media-keys \
  org.cinnamon.desktop.keybindings.panel \
  org.cinnamon.desktop.keybindings.screensaver \
  org.gnome.desktop.keybindings.media-keys

# Alt+F2(実行ダイアログ)/ Looking Glass は Cinnamon 独自スキーマ。
_set org.cinnamon.desktop.keybindings.wm panel-run-dialog "[]"
_set org.cinnamon.desktop.keybindings looking-glass-keybinding "[]"

# ---------------------------------------------------------------------------
# 2. OS側のロックダウン
# ---------------------------------------------------------------------------
# disable-command-line : Alt+F2 等のコマンド実行を禁止
# disable-user-switching : 他のユーザーへの切り替えを禁止(別アカウントへの乗り替え防止)
# disable-lock-screen / disable-screensaver :
#   ロック画面を出すとログイン画面が出てしまい、別ユーザーでログインし直される。
#   キオスクは常時表示が前提なので、スリープ・ロックは一切無効化する。
for schema in org.cinnamon.desktop.lockdown org.gnome.desktop.lockdown; do
  for key in disable-command-line disable-user-switching disable-printing \
             disable-lock-screen disable-screensaver disable-notifications \
             disable-applet-lockdown; do
    _set "$schema" "$key" true
  done
done

# スクリーンセーバー・スリープの待機自体を止める
for schema in org.cinnamon.desktop.screensaver org.gnome.desktop.screensaver; do
  _set "$schema" lock-enabled false
  _set "$schema" idle-activation-enabled false
  _set "$schema" screensaver-enabled false
done
_set org.cinnamon.settings-daemon.plugins.power sleep-inactive-ac-type "'nothing'"
_set org.cinnamon.settings-daemon.plugins.power sleep-inactive-battery-type "'nothing'"

# ---------------------------------------------------------------------------
# 3. アクセシビリティ機能(assistive technology)の無効化
# ---------------------------------------------------------------------------
# MouseKeys(キーを使わずマウスだけでメニューを操作する機能)やスクリーンリーダーは、
# 「キーボードも画面上のボタンも使わずに OS を操作できる」経路になる。
# タッチキオスクでは特に危険なので無効化する。
for schema in org.cinnamon.desktop.a11y.keyboard org.gnome.desktop.a11y.keyboard \
              org.cinnamon.desktop.a11y.applications org.gnome.desktop.a11y.applications \
              org.cinnamon.desktop.a11y.magnifier org.gnome.desktop.a11y.magnifier; do
  _set "$schema" mousekeys-enable false
  _set "$schema" screenreader-keys-enable false
  _set "$schema" keyrepeat-enable false
  _set "$schema" screen-magnifier-enabled false
  _set "$schema" screen-reader-enabled false
  _set "$schema" always-show-accessibility-menu false
done

# 画面上のオンスクリーンキーボード(Cinnamon の OS 側ダイアログ)。
#   既定は「有効のまま」。キオスク画面は自前の画面内キーパッドで操作するため
#   必須ではないが、管理者がタッチだけで管理者画面へ入る経路となる。
#   それも消す場合は、このスクリプトを呼ぶ側で DISABLE_OS_KEYBOARD=1 を設定する。
if [ "${DISABLE_OS_KEYBOARD:-0}" = "1" ]; then
  for schema in org.cinnamon.desktop.a11y.applications org.gnome.desktop.a11y.applications; do
    _set "$schema" screen-keyboard-enabled false
  done
  for schema in org.cinnamon.desktop.a11y.keyboard org.gnome.desktop.a11y.keyboard; do
    _set "$schema" screen-keyboard-enable false
  done
fi

# ---------------------------------------------------------------------------
# 4. 画面の隅（ホットコーナー）とワークスペースの切り替え抑止
# ---------------------------------------------------------------------------
# タッチキオスクで最も実際に抜けられるのがここ。
# 画面の隅をスワイプ/タップすると、Cinnamon がパネルや概要表示(Overview)を
# 出したり、Muffin がワークスペースを切り替えたりする。
#
# hotcorner-layout の書式は「アクション:ゾーン:待ち時間」。アクションに
# none を指定すると「何も起こさない」になるため、4 隅すべてを無効化できる。
# なお "false" や "scroll" などはアクション名として無効なため、
# ここでは必ず none を書くこと。
_set org.cinnamon hotcorner-layout \
  "['none:top-left:0','none:top-right:0','none:bottom-left:0','none:bottom-right:0']"
_set org.gnome.desktop.wm.preferences hotcorner-layout \
  "['none:top-left:0','none:top-right:0','none:bottom-left:0','none:bottom-right:0']"
_set org.gnome.desktop.wm.preferences disable-application-handling true

# Muffin の「画面端からスワイプでワークスペース切替」も止める。
_set org.cinnamon.muffin workspace-cycle false

# ---------------------------------------------------------------------------
# 5. Cinnamon パネルの中身を消す（タッチ操作の最大の抜け口）
# ---------------------------------------------------------------------------
# --kiosk は Chromium ウィンドウを全画面にするだけで、パネル自体を隠さない。
# パネルには「メニュー」「クロック」「ウィンドウ一覧」「トレイ」があり、
# 画面の隅をスワイプしてパネルを出現させれば、そこから
# 「システム設定」やファイルマネージャーを起動できてしまう。
#
# enabled-applets を空にするとパネルは空の帯だけになり、押しても何も起きない。
# 復元方法（管理者用）:
#   gsettings get org.cinnamon enabled-applets   # 現在の値を控えておく
#   gsettings set org.cinnamon enabled-applets "[
#     'panel1:right:0:menu:0','panel1:right:1:clock:0']"   # 例
# パネルを元に戻したい場合は、この section を丸ごとコメントアウトして
# ログインし直すか、上記コマンドで元の値を書き戻す。
if [ "${KIOSK_KEEP_PANEL_APPLETS:-0}" != "1" ]; then
  _set org.cinnamon enabled-applets "[]"
fi
_set org.cinnamon panel-edit-mode false

# ---------------------------------------------------------------------------
# 6. ファイルマネージャーの自動起動抑止(自動マウント自体は維持)
# ---------------------------------------------------------------------------
# 録画・バックアップの外部ストレージ検出に自動マウントが必要なため、
# 「マウント後にフォルダを開く」「autorun」だけを止める。
for schema in org.cinnamon.desktop.media-handling org.gnome.desktop.media-handling; do
  _set "$schema" automount true
  _set "$schema" automount-open false
  _set "$schema" autorun-never true
done
_set org.nemo.preferences media-automount true
_set org.nemo.preferences media-automount-open false
_set org.nemo.preferences media-autorun-never true

exit 0
