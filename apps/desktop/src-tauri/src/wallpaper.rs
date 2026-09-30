//! The desktop wallpaper's representative colour.
//!
//! GNOME derives its own accent from the background image, and Ritmo offers the
//! same thing: read the wallpaper GNOME is actually showing, reduce it to one
//! colour, and hand that to the frontend as `#rrggbb`.
//!
//! The reduction mirrors `dominantColor` in `packages/core/src/util/color.ts`
//! deliberately — a plain mean of a photograph trends to mud, so pixels are
//! bucketed coarsely, near-black and near-white ones are dropped and saturated
//! buckets are weighted up, and the winner's lightness is clamped into a band
//! that works both as a surface tint and as a button fill.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Longest edge the wallpaper is reduced to before any pixel is inspected: a 4K
/// image contributes the same ~4k samples as a thumbnail would.
const SAMPLE_EDGE: u32 = 64;

/// The dark key first: it is what the shell paints under a dark colour scheme,
/// and it is unset on setups that use a single wallpaper, where the light key
/// holds the real value.
const WALLPAPER_KEYS: [&str; 2] = ["picture-uri-dark", "picture-uri"];

pub struct Accent {
    pub hex: String,
    pub path: PathBuf,
}

/// `None` when no wallpaper is configured, `gsettings` is missing (a non-GNOME
/// session), or the file cannot be decoded.
pub fn accent() -> Option<Accent> {
    let path = wallpaper_path()?;
    let hex = representative_hex(&path)?;
    tracing::debug!(wallpaper = %path.display(), accent = %hex, "wallpaper accent resolved");
    Some(Accent { hex, path })
}

/// `gsettings get` prints a GVariant, i.e. the value single-quoted with
/// backslash escapes, plus a trailing newline.
fn gsettings(key: &str) -> Option<String> {
    let output = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.background", key])
        .output()
        .map_err(|e| tracing::debug!(key, error = %e, "gsettings unavailable"))
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let text = raw.trim();
    let inner = text
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .unwrap_or(text);
    let unescaped = inner.replace("\\'", "'").replace("\\\\", "\\");
    if unescaped.is_empty() {
        None
    } else {
        Some(unescaped)
    }
}

fn wallpaper_path() -> Option<PathBuf> {
    for key in WALLPAPER_KEYS {
        let Some(value) = gsettings(key) else { continue };
        // Both keys hold a percent-encoded `file://` URI; `Url` does the
        // decoding. A few themes write a bare path instead, so that is accepted
        // too rather than silently yielding no accent.
        let candidate = if value.contains("://") {
            url::Url::parse(&value)
                .ok()
                .and_then(|u| u.to_file_path().ok())
        } else {
            Some(PathBuf::from(&value))
        };
        match candidate {
            Some(path) if path.is_file() => return Some(path),
            _ => tracing::debug!(key, value = %value, "wallpaper is not a readable file"),
        }
    }
    None
}

fn representative_hex(path: &Path) -> Option<String> {
    let image = image::open(path)
        .map_err(|e| tracing::debug!(path = %path.display(), error = %e, "wallpaper not decodable"))
        .ok()?;
    // Downscale first: everything below runs over at most SAMPLE_EDGE² pixels
    // no matter how large the wallpaper is.
    let sample = image
        .resize(SAMPLE_EDGE, SAMPLE_EDGE, image::imageops::FilterType::Triangle)
        .to_rgba8();

    #[derive(Default, Clone, Copy)]
    struct Bucket {
        r: f64,
        g: f64,
        b: f64,
        count: f64,
        score: f64,
    }
    // 4 bits per channel: coarse enough that a gradient lands in one bucket,
    // fine enough to keep two different hues apart.
    let mut buckets: std::collections::HashMap<u16, Bucket> = std::collections::HashMap::new();
    let mut mean = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);

    for pixel in sample.pixels() {
        let [r, g, b, a] = pixel.0;
        if a < 128 {
            continue;
        }
        mean.0 += f64::from(r);
        mean.1 += f64::from(g);
        mean.2 += f64::from(b);
        mean.3 += 1.0;

        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        // Near-black and near-white carry no hue; a dark wallpaper would
        // otherwise resolve to charcoal.
        if max < 26 || min > 232 {
            continue;
        }
        let saturation = f64::from(max - min) / f64::from(max);

        let key = (u16::from(r >> 4) << 8) | (u16::from(g >> 4) << 4) | u16::from(b >> 4);
        let bucket = buckets.entry(key).or_default();
        bucket.r += f64::from(r);
        bucket.g += f64::from(g);
        bucket.b += f64::from(b);
        bucket.count += 1.0;
        // Vividness beats sheer pixel count, so a large muddy sky does not win
        // over the one saturated subject.
        bucket.score += 0.35 + saturation;
    }

    let winner = buckets
        .values()
        .copied()
        .fold(None::<Bucket>, |best, bucket| match best {
            Some(b) if b.score >= bucket.score => Some(b),
            _ => Some(bucket),
        });

    let Some(winner) = winner.filter(|b| b.count > 0.0) else {
        // Nothing but black and white in the image: fall back to its mean.
        if mean.3 == 0.0 {
            return None;
        }
        return Some(to_hex(mean.0 / mean.3, mean.1 / mean.3, mean.2 / mean.3));
    };

    let (h, s, l) = rgb_to_hsl(
        winner.r / winner.count,
        winner.g / winner.count,
        winner.b / winner.count,
    );
    // Keep the accent usable as a surface tint and as a button fill: clamp the
    // lightness into a mid band and give very grey colours a little help.
    let s = clamp01(if s < 0.2 { s + 0.12 } else { s.min(0.9) });
    let l = l.clamp(0.38, 0.62);
    let (r, g, b) = hsl_to_rgb(h, s, l);
    Some(to_hex(r, g, b))
}

fn clamp01(n: f64) -> f64 {
    if n.is_finite() {
        n.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn to_hex(r: f64, g: f64, b: f64) -> String {
    let byte = |n: f64| -> u8 {
        if n.is_finite() {
            n.round().clamp(0.0, 255.0) as u8
        } else {
            0
        }
    };
    format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
}

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return (0.0, 0.0, l);
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let mut h = if max == r {
        ((g - b) / d) % 6.0
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } * 60.0;
    if h < 0.0 {
        h += 360.0;
    }
    (h, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    let h = ((h % 360.0) + 360.0) % 360.0;
    let chroma = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = chroma * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - chroma / 2.0;
    let (r, g, b) = if h < 60.0 {
        (chroma, x, 0.0)
    } else if h < 120.0 {
        (x, chroma, 0.0)
    } else if h < 180.0 {
        (0.0, chroma, x)
    } else if h < 240.0 {
        (0.0, x, chroma)
    } else if h < 300.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    ((r + m) * 255.0, (g + m) * 255.0, (b + m) * 255.0)
}
