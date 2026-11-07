import { execFile } from 'node:child_process';
import { dirname } from 'node:path';

export interface FileManagerLaunch {
  cmd: string;
  args: string[];
}

/**
 * The argv that shows `target` in the host's file manager: the folder itself,
 * or, with `select`, the file highlighted in its parent folder. Linux has no
 * portable "select this file", so it opens the parent there.
 */
export function fileManagerLaunch(
  target: string,
  opts: { select?: boolean } = {},
  platform: NodeJS.Platform = process.platform,
): FileManagerLaunch {
  if (platform === 'darwin') {
    return { cmd: 'open', args: opts.select ? ['-R', target] : [target] };
  }
  if (platform === 'win32') {
    return { cmd: 'explorer', args: opts.select ? ['/select,', target] : [target] };
  }
  return { cmd: 'xdg-open', args: [opts.select ? dirname(target) : target] };
}

/**
 * Show `target` in the host's file manager.
 *
 * Always an argv array, never an interpolated shell string: a project
 * `workingDir` is settable by the model via `update_project`, and `open
 * "${dir}"` would let `"; rm -rf … #` run as the user on the next click.
 *
 * Never pass `windowsHide`. Explorer is a GUI app with no console to hide, and
 * it honors the SW_HIDE that flag puts in its startup info: the folder opens
 * in an invisible window, so the button appears to do nothing.
 *
 * Fire-and-forget: the file manager owns the window, and explorer.exe exits
 * non-zero even on success.
 */
export function revealInFileManager(target: string, opts: { select?: boolean } = {}): void {
  const launch = fileManagerLaunch(target, opts);
  execFile(launch.cmd, launch.args, () => {});
}
