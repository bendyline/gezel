import { afterEach, describe, expect, it } from 'vitest';
import { type BindingSyncResult, syncWithAdapter } from '../manager.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import { FakeGraphDrive, GRAPH_DOWNLOAD_ORIGIN, GRAPH_V1 } from '../testing/fake-graph-drive.js';
import { json, status } from '../testing/fake-http.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
  readCorpus,
} from '../testing/harness.js';
import type { ConnectorBindingRef } from '../types.js';
import {
  OneDriveFilesAdapter,
  SharePointFilesAdapter,
  UnsafeGraphLinkError,
  assertGraphUrl,
  encodeDrivePath,
  parseSharePointSiteUrl,
} from './files-microsoft.js';

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
const DOCX = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0xde, 0xad, 0xbe, 0xef,
]);

/** Seed a folder tree under `parent` with every content kind; returns ids. */
function seedTree(graph: FakeGraphDrive, parent: string) {
  const reports = graph.addFolder('Reports', parent);
  return {
    reports,
    notes: graph.addFile('notes.md', parent, {
      mimeType: 'text/markdown',
      content: '# Notes\n\nShip it.',
    }),
    script: graph.addFile('build.py', parent, {
      mimeType: 'text/x-python',
      content: 'print("ok")\n',
    }),
    docx: graph.addFile('Brief.docx', reports, {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: DOCX,
    }),
    csv: graph.addFile('data.csv', reports, { mimeType: 'text/csv', content: 'a,b\n1,2\n' }),
    huge: graph.addFile('backup.zip', reports, {
      mimeType: 'application/zip',
      reportedSize: 2 * 1024 ** 3,
    }),
    notebook: graph.addFile('Team Notebook', parent, { package: true }),
    shortcut: graph.addFile('Shared with me', parent, {
      mimeType: 'application/pdf',
      remote: true,
    }),
  };
}

/** A work OneDrive with the synced folder at Documents/Projects. */
function oneDriveWorld() {
  const graph = new FakeGraphDrive();
  const drive = graph.addDrive(
    'OneDrive',
    'business',
    'https://contoso-my.sharepoint.com/personal/grace/Documents',
  );
  graph.meDrive = drive.id;
  const documents = graph.addFolder('Documents', drive.rootId);
  const projects = graph.addFolder('Projects', documents);
  const ids = { documents, projects, ...seedTree(graph, projects) };
  graph.addFile('outside.txt', documents, { content: 'not synced' });
  return { graph, drive, ids, seeded: 5 };
}

/** A SharePoint site with two libraries; the binding syncs the "Legal" one. */
function sharePointWorld() {
  const graph = new FakeGraphDrive();
  const docs = graph.addDrive(
    'Documents',
    'documentLibrary',
    'https://contoso.sharepoint.com/sites/Finance/Shared%20Documents',
  );
  const legal = graph.addDrive(
    'Legal',
    'documentLibrary',
    'https://contoso.sharepoint.com/sites/Finance/Legal%20Files',
  );
  graph.addSite('contoso.sharepoint.com', '/sites/Finance', [docs, legal]);
  graph.addFile('budget.txt', docs.rootId, { content: 'default library, not synced' });
  const ids = { projects: legal.rootId, ...seedTree(graph, legal.rootId) };
  return { graph, drive: legal, docs, ids, seeded: 5 };
}

type World = ReturnType<typeof oneDriveWorld> | ReturnType<typeof sharePointWorld>;

async function setupOneDrive(
  config: Record<string, unknown> = { folderPath: 'Documents/Projects' },
) {
  const env = await createConnectorTestEnv();
  const world = oneDriveWorld();
  const b: ConnectorBindingRef = {
    id: 'files-onedrive:b1',
    type: 'files-onedrive',
    config: { tenant: 'common', ...config },
  };
  await env.storeCredential(b, world.graph.credential('common'));
  return {
    env,
    ...world,
    b,
    adapter: () => new OneDriveFilesAdapter(b, env.deps({ fetch: world.graph.http.fetch })),
  };
}

async function setupSharePoint(
  config: Record<string, unknown> = {
    siteUrl: 'https://contoso.sharepoint.com/sites/Finance/Legal%20Files/Forms/AllItems.aspx',
    library: 'Legal',
  },
) {
  const env = await createConnectorTestEnv();
  const world = sharePointWorld();
  const b: ConnectorBindingRef = {
    id: 'files-sharepoint:b1',
    type: 'files-sharepoint',
    config: { tenant: 'organizations', ...config },
  };
  await env.storeCredential(b, world.graph.credential('organizations'));
  return {
    env,
    ...world,
    b,
    adapter: () => new SharePointFilesAdapter(b, env.deps({ fetch: world.graph.http.fetch })),
  };
}

