import { type SpawnSyncReturns, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
    const privateRepairStart = position(macPostinstall, 'find -x "$DATA_DIR" \\');
    const privateRepairEnd = position(macPostinstall, 'chmod 711 "$DATA_DIR"');
    const privateRepair = macPostinstall.slice(privateRepairStart, privateRepairEnd);
    expect(privateRepair).toContain('-path "$SERVICE_TREE"');
    expect(privateRepair).toContain('-path "${SERVICE_TREE}.previous"');
    expect(privateRepair).toContain('-path "${SERVICE_TREE}.staging-*"');
    expect(privateRepair).toContain('-path "$ASSETS_DIR"');
    expect(privateRepair).toContain('-exec chown -h "${DAEMON_USER}:${DAEMON_USER}" {} +');
    expect(privateRepair).toContain('! -type l -exec chmod -N {} +');
    expect(privateRepair).toContain('-exec chmod go-rwx {} +');
    expect(privateRepair.match(/find -x/g)).toHaveLength(1);
    expect(macPostinstall).not.toContain('chmod -RN "$DATA_DIR"');
    expect(macPostinstall).not.toContain('chown -R');
    expect(macPostinstall).toContain('chmod 711 "$DATA_DIR"');
    expect(macPostinstall).toContain('chmod 755 "$DATA_DIR/runtime"');
    expect(macPostinstall).toContain('chmod 700 "$DATA_DIR/logs"');
    expect(privateRepair).toContain('\\( -type f -links +1 \\) -prune -o');
    const assets = shellFunction(macPostinstall, 'harden_shared_assets', 'brace');
    expect(assets).toContain('find -x "$ASSETS_DIR" \\');
    expect(assets).toContain('\\( -type f -links +1 \\) -prune -o');
    expect(assets).toContain('-exec chown -h "${DAEMON_USER}:${DAEMON_USER}" {} +');
    expect(assets).toContain(
      '\\( -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} + \\)',
    );
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
    const privateRepairPosition = position(macPostinstall, 'find -x "$DATA_DIR"');
    const extraction = position(
      macPostinstall,
      'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$EXTRACT_CLI"',
    );
    expect(macPostinstall.slice(inactiveGate, extraction)).toContain('exit 1');
    expect(stop).toBeLessThan(privateRepairPosition);
    expect(stop).toBeLessThan(inactiveGate);
    expect(inactiveGate).toBeLessThan(privateRepairPosition);
    expect(inactiveGate).toBeLessThan(sharedMigration);
    expect(sharedMigration).toBeLessThan(extraction);
    expect(extraction).toBeLessThan(privateRepairPosition);
    expect(macPostinstall).toContain('available_kib=$(df -Pk "$DATA_DIR"');
    expect(macPostinstall).toContain('[ "$available_kib" -lt 10485760 ]');
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
    // A user daemon may have acquired 6228 while the machine service was down.
    // An unset override preserves the daemon's prefer-canonical + fallback path.
    expect(macPlist).not.toContain('<key>GEZEL_PORT</key>');
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
    expect(macPostinstall).toContain('SERVICE_HEALTH_TIMEOUT=180');
    expect(macPostinstall).toContain('SECONDS + SERVICE_HEALTH_TIMEOUT');
    expect(macPostinstall).toContain('waiting for service health');
    expect(macPostinstall).toContain('launchctl kickstart "system/${DAEMON_LABEL}"');
    expect(macPostinstall).not.toContain('launchctl kickstart -k');
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

  it('removes Office add-in registrations for every account, as that account', () => {
    expect(macUninstall).toContain(
      'remove_all_user_office_addins\nremove_target_user_office_certificate',
    );
    expect(macUninstall).toContain(
      'for container in com.microsoft.Word com.microsoft.Excel com.microsoft.Powerpoint',
    );
    expect(macUninstall).toContain(
      `/usr/bin/sudo -H -u "$username" /usr/bin/find "$wef" -maxdepth 1 -type f`,
    );
    expect(macUninstall).toContain(`-name 'gezel-*.xml' -delete`);
    // The certificate authority leaves the uninstalling user's Keychain by
    // exact fingerprint, inside that user's session, and never blocks the uninstall.
    expect(macUninstall).toContain('/usr/bin/security delete-certificate -Z "$sha1" "$keychain"');
    expect(macUninstall).toContain('[[ "$sha1" =~ ^[0-9A-Fa-f]{40}$ ]] || return 0');
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

  it('validates wait pids before numeric comparison', () => {
    const validator = shellFunction(macUninstall, 'valid_wait_pid', 'brace');
    expect(validator).toContain('[[ "$1" =~ ^[0-9]+$ ]]');
    expect(validator).toContain('[ "$1" -gt 1 ]');
    expect(macUninstall).toContain('! valid_wait_pid "$WAIT_FOR_PID"');
  });

  it.skipIf(process.platform === 'win32')(
    'live probe: rejects non-numeric and unsafe wait pids',
    () => {
      const validator = shellFunction(macUninstall, 'valid_wait_pid', 'brace');
      const probe = `${validator}
for value in nope 0 1 2 4321; do
  if valid_wait_pid "$value"; then printf 'valid:%s\\n' "$value"; else printf 'invalid:%s\\n' "$value"; fi
done`;
      const output = execFileSync('/bin/bash', ['-c', probe], { encoding: 'utf8' });
      expect(output.trim().split('\n')).toEqual([
        'invalid:nope',
        'invalid:0',
        'invalid:1',
        'valid:2',
        'valid:4321',
      ]);
    },
  );

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
    expect(macUninstall).toContain('Ask an administrator to inspect and remove the _gezeld user');
    expect(macUninstall).not.toContain('item 1 of argv');
    expect(macUninstall).not.toContain('The complete log is at');
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
    // One walk definition for every private-state pass, so none of them can
    // drift back into the shared tree, the service tree, or a hard link.
    const walk = shellFunction(linuxPostinstall, 'private_state_find', 'brace');
    expect(walk).toContain('find "$DATA_DIR" -xdev');
    expect(walk).toContain(
      '\\( -path "$SHARED_DIR" -o -path "$SERVICE_TREE" -o -path "$SERVICE_TREE.previous" -o -path "$SERVICE_TREE.staging-*" \\) -prune -o',
    );
    expect(walk).toContain('\\( -type f -links +1 \\) -prune -o');
    const harden = shellFunction(linuxPostinstall, 'harden_private_state', 'brace');
    expect(harden).toContain(
      'private_state_find -exec chown --no-dereference "$GEZEL_USER:$GEZEL_USER" -- {} +',
    );
    expect(linuxPostinstall).not.toContain('chown -R');
    expect(harden).toContain('private_state_find ! -type l -exec setfacl -b -- {} +');
    expect(harden).toContain('private_state_find -type d -exec setfacl -k -- {} +');
    expect(harden).toContain('private_state_find ! -type l -exec chmod go-rwx {} +');
    expect(harden.match(/^\s*find "\$DATA_DIR"/gm) ?? []).toEqual([]);
    expect(harden).toContain('chmod 711 "$DATA_DIR"');
    expect(harden).toContain('chmod 755 "$DATA_DIR/runtime"');
    expect(harden).toContain('chmod 700 "$DATA_DIR/logs"');
    expect(harden).toContain('find "$ASSETS_DIR" -xdev -type d -exec chmod 755 {} +');
    expect(harden).toContain('find "$ASSETS_DIR" -xdev -type f -links 1 -exec chmod 644 {} +');
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
    // account could rewrite, executed by a service daemon, is an escalation.
    // Linux publishes with `go=u-w`; macOS extracts directly as 0644/0755.
    // supervisor/shared-service-tree.ts independently refuses to adopt a tree
    // that fails this at runtime, but the installer must not produce one.
    for (const script of [linuxPostinstall, macPostinstall]) {
      expect(script).not.toContain('chmod go+w');
      expect(script).not.toContain('chmod a+w');
    }
    // Root's, not the service account's: every account's daemon executes this
    // tree, and the service account parses untrusted model files.
    const linuxPublish = shellFunction(linuxPostinstall, 'publish_service_tree', 'brace');
    expect(linuxPublish).toContain(
      'find "$SERVICE_TREE" -xdev \\\n    -exec chown --no-dereference root:root -- {} + \\\n    ! -type l -exec setfacl -b -- {} + \\\n    -exec chmod go=u-w {} +',
    );
    // macOS now normalizes modes and clears inherited ACLs in the extractor,
    // before publishing, without a second per-file metadata mutation pass.
    expect(macPostinstall).toContain('--force \\\n  --shared-readonly');
    expect(macPostinstall).not.toContain('find -x "$SERVICE_TREE"');
    expect(linuxUnit).toContain('ReadOnlyPaths=/var/lib/gezel/service');
    // The private-state sweeps must not run over it: they would both undo the
    // publication and traverse ~33k files that step 2b is about to replace.
    expect(linuxPostinstall).toContain('-path "$SERVICE_TREE" -o');
    expect(macPostinstall).toContain('-path "$SERVICE_TREE" -o');
    // Publication happens after extraction, never before — otherwise the modes
    // would apply to the tree being thrown away.
    expect(position(linuxPostinstall, '--dest="$SERVICE_TREE"')).toBeLessThan(
      position(linuxPostinstall, 'chmod go=u-w {} +'),
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

/**
 * Both hooks run as root on every install and upgrade. A root chown, chmod, or
 * setfacl by path over a tree another account can write can be steered onto a
 * system file: through a hard link that account made to a file it does not
 * own, or a symlink swapped in between the check and the change.
 */
describe('root permission passes over writable trees', () => {
  const hooks = [
    { name: 'linux', script: linuxPostinstall, stoppedAfter: 'while service_still_active; do' },
    { name: 'macos', script: macPostinstall, stoppedAfter: 'remained loaded after bootout' },
  ] as const;

  it('stops everything running as the service account before the first root pass', () => {
    for (const { name, script, stoppedAfter } of hooks) {
      const stop = position(script, '\nstop_service_account_processes\n');
      expect(position(script, stoppedAfter), name).toBeLessThan(stop);
      for (const pass of [
        'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$MIGRATE_SHARED_CLI"',
        'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$EXTRACT_CLI"',
        '\nharden_private_state\n',
        '\npublish_shared_data\n',
      ]) {
        expect(stop, `${name}: ${pass.trim()}`).toBeLessThan(position(script, pass));
      }
    }
    expect(position(linuxPostinstall, '\nstop_service_account_processes\n')).toBeLessThan(
      position(linuxPostinstall, '\npublish_service_tree\n'),
    );
    expect(shellFunction(linuxPostinstall, 'stop_service_account_processes', 'brace')).toContain(
      'kill -KILL $account_pids',
    );
    // A uid is not an account: a container's uid-999 database or, in a chroot
    // image build, a host account that happens to share the number must be
    // left alone. Only root can put a process in another PID namespace or
    // root while it keeps our user namespace, so that is the one exception.
    const listPids = shellFunction(linuxPostinstall, 'service_account_pids', 'brace');
    for (const probe of ['/ns/user', '/ns/pid', "stat -L -c '%d:%i'"]) {
      expect(listPids, probe).toContain(probe);
    }
    expect(listPids).toContain('[ "$their_user_ns" = "$own_user_ns" ]');
    const macStop = shellFunction(macPostinstall, 'stop_service_account_processes', 'brace');
    expect(macStop).toContain('/usr/bin/pkill -KILL -U "$DAEMON_USER"');
    expect(macStop).toContain('/usr/bin/pkill -KILL -u "$DAEMON_USER"');
    // An unreadable process list must not read as an empty one.
    expect(shellFunction(macPostinstall, 'service_account_running', 'brace')).toContain(
      'cannot list processes running as ${DAEMON_USER}',
    );
  });

  it('refuses a shared root that root did not create, before migrating into it', () => {
    for (const { name, script } of hooks) {
      const refusal = position(script, 'is not a root-owned directory; refusing to migrate into');
      expect(refusal, name).toBeLessThan(
        position(script, 'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE" "$MIGRATE_SHARED_CLI"'),
      );
    }
    expect(linuxPostinstall).toContain('[ "$(stat -c %u -- "$SHARED_DIR")" != 0 ]');
    expect(macPostinstall).toContain('[ "$(stat -f %u "$SHARED_DIR")" != 0 ]');
  });

  it('never walks the collaborative shared tree as root', () => {
    for (const { name, script } of hooks) {
      expect(script, name).not.toMatch(/find (-x )?"\$SHARED_DIR"/);
      expect(script, name).not.toMatch(/find (-x )?"\$scope_dir"/);
      const publish = shellFunction(script, 'publish_migrated_entity');
      expect(publish).toContain('cd -P -- "$scope_dir/$name"');
      expect(publish).toContain(
        '[ "$(pwd -P)" = "$shared_physical/${scope_dir##*/}/$name" ] || exit 0',
      );
      expect(publish).toContain('case $2 in *00) ;; *) exit 0 ;; esac');
      expect(publish).toMatch(/find (-x )?\. (-xdev )?-mindepth 1/);
      // Once the walk is done, only `.` — the pinned directory — changes.
      const afterWalk = publish.slice(publish.lastIndexOf('{} +'));
      const tail = afterWalk.split('\n').slice(1, -1);
      expect(tail.length, name).toBeGreaterThan(0);
      for (const line of tail) expect(line.trim(), name).toMatch(/ \.$/);
    }
  });

  it('skips hard-linked files in every pass over service-account state', () => {
    expect(shellFunction(linuxPostinstall, 'private_state_find', 'brace')).toContain(
      '\\( -type f -links +1 \\) -prune -o',
    );
    expect(shellFunction(linuxPostinstall, 'harden_private_state', 'brace')).toContain(
      '-type f -links 1 -exec chmod 644 {} +',
    );
    for (const name of ['harden_private_state', 'harden_shared_assets']) {
      expect(shellFunction(macPostinstall, name, 'brace')).toContain(
        '\\( -type f -links +1 \\) -prune -o',
      );
    }
  });
});

const linuxOnly = process.platform === 'linux' ? it : it.skip;
const darwinOnly = process.platform === 'darwin' ? it : it.skip;

interface InstallerProbe {
  root: string;
  /** One line per argument each logged chown/setfacl call received. */
  privileged(): string[];
  run(shell: string, script: string, env: Record<string, string>): SpawnSyncReturns<string>;
  cleanup(): void;
}

/**
 * A scratch tree for running installer functions as the test account.
 *
 * `chown` and `setfacl` are logged rather than run: the account running the
 * suite cannot give files to root, and ACL tooling is not installed
 * everywhere. `stat` reports the fixture's own files as root's, which is what
 * the hooks see on a real machine. `chmod`, `find`, and `cd` are real, so a
 * pass that follows a link changes the linked file and the test sees it.
 */
function installerProbe(): InstallerProbe {
  const root = mkdtempSync(join(tmpdir(), 'gezel-installer-probe-'));
  const bin = join(root, 'shim-bin');
  const log = join(root, 'privileged.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  for (const command of ['chown', 'setfacl']) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\nfor arg in "$@"; do printf '%s %s\\n' '${command}' "$arg"; done >> "$PROBE_LOG"\n`,
      { mode: 0o755 },
    );
  }
  const realStat = execFileSync('/bin/sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'stat'),
    `#!/bin/sh\nout=$('${realStat}' "$@") || exit $?\nprintf '%s\\n' "$out" | awk -v uid="$FIXTURE_UID" '$1 == uid { $1 = 0 } { print }'\n`,
    { mode: 0o755 },
  );
  return {
    root,
    privileged: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    run: (shell, script, env) =>
      spawnSync(shell, ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:/usr/sbin:/usr/bin:/sbin:/bin`,
          PROBE_LOG: log,
          FIXTURE_UID: String(process.getuid?.() ?? 0),
          ...env,
        },
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function file(path: string, mode: number): string {
  writeFileSync(path, `${path}\n`);
  chmodSync(path, mode);
  return path;
}

function dir(path: string, mode: number): string {
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
  return path;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o7777;
}

function assignment(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}=.*$`, 'm'));
  expect(match, `missing installer assignment: ${name}`).not.toBeNull();
  return match?.[0] ?? '';
}

describe('Linux root permission passes, live', () => {
  linuxOnly('repairs service-account state without acting through links', () => {
    const probe = installerProbe();
    try {
      const outside = dir(join(probe.root, 'outside'), 0o755);
      const linked = file(join(outside, 'linked'), 0o644);
      const target = file(join(outside, 'target'), 0o644);
      const asset = file(join(outside, 'asset'), 0o600);
      const data = dir(join(probe.root, 'data'), 0o755);
      for (const sub of ['runtime', 'logs', 'assets/models', 'private'])
        dir(join(data, sub), 0o755);
      const privateFile = file(join(data, 'private', 'file'), 0o644);
      linkSync(linked, join(data, 'private', 'hard'));
      symlinkSync(target, join(data, 'private', 'sym'));
      const model = file(join(data, 'assets', 'models', 'model.bin'), 0o600);
      linkSync(asset, join(data, 'assets', 'models', 'hard.bin'));
      const untouched = ['shared', 'service', 'service.previous', 'service.staging-1-x'].map(
        (sub) => file(join(dir(join(data, sub), 0o755), 'kept'), 0o644),
      );

      const result = probe.run(
        '/bin/sh',
        `set -eu
${shellFunction(linuxPostinstall, 'private_state_find', 'brace')}
${shellFunction(linuxPostinstall, 'harden_private_state', 'brace')}
harden_private_state
`,
        {
          DATA_DIR: data,
          SHARED_DIR: join(data, 'shared'),
          SERVICE_TREE: join(data, 'service'),
          ASSETS_DIR: join(data, 'assets'),
          GEZEL_USER: '4242',
        },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(modeOf(linked)).toBe(0o644);
      expect(modeOf(target)).toBe(0o644);
      expect(modeOf(asset)).toBe(0o600);
      expect(modeOf(privateFile)).toBe(0o600);
      expect(modeOf(model)).toBe(0o644);
      expect(modeOf(data)).toBe(0o711);
      expect(modeOf(join(data, 'runtime'))).toBe(0o755);
      expect(modeOf(join(data, 'logs'))).toBe(0o700);
      for (const kept of untouched) expect(modeOf(kept), kept).toBe(0o644);
      const privileged = probe.privileged();
      expect(privileged.some((line) => line.endsWith('/private/file'))).toBe(true);
      for (const line of privileged) {
        expect(line).not.toMatch(/\/hard(\.bin)?$/);
        expect(line).not.toMatch(/\/(shared|service[^/]*)\//);
        if (line.startsWith('setfacl')) expect(line).not.toMatch(/\/sym$/);
      }
    } finally {
      probe.cleanup();
    }
  });

  linuxOnly('publishes only the private entities root placed, anchored to each directory', () => {
    const probe = installerProbe();
    try {
      const outside = dir(join(probe.root, 'outside'), 0o755);
      const target = file(join(outside, 'target'), 0o644);
      const privateDir = dir(join(outside, 'private-dir'), 0o700);
      const secret = file(join(privateDir, 'secret'), 0o600);
      const shared = dir(join(probe.root, 'shared'), 0o700);
      const marker = file(join(shared, '.gezel-machine-shared-v1.json'), 0o600);
      const projects = dir(join(shared, 'projects'), 0o700);
      // Freshly migrated: private, and root's (or the service account's).
      const legacy = dir(join(projects, 'legacy'), 0o700);
      const legacyFile = file(join(legacy, 'a.txt'), 0o600);
      const legacySub = dir(join(legacy, 'sub'), 0o700);
      const legacyScript = file(join(legacySub, 'run.sh'), 0o700);
      linkSync(target, join(legacy, 'hard'));
      symlinkSync(target, join(legacy, 'sym'));
      // Already published: any account may have put anything in it.
      const published = dir(join(projects, 'published'), 0o777);
      const mine = file(join(published, 'mine.txt'), 0o600);
      symlinkSync(target, join(published, 'evil'));
      // An entity name another account pointed at a private directory.
      symlinkSync(privateDir, join(projects, 'swapped'));
      const oddName = dir(join(projects, 'bad name'), 0o700);
      const oddFile = file(join(oddName, 'x.txt'), 0o600);
      const isRoot = process.getuid?.() === 0;
      const foreign = isRoot ? dir(join(projects, 'foreign'), 0o700) : null;
      const foreignFile = foreign ? file(join(foreign, 'x.txt'), 0o600) : null;
      if (foreign && foreignFile) {
        for (const path of [foreign, foreignFile]) execFileSync('chown', ['4343:4343', path]);
      }

      const result = probe.run(
        '/bin/sh',
        `set -eu
${assignment(linuxPostinstall, 'SHARED_DEFAULT_ACL')}
${shellFunction(linuxPostinstall, 'publish_migrated_entity')}
${shellFunction(linuxPostinstall, 'publish_shared_data', 'brace')}
publish_shared_data
`,
        { SHARED_DIR: shared, GEZEL_USER: '4242', account_uid: '4242' },
      );

      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.stdout).toContain('publishing migrated shared entity projects/legacy');
      expect(result.stdout).not.toContain('projects/published');
      expect(result.stderr).toContain('hard-linked files in projects/legacy stay private');
      expect(modeOf(target)).toBe(0o644);
      expect(modeOf(privateDir)).toBe(0o700);
      expect(modeOf(secret)).toBe(0o600);
      expect(modeOf(shared)).toBe(0o3777);
      expect(modeOf(projects)).toBe(0o2777);
      expect(modeOf(legacy)).toBe(0o2777);
      expect(modeOf(legacyFile)).toBe(0o666);
      expect(modeOf(legacySub)).toBe(0o2777);
      expect(modeOf(legacyScript)).toBe(0o777);
      expect(modeOf(mine)).toBe(0o600);
      expect(modeOf(oddName)).toBe(0o700);
      expect(modeOf(oddFile)).toBe(0o600);
      if (foreign && foreignFile) {
        expect(modeOf(foreign)).toBe(0o700);
        expect(modeOf(foreignFile)).toBe(0o600);
      }
      expect(modeOf(marker)).toBe(0o644);
      for (const line of probe.privileged()) {
        expect(line).not.toMatch(/outside|published|swapped|bad name|foreign|\/hard$/);
      }
    } finally {
      probe.cleanup();
    }
  });

  linuxOnly('refuses to re-own a shared marker that is not a plain root file', () => {
    const probe = installerProbe();
    try {
      const target = file(join(probe.root, 'target'), 0o600);
      const shared = dir(join(probe.root, 'shared'), 0o700);
      symlinkSync(target, join(shared, '.gezel-machine-shared-v1.json'));

      const result = probe.run(
        '/bin/sh',
        `set -eu
${assignment(linuxPostinstall, 'SHARED_DEFAULT_ACL')}
${shellFunction(linuxPostinstall, 'publish_migrated_entity')}
${shellFunction(linuxPostinstall, 'publish_shared_data', 'brace')}
publish_shared_data
`,
        { SHARED_DIR: shared, GEZEL_USER: '4242', account_uid: '4242' },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('is not a root-owned regular file');
      expect(modeOf(target)).toBe(0o600);
    } finally {
      probe.cleanup();
    }
  });

  linuxOnly('publishes the service tree as root without following its links', () => {
    const probe = installerProbe();
    try {
      const target = file(join(probe.root, 'target'), 0o600);
      const tree = dir(join(probe.root, 'service'), 0o700);
      const bin = dir(join(tree, 'dist', 'bin'), 0o700);
      const entry = file(join(bin, 'gezeld.js'), 0o700);
      symlinkSync(target, join(tree, 'dist', 'link'));

      const result = probe.run(
        '/bin/sh',
        `set -eu
${shellFunction(linuxPostinstall, 'publish_service_tree', 'brace')}
publish_service_tree
`,
        { SERVICE_TREE: tree },
      );

      expect(result.status, String(result.stderr)).toBe(0);
      expect(modeOf(tree)).toBe(0o755);
      expect(modeOf(bin)).toBe(0o755);
      expect(modeOf(entry)).toBe(0o755);
      expect(modeOf(target)).toBe(0o600);
      expect(probe.privileged()).toContain('chown root:root');
      expect(probe.privileged().filter((line) => line.startsWith('setfacl'))).not.toContain(
        `setfacl ${join(tree, 'dist', 'link')}`,
      );
    } finally {
      probe.cleanup();
    }
  });

  linuxOnly('finds every live process of the service account', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const output = execFileSync(
        '/bin/sh',
        [
          '-c',
          `${shellFunction(linuxPostinstall, 'service_account_pids', 'brace')}\nservice_account_pids`,
        ],
        { encoding: 'utf8', env: { ...process.env, account_uid: String(process.getuid?.()) } },
      );
      expect(output.split('\n')).toContain(String(child.pid));
    } finally {
      child.kill('SIGKILL');
    }
  });

  /** Host pid of the `sleep <marker>` whose cmdline matches, waiting briefly for it. */
  async function sleeperPid(marker: string, launcher: { exitCode: number | null }) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          if (readFileSync(`/proc/${entry}/cmdline`, 'utf8') === `sleep\0${marker}\0`) return entry;
        } catch {
          /* exited while we looked */
        }
      }
      if (launcher.exitCode !== null) return null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  }

  const listServiceAccountPids = (uid: string) =>
    execFileSync(
      '/bin/sh',
      [
        '-c',
        `${shellFunction(linuxPostinstall, 'service_account_pids', 'brace')}\nservice_account_pids`,
      ],
      { encoding: 'utf8', env: { ...process.env, account_uid: uid } },
    ).split('\n');

  linuxOnly(
    'still finds a process of the account that moved itself into new namespaces',
    async () => {
      // What a compromised account can do without privilege: a user namespace
      // of its own and, inside it, a PID namespace — still on the host's files.
      const marker = String(31_000 + (process.pid % 1000));
      const launcher = spawn(
        'unshare',
        ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', 'sleep', marker],
        { stdio: 'ignore' },
      );
      const sleeper = await sleeperPid(marker, launcher);
      try {
        // A kernel that refuses unprivileged user namespaces leaves nothing to escape into.
        if (!sleeper) return;
        expect(listServiceAccountPids(String(process.getuid?.()))).toContain(sleeper);
      } finally {
        launcher.kill('SIGKILL');
        if (sleeper) process.kill(Number(sleeper), 'SIGKILL');
      }
    },
  );

  (process.platform === 'linux' && process.getuid?.() === 0 ? it : it.skip)(
    "spares a process that root placed in another PID namespace, like a container's (root only)",
    async () => {
      // Rootful Docker: a uid-999 postgres in its own PID namespace, still in
      // the host's user namespace. It shares the number, not the account.
      const onHost = spawn(
        'setpriv',
        ['--reuid=4243', '--regid=4243', '--clear-groups', 'sleep', '32061'],
        { stdio: 'ignore' },
      );
      const contained = spawn(
        'unshare',
        [
          '--pid',
          '--fork',
          '--mount-proc',
          'setpriv',
          '--reuid=4243',
          '--regid=4243',
          '--clear-groups',
          'sleep',
          '32062',
        ],
        { stdio: 'ignore' },
      );
      const hostPid = await sleeperPid('32061', onHost);
      const containedPid = await sleeperPid('32062', contained);
      try {
        const listed = listServiceAccountPids('4243');
        expect(listed).toContain(hostPid);
        expect(containedPid).not.toBeNull();
        expect(listed).not.toContain(containedPid);
      } finally {
        onHost.kill('SIGKILL');
        contained.kill('SIGKILL');
        if (containedPid) process.kill(Number(containedPid), 'SIGKILL');
      }
    },
  );

  (process.platform === 'linux' && process.getuid?.() === 0 ? it : it.skip)(
    'kills every process of the service account before returning (root only)',
    async () => {
      const child = spawn(
        'setpriv',
        ['--reuid=4242', '--regid=4242', '--clear-groups', 'sleep', '60'],
        { stdio: 'ignore' },
      );
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.on('exit', (_code, signal) => resolve(signal)),
      );
      try {
        // Wait until the helper has dropped to the account before asking.
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const uid = readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/^Uid:\s+(\d+)/m);
          if (uid?.[1] === '4242') break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const result = spawnSync(
          '/bin/sh',
          [
            '-c',
            `set -eu
${shellFunction(linuxPostinstall, 'service_account_pids', 'brace')}
${shellFunction(linuxPostinstall, 'stop_service_account_processes', 'brace')}
stop_service_account_processes
`,
          ],
          { encoding: 'utf8', env: { ...process.env, account_uid: '4242', GEZEL_USER: 'gezel' } },
        );
        expect(result.status, String(result.stderr)).toBe(0);
        expect(await exited).toBe('SIGKILL');
      } finally {
        child.kill('SIGKILL');
      }
    },
  );
});

