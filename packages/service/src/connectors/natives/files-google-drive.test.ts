import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type BindingSyncResult, syncWithAdapter } from '../manager.js';
import { NATIVE_ADAPTERS } from '../registry.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import {
  DRIVE_DOC,
  DRIVE_FORM,
  DRIVE_SHEET,
  DRIVE_SHORTCUT,
  DRIVE_SLIDES,
  FakeGoogleDrive,
} from '../testing/fake-google-drive.js';
import { status } from '../testing/fake-http.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
  readCorpus,
} from '../testing/harness.js';
import type { ConnectorBindingRef } from '../types.js';
import {
  GoogleDriveFilesAdapter,
  isDriveThrottle,
  parseDriveFolderRef,
} from './files-google-drive.js';
import { registerFilesAdapters } from './files-shared.js';

const REQUIRED_KEYS = [
  'title',
  'path',
  'mime_type',
  'modified',
  'url',
  'provider',
  'file_id',
  'content',
];
const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0xfe,
]);

/** A Drive with a synced "Projects" folder covering every content kind. */
function seedDrive() {
  const drive = new FakeGoogleDrive();
  const projects = drive.addFolder('Projects');
  const reports = drive.addFolder('Reports', projects);
  const y2026 = drive.addFolder('2026', reports);
  const ids = {
    projects,
    reports,
    y2026,
    notes: drive.addFile('notes.md', projects, {
      mimeType: 'text/markdown',
      content: '# Notes\n\nShip the thing.',
    }),
    plan: drive.addFile('Plan', projects, {
      mimeType: DRIVE_DOC,
      exports: { 'text/markdown': '# Plan\n\nStep one.\n', 'text/plain': 'Plan\n\nStep one.' },
    }),
    budget: drive.addFile('Budget', reports, {
      mimeType: DRIVE_SHEET,
      exports: { 'text/csv': 'item,cost\nrent,100\nfood,"1,200"\n' },
    }),
    kickoff: drive.addFile('Kickoff', reports, {
      mimeType: DRIVE_SLIDES,
      exports: { 'text/plain': 'Kickoff\n\nGoals for the quarter' },
    }),
    pdf: drive.addFile('report.pdf', y2026, { mimeType: 'application/pdf', content: PDF }),
    csv: drive.addFile('data.csv', y2026, { mimeType: 'text/csv', content: 'a,b\n1,2\n' }),
    huge: drive.addFile('huge.mov', y2026, {
      mimeType: 'video/quicktime',
      reportedSize: 900 * 1024 * 1024,
    }),
    form: drive.addFile('Survey', projects, { mimeType: DRIVE_FORM }),
    shortcut: drive.addFile('Shortcut to Plan', projects, { mimeType: DRIVE_SHORTCUT }),
    outside: drive.addFile('outside.txt', drive.rootId, { content: 'not synced' }),
  };
  return { drive, ids, seeded: 8 };
}

function binding(config: Record<string, unknown>): ConnectorBindingRef {
  return { id: 'files-google-drive:b1', type: 'files-google-drive', config };
}

async function setup(
  config?: (ids: ReturnType<typeof seedDrive>['ids']) => Record<string, unknown>,
) {
  const env = await createConnectorTestEnv();
  const world = seedDrive();
  const b = binding(
    config?.(world.ids) ?? {
      folderIds: [`https://drive.google.com/drive/folders/${world.ids.projects}?usp=sharing`],
    },
  );
  await env.storeCredential(b, world.drive.credential());
  const adapter = () => new GoogleDriveFilesAdapter(b, env.deps({ fetch: world.drive.http.fetch }));
  return { env, ...world, b, adapter };
}

