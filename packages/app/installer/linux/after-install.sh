#!/bin/sh
#
# Gezel deb/rpm post-install hook. Runs as root after the package's
# files have been laid down at /opt/Gezel/. Sets up the gezel system
# user, system-scope data dir, and the systemd unit.
#
# Idempotent: re-runs (e.g. on upgrade) detect existing user / unit
# and only do the missing work.
set -e
# Private-by-default state for both this migration and any helper it spawns.
# systemd applies the same mask to future daemon writes.
umask 077

GEZEL_USER=gezel
DATA_DIR=/var/lib/gezel
SERVICE_TREE="$DATA_DIR/service"
UNIT_SRC=/opt/Gezel/gezeld.service
UNIT_DST=/etc/systemd/system/gezeld.service
ELECTRON_EXE=/opt/Gezel/gezel
UNPACKED_DIR=/opt/Gezel/resources/app.asar.unpacked/dist
EXTRACT_CLI="$UNPACKED_DIR/extract-service-bundle.js"
BUNDLE_TARBALL="$UNPACKED_DIR/service-bundle.tar.gz"
BUNDLE_META="$UNPACKED_DIR/service-bundle.meta.json"

echo "[gezel after-install] starting"

assert_not_symlink() {
  path=$1
  description=$2
  if [ -L "$path" ]; then
    echo "[gezel after-install] ERROR: $description is a symlink: $path" >&2
    exit 1
  fi
}

abort_bad_service_identity() {
  echo "[gezel after-install] ERROR: refusing to use '$GEZEL_USER' as the daemon identity: $1" >&2
  # A prior package may already have installed/enabled the unit. Quarantine it
  # before aborting so the desktop falls back to its per-user daemon instead
  # of continuing to run arbitrary-command APIs as an unexpected human user.
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now gezeld.service >/dev/null 2>&1 || true
  fi
  exit 1
}

# 1. Create gezel system user/group if missing. --system picks a UID
# below 1000 (the conventional system-account range on most distros).
if ! getent passwd "$GEZEL_USER" >/dev/null 2>&1; then
  echo "[gezel after-install] creating $GEZEL_USER system user"
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "$GEZEL_USER"
fi

# Never commandeer a pre-existing human account. The HTTP UI includes a real
# terminal, so running under an interactive user's UID would hand that user's
# files and credentials to every authorized machine-daemon client.
passwd_entry=$(getent passwd "$GEZEL_USER" 2>/dev/null || true)
group_entry=$(getent group "$GEZEL_USER" 2>/dev/null || true)
if [ -z "$passwd_entry" ] || [ -z "$group_entry" ]; then
  abort_bad_service_identity "the dedicated user or matching group is missing"
fi

old_ifs=$IFS
IFS=: read -r account_name _ account_uid account_gid _ account_home account_shell <<EOF
$passwd_entry
EOF
IFS=: read -r group_name _ group_gid group_members <<EOF
$group_entry
EOF
IFS=$old_ifs

for numeric_id in "$account_uid" "$account_gid" "$group_gid"; do
  case "$numeric_id" in
    ''|*[!0-9]*) abort_bad_service_identity "UID/GID metadata is not numeric" ;;
  esac
done

uid_min=$(awk '$1 == "UID_MIN" && $2 ~ /^[0-9]+$/ { print $2; exit }' /etc/login.defs 2>/dev/null || true)
case "$uid_min" in
  ''|*[!0-9]*) uid_min=1000 ;;
esac
uid_count=$(getent passwd | awk -F: -v id="$account_uid" '$3 == id { n++ } END { print n + 0 }')
gid_count=$(getent group | awk -F: -v id="$group_gid" '$3 == id { n++ } END { print n + 0 }')

if [ "$account_name" != "$GEZEL_USER" ] || [ "$group_name" != "$GEZEL_USER" ]; then
  abort_bad_service_identity "name resolution did not return the dedicated account and group"
fi
if [ "$account_uid" -ge "$uid_min" ] || [ "$group_gid" -ge "$uid_min" ]; then
  abort_bad_service_identity "UID/GID is in the interactive-user range (UID_MIN=$uid_min)"
fi
if [ "$account_gid" -ne "$group_gid" ] || [ "$uid_count" -ne 1 ] || [ "$gid_count" -ne 1 ]; then
  abort_bad_service_identity "UID/GID is shared or the primary group does not match"
fi
case "$account_shell" in
  */nologin|*/false) ;;
  *) abort_bad_service_identity "login shell is interactive ($account_shell)" ;;
esac
if [ -z "$account_home" ] || { [ -d "$account_home" ] && [ "$account_home" != "$DATA_DIR" ]; }; then
  abort_bad_service_identity "account has a usable home directory ($account_home)"
fi
if password_status=$(LC_ALL=C passwd -S "$GEZEL_USER" 2>/dev/null); then
  password_state=$(printf '%s\n' "$password_status" | awk '{ print $2 }')
  case "$password_state" in
    L|LK) ;;
    *) abort_bad_service_identity "account password is not locked" ;;
  esac
fi

