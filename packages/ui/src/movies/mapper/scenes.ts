import type { RunRecording, RunRecordingActor, RunRecordingScene } from '@bendyline/gezel';
import type { Block, Layer, TextLayer } from '@bendyline/squisq/schemas';
import { hasPoppetjeMedia, poppetjeMediaPath } from '../media.js';
import { type CrewModel, activeIds } from './crew.js';
import { humanToolName, toolVerb } from './narration.js';
import type { RenditionProfile } from './profiles.js';

/**
 * Scene → squisq Block builders. Every block AUTHORS its layers directly
 * (background + content) rather than leaning on squisq's built-in
 * templates: full visual control, no template-input contract to chase,
 * and the one squisq rule that bites — a template block cannot carry
 * extra authored layers — never applies. When squisq ships a native
 * `transcript` template, the chat builders here swap to it without the
 * scene grammar changing.
 *
 * Coordinates are percent strings on squisq's 1920×1080 design basis;
 * font sizes are px on the same basis (the renderer scales).
 */

/** Dark, documentary-leaning palette. Deliberately self-contained. */
export const MOVIE_PALETTE = {
  bgTop: '#171c26',
  bgBottom: '#0f131b',
  text: '#e8ecf4',
  textMuted: '#93a0b8',
  bubble: '#232a38',
  bubbleUser: '#2b3a55',
  bubbleThought: '#1d2330',
  bubbleTool: '#152238',
  accent: '#7aa2ff',
  success: '#57c78f',
  failure: '#e2695f',
  chip: '#31405c',
} as const;

/**
 * The marketing outro's facts. Every line is a claim a viewer can check
 * against the scorecard, so the caller builds them from the trial's own
 * records, never from copy.
 */
export interface EndCard {
  /** The big line, e.g. "Done in 2 minutes". */
  headline: string;
  /** One fact per line: model and machine, pass count, where to read more. */
  lines: string[];
  /** Recording-relative screenshot of the finished work, when there is one. */
  screenshotRef?: string;
}

/** CSS font stacks resolved from the squisq theme the doc plays under. */
export interface MovieFonts {
  title: string;
  body: string;
  mono: string;
}

export interface SceneBlockContext {
  actors: Map<string, RunRecordingActor>;
  /** Recording-dir-relative media files the consumer can actually serve. */
  availableMedia?: ReadonlySet<string> | undefined;
  profile: RenditionProfile;
  showTimestamps: boolean;
  runStartedAtMs: number;
  fonts: MovieFonts;
  /** The cast and plan; set for the marketing cut, which draws them on every block. */
  crew?: CrewModel | undefined;
}

/**
 * The marketing frame: the player's caption runs along the top and its
 * controls along the bottom, the crew rail sits just above the controls,
 * and scene content is centred in the band between.
 */
const STAGE = { top: 12, bottom: 72, railY: 80 } as const;

/** Design basis the percent coordinates are laid out against. */
const BASIS = { width: 1920, height: 1080 } as const;
const LINE_HEIGHT = 1.35;

/**
 * Greedy word wrap at an average-glyph-width estimate, deliberately on
 * the narrow side (the theme's body face averages ~0.45em per glyph):
 * each line becomes its own text layer, so a line the renderer would
 * wrap again would overlap the next. A cut that runs out of lines ends
 * in an ellipsis.
 */
