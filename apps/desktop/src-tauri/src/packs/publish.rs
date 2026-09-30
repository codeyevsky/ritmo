//! Publishing: the `index.json` + `packs/*.json` + `covers/*` tree from
//! `docs/packs.md`, written into a folder the user picks.
//!
//! Ritmo never uploads anything. The user gets a folder they can drop on any
//! static host, and the command reports the path plus the URL shape to share.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tracing::{info, warn};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{
    blocking, confined, cover_extension, grant, io_error, safe_component, start_dir, MAX_PACKS,
    MAX_PACK_BYTES,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPack {
    /// Becomes `packs/<id>.json`, so it has to survive [`safe_component`].
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub track_count: u32,
    pub updated_at: i64,
    /// The `pack.json` document, already serialised by the core pack layer.
    pub json: String,
    /// Absolute path of a local cover to copy into `covers/`.
    pub cover_path: Option<String>,
    /// Absolute `http(s)` cover, used when there is no local file to copy.
    pub artwork_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    /// The index's own name — whatever the publisher typed.
    pub name: String,
    pub description: Option<String>,
    pub packs: Vec<PublishPack>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub dir: String,
    pub index_path: String,
    pub packs: u32,
    pub covers: u32,
}

#[tauri::command]
pub async fn pack_pick_publish_dir() -> AppResult<Option<String>> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("Choose a folder to publish into");
    if let Some(start) = start_dir() {
        dialog = dialog.set_directory(start);
    }

    let Some(handle) = dialog.pick_folder().await else {
        return Ok(None);
    };
    let dir = handle.path().to_path_buf();
    grant(&dir);
    Ok(Some(dir.to_string_lossy().into_owned()))
}

/// Where a hosted publish stages the tree before uploading it.
const STAGING: &str = "publish";

/// The folder `pack_publish` writes into when the destination is a host rather
/// than somewhere the user picked.
///
/// The grant this records is on a path Rust chose inside the app's own cache —
/// not on one the WebView named — so the confinement rule is unchanged: a
/// write still has to land inside a directory this process itself decided on.
/// The cache is already writable through `net`'s file commands, so nothing new
/// is reachable either.
#[tauri::command]
pub async fn pack_publish_staging_dir(state: State<'_, AppState>) -> AppResult<String> {
    let dir = state.paths.cache.join(STAGING);
    blocking(move || {
        // Wiped rather than reused: a pack deleted since the last publish must
        // not still be sitting in the tree that gets uploaded.
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(&dir, e)),
        }
        std::fs::create_dir_all(&dir).map_err(|e| io_error(&dir, e))?;
        grant(&dir);
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn pack_publish(
    state: State<'_, AppState>,
    dir: String,
    request: PublishRequest,
) -> AppResult<PublishResult> {
    if request.packs.is_empty() {
        return Err(AppError::BadRequest("nothing to publish".to_string()));
    }
    if request.packs.len() > MAX_PACKS {
        return Err(AppError::BadRequest(format!(
            "an index may not list more than {MAX_PACKS} packs"
        )));
    }

    let root = confined(&dir)?;
    // Covers are copied from the artwork cache the scanner wrote, so that is
    // the only place a cover may be read from: the WebView must not be able to
    // turn "publish" into "copy any file I name into a folder I can read".
    let cover_roots = vec![state.paths.cache.clone(), state.paths.data.clone()];

    blocking(move || write_tree(&root, &cover_roots, request)).await
}

fn write_tree(
    root: &Path,
    cover_roots: &[PathBuf],
    request: PublishRequest,
) -> AppResult<PublishResult> {
    let packs_dir = root.join("packs");
    std::fs::create_dir_all(&packs_dir).map_err(|e| io_error(&packs_dir, e))?;

    let mut entries: Vec<Value> = Vec::with_capacity(request.packs.len());
    let mut covers = 0u32;

    for pack in request.packs {
        let id = safe_component(&pack.id)?;
        if pack.json.len() as u64 > MAX_PACK_BYTES {
            return Err(AppError::BadRequest(format!(
                "pack {id} exceeds {MAX_PACK_BYTES} bytes"
            )));
        }

        let cover = match pack.cover_path.as_deref() {
            Some(path) => copy_cover(root, cover_roots, &id, path)?,
            None => None,
        };
        if cover.is_some() {
            covers += 1;
        }

        // `packs/<id>.json` sits one level down, so the copied cover is
        // `../covers/<id>.<ext>` from there; the index refers to the same file
        // as `covers/<id>.<ext>`, relative to itself.
        let pack_artwork = cover
            .as_ref()
            .map(|name| format!("../covers/{name}"))
            .or_else(|| pack.artwork_url.clone());
        let document = rewrite_artwork(&pack.json, pack_artwork.as_deref())?;

        let path = packs_dir.join(format!("{id}.json"));
        std::fs::write(&path, document.as_bytes()).map_err(|e| io_error(&path, e))?;

        entries.push(json!({
            "id": id,
            "name": pack.name,
            "description": pack.description.unwrap_or_default(),
            "author": pack.author.unwrap_or_default(),
            "trackCount": pack.track_count,
            "artwork": cover
                .map(|name| format!("covers/{name}"))
                .or(pack.artwork_url),
            "url": format!("packs/{id}.json"),
            "updatedAt": pack.updated_at,
        }));
    }

    let index = json!({
        "format": "ritmobazaar",
        "version": 1,
        "name": request.name,
        "description": request.description.unwrap_or_default(),
        "updatedAt": now_ms(),
        "packs": entries,
    });
    let index_path = root.join("index.json");
    let text = pretty(&index)?;
    std::fs::write(&index_path, text.as_bytes()).map_err(|e| io_error(&index_path, e))?;

    let packs = u32::try_from(index["packs"].as_array().map(Vec::len).unwrap_or(0)).unwrap_or(0);
    info!(dir = %root.display(), packs, covers, "published packs");

    Ok(PublishResult {
        dir: root.to_string_lossy().into_owned(),
        index_path: index_path.to_string_lossy().into_owned(),
        packs,
        covers,
    })
}

/// Pretty JSON with a trailing newline, the way both documents are written.
fn pretty(value: &Value) -> AppResult<String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::Other(format!("could not serialise the document: {e}")))?;
    Ok(format!("{text}\n"))
}

