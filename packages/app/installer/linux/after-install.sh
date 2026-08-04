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
SHARED_DIR="$DATA_DIR/shared"
ASSETS_DIR="$DATA_DIR/assets"
SERVICE_TREE="$DATA_DIR/service"
UNIT_SRC=/opt/Gezel/gezeld.service
UNIT_DST=/etc/systemd/system/gezeld.service
ELECTRON_EXE=/opt/Gezel/gezel
CHROME_SANDBOX=/opt/Gezel/chrome-sandbox
APPARMOR_PROFILE_SOURCE=/opt/Gezel/resources/apparmor-profile
APPARMOR_PROFILE_TARGET=/etc/apparmor.d/gezel
UNPACKED_DIR=/opt/Gezel/resources/app.asar.unpacked/dist
EXTRACT_CLI="$UNPACKED_DIR/extract-service-bundle.js"
MIGRATE_SHARED_CLI="$UNPACKED_DIR/migrate-legacy-shared.js"
BUNDLE_TARBALL="$UNPACKED_DIR/service-bundle.tar.gz"
BUNDLE_META="$UNPACKED_DIR/service-bundle.meta.json"

echo "[gezel after-install] starting"

# The package declares `acl` as a dependency. Default ACL inheritance is
# load-bearing for multi-user writes in the machine-shared product root.
if ! command -v setfacl >/dev/null 2>&1; then
  echo "[gezel after-install] ERROR: setfacl is required for safe shared-data permissions" >&2
  exit 1
fi

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

# Never commandeer a pre-existing human account. Native engine and download
# children must run in an isolated service identity, not with a person's file
# and credential access.
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
# is 0755 so user daemons can read only the metadata gezeld publishes.
assert_not_symlink "$DATA_DIR" "Gezel data directory"
assert_not_symlink "$DATA_DIR/runtime" "Gezel runtime directory"
assert_not_symlink "$ASSETS_DIR" "Gezel public asset directory"
assert_not_symlink "$ASSETS_DIR/models" "Gezel shared model directory"
assert_not_symlink "$DATA_DIR/logs" "Gezel logs directory"
assert_not_symlink "$SERVICE_TREE" "Gezel service tree"

if [ ! -f "$MIGRATE_SHARED_CLI" ]; then
  echo "[gezel after-install] ERROR: shared-data migration CLI is missing: $MIGRATE_SHARED_CLI" >&2
  exit 1
fi
assert_not_symlink "$SHARED_DIR" "Gezel machine-shared data directory"
echo "[gezel after-install] migrating legacy projects and gezels into $SHARED_DIR"
ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$MIGRATE_SHARED_CLI" \
  --source="$DATA_DIR" \
  --dest="$SHARED_DIR"
assert_not_symlink "$SHARED_DIR" "Gezel machine-shared data directory"
install -d -o "$GEZEL_USER" -g "$GEZEL_USER" -m 700 "$DATA_DIR"
install -d -o "$GEZEL_USER" -g "$GEZEL_USER" -m 700 "$DATA_DIR/runtime"
install -d -o "$GEZEL_USER" -g "$GEZEL_USER" -m 700 "$DATA_DIR/logs"
install -d -o "$GEZEL_USER" -g "$GEZEL_USER" -m 755 "$ASSETS_DIR/models"
assert_not_symlink "$DATA_DIR" "Gezel data directory"
assert_not_symlink "$DATA_DIR/runtime" "Gezel runtime directory"
assert_not_symlink "$ASSETS_DIR" "Gezel public asset directory"
assert_not_symlink "$ASSETS_DIR/models" "Gezel shared model directory"
assert_not_symlink "$DATA_DIR/logs" "Gezel logs directory"
assert_not_symlink "$SERVICE_TREE" "Gezel service tree"

# Upgrade migration: strip all group/other access and replace legacy owners.
# Do not dereference symlinks or cross into mounted filesystems.
find "$DATA_DIR" -xdev -exec chown --no-dereference "$GEZEL_USER:$GEZEL_USER" -- {} +
# Remove named/default POSIX ACLs when the platform provides setfacl. chmod
# alone can leave dormant named entries that regain access after a later mode
# change. On minimal systems without ACL tooling, the mode mask still denies
# all group/other access.
find "$DATA_DIR" -xdev ! -type l -exec setfacl -b -- {} +
find "$DATA_DIR" -xdev -type d -exec setfacl -k -- {} +
find "$DATA_DIR" -xdev -path "$SHARED_DIR" -prune -o ! -type l -exec chmod go-rwx {} +
chmod 711 "$DATA_DIR"
chmod 755 "$DATA_DIR/runtime"
chmod 700 "$DATA_DIR/logs"
if find "$ASSETS_DIR" -xdev -type l -print -quit | grep -q .; then
  echo "[gezel after-install] ERROR: shared asset store contains a symlink" >&2
  exit 1
