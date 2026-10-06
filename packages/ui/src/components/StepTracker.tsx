import type { DragEvent, KeyboardEvent, ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export type StepStatus = 'done' | 'active' | 'pending';

export interface StepTrackerStep {
  id: string;
  name: string;
}

/**
 * Per-step decoration for the `bench` variant — connected circular stops,
 * captioned with who's holding each step.
 * Supplied by the task wrapper via {@link StepTrackerProps.stepOf};
 * design mode leaves it undefined and shows unfilled stops.
 */
export interface StepMeta {
  /** Optional portrait inside the active stop. */
  figure?: ReactNode;
  /** Who's on this step — name shown above the stop. */
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
   * with circular stops on a route, assignee captions above
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
 * tracker. The viewport supports horizontal wheel, trackpad, and drag scrolling with its
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState({ left: 0, client: 0, scroll: 0 });
  const centeredLayout = useRef<string | null>(null);
  const max = Math.max(0, box.scroll - box.client);
  const overflowing = max > 1;
  const thumbFrac = box.scroll > 0 ? Math.min(1, box.client / box.scroll) : 1;
  const thumbLeftFrac = max > 0 ? box.left / max : 0;

  const measure = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    let leading = 0;
    let trailing = 0;
    const track = vp.firstElementChild;
    const stops = track?.querySelectorAll<HTMLElement>('[data-step-id]');
    if (centerStepId && track && stops?.length) {
      const rect = track.getBoundingClientRect();
      const style = getComputedStyle(track);
      const leftPadding = Number.parseFloat(style.paddingLeft) || 0;
      const rightPadding = Number.parseFloat(style.paddingRight) || 0;
      if (rect.width - leftPadding - rightPadding > vp.clientWidth) {
        const first = stops[0]!.getBoundingClientRect();
        const last = stops[stops.length - 1]!.getBoundingClientRect();
        leading = Math.max(
          0,
          Math.round(vp.clientWidth / 2 - (first.left + first.width / 2 - rect.left - leftPadding)),
        );
        trailing = Math.max(
          0,
          Math.round(vp.clientWidth / 2 - (rect.right - rightPadding - last.left - last.width / 2)),
        );
      }
    }
    // Apply end spacing before measuring the target: a second React layout
    // pass can otherwise leave a reopened route at its unpadded offset.
    vp.style.setProperty('--tracker-leading-space', `${leading}px`);
    vp.style.setProperty('--tracker-trailing-space', `${trailing}px`);
    const target = Array.from(stops ?? []).find((stop) => stop.dataset.stepId === centerStepId);
    if (target) {
      const vpRect = vp.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const offset = rect.left + rect.width / 2 - vpRect.left + vp.scrollLeft;
      const layout = [centerStepId, vp.clientWidth, vp.scrollWidth, Math.round(offset)].join(':');
      if (layout !== centeredLayout.current) {
        vp.scrollLeft = offset - vp.clientWidth / 2;
        centeredLayout.current = layout;
      }
    } else {
      centeredLayout.current = null;
    }
    setBox({ left: vp.scrollLeft, client: vp.clientWidth, scroll: vp.scrollWidth });
  }, [centerStepId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(remeasureKey): a step-count change alters scrollWidth without resizing the viewport box, so the ResizeObserver never fires for it — the extra dep IS the re-measure trigger.
  useLayoutEffect(() => {
    measure();
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    // End spacing changes the border box without changing the content box.
    if (vp.firstElementChild) ro.observe(vp.firstElementChild, { box: 'border-box' });
    return () => ro.disconnect();
  }, [measure, remeasureKey]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const vp = viewportRef.current;
    if (!scroll || !vp) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? Number.parseFloat(getComputedStyle(vp).lineHeight) || 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? vp.clientWidth
            : 1;
      const left = Math.max(
        0,
        Math.min(vp.scrollWidth - vp.clientWidth, vp.scrollLeft + delta * unit),
      );
      if (Math.abs(left - vp.scrollLeft) < 0.5) return;
      event.preventDefault();
      event.stopPropagation();
      vp.scrollLeft = left;
    };
    // React's delegated wheel listener is passive; this listener must be able
    // to stop the surrounding page from scrolling when the route consumes it.
    scroll.addEventListener('wheel', onWheel, { passive: false });
    return () => scroll.removeEventListener('wheel', onWheel);
  }, []);

  const pan = useRef<{ x: number; left: number; pointerId: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const onPanDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    // Touch retains the browser's native swipe, momentum, and pinch zoom.
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const target = event.target as Element;
    if (
      target.closest(
        'select, input, textarea, a, [role="combobox"], [role="listbox"], [contenteditable="true"], [draggable="true"]',
      )
    )
      return;
    const vp = event.currentTarget;
    if (vp.scrollWidth <= vp.clientWidth) return;
    pan.current = {
      x: event.clientX,
      left: vp.scrollLeft,
      pointerId: event.pointerId,
      moved: false,
    };
  };
  const onPanMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = pan.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      onPanEnd(event);
      return;
    }
    const delta = event.clientX - current.x;
    if (!current.moved) {
      if (Math.abs(delta) < 6) return;
      current.moved = true;
      suppressClick.current = true;
      setPanning(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = current.left - delta;
  };
  const onPanEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointerId !== event.pointerId) return;
    pan.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const drag = useRef<{ x: number; left: number; ratio: number } | null>(null);
  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const vp = viewportRef.current;
    const track = e.currentTarget.parentElement;
    if (e.button !== 0 || !vp || !track) return;
    const usable = track.clientWidth - e.currentTarget.offsetWidth;
    if (usable <= 0) return;
    drag.current = {
      x: e.clientX,
      left: vp.scrollLeft,
      ratio: (vp.scrollWidth - vp.clientWidth) / usable,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const vp = viewportRef.current;
    if (!d || !vp) return;
    vp.scrollLeft = d.left + (e.clientX - d.x) * d.ratio;
  };
  const onThumbUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="bench-scroll" ref={scrollRef}>
      {overflowing && (
        <div className="bench-scrollbar" aria-hidden="true">
          <div
            className="bench-scrollbar-thumb"
            style={{
              width: `${thumbFrac * 100}%`,
              left: `calc((100% - max(28px, ${thumbFrac * 100}%)) * ${thumbLeftFrac})`,
            }}
            onPointerDown={onThumbDown}
            onPointerMove={onThumbMove}
            onPointerUp={onThumbUp}
            onPointerCancel={onThumbUp}
            onLostPointerCapture={onThumbUp}
          />
        </div>
      )}
      <div
        className={`bench-viewport${panning ? ' is-panning' : ''}`}
        ref={viewportRef}
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
        onLostPointerCapture={onPanEnd}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onScroll={(event) => {
          const left = event.currentTarget.scrollLeft;
          setBox((current) => ({ ...current, left }));
        }}
      >
        {children}
      </div>
    </div>
  );
}

