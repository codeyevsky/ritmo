//! Single-instance guard.
//!
//! Two Ritmo processes would fight over the same SQLite file and the same MPRIS
//! bus name, so a second launch hands off to the first and exits. The rendezvous
//! is a Unix socket in `$XDG_RUNTIME_DIR` (which the OS clears on logout, so a
//! crashed process cannot leave a permanent lock behind).

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const RAISE: &[u8; 5] = b"raise";
const ACK: &[u8; 2] = b"ok";

fn socket_path() -> PathBuf {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    dir.join("ritmo.sock")
}

/// Returns `Err(())` when another instance already owns the socket — the caller
/// must then exit immediately. On success the returned listener must be handed
/// to [`serve`] once the app handle exists.
pub fn acquire() -> Result<UnixListener, ()> {
    let path = socket_path();

    // Hand off to a live instance — but only if it actually answers. Writing and
    // exiting immediately was a race: the socket closed before the other side
    // read it, so the launch was swallowed and the window never came forward,
    // which is why starting Ritmo appeared to need two attempts.
    if let Some(mut stream) = UnixStream::connect(&path).ok() {
        let handed_off = stream
            .set_read_timeout(Some(std::time::Duration::from_millis(1500)))
            .and_then(|()| stream.write_all(RAISE))
            .and_then(|()| stream.flush())
            .and_then(|()| {
                let mut ack = [0u8; ACK.len()];
                stream.read_exact(&mut ack)?;
                Ok(ack == *ACK)
            })
            .unwrap_or(false);

        if handed_off {
            return Err(());
        }
        tracing::warn!("a socket was present but nothing answered; taking it over");
    }

    // Nobody answered, so any socket file here is a leftover from a process that
    // died without cleaning up.
    let _ = std::fs::remove_file(&path);
    UnixListener::bind(&path).map_err(|e| {
        tracing::warn!("single-instance socket unavailable ({e}); continuing unguarded");
    })
}

pub fn serve(listener: UnixListener, app: AppHandle) {
    std::thread::Builder::new()
        .name("ritmo-single-instance".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; RAISE.len()];
                if stream.read_exact(&mut buf).is_err() || buf != *RAISE {
                    continue;
                }
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                // Acknowledge only after the window is up, so the launcher's
                // process does not exit before the raise has happened.
                let _ = stream.write_all(ACK);
                let _ = stream.flush();
            }
        })
        .ok();
}

pub fn cleanup() {
    let _ = std::fs::remove_file(socket_path());
}
