//! Publishing a pack tree to GitHub Pages, from inside the app.
//!
//! The folder publish in [`super::publish`] stays the general answer — it
//! serves any static host. This module is the hosted path: given a token and a
//! repository name it creates the repository if it has to, pushes the tree
//! `super::publish` already wrote, turns Pages on and hands back the address to
//! share. No terminal, no `git`.
//!
//! The upload goes through the Git Data API rather than one Contents call per
//! file: blobs → tree → commit → ref is **one** commit, so a subscriber never
//! fetches an `index.json` that points at a `pack.json` which is not there yet.
//!
//! Two rules hold everywhere in here. The token is a secret: it travels in an
//! `Authorization` header marked sensitive, and it is never logged and never
//! interpolated into an error. And the folder must be one a picker returned
//! this session — the same [`super::confined`] check every other pack write
//! goes through.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION};
use reqwest::{Client, Method};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use tracing::{info, warn};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{blocking, confined};

const API: &str = "https://api.github.com";
/// Pinned so a future default cannot change the shapes parsed below.
const API_VERSION: &str = "2022-11-28";

/// A pack tree is kilobytes of JSON and a handful of covers. These caps are
/// what stops a mistyped folder — a music library, a home directory — from
/// being uploaded to a public repository.
const MAX_FILES: usize = 200;
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;

/// `auto_init` lands the first commit asynchronously, so a brand-new
/// repository can still answer "empty" for a moment after it is created.
const FRESH_REPO_ATTEMPTS: u32 = 5;
const FRESH_REPO_WAIT: Duration = Duration::from_millis(900);

/// GitHub asks callers not to fire mutating requests back to back, and answers
/// a burst with a "secondary rate limit" 403 rather than a queue. A publish is
/// normally three files, so this is invisible; it is what keeps a 200-file one
/// from being refused halfway through.
const BLOB_SPACING: Duration = Duration::from_millis(120);

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// These endpoints answer with small documents; anything larger is a sign we
/// are not talking to the API we think we are.
const MAX_REPLY_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCheck {
    pub login: String,
    pub scopes_ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPublishResult {
    pub index_url: String,
    pub repo_url: String,
    /// Pages was switched on by this publish, so the address needs about a
    /// minute before it answers. Reported rather than pretended away.
    pub pages_pending: bool,
}

#[tauri::command]
pub async fn github_check_token(state: State<'_, AppState>, token: String) -> AppResult<TokenCheck> {
    let api = Api::new(state.net.client(), &token)?;
    let (login, scopes_ok) = api.whoami().await?;
    info!(login = %login, scopes_ok, "github token checked");
    Ok(TokenCheck { login, scopes_ok })
}

#[tauri::command]
pub async fn pack_publish_github(
    state: State<'_, AppState>,
    token: String,
    repo: String,
    branch: Option<String>,
    dir: String,
) -> AppResult<GithubPublishResult> {
    let repo = repo_name(&repo)?;
    let root = confined(&dir)?;
    let api = Api::new(state.net.client(), &token)?;

    let uploads = blocking(move || collect(&root)).await?;
    let (owner, _) = api.whoami().await?;
    let repository = api.ensure_repo(&owner, &repo).await?;

    let branch = match branch.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => branch_name(name)?,
        _ => branch_name(&repository.default_branch)?,
    };

    let head = api.head(&owner, &repo, &branch, repository.created).await?;
    let commit = api.push(&owner, &repo, &uploads, head.as_ref()).await?;
    api.move_ref(&owner, &repo, &branch, &commit, head.is_some())
        .await?;

    let pages_pending = api.enable_pages(&owner, &repo, &branch).await?;

    info!(
        owner = %owner,
        repo = %repo,
        branch = %branch,
        files = uploads.len(),
        pages_pending,
        "published packs to github pages"
    );

    Ok(GithubPublishResult {
        index_url: index_url(&owner, &repo),
        repo_url: repository.html_url,
        pages_pending,
    })
}

// ── the tree to upload ──────────────────────────────────────────────────────

