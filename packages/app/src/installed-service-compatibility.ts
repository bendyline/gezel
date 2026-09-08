import { createRequire } from 'node:module';
import type { ConnectOptions, InstalledServiceCompatibilityIssue } from './supervisor/index.js';
import { InstalledServiceCompatibilityDeclinedError } from './supervisor/index.js';

const require = createRequire(import.meta.url);
const { dialog, shell } = require('electron') as typeof import('electron');

interface InstalledServiceCompatibilityPolicy {
  enabled: boolean;
  autoAccept: boolean;
}

async function chooseInstalledServiceCompatibilityFallback(
  win: Electron.BrowserWindow | null,
  issue: InstalledServiceCompatibilityIssue,
): Promise<'self-hosted' | 'quit'> {
  const installed = issue.installedVersion
    ? `The installed Gezel service is version ${issue.installedVersion}. `
    : 'The installed Gezel service is not compatible with this app. ';
  const current = issue.appVersion
    ? `This Gezel app is version ${issue.appVersion}. `
    : 'This Gezel app is a newer version. ';
  const messageBoxOptions: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Installed Gezel service is not compatible',
    message: 'This version of Gezel cannot use the installed shared service.',
    detail: `${installed}${current}These versions cannot use shared services together. You can continue without shared services, but Gezel may not coordinate memory use as effectively. You can also check gezel.com for a newer installer that includes the shared service. Choosing “Get latest version” will open the website and close Gezel while you update.`,
    buttons: ['Continue without shared services', 'Get latest version…', 'Quit'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const result =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions);
  if (result.response === 1) {
    await shell.openExternal('https://gezel.com/');
    return 'quit';
  }
  return result.response === 0 ? 'self-hosted' : 'quit';
}

export function options(
  appVersion: string,
  win: Electron.BrowserWindow | null,
  policy: InstalledServiceCompatibilityPolicy,
): Pick<ConnectOptions, 'appVersion' | 'onInstalledServiceIncompatible'> {
  if (!policy.enabled) return { appVersion };
  return {
    appVersion,
    onInstalledServiceIncompatible: policy.autoAccept
      ? () => Promise.resolve('self-hosted')
      : (issue) => chooseInstalledServiceCompatibilityFallback(win, issue),
  };
}

export function isDeclined(error: unknown): error is InstalledServiceCompatibilityDeclinedError {
  return error instanceof InstalledServiceCompatibilityDeclinedError;
}
