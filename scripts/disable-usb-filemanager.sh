#!/bin/bash
# USBメモリ等を挿してもファイルマネージャ(Nemo等)が自動で開かないようにする。
# - 自動マウントは有効のまま(録画・バックアップの外部ストレージ検出に必要)
# - 「マウント後にフォルダを開く」「自動実行(autorun)」だけを無効化する
# install.sh(導入時)と kiosk-autostart.sh(ログインのたび)から呼ばれる。
# 失敗しても起動を止めない(常に終了コード0)。

command -v gsettings >/dev/null 2>&1 || exit 0

_has_schema() { gsettings list-schemas 2>/dev/null | grep -qx "$1"; }
_set() { _has_schema "$1" && gsettings set "$1" "$2" "$3" >/dev/null 2>&1; return 0; }

for schema in org.cinnamon.desktop.media-handling org.gnome.desktop.media-handling; do
  _set "$schema" automount true
  _set "$schema" automount-open false
  _set "$schema" autorun-never true
done

_set org.nemo.preferences media-automount true
_set org.nemo.preferences media-automount-open false
_set org.nemo.preferences media-autorun-never true

exit 0
