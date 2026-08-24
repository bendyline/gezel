/**
 * `gezel app new|validate|pack|schemas` — author AI Apps from source
 * folders. Unlike the install-side `app-command.ts`, nothing here talks
 * to the daemon: validation, packing, and schema rendering all run on
 * `@bendyline/gezel-service/gezapp`, which imports without booting the
 * service. Loaded through its own variable-dynamic-import seam in
 * bin/gezel.ts so ordinary CLI startup never pays for the TypeScript
 * compiler the validator carries.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  GezappSourceError,
  type GezappSourceFinding,
  packGezappFromSource,
  readGezapp,
  renderGezappAuthoringSchemaFiles,
  validateGezappSource,
  verifyGezapp,
} from '@bendyline/gezel-service/gezapp';
import { SCAFFOLD_ID_PATTERN, scaffoldGezappSource } from './app-scaffold.js';
import { CliError } from './connection.js';

function resolvePath(input: string): string {
  return isAbsolute(input) ? input : join(process.cwd(), input);
}

function formatFinding(finding: GezappSourceFinding): string {
  const where = finding.file || '.';
  const pointer = finding.pointer ? ` #${finding.pointer}` : '';
  return `${finding.severity.toUpperCase()} ${where}${pointer} - ${finding.rule}: ${finding.message}`;
}

function printFindings(findings: GezappSourceFinding[]): { errors: number; warnings: number } {
  for (const finding of findings) console.log(formatFinding(finding));
  return {
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warn').length,
  };
}

async function statKind(path: string): Promise<'dir' | 'file' | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

export async function runAppValidate(target: string, opts: { json?: boolean } = {}): Promise<void> {
  const path = resolvePath(target);
  const kind = await statKind(path);
  if (!kind) throw new CliError(`No such file or folder: ${target}`);

  let findings: GezappSourceFinding[];
  let entry: { projectType: string; version: string } | null = null;
  if (kind === 'dir') {
    const result = await validateGezappSource(path);
    findings = result.findings;
    entry = result.manifest?.entry ?? null;
  } else {
    let parsed: ReturnType<typeof readGezapp>;
    try {
      parsed = readGezapp(await readFile(path));
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err));
    }
    entry = parsed.manifest.entry;
    findings = verifyGezapp(parsed).errors.map((message) => ({
      severity: 'error' as const,
      file: '',
      pointer: '',
      rule: 'package-verify',
      message,
    }));
  }

  const ok = !findings.some((finding) => finding.severity === 'error');
  if (opts.json) {
    console.log(JSON.stringify({ ok, entry, findings }, null, 2));
  } else {
    const { errors, warnings } = printFindings(findings);
    if (ok) {
      const suffix = warnings > 0 ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : '';
      console.log(
        `OK — ${entry ? `${entry.projectType}@${entry.version}` : 'package'} is valid${suffix}.`,
      );
    } else {
      console.log(
        `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`,
      );
    }
  }
  if (!ok) process.exitCode = 1;
}

export async function runAppPack(
  folder: string,
  opts: { out?: string; json?: boolean } = {},
): Promise<void> {
  const dir = resolvePath(folder);
  if ((await statKind(dir)) !== 'dir') throw new CliError(`No such folder: ${folder}`);
  try {
    const packed = await packGezappFromSource(dir);
    const out = resolvePath(
      opts.out ?? `${packed.manifest.entry.projectType}-${packed.manifest.entry.version}.gezapp`,
    );
    await writeFile(out, packed.buffer);
    if (opts.json) {
      console.log(
        JSON.stringify(
          { ok: true, path: out, manifest: packed.manifest, findings: packed.findings },
          null,
          2,
        ),
      );
      return;
    }
    printFindings(packed.findings);
    const items = packed.manifest.items
      .map((item) => `${item.kind} ${item.id}@${item.version}`)
      .join(', ');
    console.log(`Packed ${packed.manifest.name} ${packed.manifest.entry.version} -> ${out}`);
    console.log(`  items: ${items}`);
    if (packed.manifest.dependencies.length > 0) {
      console.log(
        `  dependency locks: ${packed.manifest.dependencies
          .map((dependency) => `${dependency.kind} ${dependency.id}@${dependency.version}`)
          .join(', ')}`,
      );
    }
    console.log(`  ${packed.buffer.length.toLocaleString()} bytes`);
  } catch (err) {
    if (!(err instanceof GezappSourceError)) throw err;
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, findings: err.findings }, null, 2));
    } else {
      const { errors } = printFindings(err.findings);
      console.log(`Not packed — fix the ${errors} error${errors === 1 ? '' : 's'} above.`);
    }
    process.exitCode = 1;
  }
}

export async function runAppNew(
  id: string,
  opts: { dir?: string; withPage?: boolean } = {},
): Promise<void> {
  if (!SCAFFOLD_ID_PATTERN.test(id)) {
    throw new CliError(
      `"${id}" is not a valid app id — use lowercase letters, digits, and hyphens (2-64 chars).`,
    );
  }
  const target = join(opts.dir ? resolvePath(opts.dir) : process.cwd(), id);
  const existing = await statKind(target);
  if (existing === 'file') throw new CliError(`${target} already exists.`);
  if (existing === 'dir' && (await readdir(target)).length > 0) {
    throw new CliError(`${target} already exists and is not empty.`);
  }

  const files = scaffoldGezappSource(id, {
    ...(opts.withPage ? { withPage: true } : {}),
  });
  for (const [rel, content] of files) {
    const abs = join(target, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  console.log(`Scaffolded ${id} (${files.length} files) in ${target}`);
  console.log('Next:');
  console.log('  1. Edit items/ — start with the two about.md files and the version manifest.');
  console.log(`  2. gezel app validate ${id}`);
  console.log(`  3. gezel app pack ${id}`);
  console.log(`  4. gezel app add ${id}-1.0.0.gezapp --yes && gezel app apply ${id}`);
}

export async function runAppSchemas(opts: { out?: string; json?: boolean } = {}): Promise<void> {
  const files = renderGezappAuthoringSchemaFiles();
  if (opts.json) {
    const byName: Record<string, unknown> = {};
    for (const [filename, content] of files) byName[filename] = JSON.parse(content);
    console.log(JSON.stringify(byName, null, 2));
    return;
  }
  if (opts.out) {
    const dir = resolvePath(opts.out);
    await mkdir(dir, { recursive: true });
    for (const [filename, content] of files) {
      await writeFile(join(dir, filename), content);
    }
    console.log(`Wrote ${files.length} JSON Schemas to ${dir}`);
    return;
  }
  for (const [filename] of files) console.log(filename);
  console.log('');
  console.log('Use --out <dir> to write the files, or --json for one combined object.');
}
