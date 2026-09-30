# Packs and the Bazaar — FROZEN CONTRACT

A **pack** is a named, ordered, shareable set of tracks with its own artwork and
description. It is what the user builds when they want a custom album that only
exists in their library, and what they hand to someone else.

The **Bazaar** browses packs published by anyone. There is no Ritmo server: a
publisher writes a static `index.json` plus the pack files next to it, puts them
on any static host (GitHub Pages, an S3 bucket, a plain nginx directory, even a
local folder), and shares the index URL. Subscribers add that URL. This is
federated by construction — nothing to run, nothing to moderate centrally, and
no single point that can disappear and take the catalogue with it.

## Why packs carry metadata, not audio

A pack ships **track identity, not audio files**:

* A pack is kilobytes rather than gigabytes, so it can live in a git repo.
* Publishing a set of *references* is categorically different from
  redistributing recordings the publisher has no right to redistribute.
* The same pack resolves against whatever sources each subscriber has enabled —
  their local files, Audius, Jamendo, the Internet Archive — so it keeps working
  when one source goes away.

On import every entry is resolved in order: the exact provider `uri` first, then
the local library, then a fuzzy match across enabled providers using
title + artist + duration. Entries that resolve to nothing are kept in the pack
and shown as unavailable rather than silently dropped, so a pack never loses
tracks just because a subscriber lacks a source today.

## `pack.json` — one pack

```jsonc
{
  "format": "ritmopack",
  "version": 1,
  "id": "p_8f2c1a",              // stable across edits and re-exports
  "name": "Late Night Drive",
  "description": "",             // optional, plain text
  "author": "",                  // free-form; whatever the publisher types
  "artwork": "cover.jpg",        // path relative to this file, or an absolute URL, or null
  "createdAt": 1764500000000,    // epoch ms
  "updatedAt": 1764500000000,
  "tracks": [
    {
      "uri": "audius:track:AbC123",   // preferred resolution key; may be null for a hand-written pack
      "title": "Power Aerobic",
      "artists": ["Van Snyder"],
      "album": "Mix",                  // optional
      "durationMs": 210000,            // used by the fuzzy matcher; 0 when unknown
      "isrc": null                     // optional, strongest match key when present
    }
  ]
}
```

`title` and `artists` are **required** even when `uri` is set: the uri is a hint,
and the pack has to stay resolvable after the provider that minted it is gone.

## `index.json` — a Bazaar source

```jsonc
{
  "format": "ritmobazaar",
  "version": 1,
  "name": "codeyevsky's packs",
  "description": "",
  "updatedAt": 1764500000000,
  "packs": [
    {
      "id": "p_8f2c1a",
      "name": "Late Night Drive",
      "description": "",
      "author": "codeyevsky",
      "trackCount": 24,
      "artwork": "covers/p_8f2c1a.jpg",   // relative to the index, or absolute
      "url": "packs/p_8f2c1a.json",       // relative to the index, or absolute
      "updatedAt": 1764500000000
    }
  ]
}
```

Relative paths resolve against the index URL, so a publisher can move their whole
tree without rewriting it.

## Trust boundary

An index is a **remote document written by a stranger**. Treat every field as
hostile input:

* Never follow a `url` or `artwork` that is not `http`/`https`, and never one
  that resolves outside the index's own origin.
* Cap what a source can cost: at most 500 packs per index, 5 000 tracks per
  pack, 1 MiB per `index.json`, 2 MiB per `pack.json`.
* Strings are rendered as text, never as markup, and are truncated for display.
* A malformed or oversized document disables that source with a visible error;
  it never breaks the Bazaar or any other source.

## Schema additions

```sql
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
```

## Publishing

"Publish" writes this folder, whatever the destination is:

```
my-packs/
  index.json
  packs/p_8f2c1a.json
  covers/p_8f2c1a.jpg
```

There are two destinations, and the tree is identical for both.

**A folder.** The user picks one, Ritmo writes the tree into it, and the publish
step ends by showing the path and the URL shape to share
(`https://<host>/my-packs/index.json`). This is the general answer: it serves
any static host, and it is the only one available where the app has no network
credentials.

**GitHub Pages.** The same tree, staged in Ritmo's own cache and uploaded over
the GitHub REST API with a token the user pastes once — the repository is
created if it does not exist, the files go up as one commit, Pages is switched
on, and the publish step ends by showing the live `index.json` address. The
sequence and its limits are in `docs/ipc.md` under `pack_publish_github`. The
token is a credential: it lives in `kv`, not in `settings.json`, and a library
export never contains it.

Uploading is always something the user asked for by choosing that destination.
Nothing is sent anywhere as a side effect of editing or exporting a pack.
