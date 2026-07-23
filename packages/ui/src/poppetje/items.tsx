import type { AccessoryOption, BodyArchetype, DressOption, HatOption } from '@bendyline/gezel';
import { type JSX, useLayoutEffect, useRef, useState } from 'react';
import { renderAdditionalAccessory } from './accessories.js';
import { type Felt, feltForSkin } from './color.js';
import { type ResolvedLayout, archFor, resolveLayout, scaleFor } from './geometry.js';

/**
 * Everything a single worn item needs to draw itself: per-individual face
 * geometry, the resolved body layout + archetype (for body-level garments),
 * the felt material colors, and the shirt palette. The full `Poppetje`
 * renderer builds this from its live struct; the isolated tile picker builds
 * a neutral one. Centralizing the item art here keeps one source of truth —
 * editing a hat updates both the figure and the picker tile.
 */
export interface ItemCtx {
  fv: { eyeGap: number; eyeY: number };
  L: ResolvedLayout;
  arch: BodyArchetype;
  felt: Felt;
  scarfFelt: Felt;
  shirt: string;
  shirtAccent: string;
  /** Optional SVG paint servers supplied by the full figure renderer. */
  feltFill?: string;
  feltBandFill?: string;
  scarfFill?: string;
  scarfBandFill?: string;
  shirtFill?: string;
  shirtAccentFill?: string;
  /** Hair-zone accessories hide under a hat. */
  hasHat: boolean;
}

// Gold stud earring at one lobe. Earring side names are the VIEWER's
// left/right — what you see in the preview — not the wearer's.
const stud = (cx: number): JSX.Element => (
  <g key={`stud${cx}`}>
    <circle cx={cx} cy={6} r={2.4} fill="rgba(245,200,80,0.95)" />
    <circle cx={cx - 0.6} cy={5.4} r={0.7} fill="rgba(255,235,170,0.9)" />
    <circle cx={cx} cy={6} r={2.4} fill="none" stroke="#5b3d10" strokeWidth={0.4} />
  </g>
);

/**
 * Felt/straw hats. Drawn in head-local coordinates (origin at head center).
 * The hood is NOT here — it frames the face and must paint last; see
 * {@link renderHood}.
 */
