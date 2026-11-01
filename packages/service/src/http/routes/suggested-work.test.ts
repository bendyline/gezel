import { describe, expect, it, vi } from 'vitest';
import { CraftbookSetupRequiredError } from '../../tasks/launch-errors.js';
import type { ServiceContext } from '../context.js';
import { suggestedWorkRoutes } from './suggested-work.js';

const enable = vi.hoisted(() => vi.fn());
vi.mock('../../suggested-work/enable.js', () => ({
  enableSuggestedWork: enable,
  disableSuggestedWork: vi.fn(),
  dismissSuggestedWork: vi.fn(),
}));

const app = suggestedWorkRoutes({} as ServiceContext);
const post = (key: string) =>
  app.request('/p1/suggested-work/enable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });

describe('enabling suggested night work', () => {
  it('answers a project not ready for the book with a 409 that names the fix', async () => {
    enable.mockRejectedValueOnce(
      new CraftbookSetupRequiredError('weather-watch', [
        { toolsetId: 'weather', reason: 'forecasts' },
      ]),
    );
    const res = await post('gezel-template:planner:weather-watch');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.stringContaining('install/configure weather (forecasts)'),
      code: 'CRAFTBOOK_SETUP_REQUIRED',
    });
  });

  it('still answers an unknown key with a 404 and anything else with a 500', async () => {
    enable.mockRejectedValueOnce(new Error('unknown suggested-work key x'));
    expect((await post('x')).status).toBe(404);
    enable.mockRejectedValueOnce(new Error('disk full'));
    expect((await post('y')).status).toBe(500);
  });
});