function statusGlyph(status: StepStatus): ReactNode {
  switch (status) {
    case 'done':
      return (
        <svg viewBox="0 0 24 24" fill="none" className="step-stop-glyph" aria-hidden="true">
          <path
            d="m6 12 4 4 8-8"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'active':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="step-stop-glyph" aria-hidden="true">
          <path d="M9 5.5a1 1 0 0 1 1.5-.86l9 5.5a1 1 0 0 1 0 1.72l-9 5.5A1 1 0 0 1 9 16.5Z" />
        </svg>
      );
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

  const connectors = (idx: number) => ({
    'data-incoming': idx > 0 ? (statusOf?.(steps[idx - 1]!, idx - 1) ?? 'pending') : undefined,
    'data-outgoing':
      idx < steps.length - 1 || onAddStep || terminal
        ? (statusOf?.(steps[idx]!, idx) ?? 'pending')
        : undefined,
  });
  const lastStatus =
    steps.length > 0
      ? (statusOf?.(steps[steps.length - 1]!, steps.length - 1) ?? 'pending')
      : undefined;

  if (variant === 'bench') {
    return (
      <TrackerScroll remeasureKey={steps.length} centerStepId={centerStepId}>
        <nav className="step-tracker step-bench" aria-label={ariaLabel} role="tablist">
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
                <span className="bench-step-stage step-stop-stage" {...connectors(idx)}>
                  <button
                    type="button"
                    className="bench-step-marker"
                    onClick={() => onSelect(step.id)}
                    onKeyDown={(e) => handleKey(e, idx)}
                    disabled={busy}
                    role="tab"
                    aria-selected={selected}
                    aria-current={status === 'active' ? 'step' : undefined}
                    aria-label={stepTitle(step, status, isEntry)}
                    {...dndProps(step.id)}
                    title={stepTitle(step, status, isEntry)}
                  >
                    <span
                      className={`bench-peg step-stop${meta.figure ? ' step-stop-portrait' : ''}`}
                      aria-hidden="true"
                    >
                      {meta.figure ?? (isEntry && status === 'pending' ? '▸' : statusGlyph(status))}
                    </span>
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
              <span
                className="bench-step-stage step-stop-stage"
                data-incoming={lastStatus}
                data-outgoing={terminal ? 'pending' : undefined}
              >
                <button
                  type="button"
                  className="bench-step-marker"
                  onClick={onAddStep}
                  disabled={busy}
                  title="Add a step"
                  aria-label="Add a step"
                >
                  <span className="bench-peg step-stop is-add" aria-hidden="true">
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
              <span
                className="bench-step-stage step-stop-stage"
                data-incoming={onAddStep ? 'pending' : lastStatus}
              >
                <span className="bench-peg step-stop bench-peg-terminal" aria-hidden="true">
                  {terminal.tone === 'complete' ? statusGlyph('done') : '✕'}
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
              {...(asTabs ? { role: 'tab' as const, 'aria-selected': selected } : {})}
              aria-current={status === 'active' ? 'step' : undefined}
              {...dndProps(step.id)}
              title={stepTitle(step, status, isEntry)}
            >
              <span className="step-stop-stage" {...connectors(idx)}>
                <span className="step-dot-badge step-stop" aria-hidden="true">
                  {isEntry && status === 'pending' ? '▸' : statusGlyph(status)}
                </span>
              </span>
              <span className="step-dot-label">{step.name}</span>
              {status === 'active' && <span className="step-dot-status">Active</span>}
            </button>
          </span>
        );
      })}
      {onAddStep && (
        <span className="step-dot-wrap">
          <button
            type="button"
            className="step-dot step-dot-add"
            onClick={onAddStep}
            disabled={busy}
            title="Add a step"
            aria-label="Add a step"
          >
            <span className="step-stop-stage" data-incoming={lastStatus}>
              <span className="step-dot-badge step-stop is-add" aria-hidden="true">
                +
              </span>
            </span>
            <span className="step-dot-label muted small">{addLabel}</span>
          </button>
        </span>
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
