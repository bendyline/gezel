#!/bin/sh
#
# Gezel deb/rpm post-install hook. Runs as root after the package's
# files have been laid down at /opt/Gezel/. Sets up the gezel system
# user, system-scope data dir, and the systemd unit.
#
# Idempotent: re-runs (e.g. on upgrade) detect existing user / unit
# and only do the missing work.
set -eu
# Package managers normally provide a trusted root PATH, but maintainer hooks
# are also easy to invoke by hand while diagnosing a failed install. Never let
# an inherited user-controlled PATH choose commands that this root script runs.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$(id -u)" -ne 0 ]; then
  echo "[gezel after-install] ERROR: this package hook must run as root" >&2
  exit 1
fi

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
COMMAND_LINK=/usr/bin/gezel
ALTERNATIVES_LINK=/etc/alternatives/gezel
CHROME_SANDBOX=/opt/Gezel/chrome-sandbox
APPARMOR_PROFILE_SOURCE=/opt/Gezel/resources/apparmor-profile
APPARMOR_PROFILE_TARGET=/etc/apparmor.d/gezel
UNPACKED_DIR=/opt/Gezel/resources/app.asar.unpacked/dist
EXTRACT_CLI="$UNPACKED_DIR/extract-service-bundle.js"
MIGRATE_SHARED_CLI="$UNPACKED_DIR/migrate-legacy-shared.js"
BUNDLE_TARBALL="$UNPACKED_DIR/service-bundle.tar.gz"
BUNDLE_META="$UNPACKED_DIR/service-bundle.meta.json"
MIME_DATABASE_DIR=/usr/share/mime
APPLICATIONS_DATABASE_DIR=/usr/share/applications
HICOLOR_THEME_DIR=/usr/share/icons/hicolor

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

if [ ! -f "$UNIT_SRC" ] || [ -L "$UNIT_SRC" ]; then
  echo "[gezel after-install] ERROR: unit file is missing or unsafe: $UNIT_SRC" >&2
  exit 1
fi
assert_not_symlink "$UNIT_DST" "Gezel systemd unit target"

# Desktop integration is public operating-system state. Keep it in a subshell
# so the installer's private umask cannot leak into caches read by desktop
# sessions. A v1.26211.23 install rebuilt the MIME databases under umask 077,
# leaving them root-only; rerunning this function during an upgrade repairs
# those files without weakening Gezel's private state under /var/lib/gezel.
refresh_desktop_caches() (
  umask 022

  if command -v update-mime-database >/dev/null 2>&1; then
    if ! update-mime-database "$MIME_DATABASE_DIR"; then
      echo "[gezel after-install] WARNING: could not refresh the shared MIME database" >&2
    fi
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    if ! update-desktop-database "$APPLICATIONS_DATABASE_DIR"; then
      echo "[gezel after-install] WARNING: could not refresh the desktop database" >&2
    fi
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    if ! gtk-update-icon-cache -f -t "$HICOLOR_THEME_DIR"; then
      echo "[gezel after-install] WARNING: could not refresh the hicolor icon cache" >&2
    fi
  fi

  return 0
)

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

# Every root pass below over a tree the service account can write is safe only
# while nothing runs as that account. Such a pass resolves each path when it
# acts on it, so a live process could swap a checked entry for a link to a
# system file between the check and the chown/chmod — the account parses
# untrusted model files, so it is the one to assume compromised. Stopping the
# unit ends its cgroup; this also ends anything that escaped it.
service_account_pids() {
  for status_file in /proc/[0-9]*/status; do
    fields=$(awk '$1 == "State:" { state = $2 } $1 == "Uid:" { uids = $2 " " $3 " " $4 " " $5 } END { print state, uids }' "$status_file" 2>/dev/null) || continue
    # shellcheck disable=SC2086
    set -- $fields
    [ "$#" -ge 2 ] || continue
    case $1 in Z | X) continue ;; esac
    shift
    for id in "$@"; do
      if [ "$id" = "$account_uid" ]; then
        pid=${status_file#/proc/}
        echo "${pid%/status}"
        break
      fi
    done
  done
}

