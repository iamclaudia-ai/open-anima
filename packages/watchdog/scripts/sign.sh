#!/bin/sh
# Sign the compiled watchdog.
#
# macOS charges Accessibility and Screen Recording to the watchdog, the top of
# the launchd -> watchdog -> agent-host -> tmux chain. An ad-hoc signature
# changes with every build, so each deploy silently revoked those grants. A
# Developer ID signature with a fixed identifier gives a designated requirement
# of team + identifier, which survives rebuilds and certificate renewals.
#
# Machines without a Developer ID identity (a headless server, say) fall back to ad-hoc.
set -e
[ "$(uname)" = Darwin ] || exit 0

bin="$1"
identifier="com.anima.watchdog"
identity="${ANIMA_SIGN_IDENTITY:-Developer ID Application}"

if security find-identity -v -p codesigning | grep -q "\"$identity"; then
  codesign --force --sign "$identity" --identifier "$identifier" --timestamp=none "$bin"
else
  echo "No \"$identity\" signing identity found; signing ad-hoc"
  codesign --force --sign - --identifier "$identifier" "$bin"
fi
