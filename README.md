<h1 align="center">Ritmo</h1>
<p align="center">A music player for your own files and for freely licensed catalogues. Desktop and mobile, one codebase.</p>

---

## What it is

Ritmo plays your local music library alongside catalogues that are free to
listen to. It is not a client for a closed service: there is no account, no
telemetry, and it works offline.

| Source | What it gives you |
|---|---|
| **This computer** | Folder scanning, ID3 and Vorbis and MP4 tag reading, embedded cover extraction, filesystem watching |
| **Audius** | Independent artists, trending lists, song radio |
| **Jamendo** | Around 600k Creative Commons tracks (needs a free client id) |
| **Internet Archive** | Live concert recordings, 78rpm transfers, public domain music |
| **Radio Browser** | Over 50,000 internet radio stations by country and by genre |

Enrichment comes from **MusicBrainz** (credits), **Cover Art Archive**
(artwork), **LRCLIB** (synced lyrics) and **Last.fm** (scrobbling).

## Notable parts

**A Rust audio engine.** symphonia decodes into cpal, which buys true gapless
transitions, an equal power crossfade, sample accurate seeking, a 10 band
equaliser, ReplayGain normalisation and ICY metadata so a radio station can
report what it is playing. Master volume sits in the device callback rather than
the DSP chain, so muting is audible within one buffer instead of after the ring
buffer drains.

**MPRIS rather than global hotkeys.** The GNOME media widget, the lock screen,
`playerctl` and the keyboard media keys all speak MPRIS. Under Wayland an
application cannot grab global keys at all, so this is both the cheaper and the
only correct approach.

**Packs and the Bazaar.** A pack is a named, shareable set of tracks. Publishing
writes a static `index.json` plus the pack files, which you upload anywhere,
including straight to GitHub Pages from inside the app. Subscribers add your
index address. There is no Ritmo server: the catalogue is federated by
construction, with nothing to run and no single point that can take it away.

Packs carry track identity rather than audio. That keeps a pack in kilobytes, it
means publishing references instead of redistributing recordings, and it lets
the same pack resolve against whatever sources each subscriber has enabled.

## Architecture

```
packages/core     Platform independent TypeScript: the domain model, providers,
                  queue and playback logic, the library layer, packs, i18n
packages/ui       React interface: design system, components, stores, views
apps/web          Vite SPA, bundled by both the desktop and the mobile shell
apps/desktop      Tauri 2 shell plus the Rust backend
apps/mobile       Capacitor shell
```

Five boundary contracts hold it together, all under `docs/`:

| File | What it fixes |
|---|---|
| `packages/core/src/types.ts` | The domain model. Every layer speaks the same `Track`, `Album` and `Settings` |
| `packages/core/src/host/types.ts` | `HostBridge`, the single seam between core logic and a platform |
| `packages/core/src/engine/types.ts` | `AudioEngine`, implemented by both the Rust engine and the HTML one |
| `docs/schema.sql` | The SQLite schema. Rust writes it, TypeScript queries it |
| `docs/ipc.md` | Every Tauri command and its shape on the wire |

Core code never branches on platform. It asks the bridge and reads a capability
flag. On mobile the Capacitor implementation of `HostBridge` and the HTML audio
engine take over, and not one line of the interface changes.

## Development

```bash
pnpm install
pnpm dev:desktop      # Tauri plus Vite, hot reload
pnpm build:desktop    # produces the release binary
pnpm typecheck        # all packages
pnpm test             # 549 TypeScript tests
cd apps/desktop/src-tauri && cargo test    # 108 Rust tests
```

System packages on Arch: `webkit2gtk-4.1 gtk3 librsvg patchelf gst-libav
alsa-lib base-devel`.

## Licence

The code is MIT. Catalogue content stays under its own licence: Jamendo tracks
are Creative Commons, and the attribution travels in `Track.meta.license`.
