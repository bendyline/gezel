#!/bin/bash
#
# Gezel macOS uninstaller.
#
# A normal uninstall removes the application, the machine LaunchDaemon and
# service account, every user's optional Gezel LaunchAgent, and the PackageKit
# receipt. Data is retained unless one of the explicit removal flags is set.
#
# The app invokes this script with --detach so it can quit cleanly before any
# selected current-user data is removed. Direct administrator use remains
# synchronous and keeps the historical --purge-data alias.
set -euo pipefail

DAEMON_LABEL="com.bendyline.gezeld"
USER_AGENT_LABEL="com.bendyline.gezel"
PACKAGE_ID="com.bendyline.gezel"
PLIST="/Library/LaunchDaemons/${DAEMON_LABEL}.plist"
DATA_DIR="/Library/Application Support/Gezel"
MACHINE_SHARED_DIR="/Users/Shared/Gezel"
APP_DIR="/Applications/Gezel.app"
DAEMON_USER="_gezeld"
DETACHED_SCRIPT_PREFIX="/private/tmp/gezel-uninstall."
DETACHED_LOG_DIR_PREFIX="/var/tmp/gezel-uninstall."
DETACHED_LOG=""
SERVICE_EXIT_TIMEOUT_SECONDS=30

usage() {
  cat <<EOF
Usage:
  sudo $0 [data-removal options]

Default uninstall:
  Removes the Gezel application, machine-wide background service, service
  account, every user's Gezel startup item, and the PackageKit receipt. Service
  exit and account removal are verified. If macOS protects a pre-existing
  account, the matching group is retained and the script exits with the exact
  directory-service error and manual-remediation steps instead of claiming
  success. Downloaded models and all project, chat, credential, and settings
  data are preserved so a later reinstall can use them.

Data-removal options (independent and opt-in):
  --remove-machine-data
      Remove machine broker/engine data at:
        ${DATA_DIR}
      This includes downloaded shared models, runtime state, logs, and caches.

  --remove-shared-data
      Remove machine-shared projects and gezels at:
        ${MACHINE_SHARED_DIR}
      This affects every account on this Mac.

  --remove-current-user-data --user-uid=UID
      Remove the selected account's ~/.gezel data, Gezel desktop support
      files and preferences, and Gezel credentials from its login Keychain.
      Other users' private data is preserved.

Compatibility:
  --purge-data is an alias for --remove-machine-data.

Internal app handoff options:
  --detach --wait-for-pid=PID --detached-log=PATH
EOF
}

REMOVE_MACHINE_DATA=0
REMOVE_SHARED_DATA=0
REMOVE_CURRENT_USER_DATA=0
DETACH=0
WAIT_FOR_PID=""
TARGET_USER_UID="${SUDO_UID:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remove-machine-data|--purge-data)
      REMOVE_MACHINE_DATA=1
      ;;
    --remove-shared-data)
      REMOVE_SHARED_DATA=1
      ;;
    --remove-current-user-data)
      REMOVE_CURRENT_USER_DATA=1
      ;;
    --detach)
      DETACH=1
      ;;
    --wait-for-pid=*)
      WAIT_FOR_PID="${1#*=}"
      ;;
    --user-uid=*)
      TARGET_USER_UID="${1#*=}"
      ;;
    --detached-log=*)
      DETACHED_LOG="${1#*=}"
      ;;
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
  shift
done

if [ "$EUID" -ne 0 ]; then
  echo "uninstall.sh must be run as root: sudo $0" >&2
  exit 1
fi

valid_wait_pid() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 1 ]
}

if [ -n "$WAIT_FOR_PID" ] && ! valid_wait_pid "$WAIT_FOR_PID"; then
  echo "--wait-for-pid must name a process id greater than 1" >&2
  exit 64
fi

if [ -n "$DETACHED_LOG" ]; then
  case "$0" in
    "${DETACHED_SCRIPT_PREFIX}"*) ;;
    *)
      echo "--detached-log is reserved for the staged uninstaller" >&2
      exit 64
      ;;
  esac
  if ! [[ "$DETACHED_LOG" =~ ^/var/tmp/gezel-uninstall\.[[:alnum:]]+/uninstall\.log$ ]]; then
    echo "--detached-log does not name a staged uninstall log" >&2
    exit 64
  fi
fi

if [ "$REMOVE_CURRENT_USER_DATA" -eq 1 ]; then
  if ! [[ "$TARGET_USER_UID" =~ ^[0-9]+$ ]] || [ "$TARGET_USER_UID" -le 0 ]; then
    echo "--remove-current-user-data requires --user-uid with a non-root user id" >&2
    exit 64
  fi