describeConnectorConformance('files-google-drive', {
  async create() {
    const { env, drive, ids, seeded, adapter } = await setup();
    let added = 0;
    return {
      env,
      seeded,
      requiredKeys: REQUIRED_KEYS,
      adapter: async () => adapter(),
      unrouted: () => drive.http.unrouted,
      hooks: {
        add: (n = 1) => {
          for (let i = 0; i < n; i++) {
            added++;
            drive.addFile(`added-${added}.txt`, ids.reports, { content: `added file ${added}` });
          }
        },
        update: () => drive.setContent(ids.notes, '# Notes\n\nShip the thing twice.'),
        remove: () => drive.deleteForever(ids.csv),
        move: () => drive.move(ids.notes, ids.reports),
        expireCursor: () => drive.expireTokens(),
        throttleNextList: () => {
          drive.http.failNext(
            { url: /\/drive\/v3\/changes\?/ },
            status(
              429,
              { error: { code: 429, message: 'Rate Limit Exceeded' } },
              { 'retry-after': '1' },
            ),
          );
        },
        revokeAuth: () => drive.revokeAll(),
        addHostile: () => {
          const folder = drive.addFolder(HOSTILE_NAME, ids.projects);
          drive.addFile(HOSTILE_NAME, folder, { content: INJECTION_PAYLOAD });
        },
      },
    };
  },
});

let env: ConnectorTestEnv | null = null;
afterEach(async () => {
  await env?.dispose();
  env = null;
});

async function sync(
  adapter: GoogleDriveFilesAdapter,
  cursor: unknown,
  corpusDir = 'data/drive',
  backfillLimit = 500,
): Promise<BindingSyncResult> {
  return syncWithAdapter(adapter, {
    storageDir: env!.artifactsDir,
    quarantineDir: env!.quarantineDir,
    corpusDir,
    backfillLimit,
    cursor,
    allowPrune: true,
  });
}

