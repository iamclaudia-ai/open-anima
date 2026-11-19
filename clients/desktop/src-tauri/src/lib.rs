//! Today: the Today board in its own window, one hotkey away.
//!
//! The window shows the board (`http://localhost:<gatewayPort>/today`, port 30086 unless
//! `desktop.json` says otherwise, `settings.rs`) and nothing else. Every other link opens in
//! the default browser (`links.rs`). Closing the window hides it; the hotkey (default F19,
//! `settings.rs`) brings it back or hides it again. The window remembers where it was for each
//! monitor setup (`window_state.rs`).
//!
//! The page never calls Tauri (`withGlobalTauri` is off): everything here acts on it from
//! outside, so swapping this wrapper for Electron would change nothing on the board.

#[macro_use]
mod log;
mod links;
mod settings;
mod window_state;

use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use links::Route;
use window_state::WindowState;

const WINDOW: &str = "today";

type SharedState = Arc<Mutex<WindowState>>;

/// Check items shown in both the menu bar and the tray, kept in step.
struct Toggles {
    on_top: Vec<CheckMenuItem<Wry>>,
    login: Vec<CheckMenuItem<Wry>>,
}

/// Injected into every page the window loads (the board never knows).
///
/// WebKit drops a plain click on a `target="_blank"` link in this window: neither the
/// navigation nor the new-window handler hears of it (measured on wry 0.57.2, macOS 27;
/// ⌘-click and the context menu's Open Link do arrive, as navigations). A link with a named
/// target does arrive as a navigation, which `links::navigation` sends to the browser. So just
/// before the browser acts on a click, give a `_blank` link a name.
const BLANK_LINKS_SCRIPT: &str = r#"
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[target="_blank"]') : null;
  if (link) link.target = "today-outside";
}, true);
"#;

fn board_url() -> Url {
    Url::parse(&settings::get().board_url()).expect("the board URL is a valid URL")
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW)
}

fn open_outside(app: &AppHandle, url: &Url) {
    if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
        log!("couldn't open {url}: {err}");
    }
}

/// Load the board once the gateway answers. At login the app can start before the gateway, and
/// a reload during a gateway restart would otherwise leave WebKit's error page in the window.
fn load_board(app: &AppHandle) {
    let Some(window) = window(app) else { return };
    thread::spawn(move || {
        let addr: SocketAddr = settings::get().gateway_addr();
        while TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_err() {
            thread::sleep(Duration::from_secs(1));
        }
        if let Err(err) = window.navigate(board_url()) {
            log!("couldn't load the board: {err}");
        }
    });
}

