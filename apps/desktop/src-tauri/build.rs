use std::fs;
use std::path::Path;

fn main() {
    // `generate_context!` embeds the built frontend into the binary, but cargo
    // only watches Rust sources, so a rebuild after a frontend change used to
    // keep the old bundle and silently ship stale UI. Watching the dist tree
    // makes the frontend a real input.
    watch(Path::new("../../web/dist"));
    tauri_build::build()
}

fn watch(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            watch(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