stop_service_account_processes() {
  stop_attempt=0
  while :; do
    account_pids=$(service_account_pids)
    [ -z "$account_pids" ] && return 0
    stop_attempt=$((stop_attempt + 1))
    if [ "$stop_attempt" -gt 10 ]; then
      echo "[gezel after-install] ERROR: processes still run as $GEZEL_USER ($(echo $account_pids)); refusing to repair files that account can change" >&2
      exit 1
    fi
    # shellcheck disable=SC2086
    kill -KILL $account_pids 2>/dev/null || true
    sleep 1
  done
}

stop_service_account_processes

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
# The migration moves private product data into this directory and the
# publishing step below trusts what root placed there, so it must be one root
# created. Every release that made it left it root-owned; anything else was
# prepared by another account and is refused rather than adopted.
if [ ! -e "$SHARED_DIR" ]; then
  mkdir -p -m 700 -- "$SHARED_DIR"
fi
assert_not_symlink "$SHARED_DIR" "Gezel machine-shared data directory"
if [ ! -d "$SHARED_DIR" ] || [ "$(stat -c %u -- "$SHARED_DIR")" != 0 ]; then
  echo "[gezel after-install] ERROR: $SHARED_DIR is not a root-owned directory; refusing to migrate into or publish it" >&2
  exit 1
fi
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
#
# These passes run as root over a tree the service account owns. With that
# account's processes gone (above), nothing moves entries while they run; what
# remains is anything it left behind. A symlink is never followed and never
# given a mode or ACL. A regular file with more than one link is left exactly as
# it is: it may be a hard link to a file that account does not own, and a chown
# or chmod through that name would change the linked system file.
#
# $SERVICE_TREE and its staging/backup siblings are pruned. Step 2b replaces
# that family wholesale and publishes it with root's ownership, so walking its
# ~33k files here would only re-own root's code to the service account moments
# before deleting it. $SHARED_DIR is pruned because it is not this account's
# state; it is published separately below.
private_state_find() {
  find "$DATA_DIR" -xdev \
    \( -path "$SHARED_DIR" -o -path "$SERVICE_TREE" -o -path "$SERVICE_TREE.previous" -o -path "$SERVICE_TREE.staging-*" \) -prune -o \
    \( -type f -links +1 \) -prune -o \
    "$@"
}

harden_private_state() {
  private_state_find -exec chown --no-dereference "$GEZEL_USER:$GEZEL_USER" -- {} +
  # Remove named/default POSIX ACLs when the platform provides setfacl. chmod
  # alone can leave dormant named entries that regain access after a later mode
  # change. On minimal systems without ACL tooling, the mode mask still denies
  # all group/other access.
  private_state_find ! -type l -exec setfacl -b -- {} +
  private_state_find -type d -exec setfacl -k -- {} +
  private_state_find ! -type l -exec chmod go-rwx {} +
  chmod 711 "$DATA_DIR"
  chmod 755 "$DATA_DIR/runtime"
  chmod 700 "$DATA_DIR/logs"
  if find "$ASSETS_DIR" -xdev -type l -print -quit | grep -q .; then
    echo "[gezel after-install] ERROR: shared asset store contains a symlink" >&2
    exit 1
  fi
  find "$ASSETS_DIR" -xdev -type d -exec chmod 755 {} +
  find "$ASSETS_DIR" -xdev -type f -links 1 -exec chmod 644 {} +
}

harden_private_state

