import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stampPageLibrarySeed } from './page-library-seed.js';

let resources: string;

beforeEach(async () => {
  resources = await mkdtemp(join(tmpdir(), 'gezel-resources-'));
});

afterEach(async () => {
  await rm(resources, { recursive: true, force: true });
});

describe('stampPageLibrarySeed', () => {
  it('points the daemon at libraries that shipped with the app', async () => {
    await mkdir(join(resources, 'page-libraries'));
    const env: NodeJS.ProcessEnv = {};
    expect(stampPageLibrarySeed({ resourcesPath: resources, env })).toBe(
      join(resources, 'page-libraries'),
    );
    expect(env.GEZEL_PAGE_LIBRARIES_DIR).toBe(join(resources, 'page-libraries'));
  });

  it('does nothing for a build without them, and keeps an inherited folder', async () => {
    const env: NodeJS.ProcessEnv = {};
    expect(stampPageLibrarySeed({ resourcesPath: resources, env })).toBeNull();
    expect(env.GEZEL_PAGE_LIBRARIES_DIR).toBeUndefined();

    await mkdir(join(resources, 'page-libraries'));
    const mine: NodeJS.ProcessEnv = { GEZEL_PAGE_LIBRARIES_DIR: '/my/shelf' };
    expect(stampPageLibrarySeed({ resourcesPath: resources, env: mine })).toBeNull();
    expect(mine.GEZEL_PAGE_LIBRARIES_DIR).toBe('/my/shelf');
    expect(stampPageLibrarySeed({ resourcesPath: undefined, env })).toBeNull();
  });
});
