#!/bin/sh
#
# Gezel deb/rpm post-remove hook. Tear down the systemd unit only after a
# final package removal; package upgrades preserve the replacement's setup.
# Leaves the
# `gezel` system user and /var/lib/gezel/ data behind — a sysadmin can
# remove them manually if they want a clean wipe (mirrors how Postgres
# / Redis / etc. handle uninstall).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$(id -u)" -ne 0 ]; then
  echo "[gezel after-remove] ERROR: this package hook must run as root" >&2
  exit 1
fi

UNIT_DST=/etc/systemd/system/gezeld.service
ELECTRON_EXE=/opt/Gezel/gezel
COMMAND_LINK=/usr/bin/gezel
APPARMOR_PROFILE_TARGET=/etc/apparmor.d/gezel
MIME_DATABASE_DIR=/usr/share/mime
APPLICATIONS_DATABASE_DIR=/usr/share/applications
HICOLOR_THEME_DIR=/usr/share/icons/hicolor

echo "[gezel after-remove] starting"

# dpkg calls postrm with actions such as `upgrade` and `failed-upgrade`; RPM
# calls %postun with the number of package versions remaining. Destructive
# cleanup belongs only to a final removal. In particular, an old package's
# postrm must never disable the freshly-installed service during an upgrade.
is_final_removal() {
  action=${1:-}

  if [ "${DPKG_MAINTSCRIPT_NAME:-}" = postrm ]; then
    case "$action" in
      remove|purge|disappear) return 0 ;;
      *) return 1 ;;
    esac
  fi

  case "$action" in
    0|remove|purge|disappear) return 0 ;;
    *) return 1 ;;
  esac
}

if ! is_final_removal "${1:-}"; then
  echo "[gezel after-remove] package upgrade/rollback detected; preserving system integration"
  exit 0
fi

# The package payload containing gezel.desktop and gezel.png has already been
# removed when this hook runs. Rebuild the public indexes with a deliberately
# public umask so they forget Gezel without making unrelated desktop metadata
# root-only.
refresh_desktop_caches() (
  umask 022

  if command -v update-mime-database >/dev/null 2>&1; then
    if ! update-mime-database "$MIME_DATABASE_DIR"; then
      echo "[gezel after-remove] WARNING: could not refresh the shared MIME database" >&2
    fi
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    if ! update-desktop-database "$APPLICATIONS_DATABASE_DIR"; then
      echo "[gezel after-remove] WARNING: could not refresh the desktop database" >&2
    fi
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    if ! gtk-update-icon-cache -f -t "$HICOLOR_THEME_DIR"; then
      echo "[gezel after-remove] WARNING: could not refresh the hicolor icon cache" >&2
    fi
  fi

  return 0
)

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now gezeld.service 2>/dev/null || true
fi

rm -f "$UNIT_DST"

# Supplying a custom afterRemove hook also replaces electron-builder's default
# cleanup, so remove the desktop alternative and unload the AppArmor profile.
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove gezel "$ELECTRON_EXE" || true
fi
if [ -L "$COMMAND_LINK" ] && [ "$(readlink "$COMMAND_LINK" 2>/dev/null || true)" = "$ELECTRON_EXE" ]; then
  rm -f "$COMMAND_LINK"
fi

if [ -f "$APPARMOR_PROFILE_TARGET" ] && [ ! -L "$APPARMOR_PROFILE_TARGET" ]; then
  if command -v apparmor_status >/dev/null 2>&1 &&
    apparmor_status --enabled >/dev/null 2>&1 &&
    command -v apparmor_parser >/dev/null 2>&1 &&
    ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
    apparmor_parser --remove "$APPARMOR_PROFILE_TARGET" || true
  fi
  rm -f "$APPARMOR_PROFILE_TARGET"
fi

refresh_desktop_caches

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi

echo "[gezel after-remove] done. /var/lib/gezel and 'gezel' user preserved;"
echo "                     remove manually if desired:"
echo "                       sudo userdel gezel"
echo "                       sudo rm -rf /var/lib/gezel"
exit 0
