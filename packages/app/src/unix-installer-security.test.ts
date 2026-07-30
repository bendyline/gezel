import { readFileSync } from 'node:fs';
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

const macPostinstall = installerFile('macos-pkg-scripts/postinstall');
const macPlist = installerFile('com.bendyline.gezeld.plist');
const linuxPostinstall = installerFile('linux/after-install.sh');
const linuxUnit = installerFile('gezeld.service');

describe('macOS machine-service filesystem security', () => {
  it('migrates private state while exposing runtime and read-only assets', () => {
    expect(macPostinstall).toContain('umask 077');
    expect(macPostinstall).toContain(
      'find -x "$DATA_DIR" -exec chown -h "${DAEMON_USER}:${DAEMON_USER}" {} +',
    );
    expect(macPostinstall).toContain('find -x "$DATA_DIR" ! -type l -exec chmod -N {} +');
    expect(macPostinstall).not.toContain('chmod -RN "$DATA_DIR"');
    expect(macPostinstall).not.toContain('chown -R');
    expect(macPostinstall).toContain('find -x "$DATA_DIR" ! -type l -exec chmod go-rwx {} +');
    expect(macPostinstall).toContain('chmod 711 "$DATA_DIR"');
    expect(macPostinstall).toContain('chmod 755 "$DATA_DIR/runtime"');
    expect(macPostinstall).toContain('chmod 700 "$DATA_DIR/logs"');
    expect(macPostinstall).toContain('find -x "$ASSETS_DIR" -type d -exec chmod 755 {} +');
    expect(macPostinstall).toContain('find -x "$ASSETS_DIR" -type f -exec chmod 644 {} +');
    expect(macPostinstall).toContain('"$DATA_DIR/runtime/auth-token"');

    const stop = position(macPostinstall, 'launchctl bootout "system/${DAEMON_LABEL}"');
    const inactiveGate = position(
      macPostinstall,
      'if launchctl print "system/${DAEMON_LABEL}" >/dev/null 2>&1; then',
    );
    const migration = position(macPostinstall, 'find -x "$DATA_DIR"');
    const extraction = position(macPostinstall, 'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE"');
    expect(macPostinstall.slice(inactiveGate, migration)).toContain('exit 1');
    expect(stop).toBeLessThan(migration);
    expect(stop).toBeLessThan(inactiveGate);
    expect(inactiveGate).toBeLessThan(migration);
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
    expect(macPostinstall).toContain('user_id_count=$(dscl . -list /Users UniqueID');
    expect(macPostinstall).toContain('group_id_count=$(dscl . -list /Groups PrimaryGroupID');
    expect(macPostinstall).toContain('[ "$user_id_count" -ne 1 ]');
    expect(macPostinstall).toContain('[ "$group_id_count" -ne 1 ]');
    expect(macPostinstall).toContain('abort_bad_service_identity()');
    expect(macPostinstall).toContain('launchctl disable "system/${DAEMON_LABEL}"');
    expect(macPostinstall).toContain('daemon_shell=$(dscl . -read');
    expect(macPostinstall).toContain('[ "$daemon_shell" != "/usr/bin/false" ]');
    expect(macPostinstall).toContain('[ "$daemon_home" != "/var/empty" ]');
    expect(macPostinstall).toContain(
      'daemon_hidden=$(dscl . -read "/Users/${DAEMON_USER}" IsHidden | awk \'$1 ~ /(^|:)IsHidden:$/ { print $2 }\')',
    );
    expect(macPostinstall).toContain('[ "$daemon_hidden" != "1" ]');
    expect(macPlist).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/);
    expect(macPlist).toMatch(/<key>GEZEL_PORT<\/key>\s*<string>43935<\/string>/);
    expect(macPlist).toMatch(
      /<key>GEZEL_SHARED_ASSETS_DIR<\/key>\s*<string>\/Library\/Application Support\/Gezel\/assets<\/string>/,
    );
  });
});

describe('Linux machine-service filesystem security', () => {
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
      'find "$DATA_DIR" -xdev -exec chown --no-dereference "$GEZEL_USER:$GEZEL_USER" -- {} +',
    );
    expect(linuxPostinstall).not.toContain('chown -R');
    expect(linuxPostinstall).toContain('find "$DATA_DIR" -xdev ! -type l -exec setfacl -b -- {} +');
    expect(linuxPostinstall).toContain('find "$DATA_DIR" -xdev -type d -exec setfacl -k -- {} +');
    expect(linuxPostinstall).toContain('find "$DATA_DIR" -xdev ! -type l -exec chmod go-rwx {} +');
    expect(linuxPostinstall).toContain('chmod 711 "$DATA_DIR"');
    expect(linuxPostinstall).toContain('chmod 755 "$DATA_DIR/runtime"');
    expect(linuxPostinstall).toContain('chmod 700 "$DATA_DIR/logs"');
    expect(linuxPostinstall).toContain('find "$ASSETS_DIR" -xdev -type d -exec chmod 755 {} +');
    expect(linuxPostinstall).toContain('find "$ASSETS_DIR" -xdev -type f -exec chmod 644 {} +');
    expect(linuxPostinstall).toContain('"$DATA_DIR/runtime/auth-token"');

    const stop = position(linuxPostinstall, 'systemctl stop gezeld.service');
    const inactiveGate = position(linuxPostinstall, 'while service_still_active; do');
    const migration = position(linuxPostinstall, 'find "$DATA_DIR" -xdev');
    const extraction = position(linuxPostinstall, 'ELECTRON_RUN_AS_NODE=1 "$ELECTRON_EXE"');
    expect(linuxPostinstall.slice(inactiveGate, migration)).toContain('exit 1');
    expect(linuxPostinstall).toContain('active|activating|reloading|deactivating');
    expect(stop).toBeLessThan(migration);
    expect(stop).toBeLessThan(inactiveGate);
    expect(inactiveGate).toBeLessThan(migration);
    expect(migration).toBeLessThan(extraction);
  });

  it('rejects installer-owned symlinks and gives systemd the same private umask', () => {
    expect(linuxPostinstall).toContain('if [ -L "$path" ]');
    expect(linuxPostinstall).toContain('assert_not_symlink "$DATA_DIR"');
    expect(linuxPostinstall).toContain('assert_not_symlink "$DATA_DIR/runtime"');
    expect(linuxPostinstall).toContain('assert_not_symlink "$ASSETS_DIR/models"');
    expect(linuxPostinstall).toContain('assert_not_symlink "$SERVICE_TREE"');
    expect(linuxUnit).toContain('UMask=0077');
    expect(linuxUnit).toContain('Environment=GEZEL_PORT=43935');
    expect(linuxUnit).toContain('Environment=GEZEL_SHARED_ASSETS_DIR=/var/lib/gezel/assets');
  });
});
