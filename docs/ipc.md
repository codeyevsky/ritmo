# Tauri IPC surface — FROZEN CONTRACT

Every Rust `#[tauri::command]` name and its exact argument/return shape. The
TypeScript `TauriHost` calls these and nothing else; the Rust modules expose
these and nothing else. Argument names are **camelCase** on the wire (each
command struct/arg uses `#[serde(rename_all = "camelCase")]`).

`AppError` serialises to `{ code, message }`; every command below may reject
with that shape.

## db  (src/db/commands.rs)

| command | args | returns |
|---|---|---|
| `db_query` | `sql: String, params: Vec<serde_json::Value>` | `Vec<Map<String, Value>>` — one object per row, keyed by column name |
| `db_execute` | `sql: String, params: Vec<Value>` | `usize` rows affected |
| `db_transaction` | `statements: Vec<{ sql: String, params: Vec<Value> }>` | `()` |
| `db_maintenance` | – | `()` — `PRAGMA optimize`, prunes expired `http_cache` |
| `kv_get` | `key: String` | `Option<String>` |
| `kv_set` | `key: String, value: String` | `()` |
| `kv_remove` | `key: String` | `()` |
| `kv_keys` | `prefix: Option<String>` | `Vec<String>` |

JSON↔SQL mapping: `null`→NULL, bool→INTEGER 0/1, number→INTEGER when integral
else REAL, string→TEXT, array/object→TEXT (`serde_json::to_string`). Coming
back: INTEGER→number, REAL→number, TEXT→string, BLOB→base64 string, NULL→null.

## audio  (src/audio/commands.rs)

| command | args | returns |
|---|---|---|
| `audio_load` | `track: WireTrack, stream: WireStream, startAtMs: Option<u64>, autoplay: bool` | `()` |
| `audio_preload` | `track: Option<WireTrack>, stream: Option<WireStream>` | `()` |
| `audio_play` | – | `()` |
| `audio_pause` | – | `()` |
| `audio_stop` | – | `()` |
| `audio_seek` | `positionMs: u64` | `()` |
| `audio_set_volume` | `volume: f32` (0..1) | `()` |
| `audio_set_muted` | `muted: bool` | `()` |
| `audio_set_equalizer` | `enabled: bool, gains: Vec<f32>` (len 10, dB) | `()` |
| `audio_set_replaygain` | `enabled: bool, gainDb: Option<f32>, preampDb: f32` | `()` |
| `audio_set_crossfade` | `ms: u32` | `()` |
| `audio_position` | – | `{ positionMs: u64, durationMs: u64, bufferedMs: u64 }` |
| `audio_spectrum` | `bins: usize` | `Vec<f32>` (0..1 magnitudes) |
| `audio_devices` | – | `Vec<{ id: String, name: String, isDefault: bool }>` |
| `audio_set_device` | `id: Option<String>` | `()` |

`WireTrack` is the subset of `Track` the engine needs:
`{ uri, title, durationMs, isLive, gainDb?, path? }`.
`WireStream` mirrors `StreamRef`:
`{ url, mimeType?, kind, expiresAt?, headers?, localPath? }`.

Events on channel `ritmo://audio`: the `EngineEvent` union from
`packages/core/src/engine/types.ts`, serialised with `#[serde(tag = "type", rename_all = "camelCase")]`
and camelCase fields.

## library  (src/library/commands.rs)

| command | args | returns |
|---|---|---|
| `library_scan` | `folders: Vec<String>` | `ScanResult` — `{ added, updated, removed, errors: [{path, message}], durationMs }` |
| `library_cancel_scan` | – | `()` |
| `library_set_watching` | `enabled: bool, folders: Vec<String>` | `()` |
| `library_refresh_file` | `path: String` | `Option<Value>` — a full `Track` JSON |
| `library_pick_folder` | – | `Option<String>` |
| `library_pick_album` | – | `Option<String>` — folder picker worded for one release |
| `library_pick_files` | – | `Option<Vec<String>>` — multi-select, filtered to `tags::AUDIO_EXTENSIONS` |
| `library_import_files` | `paths: Vec<String>` | `{ imported, skipped, errors: [{path, message}], tracks: [Track] }` — imports loose files without adding their directories as watched roots |

Events on `ritmo://scan`: `ScanProgress` — `{ phase, filesSeen, filesImported, currentPath? }`.
Events on `ritmo://library-changed`: `{ added: [uri], removed: [uri] }`.

## packs  (src/packs/)

| command | args | returns |
|---|---|---|
| `pack_pick_export_path` | `defaultName: Option<String>` | `Option<String>` — save dialog for one `pack.json`; the chosen file's directory is remembered as a write grant |
| `pack_write` | `path: String, contents: String` | `()` — writes an already-serialised `pack.json`; refuses a path outside a grant, a non-`.json` name, or more than 2 MiB |
| `pack_pick_import` | – | `Option<String>` — open dialog, filtered to `.json`; grants the chosen file's directory |
| `pack_read` | `path: String` | `Value` — the parsed `pack.json`; rejects over 2 MiB (checked from the directory entry, before the read) and anything whose `format` is not `ritmopack` |
| `pack_pick_publish_dir` | – | `Option<String>` — folder picker; grants the folder |
| `pack_publish` | `dir: String, request: PublishRequest` | `{ dir, indexPath, packs, covers }` |
| `pack_publish_staging_dir` | – | `String` — `<cache>/publish`, emptied and granted; where a hosted publish stages its tree |
| `pack_publish_github` | `token: String, repo: String, branch: Option<String>, dir: String` | `{ indexUrl, repoUrl, pagesPending }` |
| `github_check_token` | `token: String` | `{ login, scopesOk }` |

