import type { BangsOption, HairPart, HairShape } from '@bendyline/gezel';
import type { JSX } from 'react';

type StyledHair = Exclude<HairShape, 'bald' | 'shaved'>;
const LENGTHS = { bob: 21, medium: 31, long: 46, 'extra-long': 72 } as const;

/** Forehead edge runs from the right temple to the left. Building it into
 * the silhouette avoids a fringe pasted on top of a separately shaded cap. */
function forehead(bangs: BangsOption | null, part: HairPart): string {
  const split = part === 'left' ? -8 : part === 'right' ? 8 : 0;
  if (bangs === 'straight') {
    return 'C 11 -4, 6 -5, 3 -5 L 2 -7 L 1 -5 C -5 -4.5, -12 -5, -15 -6';
  }
  if (bangs === 'short') {
    return 'C 10 -11, 5 -11, 2 -11 L 1 -13 L 0 -11 C -7 -11, -12 -10, -15 -6';
  }
  if (bangs === 'side-swept') {
    return part === 'right'
      ? 'C 14 -14, 9 -16, 7 -16 C 5 -10, -3 -5, -12 -4 L -15 -6'
      : 'C 8 -3, -3 -6, -7 -16 C -11 -15, -14 -10, -15 -6';
  }
  if (bangs === 'curtain') {
    return `C 13 -1, ${split + 3} -7, ${split} -15 C ${split - 3} -7, -14 0, -15 -6`;
  }
  if (part !== 'none') {
    return `C 9 -12, ${split + 4} -12, ${split} -18 C ${split - 4} -13, -12 -12, -15 -6`;
  }
  return 'C 10 -14, -10 -14, -15 -6';
}

function outline(style: StyledHair, edge: string): string {
  if (style === 'braids') {
    return `M -23 7 C -23 -1, -25 -6, -22 -16 C -19 -25, -10 -28, -1 -28
      C 11 -28, 20 -22, 23 -13 C 25 -6, 24 0, 22 7
      C 25 10, 25 13, 23 15 C 25 18, 24 22, 22 23 C 24 27, 20 29, 20 30
      L 17.5 32 L 15.5 30 C 17 28, 15 26, 16.5 24 C 14 22, 14 18, 15.5 16
      C 13 13, 14 9, 16 6 C 18 3, 17 -3, 14 -7 ${edge}
      C -18 -1, -17 3, -16 7 C -13 10, -13 14, -15 16 C -13.5 18, -14 21, -16 23
      C -14.8 25, -16 28, -15 30 L -18 32 L -20.5 30
      C -19.5 28, -23 26, -21 23 C -24 21, -24.5 18, -23 15 C -25 13, -25 9, -23 7 Z`;
  }
  if (style === 'short' || style === 'bun' || style === 'halo') {
    const top = style === 'halo' ? 27 : 25.5;
    return `M -21 -2 C -23 -18, -12 -${top}, 0 -${top}
      C 12 -${top}, 23 -18, 21 -2 Q 17 -3, 14 -7 ${edge} Q -18 -3, -21 -2 Z`;
  }
  const end = LENGTHS[style];
  if (style === 'bob') {
    return `M -24 5 C -25 -8, -20 -27, -2 -28 C 16 -29, 25 -15, 25 3
      L 25 18 Q 23 23, 15 21 C 18 16, 16 8, 14 -7 ${edge}
      C -17 4, -16 15, -14 21 Q -24 24, -25 18 Z`;
  }
  return `M -24 13 C -25 2, -24 -8, -21 -17 C -18 -24, -11 -28, -2 -28
    C 10 -29, 20 -23, 23 -13 C 26 -4, 23 8, 24 17
    C 27 ${end - 10}, 22 ${end + 1}, 15 ${end}
    C 20 ${end - 8}, 18 ${end - 15}, 17 11 C 16 5, 17 -1, 14 -7 ${edge}
    C -18 1, -16 8, -18 15 C -21 ${end - 12}, -17 ${end - 4}, -14 ${end}
    C -23 ${end + 2}, -27 ${end - 7}, -24 13 Z`;
}

/** Crown, fringe and lengths are one carved form, lit in head coordinates.
 * Parts redirect the locks; they are never a line added to an unchanged cap. */
