#!/bin/bash
# キオスク実行中に、本システム(Chromium)以外のアプリのウィンドウを閉じ、
# Cinnamon のパネル/概要表示(Overview)/ワークスペース切替など
# 「画面の隅をスワイプすると開いてしまう」経路を塞ぎ続ける番人。
# 使い方: app-guard.sh <監視対象のキオスクPID>
#   そのPIDが終了すると自動で停止する(管理者がキオスクを終了すればメンテナンス可能)。
# 環境変数 APP_GUARD_ONCE=1 で1回だけ実行して終了する(動作確認用)。
#
# 許可するもの:
#   - Chromium / Chrome 系（キオスク本体）
#   - Cinnamon / Muffin のウィンドウのうち _NET_WM_WINDOW_TYPE が DOCK または
#     DESKTOP のもの（上下のパネル・デスクトップアイコン・背景だけ）
#   - Xorg / Xwayland、xdg-desktop-portal、csd-* / cjs などの常駐補助プロセス
#   - zenity（APP_GUARD_ALLOW_ZENITY=1 のときのみ。0 にすると管理者の
#     メンテナンス互換を犠牲にして塞ぐ）
# それ以外（端末・エディター・ファイルマネージャー、および Cinnamon の概要表示・
# ワークスペース切替・実行ダイアログ）は「閉じる要求」→ 2秒以上残れば
# 自分のプロセスのものだけ強制終了する。
#
# 併せて常に維持する:
#   - Cinnamon のパネル/デスクトップを map し直さない（画面隅のスワイプで
#     パネルが出現できないようにする）。Muffin が再 map しても次の巡回（約1秒後）で
#     再度消すため、恒久的な対策。
#   - キオスクの Chromium をフルスクリーン・最前面に保つ。
#   - ウィンドウを持たないまま起動される危険物（端末・エディター等）も
#     プロセス名のまま止める。ウィンドウが写像される前の隙間を塞ぐため。
#
# ただし Cinnamon シェル・Xorg・セッション関連のプロセスは、
# 誤って閉じるとデスクトップごと落ちるため絶対に強制終了しない。
#
# 失敗しても常に終了コード0(起動処理を止めない)。

KIOSK_PID="${1:-0}"
command -v wmctrl >/dev/null 2>&1 || exit 0

# キオスク本体のブラウザと、X セッションの常駐プロセス。
ALLOW_RE='^(chromium.*|chrome.*|google-chrome.*|muffin|Xorg|Xwayland|xdg-desktop-portal.*|csd-.*|cjs)$'
# Cinnamon のシェル。パネル(DOCK)・デスクトップ(DESKTOP)に限り許可する。
# ここに当たらない cinnamon のウィンドウは「概要表示」「実行ダイアログ」
# 「ワークスペース切替」などであり、無条件に閉じる。
SHELL_RE='^(cinnamon|cinnamon-session|cjs|nemo-desktop)$'
# 通知・メニュー・ツールチップ等の補助ウィンドウは閉じる必要がない。
IGNORE_TYPE_RE='_NET_WM_WINDOW_TYPE_(NOTIFICATION|MENU|POPUP_MENU|DROPDOWN_MENU|TOOLTIP|COMBO|DND|SPLASH)'
# 絶対に強制終了してはいけないプロセス。
# Cinnamon のシェル(cinnamon / cinnamon-session)を kill すると
# セッションごとログアウトし、管理者のメンテナンスまで出来なくなる。
# Xorg を kill すると X サーバーが落ちて画面が真っ暗になる。
# いずれも「閉じたいウィンドウ」の犠牲にしてはならない重要なプロセス。
NEVER_KILL_RE='^(cinnamon|cinnamon-session|muffin|csd-.*|cjs|nemo-desktop|Xorg|Xwayland|gnome-session.*|systemd.*|dbus.*|Xsession)$'
# ウィンドウ（アイコン）を出すだけのプロセス。フェーズ1 の「X に写像済みの
# ウィンドウ」判定では捕まらないため、プロセス名のまま停止する。
KILL_NAMES='xterm uxterm gnome-terminal mate-terminal xfce4-terminal konsole tilix
alacritty kitty terminator urxvt nemo nautilus thunar pcmanfm gedit kate pluma
mousepad xed leafpad geany eog eom gpicview xarchiver file-roller engrampa
remmina virt-manager gparted timeshift baobab gnome-disks gnome-tweaks
cinnamon-sett'