`PublishRequest` is `{ name, description?, packs: PublishPack[] }` and
`PublishPack` is
`{ id, name, description?, author?, trackCount, updatedAt, json, coverPath?, artworkUrl? }`,
where `json` is the `pack.json` the core layer serialised and `coverPath` is an
absolute local image. `pack_publish` writes the `docs/packs.md` tree —
`index.json`, `packs/<id>.json`, `covers/<id>.<ext>` — into `dir`: each `id` must
be `[A-Za-z0-9._-]+` (so it cannot escape the folder), each pack's `artwork` is
rewritten to the cover actually written next to it, and a `coverPath` outside the
app's own cache/data directories is skipped rather than copied.

Every path argument here is confined to a directory one of the pickers returned
in this session, resolved through the same `confine` the `net` commands use, so
`..` and symlink escapes are rejected. `pack_publish_staging_dir` records such a
grant for a path **Rust** chose inside the app's own cache — not one the WebView
named — which is what lets a hosted publish run without a folder dialog; it
empties the folder first, so a pack deleted since the last publish is not still
in the tree that goes up.

### GitHub Pages

`pack_publish_github` uploads a tree `pack_publish` has already written, so the
two run in that order and this command never serialises a pack itself. `dir`
must be a granted folder; `branch` defaults to the repository's default branch.
The sequence is:

1. `GET /user` — resolve the login, and fail early when the token is rejected.
2. `GET /repos/{owner}/{repo}`, and `POST /user/repos`
   (`private: false`, `auto_init: true`) when that is a 404.
3. `POST /git/blobs` per file (JSON as `utf-8`, covers as `base64`) →
   `POST /git/trees` based on the branch's current tree → `POST /git/commits` →
   `PATCH /git/refs/heads/{branch}` (or `POST /git/refs` when the branch is
   new). One commit, so a subscriber never sees an `index.json` whose
   `pack.json` has not landed yet.
4. `POST /repos/{owner}/{repo}/pages` with `source.branch` + `source.path=/`;
   an existing-Pages 409 counts as success.

`indexUrl` is `https://{owner}.github.io/{repo}/index.json`, and `pagesPending`
is true when this call switched Pages on — the address then needs about a minute
before it answers. A publish refuses more than 200 files or 20 MiB in total.

`github_check_token` is the same first step on its own, so Settings can validate
a pasted token without publishing anything. `scopesOk` is false only when the
token itself reports that it lacks `public_repo`; a fine-grained token reports no
scopes at all and is therefore reported as `true`.

The token is passed per call and never stored by Rust: it goes into one
`Authorization` header marked sensitive, is never logged, and never appears in
an error message.

## net  (src/net/commands.rs)

| command | args | returns |
|---|---|---|
| `http_request` | `req: { url, method?, headers?, body?, timeoutMs?, cacheTtlSec? }` | `{ status, headers, body, fromCache }` |
| `download_file` | `id: String, url: String, headers: Option<Map<String,String>>, destRelative: String` | `{ path, bytes }` |
| `cancel_download` | `id: String` | `()` |
| `cache_size` | – | `u64` bytes |
| `cache_prune` | `maxBytes: u64` | `u64` bytes freed |
| `cache_clear` | – | `()` |
| `open_external` | `url: String` | `()` |
| `dir_size` | `path: String` | `u64` |
| `file_exists` | `path: String` | `bool` |
| `read_text_file` | `path: String` | `String` |
| `write_text_file` | `path: String, contents: String` | `()` |
| `remove_file` | `path: String` | `()` |

Events on `ritmo://download`: `{ id, received, total? }`.

## app  (src/commands.rs)

| command | args | returns |
|---|---|---|
| `app_info` | – | `{ app: String, platform: String, engine: String }` |
| `app_paths` | – | `{ data, cache, artwork, audio, http }` |
| `settings_load` | – | `Option<String>` — the JSON `Settings` blob |
| `settings_save` | `json: String` | `()` |
| `media_set_metadata` | `track: Option<Value>` | `()` |
| `media_set_state` | `{ status, positionMs, durationMs, canGoNext, canGoPrevious }` | `()` |
| `notify` | `title: String, body: String, iconPath: Option<String>` | `()` |
| `system_accent` | – | `Option<{ hex: String, wallpaperPath: Option<String> }>` — representative colour of the GNOME desktop wallpaper (`picture-uri-dark`, else `picture-uri`); `null` when there is none or it cannot be read |
| `window_ready` | – | `()` — shows the window once React has painted |

Events on `ritmo://media-command`: the `MediaSessionCommand` union
(`{ type: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop' } | { type: 'seek', positionMs } | { type: 'setVolume', volume }`),
emitted by MPRIS, the tray menu and the window's own hotkeys.