function conformanceHooks(world: World) {
  const { graph, ids } = world;
  let added = 0;
  return {
    add: (n = 1) => {
      for (let i = 0; i < n; i++) {
        added++;
        graph.addFile(`added-${added}.txt`, ids.reports, { content: `added file ${added}` });
      }
    },
    update: () => graph.setContent(ids.notes, '# Notes\n\nShip it twice.'),
    remove: () => graph.delete(ids.csv),
    move: () => graph.move(ids.notes, ids.reports),
    expireCursor: () => graph.expireTokens(),
    throttleNextList: () => {
      graph.http.failNext(
        { url: /\/root\/delta\?/ },
        status(
          429,
          { error: { code: 'TooManyRequests', message: 'Please retry after 1 second.' } },
          { 'retry-after': '1' },
        ),
      );
    },
    revokeAuth: () => graph.revokeAll(),
    addHostile: () => {
      const folder = graph.addFolder(HOSTILE_NAME, ids.projects);
      graph.addFile(HOSTILE_NAME, folder, { content: INJECTION_PAYLOAD });
    },
  };
}

describeConnectorConformance('files-onedrive', {
  async create() {
    const s = await setupOneDrive();
    return {
      env: s.env,
      seeded: s.seeded,
      requiredKeys: REQUIRED_KEYS,
      adapter: async () => s.adapter(),
      unrouted: () => [...s.graph.http.unrouted, ...s.graph.authLeaks],
      hooks: conformanceHooks(s),
    };
  },
});

describeConnectorConformance('files-sharepoint', {
  async create() {
    const s = await setupSharePoint();
    return {
      env: s.env,
      seeded: s.seeded,
      requiredKeys: REQUIRED_KEYS,
      adapter: async () => s.adapter(),
      unrouted: () => [...s.graph.http.unrouted, ...s.graph.authLeaks],
      hooks: conformanceHooks(s),
    };
  },
});

let env: ConnectorTestEnv | null = null;
afterEach(async () => {
  await env?.dispose();
  env = null;
});

async function sync(
  adapter: OneDriveFilesAdapter | SharePointFilesAdapter,
  cursor: unknown,
): Promise<BindingSyncResult> {
  return syncWithAdapter(adapter, {
    storageDir: env!.artifactsDir,
    quarantineDir: env!.quarantineDir,
    corpusDir: 'data/files',
    backfillLimit: 500,
    cursor,
    // The manifests declare `completeness: mirror`, which is what lets the
    // engine prune after a full enumeration.
    allowPrune: true,
  });
}