export function wrapLines(
  body: string,
  fontSize: number,
  widthPct: number,
  maxLines: number,
): string[] {
  const widthPx = (widthPct / 100) * BASIS.width;
  const charsPerLine = Math.max(8, Math.floor(widthPx / (fontSize * 0.5)));
  const lines: string[] = [];
  for (const paragraph of body.split('\n')) {
    let line = '';
    for (let word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
      while (word.length > charsPerLine) {
        if (line) lines.push(line);
        lines.push(word.slice(0, charsPerLine));
        line = '';
        word = word.slice(charsPerLine);
      }
      const next = line ? `${line} ${word}` : word;
      if (next.length > charsPerLine) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1]!;
  kept[maxLines - 1] =
    `${last.length > charsPerLine - 2 ? last.slice(0, charsPerLine - 2) : last}…`;
  return kept;
}

/** Percent of frame height one text line takes at `fontSize`. */
function lineHeightPct(fontSize: number): number {
  return ((fontSize * LINE_HEIGHT) / BASIS.height) * 100;
}

/** "Name · Role" — the crew are craftspeople; their trade is part of the credit. */
function credit(actor: RunRecordingActor | undefined, fallbackName: string): string {
  const name = actor?.name ?? fallbackName;
  return actor?.role ? `${name}  ·  ${actor.role}` : name;
}

/**
 * Authored layers carry no font of their own, so the renderer would fall
 * back to the platform UI font (Segoe on Windows) — off-theme. Stamp the
 * theme's stacks: title face for display lines, mono for tool chips and
 * their detail, body for everything else. Layers that already name a
 * font keep it.
 */
function applyThemeFonts(layers: Layer[], fonts: MovieFonts): Layer[] {
  for (const layer of layers) {
    if (layer.type !== 'text' || layer.content.style.fontFamily) continue;
    const id = layer.id;
    const face =
      id.endsWith('-tool') || id.endsWith('-detail')
        ? fonts.mono
        : id.endsWith('-title') || id.endsWith('-verdict') || id.endsWith('-brand')
          ? fonts.title
          : fonts.body;
    layer.content.style.fontFamily = face;
  }
  return layers;
}

export function sceneToBlock(
  scene: RunRecordingScene,
  index: number,
  timing: { startTime: number; duration: number; gapBeforeSeconds?: number },
  ctx: SceneBlockContext,
): Block {
  const id = `scene-${String(index).padStart(3, '0')}-${scene.kind}`;
  const layers: Layer[] = [backgroundLayers(id)];
  const reveal = timing.duration;
  switch (scene.kind) {
    case 'user-prompt':
      layers.push(
        ...bubbleLayers(id, ctx, {
          actor: ctx.actors.get(scene.actorId ?? 'user'),
          fallbackName: 'You',
          text: scene.excerpt ?? '…',
          fill: MOVIE_PALETTE.bubbleUser,
          reveal,
        }),
      );
      break;
    case 'reasoning':
      layers.push(
        ...bubbleLayers(id, ctx, {
          actor: ctx.actors.get(scene.actorId ?? ''),
          fallbackName: 'Gezel',
          text: scene.excerpt ?? '…',
          fill: MOVIE_PALETTE.bubbleThought,
          italic: true,
          label: 'thinking',
          thought: true,
          reveal,
        }),
      );
      break;
    case 'reply':
      layers.push(
        ...bubbleLayers(id, ctx, {
          actor: ctx.actors.get(scene.actorId ?? ''),
          fallbackName: 'Gezel',
          text: scene.excerpt ?? '…',
          fill: MOVIE_PALETTE.bubble,
          reveal,
        }),
      );
      break;
    case 'note':
      layers.push(
        ...bubbleLayers(id, ctx, {
          actor: ctx.actors.get(scene.actorId ?? ''),
          fallbackName: 'Gezel',
          text: scene.excerpt ?? '…',
          fill: MOVIE_PALETTE.bubbleThought,
          label: 'task note',
          reveal,
        }),
      );
      break;
    case 'question':
      layers.push(
        ...bubbleLayers(id, ctx, {
          actor: ctx.actors.get(scene.actorId ?? ''),
          fallbackName: 'Gezel',
          text:
            scene.excerpt ??
            (scene.state === 'answered' ? 'Question answered.' : 'A question for you.'),
          fill: MOVIE_PALETTE.bubble,
          label: 'question',
          reveal,
        }),
      );
      break;
    case 'tool-call':
      layers.push(...toolLayers(id, ctx, scene));
      break;
    case 'delegation':
      layers.push(...delegationLayers(id, ctx, scene, reveal));
      break;
    case 'step-transition':
      layers.push(
        ...(ctx.crew && ctx.profile === 'marketing'
          ? stepCardLayers(id, ctx, ctx.crew, scene)
          : stepLayers(id, scene, ctx.profile)),
      );
      break;
    case 'gate-verdict':
      layers.push(...gateLayers(id, scene, ctx.profile));
      break;
    case 'artifact-produced':
      layers.push(...artifactLayers(id, scene, ctx.profile));
      break;
    case 'turn-aborted':
      layers.push(
        text(`${id}-abort`, scene.reason ?? 'The turn was cut short.', {
          x: '50%',
          y: '50%',
          width: '70%',
          anchor: 'center',
          fontSize: 40,
          color: MOVIE_PALETTE.failure,
        }),
      );
      break;
  }
  if (ctx.crew && ctx.profile === 'marketing') {
    layers.push(...crewRailLayers(id, ctx, ctx.crew, activeIds(scene, ctx.crew)));
  }
  if (timing.gapBeforeSeconds !== undefined) {
    layers.push(
      text(`${id}-gap`, `… ${formatElapsed(timing.gapBeforeSeconds)} pass`, {
        x: '50%',
        y: '6%',
        anchor: 'center',
        fontSize: 26,
        color: MOVIE_PALETTE.textMuted,
        italic: true,
      }),
    );
  }
  if (ctx.showTimestamps) {
    const elapsed = Math.max(0, (Date.parse(scene.at) - ctx.runStartedAtMs) / 1000);
    layers.push(
      text(`${id}-clock`, `t+${formatElapsed(elapsed)}`, {
        x: '96%',
        y: '95%',
        anchor: 'bottom-right',
        fontSize: 22,
        color: MOVIE_PALETTE.textMuted,
      }),
    );
  }
  return {
    id,
    startTime: round2(timing.startTime),
    duration: round2(timing.duration),
    audioSegment: 0,
    layers: applyThemeFonts(layers, ctx.fonts),
    transition: { type: scene.kind === 'artifact-produced' ? 'zoom' : 'fade', duration: 0.5 },
  };
}

export function coverBlock(
  title: string,
  subtitle: string,
  timing: { startTime: number; duration: number },
  fonts: MovieFonts,
): Block {
  const id = 'scene-cover';
  return {
    id,
    startTime: round2(timing.startTime),
    duration: round2(timing.duration),
    audioSegment: 0,
    layers: applyThemeFonts(
      [
        backgroundLayers(id),
        text(`${id}-title`, title, {
          x: '50%',
          y: '44%',
          width: '84%',
          anchor: 'center',
          fontSize: 84,
          color: MOVIE_PALETTE.text,
          bold: true,
          align: 'center',
        }),
        ...(subtitle
          ? [
              text(`${id}-subtitle`, subtitle, {
                x: '50%',
                y: '58%',
                width: '80%',
                anchor: 'center',
                fontSize: 34,
                color: MOVIE_PALETTE.textMuted,
                align: 'center',
              }),
            ]
          : []),
      ],
      fonts,
    ),
    transition: { type: 'fade', duration: 0.7 },
  };
}

export function outroBlock(
  recording: RunRecording,
  profile: RenditionProfile,
  timing: { startTime: number; duration: number },
  fonts: MovieFonts,
  endCard?: EndCard,
): Block {
  const id = 'scene-outro';
  const layers: Layer[] = [backgroundLayers(id)];
  if (profile === 'marketing' && endCard) {
    layers.push(...endCardLayers(id, endCard));
  } else if (profile === 'marketing') {
    layers.push(
      text(`${id}-brand`, 'Made with Gezel', {
        x: '50%',
        y: '46%',
        anchor: 'center',
        fontSize: 64,
        color: MOVIE_PALETTE.text,
        bold: true,
        align: 'center',
      }),
      text(`${id}-tag`, 'A real run, played back.', {
        x: '50%',
        y: '58%',
        anchor: 'center',
        fontSize: 30,
        color: MOVIE_PALETTE.textMuted,
        align: 'center',
      }),
    );
  } else {
    const outcome =
      recording.trial?.success === undefined
        ? 'run complete'
        : recording.trial.success
          ? 'PASS'
          : 'FAIL';
    const lines = [
      `Outcome: ${outcome}`,
      recording.trial?.durationMs !== undefined
        ? `Duration: ${formatElapsed(recording.trial.durationMs / 1000)}`
        : undefined,
      `Scenes: ${recording.scenes.length}${
        recording.budget.droppedScenes > 0 ? ` (+${recording.budget.droppedScenes} dropped)` : ''
      }`,
      recording.trial?.reason ? `Reason: ${recording.trial.reason}` : undefined,
    ].filter((line): line is string => line !== undefined);
    layers.push(
      text(`${id}-stats`, lines.join('\n'), {
        x: '50%',
        y: '50%',
        width: '70%',
        anchor: 'center',
        fontSize: 36,
        color: recording.trial?.success === false ? MOVIE_PALETTE.failure : MOVIE_PALETTE.success,
        align: 'center',
      }),
    );
  }
  return {
    id,
    startTime: round2(timing.startTime),
    duration: round2(timing.duration),
    audioSegment: 0,
    layers: applyThemeFonts(layers, fonts),
    transition: { type: 'fade', duration: 0.7 },
  };
}

/**
 * The result and its numbers: the finished work on the left when there is
 * a screenshot of it, the facts beside it, the brand last and smallest.
 */
function endCardLayers(id: string, card: EndCard): Layer[] {
  const withShot = Boolean(card.screenshotRef);
  const textX = withShot ? '56%' : '50%';
  const anchor = withShot ? ('top-left' as const) : ('center' as const);
  const align = withShot ? ('left' as const) : ('center' as const);
  const layers: Layer[] = [];
  if (card.screenshotRef) {
    layers.push({
      type: 'image',
      id: `${id}-shot`,
      content: { src: card.screenshotRef, alt: 'The finished work', fit: 'contain' },
      position: { x: '28%', y: '48%', width: '46%', height: '66%', anchor: 'center' },
      animation: { type: 'zoomIn', duration: 0.8 },
    });
  }
  layers.push(
    text(`${id}-title`, card.headline, {
      x: textX,
      y: withShot ? '30%' : '36%',
      width: withShot ? '38%' : '80%',
      anchor,
      fontSize: 64,
      color: MOVIE_PALETTE.text,
      bold: true,
      align,
    }),
    text(`${id}-facts`, card.lines.join('\n'), {
      x: textX,
      y: withShot ? '44%' : '52%',
      width: withShot ? '38%' : '76%',
      anchor,
      fontSize: 32,
      color: MOVIE_PALETTE.textMuted,
      align,
      animation: { type: 'fadeIn', duration: 0.6, delay: 0.5 },
    }),
    text(`${id}-brand`, 'Made with Gezel  ·  gezel.com', {
      x: textX,
      y: withShot ? '76%' : '78%',
      width: withShot ? '38%' : '80%',
      anchor,
      fontSize: 30,
      color: MOVIE_PALETTE.accent,
      bold: true,
      align,
    }),
  );
  return layers;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ── Layer helpers ────────────────────────────────────────────────────

function backgroundLayers(blockId: string): Layer {
  return {
    type: 'shape',
    id: `${blockId}-bg`,
    content: {
      shape: 'rect',
      gradient: { from: MOVIE_PALETTE.bgTop, to: MOVIE_PALETTE.bgBottom, angle: 180 },
    },
    position: { x: '50%', y: '50%', width: '110%', height: '110%', anchor: 'center' },
  };
}

interface BubbleOpts {
  actor: RunRecordingActor | undefined;
  fallbackName: string;
  text: string;
  fill: string;
  italic?: boolean;
  label?: string;
  /** A thought, not speech: dashed outline and thought-dots. */
  thought?: boolean;
  /** Seconds the block is on screen; the lines flow in over part of it. */
  reveal: number;
}

const BUBBLE = { left: 21, width: 64, fontSize: 32, maxLines: 7, insetX: 2.5, insetY: 2.4 };

function bubbleLayers(blockId: string, ctx: SceneBlockContext, opts: BubbleOpts): Layer[] {
  const name = opts.actor?.name ?? opts.fallbackName;
  const lines = wrapLines(
    opts.text,
    BUBBLE.fontSize,
    BUBBLE.width - BUBBLE.insetX * 2,
    BUBBLE.maxLines,
  );
  const bubbleHeight = lines.length * lineHeightPct(BUBBLE.fontSize) + BUBBLE.insetY * 2;
  // Marketing centres the speaker and bubble in the stage band; debug
  // keeps its fixed top so triage frames line up run to run.
  const groupTop =
    ctx.profile === 'marketing'
      ? Math.max(STAGE.top, (STAGE.top + STAGE.bottom) / 2 - (bubbleHeight + 5) / 2)
      : 22;
  const bubbleTop = groupTop + 5;
  const avatarY = bubbleTop + 7;
  const layers: Layer[] = [
    ...avatarLayers(blockId, ctx, opts.actor, name, { x: '12%', y: `${round2(avatarY)}%` }),
    text(`${blockId}-name`, credit(opts.actor, name) + (opts.label ? `  ·  ${opts.label}` : ''), {
      x: `${BUBBLE.left}%`,
      y: `${round2(groupTop)}%`,
      anchor: 'top-left',
      fontSize: 26,
      color: MOVIE_PALETTE.textMuted,
      bold: true,
    }),
  ];
  if (opts.thought) {
    // Thought-dots rising from the figure to the bubble.
    for (const [index, dot] of [
      { x: 17.2, dy: 1.5, size: 0.8 },
      { x: 19.1, dy: -1.5, size: 1.2 },
    ].entries()) {
      layers.push({
        type: 'shape',
        id: `${blockId}-dot-${index}`,
        content: {
          shape: 'circle',
          fill: MOVIE_PALETTE.bubbleThought,
          stroke: MOVIE_PALETTE.chip,
          strokeWidth: 2,
        },
        position: {
          x: `${dot.x}%`,
          y: `${round2(avatarY - 5 + dot.dy)}%`,
          width: `${dot.size}%`,
          height: `${round2((dot.size * 16) / 9)}%`,
          anchor: 'center',
        },
        animation: { type: 'fadeIn', duration: 0.3, delay: 0.1 + index * 0.15 },
      });
    }
  }
  layers.push(
    ...flowBubble(blockId, lines, {
      top: bubbleTop,
      left: BUBBLE.left,
      width: BUBBLE.width,
      height: bubbleHeight,
      fill: opts.fill,
      fontSize: BUBBLE.fontSize,
      italic: opts.italic,
      align: 'left',
      dashed: opts.thought,
      reveal: opts.reveal,
      delay: opts.thought ? 0.35 : 0,
    }),
  );
  return layers;
}

/** A glyph per kind of work, so a tool beat reads at a glance. */
function toolGlyph(name: string): string {
  if (/^(read|list|fetch|wikipedia_read)/.test(name)) return '📖';
  if (/search/.test(name)) return '🔎';
  if (/image/.test(name)) return '🎨';
  if (/(convert|preview|inspect|docblocks)/.test(name)) return '📄';
  if (/(write_task_note|note)/.test(name)) return '🗒️';
  if (/(write|save|copy|replace|append|make_dir)/.test(name)) return '✍️';
  if (/(suggest_work|start_work)/.test(name)) return '🧭';
  if (/(message|ensure)_gezel/.test(name)) return '💬';
  if (/(advance|complete)/.test(name)) return '✅';
  if (/run_/.test(name)) return '▶️';
  return '🛠️';
}

function toolLayers(
  blockId: string,
  ctx: SceneBlockContext,
  scene: RunRecordingScene & { kind: 'tool-call' },
): Layer[] {
  const actor = ctx.actors.get(scene.actorId ?? '');
  const name = actor?.name ?? 'Gezel';
  if (ctx.profile !== 'marketing') return debugToolLayers(blockId, ctx, scene, actor, name);
  // Marketing: one work card, the action in words and what it touched.
  const action =
    capitalize(toolVerb(scene.name)) +
    (scene.count && scene.count > 1 ? `  ×${scene.count}` : '') +
    (scene.success ? '' : '  ✕');
  // Task ids are the harness's bookkeeping, not something a viewer reads.
  const detail = [scene.path, scene.argsSummary].find(
    (part) => part !== undefined && part.length > 0 && !/\w\/\d/.test(part),
  );
  const top = 32;
  const height = detail ? 17 : 12;
  const avatarY = top + 3;
  return [
    ...avatarLayers(blockId, ctx, actor, name, { x: '12%', y: `${avatarY + 4}%` }),
    text(`${blockId}-name`, credit(actor, name), {
      x: `${BUBBLE.left}%`,
      y: `${top - 5}%`,
      anchor: 'top-left',
      fontSize: 26,
      color: MOVIE_PALETTE.textMuted,
      bold: true,
    }),
    {
      type: 'shape',
      id: `${blockId}-card`,
      content: {
        shape: 'rect',
        fill: MOVIE_PALETTE.bubbleTool,
        borderRadius: 18,
        stroke: scene.success ? MOVIE_PALETTE.accent : MOVIE_PALETTE.failure,
        strokeWidth: 2,
      },
      position: {
        x: `${BUBBLE.left}%`,
        y: `${top}%`,
        width: '46%',
        height: `${height}%`,
        anchor: 'top-left',
      },
      animation: { type: 'fadeIn', duration: 0.35 },
    },
    text(`${blockId}-glyph`, toolGlyph(scene.name), {
      x: `${BUBBLE.left + 4}%`,
      y: `${top + height / 2}%`,
      anchor: 'center',
      fontSize: 64,
      color: MOVIE_PALETTE.text,
      align: 'center',
      animation: { type: 'fadeIn', duration: 0.4, delay: 0.15 },
    }),
    text(`${blockId}-action`, action, {
      x: `${BUBBLE.left + 8}%`,
      y: `${top + (detail ? 3.2 : 3.4)}%`,
      width: '36%',
      anchor: 'top-left',
      fontSize: 40,
      color: scene.success ? MOVIE_PALETTE.text : MOVIE_PALETTE.failure,
      bold: true,
      maxLines: 1,
      animation: { type: 'fadeInUp', duration: 0.45, delay: 0.25 },
    }),
    ...(detail
      ? [
          text(`${blockId}-detail`, detail, {
            x: `${BUBBLE.left + 8}%`,
            y: `${top + 9.6}%`,
            width: '36%',
            anchor: 'top-left',
            fontSize: 26,
            color: MOVIE_PALETTE.accent,
            maxLines: 1,
            animation: { type: 'fadeInUp', duration: 0.45, delay: 0.5 },
          }),
        ]
      : []),
  ];
}

function debugToolLayers(
  blockId: string,
  ctx: SceneBlockContext,
  scene: RunRecordingScene & { kind: 'tool-call' },
  actor: RunRecordingActor | undefined,
  name: string,
): Layer[] {
  const toolLabel = humanToolName(scene.name);
  const chipText =
    toolLabel +
    (scene.count && scene.count > 1 ? `  ×${scene.count}` : '') +
    (scene.success ? '' : '  ✕');
  const detailParts = [
    scene.argsSummary,
    scene.path && !scene.argsSummary?.includes(scene.path) ? scene.path : undefined,
    scene.diffStats ? `+${scene.diffStats.addedLines} −${scene.diffStats.removedLines}` : undefined,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return [
    ...avatarLayers(blockId, ctx, actor, name, { x: '12%', y: '30%' }),
    text(`${blockId}-name`, credit(actor, name), {
      x: '21%',
      y: '22%',
      anchor: 'top-left',
      fontSize: 26,
      color: MOVIE_PALETTE.textMuted,
      bold: true,
    }),
    {
      type: 'shape',
      id: `${blockId}-chip`,
      content: {
        shape: 'rect',
        fill: MOVIE_PALETTE.chip,
        borderRadius: 10,
        stroke: scene.success ? MOVIE_PALETTE.accent : MOVIE_PALETTE.failure,
        strokeWidth: 2,
      },
      position: { x: '21%', y: '28%', width: '34%', height: '7%', anchor: 'top-left' },
      animation: { type: 'fadeIn', duration: 0.3 },
    },
    text(`${blockId}-tool`, chipText, {
      x: '23%',
      y: '29.6%',
      anchor: 'top-left',
      fontSize: 30,
      color: scene.success ? MOVIE_PALETTE.accent : MOVIE_PALETTE.failure,
      bold: true,
    }),
    ...(detailParts.length > 0
      ? [
          text(`${blockId}-detail`, detailParts.join('\n'), {
            x: '21%',
            y: '39%',
            width: '60%',
            anchor: 'top-left',
            fontSize: 28,
            color: MOVIE_PALETTE.text,
            maxLines: 4,
          }),
        ]
      : []),
  ];
}

function delegationLayers(
  blockId: string,
  ctx: SceneBlockContext,
  scene: RunRecordingScene & { kind: 'delegation' },
  reveal: number,
): Layer[] {
  const from = ctx.actors.get(scene.actorId ?? '');
  const to = ctx.actors.get(scene.toActorId);
  const fromName = from?.name ?? 'Gezel';
  const toName = to?.name ?? scene.toActorId;
  return [
    ...avatarLayers(`${blockId}-from`, ctx, from, fromName, { x: '26%', y: '24%' }),
    ...avatarLayers(`${blockId}-to`, ctx, to, toName, { x: '74%', y: '24%' }),
    text(`${blockId}-from-name`, credit(from, fromName), {
      x: '26%',
      y: '36%',
      anchor: 'center',
      fontSize: 28,
      color: MOVIE_PALETTE.textMuted,
      bold: true,
      align: 'center',
    }),
    text(`${blockId}-to-name`, credit(to, toName), {
      x: '74%',
      y: '36%',
      anchor: 'center',
      fontSize: 28,
      color: MOVIE_PALETTE.textMuted,
      bold: true,
      align: 'center',
    }),
    {
      type: 'path',
      id: `${blockId}-arrow`,
      content: {
        d: 'M 0 0 L 100 0',
        stroke: MOVIE_PALETTE.accent,
        strokeWidth: 4,
        endMarker: 'arrow',
      },
      position: { x: '50%', y: '25%', width: '30%', height: '1%', anchor: 'center' },
      animation: { type: 'fadeIn', duration: 0.5 },
    } as Layer,
    text(`${blockId}-verb`, scene.delegationKind === 'consultation' ? 'asks' : 'hands off', {
      x: '50%',
      y: '19%',
      anchor: 'center',
      fontSize: 24,
      color: MOVIE_PALETTE.accent,
      align: 'center',
    }),
    ...(scene.excerpt ? delegationBubble(blockId, scene.excerpt, reveal) : []),
  ];
}

function delegationBubble(blockId: string, body: string, reveal: number): Layer[] {
  const width = 66;
  const fontSize = 32;
  const lines = wrapLines(body, fontSize, width - BUBBLE.insetX * 2, 5);
  return flowBubble(blockId, lines, {
    top: 43,
    left: 17,
    width,
    height: lines.length * lineHeightPct(fontSize) + BUBBLE.insetY * 2,
    fill: MOVIE_PALETTE.bubble,
    fontSize,
    align: 'center',
    reveal,
    delay: 0.4,
  });
}

/**
 * A bubble whose text flows in a line at a time: background rect sized
 * to the wrapped lines, then one text layer per line rising into place
 * on a stagger, so a viewer reads down the bubble as it fills instead of
 * watching every line type across at once. The whole bubble is in by
 * about 40% of the block, leaving the rest to read it.
 */
function flowBubble(
  blockId: string,
  lines: string[],
  opts: {
    top: number;
    left: number;
    width: number;
    height: number;
    fill: string;
    fontSize: number;
    italic?: boolean | undefined;
    align: 'left' | 'center';
    dashed?: boolean | undefined;
    reveal: number;
    delay?: number;
  },
): Layer[] {
  const textWidth = opts.width - BUBBLE.insetX * 2;
  const step = lineHeightPct(opts.fontSize);
  const base = opts.delay ?? 0;
  const stagger =
    lines.length > 1
      ? Math.min(0.55, Math.max(0.12, (opts.reveal * 0.4 - 0.3) / (lines.length - 1)))
      : 0;
  const layers: Layer[] = [
    {
      type: 'shape',
      id: `${blockId}-bubble`,
      content: {
        shape: 'rect',
        fill: opts.fill,
        borderRadius: 18,
        ...(opts.dashed
          ? { stroke: MOVIE_PALETTE.chip, strokeWidth: 2, borderStyle: 'dashed' as const }
          : {}),
      },
      position: {
        x: `${opts.left}%`,
        y: `${round2(opts.top)}%`,
        width: `${opts.width}%`,
        height: `${round2(opts.height)}%`,
        anchor: 'top-left',
      },
      animation: { type: 'fadeIn', duration: 0.35, ...(base ? { delay: base } : {}) },
    },
  ];
  for (const [index, line] of lines.entries()) {
    layers.push(
      text(`${blockId}-text-${index}`, line, {
        x: `${opts.left + BUBBLE.insetX}%`,
        y: `${round2(opts.top + BUBBLE.insetY + index * step)}%`,
        width: `${textWidth}%`,
        anchor: 'top-left',
        fontSize: opts.fontSize,
        color: MOVIE_PALETTE.text,
        italic: opts.italic,
        align: opts.align,
        maxLines: 1,
        animation: {
          type: 'fadeInUp',
          duration: 0.45,
          delay: round2(base + 0.15 + index * stagger),
        },
      }),
    );
  }
  return layers;
}

function stepLayers(
  blockId: string,
  scene: RunRecordingScene & { kind: 'step-transition' },
  profile: RenditionProfile,
): Layer[] {
  const title = scene.stepName ?? scene.stepId;
  const phaseLabel =
    scene.phase === 'activated' ? 'begins' : scene.phase === 'completed' ? 'complete' : scene.phase;
  return [
    text(
      `${blockId}-kicker`,
      profile === 'debug' && scene.taskRef ? `task ${scene.taskRef}` : 'step',
      {
        x: '50%',
        y: '38%',
        anchor: 'center',
        fontSize: 26,
        color: MOVIE_PALETTE.accent,
        align: 'center',
      },
    ),
    text(`${blockId}-title`, title, {
      x: '50%',
      y: '48%',
      width: '80%',
      anchor: 'center',
      fontSize: 64,
      color: MOVIE_PALETTE.text,
      bold: true,
      align: 'center',
    }),
    text(`${blockId}-phase`, phaseLabel, {
      x: '50%',
      y: '60%',
      anchor: 'center',
      fontSize: 30,
      color: scene.phase === 'completed' ? MOVIE_PALETTE.success : MOVIE_PALETTE.textMuted,
      align: 'center',
    }),
  ];
}

function gateLayers(
  blockId: string,
  scene: RunRecordingScene & { kind: 'gate-verdict' },
  profile: RenditionProfile,
): Layer[] {
  const pass = scene.verdict === 'pass';
  if (profile === 'marketing') {
    // The step it checked, without the task id: `step "Lock the outline"`.
    const step = scene.excerpt?.match(/step "([^"]+)"/)?.[1];
    return [
      text(`${blockId}-verdict`, pass ? 'Quality check passed' : 'Sent back for another pass', {
        x: '50%',
        y: '46%',
        anchor: 'center',
        fontSize: 64,
        color: pass ? MOVIE_PALETTE.success : MOVIE_PALETTE.failure,
        bold: true,
        align: 'center',
      }),
      ...(step
        ? [
            text(`${blockId}-why`, `“${step}”`, {
              x: '50%',
              y: '58%',
              width: '70%',
              anchor: 'center',
              fontSize: 34,
              color: MOVIE_PALETTE.textMuted,
              align: 'center',
            }),
          ]
        : []),
    ];
  }
  return [
    text(`${blockId}-verdict`, pass ? 'GATE: PASS' : 'GATE: PUSHED BACK', {
      x: '50%',
      y: '46%',
      anchor: 'center',
      fontSize: 72,
      color: pass ? MOVIE_PALETTE.success : MOVIE_PALETTE.failure,
      bold: true,
      align: 'center',
    }),
    ...(scene.excerpt
      ? [
          text(`${blockId}-why`, scene.excerpt, {
            x: '50%',
            y: '60%',
            width: '70%',
            anchor: 'center',
            fontSize: 30,
            color: MOVIE_PALETTE.textMuted,
            align: 'center',
            maxLines: 3,
          }),
        ]
      : []),
  ];
}

function artifactLayers(
  blockId: string,
  scene: RunRecordingScene & { kind: 'artifact-produced' },
  profile: RenditionProfile,
): Layer[] {
  // Marketing keeps the shot clear of the crew rail below it.
  const shot =
    profile === 'marketing'
      ? { y: '42%', height: '58%', captionY: '75%' }
      : { y: '46%', height: '70%', captionY: '88%' };
  const caption = `${scene.path}${scene.bytes ? `  ·  ${formatBytes(scene.bytes)}` : ''}${
    scene.count && scene.count > 1 ? `  ·  ${scene.count} revisions` : ''
  }`;
  if (scene.screenshotRef) {
    return [
      {
        type: 'image',
        id: `${blockId}-shot`,
        content: { src: scene.screenshotRef, alt: scene.path, fit: 'contain' },
        position: { x: '50%', y: shot.y, width: '78%', height: shot.height, anchor: 'center' },
        animation: { type: 'zoomIn', duration: 0.8 },
      },
      text(`${blockId}-caption`, caption, {
        x: '50%',
        y: shot.captionY,
        anchor: 'center',
        fontSize: 28,
        color: MOVIE_PALETTE.textMuted,
        align: 'center',
      }),
    ];
  }
  // No picture of it: a page with the file's name, standing in for the file.
  return [
    {
      type: 'shape',
      id: `${blockId}-page`,
      content: { shape: 'rect', fill: '#eef1f6', borderRadius: 10 },
      position: { x: '50%', y: '38%', width: '15%', height: '40%', anchor: 'center' },
      animation: { type: 'zoomIn', duration: 0.6 },
    },
    ...[0, 1, 2, 3, 4, 5].map(
      (index): Layer => ({
        type: 'shape',
        id: `${blockId}-page-line-${index}`,
        content: { shape: 'rect', fill: index === 0 ? '#7f8aa3' : '#c3cad8', borderRadius: 3 },
        position: {
          x: '44.5%',
          y: `${24 + index * 4.8}%`,
          width: index === 0 ? '8%' : index % 3 === 2 ? '7%' : '11%',
          height: index === 0 ? '2%' : '1.3%',
          anchor: 'top-left',
        },
        animation: { type: 'fadeIn', duration: 0.3, delay: 0.4 + index * 0.08 },
      }),
    ),
    text(`${blockId}-ext`, (scene.path.split('.').pop() ?? '').toUpperCase(), {
      x: '50%',
      y: '54%',
      anchor: 'center',
      fontSize: 26,
      color: MOVIE_PALETTE.accent,
      bold: true,
      align: 'center',
    }),
    text(`${blockId}-caption`, caption, {
      x: '50%',
      y: profile === 'marketing' ? '65%' : '66%',
      width: '76%',
      anchor: 'center',
      fontSize: 34,
      color: MOVIE_PALETTE.text,
      align: 'center',
    }),
  ];
}

function avatarLayers(
  idPrefix: string,
  ctx: SceneBlockContext,
  actor: RunRecordingActor | undefined,
  name: string,
  center: { x: string; y: string },
  look: { width?: number; dim?: boolean; delay?: number } = {},
): Layer[] {
  // Square on the 16:9 basis: height is width × 16/9.
  const width = look.width ?? 9;
  const size = { width: `${width}%`, height: `${round2((width * 16) / 9)}%` };
  const animation =
    look.delay !== undefined
      ? { animation: { type: 'fadeIn' as const, duration: 0.5, delay: look.delay } }
      : {};
  if (actor && hasPoppetjeMedia(actor, ctx.availableMedia)) {
    return [
      {
        type: 'image',
        id: `${idPrefix}-avatar`,
        content: {
          src: poppetjeMediaPath(actor.id),
          alt: name,
          fit: 'contain',
          ...(look.dim ? { treatment: { type: 'mono' as const, strength: 0.85 } } : {}),
        },
        position: { x: center.x, y: center.y, ...size, anchor: 'center' },
        ...animation,
      },
    ];
  }
  // Initials fallback: circle + letters. The poppetje STRUCT still rides
  // in actors[] — React surfaces render the real figure from it. The user
  // is "You", spelled out.
  const initials =
    actor?.kind === 'user' || name === 'You'
      ? 'You'
      : name
          .split(/\s+/)
          .map((part) => part[0] ?? '')
          .join('')
          .slice(0, 2)
          .toUpperCase();
  const heightPx = ((width * 16) / 9 / 100) * BASIS.height;
  return [
    {
      type: 'shape',
      id: `${idPrefix}-avatar-bg`,
      content: {
        shape: 'circle',
        fill:
          actor?.kind === 'user' || name === 'You' ? MOVIE_PALETTE.bubbleUser : MOVIE_PALETTE.chip,
        stroke: look.dim ? MOVIE_PALETTE.chip : MOVIE_PALETTE.accent,
        strokeWidth: 2,
      },
      position: { x: center.x, y: center.y, ...size, anchor: 'center' },
      ...animation,
    },
    text(`${idPrefix}-avatar-initials`, initials || '?', {
      x: center.x,
      y: center.y,
      anchor: 'center',
      fontSize: Math.round(heightPx * (initials.length > 2 ? 0.3 : 0.4)),
      color: look.dim ? MOVIE_PALETTE.textMuted : MOVIE_PALETTE.text,
      bold: true,
      align: 'center',
      ...(look.delay !== undefined
        ? { animation: { type: 'fadeIn' as const, duration: 0.5, delay: look.delay } }
        : {}),
    }),
  ];
}

// ── Crew and plan ────────────────────────────────────────────────────

/** Evenly spaced x centres (percent), centred on the frame. */
function spread(count: number, maxGap: number, span: number): number[] {
  const gap = count > 1 ? Math.min(maxGap, span / (count - 1)) : 0;
  return Array.from({ length: count }, (_, index) => 50 + (index - (count - 1) / 2) * gap);
}

/** A horizontal bar between two x centres: connectors and progress tracks. */
function bar(
  id: string,
  fromX: number,
  toX: number,
  y: number,
  fill: string,
  thickness = 0.35,
  animation?: { delay: number },
): Layer {
  return {
    type: 'shape',
    id,
    content: { shape: 'rect', fill, borderRadius: 2 },
    position: {
      x: `${round2(Math.min(fromX, toX))}%`,
      y: `${round2(y - thickness / 2)}%`,
      width: `${round2(Math.max(0.1, Math.abs(toX - fromX)))}%`,
      height: `${thickness}%`,
      anchor: 'top-left',
    },
    ...(animation
      ? { animation: { type: 'fadeIn' as const, duration: 0.4, delay: animation.delay } }
      : {}),
  };
}

/**
 * The crew rail: the same cast in the same places on every block, the
 * ones on stage in colour with a ring, the rest greyed, and the track
 * between them filled up to where the work has reached. It is what makes
 * a run of separate cards read as one story.
 */
function crewRailLayers(
  blockId: string,
  ctx: SceneBlockContext,
  crew: CrewModel,
  active: ReadonlySet<string>,
): Layer[] {
  const members = crew.members;
  if (members.length < 2) return [];
  const xs = spread(members.length, 9.5, 66);
  const y = STAGE.railY;
  const reached = members.reduce(
    (last, member, index) => (active.has(member.id) ? index : last),
    -1,
  );
  const layers: Layer[] = [
    bar(`${blockId}-rail-track`, xs[0]!, xs[xs.length - 1]!, y, MOVIE_PALETTE.chip),
  ];
  if (reached > 0)
    layers.push(bar(`${blockId}-rail-done`, xs[0]!, xs[reached]!, y, MOVIE_PALETTE.accent));
  for (const [index, member] of members.entries()) {
    const on = active.has(member.id);
    const x = `${round2(xs[index]!)}%`;
    layers.push({
      type: 'shape',
      id: `${blockId}-rail-${index}-ring`,
      content: {
        shape: 'circle',
        fill: MOVIE_PALETTE.bgBottom,
        stroke: on ? MOVIE_PALETTE.accent : MOVIE_PALETTE.chip,
        strokeWidth: on ? 3 : 1.5,
      },
      position: { x, y: `${y}%`, width: '4.2%', height: '7.47%', anchor: 'center' },
    });
    layers.push(
      ...avatarLayers(
        `${blockId}-rail-${index}`,
        ctx,
        member.actor,
        member.name,
        { x, y: `${y}%` },
        {
          width: 3.4,
          dim: !on,
        },
      ),
      text(`${blockId}-rail-${index}-label`, member.name, {
        x,
        y: `${y + 5.4}%`,
        anchor: 'center',
        fontSize: 20,
        color: on ? MOVIE_PALETTE.text : MOVIE_PALETTE.textMuted,
        bold: on,
        align: 'center',
      }),
    );
  }
  return layers;
}

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

/**
 * The cast card after the cover: who is on the job, what each one does,
 * and who hands the work to whom. Members join left to right in the
 * order they first act; a hand-off between neighbours is a straight
 * arrow, one that skips a member arcs over the row.
 */
export function castBlock(
  crew: CrewModel,
  ctx: Pick<
    SceneBlockContext,
    'availableMedia' | 'actors' | 'fonts' | 'profile' | 'showTimestamps' | 'runStartedAtMs'
  >,
  timing: { startTime: number; duration: number },
): Block {
  const id = 'scene-cast';
  const members = crew.members;
  const gezels = members.filter((member) => member.id !== 'user').length;
  const xs = spread(members.length, 16, 80);
  const y = 50;
  const avatarWidth = members.length > 5 ? 6.2 : 7.2;
  const half = avatarWidth / 2 + 0.8;
  const top = y - (avatarWidth * 16) / 9 / 2;
  const delayOf = (index: number) => round2(0.3 + index * 0.3);
  const fullCtx: SceneBlockContext = { ...ctx, crew };
  const layers: Layer[] = [
    backgroundLayers(id),
    text(`${id}-kicker`, 'THE CREW', {
      x: '50%',
      y: '17%',
      anchor: 'center',
      fontSize: 26,
      color: MOVIE_PALETTE.accent,
      bold: true,
      align: 'center',
    }),
    text(
      `${id}-title`,
      `${COUNT_WORDS[gezels] ?? String(gezels)} crew ${gezels === 1 ? 'member' : 'members'}, one job`,
      {
        x: '50%',
        y: '26%',
        anchor: 'center',
        fontSize: 60,
        color: MOVIE_PALETTE.text,
        bold: true,
        align: 'center',
      },
    ),
  ];
  let arcs = 0;
  for (const [index, member] of members.entries()) {
    const x = xs[index]!;
    const from = member.fromId ? members.findIndex((other) => other.id === member.fromId) : -1;
    if (from >= 0 && from === index - 1) {
      layers.push(
        bar(`${id}-edge-${index}`, xs[from]! + half, x - half, y, MOVIE_PALETTE.accent, 0.4, {
          delay: delayOf(index) - 0.2,
        }),
        text(`${id}-edge-${index}-head`, '▶', {
          x: `${round2(x - half)}%`,
          y: `${y}%`,
          anchor: 'center',
          fontSize: 20,
          color: MOVIE_PALETTE.accent,
          align: 'center',
          animation: { type: 'fadeIn', duration: 0.4, delay: delayOf(index) - 0.2 },
        }),
      );
    } else if (from >= 0) {
      const arcY = top - 4 - arcs * 2.2;
      arcs += 1;
      const delay = { delay: delayOf(index) - 0.2 };
      layers.push(
        vbar(`${id}-arc-${index}-up`, xs[from]!, arcY, top - 0.6, delay),
        bar(`${id}-arc-${index}-over`, xs[from]!, x, arcY, MOVIE_PALETTE.accent, 0.4, delay),
        vbar(`${id}-arc-${index}-down`, x, arcY, top - 1.6, delay),
        text(`${id}-arc-${index}-head`, '▼', {
          x: `${round2(x)}%`,
          y: `${round2(top - 1.4)}%`,
          anchor: 'center',
          fontSize: 18,
          color: MOVIE_PALETTE.accent,
          align: 'center',
          animation: { type: 'fadeIn', duration: 0.4, delay: delay.delay },
        }),
      );
    }
    const job =
      member.id === 'user'
        ? 'asks for the work'
        : member.steps.length > 0
          ? member.steps.slice(0, 2).join('\n')
          : '';
    layers.push(
      ...avatarLayers(
        `${id}-m${index}`,
        fullCtx,
        member.actor,
        member.name,
        { x: `${round2(x)}%`, y: `${y}%` },
        {
          width: avatarWidth,
          delay: delayOf(index),
        },
      ),
      text(`${id}-m${index}-name`, member.name, {
        x: `${round2(x)}%`,
        y: '62%',
        anchor: 'center',
        fontSize: 30,
        color: MOVIE_PALETTE.text,
        bold: true,
        align: 'center',
        animation: { type: 'fadeIn', duration: 0.5, delay: delayOf(index) },
      }),
    );
    if (member.role) {
      layers.push(
        text(`${id}-m${index}-role`, member.role, {
          x: `${round2(x)}%`,
          y: '66.5%',
          anchor: 'center',
          fontSize: 22,
          color: MOVIE_PALETTE.textMuted,
          align: 'center',
          animation: { type: 'fadeIn', duration: 0.5, delay: delayOf(index) },
        }),
      );
    }
    if (job) {
      layers.push(
        text(`${id}-m${index}-job`, job, {
          x: `${round2(x)}%`,
          y: '70%',
          width: `${round2(Math.min(16, 80 / Math.max(1, members.length - 1)) - 1)}%`,
          anchor: 'top-left',
          fontSize: 21,
          color: MOVIE_PALETTE.accent,
          align: 'center',
          maxLines: 3,
          animation: { type: 'fadeIn', duration: 0.5, delay: delayOf(index) + 0.15 },
        }),
      );
    }
  }
  // The job lines are anchored top-left for wrapping; centre them on x.
  for (const layer of layers) {
    if (layer.id.endsWith('-job') && layer.position.width) {
      const width = Number.parseFloat(String(layer.position.width));
      layer.position.x = `${round2(Number.parseFloat(String(layer.position.x)) - width / 2)}%`;
    }
  }
  return {
    id,
    startTime: round2(timing.startTime),
    duration: round2(timing.duration),
    audioSegment: 0,
    layers: applyThemeFonts(layers, ctx.fonts),
    transition: { type: 'fade', duration: 0.6 },
  };
}

function vbar(
  id: string,
  x: number,
  fromY: number,
  toY: number,
  animation: { delay: number },
): Layer {
  return {
    type: 'shape',
    id,
    content: { shape: 'rect', fill: MOVIE_PALETTE.accent, borderRadius: 2 },
    position: {
      x: `${round2(x - 0.11)}%`,
      y: `${round2(Math.min(fromY, toY))}%`,
      width: '0.22%',
      height: `${round2(Math.abs(toY - fromY))}%`,
      anchor: 'top-left',
    },
    animation: { type: 'fadeIn', duration: 0.4, delay: animation.delay },
  };
}

/**
 * A step card: which step of how many, what it is, who takes it, and the
 * whole plan underneath with this step lit, the earlier ones done.
 */
function stepCardLayers(
  blockId: string,
  ctx: SceneBlockContext,
  crew: CrewModel,
  scene: RunRecordingScene & { kind: 'step-transition' },
): Layer[] {
  const plan = crew.plan;
  const at = plan.findIndex((step) => step.stepId === scene.stepId);
  const step = plan[at];
  const ownerId = scene.actorId ?? step?.ownerId;
  const owner = ownerId ? ctx.actors.get(ownerId) : undefined;
  const done = scene.phase === 'completed';
  const layers: Layer[] = [
    text(
      `${blockId}-kicker`,
      at >= 0 && plan.length > 1 ? `STEP ${at + 1} OF ${plan.length}` : 'STEP',
      {
        x: '50%',
        y: '18%',
        anchor: 'center',
        fontSize: 26,
        color: MOVIE_PALETTE.accent,
        bold: true,
        align: 'center',
      },
    ),
    text(`${blockId}-title`, scene.stepName ?? step?.name ?? scene.stepId, {
      x: '50%',
      y: '27%',
      width: '80%',
      anchor: 'center',
      fontSize: 68,
      color: MOVIE_PALETTE.text,
      bold: true,
      align: 'center',
      animation: { type: 'fadeInUp', duration: 0.5, delay: 0.1 },
    }),
  ];
  if (owner) {
    layers.push(
      ...avatarLayers(
        blockId,
        ctx,
        owner,
        owner.name,
        { x: '50%', y: '42%' },
        { width: 5.4, delay: 0.3 },
      ),
      text(
        `${blockId}-owner`,
        `${credit(owner, owner.name)}  ${done ? '· done' : 'takes it from here'}`,
        {
          x: '50%',
          y: '51.5%',
          anchor: 'center',
          fontSize: 28,
          color: done ? MOVIE_PALETTE.success : MOVIE_PALETTE.textMuted,
          bold: true,
          align: 'center',
          animation: { type: 'fadeIn', duration: 0.5, delay: 0.45 },
        },
      ),
    );
  }
  if (plan.length > 1) {
    const xs = spread(plan.length, 15, 72);
    const labelWidth = round2(Math.min(14, xs[1]! - xs[0]! - 0.8));
    const y = 61;
    layers.push(
      bar(`${blockId}-plan-track`, xs[0]!, xs[xs.length - 1]!, y, MOVIE_PALETTE.chip, 0.3),
    );
    const lit = done ? at : at - 1;
    if (lit > 0)
      layers.push(bar(`${blockId}-plan-done`, xs[0]!, xs[lit]!, y, MOVIE_PALETTE.success, 0.3));
    for (const [index, planStep] of plan.entries()) {
      const isDone = index < at || (index === at && done);
      const isHere = index === at;
      const size = isHere ? 1.7 : 1.15;
      layers.push(
        {
          type: 'shape',
          id: `${blockId}-plan-${index}-dot`,
          content: {
            shape: 'circle',
            fill: isDone
              ? MOVIE_PALETTE.success
              : isHere
                ? MOVIE_PALETTE.accent
                : MOVIE_PALETTE.bgBottom,
            stroke: isDone
              ? MOVIE_PALETTE.success
              : isHere
                ? MOVIE_PALETTE.accent
                : MOVIE_PALETTE.chip,
            strokeWidth: 2,
          },
          position: {
            x: `${round2(xs[index]!)}%`,
            y: `${y}%`,
            width: `${size}%`,
            height: `${round2((size * 16) / 9)}%`,
            anchor: 'center',
          },
          ...(isHere ? { animation: { type: 'zoomIn' as const, duration: 0.5, delay: 0.5 } } : {}),
        },
        text(`${blockId}-plan-${index}-label`, planStep.name, {
          x: `${round2(xs[index]! - labelWidth / 2)}%`,
          y: `${y + 2.6}%`,
          width: `${labelWidth}%`,
          anchor: 'top-left',
          fontSize: 20,
          color: isHere ? MOVIE_PALETTE.text : MOVIE_PALETTE.textMuted,
          bold: isHere,
          align: 'center',
          maxLines: 2,
        }),
      );
    }
  }
  return layers;
}

function text(
  id: string,
  content: string,
  opts: {
    x: string;
    y: string;
    width?: string;
    height?: string;
    anchor?: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    fontSize: number;
    color: string;
    bold?: boolean;
    italic?: boolean | undefined;
    align?: 'left' | 'center' | 'right';
    maxLines?: number;
    animation?: { type: 'fadeIn' | 'fadeInUp' | 'typewriter'; duration: number; delay?: number };
  },
): TextLayer {
  return {
    type: 'text',
    id,
    content: {
      text: content,
      style: {
        fontSize: opts.fontSize,
        color: opts.color,
        ...(opts.bold ? { fontWeight: 'bold' } : {}),
        ...(opts.italic ? { fontStyle: 'italic' } : {}),
        textAlign: opts.align ?? 'left',
        ...(opts.maxLines ? { maxLines: opts.maxLines } : {}),
        lineHeight: 1.35,
      },
    },
    position: {
      x: opts.x,
      y: opts.y,
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
      anchor: opts.anchor ?? 'top-left',
    },
    ...(opts.animation ? { animation: opts.animation } : {}),
  };
}

function formatElapsed(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
