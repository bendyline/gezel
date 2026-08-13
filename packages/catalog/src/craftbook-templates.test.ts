/**
 * Validation guard for bundled craftbook templates.
 *
 * `scripts/build-index.ts` denormalizes each template's identity + version
 * manifests into `data/craftbook-templates/index.json`. This test runs every
 * resolved entry through the *runtime* `CraftbookSchema` — the same schema
 * task-creation validates against, including the graph-integrity superRefine
 * (entryStepId resolves, every `next`/`branches[].goto` resolves, terminal
 * steps carry no edges, ids unique). The version-manifest schema the index
 * builder uses is looser than this, so a book can land in the catalog yet
 * blow up at `invoke_craftbook` time; this catches that.
 *
 * It is also the safety net the generated gallery (Pillar 3, 100s of books)
 * will lean on: every generated craftbook must clear this same bar.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CraftbookSchema, type StepGateUnion, normalizeStepGate } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';

const indexPath = join(gildeDataDir(), 'craftbook-templates', 'index.json');

/**
 * Exact temporary debt in the immutable published package. Gilde source has
 * the three logos ready for its next release; binding this exception to both
 * package version and ids keeps any additional missing artwork fatal.
 */
const PINNED_GILDE_MISSING_LOGOS = {
  version: '0.1.23',
  ids: ['draft-social-post', 'reception-report', 'social-digest'],
} as const;

interface BundledManifest {
  logo?: string;
  id: string;
  name: string;
  entryStepId: string;
  steps: {
    id: string;
    next?: string;
    terminal?: boolean;
    advanceWhen?: { file: string; goto?: string };
    gate?: StepGateUnion;
  }[];
  releasedAt?: string;
  [k: string]: unknown;
}

async function loadManifests(): Promise<BundledManifest[]> {
  const raw = await readFile(indexPath, 'utf8');
  const parsed = JSON.parse(raw) as { entries: { manifest: BundledManifest }[] };
  return parsed.entries.map((e) => e.manifest);
}

async function expectedMissingLogoDebt(): Promise<Set<string>> {
  const packageJsonPath = join(gildeDataDir(), '..', 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string };
  return packageJson.version === PINNED_GILDE_MISSING_LOGOS.version
    ? new Set(PINNED_GILDE_MISSING_LOGOS.ids)
    : new Set();
}

