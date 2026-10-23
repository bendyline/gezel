import { StartupHomeViewSchema } from '@bendyline/gezel';
import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createPromptDraft: vi.fn(),
  writePromptDraftContent: vi.fn(),
}));
vi.mock('../api.js', () => ({ api }));
vi.mock('../components/composer-drafts.js', () => ({ writeDraftText: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

it('coalesces repeated handoffs and reuses the saved draft when retrying edited text', async () => {
  const { saveStartupDraft } = await import('./handoff.js');
  api.createPromptDraft.mockResolvedValue({ id: 'startup-draft' });
  const state = StartupHomeViewSchema.parse({ draft: '  Keep this\nexactly.  ' });
  expect(
    await Promise.all([saveStartupDraft(state, 'vanya'), saveStartupDraft(state, 'vanya')]),
  ).toEqual(['startup-draft', 'startup-draft']);
  expect(api.createPromptDraft).toHaveBeenCalledTimes(1);
  expect(api.createPromptDraft).toHaveBeenCalledWith('default', {
    gezelId: 'vanya',
    sessionId: null,
    scope: 'meester',
    content: state.draft,
  });
  await saveStartupDraft({ ...state, draft: 'Edited while retrying' }, 'vanya');
  expect(api.writePromptDraftContent).toHaveBeenCalledWith(
    'default',
    'startup-draft',
    'Edited while retrying',
  );
});

it('propagates a failed save and allows the unchanged startup text to be retried', async () => {
  const { saveStartupDraft } = await import('./handoff.js');
  const state = StartupHomeViewSchema.parse({ draft: 'Keep me' });
  api.createPromptDraft.mockRejectedValueOnce(new Error('offline'));
  await expect(saveStartupDraft(state, 'vanya')).rejects.toThrow('offline');
  api.createPromptDraft.mockResolvedValue({ id: 'retry-draft' });
  await expect(saveStartupDraft(state, 'vanya')).resolves.toBe('retry-draft');
});
