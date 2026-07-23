import type { GezelClient } from '@bendyline/gezel-client/node';
import { render } from 'ink';
import { App } from './App.js';

export interface LaunchTuiOpts {
  client: GezelClient;
  projectId: string;
  projectName: string;
}

/**
 * Mount the interactive TUI and resolve when the user exits it. The caller
 * (the default `gezel` command) has already resolved the owned daemon
 * client and the active project.
 */
export async function launchTui(opts: LaunchTuiOpts): Promise<void> {
  const instance = render(
    <App
      client={opts.client}
      initialProjectId={opts.projectId}
      initialProjectName={opts.projectName}
    />,
    // We own Ctrl+C (interrupt-then-exit); don't let ink exit on the first press.
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
