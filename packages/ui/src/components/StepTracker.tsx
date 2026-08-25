import type { DragEvent, KeyboardEvent, ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export type StepStatus = 'done' | 'active' | 'pending';

export interface StepTrackerStep {
  id: string;
  name: string;
}

/**
 * Per-step decoration for the `bench` variant — the workshop "bench
 * rail" look where each step is a peg (or a carved poppetje figure for the
 * active one) standing on a wooden rail, captioned with who's holding it.
 * Supplied by the task wrapper via {@link StepTrackerProps.stepOf};
 * design mode leaves it undefined and the bench falls back to plain pegs.
 */
export interface StepMeta {
  /** Marker to stand on the rail (e.g. a `<Poppetje>` for the active step). Omit → a CSS peg. */
  figure?: ReactNode;
  /** Who's on this step — name shown above the peg. */
  assigneeName?: string;
  /** Their role / relationship to the step, shown small under the name. */
  assigneeRole?: string;
  /**
   * Interactive assignee control (a `<select>`) rendered in the caption slot
   * instead of the static name/role — lets the user reassign the step inline.
   * When present it wins over {@link assigneeName}/{@link assigneeRole}.
   */
  assigneeControl?: ReactNode;
  /** Lifecycle word under the step name (e.g. "Signed off", "Active"). */
  statusWord?: string;
}

interface StepTrackerProps<T extends StepTrackerStep> {
  steps: T[];
  /** Which step the user has clicked on for viewing. */
  selectedStepId: string | null;
  onSelect: (stepId: string) => void;
  /** Per-step lifecycle status (task mode). Omit → every step renders "pending" (design mode). */
  statusOf?: (step: T, idx: number) => StepStatus;
  /** Craftbook design mode: mark the entry step with a small flag. */
  entryStepId?: string;
  /** Opens the add-step flow. Omit → no `+` affordance (read-only). */
  onAddStep?: () => void;
  /**
   * Enables drag + Alt+Arrow reordering. Receives the full id list in the
   * new order. Omit → steps are fixed (read-only / task lifecycle order).
   */
  onReorder?: (orderedIds: string[]) => void;
  busy?: boolean;
  ariaLabel?: string;
  addLabel?: string;
  /**
   * `compact` (default) is the original chain-of-circles tracker. `bench`
   * is the workshop rail used by tasks and craftbook design: numbered steps
   * with pegs/figures standing on a wooden beam, assignee captions above
   * and status words below. Pair with {@link stepOf} when those decorations
   * are available.
   */
  variant?: 'compact' | 'bench';
  /** Bench-variant decoration per step. Ignored in `compact`. */
  stepOf?: (step: T, idx: number) => StepMeta;
  /**
   * How a step reads to assistive tech. `tab` (default) is right where the
   * tracker switches a docked step panel. `button` is for a read-only
   * progress display whose steps merely lead somewhere else — it keeps the
   * tracker out of any surrounding tablist and marks the current step with
   * `aria-current`.
   */
  stepRole?: 'tab' | 'button';
  /**
   * `compact` only: wrap the chain in the horizontal-scroll scaffold the
   * bench always uses, instead of letting it wrap onto more rows. Pair with
   * a container that constrains the width (`min-width: 0`).
   */
  scroll?: boolean;
  /**
   * Keep this step scrolled to the middle of the viewport — "where am I"
   * stays readable without dragging. Only meaningful when scrolling.
   */
  centerStepId?: string | null;
  /**
   * Bench-only terminal marker pinned to the right end of the rail when the
   * whole task has finished — the task's own end state (not any step's).
   * `tone` picks the dot's color; `word` is the caption beneath it.
   */
  terminal?: { word: string; tone: 'complete' | 'canceled' };
}

/**
 * Horizontal-scroll scaffold shared by the bench and the scrolling compact
 * tracker. The viewport scrolls natively (so trackpad/wheel work) with its
 * native scrollbar hidden, and a synthetic thumb is mirrored ABOVE the
 * track — a bottom scrollbar would sever the selected step's connection to
 * the panel docked below it.
 */
function TrackerScroll({
  children,
  remeasureKey,
  centerStepId,
}: {
  children: ReactNode;
  /** Changes when the content width can have changed without the box resizing. */
  remeasureKey: number;
  /** Step to keep in the middle of the viewport. */
  centerStepId?: string | null;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ left: 0, client: 0, scroll: 0 });
  const max = Math.max(0, box.scroll - box.client);
  const overflowing = max > 1;
  const thumbFrac = box.scroll > 0 ? Math.min(1, box.client / box.scroll) : 1;
  const thumbLeftFrac = max > 0 ? box.left / max : 0;

  const measure = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    setBox({ left: vp.scrollLeft, client: vp.clientWidth, scroll: vp.scrollWidth });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies(remeasureKey): a step-count change alters scrollWidth without resizing the viewport box, so the ResizeObserver never fires for it — the extra dep IS the re-measure trigger.
  useLayoutEffect(() => {
    measure();
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [measure, remeasureKey]);

  // Re-centre when the step changes, when the content grows, or when the
  // viewport is resized — box.client is the resize signal. Matched against
  // the data attribute rather than a selector so a step id needs no escaping.
  // biome-ignore lint/correctness/useExhaustiveDependencies: neither the step count nor the viewport width is read here, but both change where the centred step sits — they ARE the re-centre triggers.
  useLayoutEffect(() => {
    if (!centerStepId) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const el = Array.from(vp.querySelectorAll<HTMLElement>('[data-step-id]')).find(
      (candidate) => candidate.dataset.stepId === centerStepId,
    );
    if (!el) return;
    const vpRect = vp.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = elRect.left + elRect.width / 2 - (vpRect.left + vpRect.width / 2);
    if (Math.abs(delta) > 1) vp.scrollLeft += delta;
  }, [centerStepId, remeasureKey, box.client]);

  const drag = useRef<{ x: number; left: number } | null>(null);
  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, left: box.left };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const vp = viewportRef.current;
    if (!d || !vp) return;
    const usable = box.client * (1 - thumbFrac);
    if (usable <= 0) return;
    vp.scrollLeft = d.left + ((e.clientX - d.x) / usable) * max;
  };
  const onThumbUp = () => {
    drag.current = null;
  };

  return (
    <div className="bench-scroll">
      {overflowing && (
        <div className="bench-scrollbar" aria-hidden="true">
          <div
            className="bench-scrollbar-thumb"
            style={{
              width: `${thumbFrac * 100}%`,
              left: `${thumbLeftFrac * (1 - thumbFrac) * 100}%`,
            }}
            onPointerDown={onThumbDown}
            onPointerMove={onThumbMove}
            onPointerUp={onThumbUp}
            onPointerCancel={onThumbUp}
          />
        </div>
      )}
      <div className="bench-viewport" ref={viewportRef} onScroll={measure}>
        {children}
      </div>
    </div>
  );
}

