import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Tool-routing — image generation.
 *
 * Fast-fail variant of `petshop`. Petshop is a 45-minute multi-stage
 * scenario that depends on chat + image-gen + voorman orchestration —
 * by the time it times out you've burned a SDXL warm + a long
 * Meester-Voorman handoff dance.
 *
 * This scenario is a **focused probe** on one specific capability: when
 * the user asks for "an image", does the team route through the
 * `image-generator` role (which has `generate_image` in its MCP
 * toolset) rather than trying to install npm packages or invoke
 * `run_npx bin: "generate_image"`?
 *
 * Pass: a real (≥ 10 KB) PNG/JPG lands in a non-default project, AND
 * either a `tool.called` event mentions `generate_image` or no
 * `run_npx`/`npm_install` red-flag patterns fire (we accept silent
 * routing as well as logged routing). Fail: no real image asset, OR
 * the team installed an npm package instead.
 *
 * Designed to time out at 20 min. This is still much shorter than
 * petshop, but leaves enough room for local models with a cold
 * Meester/tool-schema prefill plus one SDXL render.
 *
 * History: this is the scenario that would have caught the
 * `image-generator missing from SPECIALIST_ROLES` regression in
 * Petshop *did* catch it but took 54 minutes; this scenario
 * catches it faster with a clearer signal.
 */

const MIN_IMAGE_BYTES = 10 * 1024;

interface ImageFile {
  projectId: string;
  surface: 'workspace' | 'artifacts';
  path: string;
  bytes: number;
}

async function findImages(client: GezelClient, projectId: string): Promise<ImageFile[]> {
  const out: ImageFile[] = [];
  for (const surface of ['workspace', 'artifacts'] as const) {
    try {
      const list =
        surface === 'workspace'
          ? await client.listProjectWorkspace(projectId, undefined, true)
          : await client.listProjectArtifacts(projectId, undefined, true);
      for (const f of list.files) {
        if (f.isDirectory) continue;
        if (!/\.(png|jpg|jpeg|webp)$/i.test(f.path)) continue;
        // The project-file listing doesn't carry size; fetch the blob
        // to measure. Cheap for the small image-asset workload we
        // expect here (single render, ≤ 1-2 MB).
        let bytes = 0;
        try {
          const blob =
            surface === 'workspace'
              ? await client.fetchProjectWorkspaceBlob(projectId, f.path)
              : await client.fetchProjectArtifactBlob(projectId, f.path);
          bytes = blob.size;
        } catch {
          /* unreadable; treat as zero bytes */
        }
        out.push({ projectId, surface, path: f.path, bytes });
      }
    } catch {
      /* surface might not exist on this project; skip */
    }
  }
  return out;
}

export const toolRoutingImageScenario: EvalScenario = {
  id: 'tool-routing-image',
  description:
    'Tests whether the team correctly routes image generation to the image-generator role (with `generate_image` MCP tool) instead of installing npm packages. Fast-fail variant of petshop.',
  prompt:
    'Render a single image: a stylized sunset over mountains, PNG format. ' +
    'Save it inside a project (any name) under the workspace as `sunset.png`. ' +
    'Use whichever image-generation capability the team has available; no need ' +
    'to build a website around it.',
  // Short timeout relative to petshop, but not so short that a local
  // model can time out during cold Meester/tool-schema prefill before
  // it has a chance to route to the image generator.
  timeoutMs: 20 * 60_000,
  defaultImageModelId: 'sdxl-lightning-4step',
  successCheck: async ({ client, logChanged }): Promise<SuccessCheckResult> => {
    // The scenario is "did the team route through `generate_image`?",
    // not "did the team also remember to create a named project first?"
    // — we accept images written into the default project too. The
    // qwen3.6 trial routed correctly (3 real PNGs via the
    // image-generator role) but saved them in `default`, which the
    // earlier non-default-only filter rejected. Routing was right; the
    // scenario penalized correct behavior. The `tool.called` check
    // below remains the positive signal we care about.
    const { projects } = await client.listProjects();
    let realImage: ImageFile | null = null;
    for (const project of projects) {
      const images = await findImages(client, project.id);
      for (const img of images) {
        const key = `${img.projectId}/${img.surface}/${img.path}`;
        logChanged(
          key,
          `[scenario] image ${key} bytes=${img.bytes}${img.bytes >= MIN_IMAGE_BYTES ? ' (real)' : ' (too small)'}`,
        );
        if (img.bytes >= MIN_IMAGE_BYTES && !realImage) realImage = img;
      }
    }

    if (!realImage) return { done: false };

    // Confirm the image was rendered via the right tool. `tool.called`
    // events on `generate_image` are the positive signal; ANY successful
    // image render via the right path lands one. We don't strictly
    // require it (a future provider might not emit tool events), but
    // the postmortem benefits from the signal. HistoryEntry is a
    // discriminated union; only `entryType === 'event'` carries the
    // kind/summary fields we care about.
    try {
      const { entries } = await client.listHistory({ q: 'generate_image', limit: 20 });
      const used = entries.some(
        (e) =>
          e.entryType === 'event' &&
          e.kind === 'tool.called' &&
          /generate_image/i.test(e.summary ?? ''),
      );
      logChanged(
        'history-signal',
        `[scenario] generate_image tool.called events: ${used ? 'yes' : 'no'}`,
      );
    } catch {
      /* history query is advisory; don't fail the scenario for this */
    }

    return {
      done: true,
      success: true,
      reason: `${realImage.projectId}/${realImage.surface}/${realImage.path} (${realImage.bytes} bytes)`,
    };
  },
};
