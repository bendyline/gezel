import type { RunRecording, RunRecordingActor, RunRecordingScene } from '@bendyline/gezel';
import type { Block, Layer, TextLayer } from '@bendyline/squisq/schemas';
import { hasPoppetjeMedia, poppetjeMediaPath } from '../media.js';
import { humanToolName } from './narration.js';
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
}

/** Design basis the percent coordinates are laid out against. */
const BASIS = { width: 1920, height: 1080 } as const;
const LINE_HEIGHT = 1.35;

/**
 * How tall a text box must be for `body` at `fontSize` wrapped into
 * `widthPct` of the frame — the same average-glyph-width estimate
 * squisq's own templates size their captions with. Bubbles are sized
 * from this so long excerpts never run past their background.
 */
function fitText(
  body: string,
  fontSize: number,
  widthPct: number,
  maxLines: number,
): { lines: number; heightPct: number } {
  const widthPx = (widthPct / 100) * BASIS.width;
  const charsPerLine = Math.max(8, Math.floor(widthPx / (fontSize * 0.52)));
  let lines = 0;
  for (const paragraph of body.split('\n')) {
    lines += Math.max(1, Math.ceil(paragraph.length / charsPerLine));
  }
  lines = Math.min(maxLines, lines);
  return { lines, heightPct: ((lines * fontSize * LINE_HEIGHT) / BASIS.height) * 100 };
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
  switch (scene.kind) {
    case 'user-prompt':
      layers.push(
        ...bubbleLayers(id, ctx, {
          actor: ctx.actors.get(scene.actorId ?? 'user'),
          fallbackName: 'You',
          text: scene.excerpt ?? '…',
          fill: MOVIE_PALETTE.bubbleUser,
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
        }),
      );
      break;
    case 'tool-call':
      layers.push(...toolLayers(id, ctx, scene));
      break;
    case 'delegation':
      layers.push(...delegationLayers(id, ctx, scene));
      break;
    case 'step-transition':
      layers.push(...stepLayers(id, scene));
      break;
    case 'gate-verdict':
      layers.push(...gateLayers(id, scene));
      break;
    case 'artifact-produced':
      layers.push(...artifactLayers(id, scene));
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
): Block {
  const id = 'scene-outro';
  const layers: Layer[] = [backgroundLayers(id)];
  if (profile === 'marketing') {
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
}

function bubbleLayers(blockId: string, ctx: SceneBlockContext, opts: BubbleOpts): Layer[] {
  const name = opts.actor?.name ?? opts.fallbackName;
  const layers: Layer[] = [
    ...avatarLayers(blockId, ctx, opts.actor, name, { x: '12%', y: '30%' }),
    text(`${blockId}-name`, credit(opts.actor, name) + (opts.label ? `  ·  ${opts.label}` : ''), {
      x: '21%',
      y: '22%',
      anchor: 'top-left',
      fontSize: 26,
      color: MOVIE_PALETTE.textMuted,
      bold: true,
    }),
    ...sizedBubble(blockId, opts.text, {
      top: 27,
      left: 21,
      width: 62,
      fill: opts.fill,
      fontSize: 32,
      maxLines: 7,
      italic: opts.italic,
      align: 'left',
      typewriter: Math.min(2.5, 0.4 + opts.text.length / 120),
    }),
  ];
  return layers;
}

function toolLayers(
  blockId: string,
  ctx: SceneBlockContext,
  scene: RunRecordingScene & { kind: 'tool-call' },
): Layer[] {
  const actor = ctx.actors.get(scene.actorId ?? '');
  const name = actor?.name ?? 'Gezel';
  const chipText =
    humanToolName(scene.name) +
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
): Layer[] {
  const from = ctx.actors.get(scene.actorId ?? '');
  const to = ctx.actors.get(scene.toActorId);
  const fromName = from?.name ?? 'Gezel';
  const toName = to?.name ?? scene.toActorId;
  return [
    ...avatarLayers(`${blockId}-from`, ctx, from, fromName, { x: '26%', y: '26%' }),
    ...avatarLayers(`${blockId}-to`, ctx, to, toName, { x: '74%', y: '26%' }),
    text(`${blockId}-from-name`, credit(from, fromName), {
      x: '26%',
      y: '40%',
      anchor: 'center',
      fontSize: 28,
      color: MOVIE_PALETTE.textMuted,
      bold: true,
      align: 'center',
    }),
    text(`${blockId}-to-name`, credit(to, toName), {
      x: '74%',
      y: '40%',
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
      position: { x: '50%', y: '28%', width: '30%', height: '1%', anchor: 'center' },
      animation: { type: 'fadeIn', duration: 0.5 },
    } as Layer,
    text(`${blockId}-verb`, scene.delegationKind === 'consultation' ? 'asks' : 'hands off', {
      x: '50%',
      y: '22%',
      anchor: 'center',
      fontSize: 24,
      color: MOVIE_PALETTE.accent,
      align: 'center',
    }),
    ...(scene.excerpt
      ? sizedBubble(blockId, scene.excerpt, {
          top: 50,
          left: 17,
          width: 66,
          fill: MOVIE_PALETTE.bubble,
          fontSize: 32,
          maxLines: 5,
          align: 'center',
          typewriter: 2,
          delay: 0.4,
        })
      : []),
  ];
}

/**
 * A speech bubble whose height follows its text: background rect plus
 * top-left-anchored text with a fixed inset. Percent geometry on the
 * design basis; `top`/`left`/`width` describe the bubble.
 */
function sizedBubble(
  blockId: string,
  body: string,
  opts: {
    top: number;
    left: number;
    width: number;
    fill: string;
    fontSize: number;
    maxLines: number;
    italic?: boolean;
    align: 'left' | 'center';
    typewriter: number;
    delay?: number;
  },
): Layer[] {
  const insetX = 2.5;
  const insetY = 2.6;
  const textWidth = opts.width - insetX * 2;
  const fit = fitText(body, opts.fontSize, textWidth, opts.maxLines);
  const bubbleHeight = fit.heightPct + insetY * 2;
  return [
    {
      type: 'shape',
      id: `${blockId}-bubble`,
      content: { shape: 'rect', fill: opts.fill, borderRadius: 18 },
      position: {
        x: `${opts.left}%`,
        y: `${opts.top}%`,
        width: `${opts.width}%`,
        height: `${round2(bubbleHeight)}%`,
        anchor: 'top-left',
      },
      animation: { type: 'fadeIn', duration: 0.4, ...(opts.delay ? { delay: opts.delay } : {}) },
    },
    text(`${blockId}-text`, body, {
      x: `${opts.left + insetX}%`,
      y: `${opts.top + insetY}%`,
      width: `${textWidth}%`,
      height: `${round2(fit.heightPct)}%`,
      anchor: 'top-left',
      fontSize: opts.fontSize,
      color: MOVIE_PALETTE.text,
      italic: opts.italic,
      align: opts.align,
      maxLines: opts.maxLines,
      animation: {
        type: 'typewriter',
        duration: opts.typewriter,
        ...(opts.delay ? { delay: opts.delay } : {}),
      },
    }),
  ];
}

function stepLayers(
  blockId: string,
  scene: RunRecordingScene & { kind: 'step-transition' },
): Layer[] {
  const title = scene.stepName ?? scene.stepId;
  const phaseLabel =
    scene.phase === 'activated' ? 'begins' : scene.phase === 'completed' ? 'complete' : scene.phase;
  return [
    text(`${blockId}-kicker`, scene.taskRef ? `task ${scene.taskRef}` : 'craftbook step', {
      x: '50%',
      y: '38%',
      anchor: 'center',
      fontSize: 26,
      color: MOVIE_PALETTE.accent,
      align: 'center',
    }),
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

function gateLayers(blockId: string, scene: RunRecordingScene & { kind: 'gate-verdict' }): Layer[] {
  const pass = scene.verdict === 'pass';
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
): Layer[] {
  const caption = `${scene.path}${scene.bytes ? `  ·  ${formatBytes(scene.bytes)}` : ''}${
    scene.count && scene.count > 1 ? `  ·  ${scene.count} revisions` : ''
  }`;
  if (scene.screenshotRef) {
    return [
      {
        type: 'image',
        id: `${blockId}-shot`,
        content: { src: scene.screenshotRef, alt: scene.path, fit: 'contain' },
        position: { x: '50%', y: '46%', width: '78%', height: '70%', anchor: 'center' },
        animation: { type: 'zoomIn', duration: 0.8 },
      },
      text(`${blockId}-caption`, caption, {
        x: '50%',
        y: '88%',
        anchor: 'center',
        fontSize: 28,
        color: MOVIE_PALETTE.textMuted,
        align: 'center',
      }),
    ];
  }
  return [
    text(`${blockId}-icon`, '📄', {
      x: '50%',
      y: '42%',
      anchor: 'center',
      fontSize: 120,
      color: MOVIE_PALETTE.text,
      align: 'center',
    }),
    text(`${blockId}-caption`, caption, {
      x: '50%',
      y: '60%',
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
): Layer[] {
  const size = '9%';
  if (actor && hasPoppetjeMedia(actor, ctx.availableMedia)) {
    return [
      {
        type: 'image',
        id: `${idPrefix}-avatar`,
        content: { src: poppetjeMediaPath(actor.id), alt: name, fit: 'contain' },
        position: { x: center.x, y: center.y, width: size, height: '16%', anchor: 'center' },
      },
    ];
  }
  // Initials fallback: circle + letters. The poppetje STRUCT still rides
  // in actors[] — React surfaces render the real figure from it.
  const initials = name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return [
    {
      type: 'shape',
      id: `${idPrefix}-avatar-bg`,
      content: {
        shape: 'circle',
        fill: actor?.kind === 'user' ? MOVIE_PALETTE.bubbleUser : MOVIE_PALETTE.chip,
        stroke: MOVIE_PALETTE.accent,
        strokeWidth: 2,
      },
      position: { x: center.x, y: center.y, width: size, height: '16%', anchor: 'center' },
    },
    text(`${idPrefix}-avatar-initials`, initials || '?', {
      x: center.x,
      y: center.y,
      anchor: 'center',
      fontSize: 44,
      color: MOVIE_PALETTE.text,
      bold: true,
      align: 'center',
    }),
  ];
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
    italic?: boolean;
    align?: 'left' | 'center' | 'right';
    maxLines?: number;
    animation?: { type: 'fadeIn' | 'typewriter'; duration: number; delay?: number };
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
