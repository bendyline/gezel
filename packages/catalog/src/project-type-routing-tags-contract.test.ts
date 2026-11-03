/**
 * Contract test: a project type's own routing words name that type alone.
 * The kickoff routes a brief on tags no other type carries, and a tag also
 * names its singular and any longer word it starts. So Event Desk's "events"
 * tied Event Planner's "event", and Vendor & Contract Desk's "spend" tied
 * Household Budget's "spending": either brief then routed nowhere. Run before
 * the business apps shipped (2026-11-02), this found nine such words.
 */
import { type BriefRoutableType, projectTypesMentionedByBrief } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { CatalogService } from './service.js';

function spoken(tag: string): string[] {
  return tag.length >= 4 && tag.endsWith('s') ? [tag, tag.slice(0, -1)] : [tag, `${tag}s`];
}

describe('project type routing tags', () => {
  it('name only the type that carries them', async () => {
    const items = await new CatalogService().list('project-type');
    const types = items.map((item) => item.manifest as unknown as BriefRoutableType);
    const carriers = new Map<string, number>();
    for (const type of types)
      for (const tag of type.tags ?? []) carriers.set(tag, (carriers.get(tag) ?? 0) + 1);
    const overlaps: string[] = [];
    for (const type of types) {
      if (!type.gezels?.some((gezel) => gezel.voorman === true)) continue;
      for (const tag of type.tags ?? []) {
        if (carriers.get(tag) !== 1) continue;
        for (const word of spoken(tag)) {
          const others = projectTypesMentionedByBrief(word, types).filter((id) => id !== type.id);
          if (others.length)
            overlaps.push(`${type.id} "${tag}": "${word}" also names ${others.join(', ')}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });
});
