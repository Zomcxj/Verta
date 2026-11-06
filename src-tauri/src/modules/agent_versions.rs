//! Which agent tools this machine has, what versions they are on, and whether a newer one exists.
//!
//! Asked by the header bell: it lists what can be upgraded, and each row is upgraded by running the
//! tool's own update command. The check is read-only - nothing here installs anything - and every
//! component answers on its own, so one tool being absent or a registry being unreachable leaves the
//! other rows intact.
//!
//! Where each answer comes from, measured on this machine (2026-11-01):
//!
//! - opencode is an npm global (`npm i -g @opencode/cli`), so its published version is
//!   `npm view @opencode/cli version`;
//! - pi installs itself into `~/.pi/agent/install` and records the version it is running in
//!   `install/current-version`; its npm package is `@earendil-works/pi-coding-agent` (that name is in
//!   its own launcher, which is how the registry is asked);
//! - pi's extensions are npm packages in `~/.pi/agent/settings.json` (`packages` as `npm:<name>`),
//!   installed under `~/.pi/agent/npm/node_modules`, so each one's installed version is in its
//!   `package.json` and its published version is one registry read;
//! - the same file's `git:<host>/<owner>/<repo>` entries are checkouts under `~/.pi/agent/git`, and a
//!   checkout has no version to order: the commit it is on is read out of its own `.git`, and the row
//!   is behind when it differs from the commit the remote is on now. A GitHub source is asked through
//!   the host's API and any other host through `git ls-remote HEAD`, because `git ls-remote` against
//!   `github.com` took 21 s on this machine where the API answered in 1.7 s (measured 2026-11-04);
//! - opencode's plugins are the dependencies of `~/.config/opencode/package.json`, installed under
//!   that directory's `node_modules`, each compared against the registry or - for a `github:`
//!   spec that npm never sees - against the version in that repository's own `package.json`.
//!
//! Every read goes out through the system's proxy and is retried without it when it could not be
//! sent, because a proxy that is configured and no longer answering takes the whole check with it
//! (also measured on this machine, an hour after the numbers above: every row failed through the
//! proxy while every URL answered directly).
//!
//! The registry reads are the slow part and are done in parallel, because `npm view` takes about a
//! second each and there can be eight of them; the git packages run beside them.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use serde::Serialize;

use crate::modules::proc::capture::{self, Limits};

/// How long one upgrade may run.
///
/// The reads above answer in seconds; a write that fetches tarballs and rewrites a dependency tree
/// does not. An npm install naming two plugins took 37s on a warm cache and over a minute on a cold
/// one, and killing it at 100s reported "超时" for installs that were still working - which is what
/// "老是升级失败" looked like from the outside. The limit is only here to stop a hung process, and it
/// is the user's own click with the row saying it is working.
const UPGRADE_TIMEOUT_SECS: u64 = 300;
const VERSION_TIMEOUT_SECS: u64 = 15;
/// `git ls-remote` is a network round trip with git's own startup in front of it.
const GIT_TIMEOUT_SECS: u64 = 20;
/// Registry reads are one small GET each; a slow one must not hold the popover open.
const REGISTRY_TIMEOUT_SECS: u64 = 10;
const MAX_OUTPUT: usize = 64 * 1024;
/// A `latest` document is a few kilobytes; `pi-lens` is the largest at 94 KB.
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
/// A proxy that accepts a connection and then says nothing is caught here rather than at the read's
/// own timeout, so the read without it is tried while the user is still looking.
const CONNECT_TIMEOUT_SECS: u64 = 4;

/// Runs one tool and hands back what it printed.
///
/// Every tool here is an npm shim on Windows - `npm`, `opencode` and `pi` are all `.cmd` files
/// beside a real `.exe` - and `CreateProcess` refuses to run a `.cmd`, which is why a bare
/// `Command::new("npm")` failed with "program not found" even though the command is on the path.
/// Going through `cmd /C` lets the shell resolve the shim; the program and its arguments are this
/// module's own constants, never the caller's text, so there is nothing for the shell to reparse.
///
/// `envs` is set on every run, and is how `git` is told not to stop for a credential prompt: a
/// click in the bell has no terminal to answer one in.
///
/// `capture::run` also expects the pipes to be in place already and fails at spawn time with a
/// message nobody can act on, so they are set here rather than at each call site.
fn run_tool(
    program: &str,
    args: &[&str],
    timeout: Duration,
    stop_on_cap: bool,
    envs: &[(&str, &str)],
) -> Result<capture::Captured, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program);
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(program);
    cmd.args(args);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    capture::run(
        &mut cmd,
        timeout,
        Limits {
            stdout: MAX_OUTPUT,
            stderr: MAX_OUTPUT,
            stop_on_stdout_cap: stop_on_cap,
        },
    )
    .map_err(|error| format!("运行 {program} 失败：{error}"))
}

/// The npm package that publishes opencode.
const OPENCODE_PACKAGE: &str = "@opencode/cli";
/// The npm package pi installs itself from; the name is taken from pi's own launcher.
const PI_PACKAGE: &str = "@earendil-works/pi-coding-agent";
/// The plugin API opencode itself provides. It is a dependency of the config directory, but it is
/// what plugins are loaded *through* rather than one the user chose, so it gets no row.
const OPENCODE_PLUGIN_SDK: &str = "@opencode-ai/plugin";

/// How a row's two values are compared.
///
/// A released version orders itself against another one. A git checkout has no version to order -
/// only a commit, which either matches the remote's or does not - so the row is behind on any
/// difference and the two values are shown side by side rather than ranked.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentCompare {
    Version,
    Revision,
}

/// Which agent tool a row belongs to.
///
/// The bell draws each row with its tool's own icon, so one package installed by both tools twice
/// over reads as two rows that are plainly not the same thing - which is why the tool is not spelled
/// out in the row's name.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Opencode,
    Pi,
}

/// One thing that may be upgraded.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentComponent {
    /// Stable id for the row: `opencode`, `pi`, `pi-extension:<package>`, `pi-git:<source>`, or
    /// `opencode-plugin:<package>`.
    pub id: String,
    /// What the row is called: the tool itself, or the library's own name.
    pub name: String,
    /// Which tool the row belongs to, for the row's icon.
    pub agent: AgentKind,
    /// The version on this machine - or the commit it is on - or `None` when it could not be read.
    pub current: Option<String>,
    /// The newest published version - or the commit the remote is on - or `None` when the source
    /// could not be asked.
    pub latest: Option<String>,
    /// Why the answer is incomplete, when it is. `None` when both sides were read.
    pub error: Option<String>,
    /// Whether `current` and `latest` are versions or commits, for the caller's comparison.
    pub compare: AgentCompare,
    /// The command that upgrades this one, for the row's button.
    pub upgrade: AgentUpgrade,
}

/// How to upgrade one component, as the arguments of the tool's own updater.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpgrade {
    /// The program to run.
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentVersions {
    pub components: Vec<AgentComponent>,
}

/// opencode's own updater.
fn opencode_upgrade() -> AgentUpgrade {
    AgentUpgrade {
        program: "opencode".into(),
        args: vec!["upgrade".into()],
    }
}

/// `--self` is pi's own switch for "pi only"; `--no-approve` keeps it from stopping to ask about
/// project-local files, which a click in the bell cannot answer.
fn pi_self_upgrade() -> AgentUpgrade {
    AgentUpgrade {
        program: "pi".into(),
        args: vec!["update".into(), "--self".into(), "--no-approve".into()],
    }
}

/// Every extension pi has installed, npm and git alike.
fn pi_extensions_upgrade() -> AgentUpgrade {
    AgentUpgrade {
        program: "pi".into(),
        args: vec![
            "update".into(),
            "--extensions".into(),
            "--no-approve".into(),
        ],
    }
}

/// One pi package, by the source its settings file holds (`pi update <source>`).
fn pi_package_upgrade(source: &str) -> AgentUpgrade {
    AgentUpgrade {
        program: "pi".into(),
        args: vec!["update".into(), source.to_string(), "--no-approve".into()],
    }
}

