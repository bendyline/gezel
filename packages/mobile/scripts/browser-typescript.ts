import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(
  require.resolve('@bendyline/gezel-script-runtime/package.json'),
);
const id = '\0gezel-browser-typescript';

/** TypeScript ships a browser-capable UMD compiler. Select that browser path explicitly:
 * there is no Node host, module loader, filesystem, or npm resolver in this Worker.
 * The user program is only parsed/transpiled here; QuickJS executes it separately.
 */
export function browserTypeScriptPlugin(): Plugin {
  return {
    name: 'gezel-browser-typescript',
    enforce: 'pre',
    resolveId(source) {
      return source === 'typescript' ? id : null;
    },
    async load(source) {
      if (source !== id) return null;
      const path = runtimeRequire.resolve('typescript');
      this.addWatchFile(path);
      const compiler = (await readFile(path, 'utf8')).replace(/^\/\/# sourceMappingURL=.*$/gm, '');
      return `const process = undefined; const require = undefined; const module = undefined;\n${compiler}\nexport default ts;`;
    },
  };
}
