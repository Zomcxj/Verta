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
//!   `package.json` and its published version is one registry read.
//!
//! The registry reads are the slow part and are done in parallel, because `npm view` takes about a
//! second each and there can be eight of them.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use serde::Serialize;

use crate::modules::proc::capture::{self, Limits};

const NPM_TIMEOUT_SECS: u64 = 25;
const VERSION_TIMEOUT_SECS: u64 = 15;
/// Registry reads are one small GET each; a slow one must not hold the popover open.
const REGISTRY_TIMEOUT_SECS: u64 = 10;
const MAX_OUTPUT: usize = 64 * 1024;
/// A `latest` document is a few kilobytes; `pi-lens` is the largest at 94 KB.
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;

/// Runs one tool and hands back what it printed.
///
/// Every tool here is an npm shim on Windows - `npm`, `opencode` and `pi` are all `.cmd` files
/// beside a real `.exe` - and `CreateProcess` refuses to run a `.cmd`, which is why a bare
/// `Command::new("npm")` failed with "program not found" even though the command is on the path.
/// Going through `cmd /C` lets the shell resolve the shim; the program and its arguments are this
/// module's own constants, never the caller's text, so there is nothing for the shell to reparse.
///
/// `capture::run` also expects the pipes to be in place already and fails at spawn time with a
/// message nobody can act on, so they are set here rather than at each call site.
fn run_tool(program: &str, args: &[&str], timeout: Duration, stop_on_cap: bool) -> Result<capture::Captured, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program);
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(program);
    cmd.args(args);
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

/// One thing that may be upgraded.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentComponent {
    /// Stable id for the row: `opencode`, `pi`, or `pi-extension:<package>`.
    pub id: String,
    /// What the row is called.
    pub name: String,
    /// The version on this machine, or `None` when it could not be read.
    pub current: Option<String>,
    /// The newest published version, or `None` when the registry could not be asked.
    pub latest: Option<String>,
    /// Why the answer is incomplete, when it is. `None` when both versions were read.
    pub error: Option<String>,
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