/// Epoch milliseconds. Local rather than borrowed from `db`, which keeps its
/// own clock private.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Copies one cover into `covers/<id>.<ext>`, returning that file name.
/// A cover that cannot be read is skipped with a warning: a missing image must
/// not cost the publisher the whole tree.
fn copy_cover(
    root: &Path,
    cover_roots: &[PathBuf],
    id: &str,
    raw: &str,
) -> AppResult<Option<String>> {
    let source = match crate::net::commands::confine(cover_roots, raw) {
        Ok(path) => path,
        Err(e) => {
            warn!(id, error = %e, "cover is outside the artwork cache; not copied");
            return Ok(None);
        }
    };
    let Some(ext) = cover_extension(&source) else {
        warn!(id, path = %source.display(), "cover is not an image we publish");
        return Ok(None);
    };

    let covers_dir = root.join("covers");
    std::fs::create_dir_all(&covers_dir).map_err(|e| io_error(&covers_dir, e))?;
    let name = format!("{id}.{ext}");
    let target = covers_dir.join(&name);
    match std::fs::copy(&source, &target) {
        Ok(_) => Ok(Some(name)),
        Err(e) => {
            warn!(id, error = %e, "cover could not be copied");
            Ok(None)
        }
    }
}

/// Re-serialises a `pack.json` with its `artwork` pointing at what was
/// actually written next to it.
fn rewrite_artwork(json: &str, artwork: Option<&str>) -> AppResult<String> {
    let mut value: Value = serde_json::from_str(json)
        .map_err(|e| AppError::BadRequest(format!("pack is not valid JSON: {e}")))?;
    let Some(object) = value.as_object_mut() else {
        return Err(AppError::BadRequest("a pack must be a JSON object".to_string()));
    };
    object.insert(
        "artwork".to_string(),
        match artwork {
            Some(path) => Value::String(path.to_string()),
            None => Value::Null,
        },
    );
    // `serde_json`'s default map preserves insertion order, so the document
    // still reads in the order `docs/packs.md` documents it.
    pretty(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(id: &str, cover: Option<&str>) -> PublishPack {
        PublishPack {
            id: id.to_string(),
            name: format!("Pack {id}"),
            description: None,
            author: Some("codeyevsky".to_string()),
            track_count: 2,
            updated_at: 1_764_500_000_000,
            json: format!(
                r#"{{"format":"ritmopack","version":1,"id":"{id}","name":"Pack {id}","artwork":null,"tracks":[]}}"#
            ),
            cover_path: cover.map(str::to_string),
            artwork_url: None,
        }
    }

    #[test]
    fn publishing_writes_the_documented_tree() {
        let base = std::env::temp_dir().join("ritmo-publish-test");
        let _ = std::fs::remove_dir_all(&base);
        let cache = base.join("cache");
        let out = base.join("my-packs");
        std::fs::create_dir_all(&cache).expect("cache");
        std::fs::create_dir_all(&out).expect("out");
        let cover = cache.join("abc.jpg");
        std::fs::write(&cover, b"not really a jpeg").expect("cover");

        let request = PublishRequest {
            name: "codeyevsky's packs".to_string(),
            description: None,
            packs: vec![
                pack("p_one", Some(&cover.to_string_lossy())),
                pack("p_two", None),
            ],
        };
        let result =
            write_tree(&out, &[cache.clone()], request).expect("publish");

        assert_eq!(result.packs, 2);
        assert_eq!(result.covers, 1);
        assert!(out.join("index.json").is_file());
        assert!(out.join("packs/p_one.json").is_file());
        assert!(out.join("packs/p_two.json").is_file());
        assert!(out.join("covers/p_one.jpg").is_file());

        let index: Value =
            serde_json::from_str(&std::fs::read_to_string(out.join("index.json")).expect("read"))
                .expect("index json");
        assert_eq!(index["format"], json!("ritmobazaar"));
        assert_eq!(index["version"], json!(1));
        assert_eq!(index["packs"][0]["url"], json!("packs/p_one.json"));
        assert_eq!(index["packs"][0]["artwork"], json!("covers/p_one.jpg"));
        assert_eq!(index["packs"][1]["artwork"], Value::Null);
        assert_eq!(index["packs"][0]["trackCount"], json!(2));

        // The pack file points at the cover relative to itself, one level down.
        let one: Value = serde_json::from_str(
            &std::fs::read_to_string(out.join("packs/p_one.json")).expect("read"),
        )
        .expect("pack json");
        assert_eq!(one["artwork"], json!("../covers/p_one.jpg"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_traversing_id_never_leaves_the_folder() {
        let base = std::env::temp_dir().join("ritmo-publish-escape");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("dir");

        let request = PublishRequest {
            name: "x".to_string(),
            description: None,
            packs: vec![pack("../../etc/cron.d/evil", None)],
        };
        assert!(matches!(
            write_tree(&base, &[], request),
            Err(AppError::BadRequest(_))
        ));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_cover_outside_the_cache_is_skipped_not_copied() {
        let base = std::env::temp_dir().join("ritmo-publish-cover");
        let _ = std::fs::remove_dir_all(&base);
        let cache = base.join("cache");
        let elsewhere = base.join("elsewhere");
        let out = base.join("out");
        for dir in [&cache, &elsewhere, &out] {
            std::fs::create_dir_all(dir).expect("dir");
        }
        let secret = elsewhere.join("secret.jpg");
        std::fs::write(&secret, b"x").expect("write");

        let request = PublishRequest {
            name: "x".to_string(),
            description: None,
            packs: vec![pack("p_one", Some(&secret.to_string_lossy()))],
        };
        let result = write_tree(&out, &[cache], request).expect("publish");

        assert_eq!(result.covers, 0);
        assert!(!out.join("covers").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn artwork_is_replaced_in_place() {
        let json = r#"{"format":"ritmopack","name":"A","artwork":"whatever"}"#;
        let out = rewrite_artwork(json, Some("../covers/p_1.jpg")).expect("rewrite");
        let value: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(value["artwork"], json!("../covers/p_1.jpg"));
        assert_eq!(value["name"], json!("A"));

        let cleared = rewrite_artwork(json, None).expect("rewrite");
        let value: Value = serde_json::from_str(&cleared).expect("json");
        assert_eq!(value["artwork"], Value::Null);
    }

    #[test]
    fn a_non_object_pack_is_refused() {
        assert!(matches!(
            rewrite_artwork("[]", None),
            Err(AppError::BadRequest(_))
        ));
    }
}
