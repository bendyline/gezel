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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CraftbookSchema, type StepGateUnion, normalizeStepGate } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';

const indexPath = join(gildeDataDir(), 'craftbook-templates', 'index.json');

interface BundledManifest {
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
});
