/**
 * Website lookouts: after a pass that changed pages, hand each new pass's
 * changes to the lookout engine once. Only passes since this boot count, so a
 * restart never replays old alerts.
 */

import { createLogger } from '@bendyline/gezel';
import type { Store } from '../../fs/store.js';
import type { LookoutManager } from '../../lookouts/manager.js';
import type { ConnectorManager, ConnectorSyncedInfo } from '../manager.js';
import { readChangeBatches } from './website-changes.js';

const log = createLogger('lookouts');

function siteLabelFor(
  binding: { displayName?: string; config?: Record<string, unknown> } | undefined,
) {
  if (binding?.displayName) return binding.displayName;
  const sites = (binding?.config?.sites as string[] | undefined) ?? [];
  if (sites.length !== 1) return 'a website';
  try {
    return new URL(sites[0]!).hostname;
  } catch {
    return 'a website';
  }
}

export function websiteLookoutFeed(deps: {
  store: Store;
  connectors: ConnectorManager;
  lookouts: Pick<LookoutManager, 'acceptWebsite'>;
}): (projectId: string, info: ConnectorSyncedInfo) => void {
  const seenSince = new Map<string, string>();
  const bootIso = new Date().toISOString();
  return (projectId, info) => {
    if (info.type !== 'website' || info.written + info.removed === 0) return;
    const stateDir = deps.connectors.bindingStateDir(projectId, info.bindingId);
    if (!stateDir) return;
    void (async () => {
      const batches = await readChangeBatches(stateDir, seenSince.get(info.bindingId) ?? bootIso);
      if (batches.length === 0) return;
      seenSince.set(info.bindingId, batches[batches.length - 1]!.at);
      const project = await deps.store.getProject(projectId);
      const siteLabel = siteLabelFor(project?.connectors?.find((b) => b.id === info.bindingId));
      for (const batch of batches) {
        deps.lookouts.acceptWebsite({
          projectId,
          bindingId: info.bindingId,
          passId: batch.at,
          at: batch.at,
          siteLabel,
          changes: batch.changes,
        });
      }
    })().catch((err) => log.warn(`website lookouts: ${err instanceof Error ? err.message : err}`));
  };
}
