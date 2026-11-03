import type { RunRecording, RunRecordingActor, RunRecordingScene } from '@bendyline/gezel';
import { getThemeFont } from '@bendyline/squisq/doc';
import {
  type Block,
  type CaptionPhrase,
  DEFAULT_THEME,
  DEFAULT_THEME_ID,
  type Doc,
  VIEWPORT_PRESETS,
  createTemplateContext,
  resolveTheme,
} from '@bendyline/squisq/schemas';
import {
  type MovieMediaRef,
  collectScreenshotRefs,
  hasPoppetjeMedia,
  poppetjeMediaPath,
} from '../media.js';
import { crewModel } from './crew.js';
import {
  cleanExcerpt,
  coverSubtitle,
  coverTitle,
  marketingCaption,
  narrationLine,
  thoughtExcerpt,
} from './narration.js';
import { RENDITION_KNOBS, type RenditionProfile } from './profiles.js';
import {
  type EndCard,
  type MovieFonts,
  castBlock,
  coverBlock,
  outroBlock,
  sceneToBlock,
} from './scenes.js';
import { buildTimeline, selectMarketingScenes } from './timing.js';

/**
 * The font stacks the player will resolve for `themeId`, so authored
 * text layers match the theme instead of falling back to the platform
 * UI font. Same resolution path squisq's own templates use.
 */
function themeFonts(themeId: string): MovieFonts {
  const theme = resolveTheme(themeId) ?? DEFAULT_THEME;
  const context = createTemplateContext(theme, 0, 1, VIEWPORT_PRESETS.landscape);
  return {
    title: getThemeFont(context, 'title'),
    body: getThemeFont(context, 'body'),
    mono: getThemeFont(context, 'mono'),
  };
}

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
  /** Cover title in plain words ("Build a pet shop website"); else the scenario id. */
  title?: string;
  /** The model's display name for the cover ("Gemma 4 12B"); else its catalog id. */
  modelLabel?: string;
  /**
   * The marketing outro: what was made, on what, how long it took, and how
   * often it passes. Without one the outro is the plain brand card.
   */
  endCard?: EndCard;
}

/**
 * The marketing cut shows what a viewer can follow: the job, the hand-offs,
 * the gezels thinking it through, the work and the result. A reasoning
 * trace is kept only as the stretch where the gezel speaks for itself
 * (`thoughtExcerpt`); one that is all instructions and tool names is
 * dropped. A task's kickoff message (the system restating the job it just
 * started) would only repeat the opening ask. Excerpts lose markdown and
 * the structured hand-off instructions.
 */
function marketingScenes(scenes: readonly RunRecordingScene[]): RunRecordingScene[] {
  const thoughts = new Map<RunRecordingScene, string>();
  for (const scene of scenes) {
    if (scene.kind === 'reasoning' && scene.excerpt) {
      const thought = thoughtExcerpt(scene.excerpt);
      if (thought) thoughts.set(scene, thought);
    }
  }
  const kept = scenes.filter((scene, index) => {
    if (scene.kind === 'reasoning') return thoughts.has(scene);
    if (scene.kind === 'user-prompt' && index > 0 && scene.taskRef) return false;
    // Status pings between steps say nothing a viewer can use.
    if (scene.kind === 'reply' && isStatusPing(scene.excerpt ?? '')) return false;
    return true;
  });
  // A run with a check after every step would spend the cut on verdicts:
  // keep the first and the last, which show that the work is checked.
  const gates = kept.filter((scene) => scene.kind === 'gate-verdict');
  const keepGates = new Set([gates[0], gates[gates.length - 1]].filter(Boolean));
  return kept
    .filter((scene) => scene.kind !== 'gate-verdict' || keepGates.has(scene))
    .map((scene, index) => {
      if (!scene.excerpt) return scene;
      const thought = thoughts.get(scene);
      if (thought) return { ...scene, excerpt: thought } as RunRecordingScene;
      const cleaned = cleanExcerpt(scene.excerpt);
      const excerpt =
        scene.kind === 'user-prompt' && index === 0 ? firstSentence(cleaned) : cleaned;
      return { ...scene, excerpt } as RunRecordingScene;
    });
}

function isStatusPing(text: string): boolean {
  return /^(checkpoint written|finished ".+"\. next:|step complete)/i.test(text.trim());
}

/** The opening ask's first sentence: the job, without the delivery instructions. */
function firstSentence(text: string): string {
  const match = text.match(/^[\s\S]{20,220}?[.!?](?=\s|$)/);
  return (match ? match[0] : text.slice(0, 200)).trim();
}

export interface RecordingDocResult {
  doc: Doc;
  media: MovieMediaRef[];
}

const COVER_SECONDS = { debug: 3.5, marketing: 4 } as const;
/** The cast card: long enough for each member to arrive and be read. */
function castSeconds(members: number): number {
  return Math.min(8, 3.5 + members * 0.6);
}
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
  const narrationOf = (scene: RunRecordingScene): string =>
    profile === 'marketing' ? marketingCaption(scene, actors) : narrationLine(scene, actors);

  let scenes = recording.scenes;
  if (profile === 'marketing') {
    // A few tool beats show the crew working; more is a list of file reads.
    scenes = selectMarketingScenes(marketingScenes(scenes), knobs.maxBlocks - 2, {
      maxToolCalls: 4,
    });
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
  const endCard = profile === 'marketing' ? opts?.endCard : undefined;
  // An end card carries the result and its numbers, so it holds longer.
  const outroDuration = endCard ? (endCard.screenshotRef ? 7 : 5.5) : OUTRO_SECONDS[profile];
  const themeId = opts?.themeId ?? DEFAULT_THEME_ID;
  const fonts = themeFonts(themeId);
  // The marketing cut draws the whole crew on every block and opens with
  // them; a run of one gezel has no crew to show.
  const crew = profile === 'marketing' ? crewModel(recording) : undefined;
  const showCrew =
    crew !== undefined && crew.members.filter((member) => member.id !== 'user').length >= 2;
  const castDuration = showCrew ? castSeconds(crew.members.length) : 0;
  const lead = coverDuration + castDuration;
  const blocks: Block[] = [];
  const captions: CaptionPhrase[] = [];
  const title = coverTitle(recording, opts?.title);
  const subtitle = coverSubtitle(recording, opts?.modelLabel);

  // No caption on the cover or outro: those blocks ARE full-screen text,
  // and a caption underneath just duplicates it. Captions narrate scenes.
  blocks.push(coverBlock(title, subtitle, { startTime: 0, duration: coverDuration }, fonts));

  const ctx = {
    actors,
    availableMedia: opts?.availableMedia,
    profile,
    showTimestamps: knobs.showTimestamps,
    runStartedAtMs,
    fonts,
    crew: showCrew ? crew : undefined,
  };
  if (showCrew) {
    blocks.push(castBlock(crew, ctx, { startTime: coverDuration, duration: castDuration }));
  }
  for (const [index, entry] of timeline.timed.entries()) {
    const startTime = entry.startTime + lead;
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

  const outroStart = lead + timeline.totalDuration;
  blocks.push(
    outroBlock(
      recording,
      profile,
      { startTime: outroStart, duration: outroDuration },
      fonts,
      endCard,
    ),
  );

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
    // Always explicit: the authored layers were font-stamped for THIS
    // theme, so the player must resolve the same one.
    themeId,
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
