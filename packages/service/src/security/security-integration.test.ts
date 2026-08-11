import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectLocalIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveImportEdges } from '../filemap/affinity.js';
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

    // 3. Dependency inventory picked up the declared package.
    const deps = s.dependencies();
    expect(deps.some((d) => d.name === 'lodash')).toBe(true);

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
  });
});
