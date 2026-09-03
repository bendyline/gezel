#!/usr/bin/env -S npx tsx
/**
 * `pnpm --filter @bendyline/gezel-evals run movie-pages <run-dir…> [--squisq-dir <checkout>]`
 *
 * Render playable movie pages for finished trials from their recordings:
 *
 *   <runDir>/recording/movie.html         marketing cut (social captions, top)
 *   <runDir>/recording/movie-debug.html   complete chaptered timeline
 *   <runDir>/recording/squisq-player.js   the standalone player, beside them
 *   <runDir>/recording/media/poppetje/…   each actor's figure as SVG
 *
 * Self-contained: the pages play from `file://` with no server, and every
 * media ref is relative to the recording dir — the same contract the
 * gilde site's demo page will inherit.
 *
 * The mapper lives in the UI package (`packages/ui/src/movies/`) and is
 * React-free; the poppetje renderer is the one React piece, reached here
 * through a sibling module so the figures ship as real SVGs rather than
 * initials medallions. Both are loaded by source path — the UI package
 * exports no library entry — so this bin resolves them by file URL.
 *
 * Run it through the package script (`tsx --tsconfig
 * ../packages/ui/tsconfig.json …`): tsx scopes a tsconfig to that
 * config's `include` set, so the UI's `.tsx` only gets the automatic JSX
 * runtime when tsx is pointed at the UI's own tsconfig. Under evals'
 * config it compiles to `React.createElement` against modules that never
 * import React and dies with "React is not defined".
 *
 * `--squisq-dir` (or `GEZEL_SQUISQ_DIR`) points at a squisq checkout
 * whose packages are BUILT, to use its player/formats instead of the
 * pinned registry packages. Needed for `video` mode and `captionPosition`
 * until the squisq release carrying them is published and pinned; with
 * the pinned packages the pages fall back to slideshow mode.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const uiSrc = join(repoRoot, 'packages/ui/src');
const uiDeps = join(repoRoot, 'packages/ui/node_modules/@bendyline');

interface MoviesModule {
  loadRecording(raw: unknown): { recording: Recording; warnings: string[] };
  recordingToDoc(
    recording: Recording,
    profile: 'debug' | 'marketing',
    opts?: { availableMedia?: ReadonlySet<string> },
  ): { doc: unknown; media: Array<{ path: string; kind: string }> };
  coverTitle(recording: Recording): string;
}
interface Recording {
  actors: Array<{ id: string; name: string; kind: string; poppetje?: unknown }>;
  scenes: unknown[];
}
interface PoppetjeMediaModule {
  renderPoppetjeSvg(
    gezelId: string,
    name: string,
    poppetje: unknown,
    variant?: 'headshot' | 'full' | 'icon',
  ): { path: string; svg: string };
}
interface FormatsModule {
  generateExternalHtml(doc: unknown, options: Record<string, unknown>): string;
}
interface StandaloneModule {
  PLAYER_BUNDLE: string;
}

function parseArgs(argv: string[]): { runDirs: string[]; squisqDir: string | undefined } {
  const runDirs: string[] = [];
  let squisqDir = process.env.GEZEL_SQUISQ_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--squisq-dir') {
      squisqDir = argv[++i];
      if (!squisqDir) throw new Error('--squisq-dir requires a path');
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: movie-pages <run-dir…> [--squisq-dir <squisq checkout>]');
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown arg: ${arg}`);
    } else {
      runDirs.push(resolve(arg));
    }
  }
  return { runDirs, squisqDir };
}

async function importByPath<T>(path: string): Promise<T> {
  return (await import(pathToFileURL(path).toString())) as T;
}

async function main(): Promise<void> {
  const { runDirs, squisqDir } = parseArgs(process.argv.slice(2));
  if (runDirs.length === 0) {
    console.error('Usage: movie-pages <run-dir…> [--squisq-dir <squisq checkout>]');
    process.exit(2);
  }
  const squisqPackages = squisqDir ? join(resolve(squisqDir), 'packages') : undefined;
  const formatsEntry = squisqPackages
    ? join(squisqPackages, 'formats/dist/html/index.js')
    : join(uiDeps, 'squisq-formats/dist/html/index.js');
  const playerEntry = squisqPackages
    ? join(squisqPackages, 'react/dist/standalone-source.js')
    : join(uiDeps, 'squisq-react/dist/standalone-source.js');
  for (const entry of [formatsEntry, playerEntry]) {
    if (!existsSync(entry)) {
      console.error(`[movie-pages] missing ${entry} — build squisq (or drop --squisq-dir)`);
      process.exit(2);
    }
  }

  const movies = await importByPath<MoviesModule>(join(uiSrc, 'movies/index.ts'));
  const poppetjeMedia = await importByPath<PoppetjeMediaModule>(
    join(uiSrc, 'movies/poppetje-media.ts'),
  );
  const formats = await importByPath<FormatsModule>(formatsEntry);
  const standalone = await importByPath<StandaloneModule>(playerEntry);
  console.log(
    `[movie-pages] player: ${squisqPackages ? `squisq checkout (${squisqPackages})` : 'pinned registry packages'}`,
  );

  for (const runDir of runDirs) {
    const recDir = join(runDir, 'recording');
    const transcriptPath = join(recDir, 'transcript.json');
    if (!existsSync(transcriptPath)) {
      console.error(`[movie-pages] ${runDir}: no recording/transcript.json (distill first)`);
      continue;
    }
    const { recording, warnings } = movies.loadRecording(
      JSON.parse(await readFile(transcriptPath, 'utf8')),
    );
    for (const warning of warnings) console.warn(`[movie-pages] ${warning}`);

    // Real figures for everyone who has one; the mapper falls back to an
    // initials medallion for anyone who doesn't.
    const available = new Set<string>();
    await mkdir(join(recDir, 'media/poppetje'), { recursive: true });
    for (const actor of recording.actors) {
      if (actor.kind !== 'gezel' || !actor.poppetje) continue;
      const rendered = poppetjeMedia.renderPoppetjeSvg(actor.id, actor.name, actor.poppetje);
      await writeFile(join(recDir, rendered.path), rendered.svg, 'utf8');
      available.add(rendered.path);
    }

    await writeFile(join(recDir, 'squisq-player.js'), standalone.PLAYER_BUNDLE, 'utf8');
    const title = movies.coverTitle(recording);
    // Standard captions for both cuts: the social word-by-word style is
    // too quick and harsh over scenes a viewer is already reading.
    for (const [profile, file, captionStyle] of [
      ['marketing', 'movie.html', 'standard'],
      ['debug', 'movie-debug.html', 'standard'],
    ] as const) {
      const { doc } = movies.recordingToDoc(recording, profile, { availableMedia: available });
      const html = formats.generateExternalHtml(doc, {
        playerScriptPath: 'squisq-player.js',
        mode: 'video',
        basePath: '.',
        title: `${title} (${profile})`,
        autoPlay: true,
        captionStyle,
        // Chat bubbles and summaries live in the lower half of the frame.
        captionPosition: 'top',
      });
      await writeFile(join(recDir, file), html, 'utf8');
      const blocks = (doc as { blocks: unknown[]; duration: number }).blocks.length;
      const seconds = Math.round((doc as { duration: number }).duration);
      console.log(`[movie-pages] wrote ${join(recDir, file)} (${blocks} blocks, ~${seconds}s)`);
    }
    console.log(`[movie-pages]   poppetjes rendered: ${available.size}`);
  }
}

main().catch((err) => {
  console.error('[movie-pages] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
