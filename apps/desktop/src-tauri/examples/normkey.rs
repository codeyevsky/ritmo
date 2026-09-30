//! Prints `normalize_key` for each stdin line, so the Rust and TypeScript
//! implementations can be diffed. They MUST agree: the scanner writes the
//! `*_key` columns and the TypeScript side queries them.
use std::io::BufRead;

fn main() {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        println!("{}", serde_json::to_string(&ritmo_lib::library::tags::normalize_key(&line)).unwrap_or_default());
    }
}