describe('files-onedrive', () => {
  it('mirrors the configured folder in the shared record shape', async () => {
    const s = await setupOneDrive();
    env = s.env;
    const r = await sync(s.adapter(), undefined);
    expect(r.error).toBeUndefined();
    const records = await assertCorpusInvariants(env.artifactsDir, 'data/files', {
      requiredKeys: REQUIRED_KEYS,
    });
    const byTitle = Object.fromEntries(records.map((x) => [x.frontmatter.title, x]));
    expect(Object.keys(byTitle).sort()).toEqual([
      'Brief.docx',
      'backup.zip',
      'build.py',
      'data.csv',
      'notes.md',
    ]);
    expect(byTitle['notes.md']!.frontmatter).toMatchObject({
      provider: 'onedrive',
      path: '/',
      content: 'inline',
      modified_by: 'Grace Hopper',
      file_id: s.ids.notes,
    });
    expect(byTitle['build.py']!.body).toContain('```python\nprint("ok")\n```');
    expect(byTitle['Brief.docx']!.frontmatter).toMatchObject({
      content: 'attachment',
      path: '/Reports',
    });
    expect(byTitle['Brief.docx']!.path.startsWith('reports/')).toBe(true);
    expect(byTitle['backup.zip']!.frontmatter.content).toBe('metadata-only');
    expect(s.graph.downloads).toBe(4);
  });

  it('never sends the bearer token to the pre-authenticated download host', async () => {
    const s = await setupOneDrive();
    env = s.env;
    await sync(s.adapter(), undefined);
    expect(s.graph.authLeaks).toEqual([]);
    const storage = s.graph.http.calls.filter((c) => c.url.origin === GRAPH_DOWNLOAD_ORIGIN);
    expect(storage.length).toBe(4);
    expect(storage.every((c) => !c.headers.has('authorization'))).toBe(true);
    const graphCalls = s.graph.http.calls.filter(
      (c) => c.url.origin === 'https://graph.microsoft.com',
    );
    expect(graphCalls.every((c) => c.bearer === 'seed-access')).toBe(true);
  });

  it('captures the latest delta link before walking, then follows root delta', async () => {
    const s = await setupOneDrive();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    const urls = s.graph.http.calls.map((c) => `${c.url.pathname}${c.url.search}`);
    const latest = urls.findIndex((u) => u.includes('/root/delta?token=latest'));
    const firstChildren = urls.findIndex((u) => u.includes('/children'));
    expect(latest).toBeGreaterThan(-1);
    expect(latest).toBeLessThan(firstChildren);
    s.graph.addFile('later.txt', s.ids.reports, { content: 'later' });
    const next = await sync(s.adapter(), first.cursor);
    expect(next.written).toBe(1);
    expect(s.graph.http.calls.at(-3)!.url.pathname).toMatch(/\/root\/delta$/);
  });

  it('re-paths a renamed folder’s files although delta returns only the folder', async () => {
    const s = await setupOneDrive();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    s.graph.rename(s.ids.reports, 'Board Reports');
    const next = await sync(s.adapter(), first.cursor);
    expect(next.error).toBeUndefined();
    const records = await assertCorpusInvariants(env.artifactsDir, 'data/files');
    expect(records).toHaveLength(5);
    expect(records.find((x) => x.frontmatter.title === 'Brief.docx')!.frontmatter.path).toBe(
      '/Board Reports',
    );
  });

  it('removes every file of a deleted folder (business drives report each item)', async () => {
    const s = await setupOneDrive();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    s.graph.delete(s.ids.reports);
    const next = await sync(s.adapter(), first.cursor);
    expect(next.pruned).toBe(3);
    expect(
      (await readCorpus(env.artifactsDir, 'data/files')).map((x) => x.frontmatter.title).sort(),
    ).toEqual(['build.py', 'notes.md']);
  });

  it('a delta that repeats unchanged ancestors costs no extra listing', async () => {
    const s = await setupOneDrive();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    const before = s.graph.http.calls.length;
    s.graph.setContent(s.ids.docx, new Uint8Array([1, 2, 3]));
    const next = await sync(s.adapter(), first.cursor);
    expect(next.written).toBe(1);
    const after = s.graph.http.calls.slice(before).map((c) => c.url.pathname);
    expect(after.some((p) => p.endsWith('/children'))).toBe(false);
  });

  it('starts over after a 410 resync instead of failing forever', async () => {
    const s = await setupOneDrive();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    s.graph.expireTokens();
    s.graph.delete(s.ids.csv);
    const next = await sync(s.adapter(), first.cursor);
    expect(next.error).toBeUndefined();
    // A walk that fits in one batch is a full enumeration, so the record the
    // resync could not report as deleted is pruned anyway.
    expect(next.pruned).toBe(1);
    expect(await readCorpus(env.artifactsDir, 'data/files')).toHaveLength(4);
  });

  it('requires a folder unless the whole OneDrive is chosen, and explains a missing folder', async () => {
    const none = await setupOneDrive({});
    env = none.env;
    expect((await sync(none.adapter(), undefined)).error).toMatch(
      /Enter the OneDrive folder to sync/,
    );
    await none.env.dispose();
    const missing = await setupOneDrive({ folderPath: 'Documents/Nope' });
    env = missing.env;
    expect((await sync(missing.adapter(), undefined)).error).toMatch(
      /"Documents\/Nope" was not found in your OneDrive/,
    );
    await missing.env.dispose();
    const whole = await setupOneDrive({ wholeDrive: true });
    env = whole.env;
    const r = await sync(whole.adapter(), undefined);
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(6);
  });

  it('refuses a delta link that leaves Graph and never sends the token there', async () => {
    const s = await setupOneDrive();
    env = s.env;
    const first = await sync(s.adapter(), undefined);
    s.graph.http.on('GET', `${GRAPH_V1}/drives/:drive/root/delta`, () =>
      json({
        value: [],
        '@odata.nextLink': 'https://graph.evil.example/v1.0/drives/x/root/delta?token=1',
      }),
    );
    const next = await sync(s.adapter(), first.cursor);
    expect(next.error).toMatch(/refused so the sign-in is never sent anywhere else/);
    expect(s.graph.http.calls.some((c) => c.url.hostname.includes('evil'))).toBe(false);
  });
});

