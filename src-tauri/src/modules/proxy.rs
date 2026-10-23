//! Proxy addresses for external programs (used by `gh` today; git's fetch / push /
//! clone will need them too).
//!
//! `gh` ignores Windows' Internet settings, and the inherited `HTTPS_PROXY` may be an
//! **empty string** (as on this machine: the variable exists, its value is blank), so it
//! connects to `api.github.com` directly and on a machine behind a proxy only ever gets
//! `TLS handshake timeout`. This resolves an address by "explicit > environment > system
//! settings", hands it to the child process, and clears the inherited proxy variables
//! first so empty or stale values cannot interfere.

use std::process::Command;

/// Proxy-related variables in the child environment: all cleared first, then the
/// upper-case ones set back as needed.
const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// An empty string counts as "not set". Blank inputs in the UI and empty environment
/// variables both end up here.
pub fn normalize(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Extract a usable http(s) proxy address from strings like `ProxyServer`, or None.
///
/// - `127.0.0.1:7890`: host and port only, so the http scheme is filled in;
/// - `http=127.0.0.1:7890;https=127.0.0.1:7891`: per-entry, preferring https;
/// - `socks=127.0.0.1:1080`: None when only socks entries exist (gh cannot use them);
/// - empty or unrecognised strings: None.
pub fn parse_proxy_server(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Already a full address: only http(s) is accepted, nothing else (socks, ftp).
    if trimmed.contains("://") {
        let value = trimmed.trim_end_matches('/');
        return if value.starts_with("http://") || value.starts_with("https://") {
            Some(value.to_string())
        } else {
            None
        };
    }

    let mut http: Option<String> = None;
    let mut https: Option<String> = None;
    for entry in trimmed.split(';') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (scheme, value) = match entry.split_once('=') {
            Some((scheme, value)) => (scheme.trim().to_ascii_lowercase(), value.trim()),
            // A bare host and port: treat it as an http proxy.
            None => ("http".to_string(), entry),
        };
        if value.is_empty() || value.contains(char::is_whitespace) {
            continue;
        }
        // `https=` says which proxy https requests use; the proxy itself is still an
        // http endpoint.
        let endpoint = format!("http://{value}");
        match scheme.as_str() {
            "https" => https = Some(endpoint),
            // With several http entries in the same tier, take the first.
            "http" if http.is_none() => http = Some(endpoint),
            _ => {}
        }
    }
    https.or(http)
}

/// The proxy from environment variables. Case-insensitive; an empty string counts as
/// unset.
pub fn from_env() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .into_iter()
        .find_map(|key| normalize(std::env::var(key).ok().as_deref()))
}

/// The proxy actually used for this call: explicit > environment > system settings.
pub fn resolve(explicit: Option<&str>) -> Option<String> {
    normalize(explicit).or_else(from_env).or_else(from_system)
}

/// Apply the proxy to a child process: clear the inherited variables first, then set
/// them back as needed.
pub fn apply(cmd: &mut Command, proxy: Option<&str>) {
    for key in PROXY_ENV_KEYS {
        cmd.env_remove(key);
    }
    if let Some(value) = proxy {
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
            cmd.env(key, value);
        }
    }
}

/// The proxy from system settings.
#[cfg(windows)]
pub fn from_system() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, RegGetValueW, RRF_RT_REG_DWORD,
    };

    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    // If ProxyEnable is not 1 (or cannot be read), treat proxying as off.
    let mut enabled: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide(KEY).as_ptr(),
            wide("ProxyEnable").as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            std::ptr::from_mut(&mut enabled).cast(),
            &mut size,
        )
    };
    if status != 0 || enabled != 1 {
        return None;
    }

    let raw = read_registry_string(HKEY_CURRENT_USER, KEY, "ProxyServer")?;
    parse_proxy_server(&raw)
}

/// Off Windows, system settings are just the environment variables.
#[cfg(not(windows))]
pub fn from_system() -> Option<String> {
    from_env()
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read a REG_SZ: ask for the length first, then read the value.
#[cfg(windows)]
fn read_registry_string(
    root: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
    value: &str,
) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};

    let mut size: u32 = 0;
    let status = unsafe {
        RegGetValueW(
            root,
            wide(key).as_ptr(),
            wide(value).as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status != 0 || size < 2 {
        return None;
    }

    // size is in bytes (including the trailing NUL); allocate one extra u16 as slack.
    let mut buffer = vec![0u16; (size as usize / 2) + 1];
    let status = unsafe {
        RegGetValueW(
            root,
            wide(key).as_ptr(),
            wide(value).as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let len = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_host_and_port_becomes_an_http_proxy() {
        assert_eq!(
            parse_proxy_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn per_scheme_entries_prefer_the_https_one() {
        assert_eq!(
            parse_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891").as_deref(),
            Some("http://127.0.0.1:7891")
        );
        assert_eq!(
            parse_proxy_server("http=127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn a_socks_only_setting_is_not_usable() {
        assert_eq!(parse_proxy_server("socks=127.0.0.1:1080"), None);
        assert_eq!(parse_proxy_server("socks5://127.0.0.1:1080"), None);
    }

    #[test]
    fn an_address_that_already_has_a_scheme_is_kept() {
        assert_eq!(
            parse_proxy_server("http://127.0.0.1:7890/").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_proxy_server("https://proxy.example:8443").as_deref(),
            Some("https://proxy.example:8443")
        );
    }

    #[test]
    fn empty_and_whitespace_values_are_no_proxy() {
        assert_eq!(parse_proxy_server(""), None);
        assert_eq!(parse_proxy_server("   "), None);
        assert_eq!(normalize(Some("  ")), None);
        assert_eq!(normalize(None), None);
        assert_eq!(normalize(Some(" http://a:1 ")).as_deref(), Some("http://a:1"));
    }

    #[test]
    fn an_explicit_setting_wins_over_everything_else() {
        // On this machine the environment variable is an empty string, which exercises
        // "an empty string is not a configured proxy".
        assert_eq!(
            resolve(Some("http://127.0.0.1:9999")).as_deref(),
            Some("http://127.0.0.1:9999")
        );
        assert_eq!(resolve(Some("  ")), from_env().or_else(from_system));
    }

    #[test]
    fn applying_a_proxy_leaves_no_stale_lower_case_value() {
        let mut cmd = Command::new("gh");
        apply(&mut cmd, Some("http://127.0.0.1:7890"));
        for (key, value) in cmd.get_envs() {
            let key = key.to_string_lossy().into_owned();
            let upper = key.to_ascii_uppercase();
            if PROXY_ENV_KEYS.contains(&upper.as_str()) {
                if key == upper {
                    assert_eq!(
                        value.map(|v| v.to_string_lossy().into_owned()),
                        Some("http://127.0.0.1:7890".to_string()),
                        "{key} 没设成代理"
                    );
                } else {
                    assert!(value.is_none(), "{key} 这种小写变量不该留值");
                }
            }
        }
    }

    #[test]
    fn applying_no_proxy_leaves_no_proxy_values_behind() {
        // Note that `env_remove` is a no-op for variables absent from the parent, leaving
        // no record, so this only asserts that no proxy variable holds a value.
        let mut cmd = Command::new("gh");
        apply(&mut cmd, None);
        for (key, value) in cmd.get_envs() {
            let key = key.to_string_lossy().into_owned();
            if PROXY_ENV_KEYS.contains(&key.to_ascii_uppercase().as_str()) {
                assert!(value.is_none(), "{key} 不该留下值");
            }
        }
    }
}