describe('files-google-drive records', () => {
  it('mirrors each content kind in the shared shape and leaves out shortcuts and other folders', async () => {
    const s = await setup();
    env = s.env;
    const r = await sync(s.adapter(), undefined);
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(8);
    const records = await assertCorpusInvariants(env.artifactsDir, 'data/drive', {
      requiredKeys: REQUIRED_KEYS,
    });
    const byTitle = Object.fromEntries(records.map((x) => [x.frontmatter.title, x]));
    expect(Object.keys(byTitle).sort()).toEqual(
      [
        'Budget',
        'Kickoff',
        'Plan',
        'Survey',
        'data.csv',
        'huge.mov',
        'notes.md',
        'report.pdf',
      ].sort(),
    );
    const scopeDir = s.ids.projects.toLowerCase();
    expect(byTitle['notes.md']!.path).toMatch(
      new RegExp(`^${scopeDir}/[0-9]{3}--notes-md--[0-9a-f]{8}[.]md$`),
    );
    expect(byTitle['report.pdf']!.path.startsWith(`${scopeDir}/reports/2026/`)).toBe(true);

    expect(byTitle.Plan!.frontmatter).toMatchObject({
      mime_type: DRIVE_DOC,
      content: 'inline',
      provider: 'google-drive',
      file_id: s.ids.plan,
      path: '/',
      modified_by: 'Ada Lovelace',
      owner: 'Ada Lovelace',
      direction: 'inbound',
    });
    expect(byTitle.Plan!.frontmatter).not.toHaveProperty('size');
    expect(byTitle.Plan!.body).toBe('# Plan\n\n# Plan\n\nStep one.');
    expect(byTitle.Budget!.body).toContain('| food | 1,200 |');
    expect(byTitle.Budget!.body).toContain('Only the first sheet is mirrored');
    expect(byTitle.Kickoff!.body).toContain('Goals for the quarter');
    expect(byTitle['data.csv']!.body).toContain('| a | b |');
    expect(byTitle['report.pdf']!.frontmatter).toMatchObject({
      content: 'attachment',
      size: String(PDF.length),
    });
    expect(byTitle['huge.mov']!.frontmatter.content).toBe('metadata-only');
    expect(byTitle['huge.mov']!.body).toMatch(/larger than the 25 MB download limit/);
    expect(byTitle.Survey!.frontmatter.content).toBe('metadata-only');

    const pdfRecordDir = join(env.artifactsDir, 'data/drive', scopeDir, 'reports/2026');
    const ordinal = byTitle['report.pdf']!.path.split('/').pop()!.slice(0, 3);
    const stored = await readFile(join(pdfRecordDir, 'attachments', ordinal, 'report.pdf'));
    expect(new Uint8Array(stored)).toEqual(PDF);
    expect(s.drive.http.unrouted).toEqual([]);
  });

  it('asks for exactly the fields it uses and never downloads the huge file', async () => {
    const s = await setup();
    env = s.env;
    await sync(s.adapter(), undefined);
    const list = s.drive.http.requests('GET', 'https://www.googleapis.com/drive/v3/files?');
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.url.searchParams.get('fields')).toContain(
      'lastModifyingUser(displayName,emailAddress)',
    );
    expect(list[0]!.url.searchParams.get('q')).toBe(
      `'${s.ids.projects}' in parents and trashed = false`,
    );
    const media = s.drive.http.calls.filter((c) => c.url.searchParams.get('alt') === 'media');
    expect(media.map((c) => c.url.pathname.split('/').pop()).sort()).toEqual(
      [s.ids.notes, s.ids.pdf, s.ids.csv].sort(),
    );
  });

  it('captures the start page token before the first folder listing', async () => {
    const s = await setup();
    env = s.env;
    await sync(s.adapter(), undefined);
    const order = s.drive.http.calls.map((c) => c.url.pathname);
    const start = order.indexOf('/drive/v3/changes/startPageToken');
    const firstList = order.indexOf('/drive/v3/files');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(firstList);
  });

  it('pages through a small backfill limit without skipping anything', async () => {
    const s = await setup();
    env = s.env;
    let cursor: unknown;
    let total = 0;
    for (let i = 0; i < 6; i++) {
      const r = await sync(s.adapter(), cursor, 'data/drive', 2);
      expect(r.error).toBeUndefined();
      expect(r.skipped).toBe(0);
      total += r.written;
      cursor = r.cursor;
    }
    expect(total).toBe(8);
  });

  it('mirrors details only when Drive refuses a download or an oversized export', async () => {
    const s = await setup();
    env = s.env;
    const locked = s.drive.addFile('locked.pdf', s.ids.projects, {
      mimeType: 'application/pdf',
      content: PDF,
      downloadRestricted: true,
    });
    s.drive.addFile('Giant Spec', s.ids.projects, { mimeType: DRIVE_DOC, exportTooLarge: true });
    const r = await sync(s.adapter(), undefined);
    expect(r.error).toBeUndefined();
    expect(r.errors).toBe(0);
    const byTitle = Object.fromEntries(
      (await readCorpus(env.artifactsDir, 'data/drive')).map((x) => [x.frontmatter.title, x]),
    );
    expect(byTitle['locked.pdf']!.frontmatter).toMatchObject({
      content: 'metadata-only',
      file_id: locked,
    });
    expect(byTitle['locked.pdf']!.body).toMatch(/turned off downloading/);
    expect(byTitle['Giant Spec']!.frontmatter.content).toBe('metadata-only');
    expect(byTitle['Giant Spec']!.body).toMatch(/too large to export/);
  });
});

