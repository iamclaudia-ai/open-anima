//! Settings the user can change by hand: `desktop.json` in Anima's data folder
//! (`~/.anima/desktop.json`, or `$ANIMA_DATA_DIR/desktop.json` when the app is started with it).
//!
//! ```json
//! { "hotkey": "F19", "gatewayPort": 30086 }
//! ```
//!
//! The hotkey uses the global-shortcut plugin's syntax: modifiers (`Control`, `Alt`/`Option`,
//! `Shift`, `Command`/`Super`, `CommandOrControl`) joined with `+` to a key code (`KeyT`, `Digit1`,
//! `F5`, `Space`). `gatewayPort` is the gateway's `gateway.port` from anima.json. Quit and reopen
//! the app after changing either.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Deserialize;

/// F19: no laptop keyboard has it and nothing else claims it; a key remapper
/// (e.g. Karabiner) can map any chord to it.
pub const DEFAULT_HOTKEY: &str = "F19";
/// Anima's default gateway port (`gateway.port` in anima.json).
pub const DEFAULT_GATEWAY_PORT: u16 = 30086;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Shows the board, or hides it when it's already in front.
    pub hotkey: String,
    /// The local gateway that serves the board.
    pub gateway_port: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.into(),
            gateway_port: DEFAULT_GATEWAY_PORT,
        }
    }
}

impl Settings {
    /// The board's address: `http://localhost:<gatewayPort>/today`.
    pub fn board_url(&self) -> String {
        format!("http://localhost:{}/today", self.gateway_port)
    }

    /// Where the gateway listens; the window waits for it before loading the board.
    pub fn gateway_addr(&self) -> std::net::SocketAddr {
        std::net::SocketAddr::from(([127, 0, 0, 1], self.gateway_port))
    }
}

/// Anima's data folder: `$ANIMA_DATA_DIR`, else `~/.anima`. The app keeps its settings, window
/// state and log here.
pub fn anima_dir() -> PathBuf {
    match std::env::var_os("ANIMA_DATA_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".anima"),
    }
}

fn path() -> PathBuf {
    anima_dir().join("desktop.json")
}

/// The saved settings, or the defaults when the file is missing or unreadable.
pub fn load() -> Settings {
    fs::read_to_string(path())
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

/// The settings, read once per launch.
pub fn get() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(load)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_the_standard_gateway() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.hotkey, DEFAULT_HOTKEY);
        assert_eq!(s.board_url(), "http://localhost:30086/today");
        assert_eq!(s.gateway_addr().to_string(), "127.0.0.1:30086");
    }

    #[test]
    fn follows_a_configured_gateway_port() {
        let s: Settings = serde_json::from_str(r#"{ "gatewayPort": 31086 }"#).unwrap();
        assert_eq!(s.board_url(), "http://localhost:31086/today");
        assert_eq!(s.gateway_addr().to_string(), "127.0.0.1:31086");
    }
}