fi

cleanup_staged_script() {
  case "$0" in
    "${DETACHED_SCRIPT_PREFIX}"*) rm -f -- "$0" ;;
  esac
}
trap cleanup_staged_script EXIT

if [ "$DETACH" -eq 1 ]; then
  # Copy out of Gezel.app before the child removes that bundle. Restrictive
  # ownership and mode prevent another local account from replacing the
  # privileged payload between staging and execution.
  umask 077
  staged_script=$(/usr/bin/mktemp "${DETACHED_SCRIPT_PREFIX}XXXXXX")
  /bin/cp "$0" "$staged_script"
  /usr/sbin/chown root:wheel "$staged_script"
  /bin/chmod 700 "$staged_script"

  # Keep the predictable filename inside a root-only, atomically allocated
  # directory. A local account cannot pre-create or swap this redirect target.
  detached_log_dir=$(/usr/bin/mktemp -d "${DETACHED_LOG_DIR_PREFIX}XXXXXX")
  /usr/sbin/chown root:wheel "$detached_log_dir"
  /bin/chmod 700 "$detached_log_dir"
  detached_log="${detached_log_dir}/uninstall.log"

  child_args=()
  [ -n "$WAIT_FOR_PID" ] && child_args+=("--wait-for-pid=${WAIT_FOR_PID}")
  [ -n "$TARGET_USER_UID" ] && child_args+=("--user-uid=${TARGET_USER_UID}")
  child_args+=("--detached-log=${detached_log}")
  [ "$REMOVE_MACHINE_DATA" -eq 1 ] && child_args+=("--remove-machine-data")
  [ "$REMOVE_SHARED_DATA" -eq 1 ] && child_args+=("--remove-shared-data")
  [ "$REMOVE_CURRENT_USER_DATA" -eq 1 ] && child_args+=("--remove-current-user-data")

  /usr/bin/nohup /bin/bash "$staged_script" "${child_args[@]}" \
    >"$detached_log" 2>&1 </dev/null &
  echo "[gezel uninstall] staged; Gezel may now quit"
  exit 0
fi

if [ -n "$WAIT_FOR_PID" ]; then
  echo "[gezel uninstall] waiting for Gezel process ${WAIT_FOR_PID} to exit"
  deadline=$((SECONDS + 120))
  while /bin/kill -0 "$WAIT_FOR_PID" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "[gezel uninstall] Gezel did not quit within 120 seconds; aborting cleanup" >&2
      exit 1
    fi
    /bin/sleep 1
  done
fi

read_user_attribute() {
  /usr/bin/dscl . -read "$1" "$2" 2>/dev/null |
    /usr/bin/awk -v key="$2" '$1 ~ "(^|:)" key ":$" { print $2 }' || true
}

# Keep the privileged command behind a fixed wrapper so the identity-removal
# state machine can be exercised with a fake directory service in unit tests.
# The production path is not configurable from the environment.
directory_service() {
  /usr/bin/dscl "$@"
}

# Prints exactly one of: present, absent, unknown. A non-zero dscl result is
# not enough to prove absence: permission and directory-service failures use
# the same exit channel as eDSRecordNotFound.
directory_record_state() {
  record="$1"
  if output=$(directory_service . -read "$record" 2>&1); then
    echo "present"
    return 0
  fi
  if printf '%s\n' "$output" | /usr/bin/grep -Eq 'eDSRecordNotFound|DS Error: -14136'; then
    echo "absent"
    return 0
  fi
  echo "[gezel uninstall] error: could not verify directory-service record ${record}" >&2
  if [ -n "$output" ]; then
    printf '%s\n' "$output" | /usr/bin/sed 's/^/[gezel uninstall]   /' >&2
  fi
  echo "unknown"
}