struct Upload {
    /// Repository-relative path with `/` separators, as the tree API wants it.
    path: String,
    content: Vec<u8>,
    /// JSON goes up as `utf-8`, covers as `base64`.
    text: bool,
}

/// Refuses before anything is read, so an accidental folder costs one directory
/// walk rather than a 20 MiB upload.
fn within_budget(files: usize, bytes: u64) -> AppResult<()> {
    if files > MAX_FILES {
        return Err(AppError::BadRequest(format!(
            "a publish may upload at most {MAX_FILES} files; this folder holds {files}. Point Ritmo at a folder that only contains a published pack tree."
        )));
    }
    if bytes > MAX_TOTAL_BYTES {
        let mib = MAX_TOTAL_BYTES / (1024 * 1024);
        let found = bytes / (1024 * 1024);
        return Err(AppError::BadRequest(format!(
            "a publish may upload at most {mib} MiB; this folder holds {found} MiB. Point Ritmo at a folder that only contains a published pack tree."
        )));
    }
    Ok(())
}

fn collect(root: &Path) -> AppResult<Vec<Upload>> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    let mut bytes = 0u64;

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
    {
        let entry = entry.map_err(|e| AppError::Other(format!("could not read the folder: {e}")))?;
        // Symlinks are not followed, so they are not files here either: a link
        // must not become a way to upload something outside the folder.
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| AppError::Other("a file escaped the publish folder".to_string()))?;
        let Some(path) = repo_path(relative) else {
            continue;
        };

        bytes = bytes.saturating_add(entry.metadata().map(|m| m.len()).unwrap_or(0));
        found.push((path, entry.path().to_path_buf()));
        within_budget(found.len(), bytes)?;
    }

    if found.is_empty() {
        return Err(AppError::BadRequest(
            "there is nothing to upload: write the pack tree to this folder first".to_string(),
        ));
    }

    let mut uploads = Vec::with_capacity(found.len());
    for (path, source) in found {
        let content = std::fs::read(&source).map_err(|e| super::io_error(&source, e))?;
        // A cover that claims to be JSON still goes up as base64 rather than
        // failing the publish, so the classification is by content, not name.
        let text = path.ends_with(".json") && std::str::from_utf8(&content).is_ok();
        uploads.push(Upload { path, content, text });
    }
    Ok(uploads)
}

/// `packs/p_1.json` for the tree API, or `None` for anything we will not
/// upload: a non-UTF-8 name, and dot files such as a `.git` directory that
/// happens to sit in the folder the user picked.
fn repo_path(relative: &Path) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for component in relative.components() {
        let part = component.as_os_str().to_str()?;
        if part.is_empty() || part.starts_with('.') {
            return None;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

// ── names ───────────────────────────────────────────────────────────────────

fn is_name(raw: &str, dots: bool) -> bool {
    !raw.is_empty()
        && raw.len() <= 100
        && raw != "."
        && raw != ".."
        && raw.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '-' || c == '_' || (dots && c == '.') || c == '/'
        })
}

/// Repository names reach the API inside a path, so they are checked rather
/// than trusted: `../../` in a name would otherwise address another endpoint.
fn repo_name(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if is_name(trimmed, true) && !trimmed.contains('/') {
        Ok(trimmed.to_string())
    } else {
        Err(AppError::BadRequest(
            "a repository name may only use letters, digits, dots, hyphens and underscores"
                .to_string(),
        ))
    }
}

fn branch_name(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if is_name(trimmed, false) && !trimmed.starts_with('/') && !trimmed.ends_with('/') {
        Ok(trimmed.to_string())
    } else {
        Err(AppError::BadRequest(
            "a branch name may only use letters, digits, hyphens, underscores and slashes"
                .to_string(),
        ))
    }
}

/// Where the published index will answer. A repository named
/// `<owner>.github.io` is served at the domain root, not under a path.
fn index_url(owner: &str, repo: &str) -> String {
    let host = format!("{}.github.io", owner.to_ascii_lowercase());
    if repo.to_ascii_lowercase() == host {
        format!("https://{host}/index.json")
    } else {
        format!("https://{host}/{repo}/index.json")
    }
}

