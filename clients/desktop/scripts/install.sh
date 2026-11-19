#!/usr/bin/env bash
# Build Today.app and install it in /Applications, replacing the copy there. Run from
# clients/desktop: `bun run install-app`.
#
# It only ever replaces its own app. The bundle id and app name come from
# src-tauri/tauri.conf.json (`identifier`, `productName`). If the install folder already
# holds an app of that name with a different bundle id (another Anima's Today.app, or an
# unrelated app called Today), it stops before building and changes nothing. The copy it
# does replace goes to the Trash (or, without a `trash` command, to a temporary folder).
#
# TODAY_APP_DIR installs somewhere else, e.g. TODAY_APP_DIR=~/Applications bun run install-app
#
# Signed ad-hoc by default (tauri.conf.json `signingIdentity: "-"`). To sign with your own
# certificate, set APPLE_SIGNING_IDENTITY, e.g.
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" bun run install-app
set -euo pipefail
cd "$(dirname "$0")/.."

conf="src-tauri/tauri.conf.json"
bundle_id="$(plutil -extract identifier raw -o - "$conf")"
app_name="$(plutil -extract productName raw -o - "$conf").app"
app_dir="${TODAY_APP_DIR:-/Applications}"
target="$app_dir/$app_name"

# Stop unless $target is free or is this app (same bundle id).
check_target() {
  if [[ ! -d "$app_dir" ]]; then
    echo "Install folder $app_dir does not exist." >&2
    exit 1
  fi
  [[ -e "$target" ]] || return 0
  local existing
  existing="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$target/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing" != "$bundle_id" ]]; then
    echo "Refusing to replace $target: its bundle id is '${existing:-unknown}', not '$bundle_id'." >&2
    echo "It is a different app, so nothing was changed. Move it yourself, or install this one" >&2
    echo "elsewhere: TODAY_APP_DIR=~/Applications bun run install-app" >&2
    exit 1
  fi
}

check_target

bunx tauri build --bundles app
built="src-tauri/target/release/bundle/macos/$app_name"
codesign --verify --strict "$built"

# The build takes minutes; check again in case the folder changed meanwhile.
check_target

# Quit the running copy so the new one takes the hotkey.
osascript -e "if application id \"$bundle_id\" is running then tell application id \"$bundle_id\" to quit" \
  2>/dev/null || true
sleep 1

if [[ -e "$target" ]]; then
  if command -v trash >/dev/null 2>&1; then
    trash "$target"
    echo "Moved the previous $app_name to the Trash"
  else
    backup="$(mktemp -d)"
    mv "$target" "$backup/"
    echo "Moved the previous $app_name to $backup"
  fi
fi
cp -R "$built" "$app_dir/"
open "$target"
echo "Installed $target"
