import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hookPath = fileURLToPath(new URL('../installer/nsis-hooks.nsh', import.meta.url));
const hook = readFileSync(hookPath, 'utf8');
// The service environment contract (GEZEL_SYSTEM_SCOPE, temp/profile
// redirects) is compiled into the first-party service host rather than
// configured by the installer — the security assertions cross-check its
// source so the two halves cannot drift apart silently.
const serviceHostPath = fileURLToPath(
  new URL('../../../native/helpers/service-host/src/main.cpp', import.meta.url),
);
const serviceHost = readFileSync(serviceHostPath, 'utf8');

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
  it('keeps private state closed while exposing runtime and read-only assets', () => {
    expect(hook).toContain('/setowner "*S-1-5-32-544"');
    expect(hook).toContain('!insertmacro TakeTrustedOwnership "${GEZEL_DATA_DIR}"');
    expect(hook).toContain('!insertmacro SanitizeDescendants "${GEZEL_DATA_DIR}"');

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

    const assetsAcl = commandLine('"${GEZEL_DATA_DIR}\\assets" /inheritance:r');
    const [assetsGrant = '', assetsRemove = ''] = assetsAcl.split('/remove:g');
    expect(assetsGrant).toContain('*S-1-5-18:(OI)(CI)(F)');
    expect(assetsGrant).toContain('*S-1-5-32-544:(OI)(CI)(F)');
    expect(assetsGrant).toContain('*S-1-5-32-545:(OI)(CI)(RX)');
    expect(assetsGrant).not.toMatch(/S-1-5-32-545:[^"]*[WMF]/);
    expect(assetsRemove).toContain('*S-1-5-11');
    expect(assetsRemove).toContain('*S-1-1-0');

    // The protected runtime directory does not inherit the service SID from
    // the parent; the asset boundary also has an explicit DACL.
    expect(hook.match(/NT SERVICE\\\${GEZEL_SERVICE_NAME}:\(OI\)\(CI\)\(M\)/g)).toHaveLength(3);
  });

  // Regression: v1.26219.44 granted the service SID only (M) on the asset
  // store. Modify does not include WRITE_DAC, so gezeld's `icacls <model>
  // /reset` — the step that re-inherits a moved bundle into the public
  // read-only ACL, i.e. the whole point of sharing models across accounts —
  // failed with "Access is denied" on every model SanitizeDescendants had just
  // re-owned to Administrators. The daemon crash-looped on SCM 1066.
  it('lets the broker re-inherit model bundles without opening the asset boundary', () => {
    const assetsGrant = commandLine('"${GEZEL_DATA_DIR}\\assets" /grant:r');

    // Modify on the container: create and delete bundles under assets\models.
    expect(assetsGrant).toContain('NT SERVICE\\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)');

    // FullControl on DESCENDANTS ONLY, so the broker holds the WRITE_DAC that
    // `icacls /reset` requires on each bundle. (IO) keeps it off the container.
    expect(assetsGrant).toContain('NT SERVICE\\${GEZEL_SERVICE_NAME}:(OI)(CI)(IO)(F)');

    // The inherit-only marker is what stops a compromised daemon from
    // rewriting the `assets` DACL itself and handing users write access.
    expect(assetsGrant).not.toMatch(
      /NT SERVICE\\\$\{GEZEL_SERVICE_NAME}:\((?!.*\(IO\))[^"]*\)\(F\)/,
    );

    // Users keep read-only inheritance — the sharing contract is unchanged.
    expect(commandLine('"${GEZEL_DATA_DIR}\\assets" /inheritance:r')).toContain(
      '*S-1-5-32-545:(OI)(CI)(RX)',
    );
  });

  // Regression: the installer wrote MachineServiceInstalled = 1 as soon as
  // `sc create` succeeded, so a service that registered and then failed to run
  // reported healthy. machineServiceMissing() only fires on a positive 0, which
  // made a crash-looping broker completely invisible — including on the silent
  // auto-update path, where NSIS shows no dialog at all.
  it('records the breadcrumb from the service START outcome, not registration', () => {
    const start = position('sc.exe" start ${GEZEL_SERVICE_NAME}');
    const success = position(
      'WriteRegDWORD SHELL_CONTEXT "${GEZEL_STATE_REGISTRY_KEY}" "MachineServiceInstalled" 1',
    );
    expect(start).toBeLessThan(success);

    // Both failure modes must reach the SkipNssm branch that writes 0: the
    // launch call itself failing, and the service dying during startup (which
    // `sc start` cannot report, because it returns before RUNNING).
    const startBlock = hook.slice(start, success);
    expect(startBlock).toContain('Goto SkipNssm');
    expect(startBlock).toContain('find.exe" "RUNNING"');
    expect(startBlock.match(/Goto SkipNssm/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    expect(hook).toContain(
      'WriteRegDWORD SHELL_CONTEXT "${GEZEL_STATE_REGISTRY_KEY}" "MachineServiceInstalled" 0',
    );
  });

  it('publishes migrated product data through a separate shared ACL boundary', () => {
    expect(hook).toContain('migrate-legacy-shared.js');
    expect(hook).toContain('--source="${GEZEL_DATA_DIR}" --dest="${GEZEL_SHARED_DIR}"');

    const sharedRoot = commandLine('"${GEZEL_SHARED_DIR}" /inheritance:r');
    expect(sharedRoot).toContain('*S-1-5-32-545:(RX)');
    expect(sharedRoot).not.toContain('*S-1-5-32-545:(OI)(CI)(M)');

    const marker = commandLine('"${GEZEL_SHARED_DIR}\\.gezel-machine-shared-v1.json"');
    expect(marker).toContain('*S-1-5-32-545:(R)');
    expect(marker).not.toContain('*S-1-5-32-545:(M)');

    for (const scope of ['projects', 'gezels']) {
      const acl = commandLine(`"\${GEZEL_SHARED_DIR}\\${scope}" /inheritance:r`);
      expect(acl).toContain('*S-1-5-32-545:(OI)(CI)(M)');
      expect(acl).not.toContain('NT SERVICE\\${GEZEL_SERVICE_NAME}');
    }

    expect(position('!insertmacro RemoveGezelService')).toBeLessThan(
      position('Migrating legacy machine-wide projects and gezels'),
    );
    expect(position('Migrating legacy machine-wide projects and gezels')).toBeLessThan(
      position('sc.exe" create ${GEZEL_SERVICE_NAME}'),
    );
  });

  it('applies every load-bearing ACL to the container itself, not by recursion', () => {
    // A recursive icacls pass fails as a unit — one MAX_PATH entry inside a
    // preserved GEZEL_HOME (uv venvs, cloned repos, sandbox node_modules) is
    // enough. No control that gates the install may depend on /T; each one
    // names the container, whose (OI)(CI) ACEs then propagate.
    for (const gate of [
      '"${GEZEL_DATA_DIR}" /inheritance:r',
      '"${GEZEL_DATA_DIR}" /grant:r "*S-1-5-32-545:(X)"',
      '"${GEZEL_DATA_DIR}\\runtime" /inheritance:r',
      '"${GEZEL_DATA_DIR}\\assets" /inheritance:r',
      '"${GEZEL_DATA_DIR}" /grant:r "NT SERVICE',
      '"${GEZEL_DATA_DIR}\\runtime" /grant:r "NT SERVICE',
      '"${GEZEL_DATA_DIR}\\assets" /grant:r "NT SERVICE',
    ]) {
      expect(commandLine(gate), `${gate} must not recurse`).not.toContain('/T');
    }

    // Ownership is the other gate. icacls alone cannot take ownership of a
    // directory whose DACL withholds WRITE_OWNER (it never enables
    // SeTakeOwnershipPrivilege), so the fallback is load-bearing.
    const ownership = hook.slice(
      position('!macro TakeTrustedOwnership'),
      hook.indexOf('!macroend', position('!macro TakeTrustedOwnership')),
    );
    expect(ownership).toContain('/setowner "*S-1-5-32-544"');
    expect(ownership).toContain('takeown.exe" /F "${PATH}" /A');
    expect(ownership).toContain('Goto ${FAILURE_LABEL}');
    for (const container of [
      '"${GEZEL_DATA_DIR}"',
      '"${GEZEL_DATA_DIR}\\runtime"',
      '"${GEZEL_DATA_DIR}\\assets"',
    ]) {
      expect(hook).toContain(`!insertmacro TakeTrustedOwnership ${container}`);
    }
  });

  it('cleans up pre-existing descendants without letting one file abort the install', () => {
    const sweep = hook.slice(
      position('!macro SanitizeDescendants'),
      hook.indexOf('!macroend', position('!macro SanitizeDescendants')),
    );
    // /C so icacls does not stop at the first entry it cannot open, and no
    // Goto: the fallback for a partial sweep is the per-user daemon, which
    // has no service isolation at all — strictly worse than this service
    // with a stale child ACE.
    expect(sweep).toContain('/setowner "*S-1-5-32-544" /T /C /L /Q');
    expect(sweep).toContain('/reset /T /C /L /Q');
    expect(sweep).not.toContain('Goto');
    expect(sweep).not.toContain('MessageBox');

    // /reset resets the named object too, so the sweep has to precede the
    // container DACL or it would undo it.
    for (const container of ['"${GEZEL_DATA_DIR}"', '"${GEZEL_DATA_DIR}\\assets"']) {
      expect(hook.indexOf(`!insertmacro SanitizeDescendants ${container}`)).toBeLessThan(
        position(`${container} /inheritance:r`),
      );
      expect(hook.indexOf(`!insertmacro TakeTrustedOwnership ${container}`)).toBeLessThan(
        hook.indexOf(`!insertmacro SanitizeDescendants ${container}`),
      );
    }
  });

  it('re-publishes preserved shared models for standalone use during uninstall', () => {
    const uninstallStart = position('!macro customUnInstall');
    const uninstall = hook.slice(uninstallStart, hook.indexOf('!macroend', uninstallStart));
    const removeService = uninstall.indexOf('!insertmacro RemoveGezelService');
    const sanitizeAssets = uninstall.indexOf(
      '!insertmacro SanitizeDescendants "${GEZEL_DATA_DIR}\\assets"',
    );
    const publicAcl = uninstall.indexOf('"${GEZEL_DATA_DIR}\\assets" /inheritance:r /grant:r');

    expect(removeService).toBeGreaterThanOrEqual(0);
    expect(sanitizeAssets).toBeGreaterThan(removeService);
    expect(publicAcl).toBeGreaterThan(sanitizeAssets);
    expect(uninstall.slice(publicAcl)).toContain('*S-1-5-32-545:(OI)(CI)(RX)');
    expect(uninstall.slice(publicAcl)).not.toMatch(/S-1-5-32-545:[^\n]*\([^)]+[WMF][^)]*\)/);
    expect(uninstall).not.toContain('RMDir /r "${GEZEL_DATA_DIR}\\assets"');
    expect(uninstall).not.toContain('Delete "${GEZEL_DATA_DIR}\\assets');
  });

  it('registers born-disabled LocalService and assigns the service SID before startup', () => {
    // One atomic sc.exe create: disabled AND LocalService AND a quoted
    // ImagePath from birth — no transient LocalSystem or enabled window.
    const createLine = commandLine('sc.exe" create ${GEZEL_SERVICE_NAME}');
    expect(createLine).toContain('start= disabled');
    expect(createLine).toContain('obj= "NT AUTHORITY\\LocalService"');
    expect(createLine).toContain('binPath= "\\"$INSTDIR\\gezel-service-host.exe\\" run"');

    const create = position('sc.exe" create ${GEZEL_SERVICE_NAME}');
    const restrictedSid = position('sidtype ${GEZEL_SERVICE_NAME} unrestricted');
    const restrictedPrivileges = position('privs ${GEZEL_SERVICE_NAME} SeChangeNotifyPrivilege');
    const firstServiceSidAcl = position('NT SERVICE\\${GEZEL_SERVICE_NAME}:(OI)(CI)(M)');
    const enableAutostart = position('config ${GEZEL_SERVICE_NAME} start= auto');
    const start = hook.indexOf('sc.exe" start ${GEZEL_SERVICE_NAME}', enableAutostart);
    expect(start, 'missing post-registration service start').toBeGreaterThanOrEqual(0);

    expect(create).toBeLessThan(restrictedSid);
    expect(restrictedSid).toBeLessThan(restrictedPrivileges);
    expect(restrictedPrivileges).toBeLessThan(firstServiceSidAcl);
    expect(firstServiceSidAcl).toBeLessThan(enableAutostart);
    expect(enableAutostart).toBeLessThan(start);
    expect(hook).not.toMatch(/obj=\s+"(?:NT AUTHORITY\\)?LocalSystem"/i);
    // The installer must never invoke a general-purpose service wrapper.
    expect(hook).not.toMatch(/nsExec[^\n]*nssm/i);
  });

  // `restricted` makes the service token write-restricted, and libuv creates a
  // named pipe per piped stdio handle before every CreateProcess. That pipe
  // creation is a write the restricted SID list denies, so the daemon can
  // spawn nothing at all: local engines, GPU probes, the stdio MCP server,
  // sandboxed scripts, pnpm installs and git every one of them `spawn EPERM`.
  // Shipped in v1.26215.31 — the first release whose installer actually
  // registered the service on a fresh install, so the first release anyone
  // ran it under. `unrestricted` keeps the per-service SID (every ACL below
  // grants it) without write-restricting the token.
  it('never write-restricts the service token', () => {
    expect(hook).toContain('sidtype ${GEZEL_SERVICE_NAME} unrestricted');
    expect(hook).not.toMatch(/sidtype \$\{GEZEL_SERVICE_NAME\}\s+restricted/);
    // `none` would drop the SID entirely, and the private home grants the
    // generic LocalService account nothing — the daemon would lose its own
    // GEZEL_HOME rather than merely its children.
    expect(hook).not.toMatch(/sidtype \$\{GEZEL_SERVICE_NAME\}\s+none/);
  });

  it('compiles the service environment contract into the service host', () => {
    expect(serviceHost).toContain('L"GEZEL_SYSTEM_SCOPE", L"1"');
    expect(serviceHost).toContain('L"GEZEL_SERVICE_ROLE", L"machine-engine"');
    expect(serviceHost).toContain('L"GEZEL_PORT", L"6228"');
    expect(serviceHost).toContain('L"GEZEL_SHARED_ASSETS_DIR", home + L"\\\\assets"');
    expect(serviceHost).toContain('L"ELECTRON_RUN_AS_NODE", L"1"');
    expect(serviceHost).toContain('{L"TEMP", home + L"\\\\tmp"}');
    expect(serviceHost).toContain('{L"TMP", home + L"\\\\tmp"}');
    expect(serviceHost).not.toContain('L"GEZEL_UI_DIR"');
    expect(serviceHost).toContain('{L"TMPDIR", home + L"\\\\tmp"}');
    expect(serviceHost).toContain('{L"APPDATA", home + L"\\\\appdata"}');
    expect(serviceHost).toContain('{L"LOCALAPPDATA", home + L"\\\\localappdata"}');
    expect(serviceHost).toContain('{L"USERPROFILE", home}');
    expect(serviceHost).toContain('L"C:\\\\ProgramData\\\\Gezel"');
    expect(serviceHost).toContain('dist\\\\pnpm-bundle\\\\bin\\\\pnpm.mjs');
    expect(serviceHost).not.toContain('dist\\\\pnpm-bundle\\\\pnpm.exe');
  });

  it('fails closed if any load-bearing identity control fails', () => {
    // sc create failure leaves nothing registered — skip is enough.
    const createBlock = hook.slice(
      position('sc.exe" create ${GEZEL_SERVICE_NAME}'),
      position('sidtype ${GEZEL_SERVICE_NAME} unrestricted'),
    );
    expect(createBlock).toContain('Goto SkipNssm');

    const sidTypeBlock = hook.slice(
      position('sidtype ${GEZEL_SERVICE_NAME} unrestricted'),
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

    const enableBlock = hook.slice(
      position('config ${GEZEL_SERVICE_NAME} start= auto'),
      hook.indexOf(
        'sc.exe" start ${GEZEL_SERVICE_NAME}',
        position('config ${GEZEL_SERVICE_NAME} start= auto'),
      ),
    );
    expect(enableBlock).toContain('!insertmacro RemoveGezelService');
    expect(enableBlock).toContain('Goto SkipNssm');
  });

  it('invalidates legacy runtime credentials before reinstalling', () => {
    const clear = position('!insertmacro ClearGezelRuntime');
    const install = position('create ${GEZEL_SERVICE_NAME}');
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
    expect(hook).toContain('Delete "${GEZEL_DATA_DIR}\\runtime\\service-role"');
  });

  it('waits for an old registration to disappear before replacing it', () => {
    const removeStart = position('!macro RemoveGezelService');
    const removeMacro = hook.slice(removeStart, hook.indexOf('!macroend', removeStart));
    expect(removeMacro).toContain('config ${GEZEL_SERVICE_NAME} start= disabled');
    expect(removeMacro).toContain('delete ${GEZEL_SERVICE_NAME}');
    expect(removeMacro).toContain('query ${GEZEL_SERVICE_NAME}');
    expect(removeMacro).toContain('${If} $9 == 1060');
    expect(removeMacro).toContain('${If} $8 >= 30');
    expect(removeMacro).toContain('Sleep 1000');
    const firstQuery = removeMacro.indexOf('query ${GEZEL_SERVICE_NAME}');
    const missingServiceGate = removeMacro.indexOf('${If} $9 != 1060');
    // The stop must be confirmed before delete: deleting a service whose
    // stop is still in flight marks it delete-pending until reboot.
    const stopInRemove = removeMacro.indexOf('stop ${GEZEL_SERVICE_NAME}');
    const waitInRemove = removeMacro.indexOf('!insertmacro WaitGezelServiceStopped');
    const deleteInRemove = removeMacro.indexOf('delete ${GEZEL_SERVICE_NAME}');
    const finalQuery = removeMacro.lastIndexOf('query ${GEZEL_SERVICE_NAME}');
    // A nonexistent service leaves $9=1060 and skips every stop/delete wait.
    expect(firstQuery).toBeGreaterThanOrEqual(0);
    expect(missingServiceGate).toBeGreaterThan(firstQuery);
    expect(stopInRemove).toBeGreaterThan(missingServiceGate);
    expect(waitInRemove).toBeGreaterThan(stopInRemove);
    expect(deleteInRemove).toBeGreaterThan(waitInRemove);
    expect(finalQuery).toBeGreaterThan(deleteInRemove);

    const installBody = hook.slice(position('!macro customInstall'));
    const absenceGate = installBody.indexOf('${If} $9 != 1060');
    const replacement = installBody.indexOf('create ${GEZEL_SERVICE_NAME}');
    expect(absenceGate).toBeGreaterThanOrEqual(0);
    expect(absenceGate).toBeLessThan(replacement);
  });

  it('stops only after assisted-install confirmation while preserving silent upgrades', () => {
    // .onInit runs before the welcome/license pages. An unconditional stop
    // there strands a healthy broker if the user cancels. Interactive setup
    // instead wires the stop to the InstFiles PRE callback — after acceptance,
    // but before electron-builder closes processes or replaces files.
    const initStart = position('!macro customInit');
    const initMacro = hook.slice(initStart, hook.indexOf('!macroend', initStart));
    expect(initMacro).toContain('${If} ${Silent}');
    expect(initMacro).toContain('!insertmacro StopGezelServiceForInstall');
    expect(initMacro).not.toContain('stop ${GEZEL_SERVICE_NAME}');

    const pageStart = position('!macro customPageAfterChangeDir');
    const pageMacro = hook.slice(pageStart, hook.indexOf('!macroend', pageStart));
    expect(pageMacro).toContain('!define MUI_PAGE_CUSTOMFUNCTION_PRE GezelBeforeInstall');
    const preStart = position('Function GezelBeforeInstall');
    const preFunction = hook.slice(preStart, hook.indexOf('FunctionEnd', preStart));
    expect(preFunction).toContain('!insertmacro StopGezelServiceForInstall');
    const installerOnlyGuard = hook.lastIndexOf('!ifndef BUILD_UNINSTALLER', pageStart);
    const installerOnlyEnd = hook.indexOf('!endif', preStart);
    expect(installerOnlyGuard).toBeGreaterThanOrEqual(0);
    expect(installerOnlyGuard).toBeLessThan(pageStart);
    expect(installerOnlyEnd).toBeGreaterThan(preStart);

    const stopStart = position('!macro StopGezelServiceForInstall');
    const stopMacro = hook.slice(stopStart, hook.indexOf('!macroend', stopStart));
    const guard = stopMacro.indexOf('query ${GEZEL_SERVICE_NAME}');
    const stop = stopMacro.indexOf('stop ${GEZEL_SERVICE_NAME}');
    const wait = stopMacro.indexOf('!insertmacro WaitGezelServiceStopped');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(guard);
    expect(wait).toBeGreaterThan(stop);
    expect(stopMacro).toContain('StrCpy $GezelServiceStoppedForInstall 1');

    // If the user aborts after the InstFiles transition but before the old
    // registration is removed, restore only that intact registration. The
    // rollback must never recreate a deleted or quarantined service.
    const restartStart = position('!macro RestartGezelServiceAfterAbortedInstall');
    const restartMacro = hook.slice(restartStart, hook.indexOf('!macroend', restartStart));
    expect(restartMacro).toContain('query ${GEZEL_SERVICE_NAME}');
    expect(restartMacro).toContain('start ${GEZEL_SERVICE_NAME}');
    expect(restartMacro).not.toContain('create ${GEZEL_SERVICE_NAME}');
    expect(hook).toContain('!define MUI_CUSTOMFUNCTION_ABORT GezelOnUserAbort');
    expect(hook).not.toContain('Function .onUserAbort');
    for (const callback of ['Function GezelOnUserAbort', 'Function .onInstFailed']) {
      const callbackStart = position(callback);
      const callbackBody = hook.slice(callbackStart, hook.indexOf('FunctionEnd', callbackStart));
      expect(callbackBody).toContain('!insertmacro RestartGezelServiceAfterAbortedInstall');
    }
    // The wait itself is bounded — a wedged service must not hang setup.
    const waitStart = position('!macro WaitGezelServiceStopped');
    const waitMacro = hook.slice(waitStart, hook.indexOf('!macroend', waitStart));
    expect(waitMacro).toContain('${If} $8 >= 20');
    expect(waitMacro).toContain('Sleep 500');
    expect(waitMacro).toContain('"STOPPED"');
  });

  it('keeps restricted-service temporary files below the private root', () => {
    // The installer still creates + reparse-guards the redirect targets;
    // the env vars pointing the service at them are compiled into the
    // service host (asserted above).
    expect(hook).toContain('CreateDirectory "${GEZEL_DATA_DIR}\\tmp"');
    expect(hook).toContain(
      '!insertmacro RejectReparsePoint "${GEZEL_DATA_DIR}\\tmp" "Gezel temporary directory"',
    );
    expect(hook).toContain('CreateDirectory "${GEZEL_DATA_DIR}\\appdata"');
    expect(hook).toContain('CreateDirectory "${GEZEL_DATA_DIR}\\localappdata"');
    expect(hook).not.toMatch(/S-1-5-32-545:\(OI\)\(CI\).*tmp/i);
  });

  it('rejects reparse-point redirection before elevated extraction', () => {
    expect(hook).toContain('GetFileAttributesW');
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

  it('captures the reparse-check last error atomically with the call', () => {
    // A standalone GetLastError() System::Call reads a leftover code, because
    // the plugin's marshalling clobbers the thread's last error in between.
    // That aborted the machine-service install on every fresh Windows device:
    // the not-yet-created service tree took the -1 branch and saw a stale
    // ERROR_FILE_EXISTS (80) instead of ERROR_PATH_NOT_FOUND.
    expect(hook).toContain('System::Call \'kernel32::GetFileAttributesW(w "${PATH}") i .r0 ?e\'');
    expect(hook).not.toMatch(/System::Call\s+'kernel32::GetLastError/);
    expect(position('Pop $1')).toBeLessThan(position('${If} $0 == -1'));
  });
});
