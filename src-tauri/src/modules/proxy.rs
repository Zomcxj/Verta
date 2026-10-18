//! 给外部程序准备的代理地址（现在给 `gh` 用，将来 git 的 fetch / push / clone 也要用）。
//!
//! `gh` 不读 Windows 的 Internet 设置，而进程继承来的 `HTTPS_PROXY` 可能是**空串**
//! （本机就是：变量在、值为空），于是它直连 `api.github.com`，在有代理的机器上只会拿到
//! `TLS handshake timeout`。这里按「显式传入 > 环境变量 > 系统设置」取一个地址塞给子进程，
//! 并把继承来的那几个代理变量先清掉，免得空串或过期的值干扰。

use std::process::Command;

/// 子进程环境里跟代理有关的变量：先全清，再按需要设回大写那几个。
const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// 空串等同于「没设」。界面上留白的输入框、环境里的空变量都会走到这里。
pub fn normalize(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 从 `ProxyServer` 这类字符串里取出能用的 http(s) 代理地址，取不到就 None。
///
/// - `127.0.0.1:7890`：只有主机端口，按 http 代理补上 scheme；
/// - `http=127.0.0.1:7890;https=127.0.0.1:7891`：按条目取，优先 https；
/// - `socks=127.0.0.1:1080`：只有 socks 条目时返回 None（gh 不能直接吃）；
/// - 空串、认不出的串返回 None。
pub fn parse_proxy_server(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 已经是完整地址：只认 http(s)，别的（socks、ftp）一律不要。
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
            // 光秃秃一个主机端口：按 http 代理算。
            None => ("http".to_string(), entry),
        };
        if value.is_empty() || value.contains(char::is_whitespace) {
            continue;
        }
        // `https=` 给的是「https 请求走哪个代理」，代理本身仍是 http 端点。
        let endpoint = format!("http://{value}");
        match scheme.as_str() {
            "https" => https = Some(endpoint),
            // 同一档里出现多个 http 条目时取第一个。
            "http" if http.is_none() => http = Some(endpoint),
            _ => {}
        }
    }
    https.or(http)
}

/// 环境变量里的代理。大小写都认，空串当没设。
pub fn from_env() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .into_iter()
        .find_map(|key| normalize(std::env::var(key).ok().as_deref()))
}

/// 本次调用实际用的代理：显式传入 > 环境变量 > 系统设置。
pub fn resolve(explicit: Option<&str>) -> Option<String> {
    normalize(explicit).or_else(from_env).or_else(from_system)
}

/// 把代理应用到子进程：先清掉继承来的那几个变量，再按需要设回。
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

/// 系统设置里的代理。
#[cfg(windows)]
pub fn from_system() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, RegGetValueW, RRF_RT_REG_DWORD,
    };

    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    // ProxyEnable 不是 1（或读不到）就按没开代理算。
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

/// 非 Windows 上系统设置就是环境变量那一份。
#[cfg(not(windows))]
pub fn from_system() -> Option<String> {
    from_env()
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 读一个 REG_SZ：先问长度，再取内容。
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

    // size 是字节数（含结尾的 NUL），多要一个 u16 兜底。
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
        // 环境变量在本机是空串，正好验证「空串不算设置了代理」。
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
        // 注意 `env_remove` 对「父进程里本来就没有」的变量是 no-op，不会留下记录，
        // 所以这里断言的是「没有任何代理变量被设成值」。
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