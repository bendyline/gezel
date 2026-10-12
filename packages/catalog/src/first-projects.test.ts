/**
 * The welcome's first projects must land where they promise. Each card's
 * sentence goes through the kickoff's own routing against the pinned
 * catalog's project types, so a gilde release that renames a type or
 * shares a tag another type now uses fails here rather than on someone's
 * first request.
 */

import {
  type BriefRoutableType,
  FIRST_PROJECTS,
  briefAsksForBuild,
  matchProjectTypeForBrief,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { CatalogService } from './service.js';

describe('first projects against the pinned catalog', () => {
  it('routes every first project to its project type, filled from its own words', async () => {
    const items = await new CatalogService().list('project-type');
    const types = items.map((item) => item.manifest as unknown as BriefRoutableType);
    for (const first of FIRST_PROJECTS) {
      expect(briefAsksForBuild(first.prompt), first.id).toBe(false);
      const match = matchProjectTypeForBrief(first.prompt, types);
      expect(match?.typeId, first.id).toBe(first.typeId);
      // Every required parameter comes from the sentence itself, never a
      // schema placeholder ("somewhere wonderful", a made-up date).
      const type = types.find((t) => t.id === first.typeId)!;
      for (const key of type.params?.required ?? []) {
        const value = match?.params[key];
        expect(value, `${first.id}.${key}`).toBeTruthy();
        expect(first.prompt.toLowerCase(), `${first.id}.${key}`).toContain(
          String(value).toLowerCase(),
        );
      }
    }
  });
});
