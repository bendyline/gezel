import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MacUninstallSelection {
  removeMachineData: boolean;
  removeSharedData: boolean;
  removeCurrentUserData: boolean;
}

export type MacUninstallResult = { ok: true } | { ok: false; error: string; canceled?: boolean };

export type UninstallExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: UninstallExec = async (file, args, options) => {
  const result = await execFileAsync(file, args, options);
  return { stdout: result.stdout, stderr: result.stderr };
};

/**
 * Parse the renderer payload at the IPC boundary. A compromised renderer may
 * not smuggle paths or arbitrary shell arguments into the privileged flow;
 * the only accepted input is the three documented boolean choices.
 */
export function parseMacUninstallSelection(value: unknown): MacUninstallSelection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set(['removeMachineData', 'removeSharedData', 'removeCurrentUserData']);
  if (
    Object.keys(candidate).some((key) => !allowedKeys.has(key)) ||
    typeof candidate.removeMachineData !== 'boolean' ||
    typeof candidate.removeSharedData !== 'boolean' ||
    typeof candidate.removeCurrentUserData !== 'boolean'
  ) {
    return null;
  }
  return {
    removeMachineData: candidate.removeMachineData,
    removeSharedData: candidate.removeSharedData,
    removeCurrentUserData: candidate.removeCurrentUserData,
  };
}

/** POSIX single-quote one fixed argument for the shell AppleScript invokes. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** AppleScript string literal; the command itself remains POSIX-quoted. */
function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function macUninstallShellCommand(input: {
  scriptPath: string;
  appPid: number;
  userUid: number;
  selection: MacUninstallSelection;
}): string {
  if (!Number.isSafeInteger(input.appPid) || input.appPid <= 1) {
    throw new Error('The Gezel process id is invalid.');
  }
  if (!Number.isSafeInteger(input.userUid) || input.userUid <= 0) {
    throw new Error('The current macOS user id is invalid.');
  }

  const args = [
    '/bin/bash',
    input.scriptPath,
    '--detach',
    `--wait-for-pid=${input.appPid}`,
    `--user-uid=${input.userUid}`,
    ...(input.selection.removeMachineData ? ['--remove-machine-data'] : []),
    ...(input.selection.removeSharedData ? ['--remove-shared-data'] : []),
    ...(input.selection.removeCurrentUserData ? ['--remove-current-user-data'] : []),
  ];
  return args.map(shellQuote).join(' ');
}

export function macUninstallAppleScript(command: string): string {
  const prompt =
    'Gezel needs administrator permission to remove its app and machine-wide background service.';
  return `do shell script ${appleScriptString(command)} with prompt ${appleScriptString(prompt)} with administrator privileges`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: unknown }).stderr;
    return `${error.message}${typeof stderr === 'string' && stderr.trim() ? `\n${stderr.trim()}` : ''}`;
  }
  return String(error);
}

export async function scheduleMacUninstall(input: {
  resourcesPath: string;
  appPid: number;
  userUid: number;
  selection: MacUninstallSelection;
  platform?: NodeJS.Platform;
  isPackaged: boolean;
  exists?: (path: string) => boolean;
  exec?: UninstallExec;
}): Promise<MacUninstallResult> {
  if ((input.platform ?? process.platform) !== 'darwin' || !input.isPackaged) {
    return {
      ok: false,
      error: 'Uninstall is available only from an installed Gezel app on macOS.',
    };
  }

  const scriptPath = posix.join(input.resourcesPath, 'uninstall.sh');
  if (!(input.exists ?? existsSync)(scriptPath)) {
    return {
      ok: false,
      error: 'Gezel’s signed uninstaller is missing. Reinstall Gezel and try again.',
    };
  }

  let command: string;
  try {
    command = macUninstallShellCommand({
      scriptPath,
      appPid: input.appPid,
      userUid: input.userUid,
      selection: input.selection,
    });
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }

  try {
    await (input.exec ?? defaultExec)(
      '/usr/bin/osascript',
      ['-e', macUninstallAppleScript(command)],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    return { ok: true };
  } catch (error) {
    const message = errorText(error);
    if (/\b-128\b|user cancel(?:ed|led)/i.test(message)) {
      return { ok: false, canceled: true, error: 'Administrator authorization was canceled.' };
    }
    return { ok: false, error: `Gezel could not start its uninstaller. ${message}` };
  }
}
