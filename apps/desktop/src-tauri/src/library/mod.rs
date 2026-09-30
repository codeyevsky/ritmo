//! Local music library: folder scanning, tag reading, artwork caching and
//! filesystem watching.

pub mod commands;
pub mod tags;

mod artwork;
mod scanner;
mod watcher;

pub use scanner::{ScanError, ScanResult, Scanner};