/// Classic tokens report their scopes in a header; fine-grained ones report
/// nothing at all, so an absent header is "cannot tell from here" rather than
/// "insufficient" — what a token may actually do surfaces when it is used.
fn scopes_ok(header: Option<&str>) -> bool {
    match header {
        None => true,
        Some(raw) => raw
            .split(',')
            .map(str::trim)
            .any(|scope| scope == "public_repo" || scope == "repo"),
    }
}

// ── the API ─────────────────────────────────────────────────────────────────

struct Reply {
    status: u16,
    body: Value,
    /// `x-oauth-scopes`, present only for a classic token.
    scopes: Option<String>,
}

struct Repository {
    default_branch: String,
    html_url: String,
    /// This publish created it, so its first commit may still be landing.
    created: bool,
}

struct Head {
    commit: String,
    tree: String,
}

struct Api<'a> {
    client: &'a Client,
    auth: HeaderValue,
}

impl<'a> Api<'a> {
    /// Reuses the app's client, which is where the `User-Agent` GitHub insists
    /// on lives, along with the connection pool and the redirect policy.
    fn new(client: &'a Client, token: &str) -> AppResult<Self> {
        Ok(Self {
            client,
            auth: auth_header(token)?,
        })
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> AppResult<Reply> {
        let mut request = self
            .client
            .request(method, format!("{API}{path}"))
            .header(AUTHORIZATION, self.auth.clone())
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION)
            .timeout(REQUEST_TIMEOUT);
        if let Some(payload) = body {
            request = request.json(&payload);
        }

        let response = request
            .send()
            .await
            .map_err(|e| AppError::Http(format!("GitHub could not be reached: {e}")))?;

        let status = response.status().as_u16();
        let scopes = response
            .headers()
            .get("x-oauth-scopes")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        if response
            .content_length()
            .is_some_and(|len| len > MAX_REPLY_BYTES)
        {
            return Err(AppError::Http(
                "GitHub answered with an unexpectedly large document".to_string(),
            ));
        }
        let text = response
            .text()
            .await
            .map_err(|e| AppError::Http(format!("GitHub's answer could not be read: {e}")))?;
        // 204s and some errors answer with nothing at all; the status carries
        // the meaning in that case.
        let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);

