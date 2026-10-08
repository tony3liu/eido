//! Session-owned application focus for window-addressed background input.
//! This never changes the real front process or its key window. Keep the
//! target's local key window between click and keyboard calls; re-activating
//! on every key can reset an application's focused field.
use std::{collections::HashMap, sync::{Mutex, OnceLock}, time::Duration};
use crate::{apps, ax::bindings::focused_window_id_of_pid};

struct OwnedFocus {
    session: String,
    window: u32,
    previous: Option<u32>,
}
fn owners() -> &'static Mutex<HashMap<i32, OwnedFocus>> {
    static OWNERS: OnceLock<Mutex<HashMap<i32, OwnedFocus>>> = OnceLock::new();
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn application_active(pid: i32) -> bool {
    use crate::ax::bindings::{AXUIElementCreateApplication, copy_bool_attr};
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() { return false; }
        let active = copy_bool_attr(app, "AXFrontmost") == Some(true);
        core_foundation::base::CFRelease(app as _);
        active
    }
}

pub(crate) fn prepare(pid: i32, window: u32, session: &str) -> anyhow::Result<bool> {
    let mut entries = owners().lock().unwrap_or_else(|e| e.into_inner());
    if cua_driver_core::session::is_session_ended(session) {
        anyhow::bail!("the desktop session has ended");
    }
    if entries.get(&pid).is_some_and(|entry| entry.session != session) {
        anyhow::bail!("another desktop session owns this application focus; end that session before switching targets");
    }
    let previous = focused_window_id_of_pid(pid);
    // AXFocusedWindow may retain the last window after deactivation. It is
    // usable for keyboard routing only while the application is locally active.
    if previous == Some(window) && application_active(pid) {
        if let Some(entry) = entries.get_mut(&pid) {
            entry.session = session.to_owned();
            entry.window = window;
        }
        return Ok(false);
    }
    // Register ownership before posting: a failed request may have partially
    // focused the target and still needs session cleanup.
    let entry = entries.entry(pid).or_insert_with(|| OwnedFocus {
        session: session.to_owned(), window, previous: if application_active(pid) { previous } else { None },
    });
    entry.session = session.to_owned();
    entry.window = window;
    if !super::skylight::activate_without_raise(pid, window) {
        anyhow::bail!("native focus record is unavailable for the exact window");
    }
    // AppKit processes the active record before the routed mouse event makes
    // the addressed window key. Keyboard tools re-prove AXFocusedWindow after
    // the click; do not assume the active record alone selects a key window.
    std::thread::sleep(Duration::from_millis(50));
    Ok(true)
}

pub(crate) fn finish(session: &str) {
    let mut entries = owners().lock().unwrap_or_else(|e| e.into_inner());
    let targets: Vec<_> = entries.iter().filter(|(_, f)| f.session == session).map(|(pid, _)| *pid).collect();
    for pid in targets {
        let Some(focus) = entries.remove(&pid) else { continue; };
        // A later user activation or sibling selection owns its new focus.
        if apps::frontmost_pid() == Some(pid) || focused_window_id_of_pid(pid).is_some_and(|window| window != focus.window) { continue; }
        if let Some(previous) = focus.previous {
            super::skylight::post_background_focus(pid, previous, true);
        } else {
            super::skylight::post_background_focus(pid, focus.window, false);
        }
    }
}
