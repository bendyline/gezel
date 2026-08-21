/**
 * The Growth tab — a gezel's character sheet plus the level-up consent
 * loop. Everything shown here is honest state: XP comes from real
 * learning signals, trait proposals quote verbatim memory evidence, and
 * nothing changes the gezel without an explicit accept. Deliberately
 * calm: no streaks, no countdowns, skip is first-class.
 */

import type {
  GezelDetail as GezelDetailData,
  GezelGrowthResponse,
  GezelTrait,
  GrowthProposal,
  Poppetje as PoppetjeStruct,
} from '@bendyline/gezel';
import {
  CANONICAL_PROFILES,
  growthCosmeticById,
  isKnownProfileId,
  xpForLevel,
} from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { Poppetje } from '../poppetje/index.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { GezelIcon } from './GezelIcon.js';
import { LevelBadge } from './LevelBadge.js';
import {
  MEMORY_KIND_LABELS,
  celebrationKey,
  counterTiles,
  formatDay,
  proposalActionLabel,
  xpPercent,
} from './growth-format.js';
import { type UseGezelGrowth, useGezelGrowth } from './useGezelGrowth.js';

interface GrowthPanelProps {
  gezel: GezelDetailData;
  /** Called after a mutation that changed the gezel record itself. */
  onUpdated?: () => void;
}