describe('files-google-drive incremental changes', () => {
  it('re-paths every file under a renamed folder and drops the stale copies', async () => {
    const s = await setup();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    s.drive.rename(s.ids.reports, 'Quarterly Reports');
    const next = await sync(s.adapter(), first.cursor);
    expect(next.error).toBeUndefined();
    const records = await assertCorpusInvariants(env.artifactsDir, 'data/drive');
    expect(records).toHaveLength(8);
    const pdf = records.find((x) => x.frontmatter.title === 'report.pdf')!;
    expect(pdf.frontmatter.path).toBe('/Quarterly Reports/2026');
    expect(pdf.path).toContain('/quarterly-reports/2026/');
  });

  it('tombstones the files of a trashed folder (Drive reports only the folder)', async () => {
    const s = await setup();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    s.drive.trash(s.ids.y2026);
    const next = await sync(s.adapter(), first.cursor);
    expect(next.error).toBeUndefined();
    expect(next.pruned).toBe(3);
    const titles = (await readCorpus(env.artifactsDir, 'data/drive')).map(
      (x) => x.frontmatter.title,
    );
    expect(titles).not.toContain('report.pdf');
    expect(titles).toHaveLength(5);
  });

  it('walks a folder moved into the synced folder and tombstones one moved out', async () => {
    const s = await setup();
    env = s.env;
    const elsewhere = s.drive.addFolder('Elsewhere');
    s.drive.addFile('inside-elsewhere.txt', elsewhere, { content: 'hello' });
    const first = await sync(s.adapter(), undefined);
    s.drive.move(elsewhere, s.ids.projects);
    const movedIn = await sync(s.adapter(), first.cursor);
    expect(movedIn.written).toBe(1);
    s.drive.move(s.ids.reports, s.drive.rootId);
    const movedOut = await sync(s.adapter(), movedIn.cursor);
    expect(movedOut.pruned).toBe(5);
    const titles = (await readCorpus(env.artifactsDir, 'data/drive'))
      .map((x) => x.frontmatter.title)
      .sort();
    expect(titles).toEqual(['Plan', 'Survey', 'inside-elsewhere.txt', 'notes.md']);
  });

  it('a metadata-only change rewrites nothing', async () => {
    const s = await setup();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    s.drive.touch(s.ids.pdf);
    s.drive.touch(s.ids.plan);
    const next = await sync(s.adapter(), first.cursor);
    expect(next.error).toBeUndefined();
    expect(next.written).toBe(0);
    expect(next.skipped).toBe(2);
  });

  it('treats a 403 rateLimitExceeded on the change feed as backpressure', async () => {
    const s = await setup();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    s.drive.http.failNext(
      { url: /\/drive\/v3\/changes\?/ },
      status(403, {
        error: {
          code: 403,
          message: 'User Rate Limit Exceeded',
          errors: [
            {
              domain: 'usageLimits',
              reason: 'userRateLimitExceeded',
              message: 'User Rate Limit Exceeded',
            },
          ],
        },
      }),
    );
    const throttled = await sync(s.adapter(), first.cursor);
    expect(throttled.rateLimited).toBe(true);
    expect(throttled.error).toBeUndefined();
    expect(JSON.stringify(throttled.cursor)).toBe(JSON.stringify(first.cursor));
  });

  it('keeps each configured folder in its own scope with its own cursor', async () => {
    const s = await setup((ids) => ({ folderIds: [ids.projects, ids.y2026] }));
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    expect(first.scopes).toEqual([s.ids.projects, s.ids.y2026]);
    const y2026Records = await readCorpus(
      env.artifactsDir,
      `data/drive/${s.ids.y2026.toLowerCase()}`,
    );
    expect(y2026Records.map((x) => x.frontmatter.title).sort()).toEqual([
      'data.csv',
      'huge.mov',
      'report.pdf',
    ]);
    expect(y2026Records.find((x) => x.frontmatter.title === 'data.csv')!.frontmatter.path).toBe(
      '/',
    );
    s.drive.setContent(s.ids.csv, 'a,b\n3,4\n');
    const next = await sync(s.adapter(), first.cursor);
    expect(next.written).toBe(2);
  });

  it('follows a shared drive folder through that drive’s own change feed', async () => {
    const env0 = await createConnectorTestEnv();
    env = env0;
    const drive = new FakeGoogleDrive();
    const team = drive.addFolder('Team Drive', drive.rootId, { driveId: '0ASharedDrive1' });
    drive.addFile('handbook.md', team, { mimeType: 'text/markdown', content: '# Handbook' });
    const b = binding({ folderIds: [team] });
    await env0.storeCredential(b, drive.credential());
    const adapter = () => new GoogleDriveFilesAdapter(b, env0.deps({ fetch: drive.http.fetch }));
    const first = await sync(adapter(), undefined);
    expect(first.written).toBe(1);
    const start = drive.http.requests(
      'GET',
      'https://www.googleapis.com/drive/v3/changes/startPageToken',
    );
    expect(start[0]!.url.searchParams.get('driveId')).toBe('0ASharedDrive1');
    const list = drive.http.requests('GET', 'https://www.googleapis.com/drive/v3/files?');
    expect(list[0]!.url.searchParams.get('corpora')).toBe('drive');
    drive.addFile('policy.md', team, { mimeType: 'text/markdown', content: '# Policy' });
    const next = await sync(adapter(), first.cursor);
    expect(next.written).toBe(1);
    const changes = drive.http.requests('GET', 'https://www.googleapis.com/drive/v3/changes?');
    expect(changes.every((c) => c.url.searchParams.get('driveId') === '0ASharedDrive1')).toBe(true);
  });
});

