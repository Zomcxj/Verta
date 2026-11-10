//! What a path means on Windows when a POSIX shell spelled it.
//!
//! Git-Bash reports its working directory over OSC 7 in MSYS spelling, and only one shape of it can be
//! repaired by reading: `/c/Users/x` is a drive letter in disguise, which the OSC 7 parser already
//! turns into `C:/Users/x`. Everything else keeps its POSIX spelling - `/tmp`, `/usr/bin`, `/home/x` -
//! and those are real places under the Git for Windows install or under `%TEMP%`, which no amount of
//! reading can work out: `/tmp` is the user's temp directory, and only the install's own mount table
//! says so.
//!
//! So the shell is asked. `cygpath -w` is the translator MSYS ships for exactly this, and the answer
//! is what a Windows API can then open. Measured on this machine: `/tmp` is
//! `C:\Users\<user>\AppData\Local\Temp`, `/` is the install's own root, and a path under no mount at
//! all comes back as a plausible-looking path that does not exist - which is why nothing here pretends
//! to validate and the caller still shows the failure it gets from the filesystem.
//!
//! Nothing is guessed from the text: a path that already has a drive letter or is a UNC path is not
//! asked about at all.

use std::path::{Path, PathBuf};

use super::blocking;

/// Whether a path is spelled in a way only a POSIX shell understands.
///
/// A leading slash is the whole test, with `//` excluded: a UNC path is spelled that way on Windows
/// too (`//server/share`, which `cygpath -w` would turn into `\\server\share` and back again). A
/// relative path is never translated - `cygpath` hands it back unchanged, so there is nothing to say
/// about it.
pub(crate) fn needs_shell_translation(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//")
}

/// The Windows spelling of what `cygpath` printed, or nothing when it printed nothing usable.
///
/// The first non-empty line is the answer: the tool prints a warning on stderr, but a wrapper that
/// merges the streams would put it here. A path handed back unchanged is not a translation - a
/// relative path comes back exactly as it went in - and neither is anything that is not a Windows
/// path, so both are refused rather than passed on as if they were an answer.
pub(crate) fn windows_form(stdout: &str) -> Option<String> {
    let line = stdout.lines().map(str::trim).find(|line| !line.is_empty())?;
    let is_windows = line.starts_with("\\\\")
        || matches!(line.as_bytes(), [drive, b':', ..] if drive.is_ascii_alphabetic());
    if !is_windows {
        return None;
    }
    // The pane spells Windows paths with forward slashes everywhere else (the OSC 7 parser's own
    // repair produces `C:/Users/x`), and one trailing separator is what `cygpath -w /` prints.
    let slashed = line.replace('\\', "/");
    let trimmed = slashed.trim_end_matches('/');
    Some(if trimmed.ends_with(':') { format!("{trimmed}/") } else { trimmed.to_string() })
}

/// Where `cygpath.exe` would be, for a bash out of a Git for Windows install.
///
/// The tool is installed beside the shell it belongs to, one level up from `bin`: an install keeps
/// bash in `Git\bin\bash.exe` and the POSIX tools in `Git\usr\bin\`, so the answer is
/// `Git\usr\bin\cygpath.exe` for both the `bin` and the `usr\bin` spelling of the shell. Candidates
/// are returned in the order they should be tried; whether one is really there is the caller's
/// question, because this is the part two tests can check without a disk.
pub(crate) fn cygpath_candidates(bash: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = bash.parent() {
        // A bash installed at `usr\bin` has the tool in its own directory.
        out.push(dir.join("cygpath.exe"));
        // A bash installed at `bin` has it in `usr\bin` beside its install root.
        if let Some(root) = dir.parent() {
            out.push(root.join("usr").join("bin").join("cygpath.exe"));
        }
    }
    out
}

