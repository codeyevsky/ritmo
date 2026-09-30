//! Per-host minimum-interval gate.
//!
//! Several of the services Ritmo reads from answer a burst with a 429 and then
//! a temporary ban, so outbound requests are spaced out before they are sent
//! rather than being retried after the fact.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use tokio::sync::Mutex;

/// Published limits of the hosts with one. MusicBrainz documents 1 req/s and
/// counts strictly, hence the 100 ms of headroom.
const DEFAULTS: &[(&str, u64)] = &[
    ("musicbrainz.org", 1100),
    ("coverartarchive.org", 250),
    ("lrclib.net", 250),
    ("ws.audioscrobbler.com", 250),
    ("archive.org", 200),
];

struct Gate {
    min_interval_ms: AtomicU64,
    /// Async mutex, because it is deliberately held across the spacing sleep:
    /// that is what serialises concurrent callers onto the same host.
    last_issued: Mutex<Option<Instant>>,
}

impl Gate {
    fn new(min_interval_ms: u64) -> Self {
        Self {
            min_interval_ms: AtomicU64::new(min_interval_ms),
            last_issued: Mutex::new(None),
        }
    }
}

pub struct HostThrottle {
    gates: DashMap<String, Arc<Gate>>,
}

impl HostThrottle {
    pub fn new() -> Self {
        let throttle = Self {
            gates: DashMap::new(),
        };
        for (host, interval) in DEFAULTS {
            throttle.set_interval(host, *interval);
        }
        throttle
    }

    /// Waits until this host's next slot, then reserves it.
    pub async fn acquire(&self, host: &str) {
        let gate = self.gate(host);
        let interval = Duration::from_millis(gate.min_interval_ms.load(Ordering::Relaxed));
        if interval.is_zero() {
            return;
        }

        let mut last = gate.last_issued.lock().await;
        if let Some(previous) = *last {
            let elapsed = previous.elapsed();
            if elapsed < interval {
                tokio::time::sleep(interval - elapsed).await;
            }
        }
        *last = Some(Instant::now());
    }

    pub fn set_interval(&self, host: &str, min_interval_ms: u64) {
        self.gate(host)
            .min_interval_ms
            .store(min_interval_ms, Ordering::Relaxed);
    }

    /// Returns an owned handle so no shard lock is held across an await.
    fn gate(&self, host: &str) -> Arc<Gate> {
        let key = host.to_ascii_lowercase();
        if let Some(existing) = self.gates.get(&key) {
            return Arc::clone(existing.value());
        }
        Arc::clone(
            self.gates
                .entry(key)
                .or_insert_with(|| Arc::new(Gate::new(0)))
                .value(),
        )
    }
}

impl Default for HostThrottle {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn interval_is_enforced_between_consecutive_acquires() {
        let throttle = HostThrottle::new();
        throttle.set_interval("example.test", 80);

        throttle.acquire("example.test").await;
        let start = Instant::now();
        throttle.acquire("example.test").await;
        let spacing = start.elapsed();

        assert!(
            spacing >= Duration::from_millis(70),
            "second acquire returned after only {spacing:?}"
        );
    }

    #[tokio::test]
    async fn unknown_hosts_are_not_delayed() {
        let throttle = HostThrottle::new();
        let start = Instant::now();
        for _ in 0..8 {
            throttle.acquire("unlimited.test").await;
        }
        assert!(start.elapsed() < Duration::from_millis(40));
    }

    #[tokio::test]
    async fn hosts_do_not_block_each_other() {
        let throttle = HostThrottle::new();
        throttle.set_interval("slow.test", 500);
        throttle.acquire("slow.test").await;

        let start = Instant::now();
        throttle.acquire("other.test").await;
        assert!(start.elapsed() < Duration::from_millis(40));
    }

    #[tokio::test]
    async fn host_matching_ignores_case() {
        let throttle = HostThrottle::new();
        throttle.set_interval("Mixed.Case.Test", 90);

        throttle.acquire("mixed.case.test").await;
        let start = Instant::now();
        throttle.acquire("MIXED.CASE.TEST").await;
        assert!(start.elapsed() >= Duration::from_millis(80));
    }

    #[tokio::test]
    async fn defaults_cover_the_rate_limited_hosts() {
        let throttle = HostThrottle::new();
        for (host, expected) in DEFAULTS {
            let gate = throttle.gate(host);
            assert_eq!(gate.min_interval_ms.load(Ordering::Relaxed), *expected);
        }
    }
}