describe('files-google-drive configuration', () => {
  it('requires a folder unless the whole Drive is chosen', async () => {
    const s = await setup(() => ({}));
    env = s.env;
    const r = await sync(s.adapter(), undefined);
    expect(r.error).toMatch(/Choose at least one Google Drive folder/);
    expect(s.drive.http.calls).toHaveLength(0);
  });

  it('syncs the whole My Drive when asked, outside file included', async () => {
    const s = await setup(() => ({ wholeDrive: true }));
    env = s.env;
    const r = await sync(s.adapter(), undefined);
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(9);
    expect(r.scopes).toEqual(['']);
  });

  it('reports a folder it cannot open in words a person can act on', async () => {
    const s = await setup(() => ({ folderIds: ['1NoSuchFolder'] }));
    env = s.env;
    const r = await sync(s.adapter(), undefined);
    expect(r.error).toMatch(/was not found, or this Google account cannot open it/);
    await s.env.dispose();
    const file = await setup((ids) => ({ folderIds: [ids.pdf] }));
    env = file.env;
    expect((await sync(file.adapter(), undefined)).error).toMatch(/is a file, not a folder/);
  });

  it('parses folder links and ids, and refuses anything else', () => {
    expect(
      parseDriveFolderRef('https://drive.google.com/drive/u/0/folders/1AbC_d-9?usp=sharing'),
    ).toBe('1AbC_d-9');
    expect(parseDriveFolderRef('https://drive.google.com/open?id=1XyZ')).toBe('1XyZ');
    expect(parseDriveFolderRef(' 1Bare_Id ')).toBe('1Bare_Id');
    expect(() => parseDriveFolderRef('https://evil.example/folders/1x')).toThrow(
      /not a Google Drive link/,
    );
    expect(() => parseDriveFolderRef("x' or name contains 'y")).toThrow(
      /not a Google Drive folder/,
    );
  });

  it('counts Drive 403 rate-limit reasons as throttles but not other 403s', async () => {
    const { HttpStatusError } = await import('@bendyline/gezel');
    expect(
      isDriveThrottle(
        new HttpStatusError(403, 'Google Drive 403: {"reason":"userRateLimitExceeded"}'),
      ),
    ).toBe(true);
    expect(isDriveThrottle(new HttpStatusError(429, 'x'))).toBe(true);
    expect(isDriveThrottle(new HttpStatusError(403, 'insufficientFilePermissions'))).toBe(false);
  });

  it('registers all three cloud-files adapters', async () => {
    registerFilesAdapters();
    for (const id of ['files-google-drive', 'files-onedrive', 'files-sharepoint']) {
      expect(NATIVE_ADAPTERS.has(id)).toBe(true);
    }
    const s = await setup();
    env = s.env;
    const made = await NATIVE_ADAPTERS.get('files-google-drive')!(s.b, s.env.deps());
    expect(made.typeId).toBe('files-google-drive');
    await made.close();
  });
});