describe('macOS root permission passes, live', () => {
  darwinOnly('publishes only the private entities root placed, anchored to each directory', () => {
    const probe = installerProbe();
    try {
      const outside = dir(join(probe.root, 'outside'), 0o755);
      const target = file(join(outside, 'target'), 0o644);
      const privateDir = dir(join(outside, 'private-dir'), 0o700);
      const shared = dir(join(probe.root, 'shared'), 0o700);
      const marker = file(join(shared, '.gezel-machine-shared-v1.json'), 0o600);
      const projects = dir(join(shared, 'projects'), 0o700);
      const legacy = dir(join(projects, 'legacy'), 0o700);
      const legacyFile = file(join(legacy, 'a.txt'), 0o600);
      const legacyScript = file(join(dir(join(legacy, 'sub'), 0o700), 'run.sh'), 0o700);
      linkSync(target, join(legacy, 'hard'));
      symlinkSync(target, join(legacy, 'sym'));
      const published = dir(join(projects, 'published'), 0o777);
      const mine = file(join(published, 'mine.txt'), 0o600);
      symlinkSync(privateDir, join(projects, 'swapped'));

      const result = probe.run(
        '/bin/bash',
        `set -eu
${assignment(macPostinstall, 'SHARED_EVERYONE_ACE')}
${shellFunction(macPostinstall, 'publish_migrated_entity')}
${shellFunction(macPostinstall, 'publish_shared_data', 'brace')}
publish_shared_data
`,
        { SHARED_DIR: shared, DAEMON_USER: 'nobody', daemon_uid: '4242' },
      );

      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.stdout).toContain('publishing migrated shared entity projects/legacy');
      expect(modeOf(target)).toBe(0o644);
      expect(modeOf(privateDir)).toBe(0o700);
      expect(modeOf(shared)).toBe(0o1777);
      expect(modeOf(legacy)).toBe(0o777);
      expect(modeOf(legacyFile)).toBe(0o666);
      expect(modeOf(legacyScript)).toBe(0o777);
      expect(modeOf(mine)).toBe(0o600);
      expect(modeOf(marker)).toBe(0o644);
      expect(probe.privileged()).toContain('chown root:wheel');
    } finally {
      probe.cleanup();
    }
  });
});