export function renderHatCrown(hat: HatOption | null, ctx: ItemCtx): JSX.Element | null {
  const { felt } = ctx;
  const feltFill = ctx.feltFill ?? felt.felt;
  const feltBandFill = ctx.feltBandFill ?? felt.band;
  if (hat === 'cap') {
    return (
      <>
        <path
          d="M -22 -8 C -22 -23, -11 -29, 0 -29 C 11 -29, 22 -23, 22 -8 C 16 -11, 8 -13, 0 -13 C -8 -13, -16 -11, -22 -8 Z"
          fill={feltFill}
        />
        {/* Front bill — seen face-on it reads as a lens-shaped curve
            over the forehead, not a sideways duckbill. */}
        <path
          d="M -16 -9.5 C -8 -13, 8 -13, 16 -9.5 C 13 -3.5, -13 -3.5, -16 -9.5 Z"
          fill={feltBandFill}
        />
        <path
          d="M -16 -9.5 C -8 -13, 8 -13, 16 -9.5"
          fill="none"
          stroke="rgba(0,0,0,0.25)"
          strokeWidth={0.5}
        />
      </>
    );
  }
  if (hat === 'beanie') {
    return (
      <>
        <path
          d="M -22 -7 C -22 -25, -12 -32, 0 -32 C 12 -32, 22 -25, 22 -7 C 16 -9, 8 -10, 0 -10 C -8 -10, -16 -9, -22 -7 Z"
          fill={feltFill}
        />
        <path
          d="M -22 -8 C -17 -10, -9 -11, 0 -11 C 9 -11, 17 -10, 22 -8 C 18 -5, 9 -4, 0 -4 C -9 -4, -18 -5, -22 -8 Z"
          fill={feltBandFill}
        />
        {/* Knit pompom. */}
        <circle cx={0} cy={-32.5} r={2.8} fill="#e8dfc8" opacity={0.95} />
      </>
    );
  }
  if (hat === 'kerchief') {
    return (
      <>
        <path
          d="M -22 -9 C -22 -22, -11 -28, 0 -28 C 11 -28, 22 -22, 22 -9 L 18 -3 C 14 -7, 7 -9, 0 -9 C -7 -9, -14 -7, -18 -3 Z"
          fill={feltFill}
        />
        {/* Side knot with two tails poking past the head silhouette —
            the knot is what makes it read as a tied kerchief instead
            of a beanie. */}
        <path d="M 19.5 -9 L 26.5 -10.5 L 23 -4.5 Z" fill={feltBandFill} />
        <path d="M 20 -7.5 L 27.5 -5 L 22.5 -2 Z" fill={feltFill} />
        <circle cx={-6} cy={-18} r={1} fill="rgba(255,255,255,0.25)" />
        <circle cx={6} cy={-16} r={1} fill="rgba(255,255,255,0.25)" />
        <circle cx={0} cy={-22} r={1} fill="rgba(255,255,255,0.25)" />
      </>
    );
  }
  if (hat === 'straw') {
    return (
      <>
        {/* Straw uses its own warm material color, not the shirt accent. */}
        <ellipse cx={0} cy={-8.5} rx={29} ry={4.2} fill="#b98942" />
        <path
          d="M -18 -9 C -18 -23, -9 -29, 0 -29 C 9 -29, 18 -23, 18 -9 C 12 -11, 6 -12, 0 -12 C -6 -12, -12 -11, -18 -9 Z"
          fill="#cda75d"
        />
        {/* Hat band */}
        <ellipse cx={0} cy={-10} rx={18} ry={1.25} fill="#5b3518" opacity={0.5} />
        {/* Brim weave — thin radial darks suggesting straw fibers. */}
        <g stroke="#5b3518" strokeWidth={0.3} opacity={0.26}>
          <line x1={-27} y1={-8.5} x2={-19} y2={-9.5} />
          <line x1={-23} y1={-6.5} x2={-16} y2={-8.8} />
          <line x1={27} y1={-8.5} x2={19} y2={-9.5} />
          <line x1={23} y1={-6.5} x2={16} y2={-8.8} />
        </g>
      </>
    );
  }
  if (hat === 'newsboy') {
    return (
      <>
        <path
          d="M -22 -8 C -23 -21, -11 -28, 0 -28 C 11 -28, 23 -21, 22 -8 C 16 -11, 8 -13, 0 -13 C -8 -13, -16 -11, -22 -8 Z"
          fill={feltFill}
        />
        <circle cx={0} cy={-25} r={1} fill={feltBandFill} />
        <path
          d="M -13 -9 C -7 -7, 7 -7, 13 -9 C 16 -8, 16 -6, 13 -5.5 C 5 -4, -5 -4, -13 -5.5 C -16 -6, -16 -8, -13 -9 Z"
          fill="#2a2118"
          opacity={0.82}
        />
      </>
    );
  }
  return null;
}

/**
 * The hood — one continuous arch of fabric framing the face. Stays in the
 * shirt accent (it's part of the garment, unlike felt hats) and paints LAST
 * in the figure so it sits over the head. Head-local coordinates.
 */
export function renderHood(ctx: ItemCtx): JSX.Element {
  return (
    <>
      <path
        d="M -15 20
           C -24 9, -26 -10, -24 -20
           C -22 -28, -12 -31, 0 -31
           C 12 -31, 22 -28, 24 -20
           C 26 -10, 24 9, 15 20
           L 9 20
           C 15 8, 16 -9, 13 -15
           C 7 -18, -7 -18, -13 -15
           C -16 -9, -15 8, -9 20
           Z"
        fill={ctx.shirtAccentFill ?? ctx.shirtAccent}
      />
      {/* Soft inner rim along the face opening so the hood reads as
          a recessed cowl rather than a flat cutout. */}
      <path
        d="M 13 -15 C 7 -18, -7 -18, -13 -15 C -16 -9, -15 8, -9 20"
        fill="none"
        stroke="#1a1410"
        strokeWidth={0.9}
        strokeOpacity={0.16}
        strokeLinecap="round"
      />
    </>
  );
}

/**
 * Body-level garments — scarf, apron, collar, turtleneck. Drawn in
 * body-absolute coordinates (figure centered on x = 40), so they need the
 * resolved layout + archetype from {@link ItemCtx}.
 */
