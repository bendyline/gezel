import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react';
import '../../styles/file-inspector.css';

/**
 * The inspector's share of the view, a fraction because the split is about
 * balance (docs/ux.md "Resizable splits"). Global, not per project, so the
 * pane opens the same width in every project.
 */
const FRACTION_STORAGE_KEY = 'gezel:file-inspector-fraction:v1';
const MIN_FRACTION = 0.28;
const MAX_FRACTION = 0.72;
const DEFAULT_FRACTION = 0.46;

function clampFraction(f: number): number {
  if (!Number.isFinite(f)) return DEFAULT_FRACTION;
  return Math.max(MIN_FRACTION, Math.min(MAX_FRACTION, f));
}

function readStoredFraction(): number {
  try {
    const raw = window.localStorage.getItem(FRACTION_STORAGE_KEY);
    return raw ? clampFraction(Number.parseFloat(raw)) : DEFAULT_FRACTION;
  } catch {
    return DEFAULT_FRACTION;
  }
}

/**
 * A view with the shared file inspector beside it on the right. Without an
 * inspector the view fills the space. In a compact layout the inspector
 * covers the view as a sheet with a way back, and the view stays mounted
 * underneath so its scroll, zoom and selection survive.
 */
export function InspectorLayout({
  main,
  inspector,
  compact = false,
  backLabel,
  onBack,
}: {
  main: ReactNode;
  inspector: ReactNode | null;
  compact?: boolean;
  /** Names the view the sheet returns to ("Village view"). */
  backLabel?: string;
  onBack?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [fraction, setFraction] = useState<number>(() => readStoredFraction());
  const drag = useRef<{ startX: number; startFraction: number; width: number } | null>(null);

  const commit = useCallback((next: number) => {
    const clamped = clampFraction(next);
    setFraction(clamped);
    try {
      window.localStorage.setItem(FRACTION_STORAGE_KEY, clamped.toFixed(4));
    } catch {
      /* private-mode storage — the split still works this session */
    }
  }, []);

  const onGripMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      drag.current = {
        startX: e.clientX,
        startFraction: fraction,
        width: rootRef.current?.clientWidth ?? 1,
      };
      document.body.classList.add('chat-rail-resizing');
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => {
        const st = drag.current;
        if (!st || st.width <= 0) return;
        // The inspector is on the right: moving left grows it.
        commit(st.startFraction - (ev.clientX - st.startX) / st.width);
      };
      const onUp = () => {
        drag.current = null;
        document.body.style.cursor = '';
        document.body.classList.remove('chat-rail-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [commit, fraction],
  );

  const onGripKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 0.08 : 0.02;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        commit(fraction + step);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        commit(fraction - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        commit(MIN_FRACTION);
      } else if (e.key === 'End') {
        e.preventDefault();
        commit(MAX_FRACTION);
      }
    },
    [commit, fraction],
  );

  return (
    <div
      ref={rootRef}
      className={`inspector-layout${compact ? ' is-compact' : ''}${inspector ? ' has-inspector' : ''}`}
      style={{ ['--inspector-fraction' as string]: `${(fraction * 100).toFixed(2)}%` }}
    >
      <div className="inspector-layout-main" aria-hidden={compact && inspector ? true : undefined}>
        {main}
      </div>
      {inspector && !compact && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file details"
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuemin={Math.round(MIN_FRACTION * 100)}
          aria-valuemax={Math.round(MAX_FRACTION * 100)}
          tabIndex={0}
          className="chat-rail-grip inspector-layout-grip"
          onMouseDown={onGripMouseDown}
          onKeyDown={onGripKeyDown}
        />
      )}
      {inspector && (
        <div className="inspector-layout-side">
          {compact && onBack && (
            <button type="button" className="inspector-layout-back" onClick={onBack}>
              ‹ {backLabel ?? 'Back'}
            </button>
          )}
          {inspector}
        </div>
      )}
    </div>
  );
}