# 環境変数（既定値）
ALLOW_ZENITY="${APP_GUARD_ALLOW_ZENITY:-1}"   # 1: zenity のダイアログは残す
UNMAP_PANEL="${APP_GUARD_UNMAP_PANEL:-1}"     # 1: パネル/デスクトップを unmap し続ける
KEEP_FULLSCREEN="${APP_GUARD_KEEP_FULLSCREEN:-1}" # 1: Chromium をフルスクリーンに保つ

MY_UID="$(id -u)"
declare -A SEEN   # ウィンドウID -> 連続して検出した回数

# パネル・デスクトップを画面から消し、Chromium の下層へ落とす。
# Muffin はパネルを「最前面」に保つため、lower だけでは再描画時に手前に
# 戻ってしまう。unmap が唯一確実な手段。
hide_panel_window() {
  local wid="$1"
  wmctrl -ir "$wid" -b remove,above 2>/dev/null || true
  wmctrl -ir "$wid" -b remove,shaded 2>/dev/null || true
  [ "$UNMAP_PANEL" = "1" ] || return 0
  command -v xdotool >/dev/null 2>&1 || return 0
  xdotool windowunmap "$wid" 2>/dev/null && return 0
  xdotool windowlower "$wid" 2>/dev/null || true
}

# 画面上のどのウィンドウが「前面」か。キオスク以外なら前面に戻す。
# force=1 の場合は、フォーカス状態に関係なく必ずキオスクを前面へ戻す。
# 画面の隅をスワイプして出た Cinnamon の概要表示(Overview)は、
# フォーカスを奪わずに描画されることがあるため、
# 「フォーカスを奪った」だけでは検出できず、その場合は force で戻す必要がある。
restore_kiosk_focus() {
  local kiosk_wid="$1" force="${2:-0}"
  local active_hex active_pid active_comm
  command -v xdotool >/dev/null 2>&1 || return 0

  if [ "$KEEP_FULLSCREEN" = "1" ]; then
    wmctrl -ir "$kiosk_wid" -b add,fullscreen 2>/dev/null || true
  fi

  if [ "$force" != "1" ]; then
    active_hex="$(xdotool getactivewindow 2>/dev/null)"
    [ -n "$active_hex" ] || return 0
    # xdotool は 16 進、wmctrl は 10 進で返すため変換して比較する。
    [ "$(printf '%d' "$active_hex" 2>/dev/null)" = "$kiosk_wid" ] && return 0

    if [ "$ALLOW_ZENITY" = "1" ]; then
      active_pid="$(xdotool getwindowpid "$active_hex" 2>/dev/null)"
      active_comm="$(cat "/proc/${active_pid:-0}/comm" 2>/dev/null)"
      # 管理者がメンテナンス中は zenity のダイアログを出すため、ここだけ残す。
      [ "$active_comm" = "zenity" ] && return 0
    fi
  fi
  wmctrl -ia "$kiosk_wid" 2>/dev/null || true
  command -v xdotool >/dev/null 2>&1 && xdotool windowactivate "$kiosk_wid" 2>/dev/null
  return 0
}