fi
find "$ASSETS_DIR" -xdev -type d -exec chmod 755 {} +
find "$ASSETS_DIR" -xdev -type f -exec chmod 644 {} +

# The broker owns no product routes and never receives these paths. Interactive
# accounts collaborate through their own user daemons. Sticky/setgid roots and
# default ACLs keep newly-created nested content writable across accounts.
find "$SHARED_DIR" -xdev -exec chown --no-dereference root:root -- {} +
find "$SHARED_DIR" -xdev ! -type l -exec chmod a+rwX {} +
find "$SHARED_DIR" -xdev -type d -exec chmod 2777 {} +
chmod 3777 "$SHARED_DIR"
find "$SHARED_DIR" -xdev -type d -exec setfacl -m d:u::rwx,d:g::rwx,d:o::rwx,d:m::rwx -- {} +
# Defense in depth beyond systemd's InaccessiblePaths: the non-login broker
# identity cannot even traverse the shared root outside its service sandbox.
setfacl -m "u:$GEZEL_USER:---" "$SHARED_DIR"
chown root:root "$SHARED_DIR/.gezel-machine-shared-v1.json"
chmod 644 "$SHARED_DIR/.gezel-machine-shared-v1.json"

# Remove any root-equivalent token left by a pre-split release before runtime
# becomes readable. gezeld recreates it as a scoped first-party credential.
rm -f \
  "$DATA_DIR/runtime/auth-token" \
  "$DATA_DIR/runtime/web-ui-token" \
  "$DATA_DIR/runtime/port" \
  "$DATA_DIR/runtime/pid" \
  "$DATA_DIR/runtime/cert.pem" \
  "$DATA_DIR/runtime/cert-fingerprint" \
  "$DATA_DIR/runtime/service-role" \
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

# 3. Preserve electron-builder's standard Linux desktop integration. Supplying
# our own afterInstall hook replaces electron-builder's default hook entirely,
# so these responsibilities must live here too.
if command -v update-alternatives >/dev/null 2>&1; then
  # Remove an old direct symlink before registering the managed alternative.
  if [ -L /usr/bin/gezel ] &&
    [ -e /usr/bin/gezel ] &&
    [ "$(readlink /usr/bin/gezel)" != /etc/alternatives/gezel ]; then
    rm -f /usr/bin/gezel
  fi
  update-alternatives --install /usr/bin/gezel gezel "$ELECTRON_EXE" 100 ||
    ln -sf "$ELECTRON_EXE" /usr/bin/gezel
else
  ln -sf "$ELECTRON_EXE" /usr/bin/gezel
fi

# Chromium needs either working unprivileged user namespaces or its root-owned
# SUID helper. Ubuntu 24+ permits the namespace path only for applications with
# an AppArmor userns profile, which is installed immediately below.
if [ ! -f "$CHROME_SANDBOX" ] || [ -L "$CHROME_SANDBOX" ]; then
  echo "[gezel after-install] ERROR: Chromium sandbox helper is missing or unsafe: $CHROME_SANDBOX" >&2
  exit 1
fi
chown root:root "$CHROME_SANDBOX"
if [ -L /proc/self/ns/user ] &&
  command -v unshare >/dev/null 2>&1 &&
  unshare --user true; then
  chmod 0755 "$CHROME_SANDBOX"
else
  chmod 4755 "$CHROME_SANDBOX"
fi

# electron-builder ships this generated profile in resources/. Loading it
# grants only the user-namespace permission Chromium requires; the application
# otherwise remains unconfined. Older AppArmor versions that cannot parse the
# abi/4.0 profile do not enforce Ubuntu's userns restriction and safely skip it.
if command -v apparmor_status >/dev/null 2>&1 &&
  apparmor_status --enabled >/dev/null 2>&1; then
  if [ ! -f "$APPARMOR_PROFILE_SOURCE" ] || [ -L "$APPARMOR_PROFILE_SOURCE" ]; then
    echo "[gezel after-install] ERROR: AppArmor profile is missing or unsafe: $APPARMOR_PROFILE_SOURCE" >&2
    exit 1
  fi
  if [ -L "$APPARMOR_PROFILE_TARGET" ]; then
    echo "[gezel after-install] ERROR: AppArmor profile target is a symlink: $APPARMOR_PROFILE_TARGET" >&2
    exit 1
  fi
  if command -v apparmor_parser >/dev/null 2>&1 &&
    apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" >/dev/null 2>&1; then
    install -o root -g root -m 0644 "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Live profile updates are neither possible nor meaningful in a chroot.
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "[gezel after-install] AppArmor does not support the bundled userns profile; skipping it"
  fi
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi

# 4. Install the systemd unit (root:root 644, standard).
if [ ! -f "$UNIT_SRC" ]; then
  echo "[gezel after-install] ERROR: unit file missing at $UNIT_SRC" >&2
  exit 1
fi
install -m 644 "$UNIT_SRC" "$UNIT_DST"

# 5. Enable + start. Tolerate systems without systemctl (e.g. running
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
