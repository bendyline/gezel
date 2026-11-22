import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// pnpm 11 checks a tree's install state before `exec` and runs a nested
// `pnpm install` that drops command-line config. Against a managed toolset
// tree that install aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, so
// every exec there must carry PNPM_MANAGED_TREE_EXEC_CONFIG. The hoisted linker
// flag alone is for install commands only.
const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(SRC, f));
}

describe('pnpm exec against managed toolset trees', () => {
  it('uses PNPM_MANAGED_TREE_EXEC_CONFIG wherever the service launches pnpm exec', () => {
    const launchers = sourceFiles().filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /resolvePnpm(Command|Invocation)\(/.test(text) && text.includes("'exec'");
    });
    expect(launchers.length, 'expected the known pnpm exec call sites').toBeGreaterThanOrEqual(4);
    for (const file of launchers) {
      expect(
        readFileSync(file, 'utf8'),
        `${relative(SRC, file)} runs pnpm exec without PNPM_MANAGED_TREE_EXEC_CONFIG`,
      ).toContain('...PNPM_MANAGED_TREE_EXEC_CONFIG');
    }
  });

  it('installs managed trees with PNPM_MANAGED_TREE_INSTALL_CONFIG, never the bare linker flag', () => {
    // The bare flag let a managed-tree install adopt a parent folder's
    // pnpm-workspace.yaml and relink that workspace's node_modules.
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      let at = text.indexOf('PNPM_HOISTED_NODE_LINKER');
      while (at !== -1) {
        const lineStart = text.lastIndexOf('\n', at) + 1;
        const lastImport = text.lastIndexOf('import ', at);
        const inImport = lastImport !== -1 && !text.slice(lastImport, at).includes(';');
        const inComment = /^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, at));
        if (!inImport && !inComment) {
          const array = text.slice(text.lastIndexOf('[', at), text.indexOf(']', at) + 1);
          expect(array, `${relative(SRC, file)} installs with the bare linker flag`).not.toMatch(
            /'install'/,
          );
        }
        at = text.indexOf('PNPM_HOISTED_NODE_LINKER', at + 1);
      }
    }
    const bootstrap = readFileSync(join(SRC, 'system-toolsets', 'bootstrap.ts'), 'utf8');
    expect(bootstrap).toContain('...PNPM_MANAGED_TREE_INSTALL_CONFIG');
  });

  it('never pairs the bare hoisted-linker flag with exec', () => {
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      let at = text.indexOf('PNPM_HOISTED_NODE_LINKER');
      while (at !== -1) {
        const lineStart = text.lastIndexOf('\n', at) + 1;
        const lastImport = text.lastIndexOf('import ', at);
        const inImport = lastImport !== -1 && !text.slice(lastImport, at).includes(';');
        const inComment = /^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, at));
        if (!inImport && !inComment) {
          const array = text.slice(text.lastIndexOf('[', at), text.indexOf(']', at) + 1);
          expect(
            array,
            `${relative(SRC, file)} passes the bare linker flag to pnpm exec`,
          ).not.toMatch(/'(exec|run|dlx)'/);
        }
        at = text.indexOf('PNPM_HOISTED_NODE_LINKER', at + 1);
      }
    }
  });
});
