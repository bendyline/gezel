import { api } from '../api.js';

let noted = false;

/**
 * The person opened a finished result from its card. Stamped once per
 * install (`onboarding.firstResultOpenedAt`): Home's folder and night-work
 * question waits for it. Asked as the first result landed, the question was
 * appended under it and scrolled into view, and the result the person had
 * waited for left the screen for a folder picker (2026-11-09).
 */
export async function noteResultOpened(): Promise<void> {
  if (noted) return;
  noted = true;
  try {
    const config = await api.getConfig();
    if (config.onboarding?.firstResultOpenedAt) return;
    const updated = await api.updateConfig({
      onboarding: { ...config.onboarding, firstResultOpenedAt: new Date().toISOString() },
    });
    window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: updated }));
  } catch {
    noted = false;
  }
}

/** Test seam: a fresh window. */
export function resetResultOpenedNote(): void {
  noted = false;
}