fn show(app: &AppHandle) {
    let _ = app.show();
    if let Some(window) = window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Hide the whole app, so focus goes back to whatever the user was using before.
fn hide(app: &AppHandle) {
    let _ = app.hide();
}

/// Whether Today is the active app, asked of `NSApp` (main thread only). Two cheaper answers
/// are wrong here (measured): the window's `is_focused` stays false while the board is in front,
/// so the toggle only ever showed; and `NSRunningApplication.isActive` lags just after the app
/// comes forward, so the next press showed again instead of hiding.
fn app_is_active() -> bool {
    match objc2::MainThreadMarker::new() {
        Some(mtm) => objc2_app_kit::NSApplication::sharedApplication(mtm).isActive(),
        None => {
            log!("hotkey handler off the main thread; using NSRunningApplication");
            objc2_app_kit::NSRunningApplication::currentApplication().isActive()
        }
    }
}

/// The hotkey: bring the board to the front, or put it away when it already is.
fn toggle(app: &AppHandle) {
    let Some(w) = window(app) else { return };
    let (active, visible, minimized) = (
        app_is_active(),
        w.is_visible().unwrap_or(false),
        w.is_minimized().unwrap_or(false),
    );
    let in_front = active && visible && !minimized;
    log!(
        "hotkey: active={active} visible={visible} minimized={minimized} → {}",
        if in_front { "hide" } else { "show" }
    );
    if in_front {
        hide(app);
    } else {
        show(app);
    }
}

fn set_on_top(app: &AppHandle, on: bool) {
    if let Some(window) = window(app) {
        let _ = window.set_always_on_top(on);
    }
    let state = app.state::<SharedState>();
    let mut ws = state.lock().unwrap();
    ws.always_on_top = on;
    window_state::save(&ws);
    for item in &app.state::<Toggles>().on_top {
        let _ = item.set_checked(on);
    }
}

fn set_open_at_login(app: &AppHandle, on: bool) {
    let launcher = app.autolaunch();
    let result = if on {
        launcher.enable()
    } else {
        launcher.disable()
    };
    if let Err(err) = result {
        log!("couldn't change Open at Login: {err}");
    }
    let enabled = launcher.is_enabled().unwrap_or(false);
    for item in &app.state::<Toggles>().login {
        let _ = item.set_checked(enabled);
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "show" => show(app),
        "reload" => load_board(app),
        "on_top" => {
            let on = !app.state::<SharedState>().lock().unwrap().always_on_top;
            set_on_top(app, on);
        }
        "login" => {
            let on = !app.autolaunch().is_enabled().unwrap_or(false);
            set_open_at_login(app, on);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn build_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let board = board_url();
    let nav_app = app.clone();
    let new_window_app = app.clone();
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
        .title("Today")
        .inner_size(1100.0, 900.0)
        .min_inner_size(380.0, 500.0)
        .initialization_script(BLANK_LINKS_SCRIPT)
        .on_navigation(move |url| match links::navigation(url, &board) {
            Route::Stay => true,
            Route::Outside => {
                open_outside(&nav_app, url);
                false
            }
            Route::Block => false,
        })
        // A backstop for `window.open` and anything else that does ask for a window; plain
        // `_blank` clicks never get here (see BLANK_LINKS_SCRIPT).
        .on_new_window(move |url, _features| {
            if links::new_window(&url) == Route::Outside {
                open_outside(&new_window_app, &url);
            }
            NewWindowResponse::Deny
        })
        .build()
}

fn install_menus(app: &AppHandle, on_top: bool, open_at_login: bool) -> tauri::Result<()> {
    let check = |id: &str, label: &str, checked: bool| {
        CheckMenuItem::with_id(app, id, label, true, checked, None::<&str>)
    };
    let separator = || PredefinedMenuItem::separator(app);

    // macOS takes the first submenu as the application menu.
    let login_menubar = check("login", "Open at Login", open_at_login)?;
    let app_menu = Submenu::with_items(
        app,
        "Today",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &separator()?,
            &login_menubar,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
            &separator()?,
            // On a laptop the board can live in its own Space, a swipe away.
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let on_top_menubar = check("on_top", "Always on Top", on_top)?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &on_top_menubar,
            &separator()?,
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu],
    )?)?;
    app.on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));

    let on_top_tray = check("on_top", "Always on Top", on_top)?;
    let login_tray = check("login", "Open at Login", open_at_login)?;
    let tray_menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", "Show Today", true, None::<&str>)?,
            &MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?,
            &separator()?,
            &on_top_tray,
            &login_tray,
            &separator()?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("today")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Today")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        // No tray handler: menu events are app-wide, so `app.on_menu_event` already gets these.
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(Toggles {
        on_top: vec![on_top_menubar, on_top_tray],
        login: vec![login_menubar, login_tray],
    });
    Ok(())
}

fn register_hotkey(app: &AppHandle, wanted: &str) {
    let shortcut: Shortcut = wanted.parse().unwrap_or_else(|err| {
        log!(
            "hotkey {wanted:?} isn't valid ({err}); using {}",
            settings::DEFAULT_HOTKEY
        );
        settings::DEFAULT_HOTKEY
            .parse()
            .expect("the default hotkey parses")
    });
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle(app);
            }
        });
    match result {
        Ok(()) => log!("hotkey {wanted:?} registered"),
        Err(err) => log!("couldn't register the hotkey {wanted:?}: {err}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = settings::get().clone();
    let saved = window_state::load();
    let on_top = saved.always_on_top;

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage::<SharedState>(Arc::new(Mutex::new(saved.clone())))
        .setup(move |app| {
            let handle = app.handle();
            let window = build_window(handle)?;
            window_state::restore(&window, &saved);
            if on_top {
                let _ = window.set_always_on_top(true);
            }
            let open_at_login = handle.autolaunch().is_enabled().unwrap_or(false);
            install_menus(handle, on_top, open_at_login)?;
            register_hotkey(handle, &settings.hotkey);
            load_board(handle);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing puts the board away; the hotkey, the Dock or the tray brings it back.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                hide(window.app_handle());
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                // A minimized or full-screen frame isn't where the window lives.
                if !window.is_minimized().unwrap_or(false)
                    && !window.is_fullscreen().unwrap_or(false)
                {
                    let state = window.app_handle().state::<SharedState>();
                    window_state::remember(window, &mut state.lock().unwrap());
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Today");

    app.run(|app, event| {
        if let RunEvent::Reopen { .. } = event {
            show(app);
        }
    });
}
