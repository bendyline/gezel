/**
 * Mail's background sync loop — now a thin `ConnectorSyncManager` subclass. The
 * idle/posture/staleness/one-per-tick machinery lives in the connector core;
 * this only supplies mail's source binding (`p.mail.accounts`), its posture gate
 * (`allowExternalServices`, of which `allowMail` is an alias), and `syncProject`.
 */

import type { ChatManager } from '../chat/manager.js';
import { ConnectorSyncManager } from '../connectors/sync-manager.js';
import type { Store } from '../fs/store.js';
import type { SystemIdleState } from '../system/idle-state.js';
import type { MailManager } from './manager.js';

export interface MailSyncManagerOptions {
  store: Store;
  chat: ChatManager;
  idle: SystemIdleState;
  mail: MailManager;
  isNightShiftActive?: () => boolean;
  intervalMs?: number;
  startupDelayMs?: number;
  osIdleThresholdMs?: number;
  syncIntervalMs?: number;
}

export class MailSyncManager extends ConnectorSyncManager {
  constructor(opts: MailSyncManagerOptions) {
    super({
      store: opts.store,
      chat: opts.chat,
      idle: opts.idle,
      ...(opts.isNightShiftActive ? { isNightShiftActive: opts.isNightShiftActive } : {}),
      ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
      ...(opts.startupDelayMs !== undefined ? { startupDelayMs: opts.startupDelayMs } : {}),
      ...(opts.osIdleThresholdMs !== undefined
        ? { osIdleThresholdMs: opts.osIdleThresholdMs }
        : {}),
      ...(opts.syncIntervalMs !== undefined ? { syncIntervalMs: opts.syncIntervalMs } : {}),
      source: {
        label: 'mail',
        listBindings: (p) => p.mail?.accounts ?? [],
        posture: (pol) => pol.allowExternalServices,
        syncProject: (p) => opts.mail.syncProject(p),
      },
    });
  }
}
