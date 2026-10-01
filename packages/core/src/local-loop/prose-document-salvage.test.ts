import { describe, expect, it } from 'vitest';
import { prepareSalvagedProseDocument } from './prose-document-salvage.js';

const REVIEW = `## Batch 11 — files 251–253

### B11-1 — minor — scripts/latest-app-release.test.mjs:44

The fixture writes the article before the listing dir exists, so the
assertion passes vacuously. Create the directory first.

### Verified OK

- \`tests/published/packageShape.test.ts\` — the exports map assertion covers
  every published subpath.
`;

const salvage = (over: Partial<Parameters<typeof prepareSalvagedProseDocument>[0]> = {}) =>
  prepareSalvagedProseDocument({
    text: REVIEW,
    deliverableFile: 'tasks/35/pr-review/observations-11.md',
    streamComplete: true,
    ...over,
  });

describe('prepareSalvagedProseDocument', () => {
  it('promotes a finished markdown document the model wrote into chat', () => {
    const out = salvage();
    expect(out).toContain('## Batch 11 — files 251–253');
    expect(out).toContain('### Verified OK');
    expect(out?.endsWith('\n')).toBe(true);
  });

  describe('the truncation rule', () => {
    // A ramble abort cuts the stream mid-token. Promoting that buffer is
    // worse than losing it: `minBytes` / `json-valid` pass a half-written
    // deliverable and the craftbook advances on it.
    it('refuses a buffer from a stream we cut', () => {
      expect(salvage({ streamComplete: false })).toBeNull();
    });

    it('refuses a buffer that stops mid-sentence', () => {
      expect(
        salvage({ text: '## Batch 11\n\nRecord 251 declares a helper that resolves the' }),
      ).toBeNull();
    });

    it('refuses a buffer that trails off in an ellipsis', () => {
      expect(salvage({ text: `${REVIEW.trimEnd()}\n\nStill checking record 253…` })).toBeNull();
    });

    it('refuses a buffer with an unclosed code fence', () => {
      expect(
        salvage({ text: `${REVIEW}\n\`\`\`js\nconst handboekNotesPath = (v) => {\n` }),
      ).toBeNull();
    });
  });

  describe('gates', () => {
    it('refuses when the step names no deliverable', () => {
      expect(salvage({ deliverableFile: undefined })).toBeNull();
    });

    it('refuses a non-prose deliverable — prose is not JSON', () => {
      expect(salvage({ deliverableFile: 'tasks/35/pr-review/coverage-11.json' })).toBeNull();
      expect(salvage({ deliverableFile: 'src/index.ts' })).toBeNull();
    });

    it('refuses a reply that opens with narration and only then shows the document', () => {
      // A reply ABOUT the deliverable, not the deliverable. Promoting it
      // would overwrite the review with commentary on the review.
      expect(
        salvage({ text: `I've finished reviewing the batch. Here's what I found:\n\n${REVIEW}` }),
      ).toBeNull();
    });

    it('accepts narration-first only when the model names the deliverable', () => {
      expect(
        salvage({
          text: `Writing observations-11.md now:\n\n${REVIEW}`,
        }),
      ).not.toBeNull();
    });

    it('refuses a successful handoff receipt that mentions the deliverable', () => {
      const receipt = `Research step complete — handed off to the outline gezel.

- Validated deliverable: \`tasks/35/pr-review/observations-11.md\`.
- The completion gate passed with all required sources present.
- Active step is now "Lock the outline" and its assignee owns the next phase.

No further edits are required from the research step.`;
      expect(salvage({ text: receipt })).toBeNull();
    });

    it('refuses narration that carries no document structure', () => {
      const narration =
        'I have reviewed all three records in this batch and found no significant issues. '.repeat(
          10,
        );
      expect(salvage({ text: narration })).toBeNull();
    });

    it('refuses a buffer too short to be the deliverable', () => {
      expect(salvage({ text: '## Batch 11\n\nNothing found.' })).toBeNull();
    });

    it('accepts a table-shaped document with no heading', () => {
      const table = `| Finding | Severity | Path |\n| --- | --- | --- |\n${'| B11-1 | minor | scripts/latest-app-release.test.mjs:44 |\n'.repeat(
        6,
      )}`;
      expect(salvage({ text: table })).not.toBeNull();
    });
  });

  it('accepts .md, .markdown, .mdx and .txt deliverables', () => {
    for (const ext of ['md', 'markdown', 'mdx', 'txt', 'text']) {
      expect(salvage({ deliverableFile: `notes/review.${ext}` }), ext).not.toBeNull();
    }
  });
});