/// The Windows spelling of one of the shell's paths, or nothing when the shell cannot say.
///
/// `None` is an ordinary answer, not a failure: a path that needs no translation, a machine without a
/// Git install, and a `cygpath` that refused the input all mean "the caller keeps the spelling it
/// had", which is what it did before this existed. An `Err` is reserved for the work not being able
/// to run at all.
fn translate(path: &str, shell: Option<&str>) -> Result<Option<String>, String> {
    if !needs_shell_translation(path) {
        return Ok(None);
    }
    let Some(bash) = msys_bash(shell) else {
        return Ok(None);
    };
    let Some(cygpath) = cygpath_candidates(&bash).into_iter().find(|at| at.is_file()) else {
        return Ok(None);
    };
    let mut cmd = std::process::Command::new(cygpath);
    // `--` so a path that begins with a dash is still the path: a translated path is used to open a
    // directory, and one mistake here is the wrong directory opened.
    cmd.arg("-w").arg("--").arg(path);
    crate::modules::proc::hide_console(&mut cmd);
    let out = cmd.output().map_err(|error| error.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(windows_form(&String::from_utf8_lossy(&out.stdout)))
}

/// The MSYS bash to ask: the one the pane is actually running, or the install Git for Windows is in.
///
/// The leaf's own shell comes first because that is the shell whose spelling is being translated - a
/// path is only in MSYS form because that shell said so. Anything else falls back to the install the
/// same way the shell list finds one.
#[cfg(windows)]
fn msys_bash(shell: Option<&str>) -> Option<PathBuf> {
    let named = shell
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|at| at.is_file())
        .filter(|at| {
            at.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("bash.exe"))
        });
    named.or_else(crate::modules::pty::shell_init::windows::git_bash_path)
}

/// Off Windows an MSYS path is just a path: there is no other spelling to ask about.
#[cfg(not(windows))]
fn msys_bash(_shell: Option<&str>) -> Option<PathBuf> {
    None
}

/// The Windows spelling of a path a POSIX shell reported.
///
/// `shell` is the shell the pane is running, when the front end knows it: the translator must be
/// asked through the same install that spelled the path, and a machine can have more than one.
#[tauri::command]
pub async fn translate_path(path: String, shell: Option<String>) -> Result<Option<String>, String> {
    blocking(move || translate(&path, shell.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_posix_spelling_is_asked_about() {
        assert!(needs_shell_translation("/tmp"));
        assert!(needs_shell_translation("/c/Users/x"));
        assert!(needs_shell_translation("/usr/bin"));
        // A Windows path, a UNC path and a relative path are not the shell's to explain.
        assert!(!needs_shell_translation("C:/Users/x"));
        assert!(!needs_shell_translation("c:\\Users\\x"));
        assert!(!needs_shell_translation("//server/share"));
        assert!(!needs_shell_translation("nonsense"));
        assert!(!needs_shell_translation(""));
    }

    #[test]
    fn the_tools_answer_is_read_as_a_windows_path() {
        // Measured on this machine: `/tmp` and `/` through `cygpath -w`, with the CRLF a Windows pipe
        // writes.
        assert_eq!(
            windows_form("C:\\Users\\cxj\\AppData\\Local\\Temp\r\n").as_deref(),
            Some("C:/Users/cxj/AppData/Local/Temp")
        );
        assert_eq!(
            windows_form("C:\\Program Files\\Git\\\r\n").as_deref(),
            Some("C:/Program Files/Git")
        );
        // The root keeps its separator: `C:` alone is not a place, `C:/` is.
        assert_eq!(windows_form("C:\\\r\n").as_deref(), Some("C:/"));
        assert_eq!(windows_form("\\\\server\\share\\x\n").as_deref(), Some("//server/share/x"));
    }

    #[test]
    fn an_answer_that_is_not_a_translation_is_refused() {
        // Measured: a relative path comes back exactly as it went in, so it is not an answer.
        assert_eq!(windows_form("nonsense\n"), None);
        assert_eq!(windows_form("/tmp\n"), None);
        assert_eq!(windows_form(""), None);
        assert_eq!(windows_form("\r\n"), None);
        // Only the first non-empty line is read, and it has to be the path: `cygpath` writes its
        // warnings to stderr, and a stream that got merged anyway must not have a path picked out of
        // a sentence about the path.
        assert_eq!(windows_form("cygpath: something to say\nC:\\Users\\x\n"), None);
        assert_eq!(
            windows_form("C:\\Users\\x\ncygpath: something to say\n").as_deref(),
            Some("C:/Users/x")
        );
    }

    #[test]
    fn the_translator_is_looked_for_beside_the_shell() {
        // Both spellings of the install find the tool Git for Windows actually ships, `usr\bin\cygpath.exe`:
        // measured here, there is no `cygpath.exe` in `Git\bin`.
        for bash in [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"] {
            let found = cygpath_candidates(Path::new(bash));
            assert!(
                found.contains(&PathBuf::from(r"C:\Program Files\Git\usr\bin\cygpath.exe")),
                "{bash} -> {found:?}"
            );
        }
    }

    #[test]
    fn a_path_that_needs_nothing_is_not_asked_about() {
        // The tool is never run for these, which is what `None` says: no disk, no shell, no process.
        assert_eq!(translate("C:/Users/x", None), Ok(None));
        assert_eq!(translate("//server/share", None), Ok(None));
        assert_eq!(translate("", None), Ok(None));
    }
}