delete_directory_record() {
  kind="$1"
  record="$2"
  state=$(directory_record_state "$record")
  case "$state" in
    absent)
      echo "[gezel uninstall] ${kind} record ${record} is already absent"
      return 0
      ;;
    present) ;;
    *)
      echo "[gezel uninstall] error: refusing to claim ${kind} removal without a reliable preflight" >&2
      return 1
      ;;
  esac

  delete_failed=0
  delete_output=""
  if ! delete_output=$(directory_service . -delete "$record" 2>&1); then
    delete_failed=1
    echo "[gezel uninstall] error: dscl could not delete ${kind} record ${record}" >&2
    if [ -n "$delete_output" ]; then
      printf '%s\n' "$delete_output" | /usr/bin/sed 's/^/[gezel uninstall]   /' >&2
    fi
  fi

  state=$(directory_record_state "$record")
  if [ "$state" = "absent" ]; then
    if [ "$delete_failed" -eq 1 ]; then
      echo "[gezel uninstall] ${kind} record ${record} is nevertheless verified absent"
    else
      echo "[gezel uninstall] removed ${kind} record ${record} (verified absent)"
    fi
    return 0
  fi

  if [ "$state" = "present" ]; then
    echo "[gezel uninstall] error: ${kind} record ${record} still exists after deletion" >&2
  else
    echo "[gezel uninstall] error: absence of ${kind} record ${record} could not be verified" >&2
  fi
  return 1
}

remove_service_identity() {
  user_record="/Users/${DAEMON_USER}"
  group_record="/Groups/${DAEMON_USER}"

  # Never repeat the release defect: if macOS retains the user, keep its
  # matching group too instead of manufacturing an orphaned account.
  if ! delete_directory_record "user" "$user_record"; then
    echo "[gezel uninstall] error: keeping ${group_record} because ${user_record} remains" >&2
    return 1
  fi
  delete_directory_record "group" "$group_record"
}

launchd_service_pid() {
  /bin/launchctl print "system/${DAEMON_LABEL}" 2>/dev/null |
    /usr/bin/awk '$1 == "pid" && $2 == "=" { gsub(/;/, "", $3); print $3; exit }' || true
}

stop_machine_service() {
  echo "[gezel uninstall] stopping GezelService"
  service_was_loaded=0
  if /bin/launchctl print "system/${DAEMON_LABEL}" >/dev/null 2>&1; then
    service_was_loaded=1
  fi
  service_pid=$(launchd_service_pid)

  bootout_output=""
  if ! bootout_output=$(/bin/launchctl bootout "system/${DAEMON_LABEL}" 2>&1); then
    if [ "$service_was_loaded" -eq 1 ]; then
      echo "[gezel uninstall] warning: launchctl bootout reported an error; waiting to verify shutdown" >&2
      if [ -n "$bootout_output" ]; then
        printf '%s\n' "$bootout_output" | /usr/bin/sed 's/^/[gezel uninstall]   /' >&2
      fi
    fi
  fi

  deadline=$((SECONDS + SERVICE_EXIT_TIMEOUT_SECONDS))
  while :; do
    service_loaded=0
    service_process_running=0
    if /bin/launchctl print "system/${DAEMON_LABEL}" >/dev/null 2>&1; then
      service_loaded=1
    fi
    if [[ "$service_pid" =~ ^[0-9]+$ ]] && [ "$service_pid" -gt 1 ] &&
       /bin/kill -0 "$service_pid" 2>/dev/null; then
      service_process_running=1
    fi
    if [ "$service_loaded" -eq 0 ] && [ "$service_process_running" -eq 0 ]; then
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "[gezel uninstall] error: GezelService did not exit within ${SERVICE_EXIT_TIMEOUT_SECONDS} seconds; cleanup stopped before removing its files or account" >&2
      return 1
    fi
    /bin/sleep 0.2
  done
  echo "[gezel uninstall] GezelService stopped (verified)"
}

print_identity_remediation() {
  cat >&2 <<EOF
[gezel uninstall] ERROR: Gezel was removed, but macOS retained part of the ${DAEMON_USER} service account.
[gezel uninstall] No unconditional success is being reported. Review the protected or pre-existing records with:
[gezel uninstall]   sudo /usr/bin/dscl . -read /Users/${DAEMON_USER}
[gezel uninstall]   sudo /usr/bin/dscl . -read /Groups/${DAEMON_USER}
[gezel uninstall] If the user is Gezel's dedicated account, remove it first. Remove the matching group only after the user is verified absent:
[gezel uninstall]   sudo /usr/bin/dscl . -delete /Users/${DAEMON_USER}
[gezel uninstall]   sudo /usr/bin/dscl . -delete /Groups/${DAEMON_USER}
EOF
  if [ -n "$DETACHED_LOG" ]; then
    echo "[gezel uninstall] A detached uninstall's complete log is at ${DETACHED_LOG}." >&2
  fi
}

