import { OFFLINE_RUNTIME_CAPABILITIES } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { consumeOpenFile } from './pending-open-file.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
const { api } = await import('../api.js');
const { MessageBubble } = await import('./chat-bubbles.js');
const originalBridge = window.__GEZEL__;

beforeEach(() => {
  vi.clearAllMocks();
  window.__GEZEL__ = { token: 'test', capabilities: OFFLINE_RUNTIME_CAPABILITIES };
  vi.mocked(api.writeProjectArtifactBinary).mockResolvedValue({
    ok: true,
    path: 'response.md',
  } as never);
});
afterEach(() => {
  window.__GEZEL__ = originalBridge;
  consumeOpenFile('field-notes');
});

function renderResponse() {
  return render(
    // biome-ignore lint/a11y/useValidAriaRole: This is the message author, not an ARIA role.
    <MessageBubble
      role="assistant"
      content={'# Field report\n\nA quiet morning.'}
      authorLabel="Ada"
      authorIcon={null}
      projectId="field-notes"
    />,
  );
}

describe('saving a chat response', () => {
  it('writes an artifact and opens it through the shared project file navigation', async () => {
    renderResponse();
    fireEvent.click(screen.getByRole('button', { name: 'Save response to project artifacts' }));
    const open = await screen.findByRole('button', {
      name: 'Open saved response in project artifacts',
    });
    expect(api.writeProjectArtifactBinary).toHaveBeenCalledOnce();
    const [projectId, path, body, type, options] = vi.mocked(api.writeProjectArtifactBinary).mock
      .calls[0]!;
    expect(projectId).toBe('field-notes');
    expect(path).toMatch(/^responses\/response-.*\.md$/);
    expect(body).toBeInstanceOf(Blob);
    expect(type).toBe('text/markdown');
    expect(options).toEqual({ createOnly: true });
    expect(screen.getByRole('status')).toHaveTextContent(
      `Response saved to project artifacts: ${path}`,
    );
    fireEvent.click(open);
    expect(consumeOpenFile('field-notes')).toEqual({
      projectId: 'field-notes',
      source: 'artifacts',
      path,
    });
  });

  it('preserves the response and offers retry after a failed save', async () => {
    vi.mocked(api.writeProjectArtifactBinary).mockRejectedValueOnce(new Error('Storage is full.'));
    renderResponse();
    fireEvent.click(screen.getByRole('button', { name: 'Save response to project artifacts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage is full.');
    expect(screen.getByText('A quiet morning.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open saved response in project artifacts' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save response to project artifacts' }));
    await waitFor(() => expect(api.writeProjectArtifactBinary).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole('button', { name: 'Open saved response in project artifacts' }),
    ).toBeInTheDocument();
  });
});
