import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMUNITY_POLICY_MODULE, loadCommunityPolicy } from './community-policy.js';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function gildeWith(moduleSource?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gezel-gilde-policy-'));
  roots.push(root);
  if (moduleSource !== undefined) {
    const path = join(root, COMMUNITY_POLICY_MODULE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, moduleSource);
  }
  return root;
}

describe('loadCommunityPolicy', () => {
  it('uses the policy the gilde checkout ships', async () => {
    const root = await gildeWith(
      `export function communityPolicyViolation({ identity }) {
        return /casino/i.test(identity.description) ? { rule: 'gambling', detail: 'casino' } : null;
      }`,
    );
    const policy = await loadCommunityPolicy(root);
    expect(policy?.({ identity: { description: 'A casino game.' }, versions: [] })).toEqual({
      rule: 'gambling',
      detail: 'casino',
    });
    expect(policy?.({ identity: { description: 'Weather.' }, versions: [] })).toBeNull();
  });

  it('returns null for a checkout that predates the policy', async () => {
    expect(await loadCommunityPolicy(await gildeWith())).toBeNull();
  });

  it('refuses a module that no longer exports the policy', async () => {
    const root = await gildeWith('export const somethingElse = 1;');
    await expect(loadCommunityPolicy(root)).rejects.toThrow(/communityPolicyViolation/);
  });
});
