#!/bin/sh
#
# Gezel deb/rpm pre-remove hook. Tear down the systemd unit. Leaves the
# `gezel` system user and /var/lib/gezel/ data behind — a sysadmin can
# remove them manually if they want a clean wipe (mirrors how Postgres
# / Redis / etc. handle uninstall).
set -e

UNIT_DST=/etc/systemd/system/gezeld.service
ELECTRON_EXE=/opt/Gezel/gezel
APPARMOR_PROFILE_TARGET=/etc/apparmor.d/gezel

echo "[gezel after-remove] starting"

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now gezeld.service 2>/dev/null || true
fi

rm -f "$UNIT_DST"

# Supplying a custom afterRemove hook also replaces electron-builder's default
# cleanup, so remove the desktop alternative and unload the AppArmor profile.
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove gezel "$ELECTRON_EXE" || true
elif [ -L /usr/bin/gezel ] && [ "$(readlink /usr/bin/gezel)" = "$ELECTRON_EXE" ]; then
  rm -f /usr/bin/gezel
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

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi

echo "[gezel after-remove] done. /var/lib/gezel and 'gezel' user preserved;"
echo "                     remove manually if desired:"
echo "                       sudo userdel gezel"
echo "                       sudo rm -rf /var/lib/gezel"
exit 0