/// The specs one `npm install` names, given what is installed and which plugins were asked for.
///
/// The plugins being updated are asked for their newest; **every other one is pinned to the version it
/// is already on**. Naming them all `@latest` is what produced "回退一个小版本然后重试": one `npm install`
/// re-resolved every plugin, so a click about one row could put a *different* one back at whatever the
/// registry publishes now - measured on this machine, a plugin installed from a git branch (7.0.1,
/// newer than the registry's 6.3.0) came back at 6.3.0. Pinning leaves each other row where it is, and
/// a plugin whose installed version cannot be read keeps its configured spec, which is what every
/// plugin used to get.
///
/// `targets` is a set rather than one name because a batch clickable covers several rows at once: one
/// `npm install` is what makes them one unit of work instead of one per row.
fn opencode_install_specs(
    plugins: &[OpencodePlugin],
    installed: &std::collections::HashMap<String, String>,
    targets: Option<&std::collections::HashSet<String>>,
) -> Vec<String> {
    plugins
        .iter()
        .map(|plugin| {
            // No targets at all means the whole project is being brought up to date.
            let asked_for = targets.is_none_or(|set| set.contains(&plugin.name));
            match plugin_upstream(&plugin.spec) {
                PluginUpstream::Registry => match installed.get(&plugin.name) {
                    _ if asked_for => format!("{}@latest", plugin.name),
                    Some(version) => format!("{}@{}", plugin.name, version),
                    None => format!("{}@latest", plugin.name),
                },
                // A git plugin is installed from its own spec, which is how npm re-resolves the
                // branch to wherever it is now; its installed version is not on the registry to pin
                // to, and npm would fail the whole install over it.
                PluginUpstream::Github(_) => format!("{}@{}", plugin.name, plugin.spec),
            }
        })
        .collect()
}

/// opencode's plugins are the npm dependencies of its config directory, so updating them is one
/// `npm install` there, naming each one at its newest.
///
/// opencode's own `plugin update` cannot: for a plugin configured as a path it has nothing to
/// compare against (it answers "current" whatever the remote says) and does nothing on an update,
/// and `plugin add` would write a second, spec-form entry beside the path form. Naming *every*
/// plugin in one install is also what keeps them from clobbering each other - installing one at a
/// time let npm put another one back at the commit its lock file still named (measured 2026-11-04:
/// ponytail at latest left superpowers at 6.3.0 while the checkout was 7.0.1).
fn opencode_plugins_upgrade(
    plugins: &[OpencodePlugin],
    targets: Option<&std::collections::HashSet<String>>,
) -> AgentUpgrade {
    let dir = opencode_config_dir().unwrap_or_default();
    let installed: std::collections::HashMap<String, String> = plugins
        .iter()
        .filter_map(|plugin| {
            opencode_plugin_version(&plugin.name)
                .ok()
                .map(|version| (plugin.name.clone(), version))
        })
        .collect();
    let mut args = vec![
        "install".to_string(),
        "--prefix".to_string(),
        dir.display().to_string(),
    ];
    args.extend(opencode_install_specs(plugins, &installed, targets));
    AgentUpgrade {
        program: "npm".into(),
        args,
    }
}

/// Why a row's answer is incomplete, when it is.
///
/// The installed side is named first: a machine where the tool itself is missing is the more
/// useful thing to say, whatever the source then answered.
fn answer_error(current: &Result<String, String>, latest: &Result<String, String>) -> Option<String> {
    match (current, latest) {
        (Err(current_error), _) => Some(current_error.clone()),
        (_, Err(latest_error)) => Some(latest_error.clone()),
        _ => None,
    }
}

/// A commit as a row shows it: the seven characters git's own short form uses.
fn short_sha(sha: &str) -> String {
    sha.trim().chars().take(7).collect()
}

/// The registry to ask, taken from npm's own configuration.
///
/// `npm view` honours `registry=` in `.npmrc`, and on this machine that is a mirror
/// (`registry.npmmirror.com`), which answered in 187 ms where spawning `npm view` took 2.7 s a
/// package. Reading the same setting here keeps the answer consistent with what `npm install`
/// would actually do, rather than assuming the public registry.
fn registry_base() -> String {
    const DEFAULT: &str = "https://registry.npmjs.org";
    let Some(home) = dirs::home_dir() else {
        return DEFAULT.to_string();
    };
    let Ok(text) = std::fs::read_to_string(home.join(".npmrc")) else {
        return DEFAULT.to_string();
    };
    let base = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (key, value) = line.split_once('=')?;
            (key.trim() == "registry").then(|| value.trim().to_string())
        })
        .next_back()
        .unwrap_or_else(|| DEFAULT.to_string());
    // A trailing slash would make the joined URL contain `//`, which some mirrors 404.
    base.trim_end_matches('/').to_string()
}

/// One read that did not happen, and whether it is worth trying again without the proxy.
enum Unread {
    /// The request never reached the host, which is what a proxy that is listening but not answering
    /// looks like from here.
    Transport(String),
    /// The host answered, and the answer could not be used.
    Answered(String),
}

impl Unread {
    fn message(self) -> String {
        match self {
            Unread::Transport(message) | Unread::Answered(message) => message,
        }
    }
}

/// The way out of this process, and the registry to ask with it.
///
/// The system's proxy is honoured (`system-proxy` on Windows) because that is what a machine behind
/// one needs. It is not the only way tried: measured on this machine (2026-11-04), a tunnelling
/// client's proxy was configured and answered nothing at all, and every read of every row failed
/// while the same URLs answered directly in about a second. So a read that could not be *sent* is
/// retried once without the proxy, and a check that can go direct still goes.
struct Http {
    proxied: reqwest::Client,
    direct: reqwest::Client,
    /// The registry from npm's own configuration.
    base: String,
}

impl Http {
    fn build() -> Result<Http, String> {
        // reqwest here has no bundled TLS provider, so a client built without one fails and the
        // failure would read as "the registry said nothing".
        crate::modules::tls::ensure_crypto_provider();
        let client = |skip_proxy: bool| {
            let mut builder = reqwest::Client::builder()
                // GitHub's API answers 403 to a request with no user agent ("forbidden by
                // administrative rules"), which is how both of its reads failed before this.
                .user_agent(concat!("Verta/", env!("CARGO_PKG_VERSION")))
                // A registry read carries no credentials, so a redirect is harmless.
                .redirect(reqwest::redirect::Policy::limited(5))
                .timeout(Duration::from_secs(REGISTRY_TIMEOUT_SECS))
                // A proxy that accepts and then says nothing must not hold every row for the whole
                // timeout before the direct read is tried.
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
            base: registry_base(),
        })
    }

    /// One small JSON document, with the size caps every read here has.
    async fn get(&self, url: &str, label: &str, accept: &str) -> Result<serde_json::Value, Unread> {
        match fetch_json(&self.proxied, url, label, accept).await {
            Ok(json) => Ok(json),
            // Only a read that was never sent is worth a second try: the host answering badly would
            // answer badly again, and the retry would only be another request.
            Err(Unread::Answered(message)) => Err(Unread::Answered(message)),
            Err(Unread::Transport(proxied)) => match fetch_json(&self.direct, url, label, accept).await
            {
                Ok(json) => Ok(json),
                // The proxy's failure is the one reported: it is the path this machine is configured
                // for, and its message says more about what is wrong than the fallback's would.
                Err(_) => Err(Unread::Transport(proxied)),
            },
        }
    }

    /// The newest published version of one package.
    async fn published_version(&self, package: &str) -> Result<String, String> {
        // Scoped packages keep their `@` and their slash in the path; the registry accepts the
        // unescaped form, which is what `npm view` sends.
        let url = format!("{}/{package}/latest", self.base);
        let json = self.get(&url, package, "application/json").await.map_err(Unread::message)?;
        json.get("version")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("{package} 的响应没有 version"))
    }

    /// The version a repository publishes on its default branch, from its own `package.json`.
    ///
    /// The path taken by a `github:` plugin, which npm never sees: there is no registry document for
    /// it, only the repository, and its `package.json` is where the version it is on is written.
    async fn published_repo_version(&self, repo: &str) -> Result<String, String> {
        let path = format!("repos/{repo}/contents/package.json?ref=HEAD");
        if let Some(text) = gh_api_raw(&path).await {
            let json: serde_json::Value = serde_json::from_str(&text)
                .map_err(|error| format!("解析 {repo} 的 package.json 失败：{error}"))?;
            return json
                .get("version")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .ok_or_else(|| format!("{repo} 的 package.json 没有 version"));
        }
        // The contents endpoint with the raw media type hands back the file itself; the plain form
        // would be base64 inside JSON, which is another decode for nothing.
        let url = format!("https://api.github.com/repos/{repo}/contents/package.json?ref=HEAD");
        let json = self
            .get(&url, repo, "application/vnd.github.raw")
            .await
            .map_err(Unread::message)?;
        json.get("version")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("{repo} 的 package.json 没有 version"))
    }
}