export function GrowthPanel({ gezel, onUpdated }: GrowthPanelProps) {
  const g = useGezelGrowth(gezel.id, onUpdated);
  const [deferred, setDeferred] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [retiring, setRetiring] = useState<GezelTrait | null>(null);
  const [celebrating, setCelebrating] = useState(false);

  // One-shot celebration per (gezel, level) — latched in localStorage so
  // it never replays (and a queue of level-ups only flourishes once
  // each). CSS keeps the animation off under prefers-reduced-motion;
  // the render-time expression swap still happens (never persisted).
  const pendingToLevel = g.growth?.state.pendingLevelUp?.toLevel;
  useEffect(() => {
    if (pendingToLevel === undefined) return;
    const key = celebrationKey(gezel.id, pendingToLevel);
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, '1');
    } catch {
      /* private mode — celebrate anyway, it just may replay */
    }
    setCelebrating(true);
    const timer = setTimeout(() => setCelebrating(false), 1600);
    return () => clearTimeout(timer);
  }, [gezel.id, pendingToLevel]);

  if (g.error) {
    return (
      <section className="growth-panel" data-testid="growth-panel">
        <p className="error">Couldn't load growth: {g.error}</p>
      </section>
    );
  }
  if (!g.growth) {
    return (
      <section className="growth-panel" data-testid="growth-panel">
        <p className="placeholder">Loading growth…</p>
      </section>
    );
  }

  const { state, nextLevelXp, activeTraits, driftedTraitIds } = g.growth;
  const pending = state.pendingLevelUp;
  const floor = xpForLevel(state.level);
  const pct = xpPercent(state.xp, floor, nextLevelXp);
  const isEmpty = state.level === 1 && !pending && activeTraits.length === 0 && state.xp === 0;

  return (
    <section className="growth-panel" data-testid="growth-panel">
      {g.notice && (
        <output className="growth-notice">
          <span>{g.notice}</span>
          <button type="button" className="link-btn" onClick={g.clearNotice}>
            Dismiss
          </button>
        </output>
      )}

      {pending && deferred && (
        <div className="growth-deferred-reminder">
          <span>
            {gezel.name} reached level {pending.toLevel} — growth choices are waiting.
          </span>
          <button type="button" className="link-btn" onClick={() => setDeferred(false)}>
            Show choices
          </button>
        </div>
      )}

      {pending && !deferred && (
        <LevelUpBanner
          gezel={gezel}
          growth={g}
          onDefer={() => setDeferred(true)}
          onSkip={() => setConfirmSkip(true)}
        />
      )}

      <header className="growth-header">
        <span className={`level-badge-anchor${celebrating ? ' growth-celebrate' : ''}`}>
          <GezelIcon
            svg={gezel.icon ?? null}
            poppetje={
              celebrating && gezel.poppetje
                ? { ...gezel.poppetje, expression: 'wider' }
                : gezel.poppetje
            }
            iconOverride={gezel.iconOverride}
            name={gezel.name}
            size={96}
          />
          <LevelBadge level={state.level} pending={!!pending} overlay />
        </span>
        <div className="growth-header-text">
          <h4>
            {gezel.name} · Level {state.level}
          </h4>
          <div
            className="growth-xp-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={`${state.xp} XP — ${nextLevelXp} needed for level ${state.level + 1}`}
            tabIndex={-1}
          >
            <div className="growth-xp-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="muted small">
            {state.xp} XP · {Math.max(0, nextLevelXp - state.xp)} to level {state.level + 1}
          </span>
        </div>
        <button
          type="button"
          className="link-btn growth-refresh"
          disabled={g.refreshing}
          title="Recompute XP from memories, lessons, and task work now"
          onClick={() => void g.refresh()}
        >
          {g.refreshing ? 'Checking…' : 'Check growth now'}
        </button>
      </header>

      {isEmpty ? (
        <div className="growth-empty">
          <p>
            Growth here is earned, not simulated — every point comes from real work. As {gezel.name}{' '}
            accumulates distinct memories, distills lessons, and completes tasks, XP adds up; at
            each level you'll choose how they grow.
          </p>
          <div className="growth-trait-ghost" aria-hidden="true">
            Trait slot · unlocks at Level 2
          </div>
        </div>
      ) : (
        <div className="growth-counters">
          {counterTiles(state.signals).map((tile) => (
            <div key={tile.label} className="growth-counter" title={tile.hint}>
              <span className="growth-counter-value">{tile.value}</span>
              <span className="growth-counter-label">{tile.label}</span>
            </div>
          ))}
        </div>
      )}

      {driftedTraitIds.length > 0 && (
        <p className="growth-drift-warning">
          {driftedTraitIds.length === 1 ? 'One adopted trait is' : 'Some adopted traits are'} no
          longer in {gezel.name}'s frontmatter — likely lost to a manual gezel.md edit. Re-adopt
          from a future level-up, or edit the frontmatter directly.
        </p>
      )}

      {activeTraits.length > 0 && (
        <div className="growth-traits">
          <h5>Traits</h5>
          {activeTraits.map((trait) => {
            const record = state.adoptedTraits.find((r) => r.traitId === trait.id && !r.removedAt);
            return (
              <details key={trait.id} className="growth-trait">
                <summary>
                  <span className="growth-trait-text">{trait.text}</span>
                  <span className="muted small">
                    {' '}
                    · adopted {formatDay(trait.adoptedAt.slice(0, 10))}
                  </span>
                </summary>
                {record && record.evidence.length > 0 && (
                  <div className="growth-trait-evidence">
                    {record.evidence.map((ev) => (
                      <blockquote key={`${ev.day}-${ev.excerpt.slice(0, 24)}`}>
                        “{ev.excerpt}”
                        <footer>
                          <span className="growth-day-chip">{formatDay(ev.day)}</span>
                          <span className="growth-kind-chip">
                            {MEMORY_KIND_LABELS[ev.kind] ?? ev.kind}
                          </span>
                        </footer>
                      </blockquote>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="link-btn growth-retire"
                  disabled={g.busyId !== null}
                  onClick={() => setRetiring(trait)}
                >
                  Retire this trait
                </button>
              </details>
            );
          })}
        </div>
      )}

      {gezel.tuningProfile && isKnownProfileId(gezel.tuningProfile) && (
        <div className="growth-tuning">
          <h5>Tuning</h5>
          <span className="growth-tuning-chip">
            {CANONICAL_PROFILES[gezel.tuningProfile].label}
          </span>
        </div>
      )}

      {state.unlockedCosmetics.length > 0 && (
        <div className="growth-cosmetics">
          <h5>Unlocked</h5>
          <div className="growth-cosmetics-row">
            {state.unlockedCosmetics.map((u) => {
              const cosmetic = growthCosmeticById(u.id);
              return (
                <span key={u.id} className="growth-cosmetic-chip">
                  {cosmetic ? cosmetic.label : u.id.replace(/^level-(\d+)$/, 'Level $1 milestone')}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmSkip}
        title={`Skip level ${pending?.toLevel ?? state.level + 1}?`}
        message="The level still advances — it was earned — but these trait offers won't come back. The evidence stays in memory for future level-ups."
        confirmLabel="Skip this level"
        onConfirm={async () => {
          await g.skipLevel();
          setConfirmSkip(false);
        }}
        onCancel={() => setConfirmSkip(false)}
      />
      <ConfirmDialog
        open={retiring !== null}
        title="Retire this trait?"
        message={
          retiring ? (
            <>
              “{retiring.text}” will stop shaping {gezel.name}'s behavior. The adoption record and
              its evidence stay on the character sheet.
            </>
          ) : undefined
        }
        confirmLabel="Retire"
        danger
        onConfirm={async () => {
          if (retiring) await g.retireTrait(retiring.id);
          setRetiring(null);
        }}
        onCancel={() => setRetiring(null)}
      />
    </section>
  );
}

function LevelUpBanner({
  gezel,
  growth,
  onDefer,
  onSkip,
}: {
  gezel: GezelDetailData;
  growth: UseGezelGrowth;
  onDefer: () => void;
  onSkip: () => void;
}) {
  const pending = (growth.growth as GezelGrowthResponse).state.pendingLevelUp;
  if (!pending) return null;
  return (
    <div className="growth-levelup">
      <h4>
        {gezel.name} reached level {pending.toLevel}.
      </h4>
      <p className="muted">Pick one way to grow — or skip; the evidence isn't going anywhere.</p>
      <div className="growth-proposals">
        {pending.proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            gezel={gezel}
            busy={growth.busyId !== null}
            declinable={pending.proposals.length > 1}
            onAccept={() => void growth.accept(proposal.id)}
            onDecline={() => void growth.decline(proposal.id)}
          />
        ))}
      </div>
      <div className="growth-levelup-actions">
        <button type="button" className="link-btn" onClick={onDefer}>
          Decide later
        </button>
        <button type="button" className="link-btn" onClick={onSkip}>
          Skip this level
        </button>
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  gezel,
  busy,
  declinable,
  onAccept,
  onDecline,
}: {
  proposal: GrowthProposal;
  gezel: GezelDetailData;
  busy: boolean;
  declinable: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="growth-proposal-card" data-kind={proposal.kind}>
      <span className="growth-proposal-kind">{KIND_LABELS[proposal.kind]}</span>
      <h5>{proposal.title}</h5>
      {proposal.kind === 'trait' && (
        <>
          <p className="growth-proposal-trait-text">“{proposal.traitText}”</p>
          <div className="growth-trait-evidence">
            {proposal.evidence.map((ev) => (
              <blockquote key={`${ev.day}-${ev.excerpt.slice(0, 24)}`}>
                “{ev.excerpt}”
                <footer>
                  <span className="growth-day-chip">{formatDay(ev.day)}</span>
                  <span className="growth-kind-chip">{MEMORY_KIND_LABELS[ev.kind] ?? ev.kind}</span>
                </footer>
              </blockquote>
            ))}
          </div>
        </>
      )}
      {proposal.kind === 'tuning' && <p className="muted small">{proposal.description}</p>}
      {proposal.kind === 'cosmetic' && (
        <CosmeticTryOn poppetje={gezel.poppetje ?? null} cosmeticId={proposal.cosmeticId} />
      )}
      <div className="growth-proposal-actions">
        <button type="button" className="primary" disabled={busy} onClick={onAccept}>
          {proposalActionLabel(proposal)}
        </button>
        {declinable && (
          <button type="button" disabled={busy} onClick={onDecline}>
            Not this one
          </button>
        )}
      </div>
    </div>
  );
}

const KIND_LABELS: Record<GrowthProposal['kind'], string> = {
  trait: 'Trait',
  tuning: 'Tuning',
  cosmetic: 'Cosmetic',
};

/** 56px try-on render — the poppetje wearing the proposed item. */
function CosmeticTryOn({
  poppetje,
  cosmeticId,
}: {
  poppetje: PoppetjeStruct | null;
  cosmeticId: string;
}) {
  const cosmetic = growthCosmeticById(cosmeticId);
  if (!cosmetic || !poppetje) {
    return cosmetic ? <p className="muted small">{cosmetic.label}</p> : null;
  }
  const tryOn = { ...poppetje, [cosmetic.slot]: cosmetic.option } as PoppetjeStruct;
  return (
    <div className="growth-cosmetic-tryon">
      {/* A bare <Poppetje> paints its whole body — the SVG is
          overflow:visible and the variant only crops the viewBox — so this
          wrapper's clip is what makes the try-on a head-and-shoulders
          portrait instead of a figure spilling out of the card. */}
      <div className="growth-cosmetic-figure">
        <Poppetje poppetje={tryOn} variant="headshot" size={56} />
      </div>
      <span className="muted small">{cosmetic.label}</span>
    </div>
  );
}
