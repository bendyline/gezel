import {
  GRAIN_PRESETS,
  type GrainStyle,
  type Poppetje as PoppetjeStruct,
  seedFromKey,
} from '@bendyline/gezel';
import { type JSX, useId } from 'react';
import { feltForSkin, mixHex } from './color.js';
import { archFor, buildBodyPath, resolveLayout, scaleFor, whorlRing } from './geometry.js';
import { type ItemCtx, renderAccessory, renderDress, renderHatCrown, renderHood } from './items.js';

/**
 * Variant decides the SVG `viewBox` crop — same content tree, three
 * framings. Small surfaces (sidebar, chat) want the head-only `icon`
 * variant; the gezel-detail hero wants `full`; pickers and project
 * chips look best as `headshot` (head + shoulders).
 */
export type PoppetjeVariant = 'full' | 'headshot' | 'icon';

interface PoppetjeProps {
  poppetje: PoppetjeStruct;
  variant?: PoppetjeVariant;
  /** Pixel dimension of the rendered SVG's longest axis. */
  size?: number;
  /** Wood-grain treatment — default `wavy`. Use `none` to skip the filter (perf). */
  grainStyle?: GrainStyle;
  /** Override the whorl count from the seed default (`grainSeed % 4 === 0` → 1, else 0). */
  whorls?: number;
  title?: string;
  className?: string;
  /** Skip the ground shadow + base disc. Useful inside tight icon crops. */
  withShadow?: boolean;
  withBase?: boolean;
  /**
   * Explicit id namespace for this figure's SVG defs (gradients, filters,
   * clips). `useId` restarts per `renderToStaticMarkup` call, so statically
   * rendering many figures into one document makes every figure resolve
   * `url(#…)` to the FIRST figure's defs — every body slate, every head the
   * same skin. Pass a document-unique value in static/SSR contexts; inside
   * a single React root the default `useId` is already unique.
   */
  svgId?: string;
}

const W = 80;
const H = 175;

type GrainCharacter = 'fine' | 'flowing' | 'cathedral' | 'knotty';

interface GrainCharacterProfile {
  fiberFrequency: number;
  waveFrequency: number;
  displacement: number;
  opacity: number;
  soften: number;
}

const GRAIN_CHARACTER_PROFILES: Record<GrainCharacter, GrainCharacterProfile> = {
  fine: {
    fiberFrequency: 1.42,
    waveFrequency: 1.18,
    displacement: 0.42,
    opacity: 1.08,
    soften: 0.78,
  },
  flowing: {
    fiberFrequency: 0.68,
    waveFrequency: 0.72,
    displacement: 1.85,
    opacity: 1.2,
    soften: 1.08,
  },
  cathedral: {
    fiberFrequency: 0.86,
    waveFrequency: 0.62,
    displacement: 1.28,
    opacity: 1.06,
    soften: 0.96,
  },
  knotty: {
    fiberFrequency: 1.02,
    waveFrequency: 0.9,
    displacement: 1.05,
    opacity: 1.08,
    soften: 0.9,
  },
};

/** Exactly one quarter of stable keys are knotty; the rest rotate evenly. */
function grainCharacterFor(seed: number): GrainCharacter {
  if (seed % 4 === 0) return 'knotty';
  return (['fine', 'flowing', 'cathedral'] as const)[Math.floor(seed / 4) % 3]!;
}

/**
 * Parametric carved-figure renderer. Adapted from the reference engine
 * in `poppetjes-handoff/engine.jsx`. Same `key` always produces the
 * same wood-grain pattern across every render and every variant — the
 * grain seed is djb2-hashed from the key string. The same hash also
 * drives the per-individual micro-variation (eye spacing, mouth width,
 * hat felt color), so two gezels with identical catalog slots still
 * don't share a face.
 */
