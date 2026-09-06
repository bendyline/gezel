import { gezelHome } from '@bendyline/gezel/paths';
import type { EngineContext } from './http/engine-context.js';
import { resolveEffectiveServiceRole } from './runtime-discovery.js';
import type { RunningService, StartServiceOptions } from './service-options.js';
export {
  DEFAULT_PORT,
  type RunningService,
  type RunningEngineService,
  type StartServiceOptions,
} from './service-options.js';

export function startService(
  opts: StartServiceOptions & { role: 'machine-engine' },
): Promise<RunningService<EngineContext>>;
export function startService(
  opts?: StartServiceOptions & { role?: 'user' | 'legacy-full' },
): Promise<RunningService>;
export function startService(opts: StartServiceOptions): Promise<RunningService<EngineContext>>;
/** Resolve ownership before importing either composition root. Legacy product homes
 * retain their compatibility role; an engine home never enters product startup. */
export async function startService(
  opts: StartServiceOptions = {},
): Promise<RunningService<EngineContext>> {
  const home = opts.home ?? gezelHome();
  const role = await resolveEffectiveServiceRole(opts.role, process.env, home);
  if (role === 'machine-engine') {
    const { startEngineService } = await import('./engine-service.js');
    return startEngineService({ ...opts, home, role });
  }
  const { startProductService } = await import('./product-service.js');
  return startProductService({ ...opts, home, role });
}
