import { readFile } from 'node:fs/promises';
import { GezelClient } from '@bendyline/gezel-client';
import { expect, test } from './fixtures/test.js';

test.use({ daemonGroup: 'mobile-contracts', hasTouch: true });

test('native mobile question contract skips through Activity at phone width', async ({
  page,
  daemon,
  world,
}) => {
  test.skip(!world, 'requires the seeded world');
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  const projectId = world!.projectId;
  const gezelId = world!.gezelIds.ada;
  const session = await client.createChatSession({ projectId, gezelId });
  const question = await client.askUserQuestion({
    projectId,
    gezelId,
    sessionId: session.id,
    prompt: 'Which report format?',
    choices: ['Short', 'Detailed'],
    allowWriteIn: true,
  });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto('/');
  await expect(page.getByTestId('app-sidebar')).toBeAttached();
  await page.addStyleTag({
    content: await readFile(new URL('../../mobile/src/product-host.css', import.meta.url), 'utf8'),
  });
  await page.evaluate(({ baseURL, token }) => {
    document.documentElement.dataset.platform = 'ios';
    document.documentElement.style.setProperty('--safe-area-inset-top', '59px');
    document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px');
    Object.assign(window, {
      __GEZEL__: { baseUrl: baseURL, token, fetch: window.fetch.bind(window) },
    });
  }, daemon);
  for (const file of ['mobile-eval-clock.js', 'mobile-product-eval.js']) {
    await page.evaluate(
      await readFile(new URL(`../../mobile/evals/${file}`, import.meta.url), 'utf8'),
    );
  }
  const assertions = await page.evaluate(
    async ({ projectId, sessionId, questionId }) => {
      const result = { projectId, sessionId, questionId, assertions: [], sessions: [] };
      const harness = (
        window as unknown as {
          __gezelMobileEval: { finishQuestionContracts(result: unknown): Promise<void> };
        }
      ).__gezelMobileEval;
      await harness.finishQuestionContracts(result);
      return result.assertions;
    },
    { projectId, sessionId: session.id, questionId: question.questionId },
  );
  expect(assertions).toEqual([
    expect.objectContaining({ id: 'question-skip-visible', passed: true }),
    expect.objectContaining({ id: 'silent-skip-started-no-model-turn', passed: true }),
  ]);
  const panel = page.getByRole('dialog', { name: 'What’s going on' });
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(6);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(393 - 6);
  expect(bounds!.y).toBeGreaterThanOrEqual(59 + 52);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(852 - 34);
  await page.setViewportSize({ width: 1024, height: 800 });
  const tablet = await panel.boundingBox();
  expect(tablet!.width).toBeLessThanOrEqual(600);
  expect(tablet!.x).toBeGreaterThanOrEqual(6);
  expect(tablet!.x + tablet!.width).toBeLessThanOrEqual(1024 - 6);
});
