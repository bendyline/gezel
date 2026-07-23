#!/bin/sh
#
# Gezel deb/rpm pre-remove hook. Tear down the systemd unit. Leaves the
# `gezel` system user and /var/lib/gezel/ data behind — a sysadmin can
# remove them manually if they want a clean wipe (mirrors how Postgres
# / Redis / etc. handle uninstall).
set -e

UNIT_DST=/etc/systemd/system/gezeld.service

echo "[gezel after-remove] starting"

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now gezeld.service 2>/dev/null || true
fi

rm -f "$UNIT_DST"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi

echo "[gezel after-remove] done. /var/lib/gezel and 'gezel' user preserved;"
echo "                     remove manually if desired:"
echo "                       sudo userdel gezel"
echo "                       sudo rm -rf /var/lib/gezel"
exit 0
