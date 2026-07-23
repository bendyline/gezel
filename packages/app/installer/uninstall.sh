#!/bin/bash
#
# Gezel macOS uninstaller. PKG doesn't ship an Apple-supported uninstall
# mechanism — the convention is to provide a script alongside the .app
# that an admin can run.
#
# What this removes:
#   - The launchd unit at /Library/LaunchDaemons/com.bendyline.gezeld.plist
#   - The _gezeld system user and group
#   - The Gezel.app bundle in /Applications
#
# What this preserves:
#   - User data at /Library/Application Support/Gezel/ (gezels, projects,
#     chats, memories). Pass --purge-data to delete this too.
#
# Usage:
#   sudo /Applications/Gezel.app/Contents/Resources/uninstall.sh
#   sudo /Applications/Gezel.app/Contents/Resources/uninstall.sh --purge-data
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "uninstall.sh must be run as root: sudo $0" >&2
  exit 1
fi

PURGE=0
if [ "${1:-}" = "--purge-data" ]; then
  PURGE=1
fi

DAEMON_LABEL="com.bendyline.gezeld"
PLIST="/Library/LaunchDaemons/${DAEMON_LABEL}.plist"
DATA_DIR="/Library/Application Support/Gezel"
APP_DIR="/Applications/Gezel.app"
DAEMON_USER="_gezeld"

echo "[gezel uninstall] stopping GezelService"
launchctl bootout "system/${DAEMON_LABEL}" 2>/dev/null || true

echo "[gezel uninstall] removing LaunchDaemon plist"
rm -f "$PLIST"

echo "[gezel uninstall] removing application bundle"
rm -rf "$APP_DIR"

echo "[gezel uninstall] removing ${DAEMON_USER} system user"
dscl . -delete "/Users/${DAEMON_USER}" 2>/dev/null || true
dscl . -delete "/Groups/${DAEMON_USER}" 2>/dev/null || true

if [ "$PURGE" -eq 1 ]; then
  echo "[gezel uninstall] PURGING user data at ${DATA_DIR}"
  rm -rf "$DATA_DIR"
else
  echo "[gezel uninstall] preserved user data at ${DATA_DIR}"
  echo "                  (pass --purge-data to remove)"
fi

echo "[gezel uninstall] done."
