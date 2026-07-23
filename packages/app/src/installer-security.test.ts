import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hookPath = fileURLToPath(new URL('../installer/nsis-hooks.nsh', import.meta.url));
const hook = readFileSync(hookPath, 'utf8');

function position(needle: string): number {
  const index = hook.indexOf(needle);
  expect(index, `missing installer security directive: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

function commandLine(containing: string): string {
  const line = hook.split(/\r?\n/).find((candidate) => candidate.includes(containing));
  expect(line, `missing installer command containing: ${containing}`).toBeDefined();
  return line!;
}

describe('Windows machine-service installer security', () => {
  it('makes the ProgramData root private while exposing only runtime discovery', () => {
    expect(hook).toContain('/setowner "*S-1-5-32-544"');
    expect(hook).toContain('"${GEZEL_DATA_DIR}" /setowner "*S-1-5-32-544" /T /L');
    expect(hook).toContain('"${GEZEL_DATA_DIR}" /reset /T /L');

    const rootAcl = commandLine('"${GEZEL_DATA_DIR}" /inheritance:r');
    const [rootGrant = '', rootRemove = ''] = rootAcl.split('/remove:g');
    expect(rootGrant).toContain('*S-1-5-18:(OI)(CI)(F)'); // SYSTEM
    expect(rootGrant).toContain('*S-1-5-32-544:(OI)(CI)(F)'); // Administrators
    expect(rootGrant).not.toContain('S-1-5-32-545'); // BUILTIN\Users
    expect(rootGrant).not.toContain('S-1-5-11'); // Authenticated Users
    expect(rootGrant).not.toContain('S-1-1-0'); // Everyone
    expect(rootRemove).toContain('*S-1-5-32-545');
    expect(rootRemove).toContain('*S-1-5-11');
    expect(rootRemove).toContain('*S-1-1-0');
    expect(rootRemove).toContain('*S-1-5-19'); // generic LocalService
    expect(rootAcl).toContain('/L');

    const traverseAcl = commandLine('"${GEZEL_DATA_DIR}" /grant:r "*S-1-5-32-545:(X)"');
    expect(traverseAcl).not.toContain('(OI)');
    expect(traverseAcl).not.toContain('(CI)');
    expect(traverseAcl).not.toMatch(/S-1-5-32-545:\([^)]*[RWMF][^)]*\)/);
    expect(traverseAcl).toContain('/L');

    const runtimeAcl = commandLine('"${GEZEL_DATA_DIR}\\runtime" /inheritance:r');
    const [runtimeGrant = '', runtimeRemove = ''] = runtimeAcl.split('/remove:g');
    expect(runtimeGrant).toContain('*S-1-5-18:(OI)(CI)(F)');
    expect(runtimeGrant).toContain('*S-1-5-32-544:(OI)(CI)(F)');
    expect(runtimeGrant).toContain('*S-1-5-32-545:(OI)(CI)(RX)');
    expect(runtimeGrant).not.toMatch(/S-1-5-32-545:[^"]*[WMF]/);
    expect(runtimeRemove).toContain('*S-1-5-11');
    expect(runtimeRemove).toContain('*S-1-1-0');

    // The protected runtime directory does not inherit the service SID from
    // the parent, so both grants are required.
    expect(hook.match(/NT SERVICE\\\${GEZEL_SERVICE_NAME}:\(OI\)\(CI\)\(M\)/g)).toHaveLength(2);
  });

  it('configures LocalService and a restricted service SID before startup', () => {
    const install = position('install ${GEZEL_SERVICE_NAME}');
    const disabled = hook.indexOf('config ${GEZEL_SERVICE_NAME} start= disabled', install);
    expect(disabled).toBeGreaterThan(install);
    const account = position('ObjectName "NT AUTHORITY\\LocalService"');
    const restrictedSid = position('sidtype ${GEZEL_SERVICE_NAME} restricted');
    const restrictedPrivileges = position('privs ${GEZEL_SERVICE_NAME} SeChangeNotifyPrivilege');
    const firstServiceSidAcl = position('NT SERVICE\\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)');
    const environment = position('"GEZEL_SYSTEM_SCOPE=1"');
    const start = position('start ${GEZEL_SERVICE_NAME}');

    expect(disabled).toBeLessThan(account);
    expect(account).toBeLessThan(restrictedSid);
    expect(restrictedSid).toBeLessThan(restrictedPrivileges);
    expect(restrictedPrivileges).toBeLessThan(firstServiceSidAcl);
    expect(firstServiceSidAcl).toBeLessThan(environment);
    expect(environment).toBeLessThan(start);
    expect(hook).not.toMatch(/ObjectName\s+"(?:NT AUTHORITY\\)?LocalSystem"/i);
  });

  it('fails closed if any load-bearing identity control fails', () => {
    const accountBlock = hook.slice(
      position('ObjectName "NT AUTHORITY\\LocalService"'),
      position('sidtype ${GEZEL_SERVICE_NAME} restricted'),
    );
    expect(accountBlock).toContain('!insertmacro RemoveGezelService');
    expect(accountBlock).toContain('Goto SkipNssm');

    const sidTypeBlock = hook.slice(
      position('sidtype ${GEZEL_SERVICE_NAME} restricted'),
      position('privs ${GEZEL_SERVICE_NAME} SeChangeNotifyPrivilege'),
    );
    expect(sidTypeBlock).toContain('!insertmacro RemoveGezelService');
    expect(sidTypeBlock).toContain('Goto SkipNssm');

    const privilegesBlock = hook.slice(
      position('privs ${GEZEL_SERVICE_NAME} SeChangeNotifyPrivilege'),
      position('NT SERVICE\\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)'),
    );
    expect(privilegesBlock).toContain('!insertmacro RemoveGezelService');
    expect(privilegesBlock).toContain('Goto SkipNssm');

    const environmentBlock = hook.slice(
      position('"GEZEL_SYSTEM_SCOPE=1"'),
      position('AppStdout "${GEZEL_DATA_DIR}\\logs\\service-stdout.log"'),
    );
    expect(environmentBlock).toContain('!insertmacro RemoveGezelService');
    expect(environmentBlock).toContain('Goto SkipNssm');
  });

  it('invalidates legacy runtime credentials before reinstalling', () => {
    const clear = position('!insertmacro ClearGezelRuntime');
    const install = position('install ${GEZEL_SERVICE_NAME}');
    expect(clear).toBeLessThan(install);
    const installBody = hook.slice(
      position('!macro customInstall'),
      hook.indexOf('!macroend', install),
    );
    const rootChecks = [
      ...installBody.matchAll(
        /!insertmacro RejectReparsePoint "\$\{GEZEL_DATA_DIR\}" "Gezel data directory"/g,
      ),
    ];
    expect(rootChecks).toHaveLength(2);
    const secondRootCheck = installBody.lastIndexOf(
      '!insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}" "Gezel data directory"',
    );
    const runtimeCheck = installBody.indexOf(
      '!insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\\runtime"',
    );
    const cleanup = installBody.indexOf('!insertmacro ClearGezelRuntime');
    expect(secondRootCheck).toBeLessThan(runtimeCheck);
    expect(runtimeCheck).toBeLessThan(cleanup);
    expect(hook).toContain('Delete "${GEZEL_DATA_DIR}\\runtime\\auth-token"');
    expect(hook).toContain('Delete "${GEZEL_DATA_DIR}\\runtime\\web-ui-token"');
  });

  it('waits for an old registration to disappear before replacing it', () => {
    const removeMacro = hook.slice(position('!macro RemoveGezelService'), position('!macroend'));
    expect(removeMacro).toContain('config ${GEZEL_SERVICE_NAME} start= disabled');
    expect(removeMacro).toContain('delete ${GEZEL_SERVICE_NAME}');
    expect(removeMacro).toContain('query ${GEZEL_SERVICE_NAME}');
    expect(removeMacro).toContain('${If} $9 == 1060');
    expect(removeMacro).toContain('${If} $8 >= 30');
    expect(removeMacro).toContain('Sleep 1000');
    expect(removeMacro.indexOf('delete ${GEZEL_SERVICE_NAME}')).toBeLessThan(
      removeMacro.indexOf('query ${GEZEL_SERVICE_NAME}'),
    );

    const installBody = hook.slice(position('!macro customInstall'));
    const absenceGate = installBody.indexOf('${If} $9 != 1060');
    const replacement = installBody.indexOf('install ${GEZEL_SERVICE_NAME}');
    expect(absenceGate).toBeGreaterThanOrEqual(0);
    expect(absenceGate).toBeLessThan(replacement);
  });

  it('keeps restricted-service temporary files below the private root', () => {
    expect(hook).toContain('CreateDirectory "${GEZEL_DATA_DIR}\\tmp"');
    expect(hook).toContain(
      '!insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\\tmp" "Gezel temporary directory"',
    );
    expect(hook).toContain('"TEMP=${GEZEL_DATA_DIR}\\tmp"');
    expect(hook).toContain('"TMP=${GEZEL_DATA_DIR}\\tmp"');
    expect(hook).toContain('"TMPDIR=${GEZEL_DATA_DIR}\\tmp"');
    expect(hook).toContain('"USERPROFILE=${GEZEL_DATA_DIR}"');
    expect(hook).toContain('CreateDirectory "${GEZEL_DATA_DIR}\\appdata"');
    expect(hook).toContain('CreateDirectory "${GEZEL_DATA_DIR}\\localappdata"');
    expect(hook).toContain('"APPDATA=${GEZEL_DATA_DIR}\\appdata"');
    expect(hook).toContain('"LOCALAPPDATA=${GEZEL_DATA_DIR}\\localappdata"');
    expect(hook).not.toMatch(/S-1-5-32-545:\(OI\)\(CI\).*tmp/i);
  });

  it('rejects reparse-point redirection before elevated extraction', () => {
    expect(hook).toContain('GetFileAttributesW');
    expect(hook).toContain('GetLastError()');
    expect(hook).toContain('${If} $1 != 2');
    expect(hook).toContain('${AndIf} $1 != 3');
    expect(hook).toContain('IntOp $1 $0 & 0x400');
    expect(hook).toContain(
      '!insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}" "Gezel data directory"',
    );
    expect(hook).toContain(
      '!insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\\runtime" "Gezel runtime directory"',
    );
    expect(hook).toContain(
      '!insertmacro RejectReparsePoint "${GEZEL_SERVICE_TREE}" "Gezel service tree"',
    );
    expect(hook).toContain(
      '!insertmacro RejectReparseDescendants "${GEZEL_SERVICE_TREE}" "Gezel service tree"',
    );
    expect(position('RejectReparsePoint "${GEZEL_SERVICE_TREE}"')).toBeLessThan(
      position('--dest="${GEZEL_SERVICE_TREE}" --force'),
    );
  });
});
