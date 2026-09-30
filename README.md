<h1 align="center">Ritmo</h1>
<p align="center">Açık kaynaklı, çok platformlu müzik çalar — masaüstü (Tauri 2) ve mobil (Capacitor), tek kod tabanı.</p>

---

## Ne yapar

Ritmo, yerel müzik kütüphanenizi ve **özgürce dinlenebilir açık katalogları** tek
bir arayüzde birleştirir. Kapalı bir servise bağımlı değildir; hesap açmanız
gerekmez.

| Kaynak | Ne sağlar |
|---|---|
| **Bilgisayarım** | Klasör tarama, ID3/Vorbis/MP4 etiket okuma, gömülü kapak çıkarma, dosya sistemi izleme |
| **Audius** | Bağımsız sanatçıların katalogu, trend listeleri, benzer şarkı radyosu |
| **Jamendo** | Creative Commons lisanslı ~600k parça (ücretsiz `client_id` gerekir) |
| **Internet Archive** | Canlı kayıt arşivi (etree), 78'lik plaklar, telifsiz müzik |
| **Radio Browser** | 50.000+ internet radyosu, ülke ve tür filtreleriyle |

Zenginleştirme: **MusicBrainz** (künye), **Cover Art Archive** (kapak),
**LRCLIB** (senkron şarkı sözleri), **Last.fm** (scrobble).

## Öne çıkanlar

- **Rust ses motoru** — symphonia ile çözümleme, cpal ile çıkış: gerçek *gapless*
  geçiş, eşit-güçlü *crossfade*, örnek hassasiyetinde arama
- **10 bantlı ekolayzır** + ReplayGain ses seviyesi eşitleme + preamp
- **MPRIS** entegrasyonu — GNOME medya widget'ı, kilit ekranı, `playerctl` ve
  klavyenin medya tuşları doğrudan çalışır (Wayland'de global kısayol yakalamak
  mümkün değil; MPRIS doğru çözüm)
- **Çevrimdışı indirme** — LRU bütçeli disk önbelleği
- **Çalma listeleri** — sürükle-bırak sıralama, M3U/JSON içe-dışa aktarma
- **Sanatçı aralıklı karıştırma** — aynı sanatçı üst üste gelmez
- **Sıfır telemetri**, yerel SQLite, tamamen çevrimdışı çalışabilir

## Mimari

```
packages/core     Platformdan bağımsız TypeScript: domain modeli, sağlayıcılar,
                  kuyruk/çalma mantığı, kütüphane katmanı, i18n
packages/ui       React arayüz: tasarım sistemi, bileşenler, store'lar, ekranlar
apps/web          Vite SPA — hem Tauri hem Capacitor bunu paketler
apps/desktop      Tauri 2 kabuğu + Rust backend (ses, DB, tarayıcı, ağ, MPRIS)
```

Üç **sınır sözleşmesi** her şeyi bir arada tutar — `docs/` altında:

| Dosya | Ne tanımlar |
|---|---|
| `packages/core/src/types.ts` | Domain modeli. Her katman aynı `Track`/`Album`/`Settings`'i konuşur |
| `packages/core/src/host/types.ts` | `HostBridge` — çekirdek ile platform arasındaki tek dikiş |
| `packages/core/src/engine/types.ts` | `AudioEngine` — Rust motoru ve HTML motoru aynı arayüzü uygular |
| `docs/schema.sql` | SQLite şeması; Rust yazar, TypeScript sorgular |
| `docs/ipc.md` | Her Tauri komutunun adı ve tel üstündeki şekli |

Çekirdek kod **asla** platforma göre dallanmaz: köprüye sorar, yetenek bayrağına
bakar. Mobil sürümde `HostBridge`'in Capacitor uygulaması ve HTML ses motoru
devreye girer; arayüzün tek satırı değişmez.

## Geliştirme

```bash
pnpm install
pnpm dev:desktop      # Tauri + Vite, hot reload
pnpm build:desktop    # .deb / .rpm / .AppImage üretir
pnpm typecheck        # tüm paketler
cd apps/desktop/src-tauri && cargo test    # Rust birim testleri
```

Gerekli sistem paketleri (Arch): `webkit2gtk-4.1 gtk3 librsvg patchelf gst-libav
alsa-lib base-devel`.

## Lisans

Kodu MIT. Katalog içeriği ilgili sağlayıcının lisansına tabidir — Jamendo
parçaları Creative Commons'tır ve künye bilgisi `Track.meta.license` alanında
taşınır.
