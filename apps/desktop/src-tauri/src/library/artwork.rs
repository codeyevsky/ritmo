//! Album art cache: one 640px JPEG and one 96px thumbnail per album hash.
//!
//! The frontend never reads the originals — it gets absolute paths and runs
//! them through `convertFileSrc`, so everything the UI paints is a small,
//! predictable JPEG rather than a 4000px PNG embedded in a FLAC.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageReader, Limits};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::state::Paths;

const LARGE_EDGE: u32 = 640;
const SMALL_EDGE: u32 = 96;
const QUALITY: u8 = 85;
/// Anything wider than this is a scan or a bomb, not cover art.
const MAX_INPUT_EDGE: u32 = 16384;

const ART_STEMS: &[&str] = &["cover", "folder", "front", "album", "albumart", "artwork"];
const ART_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub enum ArtSource<'a> {
    Embedded(&'a [u8]),
    File(&'a Path),
}

/// Writes `<paths.artwork>/<hash>.jpg` (longest edge 640) and `<hash>_96.jpg`,
/// returning the `Artwork` JSON for the DB. `Ok(None)` means the source was
/// not a usable image — a corrupt cover must not fail the whole track.
pub fn cache_for_album(
    paths: &Paths,
    hash: &str,
    source: ArtSource<'_>,
) -> AppResult<Option<Value>> {
    let large = paths.artwork.join(format!("{hash}.jpg"));
    let small = paths.artwork.join(format!("{hash}_{SMALL_EDGE}.jpg"));

    if let Some(cached) = reuse(&large, &small, &source) {
        return Ok(Some(cached));
    }

    let img = match decode(&source) {
        Ok(img) => img,
        Err(e) => {
            tracing::debug!(hash, error = %e, "unusable cover art");
            return Ok(None);
        }
    };

    std::fs::create_dir_all(&paths.artwork)?;
    let large_edge = write_jpeg(&img, LARGE_EDGE, &large)?;
    let small_edge = write_jpeg(&img, SMALL_EDGE, &small)?;

    Ok(Some(artwork_json(
        (&small, small_edge),
        (&large, large_edge),
    )))
}

/// cover.jpg / folder.jpg / front.jpg / album.jpg (and .jpeg/.png/.webp)
/// sitting next to the track.
pub fn find_folder_art(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(usize, usize, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let ext = path
            .extension()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let Some(stem_rank) = ART_STEMS.iter().position(|s| *s == stem) else {
            continue;
        };
        let Some(ext_rank) = ART_EXTS.iter().position(|e| *e == ext) else {
            continue;
        };
        let better = match &best {
            Some((s, e, _)) => (stem_rank, ext_rank) < (*s, *e),
            None => true,
        };
        if better {
            best = Some((stem_rank, ext_rank, path));
        }
    }
    best.map(|(_, _, path)| path)
}

/// Both outputs present and no older than the source. `Embedded` carries no
/// timestamp of its own, so existence is all we can check there; the album
/// hash changes whenever the album identity does, and re-tagging a cover
/// in place is rare enough to be worth the saved decode on every rescan.
fn reuse(large: &Path, small: &Path, source: &ArtSource<'_>) -> Option<Value> {
    let large_at = modified(large)?;
    let small_at = modified(small)?;
    if let ArtSource::File(src) = source {
        let src_at = modified(src)?;
        if large_at < src_at || small_at < src_at {
            return None;
        }
    }
    Some(artwork_json(
        (small, longest_edge(small).unwrap_or(SMALL_EDGE)),
        (large, longest_edge(large).unwrap_or(LARGE_EDGE)),
    ))
}

fn artwork_json(small: (&Path, u32), large: (&Path, u32)) -> Value {
    let mut sources = [small, large];
    sources.sort_by_key(|(_, edge)| *edge);
    json!({
        "sources": sources
            .iter()
            .map(|(path, edge)| json!({
                "url": path.to_string_lossy().into_owned(),
                "size": edge,
            }))
            .collect::<Vec<Value>>(),
    })
}

fn decode(source: &ArtSource<'_>) -> AppResult<DynamicImage> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_INPUT_EDGE);
    limits.max_image_height = Some(MAX_INPUT_EDGE);

    match *source {
        ArtSource::Embedded(bytes) => {
            let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
            reader.limits(limits);
            reader.decode().map_err(image_err)
        }
        ArtSource::File(path) => {
            let mut reader = ImageReader::open(path)?.with_guessed_format()?;
            reader.limits(limits);
            reader.decode().map_err(image_err)
        }
    }
}

/// Returns the longest edge actually written, which may be below `max_edge`:
/// upscaling a 300px cover to 640 would only waste bytes.
fn write_jpeg(img: &DynamicImage, max_edge: u32, dest: &Path) -> AppResult<u32> {
    let rgb = if img.width().max(img.height()) > max_edge {
        img.resize(max_edge, max_edge, FilterType::Lanczos3).to_rgb8()
    } else {
        img.to_rgb8()
    };
    if rgb.width() == 0 || rgb.height() == 0 {
        return Err(AppError::Decode("cover art has a zero dimension".into()));
    }

    let mut encoded: Vec<u8> = Vec::with_capacity(32 * 1024);
    JpegEncoder::new_with_quality(&mut encoded, QUALITY)
        .encode_image(&rgb)
        .map_err(image_err)?;

    // Rename in so a reader never sees a half-written JPEG.
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dest.with_extension(format!("jpg.{seq}.tmp"));
    std::fs::write(&tmp, &encoded)?;
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(rgb.width().max(rgb.height()))
}

fn longest_edge(path: &Path) -> Option<u32> {
    image::image_dimensions(path).ok().map(|(w, h)| w.max(h))
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn image_err(e: image::ImageError) -> AppError {
    AppError::Decode(e.to_string())
}
