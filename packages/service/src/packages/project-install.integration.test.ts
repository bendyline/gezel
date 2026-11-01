import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPnpm } from './pnpm.js';
import { addProjectPackage } from './project-install.js';

const pnpm = [
  '../../../app/dist/pnpm-bundle/bin/pnpm.mjs',
  '../../../app/.cache/native-runtime/pnpm-bundle/bin/pnpm.mjs',
]
  .map((path) => fileURLToPath(new URL(path, import.meta.url)))
  .find(existsSync);
let fixture: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixture) await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('bundled pnpm project migration', () => {
  it.runIf(pnpm)(
    'does not repair sibling projects outside the selected workspace folder',
    async () => {
      fixture = await mkdtemp(join(tmpdir(), 'gezel-pnpm-workspace-migration-'));
      const workspace = join(fixture, 'workspace');
      const dependency = join(fixture, 'dependency');
      const first = join(workspace, 'first');
      const sibling = join(workspace, 'sibling');
      for (const dir of [first, sibling, dependency]) await mkdir(dir, { recursive: true });
      await writeFile(
        join(dependency, 'package.json'),
        JSON.stringify({ name: 'kept', version: '1.0.0' }),
      );
      await writeFile(
        join(workspace, 'package.json'),
        JSON.stringify({ name: 'root', private: true }),
      );
      await writeFile(
        join(workspace, 'pnpm-workspace.yaml'),
        'packages:\n  - first\n  - sibling\n',
      );
      for (const [dir, name] of [
        [first, 'first'],
        [sibling, 'sibling'],
      ] as const) {
        await writeFile(
          join(dir, 'package.json'),
          JSON.stringify({ name, private: true, dependencies: { kept: 'file:../../dependency' } }),
        );
      }
      vi.stubEnv('GEZEL_PNPM_PATH', pnpm!);
      vi.stubEnv('GEZEL_NODE_PATH', process.execPath);
      const options = {
        cwd: workspace,
        env: {
          pnpm_config_offline: 'true',
          pnpm_config_store_dir: join(fixture, 'store'),
          pnpm_config_cache_dir: join(fixture, 'cache'),
          CI: '',
        },
      };
      const initial = await runPnpm(['install'], options);
      expect(initial.ok, initial.log).toBe(true);
      const modulesFile = join(workspace, 'node_modules', '.modules.yaml');
      const modules = JSON.parse(await readFile(modulesFile, 'utf8'));
      modules.storeDir = join(fixture, 'old-store', 'v10');
      const before = JSON.stringify(modules);
      await writeFile(modulesFile, before);
      const siblingPackage = join(sibling, 'node_modules', 'kept', 'package.json');
      const siblingBefore = await readFile(siblingPackage, 'utf8');

      const result = await addProjectPackage('file:../../dependency', { ...options, cwd: first });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Dependency repair failed');
      expect(await readFile(modulesFile, 'utf8')).toBe(before);
      expect(await readFile(siblingPackage, 'utf8')).toBe(siblingBefore);
    },
    60_000,
  );

  it.runIf(pnpm)(
    'repairs a v10 store layout offline and keeps source, locked packages, and hooks safe',
    async () => {
      fixture = await mkdtemp(join(tmpdir(), 'gezel-pnpm-migration-'));
      const project = join(fixture, 'project');
      const dependency = join(fixture, 'dependency');
      const added = join(fixture, 'added');
      for (const dir of [project, dependency, added]) await mkdir(dir);
      for (const [dir, name] of [
        [dependency, 'kept'],
        [added, 'added'],
      ] as const) {
        await writeFile(
          join(dir, 'package.json'),
          JSON.stringify({
            name,
            version: '1.2.3',
            main: 'index.js',
            scripts: { postinstall: 'node -e "process.exit(99)"' },
          }),
        );
        await writeFile(join(dir, 'index.js'), 'module.exports = 123;\n');
      }
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({
          name: 'migration-project',
          private: true,
          dependencies: { kept: 'file:../dependency' },
          scripts: {
            preinstall: 'node -e "process.exit(99)"',
            'pnpm:devPreinstall': 'node -e "process.exit(99)"',
          },
        }),
      );
      await writeFile(join(project, 'source.js'), 'user-owned source\n');
      await writeFile(join(project, '.pnpmfile.cjs'), 'throw new Error("hook must never run");\n');
      vi.stubEnv('GEZEL_PNPM_PATH', pnpm!);
      vi.stubEnv('GEZEL_NODE_PATH', process.execPath);
      const options = {
        cwd: project,
        env: {
          npm_config_offline: 'true',
          npm_config_store_dir: join(fixture, 'store'),
          npm_config_cache_dir: join(fixture, 'cache'),
          pnpm_config_offline: 'true',
          pnpm_config_store_dir: join(fixture, 'store'),
          pnpm_config_cache_dir: join(fixture, 'cache'),
          CI: '',
        },
      };
      const initial = await runPnpm(['install'], options);
      expect(initial.ok, initial.log).toBe(true);
      const modulesFile = join(project, 'node_modules', '.modules.yaml');
      const modules = JSON.parse(await readFile(modulesFile, 'utf8'));
      const currentStore = modules.storeDir;
      expect(currentStore).toContain(join(fixture, 'store'));
      modules.storeDir = join(fixture, 'old-store', 'v10');
      modules.packageManager = 'pnpm@10.33.0';
      await writeFile(modulesFile, JSON.stringify(modules));

      const result = await addProjectPackage('file:../added', options);

      expect(result.ok, result.log).toBe(true);
      expect(result.log).toContain('ERR_PNPM_UNEXPECTED_STORE');
      expect(JSON.parse(await readFile(modulesFile, 'utf8')).storeDir).toBe(currentStore);
      expect(
        JSON.parse(await readFile(join(project, 'node_modules', 'kept', 'package.json'), 'utf8'))
          .version,
      ).toBe('1.2.3');
      expect(
        JSON.parse(await readFile(join(project, 'node_modules', 'added', 'package.json'), 'utf8'))
          .version,
      ).toBe('1.2.3');
      expect(await readFile(join(project, 'source.js'), 'utf8')).toBe('user-owned source\n');
      const again = await addProjectPackage('file:../added', options);
      expect(again.ok, again.log).toBe(true);
      expect(again.log).not.toContain('Updating this project');
    },
    60_000,
  );
});
