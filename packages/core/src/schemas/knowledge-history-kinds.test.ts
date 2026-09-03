import { describe, expect, it } from 'vitest';
import { HistoryEventKindSchema } from './history.js';
import { KNOWLEDGE_HISTORY_KINDS } from './knowledge.js';

describe('knowledge history kinds', () => {
  it('every knowledge kind is a recognised history event kind', () => {
    for (const kind of KNOWLEDGE_HISTORY_KINDS) {
      expect(HistoryEventKindSchema.options).toContain(kind);
    }
  });
});
