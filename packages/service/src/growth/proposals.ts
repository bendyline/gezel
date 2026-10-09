/**
 * Level-up proposals on the desktop: the shared generator in core
 * (core/src/growth/proposals.ts), fed from the store, the memory manager and
 * the Klerk one-shot.
 */

import {
  type GezelFrontmatter,
  type GezelGrowthState,
  type GrowthProposal,
  generateGrowthProposals,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { CompactOneShot } from '../memory/compaction.js';
import type { MemoryManager } from '../memory/manager.js';

export {
  type CorpusEntry,
  type TraitProposalDraft,
  buildPayoutOptions,
  parseProposalOutput,
} from '@bendyline/gezel';

export interface ProposalGenArgs {
  store: Store;
  memory: MemoryManager;
  oneShot: CompactOneShot;
  gezelId: string;
  toLevel: number;
  state: GezelGrowthState;
  frontmatter: Pick<GezelFrontmatter, 'tuningProfile' | 'suggestedTuningProfile'>;
  /** When false, skip the Klerk call entirely (payout options only). */
  allowKlerk: boolean;
}

/** Build the full 2–4 proposal set for a pending level-up. */
export function generateProposals(args: ProposalGenArgs): Promise<GrowthProposal[]> {
  const { store, memory, oneShot, gezelId } = args;
  return generateGrowthProposals({
    sources: {
      authoredEntries: () => memory.authoredEntries(gezelId),
      activeTraits: () => store.getGezel(gezelId).then((g) => g?.parsed.frontmatter.traits ?? []),
      lessons: () => store.readMemoryLessons(gezelId),
      complete: (prompt) =>
        oneShot(prompt, 180_000, { useKlerk: true, jobLabel: `growth proposals · ${gezelId}` }),
    },
    gezelId,
    toLevel: args.toLevel,
    state: args.state,
    frontmatter: args.frontmatter,
    allowKlerk: args.allowKlerk,
  });
}
