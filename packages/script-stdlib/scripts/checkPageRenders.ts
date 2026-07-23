import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkPageRenders',
  description:
    'Gate (EXPENSIVE — spawns headless Chromium): an HTML workspace file loads without page errors, optionally requiring a selector to exist. Use sparingly; static gates cover most cases.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'HTML file to render.', default: 'index.html' },
    selector: {
      type: 'string',
      description: 'CSS selector that must exist after load (optional).',
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read', 'network'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const file = input.file ?? 'index.html';
let html: string | null = null;
try {
  html = await gezel.fs.read(file);
} catch {
  html = null;
}
if (html === null) {
  gezel.output(gateResult(false, `${file} not found — write the deliverable before advancing.`));
} else {
  const script = `
    import { chromium } from 'playwright';
    const browser = await chromium.launch();
    const page = await (await browser.newContext()).newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    await page.setContent(${JSON.stringify(html)}, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(500);
    const selectorOk = ${JSON.stringify(input.selector ?? '')}
      ? (await page.$(${JSON.stringify(input.selector ?? '')})) !== null
      : true;
    await browser.close();
    console.log(JSON.stringify({ pageErrors: pageErrors.slice(0, 3), selectorOk }));
  `;
  const raw = await gezel.mcp.call('run_playwright_script', { script });
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) {
    throw new Error(`run_playwright_script returned unparseable output: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jsonMatch[0]!) as { pageErrors: string[]; selectorOk: boolean };
  if (parsed.pageErrors.length > 0) {
    gezel.output(
      gateResult(
        false,
        `${file} throws on load: ${parsed.pageErrors[0]}. Fix the runtime error and re-advance.`,
      ),
    );
  } else if (!parsed.selectorOk) {
    gezel.output(
      gateResult(
        false,
        `${file} loads but "${input.selector}" is missing from the rendered page — make sure that element actually renders.`,
      ),
    );
  } else {
    gezel.output(gateResult(true, `${file} renders without errors`));
  }
}
