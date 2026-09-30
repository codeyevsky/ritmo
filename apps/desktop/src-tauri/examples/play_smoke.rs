//! End-to-end audio diagnostic: decode → DSP → cpal output, with no Tauri and
//! no WebView involved.
//!
//!   cargo run --example play_smoke -- <file-or-url> [seconds]
//!
//! It plays for real (you should hear it) and then asserts that the playhead
//! actually advanced, which is the part a unit test cannot cover: everything up
//! to `Output::push` can be correct while the device still produces silence.

use std::sync::Arc;
use std::time::{Duration, Instant};

use ritmo_lib::audio::commands::{WireStream, WireTrack};
use ritmo_lib::audio::AudioEngine;
use ritmo_lib::state::Paths;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("RUST_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("ritmo_lib=debug,warn")),
        )
        .with_writer(std::io::stderr)
        .init();

    let mut args = std::env::args().skip(1);
    let target = args
        .next()
        .ok_or("usage: play_smoke <file-or-url> [seconds]")?;
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(4);

    let paths = Paths::resolve()?;
    let is_local = !target.starts_with("http://") && !target.starts_with("https://");

    let engine = AudioEngine::new(
        paths,
        Arc::new(|channel: &str, payload: serde_json::Value| {
            println!("[{channel}] {payload}");
        }),
    )?;

    engine.set_volume(0.6)?;
    engine.load(
        WireTrack {
            uri: "smoke:track:1".into(),
            title: target.clone(),
            duration_ms: 0,
            is_live: false,
            gain_db: None,
            path: if is_local { Some(target.clone()) } else { None },
        },
        WireStream {
            url: target.clone(),
            mime_type: None,
            kind: "progressive".into(),
            expires_at: None,
            headers: Default::default(),
            local_path: if is_local { Some(target) } else { None },
        },
        None,
        true,
    )?;

    // Opening a remote source and filling the first buffer both happen on the
    // engine thread, so give it a moment before judging progress.
    let deadline = Instant::now() + Duration::from_secs(seconds.max(2));
    let mut first_movement: Option<Duration> = None;
    let started = Instant::now();
    let mut last = 0u64;

    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        let pos = engine.position();
        if pos.position_ms > last {
            if first_movement.is_none() {
                first_movement = Some(started.elapsed());
            }
            last = pos.position_ms;
        }
        println!(
            "pos={:>6}ms  dur={:>6}ms  buffered={:>5}ms",
            pos.position_ms, pos.duration_ms, pos.buffered_ms
        );
    }

    engine.stop()?;

    match first_movement {
        Some(t) => {
            println!(
                "\nOK: playhead advanced to {last} ms (first movement after {} ms)",
                t.as_millis()
            );
            Ok(())
        }
        None => Err("FAIL: the playhead never advanced — no audio reached the device".into()),
    }
}
