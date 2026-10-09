import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { NightShiftReviewIntent } from '@bendyline/gezel';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Night in the life: the overnight promise on a real model. A person adds a
 * Pictures-like folder and a small code folder, nothing is queued, and the
 * night shift opens on a window placed around the trial. Graded on the
 * morning: a review card exists for the window, both folders were swept (the
 * photos described, the code summarized and reviewed), and neither folder
 * changed by a byte.
 *
 * The window is whole hours, so a trial waits up to two hours for it to
 * close; the watchdogs are set for that rather than for task progress.
 */

const PHOTOS: Array<{ name: string; bg: Rgb; shape: Rgb; kind: 'disc' | 'bar' }> = [
  { name: 'beach-ball.png', bg: [40, 110, 200], shape: [220, 40, 40], kind: 'disc' },
  { name: 'sunset.png', bg: [250, 170, 60], shape: [200, 60, 20], kind: 'disc' },
  { name: 'forest-path.png', bg: [30, 120, 50], shape: [120, 90, 50], kind: 'bar' },
  { name: 'snow-field.png', bg: [235, 240, 245], shape: [60, 60, 70], kind: 'bar' },
];

/** A small library with one plain bug for the Boekwachter to find. */
export const CODE_FILES: Array<{ path: string; content: string }> = [
  { path: 'package.json', content: '{ "name": "allotment-rota", "type": "module" }\n' },
  {
    path: 'README.md',
    content:
      '# Allotment rota\n\nPicks who waters the plots each day, round-robin over the members.\n',
  },
  {
    path: 'src/rota.js',
    content: [
      '/** Who waters on day `day` (0-based), cycling through `members`. */',
      'export function waterer(members, day) {',
      '  if (members.length === 0) return null;',
      '  // Bug: skips the first member and runs past the end of the list.',
      '  return members[(day % members.length) + 1];',
      '}',
      '',
    ].join('\n'),
  },
  {
    path: 'src/plots.js',
    content: [
      '/** Plots needing water: dry for more than `days` days. */',
      'export function thirsty(plots, days) {',
      '  return plots.filter((p) => p.daysSinceWatered > days);',
      '}',
      '',
    ].join('\n'),
  },
];

type Rgb = [number, number, number];

/** A 64x48 picture of a disc or a bar on a plain ground, as a real PNG a vision model can read. */
export function encodeScenePng(bg: Rgb, shape: Rgb, kind: 'disc' | 'bar'): Buffer {
  const width = 64;
  const height = 48;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const inShape =
        kind === 'disc' ? (x - 32) ** 2 + (y - 24) ** 2 < 14 ** 2 : y > 30 && y < 40 && x > 8;
      const [r, g, b] = inShape ? shape : bg;
      const at = y * (1 + width * 3) + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * A whole-hour night window that is open now and closes one to two hours
 * from now: long enough for a small folder's sweep on a local model.
 */
export function trialNightWindow(now: Date): { startHour: number; endHour: number } {
  const startHour = now.getHours();
  const span = now.getMinutes() < 30 ? 1 : 2;
  return { startHour, endHour: (startHour + span) % 24 };
}

/** Every entry under `dir` with size, mtime and content hash. */
export async function folderSnapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    out[`${relative(dir, d)}/`] = `dir ${(await lstat(d)).mtimeMs}`;
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const st = await lstat(abs);
      const hash = createHash('sha256')
        .update(await readFile(abs))
        .digest('hex');
      out[relative(dir, abs)] = `${st.size} ${st.mtimeMs} ${hash}`;
    }
  };
  await walk(dir);
  return out;
}

export interface MorningEvidence {
  card: { prompt: string; intent: NightShiftReviewIntent } | null;
  photos: { eligible: number; shadowsPending: number; skipped: number };
  code: { summarized: number; reviewed: number };
  /** Paths whose size, date or content changed, plus any added or removed. */
  changed: string[];
}

