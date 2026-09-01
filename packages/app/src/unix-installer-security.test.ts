import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function installerFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../installer/${relativePath}`, import.meta.url)),
    'utf8',
  );
}

function position(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, `missing installer security directive: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

function shellFunction(
  source: string,
  name: string,
  body: 'subshell' | 'brace' = 'subshell',
): string {
  const opening = body === 'subshell' ? '(' : '{';
  const closing = body === 'subshell' ? ')' : '}';
  const start = position(source, `${name}() ${opening}`);
  const end = source.indexOf(`\n${closing}\n`, start);
  expect(end, `unterminated installer function: ${name}`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

const macPostinstall = installerFile('macos-pkg-scripts/postinstall');
const macPlist = installerFile('com.bendyline.gezeld.plist');
const macUninstall = installerFile('uninstall.sh');
const linuxPostinstall = installerFile('linux/after-install.sh');
const linuxPostremove = installerFile('linux/after-remove.sh');
const linuxUnit = installerFile('gezeld.service');

describe('macOS machine-service filesystem security', () => {
  it('records the exact command behind a PackageKit script failure', () => {
    expect(macPostinstall).toContain('set -Eeuo pipefail');
    expect(macPostinstall).toContain('report_unhandled_error()');
    expect(macPostinstall).toContain(
      'trap \'report_unhandled_error "$?" "$LINENO" "$BASH_COMMAND"\' ERR',
    );
    expect(macPostinstall).toContain(
      '[gezel postinstall] ERROR: command failed at line ${line} (exit ${status}): ${command}',
    );
  });

  it('fails the package instead of accepting an unpublished partial migration', () => {
    const migration = position(
      macPostinstall,
      'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$MIGRATE_SHARED_CLI"',
    );
    const aclSetup = macPostinstall.indexOf('assert_not_symlink "$SHARED_DIR"', migration);
    expect(aclSetup).toBeGreaterThan(migration);
    const migrationBlock = macPostinstall.slice(migration, aclSetup);

    expect(migrationBlock).not.toContain('|| migration_ok=0');
    expect(migrationBlock).not.toContain('exit 0');
    expect(macPostinstall).not.toContain('migration_ok=');
  });

  it('migrates private state while exposing runtime and read-only assets', () => {
    expect(macPostinstall).toContain('umask 077');
    expect(macPostinstall).toContain(
      'find -x "$DATA_DIR" -path "$SERVICE_TREE" -prune -o \\\n  -exec chown -h "${DAEMON_USER}:${DAEMON_USER}" {} +',
    );
    expect(macPostinstall).toContain(
      'find -x "$DATA_DIR" -path "$SERVICE_TREE" -prune -o ! -type l -exec chmod -N {} +',
    );
    expect(macPostinstall).not.toContain('chmod -RN "$DATA_DIR"');
    expect(macPostinstall).not.toContain('chown -R');
    expect(macPostinstall).toContain(
      'find -x "$DATA_DIR" -path "$SERVICE_TREE" -prune -o ! -type l -exec chmod go-rwx {} +',
    );
    expect(macPostinstall).toContain('chmod 711 "$DATA_DIR"');
    expect(macPostinstall).toContain('chmod 755 "$DATA_DIR/runtime"');
    expect(macPostinstall).toContain('chmod 700 "$DATA_DIR/logs"');
    expect(macPostinstall).toContain('find -x "$ASSETS_DIR" -type d -exec chmod 755 {} +');
    expect(macPostinstall).toContain('find -x "$ASSETS_DIR" -type f -exec chmod 644 {} +');
    expect(macPostinstall).toContain('--source="$DATA_DIR"');
    expect(macPostinstall).toContain('--dest="$SHARED_DIR"');
    expect(macPostinstall).toContain('chmod 1777 "$SHARED_DIR"');
    expect(macPostinstall).toContain('${DAEMON_USER} deny list,search,read,write');
    expect(macPostinstall).toContain('.gezel-machine-shared-v1.json');
    expect(macPostinstall).toContain('"$DATA_DIR/runtime/auth-token"');
    expect(macPostinstall).toContain('"$DATA_DIR/runtime/service-role"');

    const stop = position(macPostinstall, 'launchctl bootout "system/${DAEMON_LABEL}"');
    const inactiveGate = position(
      macPostinstall,
      'if launchctl print "system/${DAEMON_LABEL}" >/dev/null 2>&1; then',
    );
    const sharedMigration = position(
      macPostinstall,
      'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$MIGRATE_SHARED_CLI"',
    );
    const migration = position(macPostinstall, 'find -x "$DATA_DIR"');
    const extraction = position(
      macPostinstall,
      'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$EXTRACT_CLI"',
    );
    expect(macPostinstall.slice(inactiveGate, migration)).toContain('exit 1');
    expect(stop).toBeLessThan(migration);
    expect(stop).toBeLessThan(inactiveGate);
    expect(inactiveGate).toBeLessThan(migration);
    expect(inactiveGate).toBeLessThan(sharedMigration);
    expect(sharedMigration).toBeLessThan(migration);
    expect(migration).toBeLessThan(extraction);
  });

  it('rejects installer-owned symlinks and gives launchd the same private umask', () => {
    expect(macPostinstall).toContain('if [ -L "$path" ]');
    expect(macPostinstall).toContain('assert_not_symlink "$DATA_DIR"');
    expect(macPostinstall).toContain('assert_not_symlink "$DATA_DIR/runtime"');
    expect(macPostinstall).toContain('assert_not_symlink "$ASSETS_DIR/models"');
    expect(macPostinstall).toContain('assert_not_symlink "$SERVICE_TREE"');
    expect(macPostinstall).toContain('dscl . -list /Groups PrimaryGroupID');
    expect(macPostinstall).toContain('for candidate in $(seq 200 399)');
    expect(macPostinstall).toContain('if [ -z "$new_uid" ]');
    expect(macPostinstall).toContain('dscl . -list /Users UniqueID');
    expect(macPostinstall).toContain('dscl . -list /Groups PrimaryGroupID');
    expect(macPostinstall).toContain('[ "${user_id_count:-0}" -ne 1 ]');
    expect(macPostinstall).toContain('[ "${group_id_count:-0}" -ne 1 ]');
    expect(macPostinstall).toContain('abort_bad_service_identity()');
    expect(macPostinstall).toContain('launchctl disable "system/${DAEMON_LABEL}"');
    expect(macPostinstall).toContain(
      'daemon_shell=$(read_daemon_attribute "/Users/${DAEMON_USER}" UserShell)',
    );
    expect(macPostinstall).toContain('[ "$daemon_shell" != "/usr/bin/false" ]');
    expect(macPostinstall).toContain('[ "$daemon_home" != "/var/empty" ]');
    expect(macPostinstall).toContain(
      'daemon_hidden=$(read_daemon_attribute "/Users/${DAEMON_USER}" IsHidden)',
    );
    // macOS 26 renders native attributes as `dsAttrTypeNative:IsHidden: 1`,
    // older releases as `IsHidden: 1`. The shared reader must accept either
    // label without accepting a different value.
    expect(macPostinstall).toContain('awk -v key="$2" \'$1 ~ "(^|:)" key ":$" { print $2 }\'');
    expect(macPostinstall).toContain('[ "$daemon_hidden" != "1" ]');
    expect(macPlist).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/);
    expect(macPlist).toMatch(/<key>GEZEL_PORT<\/key>\s*<string>6228<\/string>/);
    expect(macPlist).toMatch(/<key>GEZEL_SERVICE_ROLE<\/key>\s*<string>machine-engine<\/string>/);
    expect(macPlist).not.toContain('<key>GEZEL_UI_DIR</key>');
    expect(macPlist).toMatch(
      /<key>GEZEL_SHARED_ASSETS_DIR<\/key>\s*<string>\/Library\/Application Support\/Gezel\/assets<\/string>/,
    );
  });

  it('recovers launchd quarantine and proves the installed service is healthy', () => {
    const identityValidation = position(macPostinstall, '[ "$daemon_hidden" != "1" ]');
    const enable = position(macPostinstall, 'launchctl enable "system/${DAEMON_LABEL}"');
    const bootstrap = position(
      macPostinstall,
      'bootstrap_err=$(launchctl bootstrap system "$PLIST_DST"',
    );
    const health = position(macPostinstall, '\nwait_for_service_health\n');

    expect(identityValidation).toBeLessThan(enable);
    expect(enable).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(health);
    expect(macPostinstall).toContain('--cacert "$RUNTIME_CERT"');
    expect(macPostinstall).toContain('"https://127.0.0.1:${runtime_port}/api/health"');
    expect(macPostinstall).toContain('grep -Eq \'"ok"[[:space:]]*:[[:space:]]*true\'');
    expect(macPostinstall).toContain(
      'grep -Eq \'"serviceRole"[[:space:]]*:[[:space:]]*"(machine-engine|legacy-full)"\'',
    );
    expect(macPostinstall).toContain('dump_service_diagnostics');
    expect(macUninstall).toContain('launchctl enable "system/${DAEMON_LABEL}"');
  });

  it('makes every macOS data-removal scope explicit and opt-in', () => {
    expect(macUninstall).toContain('DATA_DIR="/Library/Application Support/Gezel"');
    expect(macUninstall).toContain('MACHINE_SHARED_DIR="/Users/Shared/Gezel"');
    expect(macUninstall).toContain('--purge-data is an alias for --remove-machine-data');
    expect(macUninstall).toContain('--remove-machine-data');
    expect(macUninstall).toContain('--remove-shared-data');
    expect(macUninstall).toContain('--remove-current-user-data --user-uid=UID');
    expect(macUninstall).toContain('if [ "$REMOVE_MACHINE_DATA" -eq 1 ]');
    expect(macUninstall).toContain('if [ "$REMOVE_SHARED_DATA" -eq 1 ]');
    expect(macUninstall).toContain('if [ "$REMOVE_CURRENT_USER_DATA" -eq 1 ]');
    expect(macUninstall).toContain(
      '[gezel uninstall] preserved machine-shared projects and gezels at ${MACHINE_SHARED_DIR}',
    );
    expect(macUninstall).toContain(
      "[gezel uninstall] preserved every account's private Gezel data",
    );
    expect(macUninstall).toContain('/bin/rm -rf -- "$DATA_DIR"');
    expect(macUninstall).toContain('/bin/rm -rf -- "$MACHINE_SHARED_DIR"');
    expect(macUninstall).toContain('/usr/bin/sudo -H -u "$target_username" /bin/rm -rf --');
  });

  it('removes all user startup items, detaches safely, and forgets the PKG receipt', () => {
    expect(macUninstall).toContain('USER_AGENT_LABEL="com.bendyline.gezel"');
    expect(macUninstall).toContain('/usr/bin/dscl . -list /Users UniqueID');
    expect(macUninstall).toContain('/bin/launchctl bootout "gui/${uid}/${USER_AGENT_LABEL}"');
    expect(macUninstall).toContain('"${home}/Library/LaunchAgents/${USER_AGENT_LABEL}.plist"');
    expect(macUninstall).toContain('/usr/bin/mktemp "${DETACHED_SCRIPT_PREFIX}XXXXXX"');
    expect(macUninstall).toContain('/usr/bin/mktemp -d "${DETACHED_LOG_DIR_PREFIX}XXXXXX"');
    expect(macUninstall).toContain('/bin/chmod 700 "$detached_log_dir"');
    expect(macUninstall).toContain('child_args+=("--detached-log=${detached_log}")');
    expect(macUninstall).toContain('/usr/bin/nohup /bin/bash "$staged_script"');
    expect(macUninstall).toContain('>"$detached_log" 2>&1 </dev/null &');
    expect(macUninstall).not.toContain('DETACHED_LOG="/var/tmp/gezel-uninstall.log"');
    expect(macUninstall).toContain('waiting for Gezel process ${WAIT_FOR_PID} to exit');
    expect(macUninstall).toContain('PACKAGE_ID="com.bendyline.gezel"');
    expect(macUninstall).toContain('/usr/sbin/pkgutil --forget "$PACKAGE_ID"');
  });

  it('waits for the LaunchDaemon job and process to exit before destructive cleanup', () => {
    const stop = shellFunction(macUninstall, 'stop_machine_service', 'brace');
    expect(stop).toContain('service_pid=$(launchd_service_pid)');
    expect(stop).toContain('/bin/launchctl print "system/${DAEMON_LABEL}"');
    expect(stop).toContain('/bin/kill -0 "$service_pid"');
    expect(stop).toContain('GezelService stopped (verified)');
    expect(stop).toContain('cleanup stopped before removing its files or account');

    const stopCall = macUninstall.lastIndexOf('\nstop_machine_service\n');
    const removePlist = position(macUninstall, '/bin/rm -f -- "$PLIST"');
    const removeIdentity = position(macUninstall, 'if ! remove_service_identity; then');
    expect(stopCall).toBeGreaterThanOrEqual(0);
    expect(stopCall).toBeLessThan(removePlist);
    expect(stopCall).toBeLessThan(removeIdentity);
  });

  it('keeps the service group and reports remediation when macOS retains the user', () => {
    const removeIdentity = shellFunction(macUninstall, 'remove_service_identity', 'brace');
    const deleteUser = position(removeIdentity, 'delete_directory_record "user"');
    const deleteGroup = position(removeIdentity, 'delete_directory_record "group"');
    expect(deleteUser).toBeLessThan(deleteGroup);
    expect(removeIdentity.slice(deleteUser, deleteGroup)).toContain('return 1');
    expect(macUninstall).toContain('No unconditional success is being reported');
    expect(macUninstall).toContain(
      'Remove the matching group only after the user is verified absent',
    );
    expect(macUninstall).toContain('display alert "Gezel uninstall needs attention"');
    expect(macUninstall).toContain('item 1 of argv');
    expect(macUninstall).toContain('"$DETACHED_LOG"');
    expect(macUninstall).not.toContain('See /var/tmp/gezel-uninstall.log');
    expect(macUninstall).toContain('giving up after 30');
    expect(macUninstall).toContain('exit 1');
    expect(macUninstall).toContain('done (service exit and account removal verified)');
  });

  it.skipIf(process.platform === 'win32')(
    'live probe: retained user keeps the group and fails loudly (fake dscl)',
    () => {
      const removeIdentity = shellFunction(macUninstall, 'remove_service_identity', 'brace');
      // Exercise the exact state machine with a fake directory service. This
      // reproduces the release failure: user deletion returns eDSPermissionError.
      // The group must remain, the dscl error must be visible, and the function
      // must return failure instead of printing a success claim.
      const probeRoot = mkdtempSync(join(tmpdir(), 'gezel-uninstall-identity-'));
      try {
        const userRecord = join(probeRoot, 'user-record');
        const groupRecord = join(probeRoot, 'group-record');
        const calls = join(probeRoot, 'calls.log');
        const output = join(probeRoot, 'output.log');
        writeFileSync(userRecord, 'present');
        writeFileSync(groupRecord, 'present');

        const script = `set -euo pipefail
DAEMON_USER="_gezeld"
USER_RECORD=${JSON.stringify(userRecord)}
GROUP_RECORD=${JSON.stringify(groupRecord)}
CALLS=${JSON.stringify(calls)}
OUTPUT=${JSON.stringify(output)}
directory_service() {
  printf '%s:%s\\n' "$2" "$3" >>"$CALLS"
  case "$2:$3" in
    -read:/Users/_gezeld)
      [ -e "$USER_RECORD" ] && { echo present; return 0; }
      ;;
    -read:/Groups/_gezeld)
      [ -e "$GROUP_RECORD" ] && { echo present; return 0; }
      ;;
    -delete:/Users/_gezeld)
      echo 'DS Error: -14090 (eDSPermissionError)' >&2
      return 70
      ;;
    -delete:/Groups/_gezeld)
      rm -f "$GROUP_RECORD"
      return 0
      ;;
  esac
  echo 'DS Error: -14136 (eDSRecordNotFound)' >&2
  return 56
}
${shellFunction(macUninstall, 'directory_record_state', 'brace')}
${shellFunction(macUninstall, 'delete_directory_record', 'brace')}
${removeIdentity}
if remove_service_identity >"$OUTPUT" 2>&1; then
  echo 'identity removal unexpectedly succeeded' >&2
  exit 90
fi
[ -e "$USER_RECORD" ]
[ -e "$GROUP_RECORD" ]
! grep -q -- '-delete:/Groups/_gezeld' "$CALLS"
grep -q 'eDSPermissionError' "$OUTPUT"
grep -q 'keeping /Groups/_gezeld because /Users/_gezeld remains' "$OUTPUT"
`;
        execFileSync('/bin/bash', ['-c', script], { stdio: 'pipe' });
      } finally {
        rmSync(probeRoot, { recursive: true, force: true });
      }
    },
  );

  it('repairs a daemon account that kept its user but lost its group', () => {
    // Group creation lives inside the `user does not exist` branch, so a
    // machine holding the user without the group takes the *other* branch on
    // every reinstall and never reaches the only code that makes a group.
    // Without a repair here that state is permanent: validation rejects the
    // install forever, and uninstall.sh ships inside an app bundle the failed
    // install never wrote. Reproduced on a real Mac carrying uid 206 with no
    // matching group.
    const alreadyExists = position(macPostinstall, 'already exists; skipping create');
    const repair = position(macPostinstall, 'group is missing; attempting repair');
    const validation = position(macPostinstall, 'read_daemon_attribute() {');
    expect(alreadyExists).toBeLessThan(repair);
    expect(repair).toBeLessThan(validation);

    // Repaired from the user's own PrimaryGroupID, not a freshly-picked id:
    // the account already owns files under that gid.
    expect(macPostinstall).toContain(
      'dscl . -create "/Groups/${DAEMON_USER}" PrimaryGroupID "$repair_gid"',
    );
    // …and only when that id is genuinely free. Minting a group over a gid
    // another group already holds would manufacture the shared-GID collision
    // the checks below exist to reject.
    expect(macPostinstall).toContain('[ "$repair_gid" -ge 200 ]');
    expect(macPostinstall).toContain('[ "$repair_gid" -lt 400 ]');
    expect(macPostinstall).toContain('[ "$repair_gid_owners" = "0" ]');
    expect(macPostinstall).toContain('cannot safely recreate ${DAEMON_USER} group');
  });

  it('reads every identity attribute through a guard so a gap is named, not trapped', () => {
    // dscl exits non-zero for a missing record AND for a missing key on a
    // record that exists. Under `set -Eeuo pipefail` a bare
    // `x=$(dscl ... | awk ...)` aborts at the ERR trap, so PackageKit showed
    // only "installation failed" plus a line number. Absent values have to
    // survive to the named checks instead.
    expect(macPostinstall).toContain('read_daemon_attribute() {');
    expect(macPostinstall).toMatch(
      /dscl \. -read "\$1" "\$2" 2>\/dev\/null \|\n\s*awk .* \|\| true/,
    );
    expect(macPostinstall).toContain('the dedicated user record is missing or incomplete');
    expect(macPostinstall).toContain(
      'the matching ${DAEMON_USER} group is missing and could not be repaired',
    );

    // The regression itself: no identity value may be assigned from an
    // unguarded dscl pipeline.
    const unguarded = macPostinstall
      .split('\n')
      .filter((line) =>
        /^\s*(daemon_|user_id_count|group_id_count|repair_)\w*=\$\(\s*dscl/.test(line),
      )
      .filter((line) => !line.includes('2>/dev/null'));
    expect(unguarded, `unguarded dscl assignment: ${unguarded.join(' | ')}`).toEqual([]);
  });

  it('still refuses to commandeer a pre-existing interactive or shared account', () => {
    // The repair above must not soften any of these: it only ever creates a
    // group, never rewrites the user record's shell, home, or visibility.
    expect(macPostinstall).toContain('abort_bad_service_identity');
    expect(macPostinstall).toContain('[ "$daemon_uid" -lt 200 ]');
    expect(macPostinstall).toContain('[ "$daemon_uid" -ge 400 ]');
    expect(macPostinstall).toContain('[ "$daemon_uid" -ne "$daemon_user_gid" ]');
    expect(macPostinstall).toContain('[ "${user_id_count:-0}" -ne 1 ]');
    expect(macPostinstall).toContain('[ "${group_id_count:-0}" -ne 1 ]');
    expect(macPostinstall).toContain('[ "$daemon_shell" != "/usr/bin/false" ]');
    expect(macPostinstall).toContain('[ "$daemon_home" != "/var/empty" ]');
    expect(macPostinstall).toContain('[ "$daemon_hidden" != "1" ]');

    // The repair writes to /Groups only. Re-asserting the user record's shell,
    // home, or visibility would turn a pre-existing human account named
    // _gezeld into a daemon account — exactly what the checks above refuse.
    const repairBlock = macPostinstall.slice(
      position(macPostinstall, 'group is missing; attempting repair'),
      position(macPostinstall, 'read_daemon_attribute() {'),
    );
    const repairWrites = repairBlock.match(/dscl \. -create "[^"]+"/g) ?? [];
    expect(repairWrites.length).toBeGreaterThan(0);
    for (const write of repairWrites) {
      expect(write, 'account repair must never rewrite the user record').toContain('/Groups/');
    }
  });
});

describe('Linux machine-service filesystem security', () => {
  it('uses a trusted root environment for package-manager hooks', () => {
    for (const hook of [linuxPostinstall, linuxPostremove]) {
      expect(hook).toContain('set -eu');
      expect(hook).toContain('PATH=/usr/sbin:/usr/bin:/sbin:/bin');
      expect(hook).toContain('if [ "$(id -u)" -ne 0 ]; then');

      const path = position(hook, 'PATH=/usr/sbin:/usr/bin:/sbin:/bin');
      const firstCommand = position(hook, 'if [ "$(id -u)" -ne 0 ]; then');
      expect(path).toBeLessThan(firstCommand);
    }
  });

  it('refuses to commandeer a pre-existing interactive or shared account', () => {
    expect(linuxPostinstall).toContain('abort_bad_service_identity()');
    expect(linuxPostinstall).toContain('systemctl disable --now gezeld.service');
    expect(linuxPostinstall).toContain('getent passwd "$GEZEL_USER"');
    expect(linuxPostinstall).toContain('getent group "$GEZEL_USER"');
    expect(linuxPostinstall).toContain('[ "$account_uid" -ge "$uid_min" ]');
    expect(linuxPostinstall).toContain('[ "$account_gid" -ne "$group_gid" ]');
    expect(linuxPostinstall).toContain('[ "$uid_count" -ne 1 ]');
    expect(linuxPostinstall).toContain('[ "$gid_count" -ne 1 ]');
    expect(linuxPostinstall).toContain('*/nologin|*/false');
    expect(linuxPostinstall).toContain('account password is not locked');

    const validation = position(linuxPostinstall, 'passwd_entry=$(getent passwd');
    const migration = position(linuxPostinstall, 'find "$DATA_DIR" -xdev');
    const extraction = position(linuxPostinstall, 'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE"');
    expect(validation).toBeLessThan(migration);
    expect(validation).toBeLessThan(extraction);
  });

  it('migrates private state while exposing runtime and read-only assets', () => {
    expect(linuxPostinstall).toContain('umask 077');
    expect(linuxPostinstall).toContain(
      'find "$DATA_DIR" -xdev -path "$SERVICE_TREE" -prune -o \\\n  -exec chown --no-dereference "$GEZEL_USER:$GEZEL_USER" -- {} +',
    );
    expect(linuxPostinstall).not.toContain('chown -R');
    expect(linuxPostinstall).toContain(
      'find "$DATA_DIR" -xdev -path "$SERVICE_TREE" -prune -o ! -type l -exec setfacl -b -- {} +',
    );
    expect(linuxPostinstall).toContain(
      'find "$DATA_DIR" -xdev -path "$SERVICE_TREE" -prune -o -type d -exec setfacl -k -- {} +',
    );
    expect(linuxPostinstall).toContain(
      'find "$DATA_DIR" -xdev \\( -path "$SHARED_DIR" -o -path "$SERVICE_TREE" \\) -prune -o \\\n  ! -type l -exec chmod go-rwx {} +',
    );
    expect(linuxPostinstall).toContain('chmod 711 "$DATA_DIR"');
    expect(linuxPostinstall).toContain('chmod 755 "$DATA_DIR/runtime"');
    expect(linuxPostinstall).toContain('chmod 700 "$DATA_DIR/logs"');
    expect(linuxPostinstall).toContain('find "$ASSETS_DIR" -xdev -type d -exec chmod 755 {} +');
    expect(linuxPostinstall).toContain('find "$ASSETS_DIR" -xdev -type f -exec chmod 644 {} +');
    expect(linuxPostinstall).toContain('--source="$DATA_DIR"');
    expect(linuxPostinstall).toContain('--dest="$SHARED_DIR"');
    expect(linuxPostinstall).toContain('chmod 3777 "$SHARED_DIR"');
    expect(linuxPostinstall).toContain('.gezel-machine-shared-v1.json');
    expect(linuxUnit).toContain('InaccessiblePaths=/var/lib/gezel/shared');
    expect(linuxPostinstall).toContain('"$DATA_DIR/runtime/auth-token"');
    expect(linuxPostinstall).toContain('"$DATA_DIR/runtime/service-role"');

    const stop = position(linuxPostinstall, 'systemctl stop gezeld.service');
    const inactiveGate = position(linuxPostinstall, 'while service_still_active; do');
    const migration = position(linuxPostinstall, 'find "$DATA_DIR" -xdev');
    const sharedMigration = position(
      linuxPostinstall,
      'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$MIGRATE_SHARED_CLI"',
    );
    const extraction = position(
      linuxPostinstall,
      'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$EXTRACT_CLI"',
    );
    expect(linuxPostinstall.slice(inactiveGate, migration)).toContain('exit 1');
    expect(linuxPostinstall).toContain('active|activating|reloading|deactivating');
    expect(stop).toBeLessThan(migration);
    expect(stop).toBeLessThan(inactiveGate);
    expect(inactiveGate).toBeLessThan(migration);
    expect(inactiveGate).toBeLessThan(sharedMigration);
    expect(sharedMigration).toBeLessThan(migration);
    expect(migration).toBeLessThan(extraction);
  });

  it('publishes the service tree read-only so user daemons can run it without rewriting it', () => {
    // The tree is product code — the same bytes as the world-readable tarball
    // in /opt and inside Gezel.app — so making it readable exposes nothing new,
    // and it is what lets each account's user daemon execute this copy instead
    // of unpacking a byte-identical second one into its own home.
    //
    // Writability is the property that must not move. A tree an interactive
    // account could rewrite, executed by a service daemon, is an escalation;
    // `go=u-w` grants group and other exactly the owner's access minus write,
    // so exec bits survive and only the service account can modify anything.
    // supervisor/shared-service-tree.ts independently refuses to adopt a tree
    // that fails this at runtime, but the installer must not produce one.
    for (const script of [linuxPostinstall, macPostinstall]) {
      expect(script).toContain('chmod go=u-w {} +');
      expect(script).not.toContain('chmod go+w');
      expect(script).not.toContain('chmod a+w');
    }
    expect(linuxPostinstall).toContain(
      'find "$SERVICE_TREE" -xdev \\\n  -exec chown --no-dereference "$GEZEL_USER:$GEZEL_USER" -- {} + \\\n  ! -type l -exec chmod go=u-w {} +',
    );
    expect(macPostinstall).toContain(
      'find -x "$SERVICE_TREE" -exec chown -h "${DAEMON_USER}:${DAEMON_USER}" {} +',
    );
    // macOS inherited ACLs survive a mode change, so they must be stripped
    // before the tree is published rather than after.
    expect(macPostinstall).toContain('find -x "$SERVICE_TREE" ! -type l -exec chmod -N {} +');
    expect(
      position(macPostinstall, 'find -x "$SERVICE_TREE" ! -type l -exec chmod -N {} +'),
    ).toBeLessThan(
      position(macPostinstall, 'find -x "$SERVICE_TREE" ! -type l -exec chmod go=u-w {} +'),
    );
    // The private-state sweeps must not run over it: they would both undo the
    // publication and traverse ~33k files that step 2b is about to replace.
    for (const script of [linuxPostinstall, macPostinstall]) {
      expect(script).toContain('-path "$SERVICE_TREE" -prune');
    }
    // Publication happens after extraction, never before — otherwise the modes
    // would apply to the tree being thrown away.
    expect(position(linuxPostinstall, '--dest="$SERVICE_TREE"')).toBeLessThan(
      position(linuxPostinstall, 'chmod go=u-w {} +'),
    );
    expect(position(macPostinstall, '--dest="$SERVICE_TREE"')).toBeLessThan(
      position(macPostinstall, 'chmod go=u-w {} +'),
    );
  });

  it('rejects installer-owned symlinks and gives systemd the same private umask', () => {
    expect(linuxPostinstall).toContain('if [ -L "$path" ]');
    expect(linuxPostinstall).toContain('assert_not_symlink "$DATA_DIR"');
    expect(linuxPostinstall).toContain('assert_not_symlink "$DATA_DIR/runtime"');
    expect(linuxPostinstall).toContain('assert_not_symlink "$ASSETS_DIR/models"');
    expect(linuxPostinstall).toContain('assert_not_symlink "$SERVICE_TREE"');
    expect(linuxPostinstall).toContain('[ ! -f "$UNIT_SRC" ] || [ -L "$UNIT_SRC" ]');
    expect(linuxPostinstall).toContain(
      'assert_not_symlink "$UNIT_DST" "Gezel systemd unit target"',
    );
    expect(position(linuxPostinstall, 'assert_not_symlink "$UNIT_DST"')).toBeLessThan(
      position(linuxPostinstall, 'systemctl stop gezeld.service'),
    );
    expect(linuxPostinstall).toContain('install -o root -g root -m 0644 "$UNIT_SRC" "$UNIT_DST"');
    expect(linuxUnit).toContain('UMask=0077');
    expect(linuxUnit).toContain('Environment=GEZEL_PORT=6228');
    expect(linuxUnit).toContain('Environment=GEZEL_SERVICE_ROLE=machine-engine');
    expect(linuxUnit).not.toContain('Environment=GEZEL_UI_DIR=');
    expect(linuxUnit).toContain('Environment=GEZEL_SHARED_ASSETS_DIR=/var/lib/gezel/assets');
  });

  it('isolates public desktop caches from the private installer umask', () => {
    const installRefresh = shellFunction(linuxPostinstall, 'refresh_desktop_caches');
    const removeRefresh = shellFunction(linuxPostremove, 'refresh_desktop_caches');

    expect(position(linuxPostinstall, 'umask 077')).toBeLessThan(
      position(linuxPostinstall, 'refresh_desktop_caches() ('),
    );
    for (const refresh of [installRefresh, removeRefresh]) {
      expect(refresh).toContain('umask 022');
      expect(refresh).not.toContain('umask 077');
      expect(refresh).toContain('update-mime-database "$MIME_DATABASE_DIR"');
      expect(refresh).toContain('update-desktop-database "$APPLICATIONS_DATABASE_DIR"');
      expect(refresh).toContain('gtk-update-icon-cache -f -t "$HICOLOR_THEME_DIR"');
    }

    expect(linuxPostinstall.match(/^refresh_desktop_caches$/gm)).toHaveLength(1);
    expect(linuxPostremove.match(/^refresh_desktop_caches$/gm)).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'actually creates public cache output under 022 without leaking that umask',
    () => {
      const probeRoot = mkdtempSync(join(tmpdir(), 'gezel-linux-cache-umask-'));
      const probeBin = join(probeRoot, 'bin');
      const outputDir = join(probeRoot, 'output');

      try {
        mkdirSync(probeBin, { recursive: true });
        mkdirSync(outputDir, { recursive: true });
        const probe = '#!/bin/sh\n: > "$CACHE_PROBE_DIR/${0##*/}"\n';
        for (const command of [
          'update-mime-database',
          'update-desktop-database',
          'gtk-update-icon-cache',
        ]) {
          const commandPath = join(probeBin, command);
          writeFileSync(commandPath, probe);
          chmodSync(commandPath, 0o755);
        }

        const script = `${shellFunction(linuxPostinstall, 'refresh_desktop_caches')}
PATH=$PROBE_BIN
MIME_DATABASE_DIR=/unused/mime
APPLICATIONS_DATABASE_DIR=/unused/applications
HICOLOR_THEME_DIR=/unused/hicolor
umask 077
refresh_desktop_caches
: > "$CACHE_PROBE_DIR/after-refresh"
`;
        execFileSync('/bin/sh', ['-c', script], {
          env: {
            ...process.env,
            CACHE_PROBE_DIR: outputDir,
            PROBE_BIN: probeBin,
          },
        });

        for (const command of [
          'update-mime-database',
          'update-desktop-database',
          'gtk-update-icon-cache',
        ]) {
          expect(statSync(join(outputDir, command)).mode & 0o777).toBe(0o644);
        }
        expect(statSync(join(outputDir, 'after-refresh')).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(probeRoot, { recursive: true, force: true });
      }
    },
  );

  it('does destructive removal only for final dpkg and RPM removals', () => {
    expect(linuxPostremove).toContain('DPKG_MAINTSCRIPT_NAME');
    expect(linuxPostremove).toContain('remove|purge|disappear');
    expect(linuxPostremove).toContain('0|remove|purge|disappear');
    expect(linuxPostremove).not.toContain("''|0|remove|purge|disappear");
    expect(linuxPostremove).toContain('package upgrade/rollback detected');

    const guard = position(linuxPostremove, 'if ! is_final_removal "${1:-}"; then');
    expect(guard).toBeLessThan(position(linuxPostremove, 'systemctl disable --now gezeld.service'));
    expect(guard).toBeLessThan(position(linuxPostremove, 'rm -f "$UNIT_DST"'));
    expect(guard).toBeLessThan(position(linuxPostremove, 'update-alternatives --remove'));
  });

  it.skipIf(process.platform === 'win32')(
    'classifies real dpkg and RPM removal actions conservatively',
    () => {
      const script = `${shellFunction(linuxPostremove, 'is_final_removal', 'brace')}
if is_final_removal "$1"; then
  printf final
else
  printf preserve
fi
`;
      const classify = (action: string, dpkg = false) =>
        execFileSync('/bin/sh', ['-c', script, 'gezel-remove-test', action], {
          encoding: 'utf8',
          env: {
            ...process.env,
            DPKG_MAINTSCRIPT_NAME: dpkg ? 'postrm' : '',
          },
        });

      for (const action of ['remove', 'purge', 'disappear']) {
        expect(classify(action, true)).toBe('final');
      }
      for (const action of ['', 'upgrade', 'failed-upgrade', 'abort-install', 'abort-upgrade']) {
        expect(classify(action, true)).toBe('preserve');
      }
      expect(classify('0')).toBe('final');
      for (const action of ['', '1', '2', 'upgrade', 'failed-upgrade']) {
        expect(classify(action)).toBe('preserve');
      }
    },
  );

  it('never overwrites an unrelated command while registering the CLI', () => {
    expect(linuxPostinstall).toContain('if [ ! -L "$COMMAND_LINK" ]; then');
    expect(linuxPostinstall).toContain('refusing to replace an existing non-symlink');
    expect(linuxPostinstall).toContain('refusing to replace an unrelated symlink');
    expect(linuxPostinstall).toContain('"$ELECTRON_EXE")');
    expect(linuxPostinstall).toContain('"$ALTERNATIVES_LINK")');
    expect(linuxPostinstall).toContain(
      'update-alternatives --install "$COMMAND_LINK" gezel "$ELECTRON_EXE" 100',
    );
    expect(linuxPostinstall).not.toMatch(/update-alternatives --install[^\n]*\|\|/);
    expect(linuxPostinstall).not.toMatch(/^\s*ln -sf\b/m);

    expect(linuxPostremove).toContain('update-alternatives --remove gezel "$ELECTRON_EXE"');
    expect(linuxPostremove).toContain('[ -L "$COMMAND_LINK" ]');
    expect(linuxPostremove).toContain('rm -f "$COMMAND_LINK"');
  });

  it('preserves Chromium sandbox and AppArmor setup in the custom package hooks', () => {
    expect(linuxPostinstall).toContain('update-alternatives --install');
    expect(linuxPostinstall).toContain('CHROME_SANDBOX=/opt/Gezel/chrome-sandbox');
    expect(linuxPostinstall).toContain('chown root:root "$CHROME_SANDBOX"');
    expect(linuxPostinstall).toContain('unshare --user true');
    expect(linuxPostinstall).toContain('chmod 0755 "$CHROME_SANDBOX"');
    expect(linuxPostinstall).toContain('chmod 4755 "$CHROME_SANDBOX"');
    expect(linuxPostinstall).toContain(
      'APPARMOR_PROFILE_SOURCE=/opt/Gezel/resources/apparmor-profile',
    );
    expect(linuxPostinstall).toContain('APPARMOR_PROFILE_TARGET=/etc/apparmor.d/gezel');
    expect(linuxPostinstall).toContain('apparmor_parser --skip-kernel-load --debug');
    expect(linuxPostinstall).toContain('apparmor_parser --replace --write-cache --skip-read-cache');
    expect(linuxPostinstall).toContain('refresh_desktop_caches');

    expect(linuxPostremove).toContain('update-alternatives --remove gezel "$ELECTRON_EXE"');
    expect(linuxPostremove).toContain('apparmor_parser --remove "$APPARMOR_PROFILE_TARGET"');
    expect(linuxPostremove).toContain('rm -f "$APPARMOR_PROFILE_TARGET"');
    expect(linuxPostremove).toContain('refresh_desktop_caches');
  });
});
