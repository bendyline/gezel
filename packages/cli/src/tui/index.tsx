import type { GezelClient } from '@bendyline/gezel-client/node';
import { render } from 'ink';
import { App } from './App.js';
import { BootstrapGate } from './components/BootstrapGate.js';
import { startTuiRuntimeDiagnostics } from './memory-diagnostics.js';

export interface LaunchTuiOpts {
  client: GezelClient;
  projectId: string;
  projectName: string;
  gezelId: string;
}

/**
 * Mount the interactive TUI and resolve when the user exits it. The caller
 * (the default `gezel` command) has already resolved the owned daemon
 * client and the active project.
 */
export async function launchTui(opts: LaunchTuiOpts): Promise<void> {
  const diagnostics = startTuiRuntimeDiagnostics();
  const instance = render(
    <BootstrapGate client={opts.client}>
      <App
        client={opts.client}
        diagnostics={diagnostics}
        initialProjectId={opts.projectId}
        initialProjectName={opts.projectName}
        initialGezelId={opts.gezelId}
      />
    </BootstrapGate>,
    // We own Ctrl+C (interrupt-then-exit); don't let ink exit on the first press.
    { exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    await diagnostics.stop();
  }
}