export function Poppetje({
  poppetje: g,
  variant = 'full',
  size = 120,
  grainStyle = 'wavy',
  whorls,
  title,
  className,
  withShadow,
  withBase,
  svgId,
}: PoppetjeProps): JSX.Element {
  const reactId = useId();
  const uid = (svgId ?? reactId).replace(/[^a-zA-Z0-9_-]/g, '');
  const id = `pop${uid}`;

  const arch = archFor(g.bodyShape);
  const scale = scaleFor(g.figureScale);
  const L = resolveLayout(scale);
  const bodyPath = buildBodyPath(arch, L);

  const grainSeed = seedFromKey(g.key);
  const preset = GRAIN_PRESETS[grainStyle] ?? GRAIN_PRESETS.wavy!;
  const grainCharacter = grainCharacterFor(grainSeed);
  const grainProfile = GRAIN_CHARACTER_PROFILES[grainCharacter];
  // A preset describes the broad finish; the gezel key supplies the smaller
  // variations found from one turned piece of wood to the next. Keep these
  // differences deterministic so rerolls never change an established figure.
  const [presetStreakX = 0.12, presetStreakY = 0.016] = (preset.streakFreq ?? '0.12 0.016')
    .split(' ')
    .map(Number);
  const fiberWidthVariation = 0.86 + (grainSeed % 9) * 0.035;
  const waveVariation = 0.9 + (grainSeed % 7) * 0.033;
  const opacityVariation = 0.9 + (grainSeed % 9) * 0.025;
  const softenVariation = 0.9 + (Math.floor(grainSeed / 2) % 7) * 0.03;
  const displacementVariation = 0.86 + (Math.floor(grainSeed / 3) % 8) * 0.04;
  const grainWaveFrequency = `${(0.022 * waveVariation * grainProfile.waveFrequency).toFixed(
    4,
  )} ${(0.014 / waveVariation).toFixed(4)}`;
  const grainStreakFrequency = `${(
    presetStreakX * fiberWidthVariation * grainProfile.fiberFrequency
  ).toFixed(4)} ${(presetStreakY / fiberWidthVariation).toFixed(4)}`;
  const grainOpacity = (preset.opacity ?? 0.12) * opacityVariation * grainProfile.opacity;
  const grainSoften = (preset.soften ?? 0.35) * softenVariation * grainProfile.soften;
  const grainDisplacement =
    (preset.dispScale ?? 0) * displacementVariation * grainProfile.displacement;
  // Texture below ~36px cannot resolve as grain; it only muddies the face
  // and makes every tiny sidebar avatar instantiate two expensive filters.
  // Keep the modeled light/volume, but use a clean paint surface at that LOD.
  const applyGrain = !preset.skip && (variant !== 'icon' || size >= 36);
  const grainAttr = applyGrain ? { filter: `url(#${id}-wood)` } : {};
  const grainAttrSoft = applyGrain ? { filter: `url(#${id}-woodsoft)` } : {};
  const whorlCount =
    whorls === undefined
      ? grainCharacter === 'knotty'
        ? grainSeed % 8 === 0
          ? 2
          : 1
        : 0
      : Math.max(0, Math.floor(whorls));
  const whorlOpacity = Math.min(0.38, 0.17 + grainOpacity * 0.58);
  // Explicit cathedral contours supplement the stronger filter texture, but
  // stay translucent enough to avoid reading as a leaf-shaped shirt graphic.
  const cathedralOpacity = Math.min(0.12, 0.035 + grainOpacity * 0.24);

  const hat = g.hat ?? null;
  const dress = g.dress ?? null;
  const accessory = g.accessory ?? null;
  const facialHair = g.facialHair ?? null;
  const mark = g.mark ?? null;
  const expression = g.expression ?? 'smile';
  const pattern = g.shirtPattern ?? 'plain';
  const showHair = !hat;

  const { skin, skin2, shirt, shirtAccent } = g;

  // Material colors are derived at render time, not persisted. The stored
  // palette remains the gezel's identity; these tints and shades describe how
  // that paint reacts to one consistent, warm studio light. Asymmetric light
  // is the strongest cue that the simple SVG silhouettes are turned objects
  // rather than flat badges.
  const bodyLight = mixHex(shirt, '#fff2d4', 0.14);
  const bodyMid = mixHex(shirt, shirtAccent, 0.08);
  const bodyShadow = mixHex(shirtAccent, '#24160d', 0.22);
  const bodyRim = mixHex(shirtAccent, '#120c08', 0.34);
  const skinLight = mixHex(skin, '#fff1d8', 0.2);
  const skinMid = mixHex(skin, skin2, 0.1);
  const skinShadow = mixHex(skin2, '#2b190f', 0.18);
  const skinRim = mixHex(skin2, '#130d09', 0.32);
  const hairLight = mixHex(g.hair, '#f0cf9b', 0.1);
  const hairShadow = mixHex(g.hair, '#090705', 0.32);

  // Hat felt — cloth hats get their own material color instead of the
  // shirt accent (which camouflaged them into the body). Derived from the
  // stable key hash + hat name, so the color never flickers but different
  // hats on the same gezel don't all match. Skin-aware: a felt too close
  // to the wearer's skin (brick cap, warm-deep head) would read as a bald
  // crown, so those felts are skipped for that wearer.
  const felt = feltForSkin(grainSeed + (hat ? hat.length * 7 : 0), skin, skin2);
  const scarfFelt = feltForSkin(grainSeed + 23, skin, skin2);
  const feltLight = mixHex(felt.felt, '#fff0cf', 0.18);
  const feltShadow = mixHex(felt.felt, '#17100b', 0.3);
  const feltBandLight = mixHex(felt.band, '#f3d39e', 0.12);
  const feltBandShadow = mixHex(felt.band, '#120c08', 0.34);
  const scarfLight = mixHex(scarfFelt.felt, '#fff0cf', 0.16);
  const scarfShadow = mixHex(scarfFelt.felt, '#17100b', 0.28);
  const scarfBandLight = mixHex(scarfFelt.band, '#f3d39e', 0.1);
  const scarfBandShadow = mixHex(scarfFelt.band, '#120c08', 0.32);

  // Per-individual face geometry, stable per gezel (derived from the key
  // hash, which survives rerolls). Keeps every face inside the Bruna
  // dot-eyes style while making sure no two crew members share the exact
  // same face — the catalogs alone made everyone's eyes identical twins.
  const fv = {
    eyeGap: 7.4 + (grainSeed % 5) * 0.4, // 7.4 … 9.0
    eyeY: 1.2 + (Math.floor(grainSeed / 2) % 4) * 0.5, // 1.2 … 2.7
    eyeR: 1.55 + (Math.floor(grainSeed / 4) % 4) * 0.1, // 1.55 … 1.85
    mouthDY: (Math.floor(grainSeed / 8) % 3) - 1, // -1 … 1
    mouthW: 0.92 + (Math.floor(grainSeed / 16) % 3) * 0.09, // 0.92 … 1.10
    blush: 0.12 + (Math.floor(grainSeed / 2) % 3) * 0.04,
  };
  const mY = 10 + fv.mouthDY;

  // Shared drawing context for the worn-item renderers (also used by the
  // standalone accessory-picker tiles, so the art has one source of truth).
  const itemCtx: ItemCtx = {
    fv,
    L,
    arch,
    felt,
    scarfFelt,
    shirt,
    shirtAccent,
    feltFill: `url(#${id}-felt)`,
    feltBandFill: `url(#${id}-felt-band)`,
    scarfFill: `url(#${id}-scarf)`,
    scarfBandFill: `url(#${id}-scarf-band)`,
    shirtFill: `url(#${id}-body)`,
    shirtAccentFill: `url(#${id}-accent)`,
    hasHat: !!hat,
  };

  // Variant decides the viewBox crop only — content tree is identical.
  // Sizes: icon crops to the head ellipse; headshot includes shoulders;
  // full is the entire 80×175 viewBox. The withShadow/withBase defaults
  // also key off the variant — they look wrong on tight head crops.
  const headTop = L.headCY - L.headR;
  const headSize = L.headR * 2;
  const shoulderSpan = (L.baseY - L.shoulderY) * 0.35;
  // Hats are drawn inside the scaled head group and reach past the head
  // ellipse — the straw brim is the widest (29 units) and the beanie pompom
  // the tallest (35.3). A head-and-shoulders crop budgeted for the head alone
  // shears them off the moment a frame clips this overflow:visible SVG, so the
  // headshot makes room for whatever the figure is wearing.
  const headUnit = L.headR / 22;
  const hatHalfW = hat ? 30 * headUnit : 0;
  const hatTopReach = hat ? 36 * headUnit : 0;
  const headshotHalfW = Math.max(26, L.headR + 4, hatHalfW + 1);
  const headshotTop = L.headCY - Math.max(L.headR, hatTopReach) - 4;
  const headshotBottom = headTop + headSize + 4 + shoulderSpan;
  const viewBox =
    variant === 'icon'
      ? `${40 - L.headR - 4} ${headTop - 4} ${headSize + 8} ${headSize + 8}`
      : variant === 'headshot'
        ? `${40 - headshotHalfW} ${headshotTop} ${headshotHalfW * 2} ${headshotBottom - headshotTop}`
        : `0 0 ${W} ${H}`;

  const vbDims = viewBox.split(' ').map(Number);
  const vbW = vbDims[2] ?? W;
  const vbH = vbDims[3] ?? H;
  const ratio = vbH / vbW;
  const renderW = size;
  const renderH = size * ratio;

  const showShadow = withShadow ?? variant === 'full';
  const showBase = withBase ?? variant === 'full';

  return (
    <svg
      width={renderW}
      height={renderH}
      viewBox={viewBox}
      style={{ display: 'block', overflow: 'visible' }}
      role={title ? 'img' : undefined}
      aria-label={title}
      className={className}
      data-grain-character={applyGrain ? grainCharacter : undefined}
      data-whorl-count={applyGrain ? whorlCount : undefined}
    >
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={bodyRim} />
          <stop offset="0.08" stopColor={bodyShadow} />
          <stop offset="0.28" stopColor={bodyMid} />
          <stop offset="0.43" stopColor={bodyLight} />
          <stop offset="0.58" stopColor={shirt} />
          <stop offset="0.82" stopColor={bodyMid} />
          <stop offset="0.94" stopColor={bodyShadow} />
          <stop offset="1" stopColor={bodyRim} />
        </linearGradient>
        <linearGradient id={`${id}-body-depth`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff1d2" stopOpacity="0.12" />
          <stop offset="0.16" stopColor="#fff1d2" stopOpacity="0.035" />
          <stop offset="0.62" stopColor="#2b180d" stopOpacity="0" />
          <stop offset="0.88" stopColor="#2b180d" stopOpacity="0.08" />
          <stop offset="1" stopColor="#160e09" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id={`${id}-body-glaze`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff7e8" stopOpacity="0" />
          <stop offset="0.24" stopColor="#fff7e8" stopOpacity="0.025" />
          <stop offset="0.37" stopColor="#fff7e8" stopOpacity="0.07" />
          <stop offset="0.49" stopColor="#fff7e8" stopOpacity="0.025" />
          <stop offset="0.7" stopColor="#fff7e8" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-head`} cx="0.31" cy="0.22" r="0.8" fx="0.27" fy="0.18">
          <stop offset="0" stopColor={skinLight} />
          <stop offset="0.3" stopColor={skinMid} />
          <stop offset="0.66" stopColor={skin} />
          <stop offset="0.88" stopColor={skinShadow} />
          <stop offset="1" stopColor={skinRim} />
        </radialGradient>
        <radialGradient id={`${id}-hair`} cx="0.32" cy="0.18" r="0.86" fx="0.27" fy="0.13">
          <stop offset="0" stopColor={hairLight} />
          <stop offset="0.42" stopColor={g.hair} />
          <stop offset="1" stopColor={hairShadow} />
        </radialGradient>
        <linearGradient id={`${id}-felt`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={feltShadow} />
          <stop offset="0.32" stopColor={felt.felt} />
          <stop offset="0.46" stopColor={feltLight} />
          <stop offset="0.72" stopColor={felt.felt} />
          <stop offset="1" stopColor={feltShadow} />
        </linearGradient>
        <linearGradient id={`${id}-felt-band`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={feltBandShadow} />
          <stop offset="0.42" stopColor={feltBandLight} />
          <stop offset="1" stopColor={feltBandShadow} />
        </linearGradient>
        <linearGradient id={`${id}-scarf`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={scarfShadow} />
          <stop offset="0.42" stopColor={scarfLight} />
          <stop offset="1" stopColor={scarfShadow} />
        </linearGradient>
        <linearGradient id={`${id}-scarf-band`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={scarfBandShadow} />
          <stop offset="0.42" stopColor={scarfBandLight} />
          <stop offset="1" stopColor={scarfBandShadow} />
        </linearGradient>
        <linearGradient id={`${id}-accent`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={bodyRim} />
          <stop offset="0.42" stopColor={mixHex(shirtAccent, '#fff0d0', 0.16)} />
          <stop offset="1" stopColor={bodyShadow} />
        </linearGradient>
        <radialGradient id={`${id}-whorl-patch`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={skin} stopOpacity="0.7" />
          <stop offset="0.55" stopColor={skin} stopOpacity="0.5" />
          <stop offset="1" stopColor={skin} stopOpacity="0" />
        </radialGradient>
        {/* Painted garment patterns are clipped to the body silhouette so
            stripes/sashes follow the carved edge instead of poking past it. */}
        <clipPath id={`${id}-bodyclip`}>
          <path d={bodyPath} />
        </clipPath>
        {/* Whorls are clipped to the head so a knot pushed toward the
            temple never spills onto the background. */}
        <clipPath id={`${id}-headclip`}>
          <ellipse cx={0} cy={0} rx={21.4} ry={22.4} />
        </clipPath>
        <filter id={`${id}-blur`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.75" />
        </filter>

        {applyGrain &&
          /* Wood-grain filter. Two turbulence layers:
             - `waves` is the broad cathedral pattern (low frequency, both
               axes) that gives the soft cross-grain wandering you see on
               a flat-sawn board.
             - `streaks` is the dense lengthwise fiber pattern — high X
               frequency, very low Y frequency → fibers running TOP→BOTTOM
               along the figurine's long axis, like lathe-turned wood.
             The streaks displace the waves, then a small directional blur
             makes them look embedded below several coats of paint instead
             of scratched onto the SVG. A low-alpha warm `multiply` blend
             grounds that variation into the underlying skin/shirt color.
             Two strengths: `-wood` for the carved surfaces (body, head,
             hair, hats), and a softer `-woodsoft` for cream cloth overlays
             — full-strength streaks over a light apron read as scribble. */
          [
            {
              suffix: 'wood',
              opacity: grainOpacity,
              soften: grainSoften,
            },
            {
              suffix: 'woodsoft',
              opacity: grainOpacity * 0.55,
              soften: grainSoften + 0.18,
            },
          ].map(({ suffix, opacity, soften }) => (
            <filter
              key={suffix}
              id={`${id}-${suffix}`}
              x="-4%"
              y="-4%"
              width="108%"
              height="108%"
              colorInterpolationFilters="sRGB"
            >
              <feTurbulence
                type="fractalNoise"
                baseFrequency={grainWaveFrequency}
                numOctaves={2}
                seed={grainSeed}
                stitchTiles="stitch"
                result="waves"
              />
              <feTurbulence
                type="fractalNoise"
                baseFrequency={grainStreakFrequency}
                numOctaves={2}
                seed={(grainSeed + 9) % 100}
                stitchTiles="stitch"
                result="streaks"
              />
              <feDisplacementMap
                in="streaks"
                in2="waves"
                scale={grainDisplacement}
                xChannelSelector="R"
                yChannelSelector="G"
                result="wavyGrain"
              />
              <feGaussianBlur in="wavyGrain" stdDeviation={soften} result="paintSoftenedGrain" />
              {/* Turbulence clusters around middle gray. Expanding that
                  narrow range creates individual fibers instead of a nearly
                  uniform brown veil, while the following low-alpha tint
                  keeps them visibly below the painted face and clothing. */}
              <feComponentTransfer in="paintSoftenedGrain" result="fiberContrast">
                <feFuncR type="linear" slope={2.4} intercept={-0.7} />
                <feFuncG type="linear" slope={2.4} intercept={-0.7} />
                <feFuncB type="linear" slope={2.4} intercept={-0.7} />
              </feComponentTransfer>
              <feColorMatrix
                in="fiberContrast"
                type="matrix"
                values={`0 0 0 0 0.30
                         0 0 0 0 0.20
                         0 0 0 0 0.11
                         ${opacity} 0 0 0 0`}
                result="grain"
              />
              <feComposite in="grain" in2="SourceGraphic" operator="in" result="masked-grain" />
              <feBlend in="masked-grain" in2="SourceGraphic" mode="multiply" />
            </filter>
          ))}
      </defs>

      {showShadow && (
        <ellipse cx={40} cy={L.baseY + 7} rx={arch.baseW * 0.58} ry={3} fill="rgba(0,0,0,0.16)" />
      )}
      {showBase && (
        <>
          <ellipse
            cx={40}
            cy={L.baseY + 2.2}
            rx={arch.baseW * 0.54}
            ry={3.8}
            fill={bodyRim}
            opacity={0.82}
          />
          <ellipse
            cx={39}
            cy={L.baseY + 1.35}
            rx={arch.baseW * 0.45}
            ry={1.15}
            fill={bodyLight}
            opacity={0.18}
          />
        </>
      )}

      {/* BODY — silhouette, painted garment pattern, and dress overlays all
          share one wood-grain pass. Earlier versions grained only the bare
          body, so aprons/scarves floated above the material like fresh
          stickers; seating them under the same grain is most of what makes
          the figure read as one carved, painted object. */}
      <g {...grainAttr}>
        <path d={bodyPath} fill={`url(#${id}-body)`} />
        <path d={bodyPath} fill={`url(#${id}-body-depth)`} />
        <path d={bodyPath} fill={`url(#${id}-body-glaze)`} />
        {/* Cathedral grain is the broad, nested flame figure found around
            growth transitions. It is deliberately sparse so it reads as a
            different cut of wood, not another garment pattern. */}
        {applyGrain && grainCharacter === 'cathedral' && (
          <g
            clipPath={`url(#${id}-bodyclip)`}
            fill="none"
            stroke="#3a1d0d"
            strokeWidth={0.48}
            strokeLinecap="round"
            opacity={cathedralOpacity}
            transform={`translate(${((grainSeed % 5) - 2) * 1.4} 0)`}
          >
            {[0, 1, 2, 3].map((i) => {
              const top = L.chestY + 24 - i * 6;
              const bottom = L.baseY - 24 + i * 5;
              const width = 5 + i * 3.7;
              const drift = (((grainSeed + i * 3) % 5) - 2) * 0.7;
              return (
                <path
                  key={i}
                  d={`M ${40 + drift - width * 0.45} ${bottom}
                      C ${40 + drift - width} ${bottom - 18}, ${40 + drift - width * 0.84} ${top + 9}, ${40 + drift} ${top}
                      C ${40 + drift + width * 0.7} ${top + 10}, ${40 + drift + width * 1.05} ${bottom - 16}, ${40 + drift + width * 0.38} ${bottom}`}
                />
              );
            })}
          </g>
        )}
        {/* PAINTED PATTERNS — flat accent-color paint, clipped to the body. */}
        {pattern === 'buttons' && (
          <g clipPath={`url(#${id}-bodyclip)`}>
            <line
              x1={40}
              y1={L.shoulderY + 4}
              x2={40}
              y2={L.hipY + 10}
              stroke={shirtAccent}
              strokeWidth={0.9}
              opacity={0.65}
            />
            <path
              d={`M ${40 - 3.5} ${L.shoulderY + 1.5} L 40 ${L.shoulderY + 5.5} L ${40 + 3.5} ${L.shoulderY + 1.5}`}
              fill="none"
              stroke={shirtAccent}
              strokeWidth={0.9}
              opacity={0.65}
            />
            {[L.chestY + 3, (L.chestY + L.waistY) / 2 + 4, L.waistY + 6].map((y) => (
              <circle key={y} cx={40} cy={y} r={1.15} fill="#241b12" opacity={0.6} />
            ))}
          </g>
        )}
        {pattern === 'stripes' && (
          <g clipPath={`url(#${id}-bodyclip)`}>
            {[0, 1, 2, 3, 4].map((i) => {
              const step = (L.baseY - 6 - L.chestY) / 5;
              return (
                <rect
                  key={i}
                  x={4}
                  y={L.chestY + i * step}
                  width={72}
                  height={step * 0.42}
                  fill={shirtAccent}
                  opacity={0.55}
                />
              );
            })}
          </g>
        )}
        {pattern === 'sash' && (
          <g clipPath={`url(#${id}-bodyclip)`}>
            <path
              d={`M ${40 - arch.shoulderW * 0.5} ${L.shoulderY + 1}
                  L ${40 - arch.shoulderW * 0.5 + 8} ${L.shoulderY - 1.5}
                  L ${40 + arch.hipW * 0.32 + 4} ${L.baseY - 5}
                  L ${40 + arch.hipW * 0.32 - 4.5} ${L.baseY - 3.5} Z`}
              fill={shirtAccent}
              opacity={0.72}
            />
          </g>
        )}
        {pattern === 'yoke' && (
          <g clipPath={`url(#${id}-bodyclip)`}>
            <path
              d={`M ${40 - arch.shoulderW * 0.5 - 3} ${L.shoulderY - 4}
                  L ${40 + arch.shoulderW * 0.5 + 3} ${L.shoulderY - 4}
                  L ${40 + arch.chestW * 0.46} ${L.chestY + 3}
                  Q 40 ${L.chestY + 11}, ${40 - arch.chestW * 0.46} ${L.chestY + 3} Z`}
              fill={shirtAccent}
              opacity={0.72}
            />
            <circle cx={40} cy={L.chestY + 6.5} r={1} fill="#241b12" opacity={0.55} />
          </g>
        )}
        {pattern === 'twotone' && (
          <g clipPath={`url(#${id}-bodyclip)`}>
            <rect x={0} y={L.waistY + 2} width={W} height={H} fill={shirtAccent} opacity={0.55} />
            <line
              x1={0}
              y1={L.waistY + 2}
              x2={W}
              y2={L.waistY + 2}
              stroke="#241b12"
              strokeWidth={0.7}
              opacity={0.28}
            />
          </g>
        )}
      </g>

      {/* The head is turned from the same blank, but a shallow contact shadow
          at the join makes its overlap with the torso physically legible. */}
      <ellipse
        cx={40.5}
        cy={L.shoulderY + 1.5}
        rx={Math.min(L.headR * 0.72, arch.shoulderW * 0.44)}
        ry={2.8}
        fill="#160e09"
        opacity={0.18}
        filter={`url(#${id}-blur)`}
      />

      {/* DRESS — body-level garment overlays. Aprons and collars use a
          constant linen/cream so they read as separate garments; the
          scarf gets its own felt color (like hats) so it pops instead of
          vanishing into the shirt. Cloth gets the SOFT grain — it should
          sit in the same material world as the carved body without the
          full streak treatment turning cream surfaces into scribble. */}
      <g {...grainAttrSoft}>{renderDress(dress, itemCtx)}</g>

      {/* HEAD — all features in one transform group so head size scales them. */}
      <g transform={`translate(40 ${L.headCY}) scale(${L.headR / 22})`}>
        <ellipse
          cx={0.7}
          cy={1.2}
          rx={22}
          ry={23}
          fill="#160e09"
          opacity={0.16}
          filter={`url(#${id}-blur)`}
        />
        <ellipse cx={0} cy={0} rx={22} ry={23} fill={`url(#${id}-head)`} {...grainAttr} />

        {/* Whorls live on the cheeks/temples, never mid-face — a knot in
            the middle of the forehead read as a bruise. Clipped to the
            head so the push outward can't spill onto the background. */}
        <g clipPath={`url(#${id}-headclip)`}>
          {Array.from({ length: whorlCount }, (_, i) => {
            const s = grainSeed + i * 47;
            const side = whorlCount > 1 ? (i === 0 ? -1 : 1) : s % 2 === 0 ? -1 : 1;
            const wx = side * (14 + (s % 4) * 0.55);
            const verticalSide = Math.floor(s / 4) % 2 === 0 ? -1 : 1;
            const wy = verticalSide * (6.2 + (s % 3) * 1.05);
            const wr = 4.5 + (s % 3);
            const rot = ((s * 13) % 60) - 30;
            const lobes = 3 + (s % 3);
            const phase = (s * 0.317) % (Math.PI * 2);
            const amp = 0.06 + ((s * 7) % 50) / 1000;
            return (
              <g key={s} transform={`translate(${wx} ${wy}) rotate(${rot})`}>
                <ellipse
                  cx={0}
                  cy={0}
                  rx={wr * 1.75}
                  ry={wr * 1.25}
                  fill={`url(#${id}-whorl-patch)`}
                />
                <g fill="none" stroke="#3a1d0d" strokeWidth={0.32} strokeLinejoin="round">
                  <path
                    d={whorlRing(wr, wr * 0.72, lobes, amp, phase)}
                    opacity={whorlOpacity * 0.72}
                  />
                  <g transform={`translate(${-wr * 0.1} ${wr * 0.06})`}>
                    <path
                      d={whorlRing(wr * 0.7, wr * 0.5, lobes, amp * 1.4, phase + 0.3)}
                      opacity={whorlOpacity * 0.86}
                    />
                  </g>
                  <g transform={`translate(${-wr * 0.18} ${wr * 0.12})`}>
                    <path
                      d={whorlRing(wr * 0.42, wr * 0.3, lobes, amp * 1.8, phase + 0.6)}
                      opacity={whorlOpacity}
                    />
                  </g>
                </g>
                <ellipse
                  cx={-wr * 0.24}
                  cy={wr * 0.16}
                  rx={wr * 0.2}
                  ry={wr * 0.14}
                  fill="#3a1d0d"
                  opacity={Math.min(0.46, whorlOpacity + 0.08)}
                />
              </g>
            );
          })}
        </g>

        {/* Painted wood has a broad satin bloom, not the pin-point highlight
            of plastic. Keep it warm, soft, and off-axis. */}
        <ellipse
          cx={-7.5}
          cy={-9.5}
          rx={7.5}
          ry={4.2}
          fill="rgba(255,239,208,0.09)"
          filter={`url(#${id}-blur)`}
        />
        <ellipse cx={-9.2} cy={-11.2} rx={2.4} ry={1.15} fill="rgba(255,248,226,0.12)" />

        {/* Cathedral figures also show offset growth rings across the turned
            head. Fine/flowing figures rely on fibers; knotty figures use the
            organic whorl above, keeping the material signatures distinct. */}
        {applyGrain && grainCharacter === 'cathedral' && (
          <g
            fill="none"
            stroke="#3a1d0d"
            strokeOpacity={cathedralOpacity * 0.76}
            strokeWidth={0.38}
            transform={`translate(${((grainSeed % 7) - 3) * 0.6} ${((grainSeed % 5) - 2) * 0.5})`}
          >
            <ellipse cx={0} cy={0} rx={20} ry={21} />
            <ellipse cx={0} cy={0} rx={16} ry={17} />
            <ellipse cx={0} cy={0} rx={12} ry={13} />
            <ellipse cx={0} cy={0} rx={8} ry={9} />
          </g>
        )}

        {/* HAIR + HATS — painted wood, so they share the grain pass. */}
        <g {...grainAttr}>
          {/* HAIR — drawn below hats. */}
          {showHair && g.hairShape === 'halo' && (
            /* Halo is a soft curly cushion: the hull hugs the crown and a
               row of scallop curls bumps down along the fringe — that
               fringe is what separates it from `short`, which used to be
               a near-identical helmet. */
            <>
              <path
                d="M -21 0 C -23 -18, -12 -27, 0 -27 C 12 -27, 23 -18, 21 0 C 17 -8, 10 -13, 0 -13 C -10 -13, -17 -8, -21 0 Z"
                fill={`url(#${id}-hair)`}
              />
              <circle cx={-13.5} cy={-6.5} r={3.1} fill={`url(#${id}-hair)`} />
              <circle cx={-7} cy={-10.5} r={3.3} fill={`url(#${id}-hair)`} />
              <circle cx={0} cy={-12} r={3.4} fill={`url(#${id}-hair)`} />
              <circle cx={7} cy={-10.5} r={3.3} fill={`url(#${id}-hair)`} />
              <circle cx={13.5} cy={-6.5} r={3.1} fill={`url(#${id}-hair)`} />
            </>
          )}
          {showHair && g.hairShape === 'short' && (
            /* Cropped cut — hairline sits high on the forehead, ending in
               small sideburn points at the temples. */
            <path
              d="M -20 -5 C -21.5 -19, -10 -25.5, 0 -25.5 C 10 -25.5, 21.5 -19, 20 -5 C 19 -8.5, 17 -10.5, 15 -11.5 C 9 -14.5, -9 -14.5, -15 -11.5 C -17 -10.5, -19 -8.5, -20 -5 Z"
              fill={`url(#${id}-hair)`}
            />
          )}
          {showHair && g.hairShape === 'long' && (
            /* One closed path: cap + side strands, physically continuous —
               no seam at the temple. Face shows in the forehead window. */
            <path
              d="M -21 18
                 C -23 12, -22 4, -21 -2
                 C -22 -22, -12 -28, 0 -28
                 C 12 -28, 22 -22, 21 -2
                 C 22 4, 23 12, 21 18
                 C 21 24, 18 24, 18 20
                 L 18 -2
                 C 16 -8, 14 -13, 10 -16
                 C 4 -19, -4 -19, -10 -16
                 C -14 -13, -16 -8, -18 -2
                 L -18 20
                 C -18 24, -21 24, -21 18
                 Z"
              fill={`url(#${id}-hair)`}
            />
          )}
          {showHair && g.hairShape === 'bun' && (
            /* Bun + scalp drawn as one continuous shape; the bun is a real
               topknot now (the old r≈5 version read as a stray bead). */
            <>
              <path
                d="M -21 -2 C -21 -18, -11 -23, 0 -23 C 11 -23, 21 -18, 21 -2 C 15 -11, 8 -15, 0 -15 C -8 -15, -15 -11, -21 -2 Z"
                fill={`url(#${id}-hair)`}
              />
              <path
                d="M -4.5 -22 C -4.5 -24, 4.5 -24, 4.5 -22 L 4.5 -19.5 C 4.5 -18.5, -4.5 -18.5, -4.5 -19.5 Z"
                fill={`url(#${id}-hair)`}
              />
              <ellipse cx={0} cy={-25.5} rx={7} ry={5.6} fill={`url(#${id}-hair)`} />
              {/* Tie band at the base of the knot. */}
              <ellipse cx={0} cy={-20.6} rx={4.6} ry={1.4} fill={shirtAccent} opacity={0.9} />
            </>
          )}
          {showHair && g.hairShape === 'braids' && (
            /* Cap + a plaited braid down each side. Chevron strokes give
               the strands their plait texture — without them the braids
               read as flat slabs of hair. */
            <>
              <path
                d="M -22 -2 C -23 -21, -12 -28, 0 -28 C 12 -28, 23 -21, 22 -2 C 16 -11, 8 -16, 0 -16 C -8 -16, -16 -11, -22 -2 Z"
                fill={`url(#${id}-hair)`}
              />
              <path
                d="M -19 -16 C -23 -8, -23 8, -22 19 C -21 24, -20 27, -19 29 L -14 29 C -16 17, -16 4, -15 -8 C -14.5 -13, -16 -16, -19 -16 Z"
                fill={`url(#${id}-hair)`}
              />
              <path
                d="M 19 -16 C 23 -8, 23 8, 22 19 C 21 24, 20 27, 19 29 L 14 29 C 16 17, 16 4, 15 -8 C 14.5 -13, 16 -16, 19 -16 Z"
                fill={`url(#${id}-hair)`}
              />
              <g fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth={1} strokeLinecap="round">
                {[-2, 6, 14, 22].map((y) => (
                  <path key={`l${y}`} d={`M -20.5 ${y} L -18 ${y + 2.4} L -15.8 ${y - 0.4}`} />
                ))}
                {[-2, 6, 14, 22].map((y) => (
                  <path key={`r${y}`} d={`M 20.5 ${y} L 18 ${y + 2.4} L 15.8 ${y - 0.4}`} />
                ))}
              </g>
              {/* Braid ties — small dots in the shirt accent color. */}
              <circle cx={-16.5} cy={28} r={1.5} fill={shirtAccent} />
              <circle cx={16.5} cy={28} r={1.5} fill={shirtAccent} />
            </>
          )}
          {showHair && g.hairShape === 'shaved' && (
            <path
              d="M -20 -5 C -20 -19, -10 -25, 0 -25 C 10 -25, 20 -19, 20 -5 C 14 -9, 7 -11, 0 -11 C -7 -11, -14 -9, -20 -5 Z"
              fill={`url(#${id}-hair)`}
              opacity={0.68}
            />
          )}

          {/* HATS — replace hair and cover the skull top. Crowns are wider
              than the visible head at the brow so skin never pops up behind
              a hat brim. Cloth hats wear their own felt color. The hood is
              drawn last (it frames the face); see below. */}
          {renderHatCrown(hat, itemCtx)}
        </g>

        {/* FACE — Bruna-simple. Eyes are ALWAYS two dots; the expression
            varies through the mouth. Eye spacing, mouth width, and blush
            come from the per-individual `fv` so no two faces are clones. */}
        <circle cx={-fv.eyeGap} cy={fv.eyeY} r={fv.eyeR} fill="#1a1410" />
        <circle cx={fv.eyeGap} cy={fv.eyeY} r={fv.eyeR} fill="#1a1410" />
        {expression === 'smile' && (
          <path
            d={`M ${-4 * fv.mouthW} ${mY} Q 0 ${mY + 3} ${4 * fv.mouthW} ${mY}`}
            stroke="#1a1410"
            strokeWidth={1.1}
            fill="none"
            strokeLinecap="round"
          />
        )}
        {expression === 'wider' && (
          /* Open laughing mouth — a filled crescent, clearly bigger than
             the plain smile (the stroke-only version was near identical). */
          <path
            d={`M ${-5.4 * fv.mouthW} ${mY - 1} Q 0 ${mY + 5.4} ${5.4 * fv.mouthW} ${mY - 1} Q 0 ${mY + 1.6} ${-5.4 * fv.mouthW} ${mY - 1} Z`}
            fill="#1a1410"
          />
        )}
        {expression === 'neutral' && (
          <line
            x1={-3 * fv.mouthW}
            y1={mY + 1}
            x2={3 * fv.mouthW}
            y2={mY + 1}
            stroke="#1a1410"
            strokeWidth={1.2}
            strokeLinecap="round"
          />
        )}
        {expression === 'wink' && (
          /* Sideways smirk — raised on the right, lower on the left. */
          <path
            d={`M ${-5 * fv.mouthW} ${mY + 1} Q 0 ${mY + 3} ${5 * fv.mouthW} ${mY - 2}`}
            stroke="#1a1410"
            strokeWidth={1.2}
            fill="none"
            strokeLinecap="round"
          />
        )}
        {expression === 'sleepy' && (
          /* Small relaxed open mouth — reads as a sleepy yawn. */
          <ellipse cx={0} cy={mY + 1} rx={1.6 * fv.mouthW} ry={1.0} fill="#1a1410" opacity={0.85} />
        )}
        {expression !== 'neutral' && (
          <>
            <ellipse
              cx={-(fv.eyeGap + 4.5)}
              cy={fv.eyeY + 4}
              rx={2.5}
              ry={1.5}
              fill={`rgba(201,117,83,${fv.blush})`}
            />
            <ellipse
              cx={fv.eyeGap + 4.5}
              cy={fv.eyeY + 4}
              rx={2.5}
              ry={1.5}
              fill={`rgba(201,117,83,${fv.blush})`}
            />
          </>
        )}

        {/* FACIAL HAIR — drawn before the worn accessories so chains, ties,
            and masks layer over a beard the way real ones would. */}
        {facialHair === 'beard' && (
          /* Goatee — narrow chin tuft, top edge peaks up at the center so
             it never echoes the smile arc above it. */
          <path
            d="M -5.6 16.5
               C -6.2 19.5, -4 22, 0 22.5
               C 4 22, 6.2 19.5, 5.6 16.5
               C 3.2 15.8, -3.2 15.8, -5.6 16.5
               Z"
            fill={`url(#${id}-hair)`}
          />
        )}
        {facialHair === 'mustache' && (
          <path
            d={`M -6 ${6 + fv.mouthDY} C -4 ${5 + fv.mouthDY}, -2 ${5 + fv.mouthDY}, 0 ${6 + fv.mouthDY} C 2 ${5 + fv.mouthDY}, 4 ${5 + fv.mouthDY}, 6 ${6 + fv.mouthDY} C 5 ${7.5 + fv.mouthDY}, 3 ${8 + fv.mouthDY}, 0 ${7.5 + fv.mouthDY} C -3 ${8 + fv.mouthDY}, -5 ${7.5 + fv.mouthDY}, -6 ${6 + fv.mouthDY} Z`}
            fill={`url(#${id}-hair)`}
          />
        )}
        {/* ACCESSORIES — worn items (eyewear, jewelry, cloth) tracking the
            per-individual eyes. Drawn after facial hair so chains and ties
            layer over a beard the way real ones would, but before marks so
            freckles read through. */}
        {renderAccessory(accessory, itemCtx)}

        {/* MARKS — independent of accessory; can coexist (glasses + freckles). */}
        {mark === 'mole' && <circle cx={-7} cy={9} r={0.9} fill="rgba(40,20,10,0.6)" />}
        {mark === 'freckles' && (
          <g fill="rgba(150,80,40,0.55)">
            <circle cx={-11} cy={4} r={0.45} />
            <circle cx={-13} cy={6} r={0.4} />
            <circle cx={-10} cy={7} r={0.5} />
            <circle cx={-8} cy={5} r={0.4} />
            <circle cx={11} cy={4} r={0.45} />
            <circle cx={13} cy={6} r={0.4} />
            <circle cx={10} cy={7} r={0.5} />
            <circle cx={8} cy={5} r={0.4} />
            <circle cx={0} cy={6} r={0.4} />
          </g>
        )}

        {/* HOOD — one continuous arch of fabric framing the face. Stays in
            the shirt accent (it's part of the garment, unlike felt hats) and
            paints last so it sits over the head. */}
        {hat === 'hood' && <g {...grainAttr}>{renderHood(itemCtx)}</g>}
      </g>
    </svg>
  );
}
