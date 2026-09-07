import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyBinaryDocumentBytes } from '@bendyline/gezel';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// A real MCP contract probe, without model variability. Keep its output for inspection.
const packageDir = process.env.GEZEL_EVAL_DOCBLOCKS_DIR;
if (!packageDir) throw new Error('Set GEZEL_EVAL_DOCBLOCKS_DIR to a built DocBlocks CLI package');
const runDir = resolve(process.argv[2] ?? `evals/runs/docblocks-smoke-${Date.now()}`);
const workspace = join(runDir, 'workspace');
const artifacts = join(runDir, 'artifacts');
await mkdir(workspace, { recursive: true });
await mkdir(artifacts, { recursive: true });
await writeFile(
  join(workspace, 'brief.md'),
  '# Pilot update\n\n18 SKUs.\n\n## Supporting detail\n\nResponse improved from 18 hours to 6 hours.\n\n# Results\n\n| Metric | Before | After |\n| --- | --- | --- |\n| Leakage | 14.2% | 8.9% |\n\n# Next actions\n\n- Automated status emails\n- Barcode-exception training\n- Weekly Finance exception export\n',
);
const evidence: Record<string, unknown>[] = [];
let failures = 0;

async function connect() {
  const client = new Client({ name: 'gezel-docblocks-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(packageDir!, 'dist/bin.js'),
      'mcp',
      '--allow-read',
      workspace,
      artifacts,
      '--allow-write',
      artifacts,
    ],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const start = Date.now();
  const response = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 180_000,
  });
  const envelope = response.structuredContent as { result?: Record<string, unknown> } | undefined;
  evidence.push({
    name,
    args,
    durationMs: Date.now() - start,
    isError: response.isError,
    structuredContent: response.structuredContent,
    contentTypes: Array.isArray(response.content)
      ? response.content.map((item) => (item as { type: string }).type)
      : [],
  });
  if (response.isError)
    throw new Error(`${name}: ${JSON.stringify(response.structuredContent ?? response.content)}`);
  if (!envelope?.result) throw new Error(`${name}: missing canonical result envelope`);
  return { data: envelope.result, response };
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    evidence.push({ check: name, passed: true });
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}: ${error}`);
    evidence.push({ check: name, passed: false, error: String(error) });
  }
  await writeFile(join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
}

let client = await connect();
try {
  const inventory = await client.listTools();
  evidence.push({
    tools: inventory.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
  });
  const roots = (await call(client, 'list_roots')).data.roots as Array<{
    id: string;
    read: boolean;
    write: boolean;
  }>;
  const readRoot = roots.find((root) => root.read && !root.write)!;
  const writeRoot = roots.find((root) => root.write)!;
  if (!readRoot || !writeRoot)
    throw new Error('Expected separate read-only workspace and writable artifacts roots');
  const source = { kind: 'file', rootId: readRoot.id, path: 'brief.md' };

  await check('19 canonical tools', async () => {
    if (inventory.tools.length !== 19) throw new Error(`found ${inventory.tools.length}`);
  });
  await check('Office/PDF/table conversion, preview, and save', async () => {
    const converted = await call(client, 'convert_document', {
      source,
      targets: [
        { format: 'pptx', slideBreak: 'h1', fidelity: 'editable-native' },
        { format: 'docx' },
        { format: 'pdf' },
        { format: 'xlsx' },
        { format: 'csv' },
      ],
      autoTemplates: true,
      title: 'Boreal Desk Returns Pilot',
      themeId: 'minimalist',
    });
    const problems: string[] = [];
    for (const result of converted.data.results as Array<{
      targetFormat: string;
      artifact: { uri: string };
    }>) {
      const file = `report.${result.targetFormat}`;
      await call(client, 'save_artifact', {
        artifactUri: result.artifact.uri,
        destination: { rootId: writeRoot.id, path: file, ifExists: 'error' },
      });
      if (result.targetFormat !== 'csv') {
        const verdict = verifyBinaryDocumentBytes(file, await readFile(join(artifacts, file)));
        if (!verdict.ok) throw new Error(verdict.detail);
      }
      if (['pptx', 'docx', 'pdf'].includes(result.targetFormat)) {
        const preview = await call(client, 'preview_document', {
          source: { kind: 'artifact', uri: result.artifact.uri },
          maxItems: 3,
          width: 640,
          height: 360,
        });
        if (result.targetFormat === 'pptx' && preview.data.totalItems !== 3) {
          problems.push(
            `3 native slides reconstructed as ${preview.data.totalItems} preview items`,
          );
        }
        const diagnostics = preview.data.diagnostics as Array<{ code: string; severity: string }>;
        if (diagnostics.some((diagnostic) => diagnostic.code === 'rendered-content-omitted')) {
          problems.push(`${file}: ordinary list content reported omitted`);
        }
        await mkdir(join(runDir, 'previews'), { recursive: true });
        if (Array.isArray(preview.response.content)) {
          let index = 0;
          for (const item of preview.response.content) {
            if ((item as { type: string }).type !== 'image') continue;
            const image = item as { data: string; mimeType: string };
            const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
            await writeFile(
              join(runDir, 'previews', `${result.targetFormat}-${index++}.${extension}`),
              Buffer.from(image.data, 'base64'),
            );
          }
        }
        if (
          !Array.isArray(preview.response.content) ||
          !preview.response.content.some((item) => (item as { type: string }).type === 'image')
        ) {
          problems.push(`${file}: preview returned no model-visible image`);
        }
      }
      if (result.targetFormat === 'pptx') {
        const inspected = await call(client, 'inspect_document', {
          source: { kind: 'artifact', uri: result.artifact.uri },
        });
        const stats = inspected.data.statistics as { slideCount: number };
        if (stats.slideCount !== 3) problems.push(`3 H1 slides became ${stats.slideCount} slides`);
      }
    }
    if (problems.length) throw new Error(problems.join('; '));
  });

  await check('saved documents survive an MCP restart', async () => {
    await client.close();
    client = await connect();
    for (const format of ['pptx', 'docx', 'pdf', 'xlsx']) {
      await call(client, 'inspect_document', {
        source: { kind: 'file', rootId: writeRoot.id, path: `report.${format}` },
      });
    }
  });

  await check('native reference theme, DBK handoff, and cross-format comparison', async () => {
    const reference = { kind: 'file', rootId: writeRoot.id, path: 'report.pptx' };
    const inferred = await call(client, 'infer_theme_from_file', { source: reference });
    await call(client, 'inspect_pptx_layouts', { source: reference });
    const applied = await call(client, 'apply_inferred_theme', {
      source,
      themeSource: reference,
      inferLayouts: false,
    });
    const theme = inferred.data.theme as { id: string };
    if ((applied.data.theme as { id: string }).id !== theme.id)
      throw new Error('Theme application changed the inferred identity');
    const bundle = applied.data.result as { artifact: { uri: string } };
    const converted = await call(client, 'convert_document', {
      source: { kind: 'artifact', uri: bundle.artifact.uri },
      targets: [{ format: 'pptx' }, { format: 'docx' }],
    });
    for (const result of converted.data.results as Array<{
      targetFormat: string;
      appliedThemeId: string;
      artifact: { uri: string };
    }>) {
      if (result.appliedThemeId !== theme.id)
        throw new Error(`${result.targetFormat}: inferred theme was lost`);
      await call(client, 'save_artifact', {
        artifactUri: result.artifact.uri,
        destination: {
          rootId: writeRoot.id,
          path: `themed.${result.targetFormat}`,
          ifExists: 'error',
        },
      });
      const inspected = await call(client, 'inspect_document', {
        source: { kind: 'artifact', uri: result.artifact.uri },
      });
      const text = JSON.stringify(inspected.data);
      for (const fact of ['18 SKUs', '14.2%', '8.9%', 'Finance']) {
        if (!text.includes(fact)) throw new Error(`${result.targetFormat}: lost ${fact}`);
      }
    }
    await call(client, 'compare_documents', {
      left: { kind: 'file', rootId: writeRoot.id, path: 'report.docx' },
      right: { kind: 'file', rootId: writeRoot.id, path: 'themed.docx' },
    });
    const nativeConversion = await call(client, 'convert_document', {
      source: { kind: 'file', rootId: writeRoot.id, path: 'themed.docx' },
      targets: [{ format: 'pdf' }],
    });
    const pdf = (nativeConversion.data.results as Array<{ artifact: { uri: string } }>)[0]!;
    await call(client, 'save_artifact', {
      artifactUri: pdf.artifact.uri,
      destination: { rootId: writeRoot.id, path: 'from-docx.pdf', ifExists: 'error' },
    });
  });

  await check('MP4/GIF conversion and native frame previews', async () => {
    const converted = await call(client, 'convert_document', {
      source,
      targets: [
        { format: 'mp4', width: 320, height: 180, fps: 2 },
        { format: 'gif', width: 320, height: 180, fps: 2 },
      ],
    });
    for (const result of converted.data.results as Array<{
      targetFormat: string;
      artifact: { uri: string };
    }>) {
      await call(client, 'preview_document', {
        source: { kind: 'artifact', uri: result.artifact.uri },
        maxItems: 1,
        width: 320,
        height: 180,
      });
      const file = `slideshow.${result.targetFormat}`;
      await call(client, 'save_artifact', {
        artifactUri: result.artifact.uri,
        destination: { rootId: writeRoot.id, path: file, ifExists: 'error' },
      });
      const verdict = verifyBinaryDocumentBytes(file, await readFile(join(artifacts, file)));
      if (!verdict.ok) throw new Error(verdict.detail);
    }
  });
} finally {
  await client.close();
  await writeFile(join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
console.log(`Evidence: ${runDir}`);
process.exitCode = failures ? 1 : 0;
