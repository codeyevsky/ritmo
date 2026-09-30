#!/usr/bin/env bash
# Spotify'ı ve yalnızca Spotify için kurulu spicetify-cli'yi kaldırır.
#
# Ayrı bir betik olarak duruyor çünkü root gerektiriyor ve geri dönüşü yok:
# --delete-data ile birlikte yerel çalma listesi önbelleği ve oturum de silinir.
# Ritmo'nun çalıştığını doğruladıktan sonra çalıştır.
set -euo pipefail

APP=com.spotify.Client

if [ "${1:-}" != "--yes" ]; then
  cat <<'WARN'
Bu işlem şunları KALICI olarak siler:

  • Spotify flatpak uygulaması (sistem geneli)
  • ~/.var/app/com.spotify.Client  (~784 MB: oturum, indirilenler, önbellek)
  • spicetify-cli paketi ve ~/.config/spicetify
    (spicetify yalnızca Spotify'ı temalandırmak için vardır, Spotify gidince işlevsiz kalır)

Spotify çalma listelerin buradan taşınmıyor — öyle istemiştin.
Devam etmek için:  ./scripts/remove-spotify.sh --yes
WARN
  exit 1
fi

if pgrep -x spotify >/dev/null 2>&1; then
  echo "Spotify çalışıyor, kapatılıyor…"
  flatpak kill "$APP" 2>/dev/null || pkill -x spotify 2>/dev/null || true
  sleep 2
fi

echo "==> Flatpak kaldırılıyor"
if flatpak list --columns=application 2>/dev/null | grep -qx "$APP"; then
  sudo flatpak uninstall --assumeyes --delete-data "$APP"
else
  echo "    (kurulu değil, atlanıyor)"
fi

echo "==> spicetify-cli kaldırılıyor"
if pacman -Qq spicetify-cli >/dev/null 2>&1; then
  sudo pacman -Rns --noconfirm spicetify-cli
else
  echo "    (kurulu değil, atlanıyor)"
fi

echo "==> Artık kullanıcı verileri siliniyor"
rm -rf ~/.var/app/com.spotify.Client ~/.config/spicetify ~/.cache/spotify ~/.config/spotify

echo "==> Kullanılmayan flatpak çalışma zamanları"
sudo flatpak uninstall --assumeyes --unused || true

echo
echo "Bitti. Kalan iz kontrolü:"
flatpak list --columns=application 2>/dev/null | grep -i spotify || echo "  flatpak: temiz"
pacman -Qq 2>/dev/null | grep -iE "spotify|spicetify" || echo "  pacman:  temiz"
ls -d ~/.var/app/com.spotify.Client ~/.config/spicetify 2>/dev/null || echo "  veri:    temiz"
