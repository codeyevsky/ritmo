-- Ritmo library schema — FROZEN CONTRACT.
--
-- The Rust `db` module owns creating this (as migration #1); the TypeScript
-- `library` layer queries it through HostBridge.db. Both sides must agree
-- exactly, so neither may change a column without changing this file.
--
-- Conventions
--   * `uri`       — the `provider:kind:id` string from types.ts. Always the PK.
--   * `*_json`    — a JSON-encoded domain object/array, stored as TEXT.
--   * `*_key`     — search-normalised form (lowercase, diacritics folded) for
--                   case/accent-insensitive lookups; produced by util/text.ts
--                   `normalizeKey` on the TS side and by the scanner in Rust.
--   * timestamps  — Unix epoch **milliseconds**, INTEGER.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artists (
  uri          TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  artwork_json TEXT,
  genres_json  TEXT,
  followers    INTEGER,
  bio          TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artists_name_key ON artists(name_key);
CREATE INDEX IF NOT EXISTS idx_artists_provider ON artists(provider);

CREATE TABLE IF NOT EXISTS albums (
  uri            TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  name           TEXT NOT NULL,
  name_key       TEXT NOT NULL,
  artists_json   TEXT NOT NULL,          -- ArtistRef[]
  primary_artist TEXT,                   -- artists[0].name, denormalised for sorting
  artwork_json   TEXT,
  release_date   TEXT,
  album_type     TEXT,
  total_tracks   INTEGER,
  genres_json    TEXT,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_albums_name_key ON albums(name_key);
CREATE INDEX IF NOT EXISTS idx_albums_artist  ON albums(primary_artist);
CREATE INDEX IF NOT EXISTS idx_albums_provider ON albums(provider);

CREATE TABLE IF NOT EXISTS tracks (
  uri            TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  title          TEXT NOT NULL,
  title_key      TEXT NOT NULL,
  artists_json   TEXT NOT NULL,          -- ArtistRef[]
  primary_artist TEXT,
  album_uri      TEXT REFERENCES albums(uri) ON DELETE SET NULL,
  album_json     TEXT,                   -- AlbumRef, kept inline so a track row
                                         -- renders without joining albums
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  track_number   INTEGER,
  disc_number    INTEGER,
  release_date   TEXT,
  genres_json    TEXT,
  artwork_json   TEXT,
  popularity     REAL,
  explicit       INTEGER NOT NULL DEFAULT 0,
  is_live        INTEGER NOT NULL DEFAULT 0,
  gain_db        REAL,
  path           TEXT,                   -- non-NULL only for provider='local'
  meta_json      TEXT,
  added_at       INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  file_mtime     INTEGER,                -- for incremental rescans
  file_size      INTEGER,
  -- JSON array of column names the user edited in the app. Tags on disk are
  -- never written, so without this a rescan would read the file again and undo
  -- the edit; the scanner's upsert leaves any column named here alone.
  edited_json    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path) WHERE path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_album     ON tracks(album_uri);
CREATE INDEX IF NOT EXISTS idx_tracks_title_key ON tracks(title_key);
CREATE INDEX IF NOT EXISTS idx_tracks_artist    ON tracks(primary_artist);
CREATE INDEX IF NOT EXISTS idx_tracks_provider  ON tracks(provider);
CREATE INDEX IF NOT EXISTS idx_tracks_added     ON tracks(added_at DESC);

-- Standalone (not external-content) FTS so a corrupt index can be rebuilt
-- without touching `tracks`. Kept in sync by the triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  uri UNINDEXED, title, artists, album, tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS trg_tracks_fts_ins AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(uri, title, artists, album)
  VALUES (new.uri, new.title, COALESCE(new.primary_artist, ''),
          COALESCE(json_extract(new.album_json, '$.name'), ''));
END;
CREATE TRIGGER IF NOT EXISTS trg_tracks_fts_del AFTER DELETE ON tracks BEGIN
  DELETE FROM tracks_fts WHERE uri = old.uri;
END;
CREATE TRIGGER IF NOT EXISTS trg_tracks_fts_upd AFTER UPDATE ON tracks BEGIN
  DELETE FROM tracks_fts WHERE uri = old.uri;
  INSERT INTO tracks_fts(uri, title, artists, album)
  VALUES (new.uri, new.title, COALESCE(new.primary_artist, ''),
          COALESCE(json_extract(new.album_json, '$.name'), ''));
END;

CREATE TABLE IF NOT EXISTS likes (
  uri      TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,                -- track | album | artist | playlist
  liked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_likes_kind ON likes(kind, liked_at DESC);

CREATE TABLE IF NOT EXISTS playlists (
  uri          TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,            -- 'ritmo' for user-owned playlists
  name         TEXT NOT NULL,
  description  TEXT,
  artwork_json TEXT,
  owner        TEXT,
  editable     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_playlists_sort ON playlists(sort_order, updated_at DESC);

-- `position` is a dense 0-based ordinal. Reorders rewrite the affected range
-- inside one transaction rather than using fractional indices, because
-- playlists here are small enough that a rewrite is cheaper than the
-- rebalancing bookkeeping.
CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_uri TEXT NOT NULL REFERENCES playlists(uri) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  track_uri    TEXT NOT NULL,
  track_json   TEXT NOT NULL,            -- snapshot: remote tracks must survive
                                         -- the provider going away
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (playlist_uri, position)
);
CREATE INDEX IF NOT EXISTS idx_pli_track ON playlist_items(track_uri);

CREATE TABLE IF NOT EXISTS play_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_uri  TEXT NOT NULL,
  track_json TEXT NOT NULL,
  played_at  INTEGER NOT NULL,
  played_ms  INTEGER NOT NULL,
  reason     TEXT NOT NULL,              -- PlayReason
  completed  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_history_at    ON play_history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_track ON play_history(track_uri, played_at DESC);

CREATE TABLE IF NOT EXISTS settings_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_config (
  provider TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (provider, key)
);

CREATE TABLE IF NOT EXISTS http_cache (
  key          TEXT PRIMARY KEY,         -- sha256(method|url|body)
  url          TEXT NOT NULL,
  status       INTEGER NOT NULL,
  headers_json TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_http_cache_exp ON http_cache(expires_at);

CREATE TABLE IF NOT EXISTS offline_audio (
  track_uri     TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  mime          TEXT,
  downloaded_at INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL         -- drives LRU pruning
);
CREATE INDEX IF NOT EXISTS idx_offline_lru ON offline_audio(last_used_at);

CREATE TABLE IF NOT EXISTS scan_state (
  folder       TEXT PRIMARY KEY,
  last_scan_at INTEGER NOT NULL,
  file_count   INTEGER NOT NULL DEFAULT 0
);

-- Packs and the Bazaar — see docs/packs.md. Added as migration 3.

CREATE TABLE IF NOT EXISTS packs (
  uri          TEXT PRIMARY KEY,     -- pack:<id>
  name         TEXT NOT NULL,
  description  TEXT,
  author       TEXT,
  artwork_json TEXT,
  -- 'local' for one the user built, 'remote' for one installed from a source.
  source       TEXT NOT NULL,
  source_url   TEXT,                 -- the index it came from, for updates
  pack_url     TEXT,                 -- the pack.json it came from
  remote_id    TEXT,                 -- `id` from the manifest
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- Dense 0-based `position`, rewritten on reorder, exactly like playlist_items.
CREATE TABLE IF NOT EXISTS pack_items (
  pack_uri   TEXT NOT NULL REFERENCES packs(uri) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  -- The manifest entry as written, so a pack survives a provider disappearing.
  match_json TEXT NOT NULL,
  -- Resolved Track snapshot, or NULL while unresolved/unavailable.
  track_json TEXT,
  track_uri  TEXT,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (pack_uri, position)
);
CREATE INDEX IF NOT EXISTS idx_pack_items_track ON pack_items(track_uri);

CREATE TABLE IF NOT EXISTS bazaar_sources (
  url           TEXT PRIMARY KEY,
  name          TEXT,
  added_at      INTEGER NOT NULL,
  last_fetch_at INTEGER,
  ok            INTEGER NOT NULL DEFAULT 1,
  error         TEXT
);