# The broker owns no product routes and never receives these paths. Interactive
# accounts collaborate through their own user daemons. Sticky/setgid roots and
# default ACLs keep newly-created nested content writable across accounts.
#
# Root never walks this collaborative tree. Every local account can rename
# anything inside a scope directory, so a root pass over it — chown, chmod or
# setfacl by path, `find -exec` included — could be steered through a swapped-in
# symlink or hard link onto a system file (a world-writable /etc/shadow, say).
# Nested directories stay setgid and non-sticky on purpose: collaborating
# accounts replace each other's files. Content they create needs no repair; it
# inherits the setgid bit and the default ACLs below when it is created.
#
# Root touches only the root itself and the root-owned scope directories and
# marker directly inside its sticky top level — entries no other account can
# move — plus entities the migration has just placed, via publish_migrated_entity.
SHARED_DEFAULT_ACL=d:u::rwx,d:g::rwx,d:o::rwx,d:m::rwx

# A migrated entity arrives private: owned by the service account (moved from
# its home) or by root (copied across filesystems), with no group/other access.
# Nothing but root can reach inside until it is published, so its subtree can
# be walked by path — provided the walk is anchored to the directory rather
# than to its name, which any local account can rename. The subshell's `cd`
# pins the directory; everything after it is relative to that directory, and
# access opens only with the final chmod of `.`. Published entities (open, or
# owned by anyone else) are never walked again.
publish_migrated_entity() (
  scope_dir=$1
  name=$2
  case $name in
    '' | [!A-Za-z0-9@]* | *[!A-Za-z0-9@._-]*) exit 0 ;;
  esac
  cd -P -- "$scope_dir/$name" 2>/dev/null || exit 0
  [ "$(pwd -P)" = "$shared_physical/${scope_dir##*/}/$name" ] || exit 0
  owner_mode=$(stat -c '%u %a' .) || exit 0
  # shellcheck disable=SC2086
  set -- $owner_mode
  case $1 in 0 | "$account_uid") ;; *) exit 0 ;; esac
  case $2 in *00) ;; *) exit 0 ;; esac
  echo "[gezel after-install] publishing migrated shared entity ${scope_dir##*/}/$name"
  if find . -xdev -type f -links +1 -print -quit | grep -q .; then
    echo "[gezel after-install] WARNING: hard-linked files in ${scope_dir##*/}/$name stay private" >&2
  fi
  find . -xdev -mindepth 1 \( -type f -links +1 \) -prune -o \
    -exec chown --no-dereference root:root -- {} + \
    ! -type l -exec setfacl -b -- {} + \
    \( -type d -exec setfacl -m "$SHARED_DEFAULT_ACL" -- {} + -exec chmod 2777 {} + \
      -o -exec chmod a+rwX,ug-s {} + \)
  chown root:root .
  setfacl -b .
  setfacl -m "$SHARED_DEFAULT_ACL" .
  chmod 2777 .
)

publish_shared_data() {
  shared_physical=$(cd -P -- "$SHARED_DIR" && pwd -P)
  chown root:root -- "$SHARED_DIR"
  setfacl -b -- "$SHARED_DIR"
  chmod 3777 "$SHARED_DIR"
  setfacl -m "$SHARED_DEFAULT_ACL" -- "$SHARED_DIR"
  # Defense in depth beyond systemd's InaccessiblePaths: the non-login broker
  # identity cannot even traverse the shared root outside its service sandbox.
  setfacl -m "u:$GEZEL_USER:---" "$SHARED_DIR"
  for scope in projects gezels; do
    scope_dir="$SHARED_DIR/$scope"
    if [ ! -e "$scope_dir" ] && [ ! -L "$scope_dir" ]; then
      continue
    fi
    if [ -L "$scope_dir" ] || [ ! -d "$scope_dir" ] || [ "$(stat -c %u -- "$scope_dir")" != 0 ]; then
      echo "[gezel after-install] WARNING: leaving $scope_dir unchanged: it is not a root-owned directory" >&2
      continue
    fi
    setfacl -b -- "$scope_dir"
    chmod 2777 "$scope_dir"
    setfacl -m "$SHARED_DEFAULT_ACL" -- "$scope_dir"
    for entity in "$scope_dir"/*; do
      if [ -e "$entity" ] || [ -L "$entity" ]; then
        publish_migrated_entity "$scope_dir" "${entity##*/}"
      fi
    done
  done
  shared_marker="$SHARED_DIR/.gezel-machine-shared-v1.json"
  if [ -L "$shared_marker" ] || [ ! -f "$shared_marker" ] ||
    [ "$(stat -c '%u %h' -- "$shared_marker")" != "0 1" ]; then
    echo "[gezel after-install] ERROR: $shared_marker is not a root-owned regular file" >&2
    exit 1
  fi
  chown root:root -- "$shared_marker"
  chmod 644 -- "$shared_marker"
}

