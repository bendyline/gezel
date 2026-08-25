import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectLocalIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveImportEdges } from '../filemap/affinity.js';
import type { Store } from '../fs/store.js';
import { ContentIndex } from '../index-store/content-index.js';
import { runWorkspaceContentIndex } from '../index-store/content-indexer.js';
import { IndexStore } from '../index-store/index-store.js';
import { runSecurityScan } from './scan.js';

/**
 * End-to-end over the security-intel stack: index a small app with PLANTED,
 * SYSTEMIC vulnerabilities, then confirm the built-in per-file scan (run in the
 * index hot path), the whole-repo scan (dependency inventory), and the
 * import-graph reachability all surface them. This is the "reliable tool" guard
 * — it runs in CI without any external OSS tool installed.
 */

// A SQL-injection class repeated across two routes (a systemic pattern), a
// hardcoded secret, a command-injection sink, and an entry point that wires the
// routes together (import edges for reachability).
const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'vuln-app', dependencies: { lodash: '^4.17.20' } },
    null,
    2,
  ),
  'src/index.js':
    "const users = require('./routes/users');\nconst orders = require('./routes/orders');\nmodule.exports = { users, orders };\n",
  'src/routes/users.js':
    'function getUser(req, res) {\n  return db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);\n}\nmodule.exports = getUser;\n',
  'src/routes/orders.js':
    'function getOrder(req, res) {\n  return db.query(`SELECT * FROM orders WHERE id = ${req.query.id}`);\n}\nmodule.exports = getOrder;\n',
  'src/config.js':
    'const apiKey = "sk_live_9fKd83jZq0PqLmN4vTx7Bc12";\nmodule.exports = { apiKey };\n',
  'src/exec.js':
    "const cp = require('child_process');\nfunction convert(req) {\n  return cp.exec('convert ' + req.query.file);\n}\nmodule.exports = convert;\n",
  // Non-npm grammars whose import specifiers must NOT become npm dependencies,
  // plus JS import shapes the sweep must and must not pick up.
  'native/util.py': 'import asyncio\nfrom PIL import Image\n',
  'native/main.c': '#include <windows.h>\n#include <stdio.h>\n',
  'src/plugins.js':
    "const undeclared = require('leftpad-classic');\nasync function load(base, name) {\n  return import(`${base}/plugins/${name}.js`);\n}\nmodule.exports = load;\n",
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-secint-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('security-intel end-to-end', () => {
  it('surfaces planted systemic findings, dependencies, and reachability', async () => {
    // 1. Index the workspace — this runs the built-in per-file security scan.
    await runWorkspaceContentIndex(dir, 'proj', join(dir, '.gezel', 'artifacts'));

    const store = await IndexStore.open(projectLocalIndexDbFile(dir), {
      collectionId: 'proj',
      kind: 'workspace',
      rootPath: dir,
    });
    expect(store).not.toBeNull();
    const s = store as IndexStore;

    // 2. Whole-repo scan (no external tools) builds the dependency inventory.
    const scan = await runSecurityScan(s, dir, { useExternalTools: false });
    expect(scan.engines).toContain('builtin');

    const findings = s.securityFindings({});
    const byCat = (c: string) => findings.filter((f) => f.category === c);

    // The SQL-injection class appears in BOTH route files — the systemic signal.
    const injectionFiles = new Set(byCat('injection').map((f) => f.filePath));
    expect(injectionFiles.has('src/routes/users.js')).toBe(true);
    expect(injectionFiles.has('src/routes/orders.js')).toBe(true);

    // Command injection + hardcoded secret + taint sources.
    expect(byCat('command-injection').length).toBeGreaterThan(0);
    expect(byCat('secret').some((f) => f.filePath === 'src/config.js')).toBe(true);
    expect(byCat('taint-source').length).toBeGreaterThan(0);

    // The stored secret evidence must NOT contain the raw credential value.
    const secret = byCat('secret').find((f) => f.filePath === 'src/config.js');
    expect(secret?.evidence ?? '').not.toContain('sk_live_9fKd83jZq0PqLmN4vTx7Bc12');

    // 3. Dependency inventory: declared + JS-imported npm packages only. The
    //    Python/C specifiers and the interpolated dynamic import must not mint
    //    npm dependency rows (the cstdint/asyncio pollution class).
    const deps = s.dependencies();
    const depNames = new Set(deps.map((d) => d.name));
    expect(depNames.has('lodash')).toBe(true);
    expect(depNames.has('leftpad-classic')).toBe(true);
    expect(depNames.has('asyncio')).toBe(false);
    expect(depNames.has('PIL')).toBe(false);
    expect(depNames.has('windows.h')).toBe(false);
    expect(depNames.has('stdio.h')).toBe(false);
    expect([...depNames].some((n) => n.includes('${'))).toBe(false);

    // Garbage import rows that predate the extractor fix (or arrive from a
    // future grammar) are fenced out by npm-name validation on the next scan.
    s.putImports('src/plugins.js', 'h-stale', [{ raw: '${pathToFileURL(path).href}?v=${name}' }]);
    await runSecurityScan(s, dir, { useExternalTools: false });
    expect(s.dependencies().some((d) => d.name.includes('${'))).toBe(false);

    // 3b. Scan provenance: no SCA tool ran, so the advisory count is marked
    //     unmeasured — never an unearned zero.
    expect(scan.sca).toEqual({ engine: null, measured: false, lockfiles: [] });
    const prov = JSON.parse(s.getMeta('security_scan_provenance') ?? 'null');
    expect(prov?.sca?.measured).toBe(false);
    expect(prov?.toolsAvailable).toEqual({
      semgrep: false,
      osvScanner: false,
      gitleaks: false,
      npm: false,
    });

    // 4. Import-graph reachability: index.js transitively reaches the vulnerable
    //    route files (the basis of trace_taint's blast-radius walk).
    const edges = resolveImportEdges(
      s.allFiles().map((f) => f.path),
      s.allImports().map((i) => ({ srcPath: i.srcPath, raw: i.raw })),
    );
    const fromIndex = edges.filter((e) => e.src === 'src/index.js').map((e) => e.dst);
    expect(fromIndex).toContain('src/routes/users.js');
    expect(fromIndex).toContain('src/routes/orders.js');

    s.close();

    // 5. The provenance round-trips through the ContentIndex read surfaces, so
    //    security_overview / list_dependencies can render "never measured"
    //    instead of an unearned "0 with advisories".
    const ci = new ContentIndex(
      {
        projectWorkspaceDir: async () => dir,
        projectArtifactsDir: () => join(dir, '.gezel', 'artifacts'),
      } as unknown as Store,
      join(dir, '.gezel-home'),
    );
    const rescan = await ci.securityScan('proj', { useExternalTools: false });
    expect(rescan.ran).toBe(true);
    expect(rescan.sca).toEqual({ engine: null, measured: false, lockfiles: [] });

    const overview = await ci.securityOverview('proj');
    expect(overview.scanned).toBe(true);
    expect(overview.provenance?.sca).toEqual({ engine: null, measured: false, lockfiles: [] });
    expect(overview.provenance?.toolsAvailable.osvScanner).toBe(false);

    const listed = await ci.listDependencies('proj');
    expect(listed.provenance?.sca.measured).toBe(false);
  });
});