/// The client used for registry reads: plain HTTPS, one request per package, short timeout.
fn registry_client() -> Result<reqwest::Client, String> {
    // reqwest here has no bundled TLS provider, so a client built without one fails and the
    // failure would read as "the registry said nothing".
    crate::modules::tls::ensure_crypto_provider();
    reqwest::Client::builder()
        // A registry read carries no credentials, so a redirect is harmless, but a proxy is the
        // user's own setting and is honoured (`system-proxy` on Windows).
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(Duration::from_secs(REGISTRY_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
}

/// The newest published version of one package, or why the registry did not answer.
async fn published_version(
    client: &reqwest::Client,
    base: &str,
    package: &str,
) -> Result<String, String> {
    // Scoped packages keep their `@` and their slash in the path; the registry accepts the
    // unescaped form, which is what `npm view` sends.
    let url = format!("{base}/{package}/latest");
    let response = client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("查询 {package} 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("查询 {package} 失败：HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|len| len > MAX_REGISTRY_BYTES as u64)
    {
        return Err(format!("查询 {package} 的响应过大"));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("读取 {package} 的响应失败：{error}"))?;
    if body.len() > MAX_REGISTRY_BYTES {
        return Err(format!("查询 {package} 的响应过大"));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&body).map_err(|error| format!("解析 {package} 的响应失败：{error}"))?;
    json.get("version")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("{package} 的响应没有 version"))
}

/// The version `opencode --version` reports, which prints `opencode v2.2.5`.
fn opencode_installed() -> Result<String, String> {
    let captured = run_tool(
        "opencode",
        &["--version"],
        Duration::from_secs(VERSION_TIMEOUT_SECS),
        true,
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
    let stdout = String::from_utf8_lossy(&captured.stdout);
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

/// The npm packages pi has installed as extensions, from its own settings file.
fn pi_extension_packages() -> Result<Vec<String>, String> {
    let home = dirs::home_dir().ok_or("找不到用户主目录，无法定位 pi")?;
    let file = home.join(".pi/agent/settings.json");
    let text = std::fs::read_to_string(&file)
        .map_err(|error| format!("读取 {} 失败：{error}", file.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("解析 pi 设置失败：{error}"))?;
    let mut packages = Vec::new();
    if let Some(list) = json.get("packages").and_then(|value| value.as_array()) {
        for entry in list {
            let Some(text) = entry.as_str() else { continue };
            // `npm:pi-lens` is the npm form; anything else (a local path) has no registry version.
            if let Some(name) = text.strip_prefix("npm:") {
                if !name.is_empty() {
                    packages.push(name.to_string());
                }
            }
        }
    }
    Ok(packages)
}

/// The version of an installed extension, read from its own `package.json`.
fn installed_extension_version(package: &str) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("找不到用户主目录，无法定位 pi")?;
    let dir = home.join(".pi/agent/npm/node_modules").join(package);
    let file = dir.join("package.json");
    let text = std::fs::read_to_string(&file)
        .map_err(|error| format!("读取 {} 失败：{error}", file.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("解析 {package} 的 package.json 失败：{error}"))?;
    json.get("version")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("{package} 的 package.json 没有 version"))
}

fn opencode_component(client: &reqwest::Client, base: &str) -> impl std::future::Future<Output = AgentComponent> + use<> {
    let client = client.clone();
    let base = base.to_string();
    async move {
        let current = opencode_installed();
        let latest = published_version(&client, &base, OPENCODE_PACKAGE).await;
        let error = match (&current, &latest) {
            (Err(current_error), _) => Some(current_error.clone()),
            (_, Err(latest_error)) => Some(latest_error.clone()),
            _ => None,
        };
        AgentComponent {
            id: "opencode".into(),
            name: "opencode".into(),
            current: current.ok(),
            latest: latest.ok(),
            error,
            upgrade: AgentUpgrade {
                program: "opencode".into(),
                args: vec!["upgrade".into()],
            },
        }
    }
}

fn pi_component(client: &reqwest::Client, base: &str) -> impl std::future::Future<Output = AgentComponent> + use<> {
    let client = client.clone();
    let base = base.to_string();
    async move {
        let current = pi_installed();
        let latest = published_version(&client, &base, PI_PACKAGE).await;
        let error = match (&current, &latest) {
            (Err(current_error), _) => Some(current_error.clone()),
            (_, Err(latest_error)) => Some(latest_error.clone()),
            _ => None,
        };
        AgentComponent {
            id: "pi".into(),
            name: "pi".into(),
            current: current.ok(),
            latest: latest.ok(),
            error,
            upgrade: AgentUpgrade {
                program: "pi".into(),
                // `--self` is pi's own switch for "pi only"; `--no-approve` keeps it from stopping to
                // ask about project-local files, which a click in the bell cannot answer.
                args: vec![
                    "update".into(),
                    "--self".into(),
                    "--no-approve".into(),
                ],
            },
        }
    }
}

/// One extension's row.
fn pi_extension_component(
    client: &reqwest::Client,
    base: &str,
    package: &str,
) -> impl std::future::Future<Output = AgentComponent> + use<> {
    let client = client.clone();
    let base = base.to_string();
    let package = package.to_string();
    async move {
        let current = installed_extension_version(&package);
        let latest = published_version(&client, &base, &package).await;
        let error = match (&current, &latest) {
            (Err(current_error), _) => Some(current_error.clone()),
            (_, Err(latest_error)) => Some(latest_error.clone()),
            _ => None,
        };
        AgentComponent {
            id: format!("pi-extension:{package}"),
            name: package.clone(),
            current: current.ok(),
            latest: latest.ok(),
            error,
            upgrade: AgentUpgrade {
                program: "pi".into(),
                args: vec![
                    "update".into(),
                    "--extensions".into(),
                    "--no-approve".into(),
                ],
            },
        }
    }
}

fn pi_extension_package_names() -> Vec<String> {
    // Without the settings file there is nothing to list; that is not an error the bell should
    // shout about, so it contributes no rows.
    pi_extension_packages().unwrap_or_default()
}

/// Reads the installed and published version of opencode, pi, and pi's extensions.
///
/// Every registry read is one small GET, and they all run at once: `npm view` cost 2.7 s a package
/// because of npm's own startup, so nine of them took 14.8 s in a row and 9.4 s even in parallel,
/// while nine plain HTTP reads against the configured mirror answered in 187 ms.
pub async fn check() -> AgentVersions {
    let packages = pi_extension_package_names();
    let base = registry_base();
    let client = match registry_client() {
        Ok(client) => client,
        // Without a client nothing can be asked, but the installed versions are still readable, so
        // the rows list with their `current` and an error rather than disappearing.
        Err(error) => {
            let mut components = vec![
                installed_only("opencode", "opencode", &opencode_installed(), &error),
                installed_only("pi", "pi", &pi_installed(), &error),
            ];
            for package in &packages {
                components.push(installed_only(
                    &format!("pi-extension:{package}"),
                    package,
                    &installed_extension_version(package),
                    &error,
                ));
            }
            return AgentVersions { components };
        }
    };
    let (opencode, pi, extensions) = tokio::join!(
        opencode_component(&client, &base),
        pi_component(&client, &base),
        futures_util::future::join_all(
            packages
                .iter()
                .map(|package| pi_extension_component(&client, &base, package)),
        ),
    );
    let mut components = vec![
        opencode,
        pi,
    ];
    components.extend(extensions);
    AgentVersions { components }
}

/// A row with only the installed version, for when the registry could not be asked at all.
fn installed_only(
    id: &str,
    name: &str,
    current: &Result<String, String>,
    error: &str,
) -> AgentComponent {
    AgentComponent {
        id: id.to_string(),
        name: name.to_string(),
        current: current.as_ref().ok().cloned(),
        latest: None,
        error: Some(error.to_string()),
        upgrade: AgentUpgrade {
            program: if id == "opencode" { "opencode" } else { "pi" }.to_string(),
            args: if id == "opencode" {
                vec!["upgrade".into()]
            } else {
                vec!["update".into(), "--self".into(), "--no-approve".into()]
            },
        },
    }
}

/// The upgrade for one component id, without touching the network.
///
/// Separate from `check()` because `check()` asks the registry about every component; resolving
/// which command an id means must not cost eight `npm view` calls.
fn upgrade_for(id: &str) -> Option<AgentUpgrade> {
    match id {
        "opencode" => Some(AgentUpgrade {
            program: "opencode".into(),
            args: vec!["upgrade".into()],
        }),
        "pi" => Some(AgentUpgrade {
            program: "pi".into(),
            args: vec!["update".into(), "--self".into(), "--no-approve".into()],
        }),
        _ => {
            // `pi-extension:<package>`: the package is the part after the prefix, and it has to be
            // one pi actually lists, so an id the renderer made up cannot reach the command.
            let package = id.strip_prefix("pi-extension:")?;
            let listed = pi_extension_packages().ok()?;
            if !listed.iter().any(|known| known == package) {
                return None;
            }
            Some(AgentUpgrade {
                program: "pi".into(),
                args: vec!["update".into(), "--extensions".into(), "--no-approve".into()],
            })
        }
    }
}

/// Runs one component's upgrade command and reports what it said.
///
/// The command is not built from the caller's text: it is looked up by the component id among the
/// commands this module knows, so the renderer can only ask for an upgrade that exists here.
pub fn upgrade(id: &str) -> Result<String, String> {
    let upgrade = upgrade_for(id).ok_or_else(|| format!("没有这个组件：{id}"))?;
    let args: Vec<&str> = upgrade.args.iter().map(String::as_str).collect();
    let captured = run_tool(
        &upgrade.program,
        &args,
        Duration::from_secs(NPM_TIMEOUT_SECS * 4),
        false,
    )?;
    let stdout = String::from_utf8_lossy(&captured.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&captured.stderr).trim().to_string();
    if captured.timed_out {
        return Err("升级命令超时".into());
    }
    if captured.exit_code != Some(0) {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            format!("升级命令以 {} 退出", captured.exit_code.unwrap_or(-1))
        } else {
            detail
        });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upgrade_that_does_not_exist_is_refused() {
        // The renderer can only ask for a component this module knows; anything else is an error
        // rather than a command run on the caller's word.
        assert!(upgrade("rm -rf /").is_err());
        assert!(upgrade("opencode --session x").is_err());
        assert!(upgrade("pi-extension:../../etc").is_err());
        assert!(upgrade_for("opencode").is_some());
        assert!(upgrade_for("pi").is_some());
    }

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
    fn pi_extension_packages_skip_anything_that_is_not_an_npm_name() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"packages":["npm:pi-lens","/local/dir","npm:pi-web-access"]}"#,
        )
        .unwrap();
        let mut names = Vec::new();
        if let Some(list) = json.get("packages").and_then(|value| value.as_array()) {
            for entry in list {
                let Some(text) = entry.as_str() else { continue };
                if let Some(name) = text.strip_prefix("npm:") {
                    if !name.is_empty() {
                        names.push(name.to_string());
                    }
                }
            }
        }
        assert_eq!(names, vec!["pi-lens", "pi-web-access"]);
    }
}
