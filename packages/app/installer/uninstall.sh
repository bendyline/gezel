#!/bin/bash
#
# Gezel macOS uninstaller. PKG doesn't ship an Apple-supported uninstall
# mechanism — the convention is to provide a script alongside the .app
# that an admin can run.
#
# A normal uninstall removes:
#   - The launchd unit at /Library/LaunchDaemons/com.bendyline.gezeld.plist
#   - The _gezeld system user and group
#   - The Gezel.app bundle in /Applications
#
# A normal uninstall preserves all data, including:
#   - Machine broker/engine data at /Library/Application Support/Gezel
#     (downloaded shared models, runtime state, logs, caches, and service state)
#   - Machine-shared projects and gezel definitions at /Users/Shared/Gezel
#   - Every account's private projects, gezels, chats, credentials, and settings
#     under that account's ~/.gezel
#
# --purge-data additionally removes ONLY the machine broker/engine directory at
# /Library/Application Support/Gezel. This includes downloaded shared models.
# It deliberately does NOT remove /Users/Shared/Gezel or any account's
# ~/.gezel. Removing shared projects/gezels requires a separate, explicitly
# machine-wide administration operation.
#
# Usage:
#   sudo /Applications/Gezel.app/Contents/Resources/uninstall.sh
#   sudo /Applications/Gezel.app/Contents/Resources/uninstall.sh --purge-data
set -euo pipefail

DAEMON_LABEL="com.bendyline.gezeld"
PLIST="/Library/LaunchDaemons/${DAEMON_LABEL}.plist"
DATA_DIR="/Library/Application Support/Gezel"
MACHINE_SHARED_DIR="/Users/Shared/Gezel"
APP_DIR="/Applications/Gezel.app"
DAEMON_USER="_gezeld"

usage() {
  cat <<EOF
Usage:
  sudo $0
  sudo $0 --purge-data

Default uninstall:
  Removes the Gezel application, LaunchDaemon, and _gezeld service account.
  Preserves downloaded shared models, machine-shared projects/gezels, and all
  per-user Gezel data so a later reinstall can use them.

--purge-data:
  Also removes machine broker/engine data at:
    ${DATA_DIR}
  This includes downloaded shared models, runtime credentials/certificates,
  logs, caches, and extracted service state.

Always preserved:
  Machine-shared projects and gezel definitions:
    ${MACHINE_SHARED_DIR}
  Every account's private projects, gezels, chats, credentials, and settings:
    ~/.gezel (for each account)

This script never removes the two locations listed under "Always preserved."
EOF
}

PURGE=0
case "${1:-}" in
  "") ;;
  --purge-data) PURGE=1 ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    usage >&2
    exit 64
    ;;
esac

if [ "$EUID" -ne 0 ]; then
  echo "uninstall.sh must be run as root: sudo $0" >&2
  echo "Run '$0 --help' for a precise description of preserved and purged data." >&2
  exit 1
fi

echo "[gezel uninstall] stopping GezelService"
launchctl bootout "system/${DAEMON_LABEL}" 2>/dev/null || true

# `launchctl disable` persists independently of the plist and app payload.
# Clear any installer safety quarantine so a later reinstall starts from the
# platform default instead of inheriting a stale "Service is disabled" error.
echo "[gezel uninstall] clearing persistent launchd override"
launchctl enable "system/${DAEMON_LABEL}" 2>/dev/null || true

echo "[gezel uninstall] removing LaunchDaemon plist"
rm -f "$PLIST"

echo "[gezel uninstall] removing application bundle"
rm -rf "$APP_DIR"

echo "[gezel uninstall] removing ${DAEMON_USER} system user"
dscl . -delete "/Users/${DAEMON_USER}" 2>/dev/null || true
dscl . -delete "/Groups/${DAEMON_USER}" 2>/dev/null || true

if [ "$PURGE" -eq 1 ]; then
  echo "[gezel uninstall] PURGING machine broker/engine data at ${DATA_DIR}"
  echo "                  (includes downloaded shared models)"
  rm -rf "$DATA_DIR"
else
  echo "[gezel uninstall] preserved machine broker/engine data at ${DATA_DIR}"
  echo "                  (includes downloaded shared models; pass --purge-data to remove)"
fi

echo "[gezel uninstall] preserved machine-shared projects and gezels at ${MACHINE_SHARED_DIR}"
echo "[gezel uninstall] preserved every account's private Gezel data under ~/.gezel"

echo "[gezel uninstall] done."
