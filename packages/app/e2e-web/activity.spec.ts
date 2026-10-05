import { GezelClient } from '@bendyline/gezel-client';
import { expect, test } from './fixtures/test.js';
import { setTheme } from './helpers/determinism.js';
import { gotoHome } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

// Dispatching held work changes the runner's queue state as well as creating
// chats. Keep those mutations out of the shared screenshot world.
test.use({ daemonGroup: 'activity' });

test('Activity answers inline, retains drafts, and explains held work', async ({
  page,
  daemon,
  world,
}) => {
  test.skip(!world, 'requires the seeded world');
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  const projectId = world!.projectId;
  const gezelId = world!.gezelIds.ada;
  const session = await client.createChatSession({ projectId, gezelId });
  const second = await client.createChatSession({ projectId, gezelId: world!.gezelIds.bram });
  const firstQuestion = await client.askUserQuestion({
    projectId,
    gezelId,
    sessionId: session.id,
    prompt: 'Which offer should we put in the weekend newsletter?',
    choices: ['10% off', 'Free delivery'],
    allowWriteIn: true,
  });
  const secondQuestion = await client.askUserQuestion({
    projectId,
    gezelId: world!.gezelIds.bram,
    sessionId: second.id,
    prompt: 'What date should the new menu be ready?',
    allowWriteIn: true,
  });
  const task = await client.createTask(projectId, {
    title: 'Prepare the weekend newsletter',
    description: 'Draft a short newsletter describing the weekend offer for our regular customers.',
    assignee: { kind: 'gezel', gezelId },
    steps: [{ id: 'draft', name: 'Draft newsletter' }],
    entryStepId: 'draft',
    dispatchEntry: true,
  });
  try {
    await gotoHome(page);
    await page.getByRole('button', { name: /^Activity —/ }).click();
    const panel = page.getByRole('dialog', { name: 'What’s going on' });
    const card = page.locator(`[id="activity-question-${firstQuestion.questionId}"]`);
    await expect(card.getByRole('button', { name: '10% off', exact: true })).toBeVisible();
    await expect(panel.getByText('What date should the new menu be ready?')).toBeVisible();
    await card.getByRole('textbox').fill('Offer ends Sunday at 6 pm.');
    await card.getByRole('button', { name: '10% off', exact: true }).click();
    await shot(page, 'inline-questions', {
      area: 'activity',
      description: 'Activity with all answer controls visible and a saved draft',
    });
    await setTheme(page, 'dark');
    await shot(page, 'inline-questions', {
      area: 'activity',
      theme: 'dark',
      description: 'Inline answers in Activity, dark theme',
    });
    await setTheme(page, 'light');
    await page.setViewportSize({ width: 400, height: 850 });
    await expect(page.getByRole('button', { name: /^Activity —/ })).toBeVisible();
    await panel.getByRole('button', { name: 'Close Activity' }).click();
    await page.getByRole('button', { name: /^Activity —/ }).click();
    await expect(card.getByRole('textbox')).toHaveValue('Offer ends Sunday at 6 pm.');
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(400);
    await shot(page, 'inline-questions', {
      area: 'activity',
      viewport: 'narrow',
      description: 'Activity and inline answers at phone width',
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.getByRole('button', { name: 'Close Activity' }).click();
    await page.getByRole('button', { name: /^Activity —/ }).click();
    await expect(card.getByRole('textbox')).toHaveValue('Offer ends Sunday at 6 pm.');
    await expect(card.getByRole('button', { name: '10% off', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await card.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(card.getByText('Answered', { exact: true })).toBeVisible();
    await expect(panel).toBeVisible();
    const saved = (await client.listQuestions({ projectId })).questions.find(
      (q) => q.id === firstQuestion.questionId,
    );
    expect(saved?.answer).toMatchObject({
      selectedChoices: [0],
      writeIn: 'Offer ends Sunday at 6 pm.',
    });
    await shot(page, 'answer-saved', {
      area: 'activity',
      description: 'Answer receipt stays in place while the panel remains open',
    });
    await panel.getByRole('button', { name: /^Next/ }).click();
    const held = panel.locator('.activity-work').filter({ hasText: task.title });
    await expect(held).toContainText('Automatic work is paused');
    await held.scrollIntoViewIfNeeded();
    await shot(page, 'held-work', {
      area: 'activity',
      description: 'Next explains the activity setting that is holding a real task',
    });
    await page.route('**/api/activity', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"Temporarily unavailable"}',
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('gezel:config-changed')));
    await expect(page.getByRole('button', { name: 'Activity — Status unavailable' })).toBeVisible();
    await panel.getByText('Status could not be refreshed.').scrollIntoViewIfNeeded();
    await shot(page, 'connection-lost', {
      area: 'activity',
      description: 'A failed status refresh preserves known work and labels it stale',
    });
    await page.unroute('**/api/activity');
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.getByText('Status could not be refreshed.')).toBeHidden();
  } finally {
    await client.answerQuestion(secondQuestion.questionId, { silentSkip: true });
    await client.setTaskStatus(projectId, task.num, 'canceled');
  }
});
