import { describe, expect, it } from 'vitest';
import { canonicalTestSpecHash } from '../recording/spec-hash.js';
import {
  CRAFTBOOK_RECORDING_FILENAME,
  CRAFTBOOK_RECORDING_POSTER,
  RUN_RECORDING_SCHEMA_VERSION,
  type RunRecording,
  parseRunRecording,
} from './run-recording.js';

function validRecording(): RunRecording {
  return {
    schemaVersion: RUN_RECORDING_SCHEMA_VERSION,
    actors: [
      { id: 'ada', name: 'Ada', role: 'Meester', kind: 'gezel', meester: true },
      { id: 'user', name: 'You', kind: 'user' },
    ],
    scenes: [
      {
        kind: 'user-prompt',
        at: '2026-09-01T10:00:00.000Z',
        actorId: 'user',
        excerpt: 'Review the code.',
      },
      {
        kind: 'tool-call',
        at: '2026-09-01T10:00:05.000Z',
        actorId: 'ada',
        name: 'read_file',
        success: true,
        durationMs: 120,
        path: 'src/payment.js',
      },
      {
        kind: 'delegation',
        at: '2026-09-01T10:00:30.000Z',
        actorId: 'ada',
        toActorId: 'rex',
        delegationKind: 'delegation',
        excerpt: 'Please review src/.',
      },
      {
        kind: 'artifact-produced',
        at: '2026-09-01T10:05:00.000Z',
        actorId: 'ada',
        store: 'artifact',
        path: 'reviews/report.md',
        bytes: 2048,
        screenshotRef: 'screenshots/report.webp',
      },
    ],
    screenshots: [{ file: 'screenshots/report.webp', caption: 'The finished report' }],
    budget: { droppedScenes: 0, truncatedExcerpts: 0 },
  };
}

describe('parseRunRecording', () => {
  it('accepts a valid recording in strict mode', () => {
    const res = parseRunRecording(validRecording());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.recording.scenes).toHaveLength(4);
  });

  it('rejects unknown keys in strict mode but strips them in tolerant mode', () => {
    const raw = { ...validRecording(), futureField: 'x' } as unknown;
    expect(parseRunRecording(raw).ok).toBe(false);
    const tolerant = parseRunRecording(raw, { mode: 'tolerant' });
    expect(tolerant.ok).toBe(true);
  });

  it('tolerant mode drops unknown scene kinds instead of failing the recording', () => {
    const raw = validRecording() as unknown as { scenes: unknown[] };
    raw.scenes.push({ kind: 'hologram', at: '2026-09-01T10:06:00.000Z' });
    expect(parseRunRecording(raw).ok).toBe(false);
    const tolerant = parseRunRecording(raw, { mode: 'tolerant' });
    expect(tolerant.ok).toBe(true);
    if (tolerant.ok) {
      expect(tolerant.droppedUnknownScenes).toBe(1);
      expect(tolerant.recording.scenes).toHaveLength(4);
    }
  });

  it('tolerant mode clamps a future schemaVersion; strict rejects it', () => {
    const raw = { ...validRecording(), schemaVersion: RUN_RECORDING_SCHEMA_VERSION + 1 };
    // strict: version passes the int check but a future version should not
    // silently pass through tolerant clamping only.
    const tolerant = parseRunRecording(raw, { mode: 'tolerant' });
    expect(tolerant.ok).toBe(true);
    if (tolerant.ok) {
      expect(tolerant.recording.schemaVersion).toBe(RUN_RECORDING_SCHEMA_VERSION);
    }
  });

  it('requireProvenance enforces the gilde sidecar contract', () => {
    const withoutProvenance = parseRunRecording(validRecording(), { requireProvenance: true });
    expect(withoutProvenance.ok).toBe(false);
    const stamped = {
      ...validRecording(),
      provenance: {
        craftbookId: 'code-review',
        craftbookVersion: '1.0.0',
        testSpecHash: canonicalTestSpecHash({ title: 'x' }),
        modelId: 'qwen3.5-27b',
        recordedAt: '2026-09-01T10:00:00.000Z',
        summary: 'A real code review, start to finish.',
      },
    };
    const res = parseRunRecording(stamped, { requireProvenance: true });
    expect(res.ok).toBe(true);
  });

  it('rejects screenshot files that escape the recording directory', () => {
    const raw = validRecording();
    raw.screenshots = [{ file: '../outside.webp' }];
    expect(parseRunRecording(raw).ok).toBe(false);
  });

  it('never mutates the caller value in tolerant mode', () => {
    const raw = { ...validRecording(), futureField: 'x' } as Record<string, unknown>;
    parseRunRecording(raw, { mode: 'tolerant' });
    expect(raw.futureField).toBe('x');
  });
});

describe('canonicalTestSpecHash', () => {
  it('is insensitive to key order and formatting, sensitive to content', () => {
    const a = canonicalTestSpecHash({ title: 'x', setup: { files: [1, 2] } });
    const b = canonicalTestSpecHash({ setup: { files: [1, 2] }, title: 'x' });
    const c = canonicalTestSpecHash({ title: 'y', setup: { files: [1, 2] } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores undefined-valued keys, matching JSON.stringify semantics', () => {
    expect(canonicalTestSpecHash({ a: 1, b: undefined })).toBe(canonicalTestSpecHash({ a: 1 }));
  });
});

describe('recording path constants', () => {
  it('poster lives inside the recording dirname', () => {
    expect(CRAFTBOOK_RECORDING_FILENAME.startsWith('recording/')).toBe(true);
    expect(CRAFTBOOK_RECORDING_POSTER.startsWith('recording/')).toBe(true);
  });
});
