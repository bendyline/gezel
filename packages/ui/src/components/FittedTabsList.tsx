import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Tabs, Tooltip } from '../primitives/index.js';
import { SectionIcon, type SectionIconName } from './SectionIcon.js';
import '../styles/fitted-tabs.css';

export interface FittedTab {
  value: string;
  label: string;
  icon: SectionIconName;
  disabled?: boolean;
  testId?: string;
}

/**
 * How much of each tab the row can afford: every label, only the current
 * tab's label beside its icon, or icons alone.
 */
export type TabFit = 'labels' | 'active-label' | 'icons';

type Face = 'label' | 'icon' | 'both';

const FACES: readonly Face[] = ['label', 'icon', 'both'];

/** Sub-pixel slack so a row that fits exactly is not collapsed by rounding. */
const FIT_EPSILON_PX = 0.5;

export function chooseTabFit(input: {
  available: number;
  gap: number;
  labelWidths: readonly number[];
  iconWidths: readonly number[];
  activeIndex: number;
  activeBothWidth: number;
}): TabFit {
  const { available, gap, labelWidths, iconWidths, activeIndex, activeBothWidth } = input;
  // Nothing measured (a hidden pane, jsdom): keep the labels rather than
  // collapsing a row nobody has laid out.
  if (available <= 0 || labelWidths.length === 0) return 'labels';
  const gaps = gap * (labelWidths.length - 1);
  const limit = available + FIT_EPSILON_PX;
  if (sum(labelWidths) + gaps <= limit) return 'labels';
  if (
    activeIndex >= 0 &&
    sum(iconWidths) - (iconWidths[activeIndex] ?? 0) + activeBothWidth + gaps <= limit
  ) {
    return 'active-label';
  }
  return 'icons';
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function faceFor(fit: TabFit, active: boolean): Face {
  if (fit === 'labels') return 'label';
  if (fit === 'active-label' && active) return 'both';
  return 'icon';
}

/**
 * A tab row that never needs a scrollbar to show where you can go: labels
 * while they fit, then icons with the current tab still named, then icons
 * alone. Must render inside a `Tabs.Root`.
 *
 * The fit is read from a hidden probe row that lays out every tab in all
 * three faces with the live triggers' own classes, so padding, type scale and
 * touch sizing come from the same CSS rules rather than a guess. Owner CSS
 * must style a face through the trigger's `data-face`, never through the
 * list's `data-fit`: the probes carry `data-face` too, and a rule keyed on
 * the current fit would make the measurement depend on its own answer.
 *
 * The label always stays in the trigger — visually hidden when iconified — so
 * a tab's accessible name never changes with the window width.
 */
export function FittedTabsList({
  items,
  value,
  ariaLabel,
  className,
  triggerClassName,
  onPreload,
}: {
  items: readonly FittedTab[];
  value: string;
  ariaLabel: string;
  className?: string;
  triggerClassName?: string;
  onPreload?: (value: string) => void;
}) {
  const probeRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<TabFit>('labels');
  const activeIndex = items.findIndex((item) => item.value === value);
  const countRef = useRef({ count: items.length, activeIndex });
  countRef.current = { count: items.length, activeIndex };

  const measure = useCallback(() => {
    const probe = probeRef.current;
    const list = probe?.parentElement;
    if (!probe || !list) return;
    const { count, activeIndex: active } = countRef.current;
    const style = getComputedStyle(list);
    const available =
      list.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0);
    const widthOf = (index: number, face: Face) =>
      probe
        .querySelector<HTMLElement>(`[data-probe-index="${index}"][data-face="${face}"]`)
        ?.getBoundingClientRect().width ?? 0;
    const indices = Array.from({ length: count }, (_, index) => index);
    const next = chooseTabFit({
      available,
      gap: Number.parseFloat(style.columnGap) || 0,
      labelWidths: indices.map((index) => widthOf(index, 'label')),
      iconWidths: indices.map((index) => widthOf(index, 'icon')),
      activeIndex: active,
      activeBothWidth: active >= 0 ? widthOf(active, 'both') : 0,
    });
    setFit((current) => (current === next ? current : next));
  }, []);

  useLayoutEffect(() => {
    const probe = probeRef.current;
    const list = probe?.parentElement;
    if (!probe || !list || typeof ResizeObserver === 'undefined') return;
    // Deferred a frame: collapsing the labels removes the overflow scrollbar,
    // which resizes the observed list inside its own notification.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(list);
    // The probe row resizes when web fonts land or a label changes, neither
    // of which moves the list's own box.
    if (probe.firstElementChild) observer.observe(probe.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure]);

  const signatureKey = items
    .map((item) => `${item.value}\u0000${item.label}\u0000${item.icon}`)
    .join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the probe row is re-rendered from these, so they are what can change the answer.
  useLayoutEffect(() => {
    measure();
  }, [measure, signatureKey, activeIndex]);

  const triggerClass = `fitted-tab${triggerClassName ? ` ${triggerClassName}` : ''}`;

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tabs.List
        aria-label={ariaLabel}
        className={`fitted-tabs${className ? ` ${className}` : ''}`}
        data-fit={fit}
      >
        {items.map((item) => {
          const face = faceFor(fit, item.value === value);
          return (
            <Tabs.Trigger
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              className={triggerClass}
              data-face={face}
              data-testid={item.testId}
              onPointerEnter={onPreload ? () => onPreload(item.value) : undefined}
              onFocus={onPreload ? () => onPreload(item.value) : undefined}
              onPointerDown={onPreload ? () => onPreload(item.value) : undefined}
            >
              <TabFace item={item} face={face} />
            </Tabs.Trigger>
          );
        })}
        <div ref={probeRef} className="fitted-tabs-probe" aria-hidden="true">
          <div className="fitted-tabs-probe-row">
            {items.flatMap((item, index) =>
              FACES.map((face) => (
                <span
                  key={`${item.value}:${face}`}
                  className={`gz-tabs-trigger ${triggerClass}`}
                  data-face={face}
                  data-probe-index={index}
                >
                  <span className="fitted-tab-face">
                    {face !== 'label' && (
                      <span className="fitted-tab-icon">
                        <SectionIcon name={item.icon} />
                      </span>
                    )}
                    {/* Generated text, so the probe adds no second copy of the
                        label for text queries or find-in-page to land on. */}
                    {face !== 'icon' && (
                      <span className="fitted-tab-label" data-text={item.label} />
                    )}
                  </span>
                </span>
              )),
            )}
          </div>
        </div>
      </Tabs.List>
    </Tooltip.Provider>
  );
}

/**
 * The tooltip hangs off the face, not the trigger: Radix's tooltip trigger
 * stamps its own `data-state` over the tab's `active`/`inactive`, which the
 * underline and scroll-into-view both read. Keyboard users get the name from
 * the visually hidden label instead.
 */
function TabFace({ item, face }: { item: FittedTab; face: Face }) {
  const [open, setOpen] = useState(false);
  const showHint = face === 'icon' && open;
  return (
    <Tooltip.Root open={showHint} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <span className="fitted-tab-face">
          {face !== 'label' && (
            <span className="fitted-tab-icon">
              <SectionIcon name={item.icon} />
            </span>
          )}
          <span className={face === 'icon' ? 'fitted-tab-label sr-only' : 'fitted-tab-label'}>
            {item.label}
          </span>
        </span>
      </Tooltip.Trigger>
      {showHint && <Tooltip.Content side="bottom">{item.label}</Tooltip.Content>}
    </Tooltip.Root>
  );
}
