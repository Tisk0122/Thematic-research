#!/bin/bash
# キオスク起動時のデスクトップ設定。
# パネル、端末起動ショートカット、仮想端末切替などの復旧手段には触れない。
# CinnamonではUSBの自動マウント後にファイルマネージャが開くことだけを防ぐ。

case "${XDG_CURRENT_DESKTOP:-}:${DESKTOP_SESSION:-}" in
  *Cinnamon*|*cinnamon*) ;;
  *) exit 0 ;;
esac

command -v gsettings >/dev/null 2>&1 || exit 0

_has_schema() { gsettings list-schemas 2>/dev/null | grep -qx "$1"; }
_set() { _has_schema "$1" && gsettings set "$1" "$2" "$3" >/dev/null 2>&1; return 0; }

# 旧バージョンが消したパネル・ショートカットを検出した場合は既定値へ戻す。
# 設定変更を検出できない通常状態では、利用者のデスクトップ設定に触れない。
_NEEDS_RESTORE=0
_APPLETS="$(gsettings get org.cinnamon enabled-applets 2>/dev/null || true)"
case "${_APPLETS}" in
  "[]"|"@as []") _NEEDS_RESTORE=1 ;;
esac
for _KEY in panel-run-dialog; do
  _VALUE="$(gsettings get org.cinnamon.desktop.keybindings.wm "${_KEY}" 2>/dev/null || true)"
  case "${_VALUE}" in "[]"|"@as []") _NEEDS_RESTORE=1 ;; esac
done
_COMMAND_LINE="$(gsettings get org.cinnamon.desktop.lockdown disable-command-line 2>/dev/null || true)"
[ "${_COMMAND_LINE}" = "true" ] && _NEEDS_RESTORE=1

if [ "${_NEEDS_RESTORE}" -eq 1 ]; then
  if _has_schema org.cinnamon; then
    gsettings reset org.cinnamon enabled-applets >/dev/null 2>&1 || true
  fi
  for _SCHEMA in \
    org.cinnamon.desktop.keybindings.wm \
    org.cinnamon.desktop.keybindings.wm.switcher \
    org.cinnamon.desktop.keybindings.media-keys \
    org.cinnamon.desktop.keybindings.panel \
    org.cinnamon.desktop.keybindings.screensaver \
    org.gnome.desktop.keybindings.media-keys; do
    gsettings list-keys "${_SCHEMA}" 2>/dev/null | while read -r _KEY; do
      [ -n "${_KEY}" ] || continue
      [ "$(gsettings range "${_SCHEMA}" "${_KEY}" 2>/dev/null)" = "as" ] || continue
      _VALUE="$(gsettings get "${_SCHEMA}" "${_KEY}" 2>/dev/null || true)"
      case "${_VALUE}" in "[]"|"@as []") gsettings reset "${_SCHEMA}" "${_KEY}" >/dev/null 2>&1 || true ;; esac
    done
  done
  for _SCHEMA in org.cinnamon.desktop.lockdown org.gnome.desktop.lockdown; do
    for _KEY in disable-command-line disable-user-switching disable-printing \
                disable-lock-screen disable-screensaver disable-notifications \
                disable-applet-lockdown; do
      _VALUE="$(gsettings get "${_SCHEMA}" "${_KEY}" 2>/dev/null || true)"
      [ "${_VALUE}" = "true" ] && gsettings reset "${_SCHEMA}" "${_KEY}" >/dev/null 2>&1 || true
    done
  done
  gsettings reset org.cinnamon.desktop.keybindings looking-glass-keybinding >/dev/null 2>&1 || true
  gsettings reset org.cinnamon hotcorner-layout >/dev/null 2>&1 || true
  gsettings reset org.gnome.desktop.wm.preferences hotcorner-layout >/dev/null 2>&1 || true
  gsettings reset org.gnome.desktop.wm.preferences disable-application-handling >/dev/null 2>&1 || true
fi

for schema in org.cinnamon.desktop.media-handling org.gnome.desktop.media-handling; do
  _set "$schema" automount true
  _set "$schema" automount-open false
  _set "$schema" autorun-never true
done

_set org.nemo.preferences media-automount true
_set org.nemo.preferences media-automount-open false
_set org.nemo.preferences media-autorun-never true

exit 0