publish_shared_data

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
# don't need a system Node at install time. --force keeps this hook
# authoritative: a partial previous install, a content-drifted tree, or a
# deliberate downgrade all get replaced. It no longer re-unpacks a tree that
# already carries this bundle's sha.
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
# Readable, not private — one traversal, both fixups.
#
# This tree is the only thing under $DATA_DIR that is not the daemon's private
# state: it is product code, the exact bytes of the world-readable tarball in
# /opt that produced it. Publishing it lets each account's user daemon execute
# this copy instead of unpacking a byte-identical second one into its own home,
# which is the difference between one ~33k-file extraction per machine and one
# per account (see supervisor/shared-service-tree.ts). $DATA_DIR stays 0711, so
# reaching it still requires knowing the path — the directory is not listable.
#
# `go=u-w` grants group/other exactly what the owner has, minus write: 0755
# stays 0755, 0644 stays 0644, executables keep their exec bits. Write access
# stays root's alone, which is the property that matters. Every account's
# daemon executes this tree, so it must not belong to the service account
# either: that account parses untrusted model files, and a tree it owned was
# one it could rewrite under all of them. The supervisor refuses to adopt a
# tree root does not own, and gezeld.service mounts it read-only. The
# extractor already created it as root in a private staging directory, and
# nothing else runs as the service account now, so this pass is on a tree no
# one else can change.
publish_service_tree() {
  find "$SERVICE_TREE" -xdev \
    -exec chown --no-dereference root:root -- {} + \
    ! -type l -exec setfacl -b -- {} + \
    -exec chmod go=u-w {} +
}

publish_service_tree

# 3. Preserve electron-builder's standard Linux desktop integration. Supplying
# our own afterInstall hook replaces electron-builder's default hook entirely,
# so these responsibilities must live here too.
if [ -e "$COMMAND_LINK" ] || [ -L "$COMMAND_LINK" ]; then
  if [ ! -L "$COMMAND_LINK" ]; then
    echo "[gezel after-install] ERROR: refusing to replace an existing non-symlink: $COMMAND_LINK" >&2
    exit 1
  fi

  command_link_target=$(readlink "$COMMAND_LINK" 2>/dev/null || true)
  case "$command_link_target" in
    "$ELECTRON_EXE")
      # Migrate the direct symlink created by older Gezel packages into the
      # distro's alternatives manager.
      rm -f "$COMMAND_LINK"
      ;;
    "$ALTERNATIVES_LINK") ;;
    *)
      echo "[gezel after-install] ERROR: refusing to replace an unrelated symlink: $COMMAND_LINK -> $command_link_target" >&2
      exit 1
      ;;
  esac
fi

if command -v update-alternatives >/dev/null 2>&1; then
  # A failure here can mean another package owns the name. Do not hide that
  # conflict by falling back to `ln -sf`, which could overwrite its command.
  update-alternatives --install "$COMMAND_LINK" gezel "$ELECTRON_EXE" 100
else
  ln -s "$ELECTRON_EXE" "$COMMAND_LINK"
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

refresh_desktop_caches

# 4. Install the systemd unit (root:root 0644, standard). The source and
# destination were both validated before any existing service was stopped.
install -o root -g root -m 0644 "$UNIT_SRC" "$UNIT_DST"

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