export function renderDress(dress: DressOption | null, ctx: ItemCtx): JSX.Element | null {
  const { L, arch, scarfFelt, shirt } = ctx;
  const scarfFill = ctx.scarfFill ?? scarfFelt.felt;
  const scarfBandFill = ctx.scarfBandFill ?? scarfFelt.band;
  if (dress === 'scarf') {
    return (
      <g
        stroke="rgba(40,24,10,0.25)"
        strokeWidth={0.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {/* Crescent wrap hugging the collarbones. */}
        <path
          d={`M ${40 - arch.shoulderW * 0.45} ${L.shoulderY + 3}
              Q ${40 - 4} ${L.shoulderY + 11}, ${40} ${L.shoulderY + 9}
              Q ${40 + 4} ${L.shoulderY + 11}, ${40 + arch.shoulderW * 0.45} ${L.shoulderY + 3}
              Q ${40 + arch.shoulderW * 0.4} ${L.shoulderY + 15},
                ${40 + 1} ${L.shoulderY + 18}
              Q ${40} ${L.shoulderY + 14}, ${40 - 1} ${L.shoulderY + 18}
              Q ${40 - arch.shoulderW * 0.4} ${L.shoulderY + 15},
                ${40 - arch.shoulderW * 0.45} ${L.shoulderY + 3} Z`}
          fill={scarfFill}
        />
        {/* Trailing tail with a fringed end. */}
        <path
          d={`M ${40 + arch.shoulderW * 0.25} ${L.shoulderY + 12}
              Q ${40 + arch.shoulderW * 0.45} ${L.shoulderY + 22},
                ${40 + arch.shoulderW * 0.4}  ${L.shoulderY + 31}
              L ${40 + arch.shoulderW * 0.4 - 2} ${L.shoulderY + 29}
              L ${40 + arch.shoulderW * 0.4 - 4} ${L.shoulderY + 31.5}
              L ${40 + arch.shoulderW * 0.4 - 6} ${L.shoulderY + 28.5}
              Q ${40 + arch.shoulderW * 0.3} ${L.shoulderY + 24},
                ${40 + arch.shoulderW * 0.18} ${L.shoulderY + 16} Z`}
          fill={scarfBandFill}
        />
        {/* Knot where the wrap folds over itself. */}
        <ellipse
          cx={40 + arch.shoulderW * 0.06}
          cy={L.shoulderY + 12.5}
          rx={2.3}
          ry={1.8}
          fill={scarfBandFill}
        />
      </g>
    );
  }
  if (dress === 'apron') {
    return (
      /* Kept deliberately quiet: cream cloth over a (possibly dark)
         shirt is already the highest-contrast garment in the catalog,
         and with the grain multiplied over it every extra stroke reads
         as scribble. Bib + draped skirt + pocket + ties, nothing else. */
      <g>
        {/* Neck strap */}
        <path
          d={`M ${40 - 6} ${L.chestY - 0.5} C ${40 - 4.5} ${L.shoulderY + 1}, ${40 + 4.5} ${L.shoulderY + 1}, ${40 + 6} ${L.chestY - 0.5}`}
          fill="none"
          stroke="#a48a5c"
          strokeWidth={1.2}
        />
        {/* Bib */}
        <path
          d={`M ${40 - 7} ${L.chestY - 0.5}
              L ${40 + 7} ${L.chestY - 0.5}
              L ${40 + 8.5} ${L.waistY - 0.5}
              L ${40 - 8.5} ${L.waistY - 0.5} Z`}
          fill="#e6dabb"
        />
        {/* Skirt — gently flared, hem dips at center so the cloth
            reads as draping over the figure instead of a flat card. */}
        <path
          d={`M ${40 - arch.waistW * 0.47} ${L.waistY}
              L ${40 + arch.waistW * 0.47} ${L.waistY}
              C ${40 + arch.hipW * 0.5} ${L.hipY},
                ${40 + arch.hipW * 0.47} ${L.hipY + 4},
                ${40 + arch.hipW * 0.43} ${L.hipY + 8}
              Q 40 ${L.hipY + 11.5}, ${40 - arch.hipW * 0.43} ${L.hipY + 8}
              C ${40 - arch.hipW * 0.47} ${L.hipY + 4},
                ${40 - arch.hipW * 0.5} ${L.hipY},
                ${40 - arch.waistW * 0.47} ${L.waistY} Z`}
          fill="#e6dabb"
        />
        {/* Patch pocket */}
        <path
          d={`M ${40 + arch.hipW * 0.12 - 3} ${L.hipY - 3}
              L ${40 + arch.hipW * 0.12 - 3} ${L.hipY + 1}
              Q ${40 + arch.hipW * 0.12} ${L.hipY + 2.5}, ${40 + arch.hipW * 0.12 + 3} ${L.hipY + 1}
              L ${40 + arch.hipW * 0.12 + 3} ${L.hipY - 3}`}
          fill="#ddd0ad"
        />
        {/* Waist tie */}
        <line
          x1={40 - arch.waistW * 0.46}
          y1={L.waistY + 0.5}
          x2={40 + arch.waistW * 0.46}
          y2={L.waistY + 0.5}
          stroke="#a48a5c"
          strokeWidth={1.1}
        />
      </g>
    );
  }
  if (dress === 'collar') {
    return (
      <g stroke="rgba(60,40,15,0.4)" strokeWidth={0.45} strokeLinejoin="round">
        <path
          d={`M ${40 - 9} ${L.shoulderY + 1} L ${40} ${L.shoulderY + 11} L ${40 - 13} ${L.shoulderY + 8.5} Z`}
          fill="#f0e8d0"
        />
        <path
          d={`M ${40 + 9} ${L.shoulderY + 1} L ${40} ${L.shoulderY + 11} L ${40 + 13} ${L.shoulderY + 8.5} Z`}
          fill="#f0e8d0"
        />
      </g>
    );
  }
  if (dress === 'turtleneck') {
    return (
      /* Cowl wide enough to peek around the chin — the head ellipse
         spans ±16.5 at collar height, so anything narrower is fully
         hidden behind the face (the old rx=11 version was invisible).
         Pure shirt color + a light top rim: the body gradient is
         accent-dark at these x positions, so the lighter cowl pops
         against it (an accent-tinted cowl vanished into the body). */
      <g>
        <ellipse cx={40} cy={L.shoulderY - 3} rx={19} ry={7} fill={ctx.shirtFill ?? shirt} />
        <ellipse cx={40} cy={L.shoulderY - 5.2} rx={16.5} ry={3.4} fill="rgba(255,245,225,0.22)" />
        <g stroke="rgba(0,0,0,0.2)" strokeWidth={0.55}>
          {[-17.5, -15, -12.5, 12.5, 15, 17.5].map((k) => (
            <line key={k} x1={40 + k} y1={L.shoulderY - 7} x2={40 + k} y2={L.shoulderY + 1.5} />
          ))}
        </g>
      </g>
    );
  }
  return null;
}

/**
 * Worn face/jewelry accessories. Head-local coordinates, tracking the
 * per-individual eyes via {@link ItemCtx.fv}. Eyewear, then jewelry/cloth
 * pieces. Hair-zone items hide under a hat.
 */
export function renderAccessory(
  accessory: AccessoryOption | null,
  ctx: ItemCtx,
): JSX.Element | null {
  const { fv, shirtAccent, hasHat } = ctx;
  if (accessory === 'glasses') {
    return (
      <g stroke="#1a1410" strokeWidth={0.9} fill="none">
        <circle cx={-fv.eyeGap} cy={fv.eyeY} r={4.2} />
        <circle cx={fv.eyeGap} cy={fv.eyeY} r={4.2} />
        <line x1={-(fv.eyeGap - 4.2)} y1={fv.eyeY} x2={fv.eyeGap - 4.2} y2={fv.eyeY} />
      </g>
    );
  }
  if (accessory === 'sunglasses') {
    return (
      /* Rounded-square dark lenses — unmistakable at icon size next to
         the round wire glasses. */
      <g>
        <rect
          x={-fv.eyeGap - 4.3}
          y={fv.eyeY - 3.4}
          width={8.6}
          height={6.9}
          rx={2.6}
          fill="#241b12"
        />
        <rect
          x={fv.eyeGap - 4.3}
          y={fv.eyeY - 3.4}
          width={8.6}
          height={6.9}
          rx={2.6}
          fill="#241b12"
        />
        <line
          x1={-(fv.eyeGap - 4.3)}
          y1={fv.eyeY - 1.6}
          x2={fv.eyeGap - 4.3}
          y2={fv.eyeY - 1.6}
          stroke="#241b12"
          strokeWidth={1.1}
        />
        <circle cx={-fv.eyeGap - 1.4} cy={fv.eyeY - 1.5} r={0.75} fill="rgba(255,255,255,0.4)" />
        <circle cx={fv.eyeGap - 1.4} cy={fv.eyeY - 1.5} r={0.75} fill="rgba(255,255,255,0.4)" />
      </g>
    );
  }
  if (accessory === 'cateye') {
    return (
      /* Cat-eye frames — oval lenses with upswept wing tips. */
      <g stroke="#1a1410" strokeWidth={0.95} fill="none">
        <ellipse cx={-fv.eyeGap} cy={fv.eyeY + 0.3} rx={4.2} ry={3.2} />
        <ellipse cx={fv.eyeGap} cy={fv.eyeY + 0.3} rx={4.2} ry={3.2} />
        <line x1={-(fv.eyeGap - 4.2)} y1={fv.eyeY - 0.4} x2={fv.eyeGap - 4.2} y2={fv.eyeY - 0.4} />
        <path
          d={`M ${-fv.eyeGap - 3.1} ${fv.eyeY - 1.7} L ${-fv.eyeGap - 6} ${fv.eyeY - 4.3}`}
          strokeWidth={1.35}
          strokeLinecap="round"
        />
        <path
          d={`M ${fv.eyeGap + 3.1} ${fv.eyeY - 1.7} L ${fv.eyeGap + 6} ${fv.eyeY - 4.3}`}
          strokeWidth={1.35}
          strokeLinecap="round"
        />
      </g>
    );
  }
  if (accessory === 'readers') {
    return (
      /* Half-moon reading glasses perched low — flat top, bowl bottom,
         eyes peering over the rim. */
      <g stroke="#1a1410" strokeWidth={0.85} fill="none">
        <path
          d={`M ${-fv.eyeGap - 3.7} ${fv.eyeY + 2.2} L ${-fv.eyeGap + 3.7} ${fv.eyeY + 2.2} A 3.7 3.4 0 0 1 ${-fv.eyeGap - 3.7} ${fv.eyeY + 2.2}`}
        />
        <path
          d={`M ${fv.eyeGap - 3.7} ${fv.eyeY + 2.2} L ${fv.eyeGap + 3.7} ${fv.eyeY + 2.2} A 3.7 3.4 0 0 1 ${fv.eyeGap - 3.7} ${fv.eyeY + 2.2}`}
        />
        <line x1={-(fv.eyeGap - 3.7)} y1={fv.eyeY + 2.2} x2={fv.eyeGap - 3.7} y2={fv.eyeY + 2.2} />
      </g>
    );
  }
  if (accessory === 'eyepatch') {
    return (
      /* Patch over the viewer-right eye, strap running to both head
         edges. The strap stays at eye level so it works under hats. */
      <g>
        <path
          d={`M -21.2 ${fv.eyeY - 2.8} L ${fv.eyeGap - 4.6} ${fv.eyeY - 3.4}`}
          stroke="#241b12"
          strokeWidth={1.1}
          strokeLinecap="round"
        />
        <path
          d={`M ${fv.eyeGap + 4.5} ${fv.eyeY - 3.6} L 21.4 ${fv.eyeY - 4.2}`}
          stroke="#241b12"
          strokeWidth={1.1}
          strokeLinecap="round"
        />
        <ellipse cx={fv.eyeGap} cy={fv.eyeY + 0.2} rx={4.7} ry={4.3} fill="#241b12" />
      </g>
    );
  }
  if (accessory === 'monocle') {
    return (
      /* Rim around the right eye with a chain to the collar. */
      <g>
        <circle cx={fv.eyeGap} cy={fv.eyeY} r={4.4} fill="rgba(255,255,255,0.12)" />
        <circle
          cx={fv.eyeGap}
          cy={fv.eyeY}
          r={4.4}
          stroke="#1a1410"
          strokeWidth={0.95}
          fill="none"
        />
        <path
          d={`M ${fv.eyeGap + 4.2} ${fv.eyeY + 2.2} Q ${fv.eyeGap + 8} ${fv.eyeY + 8} ${fv.eyeGap + 6} ${fv.eyeY + 17}`}
          stroke="#1a1410"
          strokeWidth={0.45}
          fill="none"
          strokeLinecap="round"
        />
      </g>
    );
  }
  if (accessory === 'facemask') {
    return (
      /* Sickness/dust mask over nose and mouth — linen-cream like the
         apron, with pleat lines and ear loops. */
      <g>
        <path
          d="M -9.2 7 Q -16 4.8, -20.4 5.6"
          stroke="rgba(60,45,25,0.5)"
          strokeWidth={0.55}
          fill="none"
        />
        <path
          d="M -9 13.5 Q -16 11.5, -20.4 6.6"
          stroke="rgba(60,45,25,0.5)"
          strokeWidth={0.55}
          fill="none"
        />
        <path
          d="M 9.2 7 Q 16 4.8, 20.4 5.6"
          stroke="rgba(60,45,25,0.5)"
          strokeWidth={0.55}
          fill="none"
        />
        <path
          d="M 9 13.5 Q 16 11.5, 20.4 6.6"
          stroke="rgba(60,45,25,0.5)"
          strokeWidth={0.55}
          fill="none"
        />
        <path
          d="M -9.4 6.2 Q 0 4.6, 9.4 6.2 L 9 13.8 Q 5 16.4, 0 16.6 Q -5 16.4, -9 13.8 Z"
          fill="#ebe5d6"
          stroke="rgba(80,55,20,0.3)"
          strokeWidth={0.45}
        />
        <g stroke="rgba(80,55,20,0.16)" strokeWidth={0.5} fill="none">
          <path d="M -7.8 8.6 Q 0 7.6, 7.8 8.6" />
          <path d="M -8 11 Q 0 10.2, 8 11" />
          <path d="M -7 13.4 Q 0 12.8, 7 13.4" />
        </g>
      </g>
    );
  }
  /* Gold studs — `earrings` is both ears; sides are viewer-named. */
  if (accessory === 'earrings') {
    return (
      <>
        {stud(-20)}
        {stud(20)}
      </>
    );
  }
  if (accessory === 'earring-left') return stud(-20);
  if (accessory === 'earring-right') return stud(20);
  // Hair-zone accessories hide while a hat is worn, same as hair —
  // a flower tucked into a hood would float in fabric.
  if (accessory === 'flower' && !hasHat) {
    return (
      <g>
        {[0, 72, 144, 216, 288].map((a) => (
          <ellipse
            key={a}
            transform={`translate(-15.5 -9) rotate(${a})`}
            cx={0}
            cy={-2.2}
            rx={1.5}
            ry={2.1}
            fill="#f3ecd8"
            stroke="rgba(60,40,15,0.3)"
            strokeWidth={0.3}
          />
        ))}
        <circle cx={-15.5} cy={-9} r={1.6} fill="#d2a350" />
      </g>
    );
  }
  if (accessory === 'hairclip' && !hasHat) {
    return (
      <g transform="translate(15.8 -8) rotate(-24)">
        <rect
          x={-2.6}
          y={-1.7}
          width={5.2}
          height={1.15}
          rx={0.55}
          fill="#d8b35a"
          stroke="#7a5a18"
          strokeWidth={0.3}
        />
        <rect
          x={-2.6}
          y={0.55}
          width={5.2}
          height={1.15}
          rx={0.55}
          fill="#d8b35a"
          stroke="#7a5a18"
          strokeWidth={0.3}
        />
      </g>
    );
  }
  if (accessory === 'headband' && !hasHat) {
    return (
      /* Sweatband across the forehead, over the fringe, tied to the
         outfit via the shirt accent. */
      <path
        d="M -20.6 -4.2 Q 0 -9.4, 20.6 -4.2 L 20.6 -1.4 Q 0 -6.4, -20.6 -1.4 Z"
        fill={ctx.shirtAccentFill ?? shirtAccent}
        stroke="rgba(0,0,0,0.2)"
        strokeWidth={0.4}
      />
    );
  }
  if (accessory === 'bowtie') {
    return (
      /* Sits just below the chin on the chest. */
      <g stroke="rgba(0,0,0,0.28)" strokeWidth={0.4} strokeLinejoin="round">
        <path d="M -1.4 25 L -7 22 L -7 28 Z" fill={ctx.shirtAccentFill ?? shirtAccent} />
        <path d="M 1.4 25 L 7 22 L 7 28 Z" fill={ctx.shirtAccentFill ?? shirtAccent} />
        <rect
          x={-1.6}
          y={23.4}
          width={3.2}
          height={3.2}
          rx={0.8}
          fill={ctx.shirtAccentFill ?? shirtAccent}
        />
        <rect
          x={-1.6}
          y={23.4}
          width={3.2}
          height={3.2}
          rx={0.8}
          fill="rgba(0,0,0,0.18)"
          stroke="none"
        />
      </g>
    );
  }
  if (accessory === 'necklace') {
    return (
      <g>
        <path d="M -13.5 20.5 Q 0 29.5, 13.5 20.5" fill="none" stroke="#9a7a30" strokeWidth={0.7} />
        <circle cx={0} cy={26.8} r={1.9} fill="#d8b35a" stroke="#7a5a18" strokeWidth={0.4} />
        <circle cx={-0.5} cy={26.2} r={0.6} fill="rgba(255,240,200,0.9)" />
      </g>
    );
  }
  if (accessory === 'brooch') {
    return (
      /* Small gold pin on the viewer-left chest. */
      <g>
        <circle cx={-8.5} cy={24.5} r={2.3} fill="#d8b35a" stroke="#7a5a18" strokeWidth={0.45} />
        <circle cx={-8.5} cy={24.5} r={0.95} fill="#f4e7c0" />
      </g>
    );
  }
  return renderAdditionalAccessory(accessory, ctx);
}

export type ItemSlot = 'hat' | 'dress' | 'accessory';

/** Draw a single worn item by slot, including the hood. */
function renderItem(slot: ItemSlot, option: string, ctx: ItemCtx): JSX.Element | null {
  if (slot === 'hat') {
    return option === 'hood' ? renderHood(ctx) : renderHatCrown(option as HatOption, ctx);
  }
  if (slot === 'dress') return renderDress(option as DressOption, ctx);
  return renderAccessory(option as AccessoryOption, ctx);
}

// Neutral palette for the standalone picker tiles — the items are shown out
// of context, so we pick generic warm tones rather than any one gezel's.
const NEUTRAL_SKIN = '#c8956a';
const NEUTRAL_SKIN2 = '#b07e54';
const NEUTRAL_SHIRT = '#7a9aa6';
const NEUTRAL_SHIRT_ACCENT = '#b0724c';
const NEUTRAL_L = resolveLayout(scaleFor('adult'));
const NEUTRAL_ARCH = archFor('tapered');
const NEUTRAL_FV = { eyeGap: 8, eyeY: 1.5 };

function neutralCtx(option: string): ItemCtx {
  return {
    fv: NEUTRAL_FV,
    L: NEUTRAL_L,
    arch: NEUTRAL_ARCH,
    // Vary felt by option so cap/beanie/etc. don't all share one color,
    // mirroring the figure's per-hat felt derivation.
    felt: feltForSkin(option.length * 7, NEUTRAL_SKIN, NEUTRAL_SKIN2),
    scarfFelt: feltForSkin(option.length * 7 + 23, NEUTRAL_SKIN, NEUTRAL_SKIN2),
    shirt: NEUTRAL_SHIRT,
    shirtAccent: NEUTRAL_SHIRT_ACCENT,
    hasHat: false,
  };
}

/**
 * Render one worn item in isolation, auto-cropped to its own art. Items live
 * in different coordinate zones (hats up top, jewelry on the chest), so we
 * draw the raw geometry, measure it with `getBBox`, then fit the viewBox to
 * the result — every tile shows its item centered and filling the frame,
 * with no per-item bounding boxes to maintain. In jsdom `getBBox` returns
 * zeros; the item simply renders uncropped (fine for tests).
 */
export function PoppetjeItem({
  slot,
  option,
  size = 56,
}: {
  slot: ItemSlot;
  option: string;
  size?: number;
}): JSX.Element {
  const gRef = useRef<SVGGElement>(null);
  const [viewBox, setViewBox] = useState<string | null>(null);
  const content = renderItem(slot, option, neutralCtx(option));

  // biome-ignore lint/correctness/useExhaustiveDependencies: (slot, option) is the re-measure trigger — the drawn art changes, so getBBox must re-run, even though the effect body doesn't read them.
  useLayoutEffect(() => {
    const g = gRef.current;
    if (!g) return;
    try {
      const b = g.getBBox();
      if (b.width > 0 && b.height > 0) {
        const m = 2.5; // getBBox excludes stroke; pad so strokes aren't clipped
        setViewBox(`${b.x - m} ${b.y - m} ${b.width + m * 2} ${b.height + m * 2}`);
      }
    } catch {
      // getBBox throws in non-rendering environments — leave uncropped.
    }
  }, [slot, option]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox ?? '-30 -33 60 66'}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', overflow: 'visible', opacity: viewBox ? 1 : 0 }}
      aria-hidden="true"
    >
      <g ref={gRef}>{content}</g>
    </svg>
  );
}
