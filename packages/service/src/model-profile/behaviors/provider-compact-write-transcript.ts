/**
 * `provider.compact-write-transcript` — marker behavior for local
 * providers that should omit successful large write payloads from the
 * future model transcript. The tool still receives the full content;
 * only the provider's private chat history is compacted after success.
 */

import type { Behavior } from '../types.js';

export const ProviderCompactWriteTranscript: Behavior = {
  id: 'provider.compact-write-transcript',
  description:
    'Compacts successful large writeFile/appendToFile arguments in the local provider transcript after execution, preserving path + byte count while telling the model to readFile for current contents. OFF by default; A/B via GEZEL_FORCE_BEHAVIORS.',
};
