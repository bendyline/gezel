import { Link } from 'react-router-dom';
import { modelColor } from '../data.js';
import type { Trial } from '../types.js';

interface Props {
  trials: Trial[];
  height?: number;
}

// SVG scatter of composite-over-time, colored by model. Hover for trial details.
// Unscored trials render as hollow rings on the x-axis so the gap is visible
// rather than silently dropped — that's important because "no postmortem"
// often IS the signal (someone forgot to score it).
export function TimelineChart({ trials, height = 220 }: Props) {
  const W = 900;
  const H = height;
  const PAD = { l: 36, r: 16, t: 12, b: 28 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const dated = trials
    .filter((t) => t.startedAt)
    .map((t) => ({ t, time: Date.parse(t.startedAt as string) }));
  if (dated.length === 0) return <div className="empty">No trials in range.</div>;

  const tMin = Math.min(...dated.map((d) => d.time));
  const tMax = Math.max(...dated.map((d) => d.time));
  const tSpan = Math.max(1, tMax - tMin);
  const xOf = (time: number) => PAD.l + ((time - tMin) / tSpan) * innerW;
  const yOf = (score: number) => PAD.t + innerH - (score / 10) * innerH;

  const yTicks = [0, 2, 4, 6, 8, 10];
  const xTicks: number[] = [];
  // ~5 evenly spaced ticks
  for (let i = 0; i <= 4; i++) xTicks.push(tMin + (tSpan * i) / 4);

  const models = [...new Set(trials.map((t) => t.modelId).filter(Boolean) as string[])];

  return (
    <div className="chartwrap">
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
      >
        <title>Score timeline</title>
        {/* y-axis gridlines + labels */}
        {yTicks.map((y) => (
          <g key={y}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yOf(y)} y2={yOf(y)} className="grid" />
            <text x={PAD.l - 6} y={yOf(y) + 3} className="axislabel" textAnchor="end">
              {y}
            </text>
          </g>
        ))}
        {/* band guides */}
        <line x1={PAD.l} x2={W - PAD.r} y1={yOf(8)} y2={yOf(8)} className="bandline band-ship" />
        <line x1={PAD.l} x2={W - PAD.r} y1={yOf(5)} y2={yOf(5)} className="bandline band-cap" />
        {/* x-axis labels */}
        {xTicks.map((t) => (
          <text key={t} x={xOf(t)} y={H - 8} className="axislabel" textAnchor="middle">
            {new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </text>
        ))}
        {/* points */}
        {dated.map(({ t, time }) => {
          const cx = xOf(time);
          if (t.composite == null) {
            return (
              <Link key={t.trialId} to={`/trial/${t.trialId}`}>
                <circle cx={cx} cy={H - PAD.b + 6} r={4} className="dot-unscored">
                  <title>{`${t.trialId}\n(${t.scenarioId} / ${t.modelId})\nunscored`}</title>
                </circle>
              </Link>
            );
          }
          const cy = yOf(t.composite);
          return (
            <Link key={t.trialId} to={`/trial/${t.trialId}`}>
              <circle
                cx={cx}
                cy={cy}
                r={t.success ? 6 : 5}
                fill={modelColor(t.modelId)}
                stroke={t.success ? '#000' : 'none'}
                strokeOpacity={0.3}
                strokeWidth={1}
                opacity={0.85}
              >
                <title>{`${t.trialId}\n${t.scenarioId} / ${t.modelId}\ncomposite ${t.composite} (${t.band ?? '—'})\n${t.success ? 'PASS' : (t.failureMode ?? 'FAIL')}`}</title>
              </circle>
            </Link>
          );
        })}
      </svg>
      <div className="legend">
        {models.map((m) => (
          <span key={m} className="legenditem">
            <span className="legendswatch" style={{ background: modelColor(m) }} />
            {m}
          </span>
        ))}
        <span className="legenditem">
          <span className="legendswatch legendswatch-empty" />
          unscored
        </span>
      </div>
    </div>
  );
}
