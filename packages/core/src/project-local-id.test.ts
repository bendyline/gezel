import { describe, expect, it } from 'vitest';
import {
  PROJECT_GEZEL_LOCAL_ID,
  decodeProjectGezelId,
  encodeProjectGezelId,
  isCanonicalProjectGezelId,
  isProjectGezelId,
  projectGezelId,
} from './project-local-id.js';

describe('project-local gezel id codec', () => {
  it('round-trips a project and local id', () => {
    const id = encodeProjectGezelId('my-app', 'reviewer');
    expect(id).toBe('proj__my-app__reviewer');
    expect(decodeProjectGezelId(id)).toEqual({ projectId: 'my-app', localId: 'reviewer' });
    expect(isProjectGezelId(id)).toBe(true);
  });

  it('treats ordinary gezel ids as global', () => {
    for (const id of ['ada', 'proj-ada', 'project__x__y']) {
      expect(decodeProjectGezelId(id), id).toBeNull();
      expect(isProjectGezelId(id), id).toBe(false);
    }
  });

  it('rejects a prefixed id missing either half', () => {
    for (const id of ['proj__', 'proj__app', 'proj____local', 'proj__app__']) {
      expect(decodeProjectGezelId(id), id).toBeNull();
    }
  });

  it('splits on the first delimiter after the prefix', () => {
    expect(decodeProjectGezelId('proj__app__a__b')).toEqual({ projectId: 'app', localId: 'a__b' });
  });

  it('identifies the canonical @project gezel', () => {
    const canonical = projectGezelId('my-app');
    expect(decodeProjectGezelId(canonical)?.localId).toBe(PROJECT_GEZEL_LOCAL_ID);
    expect(isCanonicalProjectGezelId(canonical)).toBe(true);
    expect(isCanonicalProjectGezelId(encodeProjectGezelId('my-app', 'reviewer'))).toBe(false);
    expect(isCanonicalProjectGezelId('ada')).toBe(false);
  });
});