export function CarvedHair({
  style,
  bangs,
  part,
  id,
  fill,
  highlight,
  shadow,
  tie,
}: {
  style: StyledHair;
  bangs: BangsOption | null;
  part: HairPart;
  id: string;
  fill: string;
  highlight: string;
  shadow: string;
  tie: string;
}): JSX.Element {
  const edge =
    style === 'halo' && !bangs && part === 'none'
      ? 'Q 15 -1, 11 -5 Q 10 -9, 6 -7 Q 3 -6, 2 -11 Q -2 -7, -5 -10 Q -10 -5, -12 -7 Q -12 -2, -15 -6'
      : forehead(bangs, part);
  const silhouette = outline(style, edge);
  const split = part === 'left' ? -8 : part === 'right' ? 8 : 0;
  const end =
    style in LENGTHS ? LENGTHS[style as keyof typeof LENGTHS] : style === 'braids' ? 8 : -4;
  const loose = style in LENGTHS;
  // Unparted hair is brushed back at the temples, with no converging crown
  // channels that could accidentally read as a center part.
  const leftLight =
    part === 'none' ? 'M -18 -18 Q -23 -10, -21 1' : `M ${split - 4} -25 C -16 -22, -22 -12, -21 1`;
  const rightLight =
    part === 'none' ? 'M 18 -18 Q 22 -12, 21 -5' : `M ${split + 4} -25 C 13 -23, 20 -15, 21 -5`;
  const leftShade =
    part === 'none'
      ? 'M -18 -12 Q -20 -9, -18 -7'
      : `M ${split - 1} -24 C ${split - 6} -18, -16 -16, -18 -7`;
  const rightShade =
    part === 'none'
      ? 'M 18 -12 Q 20 -9, 17 -7'
      : `M ${split + 1} -23 C ${split + 6} -17, 15 -14, 17 -7`;
  return (
    <g>
      <defs>
        <clipPath id={`${id}-hair-clip`}>
          <path d={silhouette} />
        </clipPath>
      </defs>
      <path d={silhouette} fill={fill} />
      <g clipPath={`url(#${id}-hair-clip)`} fill="none" strokeLinecap="round">
        {part !== 'none' && (
          <>
            <path
              d={`M ${split * 0.65} -26 Q ${split - 0.5} -22, ${split} -18`}
              stroke={shadow}
              strokeWidth={0.85}
              opacity={0.7}
            />
            <path
              d={`M ${split * 0.65 + 1.1} -26 Q ${split + 1} -22, ${split + 1.1} -19`}
              stroke={highlight}
              strokeWidth={0.65}
              opacity={0.45}
            />
          </>
        )}
        <g stroke={highlight} strokeWidth={1.1} opacity={0.42}>
          <path d={`${leftLight} C -20 12, -24 ${end - 8}, -20 ${end - 3}`} />
          <path d={`${rightLight} C 22 7, 24 ${end - 10}, 20 ${end - 3}`} />
        </g>
        {bangs !== 'straight' && bangs !== 'short' && (
          <g stroke={shadow} strokeWidth={0.75} opacity={0.48}>
            <path d={`${leftShade} C -21 3, -18 ${end - 17}, -21 ${end - 8}`} />
            <path d={`${rightShade} C 20 1, 18 ${end - 18}, 20 ${end - 10}`} />
          </g>
        )}
        {loose && (
          <path
            d={`M -23 8 C -21 19, -26 ${end - 10}, -18 ${end - 1}`}
            stroke={highlight}
            strokeWidth={0.7}
            opacity={0.4}
          />
        )}
        {bangs && (
          <g stroke={shadow} strokeWidth={0.65} opacity={0.38}>
            {bangs === 'side-swept' ? (
              <path
                d={
                  part === 'right'
                    ? 'M 7 -22 C 5 -14, -3 -8, -12 -6'
                    : 'M -7 -22 C -5 -14, 3 -8, 12 -6'
                }
              />
            ) : bangs === 'curtain' ? (
              <path
                d={`M ${split - 2} -21 Q ${split - 4} -10, -14 -3 M ${split + 2} -21 Q ${split + 4} -10, 14 -3`}
              />
            ) : (
              [-9, -3, 5, 11].map((x) => (
                <path
                  key={x}
                  d={`M ${x * 0.75} -23 Q ${x} -17, ${x} ${bangs === 'short' ? -13 : -7}`}
                />
              ))
            )}
          </g>
        )}
        {style === 'braids' &&
          [-1, 1].map((side) => (
            <g key={side} transform={`scale(${side} 1)`}>
              <g stroke={shadow} strokeWidth={0.85} opacity={0.65}>
                <path d="M 15.8 7.5 C 17 10.1, 22 12, 23.3 14.2 M 15.8 15 C 17 17.5, 21.5 19, 22 22 M 16.8 23 C 17.7 25, 20.2 26, 20.3 28" />
              </g>
              <g stroke={highlight} strokeWidth={1} opacity={0.5}>
                <path d="M 22.5 8 C 21 10.6, 17 10.8, 15.8 13.4 M 22.5 15.3 C 21 17.5, 17.5 18, 16.2 20.5 M 21.3 23 C 20 25, 17.8 25.4, 17.2 27.5" />
              </g>
              <path
                d="M 16.4 28 Q 18.5 29.2, 20.5 27.8 L 20 30 Q 18.2 31.1, 16.4 30 Z"
                fill={tie}
              />
            </g>
          ))}
      </g>
      {style === 'bun' && (
        <>
          <ellipse cx={0} cy={-25.5} rx={7} ry={5.6} fill={fill} />
          <path
            d="M -4 -29 Q -6 -24, -2 -22 M 0 -30 Q -2 -26, 2 -23"
            fill="none"
            stroke={highlight}
            strokeWidth={0.7}
            opacity={0.45}
          />
          <ellipse cx={0} cy={-20.6} rx={4.6} ry={1.4} fill={tie} opacity={0.9} />
        </>
      )}
    </g>
  );
}