/// One GitHub read through the logged-in `gh`, when there is one.
///
/// The anonymous API is what these reads fall back to, and it is limited to sixty reads an hour per
/// address: a few bell opens spend it, and the next one answers "HTTP 403 Forbidden" on a plugin row
/// (reported as "浮窗查询失败 HTTP 403 Forbidden 更新失败"). `gh` reads with the account's own quota, is
/// already what the GitHub panel uses, and needs no token handling here. `None` means "no gh, or not
/// logged in, or it failed" - the caller then reads the API as before.
async fn gh_api_raw(path: &str) -> Option<String> {
    let path = path.to_string();
    let text = crate::modules::fs::blocking(move || {
        let args = [
            "api",
            path.as_str(),
            "-H",
            "Accept: application/vnd.github.raw",
        ];
        match crate::modules::github::gh::run(&args, GIT_TIMEOUT_SECS) {
            Ok(output) if output.is_ok() => Ok(output.stdout),
            // Nothing installed, nothing logged in, or it refused: the caller reads the API instead,
            // so there is no message to carry out of here.
            Ok(_) | Err(_) => Err(String::new()),
        }
    })
    .await
    .ok()?;
    (!text.trim().is_empty()).then_some(text)
}

/// What to say when a host refused a read.
///
/// A bare "HTTP 403 Forbidden" is what the bell showed for a rate-limited GitHub read ("浮窗查询失败
/// HTTP 403 Forbidden"), and it does not say which of several things happened. On these two APIs a 403
/// or a 429 is almost always the anonymous read quota, so the message names that, and what turns it
/// off - the same read through the logged-in `gh` does not spend it.
fn http_failure(label: &str, status: u16) -> String {
    match status {
        403 | 429 => format!(
            "查询 {label} 失败：HTTP {status}（多为匿名读取的配额用完：未登录时 GitHub 每小时 60 次，稍后再试，或登录 gh 后用其配额）"
        ),
        _ => format!("查询 {label} 失败：HTTP {status}"),
    }
}

/// One GET, read and parsed, with the size caps every read here has.
async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    label: &str,
    accept: &str,
) -> Result<serde_json::Value, Unread> {
    let response = client
        .get(url)
        .header("accept", accept)
        .send()
        .await
        .map_err(|error| Unread::Transport(format!("查询 {label} 失败：{error}")))?;
    if !response.status().is_success() {
        return Err(Unread::Answered(http_failure(
            label,
            response.status().as_u16(),
        )));
    }
    if response
        .content_length()
        .is_some_and(|len| len > MAX_REGISTRY_BYTES as u64)
    {
        return Err(Unread::Answered(format!("查询 {label} 的响应过大")));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| Unread::Transport(format!("读取 {label} 的响应失败：{error}")))?;
    if body.len() > MAX_REGISTRY_BYTES {
        return Err(Unread::Answered(format!("查询 {label} 的响应过大")));
    }
    serde_json::from_slice(&body)
        .map_err(|error| Unread::Answered(format!("解析 {label} 的响应失败：{error}")))
}

/// The `owner/repo` a package source names, when it names a GitHub repository.
fn github_repo(source: &str) -> Option<String> {
    let rest = source.strip_prefix("github.com/")?;
    let repo = rest.trim_end_matches(".git").trim_end_matches('/');
    // A repository is two segments; anything shorter is not one to ask.
    (repo.split('/').count() >= 2).then(|| repo.to_string())
}

/// The commit a repository's default branch is on, asked of GitHub's own API.
///
/// The host that answers an HTTP request in about a second, where `git ls-remote` against it took
/// 21 s on this machine (measured 2026-11-04) - long enough that the bell would have given up on it.
/// The logged-in `gh` is asked first for the same reason the plugin read asks it: the anonymous
/// quota is sixty reads an hour, and a check spends one per git-sourced row.
async fn github_head_sha(http: &Http, repo: &str) -> Result<String, String> {
    let path = format!("repos/{repo}/commits/HEAD");
    if let Some(text) = gh_api_raw(&path).await {
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|error| format!("解析 {repo} 的提交响应失败：{error}"))?;
        return json
            .get("sha")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("{repo} 的提交响应没有 sha"));
    }
    let url = format!("https://api.github.com/repos/{repo}/commits/HEAD");
    let json = http
        .get(&url, repo, "application/json")
        .await
        .map_err(Unread::message)?;
    json.get("sha")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("{repo} 的提交响应没有 sha"))
}

/// Removes the colour escapes a tool adds even when it is not talking to a terminal.
///
/// `opencode --version` answers `ESC[2mvESC[0mESC[1m2.2.5ESC[0m` (measured on this machine), and
/// without this the row's current version would be shown as escape codes.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // A control sequence is ESC "[" then parameters, ended by a byte in the 0x40..=0x7e range.
        // An ESC that starts nothing this knows is dropped on its own, and the character after it is
        // kept: the escape is what has to go, not the text it was meant to colour.
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

/// The version `opencode --version` reports, which prints `opencode v2.2.5`.
fn opencode_installed() -> Result<String, String> {
    let captured = run_tool(
        "opencode",
        &["--version"],
        Duration::from_secs(VERSION_TIMEOUT_SECS),
        true,
        &[],
    )?;
    if captured.timed_out {
        return Err("读取 opencode 版本超时".into());
    }
    if captured.exit_code != Some(0) {
        // A tool that answers with a non-zero code may still have printed its version, so the
        // stdout is tried before the failure is reported.
        let stderr = String::from_utf8_lossy(&captured.stderr);
        let first = stderr.lines().next().unwrap_or("").trim();
        return Err(if first.is_empty() {
            "opencode --version 没有成功退出".into()
        } else {
            format!("opencode --version 失败：{first}")
        });
    }
    // A tool that colours its output colours it even through a pipe: `opencode --version` answers
    // `ESC[2mvESC[0mESC[1m2.2.5ESC[0m` here, so the escapes come out before anything is parsed.
    let stdout = String::from_utf8_lossy(&captured.stdout);
    let stdout = strip_ansi(&stdout);
    let text = stdout.trim();
    if text.is_empty() {
        return Err("opencode 没有报告版本".into());
    }
    // `opencode v2.2.5`, or just `2.2.5`.
    let version = text
        .rsplit_once(' ')
        .map(|(_, last)| last)
        .unwrap_or(text)
        .trim_start_matches('v');
    if version.is_empty() {
        return Err("opencode 报告的版本无法解析".into());
    }
    Ok(version.to_string())
}

/// Where pi keeps its managed install, and the version it is running.
fn pi_install_root() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".pi/agent/install"))
}

fn pi_installed() -> Result<String, String> {
    let root = pi_install_root().ok_or("找不到用户主目录，无法定位 pi")?;
    let file = root.join("current-version");
    let text = std::fs::read_to_string(&file)
        .map_err(|error| format!("读取 {} 失败：{error}", file.display()))?;
    let version = text.trim();
    if version.is_empty() {
        return Err("pi 的版本文件是空的".into());
    }
    Ok(version.to_string())
}

/// One entry in pi's `packages` list that the bell can compare against an upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PiPackage {
    /// `npm:<name>`: released versions in the registry.
    Npm(String),
    /// `git:<host>/<owner>/<repo>`: a checkout, which moves by commit rather than by version.
    Git(String),
}

