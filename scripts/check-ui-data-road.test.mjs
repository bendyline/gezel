import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareWithBaseline, countViolations } from './check-ui-data-road.mjs';

const sources = {
  'packages/ui/src/views/A.tsx':
    'api.getConfig(); api.listGezels(); setInterval(tick, 1000); <p>Loading…</p>',
  'packages/ui/src/data/use-api-read.ts': 'api.getConfig();',
  'packages/ui/src/visible-interval.ts': 'setInterval(tick, ms);',
  'packages/ui/src/components/B.tsx': "window.addEventListener('gezel:config-updated', on);",
  'packages/ui/src/components/C.tsx': 'for await (const event of stream) {}',
  'packages/ui/src/reconnecting-stream.ts': 'for await (const event of stream) {}',
};

test('counts each rule per file, skipping the files a rule allows', () => {
  const counts = countViolations(sources);
  assert.deepEqual(counts['cached-read'], { 'packages/ui/src/views/A.tsx': 2 });
  assert.deepEqual(counts.interval, { 'packages/ui/src/views/A.tsx': 1 });
  assert.deepEqual(counts['config-event'], { 'packages/ui/src/components/B.tsx': 1 });
  assert.deepEqual(counts['stream-loop'], { 'packages/ui/src/components/C.tsx': 1 });
  assert.deepEqual(counts['loading-text'], { 'packages/ui/src/views/A.tsx': 1 });
});

test('fails a count above the baseline and notes one below it', () => {
  const counts = countViolations(sources);
  const baseline = {
    'cached-read': { 'packages/ui/src/views/A.tsx': 1 },
    interval: { 'packages/ui/src/views/A.tsx': 3 },
  };
  const { failures, lowered } = compareWithBaseline(counts, baseline);
  assert.ok(
    failures.some((line) => line.startsWith('packages/ui/src/views/A.tsx: 2 × cached-read')),
  );
  assert.ok(
    failures.some((line) => line.startsWith('packages/ui/src/components/B.tsx: 1 × config-event')),
  );
  assert.deepEqual(lowered, ['packages/ui/src/views/A.tsx: interval 3 → 1']);
});