        Ok(Reply {
            status,
            body,
            scopes,
        })
    }

    async fn whoami(&self) -> AppResult<(String, bool)> {
        let reply = self.call(Method::GET, "/user", None).await?;
        match reply.status {
            200 => {
                let login = reply
                    .body
                    .get("login")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !is_name(&login, false) || login.contains('/') {
                    return Err(AppError::Other(
                        "GitHub did not say which account this token belongs to".to_string(),
                    ));
                }
                Ok((login, scopes_ok(reply.scopes.as_deref())))
            }
            status => Err(api_error(
                "GitHub could not identify the token",
                status,
                &reply.body,
            )),
        }
    }

    async fn ensure_repo(&self, owner: &str, repo: &str) -> AppResult<Repository> {
        let reply = self
            .call(Method::GET, &format!("/repos/{owner}/{repo}"), None)
            .await?;
        match reply.status {
            200 => Ok(repository(&reply.body, owner, repo, false)),
            404 => self.create_repo(owner, repo).await,
            status => Err(api_error(
                "the repository could not be looked up",
                status,
                &reply.body,
            )),
        }
    }

    async fn create_repo(&self, owner: &str, repo: &str) -> AppResult<Repository> {
        let reply = self
            .call(
                Method::POST,
                "/user/repos",
                Some(json!({
                    "name": repo,
                    "description": "Ritmo packs",
                    // Pages on a free account only serves public repositories,
                    // and a Bazaar index is meant to be fetched by strangers.
                    "private": false,
                    // Gives the repository a first commit, so there is a branch
                    // to base this publish's tree on.
                    "auto_init": true,
                    "has_issues": false,
                    "has_projects": false,
                    "has_wiki": false,
                })),
            )
            .await?;
        match reply.status {
            201 => {
                info!(owner = %owner, repo = %repo, "created the packs repository");
                Ok(repository(&reply.body, owner, repo, true))
            }
            403 if !rate_limited(&reply.body) => Err(AppError::BadRequest(
                "the token cannot create repositories. Create a new one with the public_repo scope, or make the repository on GitHub first."
                    .to_string(),
            )),
            status => Err(api_error(
                "the repository could not be created",
                status,
                &reply.body,
            )),
        }
    }

    /// The branch's current commit and tree, or `None` when the repository has
    /// no commits yet.
    async fn head(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
        fresh: bool,
    ) -> AppResult<Option<Head>> {
        let attempts = if fresh { FRESH_REPO_ATTEMPTS } else { 1 };
        for attempt in 0..attempts {
            let reply = self
                .call(
                    Method::GET,
                    &format!("/repos/{owner}/{repo}/git/ref/heads/{branch}"),
                    None,
                )
                .await?;
            match reply.status {
                200 => {
                    let sha = reply
                        .body
                        .pointer("/object/sha")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AppError::Other("GitHub did not report the branch's commit".to_string())
                        })?
                        .to_string();
                    let tree = self.tree_of(owner, repo, &sha).await?;
                    return Ok(Some(Head { commit: sha, tree }));
                }
                // 404: no such branch. 409: the repository has no commits at
                // all — both mean "nothing to base this commit on".
                404 | 409 if attempt + 1 == attempts => return Ok(None),
                404 | 409 => tokio::time::sleep(FRESH_REPO_WAIT).await,
                status => {
                    return Err(api_error(
                        "the branch could not be read",
                        status,
                        &reply.body,
                    ))
                }
            }
        }
        Ok(None)
    }

    async fn tree_of(&self, owner: &str, repo: &str, commit: &str) -> AppResult<String> {
        let reply = self
            .call(
                Method::GET,
                &format!("/repos/{owner}/{repo}/git/commits/{commit}"),
                None,
            )
            .await?;
        if reply.status != 200 {
            return Err(api_error(
                "the branch's current files could not be read",
                reply.status,
                &reply.body,
            ));
        }
        reply
            .body
            .pointer("/tree/sha")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| AppError::Other("GitHub did not report the commit's tree".to_string()))
    }

    /// Blobs, then one tree on top of the branch's current one, then one
    /// commit. Nothing is visible to a subscriber until the ref moves.
    async fn push(
        &self,
        owner: &str,
        repo: &str,
        uploads: &[Upload],
        head: Option<&Head>,
    ) -> AppResult<String> {
        let mut entries: Vec<Value> = Vec::with_capacity(uploads.len());
        for (index, upload) in uploads.iter().enumerate() {
            if index > 0 {
                tokio::time::sleep(BLOB_SPACING).await;
            }
            let sha = self.blob(owner, repo, upload).await?;
            entries.push(json!({
                "path": upload.path,
                "mode": "100644",
                "type": "blob",
                "sha": sha,
            }));
        }

        let mut tree = json!({ "tree": entries });
        if let (Some(head), Some(object)) = (head, tree.as_object_mut()) {
            // Based on the current tree so a publish replaces the pack files it
            // owns without deleting anything else in the repository.
            object.insert("base_tree".to_string(), json!(head.tree));
        }
        let reply = self
            .call(
                Method::POST,
                &format!("/repos/{owner}/{repo}/git/trees"),
                Some(tree),
            )
            .await?;
        if reply.status != 201 {
            return Err(api_error(
                "the file tree was refused",
                reply.status,
                &reply.body,
            ));
        }
        let tree_sha = reply
            .body
            .get("sha")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Other("GitHub did not report the new tree".to_string()))?
            .to_string();

        let parents = match head {
            Some(head) => vec![head.commit.clone()],
            None => Vec::new(),
        };
        let reply = self
            .call(
                Method::POST,
                &format!("/repos/{owner}/{repo}/git/commits"),
                Some(json!({
                    "message": "Publish Ritmo packs",
                    "tree": tree_sha,
                    "parents": parents,
                })),
            )
            .await?;
        if reply.status != 201 {
            return Err(api_error(
                "the commit was refused",
                reply.status,
                &reply.body,
            ));
        }
        reply
            .body
            .get("sha")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| AppError::Other("GitHub did not report the new commit".to_string()))
    }

    async fn blob(&self, owner: &str, repo: &str, upload: &Upload) -> AppResult<String> {
        let body = if upload.text {
            json!({
                "content": String::from_utf8_lossy(&upload.content),
                "encoding": "utf-8",
            })
        } else {
            json!({
                "content": base64::engine::general_purpose::STANDARD.encode(&upload.content),
                "encoding": "base64",
            })
        };
        let reply = self
            .call(
                Method::POST,
                &format!("/repos/{owner}/{repo}/git/blobs"),
                Some(body),
            )
            .await?;
        if reply.status != 201 {
            return Err(api_error(
                &format!("{} could not be uploaded", upload.path),
                reply.status,
                &reply.body,
            ));
        }
        reply
            .body
            .get("sha")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| AppError::Other("GitHub did not report the uploaded file".to_string()))
    }

    async fn move_ref(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
        commit: &str,
        exists: bool,
    ) -> AppResult<()> {
        let (method, path, body) = if exists {
            (
                Method::PATCH,
                format!("/repos/{owner}/{repo}/git/refs/heads/{branch}"),
                json!({ "sha": commit, "force": false }),
            )
        } else {
            (
                Method::POST,
                format!("/repos/{owner}/{repo}/git/refs"),
                json!({ "ref": format!("refs/heads/{branch}"), "sha": commit }),
            )
        };

        let reply = self.call(method, &path, Some(body)).await?;
        match reply.status {
            200 | 201 => Ok(()),
            422 => Err(AppError::BadRequest(format!(
                "the {branch} branch moved while Ritmo was publishing; publish again"
            ))),
            status => Err(api_error(
                "the branch could not be updated",
                status,
                &reply.body,
            )),
        }
    }

    /// `true` when this call switched Pages on, which is the case that takes a
    /// minute before the address answers.
    async fn enable_pages(&self, owner: &str, repo: &str, branch: &str) -> AppResult<bool> {
        let reply = self
            .call(
                Method::POST,
                &format!("/repos/{owner}/{repo}/pages"),
                Some(json!({ "source": { "branch": branch, "path": "/" } })),
            )
            .await?;
        match reply.status {
            201 | 204 => Ok(true),
            // Already serving this repository.
            409 => Ok(false),
            422 => {
                warn!(owner = %owner, repo = %repo, "github pages is configured differently already");
                Ok(false)
            }
            403 if !rate_limited(&reply.body) => Err(AppError::BadRequest(
                "the packs were uploaded, but GitHub Pages could not be turned on: the token needs the public_repo scope. Paste a token with that scope, or turn Pages on under the repository's Settings."
                    .to_string(),
            )),
            status => Err(api_error(
                "the packs were uploaded, but GitHub Pages could not be turned on",
                status,
                &reply.body,
            )),
        }
    }
}

