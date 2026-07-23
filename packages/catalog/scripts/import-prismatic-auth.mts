/**
 * Prismatic auth-catalog harvest (build-time, self-contained). Reads each
 * Apache-2.0 Prismatic component's `connections` module and emits the AUTH HALF
 * of a `connector-type` manifest — the `secretShape` (authorize/token URLs,
 * scopes, secret field names) + `configSchema` (non-secret per-binding fields).
 * Feeds EVERY driver, not just `spectral`: correct OAuth config is the
 * boilerplate-heavy, security-sensitive part we'd otherwise hand-write 170×.
 *
 * Strategy: STUB-AND-IMPORT, not AST-guessing. esbuild-bundles each connections
 * module with `@prismatic-io/spectral` aliased to identity factories, so the
 * pure declarative object literals execute (following relative imports too)
 * while nothing but object construction runs. Output is staged under
 * `scripts/harvested-auth/` for a human to promote into `data/connector-types/`.
 *
 * Usage: tsx scripts/import-prismatic-auth.mts [componentsDir] [--limit N]
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Plugin, build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const limitFlag = args.indexOf('--limit');
const LIMIT = limitFlag >= 0 ? Number(args[limitFlag + 1]) : Number.POSITIVE_INFINITY;
const COMPONENTS = resolve(
  args.find((a) => !a.startsWith('--') && a !== String(LIMIT)) ??
    join(here, '../../../../components/components'),
);
const OUT = join(here, 'harvested-auth');

const SPECTRAL_STUB = `
export const oauth2Connection = (x) => ({ ...x, __kind: 'oauth2' });
export const connection = (x) => ({ ...x, __kind: 'apikey' });
export const input = (x) => x;
export const OAuth2Type = new Proxy({}, { get: (_, p) => String(p) });
export const OAuth2PkceMethod = new Proxy({}, { get: (_, p) => String(p) });
const anyFn = new Proxy(function () {}, { get: () => anyFn, apply: () => ({}) });
export const util = anyFn;
export default anyFn;
`;

// Any other bare import (aws-utils, form-data, a sibling helper) resolves to a
// deeply-permissive proxy so the pure connection object literals still execute.
const GENERIC_STUB = `
const anyFn = new Proxy(function () {}, { get: () => anyFn, apply: () => ({}) });
module.exports = anyFn;
`;

const stubPlugin: Plugin = {
  name: 'spectral-stub',
  setup(b) {
    b.onResolve({ filter: /^@prismatic-io\/spectral$/ }, () => ({
      path: 'spectral',
      namespace: 'spectral-stub',
    }));
    b.onResolve({ filter: /^[^./]/ }, (a) =>
      a.path.startsWith('@prismatic-io/spectral')
        ? { path: 'spectral', namespace: 'spectral-stub' }
        : { path: a.path, namespace: 'generic-stub' },
    );
    b.onLoad({ filter: /.*/, namespace: 'spectral-stub' }, () => ({
      contents: SPECTRAL_STUB,
      loader: 'js',
    }));
    b.onLoad({ filter: /.*/, namespace: 'generic-stub' }, () => ({
      contents: GENERIC_STUB,
      loader: 'js',
    }));
  },
};

interface ConnInput {
  label?: string;
  type?: string;
  required?: boolean;
  shown?: boolean;
  default?: unknown;
  comments?: string;
}
interface ConnDef {
  __kind?: 'oauth2' | 'apikey';
  key?: string;
  oauth2Type?: string;
  oauth2PkceMethod?: string;
  inputs?: Record<string, ConnInput>;
  display?: { label?: string; description?: string };
}

async function findConnectionsEntry(componentSrc: string): Promise<string | null> {
  for (const candidate of ['connections.ts', 'connections/index.ts']) {
    const p = join(componentSrc, candidate);
    try {
      await readFile(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function loadConnections(entry: string): Promise<ConnDef[]> {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [stubPlugin],
  });
  const tmp = join(tmpdir(), `harvest-${Math.abs(hashStr(entry))}.mjs`);
  await writeFile(tmp, res.outputFiles[0]!.text);
  try {
    const mod = (await import(pathToFileURL(tmp).href)) as { default?: unknown };
    const defs = Array.isArray(mod.default) ? mod.default : [];
    return defs as ConnDef[];
  } finally {
    await rm(tmp, { force: true });
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function mapConnection(def: ConnDef): Record<string, unknown> | null {
  const inputs = def.inputs ?? {};
  const secretShape: Record<string, unknown> = {};
  const configProps: Record<string, unknown> = {};
  const required: string[] = [];

  const isOAuth = def.__kind === 'oauth2' || !!def.oauth2Type;
  for (const [key, inp] of Object.entries(inputs)) {
    const isSecret = inp.type === 'password';
    const hasFixedDefault = inp.default !== undefined && inp.shown === false;
    if (hasFixedDefault) continue; // baked into secretShape below, not a per-binding field
    if (isSecret) {
      secretShape.fields ??= [] as string[];
      (secretShape.fields as string[]).push(key);
    } else {
      configProps[key] = { type: inp.type ?? 'string', ...(inp.label ? { title: inp.label } : {}) };
      if (inp.required) required.push(key);
    }
  }

  if (isOAuth) {
    secretShape.kind = 'oauth2';
    if (inputs.authorizeUrl?.default) secretShape.authorizeUrl = inputs.authorizeUrl.default;
    if (inputs.tokenUrl?.default) secretShape.tokenUrl = inputs.tokenUrl.default;
    if (inputs.scopes?.default) secretShape.scopes = inputs.scopes.default;
    if (def.oauth2PkceMethod) secretShape.pkce = true;
  } else {
    secretShape.kind = 'apikey';
  }

  return {
    _harvest: { connectionKey: def.key, kind: secretShape.kind },
    secretShape,
    configSchema: {
      type: 'object',
      properties: configProps,
      ...(required.length ? { required } : {}),
    },
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const components = (await readdir(COMPONENTS, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .slice(0, LIMIT);

  let ok = 0;
  let skipped = 0;
  for (const name of components) {
    const entry = await findConnectionsEntry(join(COMPONENTS, name, 'src'));
    if (!entry) {
      skipped++;
      continue;
    }
    try {
      const defs = await loadConnections(entry);
      const auth = defs.map(mapConnection).filter(Boolean);
      if (auth.length === 0) {
        skipped++;
        continue;
      }
      await writeFile(
        join(OUT, `${name}.json`),
        `${JSON.stringify({ component: name, auth }, null, 2)}\n`,
      );
      ok++;
    } catch (err) {
      skipped++;
      console.warn(`skip ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`harvested ${ok} components → ${OUT} (${skipped} skipped)`);
}

await main();