guard_pass() {
  local line wid pid comm owner types force_focus=0
  local kiosk_wid="" any_chromium_wid=""
  local -A alive=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    wid="${line%% *}"
    pid="$(awk '{print $3}' <<<"$line")"
    [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || continue
    [ -r "/proc/$pid/comm" ] || continue
    comm="$(cat "/proc/$pid/comm" 2>/dev/null)"

    # キオスク本体の Chromium。監視対象の PID が一致するウィンドウを優先する。
    # Chromium は複数のウィンドウを開くことがあるため（拡張ディスプレイ向けの
    # board.html など）、一致しない方を前面に戻すと主画面のキオスクが隠れる。
    if [[ "$comm" =~ ^(chromium|chrome|google-chrome) ]]; then
      [ -z "$any_chromium_wid" ] && any_chromium_wid="$wid"
      [ "$pid" = "$KIOSK_PID" ] && kiosk_wid="$wid"
      continue
    fi

    types=""
    if command -v xprop >/dev/null 2>&1; then
      types="$(xprop -id "$wid" _NET_WM_WINDOW_TYPE 2>/dev/null)"
    fi

    # Cinnamon のパネル・デスクトップアイコン・背景は「閉じず、消す」。
    if [[ "$comm" =~ $SHELL_RE ]] && [[ "$types" =~ _NET_WM_WINDOW_TYPE_(DOCK|DESKTOP) ]]; then
      hide_panel_window "$wid"
      continue
    fi

    # 常駐プロセスとして許可したもの。
    if [[ "$comm" =~ $ALLOW_RE ]]; then continue; fi
    if [ "$ALLOW_ZENITY" = "1" ] && [ "$comm" = "zenity" ]; then continue; fi

    # Cinnamon シェルのうち、パネルでもデスクトップでもないウィンドウ
    # （概要表示 / ワークスペース切替 / 実行ダイアログなど）は閉じる。
    # これらはフォーカスを奪わずに描画されることがあるため、
    # 見つかったら必ずキオスクを前面へ戻す（force）。
    if [[ "$comm" =~ $SHELL_RE ]]; then
      force_focus=1
    fi

    # 通知・メニュー等は放置。
    [[ "$types" =~ $IGNORE_TYPE_RE ]] && continue

    owner="$(stat -c %u "/proc/$pid" 2>/dev/null)"
    alive[$wid]=1
    SEEN[$wid]=$(( ${SEEN[$wid]:-0} + 1 ))
    wmctrl -ic "$wid" 2>/dev/null || true
    # 2秒たっても閉じないウィンドウは、自分のプロセスに限り強制終了する。
    # ただし重要なプロセス(Cinnamon シェル・Xorg・セッション関連)は
    # 絶対に kill しない。ここを誤るとデスクトップごと落ちる。
    if [ "${SEEN[$wid]}" -ge 3 ] \
       && [ "$owner" = "$MY_UID" ] \
       && [ "$pid" != "$$" ] && [ "$pid" != "$KIOSK_PID" ] \
       && ! [[ "$comm" =~ $NEVER_KILL_RE ]]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.3
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    fi
  done < <(wmctrl -lp 2>/dev/null)
  # 消えたウィンドウの記録を掃除
  local k
  for k in "${!SEEN[@]}"; do [ -n "${alive[$k]:-}" ] || unset 'SEEN[$k]'; done

  # フェーズ2: ウィンドウを持たないまま起動される危険物を、プロセス名で止める。
  # フェーズ1 は wmctrl の一覧(= X に写像済みのウィンドウ)しか見ないため、
  # 起動した直後など「まだウィンドウを作る前」の隙間に挿入されるのを塞ぐ。
  # pkill は自分のセッション内のプロセスだけを終了させる。
  for k in $KILL_NAMES; do
    pkill -x "$k" 2>/dev/null || true
  done

  # キオスクを最前面・フルスクリーンに戻す。
  [ -n "$kiosk_wid" ] || kiosk_wid="$any_chromium_wid"
  [ -n "$kiosk_wid" ] && restore_kiosk_focus "$kiosk_wid" "$force_focus"
  return 0
}

if [ "${APP_GUARD_ONCE:-0}" = "1" ]; then guard_pass; exit 0; fi

while [ "$KIOSK_PID" -gt 1 ] && kill -0 "$KIOSK_PID" 2>/dev/null; do
  guard_pass
  sleep 1
done
exit 0