/// pi's `packages` entries.
///
/// The list holds three forms and only two of them have anything upstream to ask: a local path is
/// the user's own directory, so it contributes no row.
fn parse_pi_packages(json: &serde_json::Value) -> Vec<PiPackage> {
    let mut packages = Vec::new();
    let Some(list) = json.get("packages").and_then(|value| value.as_array()) else {
        return packages;
    };
    for entry in list {
        let Some(text) = entry.as_str() else { continue };
        if let Some(name) = text.strip_prefix("npm:") {
            if !name.is_empty() {
                packages.push(PiPackage::Npm(name.to_string()));
            }
        } else if let Some(source) = text.strip_prefix("git:") {
            if !source.is_empty() {
                packages.push(PiPackage::Git(source.to_string()));
            }
        }
    }
    packages
}

/// The same list, read from pi's own settings file.
fn pi_packages() -> Result<Vec<PiPackage>, String> {
    let home = dirs::home_dir().ok_or("找不到用户主目录，无法定位 pi")?;
    let file = home.join(".pi/agent/settings.json");
    let text = std::fs::read_to_string(&file)
        .map_err(|error| format!("读取 {} 失败：{error}", file.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("解析 pi 设置失败：{error}"))?;
    Ok(parse_pi_packages(&json))
}

/// What a row calls a git package: `github.com/obra/superpowers` reads as `obra/superpowers`.
fn git_source_label(source: &str) -> String {
    // The host is the first segment, and it says nothing the row's user does not already know.
    source
        .split_once('/')
        .map(|(_, rest)| rest)
        .unwrap_or(source)
        .trim_end_matches(".git")
        .trim_end_matches('/')
        .to_string()
}

/// A checkout's `HEAD` file, as far as the commit here has to be read from it.
#[derive(Debug, PartialEq, Eq)]
enum Head {
    /// The commit itself, which is what a detached checkout or a tag looks like.
    Commit(String),
    /// A branch this checkout follows, whose commit is in its ref.
    Branch(String),
}

/// Reads a `HEAD` file's text.
fn parse_head(text: &str) -> Option<Head> {
    let text = text.trim();
    match text.strip_prefix("ref:") {
        Some(reference) => {
            let name = reference.trim();
            (!name.is_empty()).then(|| Head::Branch(name.to_string()))
        }
        None => (!text.is_empty()).then(|| Head::Commit(text.to_string())),
    }
}

/// The commit a `packed-refs` file gives for one branch, for a checkout whose ref is not a loose
/// file - git packs them once a repository has a few, and `main` is packed in pi's own checkouts.
fn packed_ref(text: &str, reference: &str) -> Option<String> {
    text.lines()
        .filter_map(|line| line.split_once(' '))
        .find_map(|(sha, name)| (name.trim() == reference).then(|| sha.trim().to_string()))
}

/// The commit a checkout is on, read from its own `.git` rather than by running git.
fn checkout_sha(dir: &Path) -> Result<String, String> {
    // `.git` is a directory in a plain clone and a `gitdir:` file when the checkout is a worktree or
    // was made by a tool that keeps the metadata elsewhere; both spellings turn up here.
    let dot_git = dir.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = std::fs::read_to_string(&dot_git)
            .map_err(|error| format!("读取 {} 失败：{error}", dot_git.display()))?;
        let target = text
            .trim()
            .strip_prefix("gitdir:")
            .map(str::trim)
            .ok_or_else(|| format!("{} 不是 git 检出", dot_git.display()))?;
        let path = PathBuf::from(target);
        if path.is_absolute() {
            path
        } else {
            dir.join(path)
        }
    };
    let head_file = git_dir.join("HEAD");
    let head = std::fs::read_to_string(&head_file)
        .map_err(|error| format!("读取 {} 失败：{error}", head_file.display()))?;
    match parse_head(&head) {
        Some(Head::Commit(sha)) => Ok(sha),
        Some(Head::Branch(branch)) => {
            if let Ok(text) = std::fs::read_to_string(git_dir.join(&branch)) {
                let sha = text.trim().to_string();
                if !sha.is_empty() {
                    return Ok(sha);
                }
            }
            let packed = std::fs::read_to_string(git_dir.join("packed-refs")).unwrap_or_default();
            packed_ref(&packed, &branch).ok_or_else(|| format!("找不到 {branch} 指向的提交"))
        }
        None => Err("HEAD 里没有提交".into()),
    }
}

/// The URL a pi package source names, which is `github.com/owner/repo` with no scheme of its own.
fn package_url(source: &str) -> String {
    if source.contains("://") || source.contains('@') {
        source.to_string()
    } else {
        format!("https://{source}")
    }
}

/// The commit a package's own repository is on now.
///
/// `git ls-remote` rather than the host's API: the source names a host, and git is already the tool
/// that knows how to reach one - with the user's own credentials. `GIT_TERMINAL_PROMPT` is cleared
/// so a repository that wants a password fails instead of waiting for one nobody can type.
fn remote_sha(source: &str) -> Result<String, String> {
    let url = package_url(source);
    let captured = run_tool(
        "git",
        &["ls-remote", &url, "HEAD"],
        Duration::from_secs(GIT_TIMEOUT_SECS),
        true,
        &[("GIT_TERMINAL_PROMPT", "0")],
    )?;
    let stdout = String::from_utf8_lossy(&captured.stdout);
    // `<sha>\tHEAD` on a success, and nothing at all when the branch list came back empty.
    let sha = stdout
        .lines()
        .find_map(|line| line.split_whitespace().next())
        .unwrap_or("")
        .trim();
    if captured.timed_out {
        return Err("读取远端提交超时".into());
    }
    if captured.exit_code != Some(0) || sha.is_empty() {
        let stderr = String::from_utf8_lossy(&captured.stderr);
        let first = stderr.lines().next().unwrap_or("").trim();
        return Err(if first.is_empty() {
            format!("{source} 没有报告远端提交")
        } else {
            format!("查询 {source} 失败：{first}")
        });
    }
    Ok(sha.to_string())
}

/// Where opencode keeps its global configuration, its plugins and their `node_modules`.
fn opencode_config_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".config/opencode"))
}

/// The version of an installed package, read from its own `package.json`.
fn package_json_version(dir: &Path, label: &str) -> Result<String, String> {
    let file = dir.join("package.json");
    let text = std::fs::read_to_string(&file)
        .map_err(|error| format!("读取 {} 失败：{error}", file.display()))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("解析 {label} 的 package.json 失败：{error}"))?;
    json.get("version")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("{label} 的 package.json 没有 version"))
}

fn installed_extension_version(package: &str) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("找不到用户主目录，无法定位 pi")?;
    let dir = home.join(".pi/agent/npm/node_modules").join(package);
    package_json_version(&dir, package)
}

/// One plugin opencode loads for this user.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OpencodePlugin {
    name: String,
    /// The spec this machine installed it from (`^5.3.2`, `github:obra/superpowers`).
    spec: String,
}

/// Where the source a plugin was installed from publishes its versions.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PluginUpstream {
    /// An npm package, asked of the registry.
    Registry,
    /// A GitHub repository, whose own `package.json` carries the version it is on.
    Github(String),
}

/// Reads a plugin spec as its upstream.
///
/// Anything that is not a repository is an npm name - including a bare `5.3.2` or `^5.3.2`, which
/// is what npm leaves behind for a registry install.
fn plugin_upstream(spec: &str) -> PluginUpstream {
    const PREFIXES: [&str; 6] = [
        "github:",
        "git+https://github.com/",
        "git+ssh://git@github.com/",
        "git@github.com:",
        "https://github.com/",
        "git://github.com/",
    ];
    for prefix in PREFIXES {
        if let Some(rest) = spec.strip_prefix(prefix) {
            let repo = rest.trim_end_matches(".git").trim_end_matches('/');
            if !repo.is_empty() {
                return PluginUpstream::Github(repo.to_string());
            }
        }
    }
    PluginUpstream::Registry
}