notify_detached_identity_failure() {
  case "$0" in
    "${DETACHED_SCRIPT_PREFIX}"*) ;;
    *) return 0 ;;
  esac
  [[ "$TARGET_USER_UID" =~ ^[0-9]+$ ]] || return 0
  [ "$TARGET_USER_UID" -gt 0 ] || return 0
  notification_username=$(user_for_uid "$TARGET_USER_UID") || return 0

  # The initiating app has already quit, so a detached failure cannot travel
  # back over IPC. Surface it in the initiating user's GUI as well as the
  # root-owned log. The alert times out so cleanup never waits indefinitely.
  /bin/launchctl asuser "$TARGET_USER_UID" /usr/bin/sudo -H -u "$notification_username" \
    /usr/bin/osascript \
    -e 'display alert "Gezel uninstall needs attention" message "Gezel was removed, but macOS retained part of the _gezeld service account. Its matching group was preserved while the user remained. Ask an administrator to inspect and remove the _gezeld user first, then remove its matching group." as critical buttons {"OK"} default button "OK" giving up after 30' \
    >/dev/null 2>&1 || true
}

is_safe_user_home() {
  case "$1" in
    /Users/*|/Volumes/*|/Network/*) ;;
    *) return 1 ;;
  esac
  [ "$1" != "/Users/Shared" ] && [ "$1" != "/Users/Shared/" ]
}

user_for_uid() {
  /usr/bin/dscl . -list /Users UniqueID 2>/dev/null |
    /usr/bin/awk -v uid="$1" '$2 == uid { print $1; count++ } END { if (count != 1) exit 1 }'
}

remove_all_user_launch_agents() {
  echo "[gezel uninstall] removing per-user Gezel startup items"
  while read -r username uid; do
    [ -n "${username:-}" ] || continue
    [[ "${uid:-}" =~ ^[0-9]+$ ]] || continue
    [ "$uid" -gt 0 ] || continue
    home=$(read_user_attribute "/Users/${username}" NFSHomeDirectory)
    if ! is_safe_user_home "$home"; then
      continue
    fi
    /bin/launchctl bootout "gui/${uid}/${USER_AGENT_LABEL}" 2>/dev/null || true
    # Run the file removal as the account itself. Besides preserving normal
    # ownership semantics, this prevents a user-controlled intermediate
    # symlink from turning the privileged uninstaller into an arbitrary root
    # file deletion primitive.
    /usr/bin/sudo -H -u "$username" /bin/rm -f -- \
      "${home}/Library/LaunchAgents/${USER_AGENT_LABEL}.plist" 2>/dev/null || true
  done < <(/usr/bin/dscl . -list /Users UniqueID 2>/dev/null || true)
}

stop_target_user_daemon() {
  runtime_pid_file="$1/.gezel/runtime/pid"
  [ -f "$runtime_pid_file" ] || return 0
  runtime_pid=$(/usr/bin/awk 'NR == 1 { print $1 }' "$runtime_pid_file" 2>/dev/null || true)
  [[ "$runtime_pid" =~ ^[0-9]+$ ]] || return 0
  [ "$runtime_pid" -gt 1 ] || return 0

  runtime_uid=$(/bin/ps -o uid= -p "$runtime_pid" 2>/dev/null | /usr/bin/tr -d ' ' || true)
  runtime_command=$(/bin/ps -o command= -p "$runtime_pid" 2>/dev/null || true)
  if [ "$runtime_uid" != "$TARGET_USER_UID" ]; then
    return 0
  fi
  case "$runtime_command" in
    *gezeld*|*service-bundle*) ;;
    *) return 0 ;;
  esac

  echo "[gezel uninstall] stopping current user's Gezel daemon"
  /bin/kill -TERM "$runtime_pid" 2>/dev/null || true
  attempts=0
  while /bin/kill -0 "$runtime_pid" 2>/dev/null && [ "$attempts" -lt 50 ]; do
    /bin/sleep 0.1
    attempts=$((attempts + 1))
  done
  if /bin/kill -0 "$runtime_pid" 2>/dev/null; then
    /bin/kill -KILL "$runtime_pid" 2>/dev/null || true
  fi
}

remove_target_user_keychain_items() {
  username="$1"
  uid="$2"
  home="$3"
  keychain="${home}/Library/Keychains/login.keychain-db"
  [ -f "$keychain" ] || keychain="${home}/Library/Keychains/login.keychain"
  if [ ! -f "$keychain" ]; then
    echo "[gezel uninstall] no login Keychain found for ${username}; skipping credential cleanup"
    return 0
  fi

  # The Keychain belongs to the logged-in user, not root. Enter that user's
  # GUI bootstrap and uid before asking the Security framework to delete each
  # generic-password item whose service is exactly "gezel". A locked or
  # policy-managed Keychain may refuse; filesystem cleanup must still finish.
  echo "[gezel uninstall] removing current user's Gezel Keychain items"
  removed=0
  while [ "$removed" -lt 512 ]; do
    if ! /bin/launchctl asuser "$uid" /usr/bin/sudo -H -u "$username" \
      /usr/bin/security delete-generic-password -s gezel "$keychain" >/dev/null 2>&1; then
      break
    fi
    removed=$((removed + 1))
  done
  if /bin/launchctl asuser "$uid" /usr/bin/sudo -H -u "$username" \
    /usr/bin/security find-generic-password -s gezel "$keychain" >/dev/null 2>&1; then
    echo "[gezel uninstall] warning: macOS did not allow every Gezel Keychain item to be removed" >&2
  fi
}

remove_current_user_data() {
  target_username=$(user_for_uid "$TARGET_USER_UID") || {
    echo "[gezel uninstall] cannot resolve one account for uid ${TARGET_USER_UID}; refusing user-data removal" >&2
    exit 1
  }
  target_home=$(read_user_attribute "/Users/${target_username}" NFSHomeDirectory)
  if ! is_safe_user_home "$target_home"; then
    echo "[gezel uninstall] unsafe home for ${target_username}; refusing user-data removal" >&2
    exit 1
  fi

  stop_target_user_daemon "$target_home"
  remove_target_user_keychain_items "$target_username" "$TARGET_USER_UID" "$target_home"

  echo "[gezel uninstall] removing private Gezel data for ${target_username}"
  # These trees are user-controlled, so remove them with that user's uid even
  # though the surrounding machine uninstall is privileged. This bounds any
  # symlink traversal to paths the account could already modify.
  /usr/bin/sudo -H -u "$target_username" /bin/rm -rf -- \
    "${target_home}/.gezel" \
    "${target_home}/Library/Application Support/Gezel" \
    "${target_home}/Library/Caches/Gezel" \
    "${target_home}/Library/Caches/com.bendyline.gezel" \
    "${target_home}/Library/Preferences/com.bendyline.gezel.plist" \
    "${target_home}/Library/Saved Application State/com.bendyline.gezel.savedState"
}

stop_machine_service

# `launchctl disable` persists independently of the plist and app payload.
# Clear any installer safety quarantine so a later reinstall starts from the
# platform default instead of inheriting a stale disabled-service override.
echo "[gezel uninstall] clearing persistent launchd override"
/bin/launchctl enable "system/${DAEMON_LABEL}" 2>/dev/null || true

remove_all_user_launch_agents

echo "[gezel uninstall] removing LaunchDaemon plist"
/bin/rm -f -- "$PLIST"

echo "[gezel uninstall] removing application bundle"
/bin/rm -rf -- "$APP_DIR"

echo "[gezel uninstall] removing ${DAEMON_USER} system user and group"
IDENTITY_REMOVAL_FAILED=0
if ! remove_service_identity; then
  IDENTITY_REMOVAL_FAILED=1
fi

if [ "$REMOVE_MACHINE_DATA" -eq 1 ]; then
  echo "[gezel uninstall] removing machine broker/engine data at ${DATA_DIR}"
  /bin/rm -rf -- "$DATA_DIR"
else
  echo "[gezel uninstall] preserved machine broker/engine data at ${DATA_DIR}"
fi

if [ "$REMOVE_SHARED_DATA" -eq 1 ]; then
  echo "[gezel uninstall] removing machine-shared projects and gezels at ${MACHINE_SHARED_DIR}"
  /bin/rm -rf -- "$MACHINE_SHARED_DIR"
else
  echo "[gezel uninstall] preserved machine-shared projects and gezels at ${MACHINE_SHARED_DIR}"
fi

if [ "$REMOVE_CURRENT_USER_DATA" -eq 1 ]; then
  remove_current_user_data
else
  echo "[gezel uninstall] preserved every account's private Gezel data"
fi

echo "[gezel uninstall] forgetting PackageKit receipt ${PACKAGE_ID}"
if /usr/sbin/pkgutil --pkg-info "$PACKAGE_ID" >/dev/null 2>&1; then
  /usr/sbin/pkgutil --forget "$PACKAGE_ID" >/dev/null ||
    echo "[gezel uninstall] warning: PackageKit could not forget ${PACKAGE_ID}" >&2
fi

if [ "$IDENTITY_REMOVAL_FAILED" -eq 1 ]; then
  print_identity_remediation
  notify_detached_identity_failure
  exit 1
fi

echo "[gezel uninstall] done (service exit and account removal verified)"
