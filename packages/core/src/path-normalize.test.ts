import { describe, expect, it } from 'vitest';
import { normalizeArtifactPath, normalizeRelativeToolPath } from './path-rules.js';

describe('normalizeRelativeToolPath', () => {
  it('reads a model path the way the desktop resolves it', () => {
    expect(normalizeRelativeToolPath('./')).toBe('');
    expect(normalizeRelativeToolPath('.')).toBe('');
    expect(normalizeRelativeToolPath('./src//app.ts')).toBe('src/app.ts');
    expect(normalizeRelativeToolPath('src/../README.md')).toBe('README.md');
    expect(normalizeRelativeToolPath('notes/')).toBe('notes');
    expect(normalizeRelativeToolPath('brief.md')).toBe('brief.md');
  });

  it('leaves escapes and absolute paths for the path rules to refuse', () => {
    expect(normalizeRelativeToolPath('../secret.txt')).toBe('../secret.txt');
    expect(normalizeRelativeToolPath('src/../../x')).toBe('src/../../x');
    expect(normalizeRelativeToolPath('/etc/passwd')).toBe('/etc/passwd');
  });
});

describe('normalizeArtifactPath', () => {
  it('drops the drawer name a model copies from listings', () => {
    expect(normalizeArtifactPath('artifacts/cabinet-note.md')).toBe('cabinet-note.md');
    expect(normalizeArtifactPath('./artifacts/artifacts/a.md')).toBe('a.md');
    expect(normalizeArtifactPath('/notes/a.md')).toBe('notes/a.md');
    expect(normalizeArtifactPath('reports/a.md')).toBe('reports/a.md');
  });
});
