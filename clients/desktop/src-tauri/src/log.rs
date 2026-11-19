//! A few lines about what the app did, in `<data folder>/logs/today-app.log` (`settings::anima_dir`,
//! default `~/.anima`): a GUI app's stderr goes
//! nowhere, and "the hotkey does nothing" needs to say whether it registered.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

/// Past this size the log starts over, so it never grows without bound.
const MAX_BYTES: u64 = 1_000_000;

pub fn write(message: &str) {
    let dir = crate::settings::anima_dir().join("logs");
    let path = dir.join("today-app.log");
    let _ = fs::create_dir_all(&dir);
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::remove_file(&path);
    }
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{secs} {message}");
    }
}

/// `log!("…", args)`: format and write one line.
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::log::write(&format!($($arg)*)) };
}