fn repository(body: &Value, owner: &str, repo: &str, created: bool) -> Repository {
    Repository {
        default_branch: body
            .get("default_branch")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_string(),
        html_url: body
            .get("html_url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://github.com/{owner}/{repo}")),
        created,
    }
}

/// The one place the token is turned into bytes. Marked sensitive so it stays
/// out of any `Debug` rendering of the request, and the failure path describes
/// the shape of the problem without quoting what was pasted.
fn auth_header(token: &str) -> AppResult<HeaderValue> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "paste a GitHub token in Settings › Integrations first".to_string(),
        ));
    }
    let mut value = HeaderValue::from_str(&format!("Bearer {trimmed}")).map_err(|_| {
        AppError::BadRequest(
            "that does not look like a GitHub token — copy it again, without line breaks"
                .to_string(),
        )
    })?;
    value.set_sensitive(true);
    Ok(value)
}

/// GitHub reports its secondary rate limit as a 403, which otherwise reads as a
/// missing scope. Telling them apart is the difference between an actionable
/// message and a wrong one.
fn rate_limited(body: &Value) -> bool {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    message.contains("rate limit") || message.contains("abuse")
}

fn detail(body: &Value) -> String {
    match body.get("message").and_then(Value::as_str) {
        Some(message) if !message.trim().is_empty() => format!(": {}", message.trim()),
        _ => String::new(),
    }
}

