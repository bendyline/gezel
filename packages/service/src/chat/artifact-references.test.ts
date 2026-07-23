import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import {
  extractReferencedArtifacts,
  findArtifactCandidates,
  matchReferencedArtifactsInContent,
} from './artifact-references.js';

describe('findArtifactCandidates', () => {
  it('pulls inline code spans', () => {
    const out = findArtifactCandidates('look at `index.html` and `about.html`');
    expect(out).toContain('index.html');
    expect(out).toContain('about.html');
  });

  it('pulls markdown link targets', () => {
    const out = findArtifactCandidates('see [the homepage](index.html) for details');
    expect(out).toContain('index.html');
  });

  it('skips fenced code blocks', () => {
    const out = findArtifactCandidates(
      '```html\n<link href="should-not-match.css">\n```\nActual `real.html`',
    );
    expect(out).not.toContain('should-not-match.css');
    expect(out).toContain('real.html');
  });
});

describe('matchReferencedArtifactsInContent (pure)', () => {
  it('resolves code-span basenames against the artifact list', () => {
    const refs = matchReferencedArtifactsInContent(
      'We built `index.html`, `catalog.html`, `about.html`.',
      ['index.html', 'catalog.html', 'about.html', 'styles/main.css'],
    );
    expect(refs).toEqual(['about.html', 'catalog.html', 'index.html']);
  });

  it('resolves exact relative paths', () => {
    const refs = matchReferencedArtifactsInContent('Update `styles/main.css` to match.', [
      'index.html',
      'styles/main.css',
    ]);
    expect(refs).toEqual(['styles/main.css']);
  });

  it('catches bare word-boundary mentions in prose (no backticks)', () => {
    const refs = matchReferencedArtifactsInContent(
      'The contact form lives in contact.html — styled by main.css.',
      ['contact.html', 'main.css'],
    );
    expect(refs).toEqual(['contact.html', 'main.css']);
  });

  it('drops ambiguous basenames (multiple artifacts share the name)', () => {
    const refs = matchReferencedArtifactsInContent('Check `Header.tsx`', [
      'components/Header.tsx',
      'routes/Header.tsx',
    ]);
    expect(refs).toEqual([]);
  });

  it('skips absolute URLs in markdown link targets', () => {
    const refs = matchReferencedArtifactsInContent(
      'See [docs](https://example.com/index.html) and `real.html`',
      ['real.html'],
    );
    expect(refs).toEqual(['real.html']);
  });

  it('returns [] when nothing matches', () => {
    const refs = matchReferencedArtifactsInContent('pure prose with no file references at all.', [
      'index.html',
    ]);
    expect(refs).toEqual([]);
  });

  it('dedupes repeated mentions', () => {
    const refs = matchReferencedArtifactsInContent(
      '`index.html` then `index.html` then index.html',
      ['index.html'],
    );
    expect(refs).toEqual(['index.html']);
  });

  it('handles empty artifact list', () => {
    const refs = matchReferencedArtifactsInContent('see `foo.html`', []);
    expect(refs).toEqual([]);
  });

  it('handles empty content', () => {
    const refs = matchReferencedArtifactsInContent('', ['foo.html']);
    expect(refs).toEqual([]);
  });

  it('ignores fenced code block contents as candidates', () => {
    const refs = matchReferencedArtifactsInContent(
      '```\n<script src="some.js"></script>\n```\nActual `real.css`',
      ['some.js', 'real.css'],
    );
    // `some.js` is inside a fence — the candidate extractor drops it,
    // but the bare-word scan on the full content still picks it up.
    // Both `real.css` and `some.js` are real artifacts, so both land.
    // This test documents the current behavior (content-wide scan
    // catches bare mentions even in fences). If the fence-skip needs
    // tightening later, update this expectation.
    expect(refs).toEqual(['real.css', 'some.js']);
  });
});

describe('extractReferencedArtifacts (with Store)', () => {
  let tmp: string;
  let store: Store;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gezel-refs-'));
    store = new Store({ home: tmp });
    await store.ensureLayout();
    await store.writeProjectArtifact('default', 'index.html', '<h1>Home</h1>');
    await store.writeProjectArtifact('default', 'about.html', '<h1>About</h1>');
    await store.writeProjectArtifact('default', 'styles/main.css', 'body{}');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('resolves real artifacts written to the project', async () => {
    const refs = await extractReferencedArtifacts(
      store,
      'default',
      'Built `index.html` and `about.html` with styles in `styles/main.css`.',
    );
    expect(refs).toEqual(['about.html', 'index.html', 'styles/main.css']);
  });

  it('returns [] when the project has no artifacts', async () => {
    const refs = await extractReferencedArtifacts(
      store,
      'empty-project',
      'Talks about `index.html`',
    );
    expect(refs).toEqual([]);
  });

  it('ignores mentions that do not match any real file', async () => {
    const refs = await extractReferencedArtifacts(
      store,
      'default',
      'We should add `imaginary.html` later.',
    );
    expect(refs).toEqual([]);
  });
});
