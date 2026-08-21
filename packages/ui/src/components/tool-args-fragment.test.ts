import { describe, expect, it } from 'vitest';
import {
  decodeJsonEscapes,
  renderToolArgsFragment,
  scanToolArgsObject,
} from './tool-args-fragment.js';

describe('decodeJsonEscapes — a fragment cut anywhere inside a string value', () => {
  it('turns wire escapes back into the characters they encode', () => {
    expect(decodeJsonEscapes('Criterion 1: PASS\\n- Criterion 2: FAIL')).toBe(
      'Criterion 1: PASS\n- Criterion 2: FAIL',
    );
    expect(decodeJsonEscapes('remove claim \\"Risks increase\\"')).toBe(
      'remove claim "Risks increase"',
    );
    expect(decodeJsonEscapes('a\\tb\\r\\nc')).toBe('a\tb\r\nc');
    expect(decodeJsonEscapes('C:\\\\Users')).toBe('C:\\Users');
    expect(decodeJsonEscapes('caf\\u00e9')).toBe('café');
  });

  it('drops an escape the fragment cut in half rather than printing it', () => {
    expect(decodeJsonEscapes('line one\\')).toBe('line one');
    expect(decodeJsonEscapes('caf\\u00')).toBe('caf');
  });

  it('keeps an invalid escape verbatim — the model, not us, emitted it', () => {
    expect(decodeJsonEscapes('\\d+ matches')).toBe('\\d+ matches');
  });
});

describe('scanToolArgsObject — the head of an args object still streaming', () => {
  it('reads complete and partial pairs alike', () => {
    const fields = scanToolArgsObject('{"path":"review.md","content":"Criterion 1: PASS\\n- Cri');
    expect(fields).toEqual([
      { key: 'path', value: 'review.md' },
      { key: 'content', value: 'Criterion 1: PASS\n- Cri' },
    ]);
  });

  it('reads non-string values', () => {
    expect(scanToolArgsObject('{"start":12,"all":true,"targets":["a","b"]}')).toEqual([
      { key: 'start', value: '12' },
      { key: 'all', value: 'true' },
      { key: 'targets', value: '["a","b"]' },
    ]);
  });

  it('stops cleanly on a key cut mid-token', () => {
    expect(scanToolArgsObject('{"path":"a.md","cont')).toEqual([{ key: 'path', value: 'a.md' }]);
  });

  it('returns null when the fragment does not open an object', () => {
    expect(scanToolArgsObject('rion 2: FAIL\\n- Criterion 3')).toBeNull();
  });
});

describe('renderToolArgsFragment', () => {
  it('renders a file being written as the file, not as JSON', () => {
    const out = renderToolArgsFragment(
      '{"path":"powerpoint/task-11/review.md","content":"Criterion 1: PASS\\n- Criterion 2: FAIL\\n\\nOverall: FAIL"}',
    );
    expect(out).toBe(
      'path: powerpoint/task-11/review.md\n\ncontent:\nCriterion 1: PASS\n- Criterion 2: FAIL\n\nOverall: FAIL',
    );
    expect(out).not.toContain('\\n');
    expect(out).not.toContain('{"');
  });

  it('decodes a tail fragment that starts mid-string', () => {
    expect(renderToolArgsFragment('rion 5: PASS\\n- Criterion 6: PASS\\n\\nOverall: FAIL')).toBe(
      'rion 5: PASS\n- Criterion 6: PASS\n\nOverall: FAIL',
    );
  });

  it('keeps short values on the key line', () => {
    expect(renderToolArgsFragment('{"path":"a.md"}')).toBe('path: a.md');
  });

  it('is empty for an empty fragment', () => {
    expect(renderToolArgsFragment('')).toBe('');
    expect(renderToolArgsFragment('   ')).toBe('');
  });

  it('shows a bare opening brace rather than nothing', () => {
    expect(renderToolArgsFragment('{')).toBe('{');
  });
});
