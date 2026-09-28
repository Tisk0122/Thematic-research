#!/bin/bash
# 端末貸出管理システム: Chrome/Chromiumをキオスク（全画面・操作制限）モードで
# 起動する際の共通オプション。
#
# kiosk-autostart.sh（ログイン時の自動起動）と start.sh（デスクトップアイコン／
# ターミナルからの手動起動）の両方から source して使う。
# 2箇所に別々にフラグを書くと片方だけ更新し忘れて挙動がずれる
# （＝手動起動だけ全画面にならない、等）事故が起きるため、ここに一本化する。
# 注意: 以前ここには --use-fake-ui-for-media-stream を含めていたが、これは
# Chromium側で「危険なコマンドラインフラグ」として明示的に警告対象に
# 登録されているフラグで、付与すると常に
#   「サポートされていないコマンドラインフラグ --use-fake-ui-for-media-stream
#    を使用しています。これにより、安全性とセキュリティが損なわれます。」
# という警告バーが（カメラを一切使わない拡張ディスプレイ側の画面を含め、
# このフラグを付けて起動した全てのウィンドウに）毎回表示されてしまっていた。
# カメラ/マイクの許可ダイアログをキオスク環境で自動許可したいだけであれば、
# 代わりに scripts/templates/kiosk-policy.json.template の
# VideoCaptureAllowedUrls / AudioCaptureAllowedUrls という
# Chromiumの企業向け管理者ポリシーで、このアプリのURLに対してのみ
# 許可することができる。こちらは正式にサポートされた仕組みのため、
# 警告バーは出ず、かつフラグのように「常に全サイトで自動許可」される
# 訳でもないためより安全（このアプリ以外のURLでは通常通り許可を求める）。
KIOSK_CHROME_ARGS=(
  --kiosk
  --noerrdialogs
  --disable-infobars
  --disable-session-crashed-bubble
  --disable-pinch
  --overscroll-history-navigation=0
  --autoplay-policy=no-user-gesture-required
  --disable-dev-tools
  --disable-translate
  --disable-features=TranslateUI
  --disable-component-update
  --no-first-run
)

# --kiosk を除いたもの。board-watch.sh（拡張ディスプレイへの表示）専用。
# --kiosk は「起動時点でフルスクリーン化」をウィンドウマネージャに要求するが、
# 環境によってはこの要求が --window-position/--window-size より優先されて
# しまい、指定した拡張ディスプレイではなくメイン（プライマリ）側でフル
# スクリーン化されてしまうことがある（＝拡張ディスプレイ自体は正しく拡張
# 表示になるのに、ボード画面はそこに現れない）。そのため board-watch.sh では
# 一旦 --kiosk 無しで指定位置・指定サイズのウィンドウとして開き、実際に
# そのモニター上へ配置されたのを確認してから、xdotoolでF11相当のフル
# スクリーン切り替えを送ってその場でフルスクリーン化する2段階方式を取る。
# KIOSK_CHROME_ARGS 本体を直接編集すれば、こちらにも自動的に反映される。
KIOSK_CHROME_ARGS_NO_KIOSK=()
for _kiosk_arg in "${KIOSK_CHROME_ARGS[@]}"; do
  [ "$_kiosk_arg" = "--kiosk" ] && continue
  KIOSK_CHROME_ARGS_NO_KIOSK+=("$_kiosk_arg")
done
unset _kiosk_arg
