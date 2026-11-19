//! Where the Today window sits, per display setup.
//!
//! Saved as `desktop-window-state.json` in Anima's data folder (`~/.anima` by default), keyed by how many monitors are attached, so the
//! board goes back to the second monitor whenever that monitor is there and lands somewhere
//! visible when it isn't.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, Window};

/// Position and size for a specific display configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayState {
    /// Number of monitors in this configuration
    monitor_count: usize,
    /// Window position
    x: i32,
    y: i32,
    /// Window size
    width: u32,
    height: u32,
    /// Which monitor the window was on (index)
    monitor_index: usize,
}

/// Persisted window state across launches
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowState {
    /// Per-display-config positions (keyed by monitor count as string)
    pub displays: std::collections::HashMap<String, DisplayState>,
    /// Last active monitor count
    pub last_monitor_count: usize,
    /// Whether always-on-top was enabled
    pub always_on_top: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            displays: std::collections::HashMap::new(),
            last_monitor_count: 0,
            // A board on a second monitor shouldn't cover whatever is in front of it.
            always_on_top: false,
        }
    }
}

fn state_path() -> PathBuf {
    crate::settings::anima_dir().join("desktop-window-state.json")
}

pub fn load() -> WindowState {
    let path = state_path();
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        WindowState::default()
    }
}

pub fn save(state: &WindowState) {
    let path = state_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = fs::write(&path, json);
    }
}

/// Capture current window state (uses Window from on_window_event)
pub fn capture(window: &Window) -> Option<DisplayState> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let monitors = window.available_monitors().ok()?;
    let monitor_count = monitors.len().max(1);

    // Determine which monitor the window center falls on
    let center_x = pos.x + (size.width as i32 / 2);
    let center_y = pos.y + (size.height as i32 / 2);
    let mut monitor_index = 0;
    for (i, monitor) in monitors.iter().enumerate() {
        let mpos = monitor.position();
        let msize = monitor.size();
        if center_x >= mpos.x
            && center_x < mpos.x + msize.width as i32
            && center_y >= mpos.y
            && center_y < mpos.y + msize.height as i32
        {
            monitor_index = i;
            break;
        }
    }

    Some(DisplayState {
        monitor_count,
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        monitor_index,
    })
}

/// Get the number of available monitors
fn get_monitor_count(window: &WebviewWindow) -> usize {
    window
        .available_monitors()
        .map(|m| m.len().max(1))
        .unwrap_or(1)
}

/// Restore window to saved position for current display configuration
pub fn restore(window: &WebviewWindow, state: &WindowState) {
    let monitor_count = get_monitor_count(window);
    let key = monitor_count.to_string();

    if let Some(display_state) = state.displays.get(&key) {
        // Verify the saved position is still valid (monitor might have been removed)
        let position_valid = if let Ok(monitors) = window.available_monitors() {
            let target_idx = display_state
                .monitor_index
                .min(monitors.len().saturating_sub(1));
            if let Some(monitor) = monitors.get(target_idx) {
                let mpos = monitor.position();
                let msize = monitor.size();
                display_state.x >= mpos.x - display_state.width as i32
                    && display_state.x < mpos.x + msize.width as i32
                    && display_state.y >= mpos.y - display_state.height as i32
                    && display_state.y < mpos.y + msize.height as i32
            } else {
                false
            }
        } else {
            false
        };

        if position_valid {
            let _ = window.set_position(PhysicalPosition::new(display_state.x, display_state.y));
            let _ = window.set_size(PhysicalSize::new(display_state.width, display_state.height));
        }
    }
}

/// Record where `window` is now and save it.
pub fn remember(window: &Window, state: &mut WindowState) {
    if let Some(ds) = capture(window) {
        state.last_monitor_count = ds.monitor_count;
        state.displays.insert(ds.monitor_count.to_string(), ds);
        save(state);
    }
}
