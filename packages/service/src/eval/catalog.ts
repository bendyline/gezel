import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { type EvalCatalog, EvalCatalogSchema } from '@bendyline/gezel/eval';
import { killProcessTree } from '../utils/kill-process-tree.js';
import { type EvalHarness, harnessBaseEnv, spawnHarness } from './harness.js';

const log = createLogger('eval-catalog');

/** Loading every craftbook spec takes seconds; a hung load must still end. */
const CATALOG_TIMEOUT_MS = 3 * 60_000;

/**
 * The harness's scenario/suite registry, asked of the harness itself.
 *
 * This replaced a hand-maintained copy of five scenarios that had drifted
 * from the harness it described (its ceilings and image model no longer
 * matched), while the harness had grown to hundreds. One source of truth:
 * the daemon never describes a scenario the harness would not run the same
 * way.
 *
 * Cached for the process lifetime once it loads. `refresh` reloads, which is
 * what picks up a gilde content update's new craftbook scenarios.
 */
export class EvalCatalogCache {
  private pending: Promise<EvalCatalog> | null = null;

  constructor(
    private readonly harness: () => EvalHarness | null,
    private readonly env: () => NodeJS.ProcessEnv = () => harnessBaseEnv(),
  ) {}

  get(opts: { refresh?: boolean } = {}): Promise<EvalCatalog> {
    if (opts.refresh || !this.pending) {
      const loading = this.load();
      this.pending = loading;
      loading.catch(() => {
        if (this.pending === loading) this.pending = null;
      });
    }
    return this.pending;
  }

  private async load(): Promise<EvalCatalog> {
    const harness = this.harness();
    if (!harness) throw new Error('this install has no eval harness to list scenarios from');
    const dir = await mkdtemp(join(tmpdir(), 'gezel-eval-catalog-'));
    const out = join(dir, 'catalog.json');
    const stderr: string[] = [];
    try {
      const proc = spawnHarness(harness.launch('catalog', ['--out', out]), {
        env: this.env(),
        onLine: (line, stream) => {
          if (stream === 'stderr') stderr.push(line);
        },
      });
      const timer = setTimeout(() => killProcessTree(proc.child), CATALOG_TIMEOUT_MS);
      const exit = await proc.exited.finally(() => clearTimeout(timer));
      if (exit.code !== 0) {
        const detail = exit.error ?? stderr.slice(-5).join('\n');
        throw new Error(
          `the eval harness could not list its scenarios (exit ${exit.code ?? exit.signal}): ${detail}`,
        );
      }
      const catalog = EvalCatalogSchema.parse(JSON.parse(await readFile(out, 'utf8')));
      log.info(
        `[eval-catalog] ${catalog.scenarios.length} scenarios, ${catalog.suites.length} suites (${harness.mode} harness)`,
      );
      return catalog;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
