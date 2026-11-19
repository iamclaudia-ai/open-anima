//! Which links stay in the Today window and which go to the default browser.
//!
//! The window shows only the board. Everything else (PRs, tickets, Slack, chat sessions) opens in
//! the browser, so the board never navigates away. The page knows nothing about this: the wrapper
//! decides from outside, by intercepting navigations and new-window requests, which keeps the
//! page a plain web page that works the same in a browser tab, Tauri or Electron.

use tauri::Url;

/// What to do with a URL the window is about to load.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// Load it here: the board itself, or the wrapper's own loading page.
    Stay,
    /// Open it in the default browser instead.
    Outside,
    /// Load it nowhere (`javascript:`, `data:`, `blob:` and the like).
    Block,
}

/// Where a navigation of the window goes.
pub fn navigation(url: &Url, board: &Url) -> Route {
    match url.scheme() {
        // The bundled loading page (`tauri://localhost/…`) and the blank page WebKit starts on.
        "tauri" | "about" => Route::Stay,
        "http" | "https" if on_board(url, board) => Route::Stay,
        "http" | "https" | "mailto" => Route::Outside,
        _ => Route::Block,
    }
}

/// Where a request for a new window (`target="_blank"`, `window.open`) goes: never a new
/// window, so a web link opens in the browser, even one to the board.
pub fn new_window(url: &Url) -> Route {
    match url.scheme() {
        "http" | "https" | "mailto" => Route::Outside,
        _ => Route::Block,
    }
}

/// The board's own pages: same origin, and its path or one below it (`/today/reviews`).
fn on_board(url: &Url, board: &Url) -> bool {
    if url.origin() != board.origin() {
        return false;
    }
    let base = board.path().trim_end_matches('/');
    let path = url.path();
    path == base || path.starts_with(&format!("{base}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn board() -> Url {
        url("http://localhost:30086/today")
    }

    #[test]
    fn the_board_and_its_sections_stay() {
        assert_eq!(
            navigation(&url("http://localhost:30086/today"), &board()),
            Route::Stay
        );
        assert_eq!(
            navigation(&url("http://localhost:30086/today/"), &board()),
            Route::Stay
        );
        assert_eq!(
            navigation(
                &url("http://localhost:30086/today/reviews?x=1#top"),
                &board()
            ),
            Route::Stay
        );
    }

    #[test]
    fn the_loading_page_stays() {
        assert_eq!(
            navigation(&url("tauri://localhost/index.html"), &board()),
            Route::Stay
        );
        assert_eq!(navigation(&url("about:blank"), &board()), Route::Stay);
    }

    #[test]
    fn other_pages_of_the_gateway_go_to_the_browser() {
        for other in [
            "http://localhost:30086/chat/ws_1/ses_2",
            "http://localhost:30086/",
            "http://localhost:30086/todayish",
            "http://localhost:30087/today",
            "https://localhost:30086/today",
        ] {
            assert_eq!(navigation(&url(other), &board()), Route::Outside, "{other}");
        }
    }

    #[test]
    fn the_rest_of_the_web_goes_to_the_browser() {
        for other in [
            "https://github.com/acme/app/pull/42",
            "https://linear.app/acme/issue/ABC-1",
            "https://acme.slack.com/archives/C1/p2",
            "mailto:someone@example.com",
        ] {
            assert_eq!(navigation(&url(other), &board()), Route::Outside, "{other}");
        }
    }

    #[test]
    fn script_and_data_urls_go_nowhere() {
        for other in [
            "javascript:alert(1)",
            "data:text/html,hi",
            "file:///etc/hosts",
        ] {
            assert_eq!(navigation(&url(other), &board()), Route::Block, "{other}");
            assert_eq!(new_window(&url(other)), Route::Block, "{other}");
        }
    }

    #[test]
    fn new_windows_always_open_in_the_browser() {
        assert_eq!(
            new_window(&url("https://github.com/x/y/pull/1")),
            Route::Outside
        );
        assert_eq!(
            new_window(&url("http://localhost:30086/today")),
            Route::Outside
        );
        assert_eq!(
            new_window(&url("http://localhost:30086/chat/a/b")),
            Route::Outside
        );
    }
}
