import { TOOL_REGISTRY } from '@bendyline/gezel-mcp';
import { describe, expect, it } from 'vitest';
import {
  type ModelToolNameCorpusEntry,
  extractModelFacingStringCorpus,
  lintModelToolNameEntries,
  normalizeModelToolCorpusSource,
  partitionModelToolNameFindings,
} from './model-tool-name-contract.js';

function promptEntry(source: string, text: string, line = 1): ModelToolNameCorpusEntry {
  return { source, category: 'prompt-source', line, text };
}

describe('model-facing tool-name contract', () => {
  it('normalizes Windows corpus paths for source policies and debt classification', () => {
    for (const version of ['0.1.18', '0.1.19']) {
      expect(
        normalizeModelToolCorpusSource(
          `node_modules\\.pnpm\\@bendyline+gilde@${version}\\node_modules\\@bendyline\\gilde\\data\\craftbook-templates\\example.json`,
        ),
      ).toBe(
        `node_modules/.pnpm/@bendyline+gilde@${version}/node_modules/@bendyline/gilde/data/craftbook-templates/example.json`,
      );
    }
  });

  it('keeps separately owned catalog findings non-blocking without a version waiver', () => {
    const catalogFinding = {
      source:
        'node_modules/.pnpm/@bendyline+gilde@0.1.24/node_modules/@bendyline/gilde/data/craftbook-templates/example/versions/2.0.0/craftbook.json',
      category: 'generated-catalog' as const,
      jsonPointer: '/plan',
      severity: 'error' as const,
      rule: 'legacy-tool-name' as const,
      tool: 'readFile',
      line: 9,
      detail: 'Use read_file.',
      excerpt: 'Call readFile.',
    };
    const report = partitionModelToolNameFindings([catalogFinding]);

    expect(report.errors).toEqual([]);
    expect(report.catalogFindings).toEqual([catalogFinding]);
  });

  it('still rejects findings from Gezel-owned model-facing sources', () => {
    const catalogFinding = {
      source:
        'node_modules/.pnpm/@bendyline+gilde@0.1.24/node_modules/@bendyline/gilde/data/craftbook-templates/example/versions/2.0.0/craftbook.json',
      category: 'generated-catalog' as const,
      jsonPointer: '/plan',
      severity: 'error' as const,
      rule: 'legacy-tool-name' as const,
      tool: 'readFile',
      line: 9,
      detail: 'Use read_file.',
      excerpt: 'Call readFile.',
    };
    const ownedFinding = {
      ...catalogFinding,
      source: 'packages/service/src/chat/instructions.ts',
      category: 'prompt-source' as const,
    };
    const report = partitionModelToolNameFindings([catalogFinding, ownedFinding]);

    expect(report.errors).toEqual([ownedFinding]);
    expect(report.catalogFindings).toEqual([catalogFinding]);
  });

  it('extracts runtime strings while ignoring source comments and identifiers', () => {
    const entries = extractModelFacingStringCorpus({
      source: 'fixture.ts',
      category: 'prompt-source',
      sourceText: [
        '// Tell the model to call run_script here (comment only).',
        'const run_script = () => undefined;',
        'const prompt = "Call `run_script({ name: \\"verify\\" })`.";',
      ].join('\n'),
    });

    expect(entries.map((entry) => entry.text)).toContain('Call `run_script({ name: "verify" })`.');
    expect(entries.some((entry) => entry.text.includes('comment only'))).toBe(false);
  });

  it('rejects hidden and undeclared tool names but permits declared external tools', () => {
    const findings = lintModelToolNameEntries({
      allowedTools: ['read_file', 'convert_document'],
      entries: [
        {
          source: 'prompt.ts',
          category: 'prompt-source',
          line: 40,
          text: [
            'Call `readFile({ path })` first.',
            'Then call `convert_document({ source })`.',
            'Finally call the `missing_project_tool({ value })` tool.',
          ].join('\n'),
        },
      ],
    });

    expect(findings).toMatchObject([
      { source: 'prompt.ts', line: 40, rule: 'legacy-tool-name', tool: 'readFile' },
      {
        source: 'prompt.ts',
        line: 42,
        rule: 'unknown-tool-name',
        tool: 'missing_project_tool',
      },
    ]);
  });

  it.each([
    ['AskUserQuestion', 'Call AskUserQuestion now.'],
    ['WebSearch', 'Call WebSearch before drafting the answer.'],
    ['Grep', 'Use the Grep tool for every code search.'],
    ['Read', 'Open the result with the Read tool.'],
    ['Bash', 'Run that command with the Bash tool.'],
    ['ExitPlanMode', 'Call ExitPlanMode when the plan is approved.'],
    ['inspect_git_workdir', 'Call `inspect_git_workdir({})` before making changes.'],
  ])('rejects tombstoned or foreign model tool name %s', (tool, text) => {
    const findings = lintModelToolNameEntries({
      // A tombstone is invalid even if a provider or broad catalog roster
      // happens to advertise the same spelling.
      allowedTools: [tool],
      entries: [promptEntry(`tombstone-${tool}.md`, text)],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: `tombstone-${tool}.md`,
          tool,
        }),
      ]),
    );
  });

  it('rejects removed names in negative guidance and supplies the canonical replacement', () => {
    const findings = lintModelToolNameEntries({
      allowedTools: ['start_project'],
      entries: [
        promptEntry(
          'removed-project-tool.md',
          'Do not call `create_project`; call `start_project` instead.',
        ),
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'removed-project-tool.md',
          tool: 'create_project',
          detail: expect.stringContaining('start_project'),
        }),
      ]),
    );
  });

  it('rejects canonical registry entries that are not model-facing even when advertised', () => {
    const hiddenCanonicalNames = Object.values(TOOL_REGISTRY)
      .filter((entry) => !entry.modelFacing)
      .map((entry) => entry.canonicalName);
    expect(hiddenCanonicalNames.length).toBeGreaterThan(0);

    const findings = lintModelToolNameEntries({
      allowedTools: hiddenCanonicalNames,
      entries: hiddenCanonicalNames.map((tool) =>
        promptEntry(`non-model-facing-${tool}.md`, `Your first tool call must be \`${tool}({})\`.`),
      ),
    });

    for (const tool of hiddenCanonicalNames) {
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: `non-model-facing-${tool}.md`,
            tool,
          }),
        ]),
      );
    }
  });

  it('rejects an unformatted alias and the same alias in negative guidance', () => {
    const findings = lintModelToolNameEntries({
      allowedTools: ['run_installed_script'],
      entries: [
        promptEntry(
          'plain-alias.md',
          [
            'Use the run_script tool for the installed verification script.',
            'Do not call the run_script tool for an ad-hoc file.',
          ].join('\n'),
          20,
        ),
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'legacy-tool-name', tool: 'run_script', line: 20 }),
        expect.objectContaining({ rule: 'legacy-tool-name', tool: 'run_script', line: 21 }),
      ]),
    );
  });

  it('does not mistake ordinary natural-language verbs or schema properties for tools', () => {
    const findings = lintModelToolNameEntries({
      allowedTools: [],
      entries: [
        promptEntry(
          'ordinary-prose.md',
          [
            'Read the report and edit the final paragraph for clarity.',
            'A bash can be a party, and grep is also the name of a Unix program.',
            'Edit distance is a string-similarity measure.',
            'The tool result includes a `suggestedGezelId` property; treat it as data.',
          ].join('\n'),
        ),
      ],
    });

    expect(findings).toEqual([]);
  });

  it('scopes declared external tools to the corpus entry that declares them', () => {
    const entries = [
      {
        ...promptEntry('docblocks-craftbook.md', 'Call `convert_document({ source })`.'),
        declaredTools: ['convert_document'],
      },
      promptEntry('unrelated-craftbook.md', 'Call `convert_document({ source })`.'),
    ];

    const findings = lintModelToolNameEntries({ entries, allowedTools: [] });

    expect(findings).toEqual([
      expect.objectContaining({ source: 'unrelated-craftbook.md', tool: 'convert_document' }),
    ]);
  });
});
