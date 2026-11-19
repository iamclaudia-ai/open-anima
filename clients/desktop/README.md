# Today.app

The Today board (`http://localhost:30086/today`) in its own window, so it can live on a second
monitor and come up with one keystroke. Tauri 2, macOS only.

Settings live in `~/.anima/desktop.json` (or `$ANIMA_DATA_DIR/desktop.json` when the app is
started with that variable, e.g. `ANIMA_DATA_DIR=… bun run dev`); quit and reopen after a change:

```json
{ "hotkey": "F19", "gatewayPort": 30086 }
```

- **Gateway port**: `gatewayPort` must match `gateway.port` in anima.json. The board loads from
  `http://localhost:<gatewayPort>/today`.
- **Hotkey F19** shows the board, or hides it when it's already in front. Change it with `hotkey`
  (`"Control+Alt+KeyT"`, global-shortcut syntax). Only ⌘ ⌥ ⌃ ⇧ work as modifiers (Carbon hotkeys: no `fn`). For a chord the app
  can't register, have a key remapper (e.g. Karabiner) send an unused key (F13–F20).
- **Log**: `logs/today-app.log` in the same folder says whether the hotkey registered and what each press
  decided (show or hide), since a GUI app's stderr goes nowhere.
- **Full screen** (View → Enter Full Screen, ⌃⌘F) puts the board in its own Space on a laptop.
- **Links open in the default browser.** Only `/today` and its sections load in the window; PRs,
  tickets, other sites and chat sessions go out (`src-tauri/src/links.rs`). WebKit silently drops plain
  clicks on `target="_blank"` links here, so the app injects a tiny click listener that gives such a
  link a named target first, which arrives as an ordinary navigation (`BLANK_LINKS_SCRIPT` in
  `lib.rs`). The page itself is unchanged.
- **Closing hides it.** The hotkey, the Dock icon or the tray brings it back; quit with ⌘Q or the tray.
- **Remembers where it was** for each monitor setup (`desktop-window-state.json`, same folder).
- **Waits for the gateway** before loading the board, so it can open at login (tray or app menu:
  Open at Login) and survives a gateway restart (View → Reload, ⌘R).
- The first launch asks for the gateway token (`anima token show`), since its web view keeps its own
  storage. It remembers it after that.

## The rule that keeps the wrapper swappable

The page never calls Tauri (`withGlobalTauri` is off, and there are no capabilities). Everything
the app does, it does to the page from outside. Replacing Tauri with Electron would change only
this folder.

## Build and install

Building needs, besides Bun:

- **Rust** with `cargo`, installed with [rustup](https://rustup.rs) (`rustc --version` to check).
- **Tauri's macOS prerequisites**: the Xcode Command Line Tools (`xcode-select --install`), or full Xcode. See
  <https://v2.tauri.app/start/prerequisites/>.

The Tauri CLI itself comes with `bun install` (`@tauri-apps/cli`). The first build compiles every Rust dependency,
so it is much slower than later ones.

```bash
cd clients/desktop
bun run test          # the link rules (cargo test)
bun run install-app   # build, sign, replace /Applications/Today.app, open it
```

`install-app` quits the running copy and replaces `/Applications/Today.app` (the old one goes to the Trash, or
to a temporary folder when there is no `trash` command). If the app already there has a different bundle
identifier (another project's Today.app, or an unrelated app named Today), it refuses before building and changes
nothing. `TODAY_APP_DIR=~/Applications bun run install-app` installs into another folder.

The app is signed ad-hoc (`signingIdentity: "-"` in `tauri.conf.json`), which runs fine on the
machine that built it. To sign with your own certificate, set `APPLE_SIGNING_IDENTITY`
(`APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" bun run install-app`); Tauri
uses it over the config. The bundle identifier is `dev.anima.today`.
