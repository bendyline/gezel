import type { RunRecording, RunRecordingActor, RunRecordingScene } from '@bendyline/gezel';
import type { Block, CaptionPhrase, Doc } from '@bendyline/squisq/schemas';
import {
  type MovieMediaRef,
  collectScreenshotRefs,
  hasPoppetjeMedia,
  poppetjeMediaPath,
} from '../media.js';
import { coverSubtitle, coverTitle, narrationLine } from './narration.js';
import { RENDITION_KNOBS, type RenditionProfile } from './profiles.js';
import { coverBlock, outroBlock, sceneToBlock } from './scenes.js';
import { buildTimeline, selectMarketingScenes } from './timing.js';

export interface RecordingToDocOptions {
  /**
   * Recording-dir-relative media files the consumer can actually serve
   * (pre-rendered poppetje SVGs, screenshots). Actors without a served
   * poppetje render as initials avatars; screenshots are always assumed
   * present (they ship inside the recording dir by contract).
   */
  availableMedia?: ReadonlySet<string>;
  articleId?: string;
  themeId?: string;
}

export interface RecordingDocResult {
  doc: Doc;
  media: MovieMediaRef[];
}

const COVER_SECONDS = { debug: 3.5, marketing: 4 } as const;
const OUTRO_SECONDS = { debug: 4, marketing: 3.5 } as const;

/**
 * Map a distilled RunRecording into a playable squisq Doc.
 *
 * Block timings are set DIRECTLY as data (`Block.startTime`/`duration` —
 * squisq's advanceTiming machinery records human slide advances and is
 * the wrong tool when the source of truth is already timestamps). The
 * doc plays with `audioMode: 'synthetic'` (no audio segments) and a
 * caption track carrying one narration line per scene.
 */
export function recordingToDoc(
  recording: RunRecording,
  profile: RenditionProfile,
  opts?: RecordingToDocOptions,
): RecordingDocResult {
  const knobs = RENDITION_KNOBS[profile];
  const actors = new Map<string, RunRecordingActor>(
    recording.actors.map((actor) => [actor.id, actor]),
  );
  const narrationOf = (scene: RunRecordingScene): string => narrationLine(scene, actors);

  let scenes = recording.scenes;
  if (profile === 'marketing') {
    scenes = selectMarketingScenes(scenes, knobs.maxBlocks - 2);
  } else if (scenes.length > knobs.maxBlocks - 2) {
    // Debug keeps chronology; overflow thins the chattiest kinds first,
    // exactly like the distiller's tiers (which usually already ran).
    scenes = selectMarketingScenes(scenes, knobs.maxBlocks - 2);
  }

  const timeline = buildTimeline(scenes, profile, knobs, narrationOf);
  const runStartedAtMs = Date.parse(
    recording.trial?.startedAt ?? recording.scenes[0]?.at ?? new Date(0).toISOString(),
  );

  const coverDuration = COVER_SECONDS[profile];
  const outroDuration = OUTRO_SECONDS[profile];
  const blocks: Block[] = [];
  const captions: CaptionPhrase[] = [];
  const title = coverTitle(recording);
  const subtitle = coverSubtitle(recording);

  // No caption on the cover or outro: those blocks ARE full-screen text,
  // and a caption underneath just duplicates it. Captions narrate scenes.
  blocks.push(coverBlock(title, subtitle, { startTime: 0, duration: coverDuration }));

  const ctx = {
    actors,
    availableMedia: opts?.availableMedia,
    profile,
    showTimestamps: knobs.showTimestamps,
    runStartedAtMs,
  };
  for (const [index, entry] of timeline.timed.entries()) {
    const startTime = entry.startTime + coverDuration;
    blocks.push(
      sceneToBlock(
        entry.scene,
        index,
        {
          startTime,
          duration: entry.duration,
          ...(entry.gapBeforeSeconds !== undefined
            ? { gapBeforeSeconds: entry.gapBeforeSeconds }
            : {}),
        },
        ctx,
      ),
    );
    captions.push({
      text: narrationOf(entry.scene),
      startTime,
      endTime: startTime + entry.duration,
      audioSegment: 0,
    });
  }

  const outroStart = coverDuration + timeline.totalDuration;
  blocks.push(outroBlock(recording, profile, { startTime: outroStart, duration: outroDuration }));

  const media: MovieMediaRef[] = collectScreenshotRefs(recording);
  for (const actor of recording.actors) {
    if (hasPoppetjeMedia(actor, opts?.availableMedia)) {
      media.push({ path: poppetjeMediaPath(actor.id), kind: 'poppetje', actorId: actor.id });
    }
  }

  const doc: Doc = {
    articleId:
      opts?.articleId ??
      recording.trial?.trialId ??
      recording.provenance?.craftbookId ??
      'gezel-run',
    duration: outroStart + outroDuration,
    blocks,
    audio: { segments: [] },
    captions: { phrases: captions, version: 1 },
    ...(opts?.themeId ? { themeId: opts.themeId } : {}),
    startBlock: {
      title,
      ...(subtitle ? { subtitle } : {}),
      ambientMotion: 'zoomIn',
    },
    // No generatedAt: the mapping is pure, and golden tests depend on
    // byte-stable output for identical input.
    meta: { generatedBy: 'gezel-movies', version: 1 },
  };
  return { doc, media };
}