/// opencode's plugins, as the dependencies its configuration installs.
fn parse_opencode_plugins(json: &serde_json::Value) -> Vec<OpencodePlugin> {
    let mut plugins = Vec::new();
    let Some(dependencies) = json.get("dependencies").and_then(|value| value.as_object()) else {
        return plugins;
    };
    for (name, spec) in dependencies {
        // The plugin API is what opencode loads plugins *through*; it is not one the user picked.
        if name == OPENCODE_PLUGIN_SDK {
            continue;
        }
        let Some(spec) = spec.as_str() else { continue };
        plugins.push(OpencodePlugin {
            name: name.clone(),
            spec: spec.to_string(),
        });
    }
    // `dependencies` is an unordered map, so the rows get an order that does not move between runs.
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    plugins
}

fn opencode_plugins() -> Result<Vec<OpencodePlugin>, String> {
    let dir = opencode_config_dir().ok_or("找不到用户主目录，无法定位 opencode")?;
    let file = dir.join("package.json");
    let text = std::fs::read_to_string(&file)
        .map_err(|error| format!("读取 {} 失败：{error}", file.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("解析 opencode 依赖失败：{error}"))?;
    Ok(parse_opencode_plugins(&json))
}

fn opencode_plugin_version(name: &str) -> Result<String, String> {
    let dir = opencode_config_dir().ok_or("找不到用户主目录，无法定位 opencode")?;
    package_json_version(&dir.join("node_modules").join(name), name)
}

/// Assembles one row: the installed side is read here, the remote's answer is passed in.
///
/// Splitting "read the remote" from "build the row" is what lets the branch where no HTTP client
/// could be built list the same rows - same ids, same names, same upgrades - with an error in place
/// of the remote's answer, instead of dropping them.
fn row(
    id: String,
    name: String,
    agent: AgentKind,
    compare: AgentCompare,
    upgrade: AgentUpgrade,
    current: Result<String, String>,
    latest: Result<String, String>,
) -> AgentComponent {
    AgentComponent {
        id,
        name,
        agent,
        current: current.as_ref().ok().cloned(),
        latest: latest.as_ref().ok().cloned(),
        error: answer_error(&current, &latest),
        compare,
        upgrade,
    }
}

fn opencode_row(latest: Result<String, String>) -> AgentComponent {
    row(
        "opencode".into(),
        "opencode".into(),
        AgentKind::Opencode,
        AgentCompare::Version,
        opencode_upgrade(),
        opencode_installed(),
        latest,
    )
}

fn pi_row(latest: Result<String, String>) -> AgentComponent {
    row(
        "pi".into(),
        "pi".into(),
        AgentKind::Pi,
        AgentCompare::Version,
        pi_self_upgrade(),
        pi_installed(),
        latest,
    )
}

/// One npm extension's row.
fn pi_extension_row(package: &str, latest: Result<String, String>) -> AgentComponent {
    row(
        format!("pi-extension:{package}"),
        package.to_string(),
        AgentKind::Pi,
        AgentCompare::Version,
        pi_extensions_upgrade(),
        installed_extension_version(package),
        latest,
    )
}

/// The commit a pi git package's checkout is on.
fn pi_git_checkout_sha(source: &str) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("找不到用户主目录，无法定位 pi")?;
    checkout_sha(&home.join(".pi/agent/git").join(source))
}

/// One pi git package's row: the commit here against the commit the remote is on now.
///
/// A checkout that was committed into by hand reads as behind rather than as "ahead", which is the
/// honest answer for what this can see - pi installs these from a branch and does not commit into
/// them, so a difference means the branch moved.
fn pi_git_row(source: &str, latest: Result<String, String>) -> AgentComponent {
    row(
        format!("pi-git:{source}"),
        git_source_label(source),
        AgentKind::Pi,
        AgentCompare::Revision,
        // `pi update` wants the source as the settings file spells it, `git:` prefix and all; without
        // the prefix it answers "No matching package found" and the checkout stays where it was.
        pi_package_upgrade(&format!("git:{source}")),
        pi_git_checkout_sha(source).map(|sha| short_sha(&sha)),
        latest.map(|sha| short_sha(&sha)),
    )
}

/// The commit a pi git package's remote is on now.
///
/// A GitHub source is asked through the host's API; any other host through `git ls-remote`, which is
/// the only thing that knows how to reach one. A failed API read does not fall back to git: on a
/// network where the API is blocked the fallback would only add another timeout to the check.
async fn pi_git_remote(http: &Http, source: &str) -> Result<String, String> {
    match github_repo(source) {
        Some(repo) => github_head_sha(http, &repo).await,
        None => {
            // A subprocess with a network round trip in it, so it runs off the async workers.
            let source = source.to_string();
            crate::modules::fs::blocking(move || remote_sha(&source)).await
        }
    }
}

/// One opencode plugin's row.
fn opencode_plugin_row(
    plugin: &OpencodePlugin,
    latest: Result<String, String>,
    upgrade: AgentUpgrade,
) -> AgentComponent {
    row(
        format!("opencode-plugin:{}", plugin.name),
        plugin.name.clone(),
        AgentKind::Opencode,
        AgentCompare::Version,
        upgrade,
        opencode_plugin_version(&plugin.name),
        latest,
    )
}

/// The newest version a plugin's own source publishes.
async fn opencode_plugin_remote(
    http: &Http,
    plugin: &OpencodePlugin,
) -> Result<String, String> {
    match plugin_upstream(&plugin.spec) {
        PluginUpstream::Registry => http.published_version(&plugin.name).await,
        PluginUpstream::Github(repo) => http.published_repo_version(&repo).await,
    }
}

/// Reads the installed and published version of every agent tool this module knows.
///
/// Every remote read is one small request, and they all run at once: `npm view` cost 2.7 s a package
/// because of npm's own startup, so nine of them took 14.8 s in a row and 9.4 s even in parallel,
/// while nine plain HTTP reads against the configured mirror answered in 187 ms.
pub async fn check() -> AgentVersions {
    let packages = pi_packages().unwrap_or_default();
    let plugins = opencode_plugins().unwrap_or_default();
    let plugin_upgrade = opencode_plugins_upgrade(&plugins, None);
    let http = match Http::build() {
        Ok(http) => http,
        // Without a client nothing can be asked, but the installed versions are still readable, so
        // the rows list with their `current` and an error rather than disappearing.
        Err(error) => {
            let failed = || Err(error.clone());
            let mut components = vec![opencode_row(failed()), pi_row(failed())];
            for package in &packages {
                match package {
                    PiPackage::Npm(name) => components.push(pi_extension_row(name, failed())),
                    PiPackage::Git(source) => components.push(pi_git_row(source, failed())),
                }
            }
            for plugin in &plugins {
                components.push(opencode_plugin_row(plugin, failed(), plugin_upgrade.clone()));
            }
            return AgentVersions { components };
        }
    };
    // The two lists the rows come from, split by what has to be asked where: an npm name is a
    // registry read, a git source is that repository's own answer.
    let npm = packages.iter().filter_map(|package| match package {
        PiPackage::Npm(name) => Some(name),
        PiPackage::Git(_) => None,
    });
    let git = packages.iter().filter_map(|package| match package {
        PiPackage::Git(source) => Some(source),
        PiPackage::Npm(_) => None,
    });
    let (opencode, pi, extensions, git_rows, plugin_rows) = tokio::join!(
        async { opencode_row(http.published_version(OPENCODE_PACKAGE).await) },
        async { pi_row(http.published_version(PI_PACKAGE).await) },
        futures_util::future::join_all(
            npm.map(|name| async { pi_extension_row(name, http.published_version(name).await) }),
        ),
        futures_util::future::join_all(
            git.map(|source| async { pi_git_row(source, pi_git_remote(&http, source).await) }),
        ),
        futures_util::future::join_all(plugins.iter().map(|plugin| async {
            opencode_plugin_row(
                plugin,
                opencode_plugin_remote(&http, plugin).await,
                plugin_upgrade.clone(),
            )
        })),
    );
    let mut components = vec![opencode, pi];
    components.extend(extensions);
    components.extend(git_rows);
    components.extend(plugin_rows);
    AgentVersions { components }
}