# Stop the old daemon before migrating modes or replacing its executable tree.
# Otherwise it can recreate a legacy-readable file while the upgrade runs.
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop gezeld.service 2>/dev/null || true
  service_still_active() {
    active_state=$(systemctl is-active gezeld.service 2>/dev/null || true)
    case "$active_state" in
      active|activating|reloading|deactivating) return 0 ;;
      *) return 1 ;;
    esac
  }
  stop_wait=0
  while service_still_active; do
    stop_wait=$((stop_wait + 1))
    if [ "$stop_wait" -ge 30 ]; then
      echo "[gezel after-install] ERROR: gezeld.service remained active after stop; refusing live state migration" >&2
      exit 1
    fi
    sleep 1
  done
fi

# 2. Private system state with a narrow runtime discovery exception. The 0711
# parent permits traversal to a known path but not directory listing; runtime
# is 0755 so desktop clients can read only the metadata gezeld publishes.
assert_not_symlink "$DATA_DIR" "Gezel data directory"
assert_not_symlink "$DATA_DIR/runtime" "Gezel runtime directory"
assert_not_symlink "$DATA_DIR/logs" "Gezel logs directory"
assert_not_symlink "$SERVICE_TREE" "Gezel service tree"
install -d -o "$GEZEL_USER" -g "$GEZEL_USER" -m 700 "$DATA_DIR"
install -d -o "$GEZEL_USER" -g "$GEZEL_USER" -m 700 "$DATA_DIR/runtime"
install -d -o "$GEZEL_USER" -g "$GEZEL_USER" -m 700 "$DATA_DIR/logs"
assert_not_symlink "$DATA_DIR" "Gezel data directory"
assert_not_symlink "$DATA_DIR/runtime" "Gezel runtime directory"
assert_not_symlink "$DATA_DIR/logs" "Gezel logs directory"
assert_not_symlink "$SERVICE_TREE" "Gezel service tree"

# Upgrade migration: strip all group/other access and replace legacy owners.
# Do not dereference symlinks or cross into mounted filesystems.
find "$DATA_DIR" -xdev -exec chown --no-dereference "$GEZEL_USER:$GEZEL_USER" -- {} +
# Remove named/default POSIX ACLs when the platform provides setfacl. chmod
# alone can leave dormant named entries that regain access after a later mode
# change. On minimal systems without ACL tooling, the mode mask still denies
# all group/other access.
if command -v setfacl >/dev/null 2>&1; then
  find "$DATA_DIR" -xdev ! -type l -exec setfacl -b -- {} +
  find "$DATA_DIR" -xdev -type d -exec setfacl -k -- {} +
fi
find "$DATA_DIR" -xdev ! -type l -exec chmod go-rwx {} +
chmod 711 "$DATA_DIR"
chmod 755 "$DATA_DIR/runtime"
chmod 700 "$DATA_DIR/logs"

# Remove any root-equivalent token left by a pre-split release before runtime
# becomes readable. gezeld recreates it as a scoped first-party credential.
rm -f \
  "$DATA_DIR/runtime/auth-token" \
  "$DATA_DIR/runtime/web-ui-token" \
  "$DATA_DIR/runtime/port" \
  "$DATA_DIR/runtime/pid" \
  "$DATA_DIR/runtime/cert.pem" \
  "$DATA_DIR/runtime/cert-fingerprint" \
  "$DATA_DIR/runtime/lock"

# 2b. Extract the shipped service bundle into $SERVICE_TREE. Runs through
# the bundled Electron exe in Node mode (ELECTRON_RUN_AS_NODE=1) so we
# don't need a system Node at install time. --force populates the tree
# even if a previous partial install left files behind.
echo "[gezel after-install] extracting service bundle"
if [ ! -f "$BUNDLE_TARBALL" ] || [ ! -f "$EXTRACT_CLI" ]; then
  echo "[gezel after-install] ERROR: shipped bundle missing (tarball=$BUNDLE_TARBALL cli=$EXTRACT_CLI)" >&2
  exit 1
fi
ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$EXTRACT_CLI" \
  --tarball="$BUNDLE_TARBALL" \
  --meta="$BUNDLE_META" \
  --dest="$SERVICE_TREE" \
  --force
find "$SERVICE_TREE" -xdev -exec chown --no-dereference "$GEZEL_USER:$GEZEL_USER" -- {} +
find "$SERVICE_TREE" -xdev ! -type l -exec chmod go-rwx {} +

# 3. Install the systemd unit (root:root 644, standard).
if [ ! -f "$UNIT_SRC" ]; then
  echo "[gezel after-install] ERROR: unit file missing at $UNIT_SRC" >&2
  exit 1
fi
install -m 644 "$UNIT_SRC" "$UNIT_DST"

# 4. Enable + start. Tolerate systems without systemctl (e.g. running
# inside a chroot during package builds) — the install still succeeds
# and the service starts on first reboot under systemd.
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable gezeld.service
  systemctl restart gezeld.service
else
  echo "[gezel after-install] systemctl not found; service will start on next boot"
fi

echo "[gezel after-install] done"
exit 0
