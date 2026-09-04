import type { RunRecordingScene } from '@bendyline/gezel';
import { estimateReadingTime } from '@bendyline/squisq/timing';
import type { RenditionKnobs, RenditionProfile } from './profiles.js';

export interface TimedScene {
  scene: RunRecordingScene;
  startTime: number;
  duration: number;
  /** Real seconds elapsed before this scene when a gap beat precedes it. */
  gapBeforeSeconds?: number;
}

export interface Timeline {
  timed: TimedScene[];
  totalDuration: number;
}

/**
 * Debug pacing: order-preserving log compression. A scene's dwell grows
 * with the real time it covered — `clamp(min, max, 2.0 + 1.3·ln(1+s))` —
 * so a 10-minute build step reads longer than a 2-second read, without
 * ever making the viewer sit through real time. Idle gaps past the
 * threshold surface as an explicit beat instead of silently vanishing:
 * ground truth stays visible, playback stays watchable.
 *
 * Marketing pacing: the scene list is already selected; dwell comes from
 * the reading time of what is ON SCREEN (the excerpt, which the bubble
 * typewrites, falling back to the narration line) plus a settle beat, so
 * a viewer can actually finish reading a bubble before it cuts. The
 * target duration is a ceiling: a naturally shorter cut is left alone,
 * and an over-long one is compressed linearly but never below the
 * per-scene floor.
 */
export function buildTimeline(
  scenes: RunRecordingScene[],
  profile: RenditionProfile,
  knobs: RenditionKnobs,
  narrationOf: (scene: RunRecordingScene) => string,
): Timeline {
  const timed: TimedScene[] = [];
  let cursor = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const prev = scenes[i - 1];
    const next = scenes[i + 1];
    // Real idle time BEFORE this scene; past the threshold it becomes an
    // explicit "time passes" beat rendered by the block builder.
    let gapBeforeSeconds: number | undefined;
    if (profile === 'debug' && prev) {
      const gap = Math.max(0, (Date.parse(scene.at) - Date.parse(prev.at)) / 1000);
      // Rendered as a ribbon ON the scene's own block (no dead air): the
      // beat costs nothing on the clock but the elapsed time is on screen.
      if (gap > knobs.gapBeatThresholdSeconds) gapBeforeSeconds = gap;
    }
    let duration: number;
    if (profile === 'debug') {
      const coveredSeconds = next
        ? Math.max(0, (Date.parse(next.at) - Date.parse(scene.at)) / 1000)
        : 4;
      duration = clamp(
        knobs.minSceneSeconds,
        knobs.maxSceneSeconds,
        2.0 + 1.3 * Math.log(1 + coveredSeconds),
      );
    } else {
      const onScreen =
        scene.excerpt && scene.excerpt.length > 0 ? scene.excerpt : narrationOf(scene);
      const reading = estimateReadingTime(onScreen);
      // +1.5s settle: the bubble typewrites in over up to 2.5s, and a card
      // needs a breath after its last word before the cut.
      duration = clamp(knobs.minSceneSeconds, knobs.maxSceneSeconds, reading.seconds + 1.5);
    }
    timed.push({
      scene,
      startTime: cursor,
      duration,
      ...(gapBeforeSeconds !== undefined ? { gapBeforeSeconds } : {}),
    });
    cursor += duration;
  }

  if (
    profile === 'marketing' &&
    knobs.targetDurationSeconds > 0 &&
    cursor > knobs.targetDurationSeconds
  ) {
    const scale = knobs.targetDurationSeconds / cursor;
    let scaledCursor = 0;
    for (const entry of timed) {
      entry.startTime = scaledCursor;
      entry.duration = Math.max(knobs.minSceneSeconds, entry.duration * scale);
      scaledCursor += entry.duration;
    }
    cursor = scaledCursor;
  }
  return { timed, totalDuration: cursor };
}

/**
 * Eval-harness interventions relayed through the crew (`[scenario check]`
 * nudges). They are real messages and stay in the debug rendition, but a
 * marketing cut must not headline the harness poking the model.
 */
export function isHarnessNudge(scene: RunRecordingScene): boolean {
  return /^\s*\[scenario check\]/i.test(scene.excerpt ?? '');
}

/**
 * Marketing selection: score every scene, keep the best `budget` in
 * chronological order. Load-bearing beats outrank chatter; visuals
 * (screenshots, diffs) get a bonus; step chapters are capped so a
 * 12-step book doesn't spend the whole cut on section cards.
 */
export function selectMarketingScenes(
  scenes: RunRecordingScene[],
  budget: number,
): RunRecordingScene[] {
  const lastReplyIndex = scenes.reduce(
    (last, scene, index) => (scene.kind === 'reply' ? index : last),
    -1,
  );
  let reasoningKept = 0;
  let stepKept = 0;
  const scored = scenes.map((scene, index) => {
    let score = 0;
    switch (scene.kind) {
      case 'user-prompt':
        score = index === 0 ? 100 : 60;
        break;
      case 'delegation':
        score = 90;
        break;
      case 'artifact-produced':
        score = 85 + (scene.screenshotRef ? 10 : 0);
        break;
      case 'gate-verdict':
        score = scene.verdict === 'pass' ? 78 : 70;
        break;
      case 'turn-aborted':
        score = 65;
        break;
      case 'step-transition':
        score = scene.phase === 'activated' ? 62 : 45;
        break;
      case 'reply':
        score = index === lastReplyIndex ? 75 : 50;
        break;
      case 'question':
        score = 45;
        break;
      case 'reasoning':
        score = 40;
        break;
      case 'tool-call':
        score = 30 + (scene.diffStats ? 15 : 0) + (scene.path?.endsWith('.html') ? 10 : 0);
        break;
      case 'note':
        score = 20;
        break;
    }
    return { scene, index, score };
  });
  const picked = new Set<number>();
  for (const entry of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (picked.size >= budget) break;
    if (isHarnessNudge(entry.scene)) continue;
    if (entry.scene.kind === 'reasoning' && reasoningKept >= 2) continue;
    if (entry.scene.kind === 'step-transition' && stepKept >= 3) continue;
    if (entry.scene.kind === 'reasoning') reasoningKept += 1;
    if (entry.scene.kind === 'step-transition') stepKept += 1;
    picked.add(entry.index);
  }
  return scenes.filter((_, index) => picked.has(index));
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}