function statusGlyph(status: StepStatus): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'active':
      return '▶';
    case 'pending':
      return '';
  }
}

/**
 * Horizontal workflow tracker — Domino's-pizza-tracker style. Each step is
 * a circle badge connected to the next; an optional trailing `+` opens the
 * add-step flow. Generic over the step shape so both the task editor (with
 * lifecycle status via `statusOf`) and the craftbook editor (design mode,
 * no status, with drag-reorder via `onReorder`) render the same UI.
 *
 * Selection is view-only and orthogonal to status.
 */
export function StepTracker<T extends StepTrackerStep>({
  steps,
  selectedStepId,
  onSelect,
  statusOf,
  entryStepId,
  onAddStep,
  onReorder,
  busy = false,
  ariaLabel = 'Steps',
  addLabel = 'Add',
  variant = 'compact',
  stepOf,
  stepRole = 'tab',
  scroll = false,
  centerStepId,
  terminal,
}: StepTrackerProps<T>) {
  const dragId = useRef<string | null>(null);

  const move = (fromId: string, toId: string, placeAfter: boolean) => {
    if (!onReorder || fromId === toId) return;
    const ids = steps.map((s) => s.id).filter((id) => id !== fromId);
    const at = ids.indexOf(toId);
    if (at < 0) return;
    ids.splice(placeAfter ? at + 1 : at, 0, fromId);
    onReorder(ids);
  };

  const handleKey = (e: KeyboardEvent<HTMLElement>, idx: number) => {
    // Alt+Arrow reorders the focused step; bare Arrow moves the selection.
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    if (e.altKey && onReorder) {
      const target = steps[idx + delta];
      if (target) move(steps[idx]!.id, target.id, delta > 0);
      return;
    }
    const next = steps[idx + delta];
    if (next) onSelect(next.id);
  };

  // Drag-to-reorder wiring, shared by both variants' step buttons. Drop on
  // the left half of a target places before it, the right half after.
  const dndProps = (stepId: string) => ({
    draggable: onReorder != null && !busy,
    onDragStart: () => {
      dragId.current = stepId;
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (onReorder && dragId.current) e.preventDefault();
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      const from = dragId.current;
      dragId.current = null;
      if (from) {
        const rect = e.currentTarget.getBoundingClientRect();
        move(from, stepId, e.clientX > rect.left + rect.width / 2);
      }
    },
  });

  const stepTitle = (step: T, status: StepStatus, isEntry: boolean) =>
    `${step.name}${isEntry ? ' (entry step)' : ''}${
      status === 'active' ? ' (active)' : status === 'done' ? ' (completed)' : ''
    }${onReorder ? ' — drag or Alt+Arrow to reorder' : ''}`;

  if (variant === 'bench') {
    return (
      <TrackerScroll remeasureKey={steps.length} centerStepId={centerStepId}>
        <nav className="step-tracker step-bench" aria-label={ariaLabel} role="tablist">
          <span className="step-rail" aria-hidden="true" />
          {steps.length === 0 && (
            <span className="step-tracker-empty muted small">No steps yet —</span>
          )}
          {steps.map((step, idx) => {
            const status = statusOf ? statusOf(step, idx) : 'pending';
            const selected = step.id === selectedStepId;
            const isEntry = entryStepId != null && step.id === entryStepId;
            const meta = stepOf?.(step, idx) ?? {};
            const num = String(idx + 1).padStart(2, '0');
            const cls = [
              'bench-step',
              `status-${status}`,
              selected ? 'selected' : '',
              isEntry ? 'entry' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div key={step.id} className={cls} data-step-id={step.id}>
                <span className="bench-step-assignee">
                  {meta.assigneeControl ??
                    (meta.assigneeName && (
                      <>
                        <span className="bench-step-assignee-name">{meta.assigneeName}</span>
                        {meta.assigneeRole && (
                          <span className="bench-step-assignee-role">{meta.assigneeRole}</span>
                        )}
                      </>
                    ))}
                </span>
                <span className="bench-step-stage">
                  <button
                    type="button"
                    className="bench-step-marker"
                    onClick={() => onSelect(step.id)}
                    onKeyDown={(e) => handleKey(e, idx)}
                    disabled={busy}
                    role="tab"
                    aria-selected={selected}
                    {...dndProps(step.id)}
                    title={stepTitle(step, status, isEntry)}
                  >
                    {meta.figure ?? (
                      <span className="bench-peg" aria-hidden="true">
                        {status === 'done' ? '✓' : isEntry && status === 'pending' ? '▸' : ''}
                      </span>
                    )}
                  </button>
                </span>
                <button
                  type="button"
                  className="bench-step-foot"
                  onClick={() => onSelect(step.id)}
                  disabled={busy}
                  tabIndex={-1}
                  title={stepTitle(step, status, isEntry)}
                >
                  <span className="bench-step-num">{num}</span>
                  <span className="bench-step-name">{step.name}</span>
                  {meta.statusWord && <span className="bench-step-status">{meta.statusWord}</span>}
                </button>
              </div>
            );
          })}
          {onAddStep && (
            <div className="bench-step bench-step-add">
              <span className="bench-step-assignee" />
              <span className="bench-step-stage">
                <button
                  type="button"
                  className="bench-step-marker"
                  onClick={onAddStep}
                  disabled={busy}
                  title="Add a step"
                  aria-label="Add a step"
                >
                  <span className="bench-peg is-add" aria-hidden="true">
                    +
                  </span>
                </button>
              </span>
              <span className="bench-step-foot">
                <span className="bench-step-num" aria-hidden="true" />
                <span className="bench-step-name muted">{addLabel}</span>
              </span>
            </div>
          )}
          {terminal && (
            <div className={`bench-step bench-step-terminal terminal-${terminal.tone}`}>
              <span className="bench-step-assignee" />
              <span className="bench-step-stage">
                <span className="bench-peg bench-peg-terminal" aria-hidden="true">
                  {terminal.tone === 'complete' ? '✓' : '✕'}
                </span>
              </span>
              <span className="bench-step-foot">
                <span className="bench-step-num" aria-hidden="true" />
                <span className="bench-step-status">{terminal.word}</span>
              </span>
            </div>
          )}
        </nav>
      </TrackerScroll>
    );
  }

  // A tracker whose steps merely lead elsewhere is not a tablist, and must
  // not join the tablist of whatever surrounds it (the chat rail has one).
  const asTabs = stepRole === 'tab';
  const chain = (
    <nav
      className="step-tracker"
      aria-label={ariaLabel}
      {...(asTabs ? { role: 'tablist' } : { role: 'group' })}
    >
      {steps.length === 0 && <span className="step-tracker-empty muted small">No steps yet —</span>}
      {steps.map((step, idx) => {
        const status = statusOf ? statusOf(step, idx) : 'pending';
        const selected = step.id === selectedStepId;
        const isEntry = entryStepId != null && step.id === entryStepId;
        const stepCls = [
          'step-dot',
          `status-${status}`,
          selected ? 'selected' : '',
          isEntry ? 'entry' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <span key={step.id} className="step-dot-wrap" data-step-id={step.id}>
            <button
              type="button"
              className={stepCls}
              onClick={() => onSelect(step.id)}
              onKeyDown={(e) => handleKey(e, idx)}
              disabled={busy}
              {...(asTabs
                ? { role: 'tab' as const, 'aria-selected': selected }
                : { 'aria-current': selected ? ('step' as const) : undefined })}
              {...dndProps(step.id)}
              title={stepTitle(step, status, isEntry)}
            >
              <span className="step-dot-badge" aria-hidden="true">
                {isEntry && status === 'pending' ? '▸' : statusGlyph(status)}
              </span>
              <span className="step-dot-label">{step.name}</span>
            </button>
            {idx < steps.length - 1 && (
              <span className={`step-dot-connector status-${status}`} aria-hidden="true" />
            )}
          </span>
        );
      })}
      {onAddStep && (
        <>
          {steps.length > 0 && (
            <span className="step-dot-connector status-pending" aria-hidden="true" />
          )}
          <button
            type="button"
            className="step-dot step-dot-add"
            onClick={onAddStep}
            disabled={busy}
            title="Add a step"
            aria-label="Add a step"
          >
            <span className="step-dot-badge" aria-hidden="true">
              +
            </span>
            <span className="step-dot-label muted small">{addLabel}</span>
          </button>
        </>
      )}
    </nav>
  );

  if (!scroll) return chain;
  return (
    <TrackerScroll remeasureKey={steps.length} centerStepId={centerStepId}>
      {chain}
    </TrackerScroll>
  );
}
