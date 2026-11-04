//! Starting a drag out of the window, so a file can leave for the desktop.
//!
//! The explorer's own drag is a pointer drag: it moves a ghost element and, on release, names a
//! folder inside the explorer. That is all it can do - there is no operating-system drag session
//! behind it, so dragging a file onto the desktop produced nothing at all there, which is exactly
//! what was reported: a file could be dragged around inside the list and never out of it.
//!
//! This is the other half. Once the pointer leaves the explorer while a file is held, the front end
//! calls here and the platform takes the drag over: Explorer, Finder or whatever is underneath
//! receives a real drop with real paths, and decides for itself what dropping them means.
//!
//! `drag::start_drag` does not return until the user drops or cancels, and it must run on the
//! platform's main thread. So it is handed to that thread and this returns at once: waiting for it
//! would hold one IPC request open for the whole gesture, and running it here would freeze the
//! window it is dragging out of.

use tauri::WebviewWindow;

/// Paths a drag may carry, so one gesture cannot be made to name a whole disk.
const MAX_PATHS: usize = 4_096;

/// Hand a drag to the operating system.
///
/// `paths` come from the front end and are checked here too: the platform resolves them itself, and
/// a path that no longer exists would show as an empty drop target. Anything that fails the check
/// refuses the whole drag rather than silently dragging some of what was asked for.
#[tauri::command]
pub async fn fs_start_drag(window: WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to drag".into());
    }
    if paths.len() > MAX_PATHS {
        return Err(format!("too many paths to drag: {}", paths.len()));
    }
    let mut items = Vec::with_capacity(paths.len());
    for path in paths {
        let path = std::path::PathBuf::from(&path);
        let canonical = std::fs::canonicalize(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        items.push(canonical);
    }
    let preview = items
        .first()
        .cloned()
        .ok_or_else(|| "nothing to drag".to_string())?;

    // The drag runs on the main thread until the user lets go; this returns before that.
    // Cloned first: `run_on_main_thread` borrows the window it is called on, and the drag needs the
    // same handle from inside the closure.
    let main = window.clone();
    window
        .run_on_main_thread(move || {
            let started = start_drag_now(&main, items, preview);
            if let Err(error) = started {
                log::warn!("fs_start_drag: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

/// The platform's own drag, called on the main thread.
///
/// Split out so the error is one place: the drag is reported through the platform's callback, which
/// has nobody left to answer to once this function has returned.
fn start_drag_now(
    window: &WebviewWindow,
    items: Vec<std::path::PathBuf>,
    preview: std::path::PathBuf,
) -> Result<(), String> {
    drag::start_drag(
        window,
        drag::DragItem::Files(items),
        drag::Image::File(preview),
        |_result, _position| {},
        drag::Options::default(),
    )
    .map_err(|error| error.to_string())
}
