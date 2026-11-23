//! The application's own update check: ask the repository's latest release what version it holds.
//!
//! This is a **check**, not an install. The answer is the version and the page to open; taking the
//! update is downloading the installer from that page, which is a step a person takes with a browser
//! rather than a silent replacement of the running program. `bundle.createUpdaterArtifacts` stays
//! false and `plugins.updater` stays empty, so the tauri updater plugin is not part of this - it
//! needs a signing key this project does not have, and an unsigned silent self-replace is a worse
//! trade than one download link.
//!
//! The read happens here rather than in the webview for two reasons that are not stylistic: the
//! window's CSP has no `api.github.com` in `connect-src`, so a `fetch` from the page is refused
//! before it leaves; and the anonymous read quota is sixty an hour per address, which the logged-in
//! `gh` does not spend. So the logged-in `gh` is asked first and the plain API is the fallback, the
//! same order `agent_versions.rs` uses for the same reasons.
//!
//! Nothing here decides whether an update is *wanted*: a release is reported when it is newer than
//! the running version, and `has_update` is false otherwise. A release older than the running build
//! (a local build ahead of the tag) is not an error and must not read as one.

use std::time::Duration;

use serde::Serialize;

/// The repository whose releases are this application's releases.
const REPO: &str = "Zomcxj/Verta";

/// A release document is a few kilobytes, and a body past this is not one this build understands.
const MAX_BYTES: usize = 1024 * 1024;

/// The API read is a few kilobytes of JSON; a slow one must not hold the About page.
const READ_TIMEOUT_SECS: u64 = 15;

/// A proxy that accepts a connection and then says nothing is caught here rather than at the read's
/// own timeout, so the read without it is tried while the person is still looking at the page.
const CONNECT_TIMEOUT_SECS: u64 = 5;

/// What the About page shows after a check.
///
/// `latest_version` is `None` when the repository has no published release at all, which is a fact
/// worth saying plainly: a repository with nothing to download is not "up to date", and it is not a
/// failed check either.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub latest_version: Option<String>,
    pub current_version: String,
    pub has_update: bool,
    /// The release's own page, for the download. Empty when there is no release.
    pub release_url: String,
}

/// Compares versions field by field, numerically, ignoring a leading `v`.
///
/// `None` when either side has a field that is not a number: a prerelease suffix or a hand-written
/// tag makes the order undecidable, and reporting a false update is worse than missing a real one.
/// A shorter version is zero-padded, so `1.0` and `1.0.0` are the same version.
fn compare(current: &str, latest: &str) -> Option<std::cmp::Ordering> {
    fn fields(value: &str) -> Option<Vec<u64>> {
        value
            .trim()
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.trim().parse::<u64>().ok())
            .collect()
    }
    let (current, latest) = (fields(current)?, fields(latest)?);
    let width = current.len().max(latest.len());
    for index in 0..width {
        let left = current.get(index).copied().unwrap_or(0);
        let right = latest.get(index).copied().unwrap_or(0);
        match left.cmp(&right) {
            std::cmp::Ordering::Equal => {}
            other => return Some(other),
        }
    }
    Some(std::cmp::Ordering::Equal)
}

/// Whether `latest` is a version after `current`. Unparsable versions are never "newer".
fn is_newer(current: &str, latest: &str) -> bool {
    compare(current, latest) == Some(std::cmp::Ordering::Less)
}

/// The two fields this build reads out of a release document.
#[derive(Debug, Clone, PartialEq)]
struct Release {
    /// Already stripped of its `v`.
    version: String,
    url: String,
}

/// Reads `tag_name` and `html_url` out of GitHub's release JSON.
///
/// Only the `tag_name` is required: a document without `html_url` is a release with no page to send
/// anyone to, which still answers "there is a newer version" - the caller decides what to do with an
/// empty URL rather than this refusing the whole read.
fn parse_release(body: &str) -> Option<Release> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let tag = value.get("tag_name")?.as_str()?.trim();
    if tag.is_empty() {
        return None;
    }
    let url = value
        .get("html_url")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    Some(Release {
        version: tag.trim_start_matches('v').to_string(),
        url,
    })
}

/// What went wrong, in the two kinds the caller has to tell apart.
#[derive(Debug, Clone, PartialEq)]
enum Unread {
    /// The request never reached the host: no network, a proxy that answers nothing, a refused
    /// connection. Trying again later is the right advice.
    Transport(String),
    /// The host answered, and the answer was not a release document this build can read.
    Answered(String),
    /// The host answered, and the answer was "there is no such release". A repository with nothing
    /// published is not a failure: it is a fact the page can state, and calling it one sends people
    /// looking for a broken connection that is not broken.
    NoRelease,
}

impl Unread {
    fn message(self) -> String {
        match self {
            Unread::Transport(message) | Unread::Answered(message) => message,
            Unread::NoRelease => String::new(),
        }
    }
}

