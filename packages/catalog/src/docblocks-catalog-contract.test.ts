import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';

interface ResolvedIndexEntry {
  manifest: {
    id: string;
    version?: string;
    runtime?: {
      package?: string;
      version?: string;
      sha256?: string;
      entry?: string;
      args?: string[];
    };
    tools?: Array<{ name: string }>;
    toolsets?: Array<{
      toolsetId?: string;
      sourceId?: string;
      autoAllow?: boolean;
    }>;
    steps?: Array<{
      id: string;
      prompt?: string;
      suggestedRole?: string;
      advanceWhen?: {
        file?: string;
        artifact?: boolean;
      };
      gate?: {
        checks?: Array<{
          file?: string;
          artifact?: boolean;
        }>;
      };
    }>;
  };
}

async function loadIndex(kind: 'toolsets' | 'craftbook-templates'): Promise<ResolvedIndexEntry[]> {
  const path = join(gildeDataDir(), kind, 'index.json');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as {
    entries: ResolvedIndexEntry[];
  };
  return parsed.entries;
}

describe('DocBlocks catalog contract', () => {
  it('pins the verified latest MCP package and its exact 19-tool inventory', async () => {
    const entries = await loadIndex('toolsets');
    const docblocks = entries.find((entry) => entry.manifest.id === 'docblocks')?.manifest;
    expect(docblocks, 'the bundled DocBlocks toolset should exist').toBeDefined();
    if (!docblocks) return;

    expect(docblocks.version).toBe('2.3.4');
    expect(docblocks.runtime).toEqual(
      expect.objectContaining({
        package: '@bendyline/docblocks-cli',
        version: '2.3.4',
        sha256: 'f9ebde4f7ea370778c9becf2a4f7a15fd435b4f2bcfdbcdf0f4242a1ef2db674',
        entry: 'dist/bin.js',
        args: ['mcp'],
      }),
    );

    const toolNames = docblocks.tools?.map((tool) => tool.name).sort() ?? [];
    expect(toolNames).toHaveLength(19);
    expect(toolNames).toContain('get_authoring_context');
    expect(toolNames).not.toContain('validate_document');
    expect(toolNames).toEqual(
      [
        'apply_inferred_theme',
        'compare_documents',
        'convert_document',
        'create_document_bundle',
        'describe_template',
        'describe_theme',
        'get_authoring_context',
        'get_conversion_report',
        'infer_theme_from_file',
        'inspect_document',
        'inspect_pptx_layouts',
        'list_formats',
        'list_roots',
        'list_templates',
        'list_themes',
        'list_transform_styles',
        'preview_document',
        'recommend_templates',
        'save_artifact',
      ].sort(),
    );
  });

  it('routes PDF, DOCX, PPTX, MP4, and GIF craftbooks through Markdown and DocBlocks', async () => {
    const entries = await loadIndex('craftbook-templates');
    const expected = new Map([
      ['report-pdf', { version: '1.1.0', artifacts: ['report.pdf'] }],
      ['research-to-document', { version: '1.2.0', artifacts: ['report.docx'] }],
      ['powerpoint-deck', { version: '1.4.0', artifacts: [], workspace: ['{{outputPath}}'] }],
      ['narrated-slideshow', { version: '1.1.0', artifacts: ['slideshow.gif', 'slideshow.mp4'] }],
    ]);

    for (const [id, contract] of expected) {
      const craftbook = entries.find((entry) => entry.manifest.id === id)?.manifest;
      expect(craftbook, `${id} should be bundled`).toBeDefined();
      if (!craftbook) continue;

      expect(craftbook.version).toBe(contract.version);
      expect(craftbook.toolsets).toContainEqual({
        toolsetId: 'docblocks',
        sourceId: 'bundled',
        autoAllow: true,
        reason: expect.any(String),
      });
      expect(craftbook.steps?.some((step) => step.suggestedRole === 'developer')).toBe(false);

      const prompts = craftbook.steps?.map((step) => step.prompt ?? '').join('\n') ?? '';
      expect(prompts).toContain('Markdown');
      expect(prompts).toContain('convert_document');
      expect(prompts).toContain('preview_document');
      expect(prompts).toContain('save_artifact');
      expect(prompts).not.toContain('validate_document` with');

      const artifactFiles = new Set<string>();
      const workspaceFiles = new Set<string>();
      for (const step of craftbook.steps ?? []) {
        if (step.advanceWhen?.file) {
          (step.advanceWhen.artifact ? artifactFiles : workspaceFiles).add(step.advanceWhen.file);
        }
        for (const check of step.gate?.checks ?? []) {
          if (check.file) (check.artifact ? artifactFiles : workspaceFiles).add(check.file);
        }
      }
      for (const artifact of contract.artifacts) {
        expect(artifactFiles, `${id} should gate the real ${artifact} artifact`).toContain(
          artifact,
        );
      }
      for (const output of contract.workspace ?? []) {
        expect(workspaceFiles, `${id} should gate the real ${output} workspace output`).toContain(
          output,
        );
      }
    }
  });
});
