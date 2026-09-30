#!/usr/bin/env bash
# Kaynaktan çalıştırırken .desktop girdisini ve ikonu kullanıcı dizinine kurar.
# MPRIS'in DesktopEntry alanı buna bakar; olmadan GNOME medya widget'ı genel bir
# ikon gösterir.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"

mkdir -p "$APPS" "$ICONS/scalable/apps"
for s in 32 64 128 256 512; do mkdir -p "$ICONS/${s}x${s}/apps"; done

install -m644 "$ROOT/assets/logo.svg" "$ICONS/scalable/apps/dev.ritmo.app.svg"

# Symbolic variant. The lock screen, the tray and notification headers ask for
# a single-colour glyph; with none installed the shell desaturates the full
# colour tile, which turns the mark into a grey block.
mkdir -p "$ICONS/symbolic/apps"
install -m644 "$ROOT/assets/logo-symbolic.svg" "$ICONS/symbolic/apps/dev.ritmo.app-symbolic.svg"
for s in 32 64 128; do
  src="$ROOT/apps/desktop/src-tauri/icons/${s}x${s}.png"
  [ -f "$src" ] && install -m644 "$src" "$ICONS/${s}x${s}/apps/dev.ritmo.app.png"
done
install -m644 "$ROOT/apps/desktop/src-tauri/icons/icon.png" \
  "$ICONS/512x512/apps/dev.ritmo.app.png"

# Prefer the release binary; fall back to the dev script when it has not been
# built yet. WEBKIT_DISABLE_DMABUF_RENDERER works around a blank-window bug in
# some Mesa versions and costs nothing here.
REL="$ROOT/apps/desktop/src-tauri/target/release/ritmo"
if [ -x "$REL" ]; then
  EXEC="env WEBKIT_DISABLE_DMABUF_RENDERER=1 $REL %U"
else
  EXEC="$ROOT/scripts/dev.sh"
  echo "uyarı: release binary yok, .desktop dev betiğine bakacak (pnpm build:desktop)" >&2
fi

# GNOME on Wayland matches a window to its launcher by comparing the toplevel's
# app_id with the desktop file's BASENAME. Tauri derives the app_id from
# `identifier` in tauri.conf.json, so the file has to be named after it or the
# window shows no icon at all. StartupWMClass stays for the X11 path.
rm -f "$APPS/Ritmo.desktop"
sed "s|^Exec=ritmo %U|Exec=$EXEC|" \
  "$ROOT/apps/desktop/src-tauri/resources/Ritmo.desktop" > "$APPS/dev.ritmo.app.desktop"
chmod 644 "$APPS/dev.ritmo.app.desktop"

command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "$ICONS" 2>/dev/null || true
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
echo "Kuruldu: $APPS/dev.ritmo.app.desktop"
