//! The proxied HTTP client: one pooled `reqwest::Client`, a retry policy tuned
//! for rate-limited public APIs, and a body cap so a runaway response cannot
//! take the process down.

use std::collections::HashMap;
use std::time::Duration;

use rand::Rng;
use reqwest::header::HeaderMap;
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::error::{AppError, AppResult};

use super::Net;

/// MusicBrainz rejects requests whose User-Agent does not identify the
/// application and offer a way to contact its author, so the contact URL is
/// part of the string rather than a comment about it.
const USER_AGENT: &str = "Ritmo/0.1.0 ( https://github.com/ritmo/ritmo )";

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const TIMEOUT_BOUNDS_MS: (u64, u64) = (1_000, 300_000);
const MAX_ATTEMPTS: u32 = 3;
const BACKOFF_BASE_MS: u64 = 400;
const BACKOFF_FACTOR: u64 = 3;
/// A hostile or confused `Retry-After` must not be able to park a UI request
/// for minutes.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum HttpMethod {
    #[default]
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "POST")]
    Post,
    #[serde(rename = "PUT")]
    Put,
    #[serde(rename = "DELETE")]
    Delete,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
            HttpMethod::Put => "PUT",
            HttpMethod::Delete => "DELETE",
        }
    }

    fn as_method(self) -> Method {
        match self {
            HttpMethod::Get => Method::GET,
            HttpMethod::Post => Method::POST,
            HttpMethod::Put => Method::PUT,
            HttpMethod::Delete => Method::DELETE,
        }
    }

    /// Replaying a POST can create a second resource; the others cannot.
    fn is_idempotent(self) -> bool {
        !matches!(self, HttpMethod::Post)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<HttpMethod>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub cache_ttl_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub from_cache: bool,
}

pub fn build_client() -> AppResult<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(8)
        .gzip(true)
        .brotli(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(AppError::from)
}

pub async fn perform(net: &Net, req: HttpRequest) -> AppResult<HttpResponse> {
    let url = reqwest::Url::parse(&req.url)
        .map_err(|e| AppError::BadRequest(format!("invalid url {:?}: {e}", req.url)))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::BadRequest(format!(
                "refusing to fetch scheme {other:?}"
            )))
        }
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let method = req.method.unwrap_or_default();
    let ttl = req.cache_ttl_sec.unwrap_or(0);
    let key = super::cache::cache_key(method.as_str(), &req.url, req.body.as_deref());

    if ttl > 0 {
        match net.cache.get(&key) {
            Ok(Some(hit)) => {
                debug!(url = %req.url, "response served from cache");
                return Ok(hit);
            }
            Ok(None) => {}
            // A damaged cache row is a nuisance, never a reason to fail a
            // request the network could still satisfy.
            Err(e) => warn!(error = %e, url = %req.url, "cache lookup failed"),
        }
    }

    net.throttle.acquire(&host).await;
    let res = send_with_retries(&net.client, &url, method, &req).await?;

    if ttl > 0 {
        if let Err(e) = net.cache.put(&key, &req.url, &res, ttl) {
            warn!(error = %e, url = %req.url, "could not store response in cache");
        }
    }
    Ok(res)
}

async fn send_with_retries(
    client: &Client,
    url: &reqwest::Url,
    method: HttpMethod,
    req: &HttpRequest,
) -> AppResult<HttpResponse> {
    let timeout = Duration::from_millis(
        req.timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(TIMEOUT_BOUNDS_MS.0, TIMEOUT_BOUNDS_MS.1),
    );

    let mut attempt: u32 = 0;
    loop {
        let mut rb = client
            .request(method.as_method(), url.clone())
            .timeout(timeout);
        if let Some(headers) = &req.headers {
            for (name, value) in headers {
                rb = rb.header(name.as_str(), value.as_str());
            }
        }
        if let Some(body) = &req.body {
            rb = rb.body(body.clone());
        }

        let outcome = rb.send().await;
        attempt += 1;
        let exhausted = attempt >= MAX_ATTEMPTS || !method.is_idempotent();

        let wait = match outcome {
            Ok(resp) => {
                let status = resp.status();
                if !is_retryable_status(status) || exhausted {
                    return read_response(resp).await;
                }
                let wait = retry_after(resp.headers()).unwrap_or_else(|| jittered_backoff(attempt - 1));
                // Dropping the response before sleeping releases the
                // connection back to the pool instead of pinning it.
                drop(resp);
                warn!(
                    url = %url, %status, attempt,
                    wait_ms = wait.as_millis() as u64,
                    "retrying request"
                );
                wait
            }
            Err(e) => {
                // Connect and timeout failures are transient. A decode or body
                // failure will repeat, so it is reported straight away.
                if exhausted || !(e.is_timeout() || e.is_connect()) {
                    return Err(AppError::Http(e.to_string()));
                }
                let wait = jittered_backoff(attempt - 1);
                warn!(
                    url = %url, error = %e, attempt,
                    wait_ms = wait.as_millis() as u64,
                    "retrying request after transport failure"
                );
                wait
            }
        };

        tokio::time::sleep(wait).await;
    }
}

fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let raw = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim();
    if let Ok(secs) = raw.parse::<u64>() {
        return Some(Duration::from_secs(secs).min(RETRY_AFTER_CAP));
    }
    let when = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    let delta = when.timestamp_millis() - super::now_ms();
    if delta <= 0 {
        return Some(Duration::ZERO);
    }
    Some(Duration::from_millis(delta as u64).min(RETRY_AFTER_CAP))
}

/// 400 ms, 1.2 s, 3.6 s, … — pure so the schedule can be asserted on.
fn backoff_ms(retry: u32) -> u64 {
    BACKOFF_BASE_MS.saturating_mul(BACKOFF_FACTOR.saturating_pow(retry.min(8)))
}

fn jittered_backoff(retry: u32) -> Duration {
    let base = backoff_ms(retry) as f64;
    // `ThreadRng` is `!Send`, so the sample is taken and dropped here rather
    // than anywhere it could straddle an await point.
    let factor: f64 = rand::rng().random_range(0.8..1.2);
    Duration::from_millis((base * factor).round() as u64)
}

async fn read_response(mut resp: reqwest::Response) -> AppResult<HttpResponse> {
    let status = resp.status().as_u16();

    let mut headers = HashMap::with_capacity(resp.headers().len());
    for (name, value) in resp.headers().iter() {
        if let Ok(text) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), text.to_string());
        }
    }

    if let Some(len) = resp.content_length() {
        if len > MAX_BODY_BYTES as u64 {
            return Err(AppError::Http(format!(
                "response body of {len} bytes exceeds the {MAX_BODY_BYTES} byte cap"
            )));
        }
    }

    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| AppError::Http(e.to_string()))? {
        if buf.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err(AppError::Http(format!(
                "response body exceeds the {MAX_BODY_BYTES} byte cap"
            )));
        }
        buf.extend_from_slice(&chunk);
    }

    // Providers occasionally mislabel their charset; the frontend only ever
    // parses JSON and M3U out of this, so lossy UTF-8 beats a hard failure.
    Ok(HttpResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&buf).into_owned(),
        from_cache: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_matches_the_documented_schedule() {
        assert_eq!(backoff_ms(0), 400);
        assert_eq!(backoff_ms(1), 1_200);
        assert_eq!(backoff_ms(2), 3_600);
    }

    #[test]
    fn backoff_is_monotonic_and_saturates() {
        let mut prev = 0u64;
        for retry in 0..12 {
            let ms = backoff_ms(retry);
            assert!(ms >= prev, "backoff went backwards at retry {retry}");
            prev = ms;
        }
    }

    #[test]
    fn jitter_stays_within_twenty_percent() {
        for retry in 0..3 {
            let base = backoff_ms(retry) as f64;
            for _ in 0..200 {
                let ms = jittered_backoff(retry).as_millis() as f64;
                assert!(ms >= base * 0.8 - 1.0 && ms <= base * 1.2 + 1.0, "{ms} out of range");
            }
        }
    }

    #[test]
    fn only_429_and_5xx_are_retried() {
        assert!(is_retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_status(StatusCode::BAD_GATEWAY));
        assert!(is_retryable_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(!is_retryable_status(StatusCode::NOT_FOUND));
        assert!(!is_retryable_status(StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_status(StatusCode::OK));
    }

    #[test]
    fn post_is_never_replayed() {
        assert!(!HttpMethod::Post.is_idempotent());
        assert!(HttpMethod::Get.is_idempotent());
        assert!(HttpMethod::Put.is_idempotent());
        assert!(HttpMethod::Delete.is_idempotent());
    }

    #[test]
    fn retry_after_seconds_and_dates_are_honoured() {
        let mut headers = HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "5".parse().expect("literal header"));
        assert_eq!(retry_after(&headers), Some(Duration::from_secs(5)));

        headers.insert(reqwest::header::RETRY_AFTER, "600".parse().expect("literal header"));
        assert_eq!(retry_after(&headers), Some(RETRY_AFTER_CAP));

        headers.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().expect("literal header"),
        );
        assert_eq!(retry_after(&headers), Some(Duration::ZERO));

        headers.insert(reqwest::header::RETRY_AFTER, "nonsense".parse().expect("literal header"));
        assert_eq!(retry_after(&headers), None);
    }

    #[test]
    fn method_deserialises_from_the_wire_spelling() {
        let req: HttpRequest =
            serde_json::from_str(r#"{"url":"https://x.test","method":"POST","cacheTtlSec":60}"#)
                .expect("valid request");
        assert_eq!(req.method, Some(HttpMethod::Post));
        assert_eq!(req.cache_ttl_sec, Some(60));
        assert!(req.headers.is_none());
    }
}