/// What one id's upgrade did, for a batch.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComponentUpgrade {
    pub id: String,
    pub ok: bool,
    pub message: String,
}

/// How a batch of ids splits: the plugins share one `npm install`, everything else runs alone.
///
/// Pure on purpose - the plugins are passed in rather than read here - so what a batch turns into can
/// be asserted without a machine's configuration behind it.
struct BatchPlan {
    plugins: Vec<String>,
    singles: Vec<String>,
}

/// Splits a batch click into the commands it will run.
///
/// Every plugin lives in the same npm project, so one install covers all of them; anything else is a
/// different tool's updater and runs on its own. An id whose plugin the configuration no longer lists
/// is dropped: it cannot reach an install command, and it must not hold up the rows that can.
fn plan_batch(ids: &[String], listed: &[OpencodePlugin]) -> BatchPlan {
    let mut plugins: Vec<String> = Vec::new();
    let mut singles: Vec<String> = Vec::new();
    for id in ids {
        let Some(name) = id.strip_prefix("opencode-plugin:") else {
            singles.push(id.clone());
            continue;
        };
        if !listed.iter().any(|plugin| plugin.name == name) {
            continue;
        }
        if !plugins.iter().any(|seen| seen == name) {
            plugins.push(name.to_string());
        }
    }
    BatchPlan { plugins, singles }
}

/// Runs a batch: one install for every plugin, one command each for the rest.
///
/// The result is in the order the ids came in, and every id gets one - a row the batch could not
/// place at all comes back failed rather than missing, so the UI never leaves a row unanswered.
pub fn upgrade_many(ids: &[String]) -> Vec<ComponentUpgrade> {
    let listed = opencode_plugins().unwrap_or_default();
    let plan = plan_batch(ids, &listed);
    let mut results: std::collections::HashMap<String, ComponentUpgrade> =
        std::collections::HashMap::new();

    if !plan.plugins.is_empty() {
        let targets: std::collections::HashSet<String> = plan.plugins.iter().cloned().collect();
        let group = run_upgrade(&opencode_plugins_upgrade(&listed, Some(&targets)));
        match group {
            Ok(said) => {
                for name in &plan.plugins {
                    let id = format!("opencode-plugin:{name}");
                    results.insert(
                        id.clone(),
                        ComponentUpgrade {
                            id,
                            ok: true,
                            message: said.clone(),
                        },
                    );
                }
            }
            Err(said) => {
                // One install covers the group, so one member it cannot install takes the whole
                // group down - and a plugin installed from a git branch does fail on a network that
                // cannot reach the repository. Falling back to one install per plugin costs a second
                // run only in that case, and it is what stops a row that could not be updated from
                // reporting the rows beside it as failed: their own install says whether they moved.
                for name in &plan.plugins {
                    let id = format!("opencode-plugin:{name}");
                    let outcome = if plan.plugins.len() == 1 {
                        Err(said.clone())
                    } else {
                        let one = std::collections::HashSet::from([name.clone()]);
                        run_upgrade(&opencode_plugins_upgrade(&listed, Some(&one)))
                    };
                    let (ok, message) = match outcome {
                        Ok(said) => (true, said),
                        Err(said) => (false, said),
                    };
                    results.insert(id.clone(), ComponentUpgrade { id, ok, message });
                }
            }
        }
    }

    for id in &plan.singles {
        let outcome = upgrade(id);
        let (ok, message) = match outcome {
            Ok(said) => (true, said),
            Err(said) => (false, said),
        };
        results.insert(id.clone(), ComponentUpgrade { id: id.clone(), ok, message });
    }

    ids.iter()
        .map(|id| {
            results.remove(id).unwrap_or_else(|| ComponentUpgrade {
                id: id.clone(),
                ok: false,
                message: format!("没有这个组件：{id}"),
            })
        })
        .collect()
}

/// The upgrade for one component id, without touching the network.
///
/// Separate from `check()` because `check()` asks every source about every component; resolving
/// which command an id means must not cost eight `npm view` calls.
///
/// Every id is checked against the configuration the row could have come from, so an id the renderer
/// made up cannot reach a command: an extension has to be one pi lists, a git package is looked up by
/// the source its settings hold, and a plugin is addressed by the string its configuration spells.
fn upgrade_for(id: &str) -> Option<AgentUpgrade> {
    match id {
        "opencode" => Some(opencode_upgrade()),
        "pi" => Some(pi_self_upgrade()),
        _ => {
            if let Some(package) = id.strip_prefix("pi-extension:") {
                let listed = pi_packages().ok()?;
                let known = listed
                    .iter()
                    .any(|known| matches!(known, PiPackage::Npm(name) if name == package));
                return known.then(pi_extensions_upgrade);
            }
            if let Some(source) = id.strip_prefix("pi-git:") {
                let listed = pi_packages().ok()?;
                let known = listed
                    .iter()
                    .any(|known| matches!(known, PiPackage::Git(git) if git == source));
                // The settings file's own spelling, `git:` prefix and all: without it `pi update`
                // answers "No matching package found" and the checkout stays where it was.
                return known.then(|| pi_package_upgrade(&format!("git:{source}")));
            }
            if let Some(name) = id.strip_prefix("opencode-plugin:") {
                let plugins = opencode_plugins().ok()?;
                if !plugins.iter().any(|plugin| plugin.name == name) {
                    return None;
                }
                // One install names every plugin, not just the row that was clicked: they live in
                // the same npm project, and installing one at a time lets npm put another back at
                // the commit its lock file still names. The others are pinned to where they are (see
                // `opencode_install_specs`), so the row that was clicked is the only one that moves.
                let targets = std::collections::HashSet::from([name.to_string()]);
                return Some(opencode_plugins_upgrade(&plugins, Some(&targets)));
            }
            None
        }
    }
}

/// Runs one component's upgrade command and reports what it said.
///
/// The command is not built from the caller's text: it is looked up by the component id among the
/// commands this module knows, so the renderer can only ask for an upgrade that exists here.
pub fn upgrade(id: &str) -> Result<String, String> {
    let upgrade = upgrade_for(id).ok_or_else(|| format!("没有这个组件：{id}"))?;
    run_upgrade(&upgrade)
}

/// Runs one upgrade command and reports what it said.
fn run_upgrade(upgrade: &AgentUpgrade) -> Result<String, String> {
    run_upgrade_with(upgrade, Duration::from_secs(UPGRADE_TIMEOUT_SECS))
}

/// The command an upgrade runs, as one line: the row's message has to say what was attempted.
fn upgrade_label(upgrade: &AgentUpgrade) -> String {
    format!("{} {}", upgrade.program, upgrade.args.join(" "))
}

