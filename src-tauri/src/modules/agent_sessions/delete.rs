use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::modules::agent_sessions::{opencode, pi};

/// What the frontend may send: a tool name and an id. Paths are resolved on this
/// side from the tool's own store, never accepted from the caller.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTarget {
    pub tool: String,
    pub id: String,
    /// `None` is this machine; a distro name will mean that distro's store once
    /// the WSL side lands.
    #[serde(default)]
    pub distro: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub tool: String,
    pub id: String,
    pub deleted: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub deleted: usize,
    pub outcomes: Vec<DeleteOutcome>,
}

const MAX_ID_BYTES: usize = 128;

/// An id reaches a filesystem lookup and a process argument list, so only the
/// shape both tools actually use is let through. No escaping, no repair.
pub(crate) fn validate_session_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(format!("非法的会话 id：{id}"))
    }
}

/// Where each tool keeps its data. Taken as a parameter so the command layer can
/// be exercised on temp stores instead of the real ones.
pub(crate) struct Stores {
    pub(crate) opencode: Option<PathBuf>,
    pub(crate) pi: Option<PathBuf>,
}

impl Stores {
    pub(crate) fn default_paths() -> Self {
        Self {
            opencode: opencode::default_db_path(),
            pi: pi::default_root(),
        }
    }

    fn path_for(&self, tool: &str) -> Result<&Path, String> {
        match tool {
            opencode::TOOL => self
                .opencode
                .as_deref()
                .ok_or_else(|| "找不到 opencode 数据库的位置".to_string()),
            pi::TOOL => self
                .pi
                .as_deref()
                .ok_or_else(|| "找不到 pi 会话目录的位置".to_string()),
            other => Err(format!("不支持的会话工具：{other}")),
        }
    }
}

/// Deletes each target on its own, so one failure never hides the others, and
/// returns the per-target reasons for the UI to show.
pub(crate) fn delete_sessions(targets: &[SessionTarget]) -> DeleteReport {
    delete_targets(targets, &Stores::default_paths())
}

fn delete_targets(targets: &[SessionTarget], stores: &Stores) -> DeleteReport {
    let mut report = DeleteReport::default();
    for target in targets {
        let outcome = delete_one(target, stores);
        if outcome.deleted {
            report.deleted += 1;
        }
        report.outcomes.push(outcome);
    }
    report
}

fn delete_one(target: &SessionTarget, stores: &Stores) -> DeleteOutcome {
    let result = attempt(target, stores);
    // The tool's own word is not enough: only a re-read that no longer sees the
    // session counts as deleted.
    let gone = result.is_ok() && is_gone(target, stores);
    outcome(&target.tool, &target.id, result, gone)
}

fn outcome(tool: &str, id: &str, result: Result<(), String>, gone: bool) -> DeleteOutcome {
    let reason = match result {
        Ok(()) if !gone => Some("删除后仍能读到该会话，可能没有真正删除".to_string()),
        Ok(()) => None,
        Err(reason) => Some(reason),
    };
    DeleteOutcome {
        tool: tool.to_string(),
        id: id.to_string(),
        deleted: reason.is_none(),
        reason,
    }
}

fn attempt(target: &SessionTarget, stores: &Stores) -> Result<(), String> {
    if let Some(distro) = &target.distro {
        return Err(format!("WSL 会话的删除尚未实现（{distro}）"));
    }
    validate_session_id(&target.id)?;
    let path = stores.path_for(&target.tool)?;
    match target.tool.as_str() {
        opencode::TOOL => opencode::delete_at(path, &target.id),
        pi::TOOL => pi::delete_at(path, &target.id),
        other => Err(format!("不支持的会话工具：{other}")),
    }
}

