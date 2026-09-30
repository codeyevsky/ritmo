//! Desktop audio stack: symphonia decode → biquad EQ → ReplayGain → cpal.

pub mod commands;
mod decoder;
mod dsp;
mod engine;
mod output;
mod source;

pub use commands::{WireStream, WireTrack};
pub use engine::{AudioEngine, EmitFn, Position};
pub use output::DeviceInfo;