fn run_upgrade_with(
    upgrade: &AgentUpgrade,
    timeout: Duration,
) -> Result<String, String> {
    let args: Vec<&str> = upgrade.args.iter().map(String::as_str).collect();
    let label = upgrade_label(upgrade);
    log::info!("agent upgrade: {label}");
    let captured = run_tool(&upgrade.program, &args, timeout, false, &[])?;
    let stdout = String::from_utf8_lossy(&captured.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&captured.stderr).trim().to_string();
    if captured.timed_out {
        // Named, so the next report of this is diagnosable: which command, how long, and that it was
        // the clock rather than a refusal.
        log::warn!(
            "agent upgrade timed out after {:?}: {label}",
            timeout
        );
        return Err(format!("升级命令超时（{label}）"));
    }
    if captured.exit_code != Some(0) {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        let said = if detail.is_empty() {
            format!("升级命令以 {} 退出（{label}）", captured.exit_code.unwrap_or(-1))
        } else {
            detail
        };
        log::warn!(
            "agent upgrade failed (exit {:?}): {label} → {said}",
            captured.exit_code
        );
        return Err(said);
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// Which agent tools are installed and whether newer versions exist. Read-only.
///
/// Async rather than on the blocking pool: the registry reads are HTTP and all run at once, so this
/// never holds a worker thread waiting.
#[tauri::command]
pub async fn agent_versions_check() -> Result<AgentVersions, String> {
    Ok(check().await)
}

/// Runs one component's upgrade command. `id` comes from `agent_versions_check`.
#[tauri::command]
pub async fn agent_versions_upgrade(id: String) -> Result<String, String> {
    crate::modules::fs::blocking(move || upgrade(&id)).await
}

/// Runs a batch of upgrades: one install for the plugins, one command each for the rest.
///
/// A batch exists because the rows are one click, not because they are one command: the plugins are
/// a single npm project, so they are one install, while `pi` and opencode's own updater are separate
/// programs that still run one after another.
#[tauri::command]
pub async fn agent_versions_upgrade_many(ids: Vec<String>) -> Result<Vec<ComponentUpgrade>, String> {
    crate::modules::fs::blocking(move || Ok(upgrade_many(&ids))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_comes_from_npmrc_and_ignores_an_absent_one() {
        // The mirror in this machine's `.npmrc` answered in 187 ms; assuming the public registry
        // would be both slower and a different answer from what `npm install` would do.
        let parse = |text: &str| {
            text.lines()
                .filter_map(|line| {
                    let line = line.trim();
                    let (key, value) = line.split_once('=')?;
                    (key.trim() == "registry").then(|| value.trim().to_string())
                })
                .next_back()
        };
        assert_eq!(
            parse("prefix=D:\\npm\nregistry=https://registry.npmmirror.com/\n"),
            Some("https://registry.npmmirror.com/".to_string())
        );
        assert_eq!(parse("prefix=D:\\npm\n"), None);
    }

    #[test]
    fn a_registry_url_has_no_double_slash() {
        // A trailing slash in `.npmrc` would produce `<base>//<package>/latest`, which some mirrors
        // 404. The trim is what keeps the joined URL well formed.
        let join = |base: &str, package: &str| {
            format!("{}/{package}/latest", base.trim_end_matches('/'))
        };
        assert_eq!(
            join("https://registry.npmmirror.com/", "pi-lens"),
            "https://registry.npmmirror.com/pi-lens/latest"
        );
        assert_eq!(
            join("https://registry.npmjs.org", "@opencode/cli"),
            "https://registry.npmjs.org/@opencode/cli/latest"
        );
    }

    #[test]
    fn opencode_reports_its_version_after_a_v_prefix_or_a_word() {
        // `opencode v2.2.5` and a bare `2.2.5` both have to yield `2.2.5`.
        let parse = |text: &str| {
            text.rsplit_once(' ')
                .map(|(_, last)| last)
                .unwrap_or(text)
                .trim_start_matches('v')
                .to_string()
        };
        assert_eq!(parse("opencode v2.2.5"), "2.2.5");
        assert_eq!(parse("2.2.5"), "2.2.5");
    }

    #[test]
    fn the_upgrade_is_resolved_from_the_configuration_not_from_the_callers_text() {
        // An id the renderer invented must not become a command. Every id family is looked up in the
        // file it could have come from, so nothing here reaches a program on the caller's word.
        assert!(upgrade("rm -rf /").is_err());
        assert!(upgrade("opencode --session x").is_err());
        assert!(upgrade("pi-extension:../../etc").is_err());
        assert!(upgrade("pi-git:github.com/nobody/nothing").is_err());
        assert!(upgrade("opencode-plugin:../../etc/passwd").is_err());
        assert!(upgrade_for("opencode").is_some());
        assert!(upgrade_for("pi").is_some());
    }

    #[test]
    fn pi_packages_keep_both_forms_that_have_an_upstream() {
        // The npm form is a registry package and the git form is a checkout; a local path is the
        // user's own directory and has nothing to compare against, so it contributes no row.
        let json: serde_json::Value = serde_json::from_str(
            r#"{"packages":["npm:pi-lens","git:github.com/obra/superpowers","/local/dir","npm:"]}"#,
        )
        .unwrap();
        assert_eq!(
            parse_pi_packages(&json),
            vec![
                PiPackage::Npm("pi-lens".into()),
                PiPackage::Git("github.com/obra/superpowers".into()),
            ]
        );
        // A settings file with no list at all is a machine with nothing installed, not an error.
        let empty: serde_json::Value = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(parse_pi_packages(&empty), Vec::new());
    }

    #[test]
    fn a_git_package_reads_as_its_repository() {
        assert_eq!(
            git_source_label("github.com/obra/superpowers"),
            "obra/superpowers"
        );
        assert_eq!(
            git_source_label("github.com/obra/superpowers.git"),
            "obra/superpowers"
        );
        // A source with no host segment is its own label rather than an empty one.
        assert_eq!(git_source_label("superpowers"), "superpowers");
    }

    #[test]
    fn a_checkout_is_read_through_its_head_a_loose_ref_or_a_packed_one() {
        // pi's own checkout of superpowers points `HEAD` at a loose `refs/heads/main`; git packs a
        // branch's ref once a repository has a few, so the packed file is the other half of this.
        assert_eq!(
            parse_head("ref: refs/heads/main\n"),
            Some(Head::Branch("refs/heads/main".into()))
        );
        assert_eq!(
            parse_head("2ce8aa15c2b3f0e2b0e19b2f7b8c2ce8aa15c2b3\n"),
            Some(Head::Commit(
                "2ce8aa15c2b3f0e2b0e19b2f7b8c2ce8aa15c2b3".into()
            ))
        );
        assert_eq!(parse_head("  \n"), None);

        let packed = "# pack-refs with: peeled fully-peeled sorted\n\
                      22f0b4638d0a2f4d4df6c13d2b7e2f2b0b4f1a99 refs/heads/main\n\
                      9c0e1b0c1a5a5a2cbb20a02c9b3c4d5e6f708192 refs/remotes/origin/main\n";
        assert_eq!(
            packed_ref(packed, "refs/heads/main"),
            Some("22f0b4638d0a2f4d4df6c13d2b7e2f2b0b4f1a99".into())
        );
        assert_eq!(packed_ref(packed, "refs/heads/other"), None);
    }

    #[test]
    fn a_package_source_becomes_a_url_and_a_row_shortens_a_commit() {
        assert_eq!(
            package_url("github.com/obra/superpowers"),
            "https://github.com/obra/superpowers"
        );
        // A source that already names a protocol or a user is left as it is written.
        assert_eq!(
            package_url("git@github.com:obra/superpowers.git"),
            "git@github.com:obra/superpowers.git"
        );
        assert_eq!(short_sha(&"a".repeat(40)), "aaaaaaa");
        assert_eq!(short_sha("2ce8aa1"), "2ce8aa1");
    }

    #[test]
    fn only_a_github_source_is_asked_through_the_api() {
        // The split that keeps the check quick on this machine: GitHub answers an HTTP request for a
        // commit in about a second, every other host has to go through git.
        assert_eq!(
            github_repo("github.com/obra/superpowers"),
            Some("obra/superpowers".to_string())
        );
        assert_eq!(
            github_repo("github.com/obra/superpowers.git"),
            Some("obra/superpowers".to_string())
        );
        // Not a repository to ask: another host, or a path with no owner.
        assert_eq!(github_repo("gitlab.com/obra/superpowers"), None);
        assert_eq!(github_repo("github.com/superpowers"), None);
        assert_eq!(github_repo("github.com/"), None);
    }

    #[test]
    fn a_tools_colour_escapes_are_gone_before_a_version_is_read() {
        // `opencode --version` colours its answer even through a pipe, which was measured here as
        // `ESC[2mvESC[0mESC[1m2.2.5ESC[0m`; the row would otherwise show the escapes as its version.
        assert_eq!(strip_ansi("\u{1b}[2mv\u{1b}[0m\u{1b}[1m2.2.5\u{1b}[0m"), "v2.2.5");
        assert_eq!(strip_ansi("2.2.5"), "2.2.5");
        assert_eq!(strip_ansi(""), "");
        // An escape with nothing after it, or one that is not a control sequence, must not eat text.
        assert_eq!(strip_ansi("\u{1b}"), "");
        assert_eq!(strip_ansi("a\u{1b}b"), "ab");
    }

    #[test]
    fn a_plugin_spec_is_read_as_a_registry_package_or_a_repository() {
        // The two plugins on this machine: `^5.3.2` is npm's own spelling of a registry install and
        // `github:obra/superpowers` is a repository npm never sees.
        assert_eq!(plugin_upstream("^5.3.2"), PluginUpstream::Registry);
        assert_eq!(plugin_upstream("5.3.2"), PluginUpstream::Registry);
        assert_eq!(
            plugin_upstream("github:obra/superpowers"),
            PluginUpstream::Github("obra/superpowers".into())
        );
        assert_eq!(
            plugin_upstream("git+https://github.com/obra/superpowers.git"),
            PluginUpstream::Github("obra/superpowers".into())
        );
        assert_eq!(
            plugin_upstream("git+ssh://git@github.com/obra/superpowers.git"),
            PluginUpstream::Github("obra/superpowers".into())
        );
    }

    /// The set of plugins a click asked for, as `opencode_install_specs` takes it.
    fn set(names: &[&str]) -> std::collections::HashSet<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    /// The ids a batch click hands over, as the UI spells them.
    fn batch(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    /// What this machine's opencode config lists, for the planning tests.
    fn listed() -> Vec<OpencodePlugin> {
        vec![
            plugin("@dietrichgebert/ponytail", "^5.3.3"),
            plugin("superpowers", "github:obra/superpowers"),
        ]
    }

    #[test]
    fn a_batch_groups_the_plugins_of_one_project_into_one_install() {
        // Both plugins live in the same npm project, so they are one install - two of them were two
        // installs, each pinning the other, which is the waste this plan removes.
        let plan = plan_batch(
            &batch(&[
                "opencode-plugin:@dietrichgebert/ponytail",
                "pi",
                "opencode-plugin:superpowers",
            ]),
            &listed(),
        );
        assert_eq!(
            plan.plugins,
            vec!["@dietrichgebert/ponytail", "superpowers"]
        );
        assert_eq!(plan.singles, vec!["pi"]);
    }

    #[test]
    fn a_batch_drops_what_the_configuration_does_not_list() {
        // An id the settings no longer hold must not block the rest of the batch, and must never
        // reach an install command: the id is checked against the configuration, as everywhere else.
        let plan = plan_batch(
            &batch(&[
                "opencode-plugin:not-installed",
                "opencode-plugin:superpowers",
                "opencode-plugin:superpowers",
            ]),
            &listed(),
        );
        assert_eq!(plan.plugins, vec!["superpowers"]);
        assert!(plan.singles.is_empty());
    }

    #[test]
    fn a_batch_of_only_singles_plans_no_install() {
        // No plugins means no `npm install` at all - an empty one would still touch the project.
        let plan = plan_batch(&batch(&["pi", "opencode"]), &listed());
        assert!(plan.plugins.is_empty());
        assert_eq!(plan.singles, vec!["pi", "opencode"]);
    }

    #[test]
    fn a_batch_of_nothing_plans_nothing() {
        let plan = plan_batch(&[], &listed());
        assert!(plan.plugins.is_empty() && plan.singles.is_empty());
    }

    /// A plugin as the settings file spells it.
    fn plugin(name: &str, spec: &str) -> OpencodePlugin {
        OpencodePlugin {
            name: name.into(),
            spec: spec.into(),
        }
    }

    #[test]
    fn an_update_pins_every_plugin_it_was_not_asked_about() {
        // "回退一个小版本然后重试": one `npm install` named every plugin at its latest, so a click about
        // one row put a plugin installed from a git branch back to the registry's older version.
        let plugins = vec![plugin("@a/asked", "^5.3.2"), plugin("@b/other", "^1.0.0")];
        let installed = std::collections::HashMap::from([
            ("@a/asked".to_string(), "5.3.2".to_string()),
            ("@b/other".to_string(), "1.4.0".to_string()),
        ]);
        assert_eq!(
            opencode_install_specs(&plugins, &installed, Some(&set(&["@a/asked"]))),
            vec!["@a/asked@latest", "@b/other@1.4.0"]
        );

        // Asking for the other one pins the first instead: only the row that was clicked moves.
        assert_eq!(
            opencode_install_specs(&plugins, &installed, Some(&set(&["@b/other"]))),
            vec!["@a/asked@5.3.2", "@b/other@latest"]
        );
        // A plugin whose installed version cannot be read keeps the spec's own newest, which is what
        // every plugin used to get - an install must not fail over the pin.
        let none_installed = std::collections::HashMap::new();
        assert_eq!(
            opencode_install_specs(&plugins, &none_installed, Some(&set(&["@a/asked"]))),
            vec!["@a/asked@latest", "@b/other@latest"]
        );
    }

    #[test]
    fn the_batch_asks_every_registry_plugin_for_its_latest() {
        let plugins = vec![plugin("@a/one", "^1.0.0"), plugin("@b/two", "^2.0.0")];
        let installed = std::collections::HashMap::from([
            ("@a/one".to_string(), "1.0.0".to_string()),
            ("@b/two".to_string(), "2.0.0".to_string()),
        ]);
        assert_eq!(
            opencode_install_specs(&plugins, &installed, None),
            vec!["@a/one@latest", "@b/two@latest"]
        );
    }

    #[test]
    fn a_git_plugin_is_installed_from_its_own_spec() {
        // Its installed version is not on the registry, so pinning to it would fail the whole install;
        // the spec is how npm re-resolves the branch.
        let plugins = vec![
            plugin("superpowers", "github:obra/superpowers"),
            plugin("@a/other", "^1.0.0"),
        ];
        let installed = std::collections::HashMap::from([
            ("superpowers".to_string(), "7.0.1".to_string()),
            ("@a/other".to_string(), "1.4.0".to_string()),
        ]);
        assert_eq!(
            opencode_install_specs(&plugins, &installed, Some(&set(&["@a/other"]))),
            vec!["superpowers@github:obra/superpowers", "@a/other@latest"]
        );
    }

    #[test]
    fn a_refused_read_says_whether_it_was_the_quota() {
        // The row showed "HTTP 403 Forbidden" and nothing else, which reads as "broken"; the quota is
        // the thing a user can act on.
        let quota = http_failure("obra/superpowers", 403);
        assert!(quota.contains("403"), "{quota}");
        assert!(quota.contains("配额"), "{quota}");
        assert!(http_failure("obra/superpowers", 429).contains("配额"));
        // Any other refusal is reported as what it is, with the source still named.
        let other = http_failure("some-package", 500);
        assert!(other.contains("some-package") && other.contains("500"), "{other}");
        assert!(!other.contains("配额"), "{other}");
    }

    #[test]
    fn an_opencode_plugin_is_read_as_a_registry_package_or_a_repository() {
        // The two plugins on this machine: `^5.3.2` is npm's own spelling of a registry install and
        // `github:obra/superpowers` is a repository npm never sees.
        let json: serde_json::Value = serde_json::from_str(
            r#"{"dependencies":{
                 "superpowers":"github:obra/superpowers",
                 "@dietrichgebert/ponytail":"^5.3.2",
                 "@opencode-ai/plugin":"^1.18.30"
               }}"#,
        )
        .unwrap();
        assert_eq!(
            parse_opencode_plugins(&json),
            vec![
                OpencodePlugin {
                    name: "@dietrichgebert/ponytail".into(),
                    spec: "^5.3.2".into(),
                },
                OpencodePlugin {
                    name: "superpowers".into(),
                    spec: "github:obra/superpowers".into(),
                },
            ]
        );
    }

    #[test]
    fn a_timed_out_upgrade_says_which_command_and_that_it_was_the_time() {
        // "升级失败" with nothing after it is what this used to say, and it is unfixable from the
        // outside: the row cannot tell a network that never answered from a tree npm refused.
        let upgrade = AgentUpgrade {
            program: "ping".into(),
            args: vec!["-n".into(), "6".into(), "127.0.0.1".into()],
        };
        let error = run_upgrade_with(&upgrade, Duration::from_millis(300)).unwrap_err();
        assert!(error.contains("超时"), "{error}");
        assert!(error.contains("ping"), "{error}");
    }
}
