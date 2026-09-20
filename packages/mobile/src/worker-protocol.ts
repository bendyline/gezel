import type { MobileProvider, MobileProviderId, MobileSnapshot } from '@bendyline/gezel/schemas';
import type { MobileInference } from './runtime/contracts.js';

export type ClientCommand =
  | { method: 'snapshot' | 'providers' | 'newConversation' | 'cancel' | 'retrySave' }
  | { method: 'setProvider'; providerId: MobileProviderId }
  | { method: 'send'; text: string }
  | { method: 'selectConversation' | 'deleteConversation'; sessionId: string }
  | { method: 'renameConversation'; sessionId: string; title: string };

export type HostCommand =
  | { method: 'load' | 'providers' }
  | { method: 'save'; data: string }
  | {
      method: 'generate';
      request: Parameters<MobileInference['generate']>[0];
    }
  | { method: 'cancel'; requestId: string };

export type ToWorker =
  | { kind: 'request'; id: number; command: ClientCommand }
  | { kind: 'hostReply'; id: number; value?: unknown; error?: string }
  | { kind: 'delta'; requestId: string; delta: string };

export type FromWorker =
  | { kind: 'reply'; id: number; value?: MobileSnapshot | MobileProvider[]; error?: string }
  | { kind: 'snapshot'; snapshot: MobileSnapshot }
  | { kind: 'hostRequest'; id: number; command: HostCommand };
