import { ExecFailure, type ExecFn, defaultExec, isProcessRunning } from './exec.js';

/**
 * Install gezel's LibreOffice extension for the current user with
 * LibreOffice's own tool, `unopkg` (`add -f -s`: replace, suppress the
 * license prompt). Per-user, so no administrator rights; `--shared` is
 * never used.
 *
 * unopkg works on the user's LibreOffice profile, which a running soffice
 * holds locked, so both operations refuse while LibreOffice is open.
 */

export const LIBREOFFICE_EXTENSION_ID = 'com.bendyline.gezel';

export interface LibreOfficeRegisterDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
}

export function buildUnopkgAddArgs(oxtPath: string): string[] {
  return ['add', '-f', '-s', oxtPath];
}

export function buildUnopkgRemoveArgs(extensionId: string = LIBREOFFICE_EXTENSION_ID): string[] {
  return ['remove', extensionId];
}

export function buildUnopkgListArgs(extensionId: string = LIBREOFFICE_EXTENSION_ID): string[] {
  return ['list', extensionId];
}

/** Whether `unopkg list` output names the extension. */
export function parseUnopkgListed(
  stdout: string,
  extensionId: string = LIBREOFFICE_EXTENSION_ID,
): boolean {
  return new RegExp(`Identifier:\\s*${extensionId.replace(/\./g, '\\.')}\\b`).test(stdout);
}

function sofficeImageNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['soffice.bin', 'soffice.exe'] : ['soffice', 'soffice.bin'];
}

async function refuseWhileRunning(deps: LibreOfficeRegisterDeps): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (await isProcessRunning(sofficeImageNames(platform), { exec: deps.exec, platform })) {
    throw new Error('Close LibreOffice first, then try again.');
  }
}

export async function installLibreOfficeExtension(
  opts: { unopkgPath: string; oxtPath: string },
  deps: LibreOfficeRegisterDeps = {},
): Promise<void> {
  await refuseWhileRunning(deps);
  const exec = deps.exec ?? defaultExec;
  await exec(opts.unopkgPath, buildUnopkgAddArgs(opts.oxtPath), { timeout: 3 * 60_000 });
}

export async function uninstallLibreOfficeExtension(
  opts: { unopkgPath: string },
  deps: LibreOfficeRegisterDeps = {},
): Promise<void> {
  await refuseWhileRunning(deps);
  const exec = deps.exec ?? defaultExec;
  await exec(opts.unopkgPath, buildUnopkgRemoveArgs(), { timeout: 3 * 60_000 }).catch((err) => {
    // "not deployed" is the goal state; anything else is a real failure.
    if (err instanceof ExecFailure && /not\s+deployed|no such/i.test(`${err.stdout} ${err.stderr}`))
      return;
    throw err;
  });
}

export async function isLibreOfficeExtensionInstalled(
  opts: { unopkgPath: string },
  deps: LibreOfficeRegisterDeps = {},
): Promise<boolean | null> {
  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout } = await exec(opts.unopkgPath, buildUnopkgListArgs(), { timeout: 60_000 });
    return parseUnopkgListed(stdout);
  } catch (err) {
    if (err instanceof ExecFailure && parseUnopkgListed(`${err.stdout}${err.stderr}`) === false) {
      // `unopkg list <id>` exits non-zero when the id is not deployed.
      return /not\s+deployed|no such/i.test(`${err.stdout} ${err.stderr}`) ? false : null;
    }
    return null;
  }
}
