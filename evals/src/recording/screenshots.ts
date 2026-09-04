import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Per-trial screenshot pass for the run recording: render the HTML the
 * run produced (from the already-captured `workspace/` + `artifacts/`
 * snapshots in the run dir) into `recording/screenshots/*.png` plus an
 * `index.json` whose entries the distiller joins against
 * `workspace.write` history events (`sourcePath` is store-relative for
 * exactly that reason).
 *
 * Post-hoc on purpose — the artifacts are static HTML, and rendering
 * during the run would add Chromium contention to a timed trial for
 * zero fidelity gain. Best-effort: no Chromium, no screenshots, no
 * failed trial. Time-bounded so a pathological artifact tree cannot
 * stall finalize.
 */

export interface RecordingScreenshotEntry {
  sourceStore: 'workspace' | 'artifact';
  /** Store-relative path (matches `workspace.write` history `details.path`). */
  sourcePath: string;
  png: string;
  width: number;
  height: number;
  bytes: number;
  pageErrors: string[];
}

const MAX_FILES = 16;
const TIME_BUDGET_MS = 60_000;
const VIEWPORT = { width: 900, height: 720 };
const SETTLE_MS = 1200;

export async function captureRecordingScreenshots(args: {
  runDir: string;
  log: (line: string) => void;
}): Promise<'ok' | 'absent' | `failed: ${string}`> {
  const { runDir, log } = args;
  const sources: Array<{ store: 'workspace' | 'artifact'; root: string }> = [
    { store: 'workspace', root: join(runDir, 'workspace') },
    { store: 'artifact', root: join(runDir, 'artifacts') },
  ];
  const htmls: Array<{ store: 'workspace' | 'artifact'; abs: string; rel: string }> = [];
  for (const source of sources) {
    if (!existsSync(source.root)) continue;
    // Snapshots are laid out <root>/<projectId>/<store-relative path> — the
    // first segment is stripped so sourcePath matches history event paths.
    for (const abs of await findHtml(source.root)) {
      const withProject = relative(source.root, abs).replace(/\\/g, '/');
      const rel = withProject.split('/').slice(1).join('/');
      if (rel.length === 0) continue;
      htmls.push({ store: source.store, abs, rel });
    }
  }
  if (htmls.length === 0) return 'absent';
  const picked = htmls.slice(0, MAX_FILES);
  if (htmls.length > picked.length) {
    log(`[recording] screenshots capped at ${MAX_FILES} of ${htmls.length} HTML file(s)`);
  }

  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return `failed: playwright unavailable (${err instanceof Error ? err.message : String(err)})`;
  }

  const outDir = join(runDir, 'recording', 'screenshots');
  await mkdir(outDir, { recursive: true });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const entries: RecordingScreenshotEntry[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    for (const [index, html] of picked.entries()) {
      if (Date.now() > deadline) {
        log('[recording] screenshot time budget exhausted; remaining files skipped');
        break;
      }
      const png = `${String(index).padStart(2, '0')}-${slug(html.rel)}.png`;
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      try {
        await page.goto(pathToFileURL(html.abs).toString(), {
          waitUntil: 'load',
          timeout: 15_000,
        });
        await page.waitForTimeout(SETTLE_MS);
        await page.screenshot({ path: join(outDir, png), fullPage: false });
        const source = await readFile(html.abs, 'utf8').catch(() => '');
        entries.push({
          sourceStore: html.store,
          sourcePath: html.rel,
          png,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          bytes: source.length,
          pageErrors,
        });
      } catch (err) {
        log(
          `[recording] screenshot of ${html.rel} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        await page.close().catch(() => {});
      }
    }
    await context.close();
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await browser?.close().catch(() => {});
  }
  if (entries.length === 0) return 'failed: no screenshot rendered';
  await writeFile(join(outDir, 'index.json'), JSON.stringify(entries, null, 2));
  log(`[recording] captured ${entries.length} screenshot(s)`);
  return 'ok';
}

async function findHtml(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        out.push(path);
      }
    }
  };
  await walk(root);
  return out.sort();
}

function slug(rel: string): string {
  return rel
    .toLowerCase()
    .replace(/\.html$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