fn is_gone(target: &SessionTarget, stores: &Stores) -> bool {
    let Ok(path) = stores.path_for(&target.tool) else {
        return false;
    };
    let exists = match target.tool.as_str() {
        opencode::TOOL => opencode::exists_at(path, &target.id),
        pi::TOOL => pi::exists_at(path, &target.id),
        _ => Ok(true),
    };
    // A store that cannot be read counts as "not gone": never a false success.
    matches!(exists, Ok(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every store in these tests is a temp directory: a target that reached the
    /// real store would delete real sessions.
    fn target(tool: &str, id: &str) -> SessionTarget {
        SessionTarget {
            tool: tool.to_string(),
            id: id.to_string(),
            distro: None,
        }
    }

    fn pi_stores(root: &Path) -> Stores {
        Stores {
            opencode: None,
            pi: Some(root.to_path_buf()),
        }
    }

    fn write_session(root: &Path, stem: &str, id: &str) -> PathBuf {
        let dir = root.join("--F--x--");
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join(format!("{stem}.jsonl"));
        std::fs::write(
            &path,
            format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"cwd\":\"F:\\\\x\"}}\n"),
        )
        .expect("write");
        path
    }

    fn reason(outcome: &DeleteOutcome) -> String {
        outcome.reason.clone().unwrap_or_default()
    }

    #[test]
    fn accepts_the_two_real_id_shapes() {
        assert!(validate_session_id("ses_0be16f2c8ffeFnRn5CVN2D7Xay").is_ok());
        assert!(validate_session_id("01a147ad-023f-71ff-b404-bb337dea4b63").is_ok());
    }

    #[test]
    fn rejects_anything_that_could_escape_a_path() {
        for id in [
            "",
            "..",
            "../x",
            "..\\x",
            "a/b",
            "a\\b",
            "C:\\Windows\\system32",
            "/etc/passwd",
            "a b",
            "a\"b",
            "a'b",
            "a;b",
            "ses_x$()",
            "ses_x\n",
            "ses_x\0",
        ] {
            assert!(validate_session_id(id).is_err(), "should reject {id:?}");
        }
    }

    #[test]
    fn rejects_an_overlong_id() {
        assert!(validate_session_id(&"a".repeat(129)).is_err());
        assert!(validate_session_id(&"a".repeat(128)).is_ok());
    }

    #[test]
    fn an_invalid_id_is_reported_and_nothing_is_deleted() {
        let root = tempfile::tempdir().expect("temp dir");
        let file = write_session(root.path(), "2026-10-17T02-00-00-000Z_keep", "keep");
        let report = delete_targets(&[target("pi", "../keep")], &pi_stores(root.path()));
        assert_eq!(report.deleted, 0);
        assert_eq!(report.outcomes.len(), 1);
        assert!(reason(&report.outcomes[0]).contains("非法"), "{:?}", report.outcomes);
        assert!(file.exists(), "a rejected target must not touch the store");
    }

    #[test]
    fn an_unsupported_tool_is_reported() {
        let root = tempfile::tempdir().expect("temp dir");
        let report = delete_targets(&[target("cursor", "whatever")], &pi_stores(root.path()));
        assert_eq!(report.deleted, 0);
        assert!(reason(&report.outcomes[0]).contains("不支持"), "{:?}", report.outcomes);
    }

    #[test]
    fn a_wsl_target_is_reported_as_not_implemented_yet() {
        let root = tempfile::tempdir().expect("temp dir");
        let file = write_session(root.path(), "2026-10-17T02-00-00-000Z_keep", "keep");
        let mut t = target("pi", "keep");
        t.distro = Some("Ubuntu-22.04".to_string());
        let report = delete_targets(&[t], &pi_stores(root.path()));
        assert_eq!(report.deleted, 0);
        assert!(reason(&report.outcomes[0]).contains("WSL"), "{:?}", report.outcomes);
        assert!(file.exists());
    }

    #[test]
    fn deletes_a_pi_session_and_counts_it() {
        let root = tempfile::tempdir().expect("temp dir");
        let doomed = write_session(root.path(), "2026-10-17T02-00-00-000Z_doomed", "doomed");
        let kept = write_session(root.path(), "2026-10-17T03-00-00-000Z_kept", "kept");
        let report = delete_targets(&[target("pi", "doomed")], &pi_stores(root.path()));
        assert_eq!(report.deleted, 1);
        assert!(report.outcomes[0].deleted);
        assert!(report.outcomes[0].reason.is_none());
        assert!(!doomed.exists());
        assert!(kept.exists());
    }

    #[test]
    fn one_failure_does_not_stop_the_other_targets() {
        let root = tempfile::tempdir().expect("temp dir");
        let doomed = write_session(root.path(), "2026-10-17T02-00-00-000Z_doomed", "doomed");
        let report = delete_targets(
            &[target("pi", "../nope"), target("pi", "doomed")],
            &pi_stores(root.path()),
        );
        assert_eq!(report.deleted, 1);
        assert_eq!(report.outcomes.len(), 2);
        assert!(!report.outcomes[0].deleted);
        assert!(report.outcomes[1].deleted);
        assert!(!doomed.exists());
    }

    #[test]
    fn a_store_that_still_has_the_session_is_not_reported_as_a_success() {
        let ok_but_present = outcome("pi", "ses_1", Ok(()), false);
        assert!(!ok_but_present.deleted);
        assert!(reason(&ok_but_present).contains("仍能读到"));

        let ok_and_gone = outcome("pi", "ses_1", Ok(()), true);
        assert!(ok_and_gone.deleted);
        assert!(ok_and_gone.reason.is_none());

        let failed = outcome("pi", "ses_1", Err("boom".to_string()), true);
        assert!(!failed.deleted);
        assert_eq!(reason(&failed), "boom");
    }

    #[test]
    fn a_broken_opencode_store_is_reported_per_target() {
        let dir = tempfile::tempdir().expect("temp dir");
        let db = dir.path().join("opencode.db");
        rusqlite::Connection::open(&db).expect("create an empty database");
        let stores = Stores {
            opencode: Some(db),
            pi: None,
        };
        let report = delete_targets(&[target("opencode", "ses_probe")], &stores);
        assert_eq!(report.deleted, 0);
        assert!(reason(&report.outcomes[0]).contains("session"), "{:?}", report.outcomes);
    }
}