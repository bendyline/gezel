import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  content: '',
  input: {} as Record<string, unknown>,
  output: undefined as unknown,
}));
vi.mock('@bendyline/gezel-sdk', () => ({
  defineScript: (meta: unknown) => meta,
  gezel: {
    get input() {
      return state.input;
    },
    fs: { read: async () => state.content },
    output: (value: unknown) => {
      state.output = value;
    },
  },
}));
beforeEach(() => {
  vi.resetModules();
  state.input = {};
  state.output = undefined;
});

describe('checkHtmlGame script', () => {
  it('uses the shared DOM interaction floor', async () => {
    state.content = `<html><body><button id="choice">Choose</button><p id="status"></p><script>
const choice = document.getElementById('choice');
const status = document.getElementById('status');
let score = 0;
choice.addEventListener('click', () => { score += 1; status.textContent = String(score); });
</script></body></html>`;
    state.input = { minInlineJsBytes: 100 };
    await import('./checkHtmlGame.js');
    expect(state.output).toMatchObject({ decision: 'approve' });
  });
  it('explains the configured JavaScript floor without demanding a canvas', async () => {
    state.content = '<canvas></canvas><script>const score = 0;</script>';
    state.input = { minInlineJsBytes: 2000 };
    await import('./checkHtmlGame.js');
    expect(state.output).toMatchObject({
      decision: 'reject',
      message: expect.stringContaining('need >= 2000'),
    });
    expect((state.output as { message: string }).message).not.toContain('needs a <canvas>');
  });
});
