import { Box, Text, useInput } from 'ink';
import { type JSX, useState } from 'react';

export interface PickerItem {
  label: string;
  value: string;
  hint?: string;
}

/**
 * Modal list selector used by `/project`, `/gezel`, `/model`, and `/task`. Arrow keys
 * move, Enter selects, Esc cancels. Rendered as an overlay above the feed;
 * owns keyboard focus while open (the prompt input is disabled).
 */
export function Picker(props: {
  title: string;
  items: ReadonlyArray<PickerItem>;
  initialValue?: string;
  /** Bound long inventories to the terminal while keeping every item reachable. */
  windowSize?: number;
  onSelect: (value: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { title, items, initialValue, windowSize, onSelect, onCancel } = props;
  const [index, setIndex] = useState(() => {
    const initialIndex = initialValue ? items.findIndex((item) => item.value === initialValue) : -1;
    return Math.max(initialIndex, 0);
  });
  const visibleCount = Math.max(1, Math.min(windowSize ?? items.length, items.length || 1));
  const start = Math.min(
    Math.max(0, index - Math.floor(visibleCount / 2)),
    Math.max(0, items.length - visibleCount),
  );
  const visibleItems = items.slice(start, start + visibleCount);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setIndex((i) => (i <= 0 ? Math.max(items.length - 1, 0) : i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i >= items.length - 1 ? 0 : i + 1));
      return;
    }
    if (key.return) {
      const chosen = items[index];
      if (chosen) onSelect(chosen.value);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {items.length === 0 ? (
        <Text dimColor>(nothing to choose)</Text>
      ) : (
        <>
          {start > 0 ? <Text dimColor> ↑ {start} more</Text> : null}
          {visibleItems.map((item, offset) => {
            const itemIndex = start + offset;
            return (
              <Text key={item.value} color={itemIndex === index ? 'green' : undefined}>
                {itemIndex === index ? '❯ ' : '  '}
                {item.label}
                {item.hint ? <Text dimColor> — {item.hint}</Text> : null}
              </Text>
            );
          })}
          {start + visibleItems.length < items.length ? (
            <Text dimColor> ↓ {items.length - start - visibleItems.length} more</Text>
          ) : null}
        </>
      )}
      <Text dimColor>↑/↓ move · Enter select · Esc cancel</Text>
    </Box>
  );
}
