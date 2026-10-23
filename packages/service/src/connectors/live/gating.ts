/**
 * Whether a device binding may run, and why not. Pure, so the table every
 * surface explains ("Paused", "Held: …") is pinned by tests.
 *
 * Local capture is not network traffic, so the security level does not gate
 * a webcam; it does gate a network camera, which is LAN traffic the app
 * makes (`allowConnectorData`). A camera is the person's explicit setup, so
 * Chat-only engagement keeps it recording — only its vision reviews and
 * lookouts wait — and only "Off" stops it.
 */

import type { ProjectConnectorBinding } from '@bendyline/gezel';
import { projectAcceptsLiveWork } from '@bendyline/gezel';

export interface LiveGateInput {
  binding: Pick<ProjectConnectorBinding, 'disabled' | 'disabledReason'>;
  project: {
    status?: 'active' | 'readonly' | 'inactive' | 'stable';
    archived?: boolean;
    storageScope?: 'user' | 'machine-shared';
  };
  engagementOff: boolean;
  /** The device reaches it over the network (an IP camera). */
  network: boolean;
  allowConnectorData: boolean;
}

export type LiveGate = { run: true } | { run: false; state: 'paused' | 'held'; reason: string };

export function liveGate(input: LiveGateInput): LiveGate {
  if (input.binding.disabled) {
    return {
      run: false,
      state: 'paused',
      reason:
        input.binding.disabledReason === 'emergency-stop'
          ? 'Stopped by the emergency stop. Resume it when you are ready.'
          : 'Paused.',
    };
  }
  if (!projectAcceptsLiveWork(input.project)) {
    return {
      run: false,
      state: 'held',
      reason: 'This project is read-only, inactive, or archived.',
    };
  }
  if (input.project.storageScope === 'machine-shared') {
    return {
      run: false,
      state: 'held',
      reason: 'Cameras cannot run on a project shared by every account on this computer.',
    };
  }
  if (input.engagementOff) {
    return {
      run: false,
      state: 'held',
      reason: 'AI engagement is off (Settings → Artificial Intelligence).',
    };
  }
  if (input.network && !input.allowConnectorData) {
    return { run: false, state: 'held', reason: 'Security settings keep Gezel off the network.' };
  }
  return { run: true };
}
