/**
 * Phase 7 — meta-boekwachter (deterministic tier). Frontmatter senders become
 * cross-file entities; find_entity / list_entity_mentions surface the who/where.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';

let dir: string;
let home: string;
let ci: ContentIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-ent-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-ent-home-'));
  ci = new ContentIndex({ projectWorkspaceDir: async () => dir } as unknown as Store, home);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('entity-intel', () => {
  it('resolves senders across files and lists their mentions by date', async () => {
    await writeFile(
      join(dir, 'a1.md'),
      '---\nfrom: Alice <alice@example.com>\ndate: 2026-06-01\n---\n\nfirst note\n',
    );
    await writeFile(
      join(dir, 'a2.md'),
      '---\nfrom: alice@example.com\ndate: 2026-06-03\n---\n\nsecond note\n',
    );
    await writeFile(
      join(dir, 'b1.md'),
      '---\nfrom: Bob <bob@example.com>\ndate: 2026-06-02\n---\n\nbob note\n',
    );

    // refresh indexes (frontmatter → metadata) and rebuilds entities.
    await ci.refresh('c');

    const found = await ci.findEntity('c', { kind: 'person' });
    expect(found.engine).toBe('index');
    const byLabel = new Map(found.entities.map((e) => [e.canonical, e]));
    expect(byLabel.get('alice@example.com')?.mentions).toBe(2);
    expect(byLabel.get('bob@example.com')?.mentions).toBe(1);

    const mentions = await ci.listEntityMentions('c', 'alice');
    expect(mentions.found).toBe(true);
    expect(mentions.entity?.kind).toBe('person');
    expect(mentions.mentions.map((m) => m.path)).toEqual(['a1.md', 'a2.md']);
    expect(mentions.mentions[0]?.date).toBe('2026-06-01');
  });

  it('returns not-found for an unknown entity', async () => {
    await writeFile(join(dir, 'x.md'), '---\nfrom: a@b.com\n---\n\nhi\n');
    await ci.refresh('c');
    const res = await ci.listEntityMentions('c', 'nobody@nowhere');
    expect(res.found).toBe(false);
  });
});
