import { Box, Text, useInput } from 'ink';
import { type JSX, useState } from 'react';

export interface PickerItem {
  label: string;
  value: string;
  hint?: string;
}

/**
 * Modal list selector used by `/project`, `/gezel`, and `/task`. Arrow keys
 * move, Enter selects, Esc cancels. Rendered as an overlay above the feed;
 * owns keyboard focus while open (the prompt input is disabled).
 */
export function Picker(props: {
  title: string;
  items: ReadonlyArray<PickerItem>;
  onSelect: (value: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { title, items, onSelect, onCancel } = props;
  const [index, setIndex] = useState(0);

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
        items.map((item, i) => (
          <Text key={item.value} color={i === index ? 'green' : undefined}>
            {i === index ? '❯ ' : '  '}
            {item.label}
            {item.hint ? <Text dimColor> — {item.hint}</Text> : null}
          </Text>
        ))
      )}
      <Text dimColor>↑/↓ move · Enter select · Esc cancel</Text>
    </Box>
  );
}