/// Two clients, so a proxy that cannot carry the request does not become "GitHub is unreachable".
///
/// The same arrangement as `agent_versions.rs`: the system's proxy is honoured because that is what
/// a machine behind one needs, and a read that could not be *sent* is retried once without it. A
/// host that answered badly is not retried - it would answer badly again.
struct Http {
    proxied: reqwest::Client,
    direct: reqwest::Client,
}

impl Http {
    fn build() -> Result<Http, String> {
        // reqwest here has no bundled TLS provider, so a client built without one fails, and the
        // failure would read as "GitHub said nothing".
        crate::modules::tls::ensure_crypto_provider();
        let client = |skip_proxy: bool| {
            let mut builder = reqwest::Client::builder()
                // GitHub answers 403 to a request with no user agent ("forbidden by administrative
                // rules"), which is how a bare read of its API fails.
                .user_agent(concat!("Verta/", env!("CARGO_PKG_VERSION")))
                .redirect(reqwest::redirect::Policy::limited(5))
                .timeout(Duration::from_secs(READ_TIMEOUT_SECS))
                .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS));
            if skip_proxy {
                builder = builder.no_proxy();
            }
            builder
                .build()
                .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
        };
        Ok(Http {
            proxied: client(false)?,
            direct: client(true)?,
        })
    }

    /// One GET, read to a capped body.
    async fn get(&self, url: &str) -> Result<String, Unread> {
        match self.get_with(&self.proxied, url).await {
            Ok(body) => Ok(body),
            // A host that answered is not retried: it would answer the same way again. "No such
            // release" is one of those answers.
            Err(Unread::Answered(message)) => Err(Unread::Answered(message)),
            Err(Unread::NoRelease) => Err(Unread::NoRelease),
            Err(Unread::Transport(proxied)) => match self.get_with(&self.direct, url).await {
                Ok(body) => Ok(body),
                // The proxy's failure is the one reported: it is the path this machine is
                // configured to take, so it is the one a person can do something about.
                Err(_) => Err(Unread::Transport(proxied)),
            },
        }
    }

    async fn get_with(&self, client: &reqwest::Client, url: &str) -> Result<String, Unread> {
        let response = client
            .get(url)
            .header("accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|error| Unread::Transport(format!("请求 GitHub 失败：{error}")))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            // A 403 or a 429 on this API is almost always the anonymous read quota, and the message
            // has to say so: "HTTP 403" alone sends people looking for a repository permission that
            // is not the problem. The logged-in `gh` read does not spend that quota.
            let message = match status {
                403 | 429 => format!(
                    "GitHub 拒绝读取（HTTP {status}）：多为匿名读取的配额用完，未登录时每小时 60 次；稍后再试，或在「GitHub」页登录 gh 后用它的配额"
                ),
                404 => return Err(Unread::NoRelease),
                _ => format!("查询最新版本失败：HTTP {status}"),
            };
            return Err(Unread::Answered(message));
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_BYTES as u64)
        {
            return Err(Unread::Answered("最新版本的响应过大".to_string()));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| Unread::Transport(format!("读取最新版本的响应失败：{error}")))?;
        if body.len() > MAX_BYTES {
            return Err(Unread::Answered("最新版本的响应过大".to_string()));
        }
        String::from_utf8(body.to_vec())
            .map_err(|_| Unread::Answered("最新版本的响应不是文本".to_string()))
    }
}

/// The logged-in `gh`'s answer, or `None` when there is no gh, nobody is logged in, or it refused.
///
/// `None` is not an error here: the caller reads the plain API next, and the only thing worth
/// reporting is that both failed.
async fn gh_release() -> Option<Release> {
    let path = format!("repos/{REPO}/releases/latest");
    let text = crate::modules::fs::blocking(move || {
        let args = ["api", path.as_str(), "-H", "Accept: application/vnd.github+json"];
        match crate::modules::github::gh::run(&args, READ_TIMEOUT_SECS) {
            Ok(output) if output.is_ok() => Ok(output.stdout),
            Ok(_) | Err(_) => Err(String::new()),
        }
    })
    .await
    .ok()?;
    (!text.trim().is_empty()).then(|| parse_release(&text)).flatten()
}

/// The latest published release, by whichever route answers. `None` when the repository has none.
async fn latest_release() -> Result<Option<Release>, String> {
    if let Some(release) = gh_release().await {
        return Ok(Some(release));
    }
    let http = Http::build()?;
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let body = match http.get(&url).await {
        Ok(body) => body,
        Err(Unread::NoRelease) => return Ok(None),
        Err(other) => return Err(other.message()),
    };
    parse_release(&body)
        .map(Some)
        .ok_or_else(|| "最新版本的响应里没有版本号".to_string())
}