/** Pure grade of the morning, so the rules are tested without a model. */
export function gradeMorning(e: MorningEvidence): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!e.card) reasons.push('no morning card for the window');
  if (e.changed.length > 0) reasons.push(`folder changed: ${e.changed.slice(0, 5).join(', ')}`);
  const described = e.photos.eligible - e.photos.shadowsPending - e.photos.skipped;
  if (described < 1) reasons.push('no photo was described');
  if (e.code.summarized < 1) reasons.push('no code file was summarized');
  if (e.code.reviewed < 1) reasons.push('no code file was reviewed');
  return { ok: reasons.length === 0, reasons };
}

export function changedPaths(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

interface NightState {
  pictures: string;
  code: string;
  picturesId: string;
  codeId: string;
  before: { pictures: Record<string, string>; code: Record<string, string> };
}

const STATE_KEY = 'night-in-the-life';

export const nightInTheLifeScenario: EvalScenario = {
  id: 'night-in-the-life',
  description:
    'Folders added with crew; the night shift sweeps them with nothing queued and leaves a morning card, folders untouched',
  // The setup adds the folders and the night does the rest; nothing is said.
  prompt: 'Look after my pictures and my allotment code overnight.',
  skipInitialPrompt: true,
  nightShift: true,
  requiresEmbeddings: true,
  timeoutMs: 3 * 60 * 60_000,
  progressTimeoutMs: 2.5 * 60 * 60_000,
  async setup(ctx: EvalContext) {
    const root = await mkdtemp(join(tmpdir(), 'gezel-eval-night-'));
    const pictures = join(root, 'Holiday Pictures');
    const code = join(root, 'allotment-rota');
    await mkdir(pictures, { recursive: true });
    for (const p of PHOTOS)
      await writeFile(join(pictures, p.name), encodeScenePng(p.bg, p.shape, p.kind));
    for (const f of CODE_FILES) {
      await mkdir(join(code, f.path, '..'), { recursive: true });
      await writeFile(join(code, f.path), f.content);
    }
    const before = { pictures: await folderSnapshot(pictures), code: await folderSnapshot(code) };
    const add = async (path: string) =>
      (
        await ctx.client.inferProjectForPath({
          path,
          kind: 'folder',
          source: 'eval',
          recruitCrew: true,
        })
      ).project!.id;
    const state: NightState = {
      pictures,
      code,
      picturesId: await add(pictures),
      codeId: await add(code),
      before,
    };
    ctx.state?.set(STATE_KEY, state);
    ctx.log(`[scenario] night-in-the-life folders added: ${state.picturesId}, ${state.codeId}`);
  },
  async successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
    const state = ctx.state?.get(STATE_KEY) as NightState | undefined;
    if (!state) return { done: false };
    const { questions } = await ctx.client.listQuestions({ projectId: 'default' });
    const question = questions.find((q) => q.intent?.kind === 'night-shift-review');
    if (!question) {
      ctx.logChanged(STATE_KEY, '[scenario] night-in-the-life waiting for the morning card');
      return { done: false };
    }
    const [photos, code, issues] = await Promise.all([
      ctx.client.getProjectIndexStatus(state.picturesId),
      ctx.client.getProjectIndexStatus(state.codeId),
      ctx.client.toolListFileIssues(state.codeId).catch(() => null),
    ]);
    const evidence: MorningEvidence = {
      card: { prompt: question.prompt, intent: question.intent as NightShiftReviewIntent },
      photos: {
        eligible: photos.enrichment?.eligible ?? 0,
        shadowsPending: photos.enrichment?.shadowsPending ?? 0,
        skipped: photos.enrichment?.skipped ?? 0,
      },
      code: {
        summarized: code.enrichment?.summarized ?? 0,
        reviewed: issues?.reviewedFiles ?? 0,
      },
      changed: [
        ...changedPaths(state.before.pictures, await folderSnapshot(state.pictures)),
        ...changedPaths(state.before.code, await folderSnapshot(state.code)),
      ],
    };
    const grade = gradeMorning(evidence);
    // Advisory: whether the review caught the planted off-by-one.
    const bugFound = issues?.issues.some((i) => i.path === 'src/rota.js') ?? false;
    const diagnostics = { evidence, card: question.prompt, bugFound };
    return grade.ok
      ? { done: true, success: true, reason: question.prompt, diagnostics }
      : { done: true, success: false, reason: grade.reasons.join('; '), diagnostics };
  },
};
