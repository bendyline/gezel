import { describe, expect, it } from 'vitest';
import type { HtmlPreviewLogEntry } from './HtmlPreviewFrame.js';
import {
  type HtmlCandidate,
  dataUrlToBlob,
  formatDebugFrame,
  formatPageScriptErrorDetails,
  looksLikePlaceholder,
  rankCandidates,
} from './ProjectOutputPane.js';

// The skeleton `index.html` a model left behind in the real
// "Space Shooter Arcade" project: comment-only canvas + script.
const STUB_INDEX = `<!DOCTYPE html><html><head><title>Space Shooter Arcade</title>
<style>/* Reset, body flex center, canvas styling */</style></head>
<body><canvas id="gameCanvas"></canvas>
<script>
  // Game logic here
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  // ... setup dimensions, state, event listeners, game loop
</script></body></html>`;

const REAL_GAME = `<!DOCTYPE html><html><head><style>body{margin:0;background:#000}</style></head>
<body><canvas id="gameCanvas"></canvas><script>
${'const x = Math.random();\n'.repeat(400)}
</script></body></html>`;

describe('looksLikePlaceholder', () => {
  it('flags empty / whitespace-only content', () => {
    expect(looksLikePlaceholder('')).toBe(true);
    expect(looksLikePlaceholder('   \n  ')).toBe(true);
  });

  it('flags a comment-only "logic here" skeleton', () => {
    expect(looksLikePlaceholder(STUB_INDEX)).toBe(true);
  });

  it('flags a script whose body is essentially empty', () => {
    expect(looksLikePlaceholder('<html><body><script>// todo\n</script></body></html>')).toBe(true);
  });

  it('does not flag a beefy real page that merely mentions a marker word', () => {
    const big = `<html><body><script>${'doThing();\n'.repeat(500)}// todo later</script></body></html>`;
    expect(big.length).toBeGreaterThan(2000);
    expect(looksLikePlaceholder(big)).toBe(false);
  });

  it('does not flag a substantive game page', () => {
    expect(looksLikePlaceholder(REAL_GAME)).toBe(false);
  });
});

describe('rankCandidates', () => {
  const cand = (over: Partial<HtmlCandidate>): HtmlCandidate => ({
    path: 'a.html',
    size: 1000,
    mtimeMs: 0,
    placeholder: false,
    ...over,
  });

  it('returns the lone candidate', () => {
    expect(rankCandidates([cand({ path: 'only.html' })])).toBe('only.html');
  });

  it('prefers the beefy real page over a stub index.html (the bug report)', () => {
    const picked = rankCandidates([
      cand({ path: 'index.html', size: 557, placeholder: true }),
      cand({ path: 'workspace/index.html', size: 14888, placeholder: false }),
    ]);
    expect(picked).toBe('workspace/index.html');
  });

  it('a non-placeholder always beats a larger placeholder', () => {
    const picked = rankCandidates([
      cand({ path: 'huge-stub.html', size: 50000, placeholder: true }),
      cand({ path: 'small-real.html', size: 900, placeholder: false }),
    ]);
    expect(picked).toBe('small-real.html');
  });

  it('breaks size ties toward the newer file', () => {
    const picked = rankCandidates([
      cand({ path: 'old.html', size: 5000, mtimeMs: 1000 }),
      cand({ path: 'new.html', size: 5000, mtimeMs: 9000 }),
    ]);
    expect(picked).toBe('new.html');
  });

  it('uses the index.html convention only as a final tiebreak', () => {
    const picked = rankCandidates([
      cand({ path: 'index.html', size: 5000, mtimeMs: 5000 }),
      cand({ path: 'other.html', size: 5000, mtimeMs: 5000 }),
    ]);
    expect(picked).toBe('index.html');
  });

  it('falls back to size/recency when every candidate is a placeholder', () => {
    const picked = rankCandidates([
      cand({ path: 'tiny.html', size: 100, placeholder: true }),
      cand({ path: 'bigger.html', size: 4000, placeholder: true }),
    ]);
    expect(picked).toBe('bigger.html');
  });
});

describe('formatDebugFrame', () => {
  const errorEntry = (over: Partial<HtmlPreviewLogEntry>): HtmlPreviewLogEntry => ({
    kind: 'error',
    detail: { message: 'boom' },
    url: 'http://localhost/preview/x',
    at: 0,
    ...over,
  });

  it('embeds the screenshot as a markdown image at the attachment path', () => {
    const md = formatDebugFrame('workspace/index.html', 'attachments/shot.png', []);
    expect(md).toContain(
      '![Screenshot of workspace file workspace/index.html](attachments/shot.png)',
    );
  });

  it('omits the browser-state section when there are no logs', () => {
    const md = formatDebugFrame('index.html', 'attachments/shot.png', []);
    expect(md).not.toContain('Browser state');
  });

  it('lists captured errors with message and location', () => {
    const md = formatDebugFrame('index.html', 'attachments/shot.png', [
      errorEntry({
        detail: { message: 'x is not defined', filename: 'app.js', lineno: 12, colno: 3 },
      }),
    ]);
    expect(md).toContain('1 console event(s)');
    expect(md).toContain('**error:** x is not defined');
    expect(md).toContain('app.js:12:3');
  });

  it('joins console.error args into the bullet message', () => {
    const md = formatDebugFrame('index.html', 'attachments/shot.png', [
      errorEntry({ kind: 'console.error', detail: { args: ['failed to load', '/data.json'] } }),
    ]);
    expect(md).toContain('**console.error:** failed to load /data.json');
  });
});

describe('formatPageScriptErrorDetails', () => {
  it('keeps the complete persisted run, logs, and call trace in the clipboard report', () => {
    const report = formatPageScriptErrorDetails({
      tool: 'user_move',
      response: {
        runId: 'run-126',
        status: 'error',
        callsSummary: [{ kind: 'fs.read', durationMs: 3 }],
        error: 'script exited with code 126',
      },
      run: {
        id: 'run-126',
        projectId: 'checkers',
        scriptName: 'game-store',
        startedAt: '2026-07-19T10:00:00.000Z',
        finishedAt: '2026-07-19T10:00:00.050Z',
        status: 'error',
        trigger: { kind: 'page', tool: 'user_move' },
        inputs: { action: 'user_move', from: 'a3', to: 'b4' },
        calls: [
          {
            at: '2026-07-19T10:00:00.010Z',
            kind: 'fs.read',
            argsSummary: 'game.json',
            durationMs: 3,
            error: 'permission denied',
          },
        ],
        logs: 'denyNet requires an enforceable OS network boundary',
        error: 'script exited with code 126',
      },
    });

    expect(report).toContain('# Gezel page script error');
    expect(report).toContain('Tool: user_move');
    expect(report).toContain('Run ID: run-126');
    expect(report).toContain('"scriptName": "game-store"');
    expect(report).toContain('denyNet requires an enforceable OS network boundary');
    expect(report).toContain('"kind": "fs.read"');
    expect(report).toContain('"from": "a3"');
  });
});

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL into a Blob with the right type and length', () => {
    // base64 "UE5H" decodes to 3 bytes (0x50 0x4e 0x47, i.e. "PNG").
    const blob = dataUrlToBlob('data:image/png;base64,UE5H');
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
  });

  it('falls back to octet-stream when the mime is absent', () => {
    expect(dataUrlToBlob('data:;base64,UE5H').type).toBe('application/octet-stream');
  });
});
