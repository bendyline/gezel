import { KNOWLEDGE_EMBEDDING_PROFILE_IDS } from '@bendyline/gezel';
import { KNOWLEDGE_EMBEDDING_PROFILES } from '@bendyline/gezel-knowledge';
import { describe, expect, it } from 'vitest';

describe('embedding profile ids', () => {
  it('the gilde-facing allowlist in core equals the registered profiles', () => {
    expect([...KNOWLEDGE_EMBEDDING_PROFILE_IDS].sort()).toEqual(
      KNOWLEDGE_EMBEDDING_PROFILES.map((p) => p.id).sort(),
    );
  });
});
