import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { api } = await import('../api.js');
const promptAssist = vi.mocked(api.promptAssist);
const { useComposerPromptAssist } = await import('./useComposerPromptAssist.js');
const { ComposerReviewStrip } = await import('./ComposerSparkleMenu.js');

function setup(initial: string) {
  let text = initial;
  const replaceText = vi.fn((next: string) => {
    text = next;
  });
  const onError = vi.fn();
  const hook = renderHook(() =>
    useComposerPromptAssist({
      projectId: 'cards',
      gezelId: 'ada',
      imageModelId: 'flux-2-klein-4b-q4',
      getText: () => text,
      replaceText,
      onError,
    }),
  );
  return { hook, replaceText, onError, text: () => text };
}

describe('useComposerPromptAssist', () => {
  beforeEach(() => promptAssist.mockReset());

  it('puts a rewrite in the composer and undoes it', async () => {
    promptAssist.mockResolvedValue({ text: 'Please draft the deck by Friday.' });
    const { hook, replaceText, text } = setup('deck friday pls');
    await act(() => hook.result.current.run('clarify'));
    expect(promptAssist).toHaveBeenCalledWith(
      'cards',
      { action: 'clarify', text: 'deck friday pls', gezelId: 'ada' },
      expect.anything(),
    );
    expect(text()).toBe('Please draft the deck by Friday.');
    expect(hook.result.current.canUndo).toBe(true);
    act(() => hook.result.current.undo());
    expect(replaceText).toHaveBeenLastCalledWith('deck friday pls');
    expect(hook.result.current.canUndo).toBe(false);
  });

  it('keeps the person’s typing once they edit the rewrite', async () => {
    promptAssist.mockResolvedValue({ text: 'Shorter.' });
    const { hook } = setup('a much longer message');
    await act(() => hook.result.current.run('shorten'));
    act(() => hook.result.current.noteEdit('Shorter. And one more thing'));
    expect(hook.result.current.canUndo).toBe(false);
  });

  it('sends the image model only for an image rewrite, and reports a refusal', async () => {
    promptAssist.mockRejectedValueOnce(
      Object.assign(new Error('Gezel API error 422'), {
        details: {
          error: 'The model did not give back a usable answer. Your message is unchanged.',
        },
      }),
    );
    const { hook, onError, text } = setup('three red cubes');
    await act(() => hook.result.current.run('shape-image'));
    expect(promptAssist.mock.calls[0]?.[1]).toMatchObject({ imageModel: 'flux-2-klein-4b-q4' });
    expect(onError).toHaveBeenCalledWith(
      'The model did not give back a usable answer. Your message is unchanged.',
    );
    expect(text()).toBe('three red cubes');
  });

  it('says so quietly when the draft already reads well', async () => {
    promptAssist.mockResolvedValue({ text: 'a fox', unchanged: true });
    const { hook, replaceText } = setup('a fox');
    await act(() => hook.result.current.run('proofread'));
    expect(replaceText).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBe('Already reads well. Nothing changed.');
    act(() => hook.result.current.noteEdit('a fox in snow'));
    expect(hook.result.current.notice).toBeNull();
  });

  it('shows review suggestions and rewrites with them', async () => {
    promptAssist.mockResolvedValueOnce({ suggestions: ['Say who it is for'] });
    const { hook } = setup('make a deck');
    await act(() => hook.result.current.run('review'));
    render(<ComposerReviewStrip assist={hook.result.current} />);
    expect(screen.getByText('Say who it is for')).toBeInTheDocument();
    promptAssist.mockResolvedValueOnce({ text: 'Make a deck for the board.' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rewrite with these' }));
    });
    expect(promptAssist.mock.calls[1]?.[1]).toMatchObject({
      action: 'clarify',
      notes: ['Say who it is for'],
    });
  });
});