/// Asks what the newest published release is and whether it is newer than this build.
///
/// `async` is not decoration: the body is network I/O, and a synchronous tauri command runs on the
/// webview's IPC thread, so an unreachable GitHub would freeze the window for the whole timeout.
///
/// A repository with no published release is `Ok` with `latest_version: None`: nothing failed, and
/// the page says so in those words rather than above a "check failed" button.
#[tauri::command]
pub async fn app_update_check(app: tauri::AppHandle) -> Result<UpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let Some(release) = latest_release().await? else {
        return Ok(UpdateCheck {
            latest_version: None,
            current_version,
            has_update: false,
            release_url: String::new(),
        });
    };
    let has_update = is_newer(&current_version, &release.version);
    Ok(UpdateCheck {
        latest_version: Some(release.version),
        current_version,
        has_update,
        release_url: release.url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_compared_field_by_field_as_numbers() {
        assert!(is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("1.0.9", "1.0.10"), "10 comes after 9, not before it");
        assert!(is_newer("1.9.0", "1.10.0"));
        assert!(is_newer("1.0.0", "2.0.0"));
        assert!(!is_newer("1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
    }

    #[test]
    fn a_leading_v_and_a_short_version_are_the_same_version() {
        assert!(is_newer("1.0.0", "v1.0.1"));
        assert!(!is_newer("1.0.0", "v1.0.0"));
        assert!(!is_newer("1.0", "1.0.0"), "1.0 and 1.0.0 are one version");
        assert!(is_newer("1.0", "1.0.1"));
    }

    #[test]
    fn a_version_that_cannot_be_ordered_is_never_an_update() {
        // A prerelease tag is not a number, and reporting a false update is worse than missing one.
        assert!(!is_newer("1.0.0", "1.1.0-beta.1"));
        assert!(!is_newer("nightly", "1.0.0"));
        assert!(!is_newer("1.0.0", ""));
    }

    #[test]
    fn a_release_document_yields_its_tag_and_page() {
        let body = r#"{"tag_name":"v1.0.1","html_url":"https://github.com/Zomcxj/Verta/releases/tag/v1.0.1","body":"notes"}"#;
        assert_eq!(
            parse_release(body),
            Some(Release {
                version: "1.0.1".to_string(),
                url: "https://github.com/Zomcxj/Verta/releases/tag/v1.0.1".to_string(),
            })
        );
    }

    #[test]
    fn a_release_without_a_page_still_reports_its_version() {
        let body = r#"{"tag_name":"v2.0.0"}"#;
        assert_eq!(
            parse_release(body),
            Some(Release {
                version: "2.0.0".to_string(),
                url: String::new(),
            })
        );
    }

    #[test]
    fn a_document_that_is_not_a_release_is_not_one() {
        assert_eq!(parse_release("not json"), None);
        assert_eq!(parse_release("{}"), None, "no tag_name, no release");
        assert_eq!(parse_release(r#"{"tag_name":""}"#), None);
        // A tag that is not a string cannot be compared to a version.
        assert_eq!(parse_release(r#"{"tag_name":1}"#), None);
    }

    #[test]
    fn a_release_older_than_the_running_build_is_not_an_update() {
        // A local build ahead of the last tag: the release is there, and it is not news.
        let release = parse_release(r#"{"tag_name":"v1.0.0"}"#).expect("parses");
        assert!(!is_newer("1.0.1", &release.version));
    }
}

#[cfg(test)]
mod live_probe {
    //! A read of the real API, kept out of the normal run: it needs a network and it spends one of
    //! GitHub's anonymous reads. Run it with `cargo test --lib live_probe -- --ignored --nocapture`
    //! when the question is "does this machine reach GitHub at all", which is the first thing to
    //! ask when a person reports that the check does not work.
    use super::*;

    #[test]
    #[ignore = "reads the real GitHub API; run with --ignored"]
    fn this_machine_can_read_a_release() {
        // A repository that does have a published release, so the read and the parse are both
        // exercised. The Verta repository itself has none yet, and its answer is asserted below.
        let http = Http::build().expect("an HTTP client");
        let body = tauri::async_runtime::block_on(
            http.get("https://api.github.com/repos/Zomcxj/MemoPaws/releases/latest"),
        )
        .expect("a published release must be readable");
        let release = parse_release(&body).expect("a published release must parse");
        println!("read {} at {}", release.version, release.url);
        assert!(!release.version.is_empty());
        assert!(release.url.starts_with("https://github.com/"));

        // Whatever the answer is for Verta's own repository, it must be a release or a sentence -
        // never a panic, and never an empty success.
        match tauri::async_runtime::block_on(latest_release()) {
            Ok(Some(release)) => println!("Verta: {}", release.version),
            Ok(None) => println!("Verta: no release published"),
            Err(message) => {
                println!("Verta: {message}");
                assert!(!message.trim().is_empty());
            }
        }
    }
}