describe('bundled craftbook templates', () => {
  it('every template passes the runtime CraftbookSchema (graph integrity included)', async () => {
    const manifests = await loadManifests();
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) {
      // `createdAt`/`updatedAt` are stamped by the resolver at runtime; the
      // catalog manifest omits them. Supply a deterministic stand-in so the
      // schema can validate everything else.
      const stamp = (m.releasedAt as string | undefined) ?? '2026-01-01T00:00:00Z';
      const result = CraftbookSchema.safeParse({ ...m, createdAt: stamp, updatedAt: stamp });
      if (!result.success) {
        throw new Error(`craftbook "${m.id}" failed CraftbookSchema:\n${result.error.message}`);
      }
    }
  });

  it('build-loop ships the gated build → evaluate → (loop) → finish shape', async () => {
    const manifests = await loadManifests();
    const buildLoop = manifests.find((m) => m.id === 'build-loop');
    expect(buildLoop, 'build-loop should be a bundled craftbook').toBeDefined();
    if (!buildLoop) return;

    // Build is the entry — models produce the deliverable in the first step,
    // so that's where observable-progress auto-advance has to bite.
    expect(buildLoop.entryStepId).toBe('build');
    const byId = new Map(buildLoop.steps.map((s) => [s.id, s]));
    const build = byId.get('build');
    // Build auto-advances when its deliverable lands (no model
    // `advance_task_step` needed); `next` carries it to evaluate.
    expect(build?.advanceWhen?.file).toBe('index.html');
    expect(build?.next).toBe('evaluate');
    // The deliverable bar is a COMPLETION gate on the build step itself:
    // declarative floor + the standard html-complete judgment, rejecting
    // back into a fresh build pass.
    expect(build?.gate).toBeDefined();
    const gate = build?.gate ? normalizeStepGate(build.gate) : null;
    expect(gate?.at).toBe('completion');
    expect(gate?.onReject).toBe('build');
    expect(gate?.scripts.map((r) => `${r.scope}:${r.name}`)).toEqual([
      'standard:checkHtmlComplete',
    ]);
    // Evaluate keeps the Layer-2 judgment only; its default forward edge
    // loops back to Build — safe failure mode is "keep improving".
    expect(byId.get('evaluate')?.gate).toBeUndefined();
    expect(byId.get('evaluate')?.next).toBe('build');
    expect(byId.get('finish')?.terminal).toBe(true);
    expect(byId.get('finish')?.next).toBeUndefined();
  });

  /**
   * Gallery artwork. Gilde ships a `logo.webp` per craftbook and points each
   * manifest at it; the UI resolves that through `logoUrlFor` into a
   * `/api/catalog/.../file/...` path.
   *
   * This guards the failure mode that hid the artwork for four days: the
   * imagery landed in gilde but the published npm package predated it, and
   * because a missing logo degrades silently to a category glyph, the app
   * looked identical either way. A release that drops or renames the files
   * fails here instead of quietly reverting the gallery to glyphs.
   */
  it('every template declares a logo whose file is present in the package', async () => {
    const manifests = await loadManifests();
    const expectedDebt = await expectedMissingLogoDebt();
    const missingDeclaration = manifests
      .filter((m) => !m.logo)
      .map((m) => m.id)
      .sort();
    expect(missingDeclaration, 'craftbooks with no manifest.logo').toEqual(
      [...expectedDebt].sort(),
    );

    const missingFile: string[] = [];
    for (const m of manifests) {
      if (expectedDebt.has(m.id)) continue;
      const shard = m.id.slice(0, 2).toLowerCase();
      const path = join(gildeDataDir(), 'craftbook-templates', shard, m.id, String(m.logo));
      try {
        const bytes = await readFile(path);
        // A zero-byte or near-empty file would still "exist" while rendering
        // as a broken image, which is the state this test is here to reject.
        if (bytes.byteLength < 1024) missingFile.push(`${m.id} (${bytes.byteLength} bytes)`);
      } catch {
        missingFile.push(`${m.id} (${path} unreadable)`);
      }
    }
    expect(missingFile, 'craftbooks whose logo file is absent or empty').toEqual([]);
  });

  // gstack-import.test.ts asserts this for the nine books the snapshot
  // converter generates, which is why five hand-authored books in gilde drifted
  // past it: they never go through `convertSnapshotSkill`. This checks the
  // shipped bytes instead of the generator, so it covers both origins — and any
  // future book, however it was authored.
  //
  // `basedOn` is the sanctioned home for upstream credit and is exempt.
  // Everything else is prose a gezel user reads (tags render as chips in the
  // catalog browser; the doc `description` is what the craftbook editor shows),
  // and naming a CLI they do not have only confuses them.
  it('shipped craftbooks keep upstream branding inside basedOn', async () => {
    const manifests = await loadManifests();
    const offenders: string[] = [];

    const scan = (label: string, value: unknown, path = '') => {
      if (typeof value === 'string') {
        if (/gstack|gbrain/i.test(value)) offenders.push(`${label}${path}`);
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) scan(label, entry, path);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          if (key === 'basedOn') continue;
          scan(label, entry, `${path}/${key}`);
        }
      }
    };

    for (const m of manifests) scan(`manifest ${m.id}`, m);

    // The index denormalizes manifests only; each version's full document sits
    // beside it on disk and is what actually installs into a user's craftbook.
    for (const m of manifests) {
      const shard = m.id.slice(0, 2).toLowerCase();
      const versionsDir = join(gildeDataDir(), 'craftbook-templates', shard, m.id, 'versions');
      let versions: string[];
      try {
        versions = await readdir(versionsDir);
      } catch {
        continue;
      }
      for (const version of versions) {
        const docPath = join(versionsDir, version, 'craftbook.json');
        let doc: unknown;
        try {
          doc = JSON.parse(await readFile(docPath, 'utf8'));
        } catch {
          continue;
        }
        scan(`doc ${m.id}@${version}`, doc);
      }
    }

    expect(offenders, 'craftbook fields naming upstream tooling outside basedOn').toEqual([]);
  });
});
