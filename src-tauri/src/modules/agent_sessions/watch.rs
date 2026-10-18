//! Watches the two session stores and tells the frontend when they change.
//!
//! The session list used to load once and then only change when someone pressed
//! Refresh, so a session started in a terminal did not appear until the user
//! went looking for it. The stores already announce themselves: opencode writes
//! `opencode.db` (plus its `-wal` and `-shm` siblings) and pi writes `.jsonl`
//! files. Watching those paths beats polling: it costs nothing while idle and
//! reports a change as soon as it lands.
//!
//! Events are coalesced. A single sqlite commit touches three files, and a
//! running agent rewrites its jsonl constantly, so each raw event only resets a
//! short timer and the frontend hears a single "something changed" per burst.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// Emitted with no payload: the frontend re-reads the list when it hears it.
pub const CHANGED_EVENT: &str = "verta://agent-sessions-changed";

/// Quiet period before reporting. Long enough to fold one sqlite commit and its
/// WAL siblings into a single event, short enough to feel immediate.
const SETTLE: Duration = Duration::from_millis(400);

/// Where each tool keeps its session data. A missing directory is fine: the tool
/// may not be installed, and the watcher simply has less to watch.
fn watch_targets() -> Vec<(PathBuf, RecursiveMode)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    vec![
        // The database file itself: a commit rewrites it and its WAL.
        (home.join(".local/share/opencode"), RecursiveMode::NonRecursive),
        // One directory per project, so this one is recursive.
        (home.join(".pi/agent/sessions"), RecursiveMode::Recursive),
    ]
}

/// Keeps the watcher alive for the life of the app. Dropping it stops watching,
/// so the handle is stored in app state rather than returned.
pub struct SessionsWatcher {
    _watcher: RecommendedWatcher,
}

/// Whether a raw event is worth waking the frontend for.
///
/// Reads are ignored: the webview and the CLI both read these files, and a read
/// changes nothing. Everything else counts, because sqlite's commit pattern on
/// each platform differs enough that filtering by kind would drop real writes.
fn is_interesting(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

/// Debounce shared between the notify thread and the timer it spawns.
type Pending = Arc<Mutex<Option<std::thread::JoinHandle<()>>>>;

fn schedule_emit(app: AppHandle, pending: Pending) {
    // A previous timer is still waiting: let it run, it will emit for this burst
    // too. Restarting it would delay the report while an agent keeps writing.
    // The guard is dropped before the thread starts so the thread can take its
    // own lock without the borrow outliving this scope.
    let already_pending = match pending.lock() {
        Ok(slot) => slot.is_some(),
        Err(_) => return,
    };
    if already_pending {
        return;
    }
    let shared = Arc::clone(&pending);
    let handle = std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        // Clearing first means a change that arrives while we are emitting
        // schedules a fresh report instead of being swallowed.
        if let Ok(mut slot) = shared.lock() {
            *slot = None;
        }
        let _ = app.emit(CHANGED_EVENT, ());
    });
    if let Ok(mut slot) = pending.lock() {
        *slot = Some(handle);
    }
}

/// Starts watching. Failure is reported, not fatal: the session list still works
/// with a manual Refresh, so a machine where the paths cannot be watched should
/// not lose the feature entirely.
pub fn start(app: AppHandle) -> Result<SessionsWatcher, String> {
    let pending: Pending = Arc::new(Mutex::new(None));
    let sink_app = app.clone();
    let sink_pending = Arc::clone(&pending);

    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            let Ok(event) = result else { return };
            if !is_interesting(&event.kind) {
                return;
            }
            schedule_emit(sink_app.clone(), Arc::clone(&sink_pending));
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    let mut watched = 0usize;
    for (path, mode) in watch_targets() {
        if !Path::new(&path).exists() {
            continue;
        }
        // One unwatchable path must not stop the others.
        if watcher.watch(&path, mode).is_ok() {
            watched += 1;
        }
    }
    if watched == 0 {
        return Err("没有找到任何会话存储目录".into());
    }
    log::info!("agent session watch started for {watched} path(s)");
    Ok(SessionsWatcher { _watcher: watcher })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_do_not_wake_the_frontend() {
        // Both the webview and the CLI read these files constantly; a read
        // changes nothing, so reporting it would refresh the list for no reason.
        assert!(!is_interesting(&EventKind::Access(
            notify::event::AccessKind::Read
        )));
    }

    #[test]
    fn writes_and_creates_count() {
        assert!(is_interesting(&EventKind::Modify(
            notify::event::ModifyKind::Any
        )));
        assert!(is_interesting(&EventKind::Create(
            notify::event::CreateKind::File
        )));
        assert!(is_interesting(&EventKind::Remove(
            notify::event::RemoveKind::File
        )));
    }

    #[test]
    fn watches_the_database_and_the_session_tree() {
        // The database is watched non-recursively: its WAL and SHM siblings sit
        // beside it, so a commit is seen without descending into the log folder.
        // The pi sessions live one directory per project, so that one recurses.
        let targets = watch_targets();
        assert_eq!(targets.len(), 2);
        let paths: Vec<String> = targets
            .iter()
            .map(|(path, _)| path.to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(paths[0].ends_with(".local/share/opencode"), "{paths:?}");
        assert!(paths[1].ends_with(".pi/agent/sessions"), "{paths:?}");
        assert!(matches!(targets[0].1, RecursiveMode::NonRecursive));
        assert!(matches!(targets[1].1, RecursiveMode::Recursive));
    }
}