/// Every failure the caller did not expect, worded as something the user can
/// act on. A bare status number is the last resort, never the whole message.
fn api_error(context: &str, status: u16, body: &Value) -> AppError {
    let detail = detail(body);
    match status {
        401 => AppError::BadRequest(format!(
            "{context}: GitHub rejected the token. Create a new one with the public_repo scope and paste it again."
        )),
        403 if rate_limited(body) => AppError::Http(format!(
            "{context}: GitHub is rate-limiting this token; wait a minute and publish again"
        )),
        403 => AppError::BadRequest(format!(
            "{context}: GitHub refused the token — it is missing the public_repo scope, or an organisation policy blocks it{detail}"
        )),
        404 => AppError::NotFound(format!(
            "{context}: GitHub has no such repository, or this token cannot see it"
        )),
        422 => AppError::BadRequest(format!("{context}: GitHub rejected the request{detail}")),
        429 => AppError::Http(format!(
            "{context}: GitHub is rate-limiting this token; try again in a minute"
        )),
        status if status >= 500 => AppError::Http(format!(
            "{context}: GitHub is having trouble right now; try again in a minute"
        )),
        status => AppError::Http(format!("{context}: GitHub answered {status}{detail}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for a pasted credential. Deliberately not shaped like a real
    /// one, so no scanner mistakes this file for a leak.
    const SECRET: &str = "not-a-real-credential-0123456789";

    #[test]
    fn the_file_count_cap_is_enforced() {
        assert!(within_budget(MAX_FILES, 1).is_ok());
        match within_budget(MAX_FILES + 1, 1) {
            Err(AppError::BadRequest(message)) => {
                assert!(message.contains("200"), "unhelpful message: {message}");
            }
            other => panic!("expected a refusal, got {:?}", other.err()),
        }
    }

    #[test]
    fn the_size_cap_is_enforced() {
        assert!(within_budget(1, MAX_TOTAL_BYTES).is_ok());
        match within_budget(1, MAX_TOTAL_BYTES + 1) {
            Err(AppError::BadRequest(message)) => {
                assert!(message.contains("20 MiB"), "unhelpful message: {message}");
            }
            other => panic!("expected a refusal, got {:?}", other.err()),
        }
    }

    #[test]
    fn collect_reads_the_published_tree_and_skips_dot_files() {
        let base = std::env::temp_dir().join("ritmo-github-collect");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("packs")).expect("packs");
        std::fs::create_dir_all(base.join("covers")).expect("covers");
        std::fs::create_dir_all(base.join(".git")).expect("git");
        std::fs::write(base.join("index.json"), b"{}").expect("index");
        std::fs::write(base.join("packs/p_one.json"), b"{}").expect("pack");
        std::fs::write(base.join("covers/p_one.jpg"), [0xff, 0xd8, 0xff]).expect("cover");
        std::fs::write(base.join(".git/config"), b"[core]").expect("config");

        let uploads = collect(&base).expect("collect");
        let paths: Vec<&str> = uploads.iter().map(|u| u.path.as_str()).collect();
        assert_eq!(paths, ["covers/p_one.jpg", "index.json", "packs/p_one.json"]);
        // JSON goes up as text, the cover as base64.
        assert!(!uploads[0].text);
        assert!(uploads[1].text);
        assert!(uploads[2].text);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_folder_is_refused() {
        let base = std::env::temp_dir().join("ritmo-github-empty");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("dir");
        assert!(matches!(collect(&base), Err(AppError::BadRequest(_))));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_folder_no_picker_returned_is_refused() {
        // The grant list is process-global, so the assertion is on the error
        // *shape* — exactly as `packs::mod`'s own test does it — which keeps
        // this independent of whether another test granted something first.
        let path = std::env::temp_dir().join("ritmo-github-no-grant");
        match confined(&path.to_string_lossy()) {
            Err(AppError::BadRequest(_)) => {}
            Ok(_) => panic!("an ungranted folder was accepted"),
            Err(e) => panic!("unexpected error: {e}"),
        }
    }

    #[test]
    fn repo_and_branch_names_cannot_address_another_endpoint() {
        assert_eq!(repo_name(" ritmo-packs ").expect("name"), "ritmo-packs");
        assert_eq!(repo_name("packs.v2").expect("name"), "packs.v2");
        for bad in ["", "..", "a/b", "../../user/repos", "pa cks", "pácks"] {
            assert!(repo_name(bad).is_err(), "accepted repo {bad:?}");
        }

        assert_eq!(branch_name("gh-pages").expect("name"), "gh-pages");
        assert_eq!(branch_name("release/1").expect("name"), "release/1");
        for bad in ["", "..", "/main", "main/", "ma in"] {
            assert!(branch_name(bad).is_err(), "accepted branch {bad:?}");
        }
    }

    #[test]
    fn the_index_url_follows_the_pages_rules() {
        assert_eq!(
            index_url("Codeyevsky", "ritmo-packs"),
            "https://codeyevsky.github.io/ritmo-packs/index.json"
        );
        // A repository named after the account is served at the domain root.
        assert_eq!(
            index_url("codeyevsky", "codeyevsky.github.io"),
            "https://codeyevsky.github.io/index.json"
        );
    }

    #[test]
    fn scope_headers_are_read_the_way_github_writes_them() {
        assert!(scopes_ok(Some("public_repo")));
        assert!(scopes_ok(Some("gist, public_repo, read:user")));
        assert!(scopes_ok(Some("repo")));
        assert!(!scopes_ok(Some("")));
        assert!(!scopes_ok(Some("gist, read:user")));
        // Fine-grained tokens send no header; the publish itself reports what
        // they may not do.
        assert!(scopes_ok(None));
    }

    #[test]
    fn the_token_never_reaches_an_error_message() {
        let messages = [
            // An interior newline survives the trim and cannot become a header.
            auth_header(&format!("{SECRET}\nsecond line"))
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default(),
            auth_header("   ")
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default(),
            api_error("x", 401, &json!({ "message": "Bad credentials" })).to_string(),
            api_error("x", 403, &json!({ "message": "Resource not accessible" })).to_string(),
            api_error("x", 404, &Value::Null).to_string(),
            api_error("x", 503, &Value::Null).to_string(),
        ];
        for message in messages {
            assert!(!message.is_empty());
            assert!(!message.contains(SECRET), "token leaked into {message:?}");
            assert!(!message.contains("Bearer"), "header leaked into {message:?}");
        }
    }

    #[test]
    fn a_sensitive_header_keeps_the_token_out_of_debug_output() {
        let header = auth_header(SECRET).expect("header");
        assert!(header.is_sensitive());
        assert!(!format!("{header:?}").contains(SECRET));
    }

    #[test]
    fn a_rate_limit_is_not_reported_as_a_missing_scope() {
        let limited = api_error(
            "x",
            403,
            &json!({ "message": "You have exceeded a secondary rate limit" }),
        )
        .to_string();
        assert!(limited.contains("rate-limiting"), "{limited}");
        assert!(!limited.contains("public_repo"), "{limited}");

        let scope = api_error("x", 403, &json!({ "message": "Must have admin rights" })).to_string();
        assert!(scope.contains("public_repo"), "{scope}");
    }

    #[test]
    fn unexpected_statuses_stay_actionable() {
        let message =
            api_error("the commit was refused", 422, &json!({ "message": "nope" })).to_string();
        assert!(message.contains("the commit was refused"));
        assert!(message.contains("nope"));
    }
}
