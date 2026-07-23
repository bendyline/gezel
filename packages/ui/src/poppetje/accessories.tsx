import type { AccessoryOption } from '@bendyline/gezel';
import type { JSX } from 'react';

/** The subset of the full item context used by accessory-only geometry. */
export interface AdditionalAccessoryCtx {
  fv: { eyeGap: number; eyeY: number };
  shirtAccent: string;
  shirtAccentFill?: string;
  hasHat: boolean;
}

const GOLD = '#d8b35a';
const DARK_GOLD = '#76521b';
const INK = '#251c15';
const LINEN = '#eee4cf';

/**
 * The extended accessory catalog lives separately from the original set so
 * items.tsx stays readable. Coordinates are head-local: the face is centered
 * at 0/0 and the upper chest begins around y=20.
 */
export function renderAdditionalAccessory(
  accessory: AccessoryOption | null,
  ctx: AdditionalAccessoryCtx,
): JSX.Element | null {
  const { fv, hasHat, shirtAccent } = ctx;
  const accent = ctx.shirtAccentFill ?? shirtAccent;

  if (accessory === 'goggles') {
    return (
      <g>
        <path
          d={`M -21 ${fv.eyeY - 0.8} Q 0 ${fv.eyeY - 4.2}, 21 ${fv.eyeY - 0.8}`}
          fill="none"
          stroke="#5c4938"
          strokeWidth={2}
        />
        {[-fv.eyeGap, fv.eyeGap].map((cx) => (
          <g key={cx}>
            <circle cx={cx} cy={fv.eyeY} r={5.2} fill="rgba(174,204,205,0.38)" />
            <circle cx={cx} cy={fv.eyeY} r={5.2} fill="none" stroke={INK} strokeWidth={1.7} />
            <path
              d={`M ${cx - 2.8} ${fv.eyeY - 2.8} L ${cx - 0.7} ${fv.eyeY - 3.7}`}
              stroke="rgba(255,255,255,0.72)"
              strokeWidth={1.1}
              strokeLinecap="round"
            />
          </g>
        ))}
        <path
          d={`M ${-fv.eyeGap + 5.1} ${fv.eyeY} Q 0 ${fv.eyeY - 2.5}, ${fv.eyeGap - 5.1} ${fv.eyeY}`}
          fill="none"
          stroke={INK}
          strokeWidth={1.7}
        />
      </g>
    );
  }

  if (accessory === 'safety-glasses') {
    return (
      <g>
        <path
          d={`M -18 ${fv.eyeY - 4.1} Q 0 ${fv.eyeY - 6}, 18 ${fv.eyeY - 4.1} L 15.8 ${fv.eyeY + 4.4} Q 0 ${fv.eyeY + 6.1}, -15.8 ${fv.eyeY + 4.4} Z`}
          fill="rgba(190,225,229,0.45)"
          stroke="#536d72"
          strokeWidth={0.8}
        />
        <path
          d={`M -15.5 ${fv.eyeY - 2.8} Q -7 ${fv.eyeY - 4.2}, -1.5 ${fv.eyeY - 3.2}`}
          fill="none"
          stroke="rgba(255,255,255,0.78)"
          strokeWidth={1.25}
          strokeLinecap="round"
        />
        <path
          d={`M -21 ${fv.eyeY - 2.2} L -17.7 ${fv.eyeY - 2.2} M 17.7 ${fv.eyeY - 2.2} L 21 ${fv.eyeY - 2.2}`}
          stroke="#536d72"
          strokeWidth={1.2}
        />
      </g>
    );
  }

  if (accessory === 'pince-nez') {
    return (
      <g fill="rgba(255,255,255,0.16)" stroke="#48382a" strokeWidth={0.8}>
        <ellipse cx={-fv.eyeGap} cy={fv.eyeY + 0.4} rx={3.5} ry={2.8} />
        <ellipse cx={fv.eyeGap} cy={fv.eyeY + 0.4} rx={3.5} ry={2.8} />
        <path
          d={`M ${-fv.eyeGap + 3.4} ${fv.eyeY + 0.2} Q 0 ${fv.eyeY - 2}, ${fv.eyeGap - 3.4} ${fv.eyeY + 0.2}`}
          fill="none"
          strokeWidth={1.1}
        />
        <path
          d={`M ${fv.eyeGap + 3.4} ${fv.eyeY + 1.2} Q ${fv.eyeGap + 6.2} ${fv.eyeY + 7}, ${fv.eyeGap + 4.8} ${fv.eyeY + 12}`}
          fill="none"
          strokeWidth={0.45}
        />
      </g>
    );
  }

  if (accessory === 'headphones') {
    return (
      <g>
        <path
          d="M -20 -1 C -20 -24, -13 -29, 0 -29 C 13 -29, 20 -24, 20 -1"
          fill="none"
          stroke="#3d3733"
          strokeWidth={2.6}
          strokeLinecap="round"
        />
        <path
          d="M -18 -3 C -18 -21, -11 -26, 0 -26 C 11 -26, 18 -21, 18 -3"
          fill="none"
          stroke="rgba(255,255,255,0.24)"
          strokeWidth={0.8}
        />
        {[-20.5, 20.5].map((cx) => (
          <g key={cx}>
            <rect x={cx - 3.1} y={-4} width={6.2} height={13} rx={2.8} fill="#49413b" />
            <rect
              x={cx - 2}
              y={-1.7}
              width={4}
              height={8.4}
              rx={1.7}
              fill={accent}
              opacity={0.88}
            />
          </g>
        ))}
      </g>
    );
  }

  if (accessory === 'hearing-aid') {
    return (
      <g>
        <path
          d="M 20 -1 Q 24 -3, 24 1.5 Q 24 5, 21.5 7"
          fill="none"
          stroke="#a58263"
          strokeWidth={1.35}
          strokeLinecap="round"
        />
        <rect
          x={19.4}
          y={5.2}
          width={4.4}
          height={7.3}
          rx={2.1}
          fill="#b9a18a"
          stroke="#6f5947"
          strokeWidth={0.45}
        />
        <circle cx={21.6} cy={7.3} r={0.6} fill="#76543b" />
        <path d="M 20.5 12 Q 18.8 11, 18.7 8.8" fill="none" stroke="#8c745e" strokeWidth={0.55} />
      </g>
    );
  }

  if (accessory === 'nose-ring') {
    return (
      <g fill="none" stroke={GOLD} strokeWidth={1.1}>
        <path d="M -2.6 6.4 A 2.7 2.7 0 1 0 2.6 6.4" />
        <circle cx={-2.45} cy={6.1} r={0.65} fill={GOLD} stroke="none" />
        <circle cx={2.45} cy={6.1} r={0.65} fill={GOLD} stroke="none" />
      </g>
    );
  }

  if (accessory === 'hoop-earrings') {
    return (
      <g fill="none" stroke={GOLD} strokeWidth={1.15}>
        <ellipse cx={-20.5} cy={8.2} rx={3.1} ry={4.2} />
        <ellipse cx={20.5} cy={8.2} rx={3.1} ry={4.2} />
      </g>
    );
  }

  if (accessory === 'drop-earrings') {
    return (
      <g>
        {[-20, 20].map((cx) => (
          <g key={cx}>
            <circle cx={cx} cy={5.2} r={1.25} fill={GOLD} stroke={DARK_GOLD} strokeWidth={0.35} />
            <path d={`M ${cx} 6.4 L ${cx} 9.2`} stroke={DARK_GOLD} strokeWidth={0.65} />
            <path
              d={`M ${cx} 8.6 C ${cx - 2.4} 11.1, ${cx - 1.5} 14, ${cx} 14.2 C ${cx + 1.5} 14, ${cx + 2.4} 11.1, ${cx} 8.6 Z`}
              fill={accent}
              stroke={DARK_GOLD}
              strokeWidth={0.4}
            />
          </g>
        ))}
      </g>
    );
  }

  if (accessory === 'pearl-earrings') {
    return (
      <>
        {[-20, 20].map((cx) => (
          <g key={cx}>
            <circle cx={cx} cy={6.4} r={2.2} fill="#f3eee0" stroke="#8c806d" strokeWidth={0.45} />
            <circle cx={cx - 0.65} cy={5.7} r={0.65} fill="rgba(255,255,255,0.9)" />
          </g>
        ))}
      </>
    );
  }

  if (accessory === 'bandage') {
    return (
      <g transform="translate(-8.5 6.2) rotate(-12)">
        <rect
          x={-5.4}
          y={-1.9}
          width={10.8}
          height={3.8}
          rx={1.45}
          fill={LINEN}
          stroke="#8b7658"
          strokeWidth={0.45}
        />
        <rect x={-1.8} y={-1.45} width={3.6} height={2.9} rx={0.6} fill="#d9c9aa" />
        {[-3.8, 3.8].map((cx) => (
          <g key={cx} fill="#a99471">
            <circle cx={cx - 0.3} cy={-0.55} r={0.25} />
            <circle cx={cx + 0.35} cy={0.5} r={0.25} />
          </g>
        ))}
      </g>
    );
  }

  if (accessory === 'feather' && !hasHat) {
    return (
      <g transform="translate(16 -11) rotate(16)">
        <path
          d="M 0 10 C -5 3, -4 -8, 2 -16 C 8 -8, 7 2, 0 10 Z"
          fill={accent}
          stroke="#56412a"
          strokeWidth={0.45}
        />
        <path d="M 0 12 Q 1 -2, 2 -15" fill="none" stroke="#705736" strokeWidth={0.7} />
        <g stroke="rgba(255,255,255,0.45)" strokeWidth={0.5}>
          <path d="M 1 -9 L -2 -5 M 2 -6 L 6 -2 M 1 -2 L -3 2 M 1 2 L 5 5" />
        </g>
      </g>
    );
  }

  if (accessory === 'pencil' && !hasHat) {
    return (
      <g transform="translate(17 -5) rotate(-22)">
        <rect
          x={-1.7}
          y={-11}
          width={3.4}
          height={18}
          rx={0.6}
          fill="#dfa843"
          stroke="#74501e"
          strokeWidth={0.45}
        />
        <path
          d="M -1.7 -11 L 0 -15 L 1.7 -11 Z"
          fill="#d9b78d"
          stroke="#74501e"
          strokeWidth={0.4}
        />
        <path d="M -0.55 -13.7 L 0 -15 L 0.55 -13.7 Z" fill="#30251c" />
        <rect x={-1.7} y={5.4} width={3.4} height={2.8} rx={0.45} fill="#c77670" />
      </g>
    );
  }

  if (accessory === 'ribbon' && !hasHat) {
    return (
      <g
        transform="translate(-15.5 -8.5)"
        fill={accent}
        stroke="rgba(50,30,15,0.38)"
        strokeWidth={0.4}
      >
        <path d="M -1 0 C -8 -5, -9 3, -2 3.5 Z" />
        <path d="M 1 0 C 8 -5, 9 3, 2 3.5 Z" />
        <path d="M -1 2 L -4.8 9 L 0 6.5 L 4.8 9 L 1 2 Z" />
        <circle cx={0} cy={1.3} r={2.2} />
      </g>
    );
  }

  if (accessory === 'necktie') {
    return (
      <g fill={accent} stroke="rgba(45,30,20,0.4)" strokeWidth={0.45} strokeLinejoin="round">
        <path d="M -3.4 21.3 L 0 18.8 L 3.4 21.3 L 1.8 25 L -1.8 25 Z" />
        <path d="M -1.7 25 L 1.7 25 L 3 34 L 0 37 L -3 34 Z" />
        <path d="M -0.9 26 L 0.7 26 L 1.5 33" fill="none" stroke="rgba(255,255,255,0.3)" />
      </g>
    );
  }

  if (accessory === 'cravat') {
    return (
      <g fill={LINEN} stroke="#7f6a4d" strokeWidth={0.4} strokeLinejoin="round">
        <path d="M -9 20 Q 0 17, 9 20 L 5 24 Q 0 22, -5 24 Z" />
        <path d="M -5 23 Q 0 21, 5 23 L 3.8 28 Q 0 26, -3.8 28 Z" />
        <path d="M -3.5 27 Q 0 25, 3.5 27 L 2 33 L 0 35 L -2 33 Z" />
        <path d="M -5.5 22 Q 0 20.4, 5.5 22" fill="none" stroke="rgba(255,255,255,0.9)" />
      </g>
    );
  }

  if (accessory === 'bolo-tie') {
    return (
      <g>
        <path
          d="M -11 20 Q -5 24, -2 31 M 11 20 Q 5 24, 2 31"
          fill="none"
          stroke="#4a3020"
          strokeWidth={1.05}
        />
        <ellipse
          cx={0}
          cy={27.5}
          rx={3.7}
          ry={4.4}
          fill={GOLD}
          stroke={DARK_GOLD}
          strokeWidth={0.55}
        />
        <path d="M -1.8 26 Q 0 24.5, 1.8 26 Q 0 28.8, -1.8 26" fill={accent} />
        <path d="M -2 31 L -3.3 36 M 2 31 L 3.3 36" stroke="#4a3020" strokeWidth={0.8} />
      </g>
    );
  }

  if (accessory === 'lanyard') {
    return (
      <g>
        <path d="M -12 20 L -5 31 M 12 20 L 5 31" fill="none" stroke={accent} strokeWidth={1.25} />
        <circle cx={0} cy={29.7} r={1.1} fill="#554434" />
        <rect
          x={-4.4}
          y={31}
          width={8.8}
          height={6.3}
          rx={1.1}
          fill="#e9e3d5"
          stroke="#66584a"
          strokeWidth={0.45}
        />
        <rect x={-2.7} y={32.4} width={5.4} height={1.1} rx={0.4} fill={accent} />
        <path d="M -2.6 35.3 H 2.6" stroke="#9d9488" strokeWidth={0.55} />
      </g>
    );
  }

  if (accessory === 'medal') {
    return (
      <g>
        <path d="M -8 20 L -1.5 29 H 1.5 L 8 20" fill="none" stroke={accent} strokeWidth={2.1} />
        <circle cx={0} cy={30.2} r={4} fill={GOLD} stroke={DARK_GOLD} strokeWidth={0.6} />
        <path
          d="M 0 27.6 L 0.8 29.2 L 2.6 29.5 L 1.3 30.8 L 1.6 32.6 L 0 31.7 L -1.6 32.6 L -1.3 30.8 L -2.6 29.5 L -0.8 29.2 Z"
          fill="#f6df8d"
        />
      </g>
    );
  }

  if (accessory === 'pocket-square') {
    return (
      <g transform="translate(9.5 27)">
        <path
          d="M -4 1.5 L -3 -5 L 0 -2.4 L 2 -6 L 4 -2.1 L 4 1.5 Z"
          fill={LINEN}
          stroke="#75634c"
          strokeWidth={0.45}
          strokeLinejoin="round"
        />
        <path d="M -4 1.5 H 4" stroke="#5a4737" strokeWidth={0.8} />
        <path
          d="M -1.2 -1.6 L 0 -2.4 L 1.4 -1.1"
          fill="none"
          stroke="rgba(255,255,255,0.8)"
          strokeWidth={0.5}
        />
      </g>
    );
  }

  if (accessory === 'tool-pendant') {
    return (
      <g>
        <path d="M -13 20.5 Q 0 28, 13 20.5" fill="none" stroke="#72583d" strokeWidth={0.65} />
        <g transform="translate(0 29) rotate(-28)" fill={GOLD} stroke={DARK_GOLD} strokeWidth={0.4}>
          <rect x={-1.1} y={-1} width={2.2} height={8} rx={0.7} />
          <path d="M -4 -3 Q 0 -5, 4 -3 L 3.4 -0.8 Q 0 -2.3, -3.4 -0.8 Z" />
        </g>
      </g>
    );
  }

  return null;
}
