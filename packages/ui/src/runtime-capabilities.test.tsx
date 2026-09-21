import { OFFLINE_RUNTIME_CAPABILITIES, type RecentTabArea } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CapabilityUnavailable,
  runtimeCapabilities,
  supportsArea,
  supportsTab,
} from './runtime-capabilities.js';

const originalBridge = window.__GEZEL__;
afterEach(() => {
  window.__GEZEL__ = originalBridge;
});

describe('runtime capability navigation', () => {
  it('keeps desktop operations available regardless of viewport width', () => {
    window.__GEZEL__ = { token: 'test' };
    for (const area of [
      'projects',
      'gezels',
      'documents',
      'tasks',
      'scripts',
      'history',
      'knowledge',
      'settings',
    ] as RecentTabArea[]) {
      expect(supportsArea(area)).toBe(true);
    }
    expect(runtimeCapabilities().terminal).toBe(true);
  });

  it('preserves the same projects, crew, documents and settings with an offline host', () => {
    window.__GEZEL__ = {
      token: 'test',
      capabilities: { ...OFFLINE_RUNTIME_CAPABILITIES, tasks: false, scripts: false },
    };
    expect(
      ['projects', 'gezels', 'documents', 'settings'].map((area) =>
        supportsArea(area as RecentTabArea),
      ),
    ).toEqual([true, true, true, true]);
    for (const area of [
      'tasks',
      'craftbooks',
      'scripts',
      'history',
      'knowledge',
      'benchmarks',
    ] as RecentTabArea[]) {
      expect(supportsArea(area)).toBe(false);
    }
    expect(supportsTab({ kind: 'task', ref: 'p:1' } as never)).toBe(false);
    expect(supportsTab({ kind: 'project', id: 'p' } as never)).toBe(true);
    expect(supportsTab({ kind: 'document', path: 'brief.md' } as never)).toBe(true);
  });

  it('explains unsupported restored destinations without mounting their view', () => {
    render(<CapabilityUnavailable feature="Tasks" />);
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(
      screen.getByText('This feature is not available with the current runtime.'),
    ).toBeInTheDocument();
  });
});