describe('files-sharepoint', () => {
  it('resolves the site from a pasted library URL and syncs the named library only', async () => {
    const s = await setupSharePoint();
    env = s.env;
    const r = await sync(s.adapter(), undefined);
    expect(r.error).toBeUndefined();
    const titles = (await readCorpus(env.artifactsDir, 'data/files'))
      .map((x) => x.frontmatter.title)
      .sort();
    expect(titles).toEqual(['Brief.docx', 'backup.zip', 'build.py', 'data.csv', 'notes.md']);
    const site = s.graph.http.calls.find((c) =>
      c.url.pathname.includes('/sites/contoso.sharepoint.com:'),
    );
    expect(site!.url.pathname).toBe('/v1.0/sites/contoso.sharepoint.com:/sites/Finance');
    expect(s.graph.authLeaks).toEqual([]);
  });

  it('matches a library by the name in its URL and lists the libraries when none match', async () => {
    const byUrl = await setupSharePoint({
      siteUrl: 'https://contoso.sharepoint.com/sites/Finance',
      library: 'Legal Files',
    });
    env = byUrl.env;
    expect((await sync(byUrl.adapter(), undefined)).written).toBe(5);
    await byUrl.env.dispose();
    const wrong = await setupSharePoint({
      siteUrl: 'https://contoso.sharepoint.com/sites/Finance',
      library: 'HR',
    });
    env = wrong.env;
    expect((await sync(wrong.adapter(), undefined)).error).toMatch(
      /has no document library named "HR". Its libraries are: Documents, Legal./,
    );
  });

  it('uses the default library when none is named, and a sub-folder when one is', async () => {
    const def = await setupSharePoint({ siteUrl: 'https://contoso.sharepoint.com/sites/Finance' });
    env = def.env;
    const r = await sync(def.adapter(), undefined);
    expect(
      (await readCorpus(env.artifactsDir, 'data/files')).map((x) => x.frontmatter.title),
    ).toEqual(['budget.txt']);
    expect(r.written).toBe(1);
    await def.env.dispose();
    const sub = await setupSharePoint({
      siteUrl: 'https://contoso.sharepoint.com/sites/Finance',
      library: 'Legal',
      folderPath: '/Reports/',
    });
    env = sub.env;
    expect((await sync(sub.adapter(), undefined)).written).toBe(3);
  });

  it('explains a missing site and a tenant that has not approved the app', async () => {
    const missing = await setupSharePoint({ siteUrl: 'https://contoso.sharepoint.com/sites/Nope' });
    env = missing.env;
    expect((await sync(missing.adapter(), undefined)).error).toMatch(
      /was not found, or this account cannot open it/,
    );
    missing.graph.http.failNext(
      { url: `${GRAPH_V1}/sites/` },
      status(403, { error: { code: 'accessDenied', message: 'Access denied' } }),
    );
    expect((await sync(missing.adapter(), undefined)).error).toMatch(
      /administrator to approve.*Sites.Read.All/,
    );
  });
});

describe('Graph helpers', () => {
  it('accepts only Graph drive and site links', () => {
    expect(
      assertGraphUrl('https://graph.microsoft.com/v1.0/drives/b!x/root/delta?token=1'),
    ).toContain('/drives/b!x/');
    expect(assertGraphUrl('https://graph.microsoft.com/v1.0/me/drive/delta(token=abc)')).toContain(
      '/me/drive/',
    );
    expect(assertGraphUrl('https://graph.microsoft.com/v1.0/sites/a,b,c/drives')).toContain(
      '/sites/',
    );
    for (const bad of [
      'https://graph.microsoft.com.evil.test/v1.0/drives/x/root/delta',
      'http://graph.microsoft.com/v1.0/drives/x/root/delta',
      'https://graph.microsoft.com/v1.0/users/x/drive/root/delta',
      'https://graph.microsoft.com/beta/drives/x/root/delta',
      'https://user:pw@graph.microsoft.com/v1.0/drives/x/root/delta',
      'https://graph.microsoft.com/v1.0/me/driveX',
      'not a url',
    ]) {
      expect(() => assertGraphUrl(bad), bad).toThrow(UnsafeGraphLinkError);
    }
  });

  it('parses SharePoint site addresses and folder paths', () => {
    expect(parseSharePointSiteUrl('https://Contoso.SharePoint.com/sites/Finance/')).toEqual({
      host: 'contoso.sharepoint.com',
      path: '/sites/Finance',
    });
    expect(
      parseSharePointSiteUrl(
        'https://contoso.sharepoint.com/sites/Finance/Shared%20Documents/Forms/AllItems.aspx',
      ),
    ).toEqual({
      host: 'contoso.sharepoint.com',
      path: '/sites/Finance',
    });
    expect(parseSharePointSiteUrl('https://contoso.sharepoint.com')).toEqual({
      host: 'contoso.sharepoint.com',
      path: '',
    });
    expect(() => parseSharePointSiteUrl('https://example.com/sites/x')).toThrow(
      /not a SharePoint Online address/,
    );
    expect(() => parseSharePointSiteUrl('')).toThrow(/Enter the SharePoint site address/);
    expect(encodeDrivePath('/Q3 Reports/Drafts #1/')).toBe('Q3%20Reports/Drafts%20%231');
    expect(() => encodeDrivePath('a/../b')).toThrow(/may not contain/);
  });
});
