import { gezelHome } from '@bendyline/gezel/paths';
import type { EngineContext } from './http/engine-context.js';
import type { RunningInferenceOnlyService } from './inference-host.js';
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
