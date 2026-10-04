import { createMobileEmbedding } from '@bendyline/gezel-capacitor';
const ai = createMobileEmbedding();
document.querySelector('#enable')!.addEventListener('click', async () => {
  try {
    await ai.setEnabled(true);
    document.querySelector('#status')!.textContent = JSON.stringify(await ai.models.list());
  } catch (error) {
    document.querySelector('#status')!.textContent = String(error);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void ai.suspend();
  else ai.resume();
});
