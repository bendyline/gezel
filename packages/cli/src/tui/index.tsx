import type { GezelClient } from '@bendyline/gezel-client/node';
import { render } from 'ink';
import { App } from './App.js';
import { BootstrapGate, ExitWhenReady } from './components/BootstrapGate.js';
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

/**
 * Show the first-time setup screens on their own, for a `gezel run` in a
 * terminal that found no model. Resolves true once setup hands over (a model
 * chosen, or "Not now"), false when the person leaves with Ctrl+C. The screens
 * draw on stderr: stdout carries only the reply, even when it is redirected.
 */
export async function launchRunSetup(opts: { client: GezelClient }): Promise<boolean> {
  let finished = false;
  const instance = render(
    <BootstrapGate client={opts.client} nextStep="run">
      <ExitWhenReady
        onReady={() => {
          finished = true;
        }}
      />
    </BootstrapGate>,
    { stdout: process.stderr, exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  return finished;
}
