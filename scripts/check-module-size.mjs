import { readFile } from 'node:fs/promises';

// These are tracked hotspot baselines, not acceptable end-state sizes. Give
// ordinary feature work up to 2x headroom so this check catches sustained
// growth instead of making every small addition update a line-count snapshot.
// Any focused extraction should lower its baseline in the same change.
const HEADROOM_MULTIPLIER = 2;
const baselines = new Map([
  ['packages/service/src/chat/manager.ts', 14_583],
  ['packages/mcp/src/server.ts', 9_232],
  ['packages/service/src/fs/store.ts', 5_393],
  ['packages/ui/src/views/ProjectsView.tsx', 3_814],
  ['packages/ui/src/views/SettingsView.tsx', 3_491],
  ['packages/ui/src/components/ChatTimelineView.tsx', 3_187],
  ['packages/ui/src/components/chat-bubbles.tsx', 2_893],
]);

const failures = [];
for (const [path, baseline] of baselines) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const lines = source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
  const ceiling = baseline * HEADROOM_MULTIPLIER;
  if (lines > ceiling) {
    failures.push(`${path}: ${lines} lines (ceiling ${ceiling}; baseline ${baseline})`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Oversized module guardrail failed. A hotspot exceeded ${HEADROOM_MULTIPLIER}x its tracked baseline; extract a focused module:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('Oversized module guardrail passed.\n');
}
