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

  it('renders an explicit empty state without fabricating a selection', () => {
    const output = renderToString(
      <Picker title="Empty" items={[]} onSelect={() => {}} onCancel={() => {}} />,
    );
    expect(output).toContain('(nothing to choose)');
    expect(output).not.toContain('❯');
  });
});
