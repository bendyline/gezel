import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type StartupHomeSnapshot,
  StartupHomeSnapshotSchema,
  type StartupHomeView,
  StartupHomeViewSchema,
} from '@bendyline/gezel';

async function readSmallJson(path: string): Promise<unknown> {
  if ((await stat(path)).size > 256_000) throw new Error('Startup cache is too large');
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Desktop view state survives navigation; product data remains service-owned. */
export class StartupHomeHost {
  active = true;
  snapshot: StartupHomeSnapshot | null = null;
  state: StartupHomeView = StartupHomeViewSchema.parse({});
  private stateFile = '';
  private writes: Promise<void> = Promise.resolve();

  async load(home: string): Promise<void> {
    // Like supervisor discovery, this runs before Store or an HTTP API exists.
    // Never show a local home's personal data when connecting to a remote.
    const config = (await readSmallJson(join(home, 'config.json')).catch(() => null)) as {
      service?: { url?: string };
      hosting?: string;
    } | null;
    const remote = typeof config?.service?.url === 'string' ? config.service.url : undefined;
    const scope = createHash('sha256')
      .update(remote || 'local')
      .digest('hex')
      .slice(0, 20);
    this.stateFile = join(home, 'desktop', `startup-${scope}.json`);
    const [snapshot, state] = await Promise.all([
      config && !config.service && config.hosting !== 'machine-service'
        ? readSmallJson(join(home, 'startup-home.json')).catch(() => null)
        : Promise.resolve(null),
      readSmallJson(this.stateFile).catch(() => null),
    ]);
    const parsed = StartupHomeSnapshotSchema.safeParse(snapshot);
    this.snapshot = parsed.success ? parsed.data : null;
    const view = StartupHomeViewSchema.safeParse(state);
    if (view.success) this.state = { ...view.data, focused: false };
  }

  save(raw: unknown): boolean {
    const parsed = StartupHomeViewSchema.safeParse(raw);
    if (!parsed.success || !this.active) return false;
    this.state = parsed.data;
    const content = JSON.stringify(this.state);
    const path = this.stateFile;
    if (path)
      this.writes = this.writes
        .catch(() => {})
        .then(async () => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(`${path}.tmp`, content, { mode: 0o600 });
          await rename(`${path}.tmp`, path);
        });
    // Failed cache writes must not turn into unhandled rejections at shutdown.
    void this.writes.catch(() => {});
    return true;
  }

  finish(draft: string): boolean {
    if (draft !== this.state.draft) return false;
    this.save({ ...this.state, draft: '', focused: false });
    this.active = false;
    return true;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
