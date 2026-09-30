# Ritmo — mobil kabuk (Capacitor 8)

Masaüstü ile **birebir aynı** React paketini (`apps/web/dist`) sarar. Arayüzün
tek satırı mobil için ayrıca yazılmaz; platform farkları çalışma zamanında
çözülür:

| Katman | Masaüstü | Mobil |
|---|---|---|
| Host köprüsü | `TauriHost` (Rust IPC) | `CapacitorHost` (Preferences / Filesystem / SQLite) |
| Ses motoru | `RustAudioEngine` (symphonia + cpal) | `HtmlAudioEngine` (Web Audio) |
| Medya oturumu | MPRIS | `navigator.mediaSession` |
| Yerel kütüphane | lofty ile etiket okuma | dosya adı/yol sezgileri |

## Ön koşullar (henüz kurulu değil)

```bash
sudo pacman -S --needed jdk17-openjdk android-sdk android-sdk-platform-tools \
                        android-sdk-build-tools android-platform gradle
export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
```

iOS için macOS + Xcode gerekir; bu depodan Linux üzerinde iOS derlenemez.

## Kurulum

```bash
pnpm install
pnpm --filter @ritmo/mobile add:android    # android/ klasörünü üretir
pnpm --filter @ritmo/mobile run:android    # web'i derle + senkronize et + çalıştır
```

## Bilinen sınırlar

- **Arka planda çalma.** WebView'deki `<audio>`, uygulama arka plana atıldığında
  Android tarafından duraklatılır. Kalıcı arka plan çalma için bir *foreground
  service* şart: `android/` üretildikten sonra `MediaSessionService` tabanlı
  küçük bir native plugin eklenmeli. `HtmlAudioEngine` zaten
  `navigator.mediaSession`'ı besliyor, yani kilit ekranı kontrolleri plugin
  geldiği anda çalışır.
- **Gapless ve ekolayzır.** `HtmlAudioEngine.supportsGapless` `false`;
  crossfade iki `<audio>` elementi arasında gain rampasıyla yapılır, ekolayzır
  Web Audio `BiquadFilterNode` zinciriyle. Rust motorunun örnek-hassas geçişi
  mobilde yok.
- **Etiket okuma.** Mobilde lofty yok; `CapacitorHost.localLibrary` dosya
  yolundan (`Sanatçı/Albüm/NN Başlık`) çıkarım yapar.
