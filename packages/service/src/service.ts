import { disableOnnxRuntimeTelemetry } from '@bendyline/gezel/native';
import { gezelHome } from '@bendyline/gezel/paths';
import { daemonHost } from './daemon-host.js';
import type { EngineContext } from './http/engine-context.js';
import type { RunningInferenceOnlyService } from './inference-host.js';
import { routeServiceLogs } from './log-routing.js';
import { resolveEffectiveServiceRole } from './runtime-discovery.js';
import type { RunningService, StartServiceOptions } from './service-options.js';
export type { RunningInferenceOnlyService } from './inference-host.js';
export {
  DEFAULT_PORT,
  type RunningService,
  type RunningEngineService,
  type StartServiceOptions,
} from './service-options.js';

export function startService(
  opts: StartServiceOptions & { embeddedInferenceOnly: true },
): Promise<RunningInferenceOnlyService>;
export function startService(
  opts: StartServiceOptions & { role: 'machine-engine'; embeddedInferenceOnly?: false },
): Promise<RunningService<EngineContext>>;
export function startService(
  opts?: StartServiceOptions & { role?: 'user' | 'legacy-full'; embeddedInferenceOnly?: false },
): Promise<RunningService>;
export function startService(
  opts: StartServiceOptions,
): Promise<RunningService<EngineContext> | RunningInferenceOnlyService>;
/** Resolve ownership before importing either composition root. Legacy product homes
 * retain their compatibility role; an engine home never enters product startup. The
 * inference-only profile is neither: the inference package owns it. */
export async function startService(
  opts: StartServiceOptions = {},
): Promise<RunningService<EngineContext> | RunningInferenceOnlyService> {
  // Before any child process is spawned: see daemon-host.ts.
  daemonHost();
  // Before any worker or child loads ONNX Runtime: see core native/onnx-telemetry.ts.
  disableOnnxRuntimeTelemetry();
  const home = opts.home ?? gezelHome();
  // A library's stdout belongs to its caller: unset means stderr, and only a
  // process that is nothing but the daemon asks for 'split'.
  const logOutput = opts.logOutput ?? 'stderr';
  const restoreLogs = routeServiceLogs(logOutput, home);
  try {
    const running = await startForRole({ ...opts, home, logOutput });
    restoreLogsOnStop(running, restoreLogs);
    return running;
  } catch (error) {
    await restoreLogs();
    throw error;
  }
}

function restoreLogsOnStop(running: { stop(): Promise<void> }, restore: () => Promise<void>): void {
  const stop = running.stop.bind(running);
  running.stop = async () => {
    try {
      await stop();
    } finally {
      await restore();
    }
  };
}

async function startForRole(
  opts: StartServiceOptions,
): Promise<RunningService<EngineContext> | RunningInferenceOnlyService> {
  const home = opts.home ?? gezelHome();
  if (opts.embeddedInferenceOnly) {
    const { startInferenceOnlyService } = await import('./inference-host.js');
    return startInferenceOnlyService({ ...opts, home });
  }
  const role = await resolveEffectiveServiceRole(opts.role, process.env, home);
  if (role === 'machine-engine') {
    const { startEngineService } = await import('./engine-service.js');
    return startEngineService({ ...opts, home, role });
  }
  const { startProductService } = await import('./product-service.js');
  return startProductService({ ...opts, home, role });
}
