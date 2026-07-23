/**
 * The on-demand, whole-repo security pass. Deliberately kept OUT of the 60s
 * index tick (the cheap per-file built-in scan runs there); this heavier work is
 * triggered explicitly by the `security_scan` MCP tool / the deep-security-review
 * craftbook's recon phase.
 *
 * Two jobs:
 *  1. Build the dependency inventory deterministically from import specifiers +
 *     package.json (+ node_modules for resolved versions/licenses when present).
 *  2. Opportunistically enrich with OSS tools (semgrep/gitleaks findings, osv/
 *     npm-audit advisories) when they're installed — see external-tools.ts.
 */

import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { createLogger, nowIso } from '@bendyline/gezel';
import { safeJoin } from '../fs/safe-paths.js';
import type { DependencyInput, IndexStore } from '../index-store/index-store.js';
import {
  type AvailableTools,
  detectTools,
  runGitleaks,
  runNpmAudit,
  runOsvScanner,
  runSemgrep,
} from './external-tools.js';

const log = createLogger('security');
const BUILTINS = new Set(builtinModules);
const MAX_DEPS = 4000;

export interface SecurityScanResult {
  engines: string[];
  toolsAvailable: AvailableTools;
  findingCounts: {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    bySource: Record<string, number>;
  };
  dependencies: number;
  advisories: number;
}

/** Reduce a raw module specifier to its package name, or null when it's a
 *  relative path or a node builtin (not a third-party dependency). */
export function packageNameOf(spec: string): string | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null;
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  const top = bare.split('/')[0]!;
  if (BUILTINS.has(bare) || BUILTINS.has(top)) return null;
  if (bare.startsWith('@')) {
    const parts = bare.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return top;
}

interface ManifestDep {
  name: string;
  range: string;
  direct: boolean;
}

/** Parse every package.json in the workspace for its declared dependencies. */
async function readManifestDeps(
  store: IndexStore,
  workspaceDir: string,
): Promise<Map<string, ManifestDep>> {
  const out = new Map<string, ManifestDep>();
  const manifests = store
    .allFiles()
    .filter((f) => f.path === 'package.json' || f.path.endsWith('/package.json'));
  for (const m of manifests) {
    const abs = safeJoin(workspaceDir, m.path);
    if (!abs) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(await readFile(abs, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = json[field] as Record<string, string> | undefined;
      if (!deps) continue;
      const direct = field === 'dependencies';
      for (const [name, range] of Object.entries(deps)) {
        const existing = out.get(name);
        // A prod dependency outranks a dev/peer classification of the same name.
        if (!existing || (direct && !existing.direct)) out.set(name, { name, range, direct });
      }
    }
  }
  return out;
}

/** Best-effort resolved version + license from an installed node_modules copy. */
async function readInstalled(
  workspaceDir: string,
  name: string,
): Promise<{ version: string | null; license: string | null }> {
  const abs = safeJoin(workspaceDir, `node_modules/${name}/package.json`);
  if (!abs) return { version: null, license: null };
  try {
    const json = JSON.parse(await readFile(abs, 'utf8')) as {
      version?: string;
      license?: string | { type?: string };
    };
    const license = typeof json.license === 'string' ? json.license : (json.license?.type ?? null);
    return { version: json.version ?? null, license };
  } catch {
    return { version: null, license: null };
  }
}

async function buildDependencyInventory(
  store: IndexStore,
  workspaceDir: string,
): Promise<DependencyInput[]> {
  const manifest = await readManifestDeps(store, workspaceDir);

  // Union of declared deps and packages actually imported from source.
  const names = new Set<string>(manifest.keys());
  for (const { raw } of store.allImports()) {
    const name = packageNameOf(raw);
    if (name) names.add(name);
  }

  const deps: DependencyInput[] = [];
  for (const name of names) {
    if (deps.length >= MAX_DEPS) break;
    const declared = manifest.get(name);
    const installed = await readInstalled(workspaceDir, name);
    deps.push({
      name,
      ecosystem: 'npm',
      version: installed.version ?? declared?.range ?? null,
      direct: declared?.direct ?? false,
      license: installed.license,
    });
  }
  return deps;
}

/**
 * Run the whole-repo scan. `useExternalTools` gates the opportunistic OSS pass
 * (default on) — set false for a purely deterministic, offline scan.
 */
export async function runSecurityScan(
  store: IndexStore,
  workspaceDir: string,
  opts: { useExternalTools?: boolean } = {},
): Promise<SecurityScanResult> {
  const useExternal = opts.useExternalTools ?? true;
  const engines = ['builtin'];
  const tools: AvailableTools = useExternal
    ? await detectTools()
    : { semgrep: false, osvScanner: false, gitleaks: false, npm: false };

  const deps = await buildDependencyInventory(store, workspaceDir);
  const advisoryByName = new Map<string, { ids: string[]; sev: DependencyInput['maxSeverity'] }>();

  if (tools.semgrep) {
    const findings = await runSemgrep(workspaceDir);
    store.replaceToolFindings('semgrep', findings);
    engines.push('semgrep');
  }
  if (tools.gitleaks) {
    const findings = await runGitleaks(workspaceDir);
    store.replaceToolFindings('gitleaks', findings);
    engines.push('gitleaks');
  }
  // Prefer osv-scanner; fall back to npm audit only when osv isn't present.
  const advisories = tools.osvScanner
    ? await runOsvScanner(workspaceDir)
    : tools.npm
      ? await runNpmAudit(workspaceDir)
      : [];
  if (advisories.length) engines.push(tools.osvScanner ? 'osv-scanner' : 'npm-audit');
  for (const a of advisories)
    advisoryByName.set(a.name, { ids: a.advisoryIds, sev: a.maxSeverity });

  // Merge advisories into the inventory; surface advisory-only packages too.
  const seen = new Set(deps.map((d) => d.name));
  for (const d of deps) {
    const adv = advisoryByName.get(d.name);
    if (adv) {
      d.advisoryIds = adv.ids;
      d.maxSeverity = adv.sev;
    }
  }
  for (const [name, adv] of advisoryByName) {
    if (seen.has(name)) continue;
    deps.push({
      name,
      ecosystem: 'npm',
      version: null,
      direct: false,
      advisoryIds: adv.ids,
      maxSeverity: adv.sev,
    });
  }

  store.replaceDependencies(deps);
  store.setMeta('security_scanned_at', nowIso());

  const advisoryCount = deps.filter((d) => (d.advisoryIds?.length ?? 0) > 0).length;
  log.info(
    `[security] scan complete: engines=${engines.join(',')} deps=${deps.length} advisories=${advisoryCount}`,
  );

  return {
    engines,
    toolsAvailable: tools,
    findingCounts: store.securityFindingCounts(),
    dependencies: deps.length,
    advisories: advisoryCount,
  };
}
