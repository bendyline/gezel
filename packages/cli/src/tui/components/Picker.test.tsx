import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { Picker } from './Picker.js';

const items = [
  { label: 'Alpha', value: 'alpha', hint: 'first' },
  { label: 'Beta', value: 'beta' },
  { label: 'Gamma', value: 'gamma' },
  { label: 'Delta', value: 'delta' },
];

describe('Picker', () => {
  it('selects and centers the requested initial value in a bounded window', () => {
    const output = renderToString(
      <Picker
        title="Choose one"
        items={items}
        initialValue="gamma"
        windowSize={2}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(output).toContain('Choose one');
    expect(output).toContain('↑ 1 more');
    expect(output).toContain('Beta');
    expect(output).toContain('❯ Gamma');
    expect(output).toContain('↓ 1 more');
    expect(output).not.toContain('Alpha — first');
  });

  it('heads each run of same-section items with one header', () => {
    const output = renderToString(
      <Picker
        title="Grouped"
        items={[
          { label: 'Joris', value: 'g1', section: 'In this project' },
          { label: 'Voorman', value: 't1', section: 'Core roles' },
          { label: 'Builder', value: 't2', section: 'Core roles' },
        ]}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(output).toContain('In this project');
    expect(output.match(/Core roles/g)).toHaveLength(1);
  });

  it('keeps selection indexed over items, not over the headers between them', () => {
    // Headers are decoration; a window of 2 must still show 2 selectable rows.
    const output = renderToString(
      <Picker
        title="Grouped"
        items={[
          { label: 'Alpha', value: 'a', section: 'One' },
          { label: 'Beta', value: 'b', section: 'Two' },
          { label: 'Gamma', value: 'c', section: 'Two' },
        ]}
        initialValue="b"
        windowSize={2}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(output).toContain('❯ Beta');
    // Two selectable rows for windowSize 2, even though two headers were also
    // drawn — the headers cost display rows, never window slots.
    expect(output).toContain('Alpha');
    expect(output).toContain('↓ 1 more');
  });

  it('renders an explicit empty state without fabricating a selection', () => {
    const output = renderToString(
      <Picker title="Empty" items={[]} onSelect={() => {}} onCancel={() => {}} />,
    );
    expect(output).toContain('(nothing to choose)');
    expect(output).not.toContain('❯');
  });
});
