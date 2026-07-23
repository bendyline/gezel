/**
 * `pnpm --filter @bendyline/gezel-evals run screenshot <trial-or-matrix-dir>`
 *
 * Renders every `index.html` (or `tic-tac-toe.html` etc.) found under a
 * trial/batch/matrix output directory in headless Chromium, screenshots
 * it, and captures page-load JS errors. Output lands at
 * `<inputDir>/screenshots/<sceneId>__<trialId>.png` + a sibling
 * `screenshots/index.json` summary with the JS-error capture and file
 * paths.
 *
 * Built to be invoked AFTER a matrix run so the user (or Claude with
 * vision) can look at what each trial actually produced — a 1.4 KB
 * "passes the sniff" HTML can still be visually a blank page; the
 * screenshot is the ground truth.
 *
 * Usage:
 *   pnpm screenshot evals/runs/matrix-2026-05-12T00-13-44-917Z
 *   pnpm screenshot evals/runs/tictactoe-2026-05-11T...-abcd
 *
 * Optional flags:
 *   --viewport <WxH>     viewport size (default 900x720)
 *   --wait-ms <N>        pause N ms before screenshotting (default 1500)
 *                        so the page has a chance to render + run
 *                        first-tick game code.
 *   --headless / --no-headless   default true; use --no-headless to
 *                        watch the renders live (debugging).
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { extractInlineScripts, validateScriptSyntax } from '../html-validation.ts';

interface ScreenshotEntry {
  scenarioId: string;
  trialId: string;
  htmlPath: string;
  pngPath: string;
  bytes: number;
  jsTotalBytes: number;
  jsParses: boolean;
  jsFirstError?: string;
  pageErrors: string[];
}

async function findHtmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'screenshots') continue;
        await walk(p);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.html')) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

function deriveIds(root: string, htmlPath: string): { scenarioId: string; trialId: string } {
  // `htmlPath` is somewhere under `<root>/<scenario>/<trial>/.../foo.html`
  // (matrix layout) OR `<root>/.../foo.html` (single-batch / single-trial
  // layout). Walk the relative path and pick the most-specific labels.
  const rel = relative(root, htmlPath).split(/[\\/]+/);
  // Standard layouts:
  //   matrix:  scenario/trialId/workspace|artifacts/<projectId>/.../foo.html
  //   batch:   trialId/workspace|artifacts/<projectId>/.../foo.html
  //   trial:   workspace|artifacts/<projectId>/.../foo.html
  let scenarioId = 'unknown';
  let trialId = 'unknown';
  if (rel.length >= 3 && /^(tictactoe|petshop|tankcombat)$/.test(rel[0] ?? '')) {
    scenarioId = rel[0]!;
    trialId = rel[1] ?? 'unknown';
  } else if (rel.length >= 2 && /^(tictactoe|petshop|tankcombat)-/.test(rel[0] ?? '')) {
    trialId = rel[0]!;
    scenarioId = trialId.split('-')[0]!;
  } else {
    trialId = rel.slice(0, Math.min(2, rel.length)).join('-') || 'unknown';
  }
  return { scenarioId, trialId };
}

interface Args {
  inputDir: string;
  viewport: { width: number; height: number };
  waitMs: number;
  headless: boolean;
}

function parseArgs(argv: string[]): Args {
  let inputDir: string | undefined;
  let viewport = { width: 900, height: 720 };
  let waitMs = 1500;
  let headless = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--viewport') {
      const v = argv[++i];
      if (!v) throw new Error('--viewport requires WxH');
      const m = v.match(/^(\d+)x(\d+)$/);
      if (!m) throw new Error('--viewport must be WxH (e.g. 1280x720)');
      viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (a === '--wait-ms') {
      waitMs = Number(argv[++i]);
      if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--wait-ms must be ≥ 0');
    } else if (a === '--headless') {
      headless = true;
    } else if (a === '--no-headless') {
      headless = false;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: pnpm screenshot <trial-or-matrix-dir> [--viewport WxH] [--wait-ms N] [--no-headless]',
      );
      process.exit(0);
    } else if (!a.startsWith('--')) {
      inputDir = isAbsolute(a) ? a : resolve(process.cwd(), a);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!inputDir) {
    console.error('Usage: pnpm screenshot <trial-or-matrix-dir> [--viewport WxH] [--wait-ms N]');
    process.exit(2);
  }
  return { inputDir, viewport, waitMs, headless };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.inputDir)) {
    console.error(`[screenshot] no such directory: ${args.inputDir}`);
    process.exit(2);
  }
  const st = await stat(args.inputDir);
  if (!st.isDirectory()) {
    console.error(`[screenshot] not a directory: ${args.inputDir}`);
    process.exit(2);
  }
  console.log(`[screenshot] scanning ${args.inputDir} for HTML files…`);
  const htmls = await findHtmlFiles(args.inputDir);
  if (htmls.length === 0) {
    console.log('[screenshot] no HTML files found.');
    return;
  }
  console.log(`[screenshot] found ${htmls.length} HTML files`);
  const outDir = join(args.inputDir, 'screenshots');
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: args.headless });
  const context = await browser.newContext({ viewport: args.viewport });
  const entries: ScreenshotEntry[] = [];
  try {
    for (const htmlPath of htmls) {
      const { scenarioId, trialId } = deriveIds(args.inputDir, htmlPath);
      const base = `${scenarioId}__${trialId}`;
      const pngPath = join(outDir, `${base}.png`);
      const fs = await import('node:fs/promises');
      const html = await fs.readFile(htmlPath, 'utf8');
      const scripts = extractInlineScripts(html);
      const v = validateScriptSyntax(scripts);

      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
      });
      try {
        const url = pathToFileURL(htmlPath).toString();
        await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
        await page.waitForTimeout(args.waitMs);
        await page.screenshot({ path: pngPath, fullPage: false });
      } catch (err) {
        pageErrors.push(`render error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await page.close();
      }

      entries.push({
        scenarioId,
        trialId,
        htmlPath: relative(args.inputDir, htmlPath),
        pngPath: relative(args.inputDir, pngPath),
        bytes: html.length,
        jsTotalBytes: v.totalBytes,
        jsParses: v.allParse,
        ...(v.firstError !== undefined ? { jsFirstError: v.firstError } : {}),
        pageErrors,
      });
      const status = v.allParse && pageErrors.length === 0 ? 'OK' : 'FAIL';
      console.log(
        `  [${status}] ${scenarioId}/${trialId}: html=${html.length}B js=${v.totalBytes}B parses=${v.allParse} pageErrors=${pageErrors.length}`,
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }

  await writeFile(join(outDir, 'index.json'), JSON.stringify({ entries }, null, 2));
  console.log(`\n[screenshot] wrote ${entries.length} screenshots + index.json to ${outDir}`);
  const failures = entries.filter((e) => !e.jsParses || e.pageErrors.length > 0);
  if (failures.length > 0) {
    console.log(`[screenshot] ${failures.length} of ${entries.length} have JS issues:`);
    for (const f of failures) {
      const reason = !f.jsParses
        ? `JS parse: ${f.jsFirstError?.slice(0, 80) ?? '?'}`
        : `${f.pageErrors.length} page error(s): ${f.pageErrors[0]?.slice(0, 80) ?? ''}`;
      console.log(`  - ${f.scenarioId}/${f.trialId}: ${reason}`);
    }
  }
}

main().catch((err) => {
  console.error('[screenshot] fatal:', err);
  process.exit(2);
});

// silence unused-import lint when bundlers strip the helper
void fileURLToPath;
