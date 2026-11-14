#!/usr/bin/env node
/**
 * Back up catalog chat models as verified, portable `.gezmodel` bundles.
 *
 *   node scripts/backup-models.mjs [--dest /Volumes/Bendyline/models] [--max-gb 80]
 *                                  [--only id,id] [--concurrency 4] [--dry-run]
 *                                  [--reverify] [--prune] [--stop-daemon]
 *   node scripts/backup-models.mjs --restore-test id[,id]
 *
 * Each bundle is named by the catalog item it was made from,
 * `<dest>/<engine>/<id>@<catalog-version>.gezmodel`, beside a sidecar
 * `<id>@<catalog-version>.json` recording the Gilde package, the Hugging Face
 * repo and revision, every pinned file's SHA-256 and a weights signature.
 * Re-running the script compares the catalog this checkout pins against what
 * is on disk and makes only what is missing or out of date. A version whose
 * weights did not change is rebuilt from the previous bundle, not downloaded.
 *
 * The work goes through the gezel CLI (`model pull`, `model export`) against
 * a dedicated staging daemon in its own home (default ~/.gezel-model-backup),
 * so the desktop app's and the evals' homes are never written. That daemon
 * reports a `cuda` llama.cpp backend so installs fetch every file the catalog
 * pins, including drafters limited to GPU backends; it downloads and exports
 * only and never runs a model.
 *
 * Every bundle is then verified independently of gezel's own checks: each
 * entry is re-hashed from the archive and every model file is compared with
 * the SHA-256 and size the Gilde version manifest pins, with no file missing
 * and none extra.
 *
 * Only the llama.cpp (GGUF) engine is supported. Uses the built CLI and client
 * (`packages/*\/dist`), so build the workspace first.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'packages/cli/dist/bin/gezel.js');
const DAEMON = join(REPO, 'packages/service/dist/bin/gezeld.js');
const ENGINE = 'llama-cpp';
const SIDECAR_SCHEMA = 'gezel-model-backup/1';
const DEFAULT_SEED_HOMES = ['~/.gezel-eval-cache', '~/.gezel-dev', '~/.gezel'];
/** Kept free on the destination volume beyond the bundles a run writes. */
const DEST_MARGIN_BYTES = 20e9;

const requireFromService = createRequire(join(REPO, 'packages/service/package.json'));
const requireFromInference = createRequire(join(REPO, 'packages/inference/package.json'));
const yauzl = requireFromInference('yauzl');
const { discoverOrSpawn } = await import(
  pathToFileURL(join(REPO, 'packages/client/dist/node.js')).href
);

const { values: args } = parseArgs({
  options: {
    dest: { type: 'string', default: '/Volumes/Bendyline/models' },
    'max-gb': { type: 'string', default: '80' },
    concurrency: { type: 'string', default: '4' },
    only: { type: 'string' },
    staging: { type: 'string', default: '~/.gezel-model-backup' },
    'seed-home': { type: 'string', multiple: true },
    'no-seed': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    reverify: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    'keep-staged': { type: 'boolean', default: false },
    'restore-test': { type: 'string' },
    'stop-daemon': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(
    readFileSyncHeader(fileURLToPath(import.meta.url))
      .replace(/^\/\*\*\n|\s*\*\/$/g, '')
      .replace(/^ \* ?/gm, ''),
  );
  process.exit(0);
}

const expandHome = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const DEST = resolve(args.dest);
const DEST_ENGINE = join(DEST, ENGINE);
const INCOMING = join(DEST_ENGINE, '.incoming');
const STAGING = expandHome(args.staging);
const STAGED_MODELS = join(STAGING, 'engines', ENGINE, 'models');
const LOGS = join(STAGING, 'logs', 'model-backup');
const MAX_BYTES = Number(args['max-gb']) * 1e9;
const CONCURRENCY = Math.max(1, Number.parseInt(args.concurrency, 10) || 1);
const ONLY = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : null;
const SEED_HOMES = args['no-seed']
  ? []
  : (args['seed-home'] ?? DEFAULT_SEED_HOMES).map(expandHome).filter((h) => h !== STAGING);

const GILDE_ROOT = dirname(requireFromService.resolve('@bendyline/gilde/package.json'));
const GILDE_VERSION = JSON.parse(await readFile(join(GILDE_ROOT, 'package.json'), 'utf8')).version;
const GILDE_MODELS = join(GILDE_ROOT, 'data', 'chat-models');

function readFileSyncHeader(path) {
  const text = readFileSync(path, 'utf8');
  return text.slice(text.indexOf('/**'), text.indexOf('*/') + 2);
}

function log(line) {
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${at}] ${line}`);
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;

// ── Catalog: what each backup must contain ───────────────────────────────

/** Every file a llama.cpp source pins, whatever backend this machine has. */
function pinnedFiles(src) {
  const files = [];
  const add = (path, sha256, sizeBytes, role, from) =>
    files.push({
      name: basename(path),
      role,
      sizeBytes,
      sha256: sha256.toLowerCase(),
      ...(from?.huggingfaceRepo && from.huggingfaceRepo !== src.huggingfaceRepo
        ? { huggingfaceRepo: from.huggingfaceRepo }
        : {}),
      ...(from?.revision && from.revision !== src.revision ? { revision: from.revision } : {}),
      ...(from?.backends ? { backends: from.backends } : {}),
    });
  if (src.shards?.length) {
    for (const shard of src.shards) add(shard.name, shard.sha256, shard.sizeBytes, 'weights');
  } else {
    add(src.filename, src.sha256, src.approxSizeBytes, 'weights');
  }
  if (src.mmproj) add(src.mmproj.filename, src.mmproj.sha256, src.mmproj.sizeBytes, 'mmproj');
  if (src.visionEncoder) {
    const v = src.visionEncoder;
    add(v.filename, v.sha256, v.sizeBytes, 'vision-encoder', v);
  }
  if (src.draftModel) {
    const d = src.draftModel;
    add(d.filename, d.sha256, d.sizeBytes, 'draft-model', d);
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Identifies the weights alone: unchanged across a version bump that only retuned the model. */
function weightsSignature(files) {
  const lines = files.map((f) => `${f.name}\t${f.sha256}\t${f.sizeBytes}\n`).join('');
  return `sha256:${createHash('sha256').update(lines).digest('hex')}`;
}

async function readGildeVersion(id, version) {
  const path = join(
    GILDE_MODELS,
    id.slice(0, 2).toLowerCase(),
    id,
    'versions',
    version,
    'manifest.json',
  );
  return JSON.parse(await readFile(path, 'utf8'));
}

async function catalogIds() {
  const index = JSON.parse(await readFile(join(GILDE_MODELS, 'raw-index.json'), 'utf8'));
  return index.items.map((item) => ({ id: item.id, name: item.identity?.name ?? item.id }));
}

/**
 * The version the daemon installs (newest this build accepts), with the pins
 * read from the Gilde version manifest itself rather than the daemon's copy.
 */
async function planEntry(client, id) {
  let detail;
  try {
    detail = await client.getCatalogItem('chat-model', id);
  } catch (error) {
    return { id, status: 'unavailable', reason: `not resolvable by this build: ${error.message}` };
  }
  const manifest = detail?.manifest;
  if (!manifest?.llamaCpp) return { id, status: 'no-engine', reason: 'no llama.cpp build' };
  const version = manifest.version;
  const gilde = await readGildeVersion(id, version);
  if (!gilde.llamaCpp) {
    return { id, status: 'failed', reason: `Gilde ${id}@${version} has no llama.cpp source` };
  }
  const files = pinnedFiles(gilde.llamaCpp);
  const daemonFiles = pinnedFiles(manifest.llamaCpp);
  if (weightsSignature(files) !== weightsSignature(daemonFiles)) {
    return {
      id,
      version,
      status: 'failed',
      reason: `the daemon's pins for ${id}@${version} differ from the Gilde ${GILDE_VERSION} files`,
    };
  }
  const bytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  return {
    id,
    name: manifest.name,
    version,
    signature: `${id}@${version}`,
    source: { huggingfaceRepo: gilde.llamaCpp.huggingfaceRepo, revision: gilde.llamaCpp.revision },
    files,
    weightsSignature: weightsSignature(files),
    bytes,
    status: bytes > MAX_BYTES ? 'too-large' : 'pending',
  };
}

// ── Destination: what is already backed up ──────────────────────────────

const bundlePath = (signature) => join(DEST_ENGINE, `${signature}.gezmodel`);
const sidecarPath = (signature) => join(DEST_ENGINE, `${signature}.json`);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function sizeOf(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** All sidecars on disk, keyed by signature. */
async function existingBackups() {
  const out = new Map();
  let names = [];
  try {
    names = await readdir(DEST_ENGINE);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'index.json') continue;
    const sidecar = await readJson(join(DEST_ENGINE, name));
    if (sidecar?.schema !== SIDECAR_SCHEMA) continue;
    out.set(sidecar.signature, sidecar);
  }
  return out;
}

async function isCurrent(entry, sidecar) {
  if (!sidecar?.verification?.ok) return false;
  if (sidecar.weightsSignature !== entry.weightsSignature) return false;
  const size = await sizeOf(bundlePath(entry.signature));
  return size !== null && size === sidecar.bundle?.sizeBytes;
}

// ── Independent verification ──────────────────────────────────────────────

function openZip(path) {
  return new Promise((resolveZip, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true },
      (error, zip) => (error ? reject(error) : resolveZip(zip)),
    );
  });
}

function zipEntries(zip) {
  return new Promise((resolveEntries, reject) => {
    const entries = [];
    zip.on('entry', (entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolveEntries(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function entryStream(zip, entry) {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolveStream(stream)));
  });
}

async function hashEntry(zip, entry) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = await entryStream(zip, entry);
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Re-read the whole archive and check it against the catalog, not against
 * the bundle's own manifest alone: right engine, id and version; every
 * pinned file present once with its pinned size and SHA-256; nothing else
 * under `model/`; every metadata entry matching the hash the bundle declares.
 */
async function verifyBundle(path, entry) {
  const started = Date.now();
  const problems = [];
  const zip = await openZip(path);
  let hashedBytes = 0;
  try {
    const entries = await zipEntries(zip);
    const byName = new Map();
    for (const e of entries) {
      if (byName.has(e.fileName)) problems.push(`duplicate archive entry ${e.fileName}`);
      byName.set(e.fileName, e);
    }
    const rootEntry = byName.get('manifest.json');
    if (!rootEntry) return { ok: false, problems: ['no root manifest.json'] };
    const root = JSON.parse((await readEntry(zip, rootEntry)).toString('utf8'));
    if (root.kind !== 'gezel-model') problems.push(`root kind is ${root.kind}`);
    if (root.engine !== ENGINE) problems.push(`engine is ${root.engine}, not ${ENGINE}`);
    if (root.id !== entry.id) problems.push(`bundle id is ${root.id}, not ${entry.id}`);
    if (root.catalogVersion !== entry.version) {
      problems.push(`bundle version is ${root.catalogVersion}, not ${entry.version}`);
    }

    const declared = new Map(root.files.map((f) => [f.path, f]));
    for (const name of byName.keys()) {
      if (name !== 'manifest.json' && !declared.has(name)) {
        problems.push(`archive entry ${name} is not declared in the bundle manifest`);
      }
    }
    const modelPaths = root.files.filter((f) => f.role === 'model').map((f) => f.path);
    const expected = new Map(entry.files.map((f) => [`model/${f.name}`, f]));
    for (const p of modelPaths) {
      if (!expected.has(p)) problems.push(`extra model file ${p} (not pinned by the catalog)`);
    }
    for (const p of expected.keys()) {
      if (!modelPaths.includes(p)) problems.push(`missing model file ${p}`);
    }

    // Archive order is write order, so this reads the file front to back.
    for (const e of entries) {
      if (e.fileName === 'manifest.json') continue;
      const want = declared.get(e.fileName);
      if (!want) continue;
      const got = await hashEntry(zip, e);
      hashedBytes += got.bytes;
      if (got.bytes !== want.sizeBytes) {
        problems.push(`${e.fileName}: ${got.bytes} bytes, bundle declares ${want.sizeBytes}`);
      }
      if (got.sha256 !== want.sha256)
        problems.push(`${e.fileName}: SHA-256 differs from the bundle manifest`);
      const pin = expected.get(e.fileName);
      if (pin) {
        if (got.bytes !== pin.sizeBytes) {
          problems.push(`${e.fileName}: ${got.bytes} bytes, catalog pins ${pin.sizeBytes}`);
        }
        if (got.sha256 !== pin.sha256)
          problems.push(`${e.fileName}: SHA-256 differs from the catalog pin`);
      }
    }

    const catalogEntry = byName.get('manifests/catalog.json');
    const installedEntry = byName.get('manifests/installed.json');
    if (!catalogEntry) problems.push('no manifests/catalog.json');
    if (!installedEntry) problems.push('no manifests/installed.json');
    if (catalogEntry) {
      const catalog = JSON.parse((await readEntry(zip, catalogEntry)).toString('utf8'));
      if (catalog.id !== entry.id || catalog.version !== entry.version) {
        problems.push(`embedded catalog manifest is ${catalog.id}@${catalog.version}`);
      }
    }
    if (installedEntry) {
      const installed = JSON.parse((await readEntry(zip, installedEntry)).toString('utf8'));
      if (installed.id !== entry.id) problems.push(`installed manifest id is ${installed.id}`);
      if (installed.catalogVersion !== entry.version) {
        problems.push(`installed manifest version is ${installed.catalogVersion}`);
      }
      for (const f of entry.files) {
        if (installed.fileSha256?.[f.name]?.toLowerCase() !== f.sha256) {
          problems.push(`installed manifest does not record ${f.name} at its pinned SHA-256`);
        }
      }
    }
  } finally {
    zip.close();
  }
  return {
    ok: problems.length === 0,
    problems,
    hashedBytes,
    seconds: Math.round((Date.now() - started) / 1000),
    at: new Date().toISOString(),
  };
}

async function readEntry(zip, entry) {
  const chunks = [];
  for await (const chunk of await entryStream(zip, entry)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── Staging daemon and CLI ───────────────────────────────────────────────

const LAUNCHER_ENV = ['GEZEL_PORT', 'GEZEL_SERVICE_ROLE', 'GEZEL_SYSTEM_SCOPE', 'GEZEL_WEB'];

const NO_LAUNCH_BIN = join(STAGING, 'bin', 'llama-server');
const REAL_LLAMA_BIN = join(REPO, 'packages/app/native-bin/darwin-arm64-metal/gezel-llama-server');

/**
 * A llama-server that refuses to start. The daemon probes every model it
 * installs and runs background turns on whatever is installed; here that would
 * load up to 80 GB per model for nothing. Alone in its folder, it has no
 * sibling build a crash fallback could switch to, so the backend stays put.
 */
async function writeNoLaunchBin() {
  await mkdir(dirname(NO_LAUNCH_BIN), { recursive: true });
  await writeFile(
    NO_LAUNCH_BIN,
    '#!/bin/sh\necho "model launches are disabled in the model-backup staging home" >&2\nexit 1\n',
    { mode: 0o755 },
  );
}

function stagingEnv() {
  const env = { ...process.env };
  for (const key of [...LAUNCHER_ENV, 'GEZEL_READONLY_MODEL_HOMES', 'GEZEL_LLAMA_SERVER_URL']) {
    delete env[key];
  }
  return {
    ...env,
    GEZEL_HOME: STAGING,
    // Fetch every pinned file: a pre-set binary keeps native discovery from
    // replacing the backend, and `cuda` is a backend every GPU-limited drafter
    // in the catalog names.
    GEZEL_LLAMA_SERVER_BIN: NO_LAUNCH_BIN,
    GEZEL_LLAMA_SERVER_BACKEND: 'cuda',
    // No image reader pulled in beside a model that cannot see.
    GEZEL_NO_AUTO_VISION: '1',
    // A quiet, isolated home: no first-run model pick, no tool bootstrap, no
    // embedders or background indexing, no machine engine or shared projects.
    GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    GEZEL_SECRETS_BACKEND: 'file',
    GEZEL_DISABLE_FIRST_USE_GRACE: '1',
    GEZEL_DISABLE_EMBEDDINGS: '1',
    GEZEL_DISABLE_IMAGE_EMBEDDINGS: '1',
    GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
    GEZEL_DISABLE_RELEVANCE_MODEL: '1',
    GEZEL_DISABLE_BACKGROUND_ENRICH: '1',
    GEZEL_DISABLE_PROJECT_TYPE_UPGRADES: '1',
    GEZEL_DISABLE_MACHINE_ENGINE: '1',
    GEZEL_DISABLE_MACHINE_SHARED: '1',
    GEZEL_MACHINE_SHARED_HOME: join(STAGING, '.no-machine-shared'),
  };
}

/**
 * Start a fresh daemon for `home`, stopping one already serving it: a
 * daemon left by an earlier run keeps the environment it started with.
 */
async function startDaemon(home, env) {
  await mkdir(home, { recursive: true });
  await gezelAt(home, env, ['stop']);
  return discoverOrSpawn({
    daemonEntry: DAEMON,
    home,
    env,
    detached: true,
    writeLogFile: true,
    forceSpawn: true,
    timeoutMs: 60_000,
  });
}

/** Run one gezel CLI command against the staging home, output to a log file. */
async function gezel(cliArgs, logName) {
  await mkdir(LOGS, { recursive: true });
  const logPath = join(LOGS, `${logName}.log`);
  const out = await open(logPath, 'a');
  try {
    await out.write(`\n$ gezel ${cliArgs.join(' ')}\n`);
    const code = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [CLI, '--standalone', '--home', STAGING, ...cliArgs], {
        env: stagingEnv(),
        stdio: ['ignore', out.fd, out.fd],
      });
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolveExit(signal ? 128 : (exitCode ?? 1)));
    });
    return { code, logPath };
  } finally {
    await out.close();
  }
}

async function tail(path, lines = 6) {
  try {
    const text = (await readFile(path, 'utf8')).split(/\r|\n/).filter((l) => l.trim());
    return text.slice(-lines).join(' | ');
  } catch {
    return '';
  }
}

// ── Seeding: reuse bytes already on disk ─────────────────────────────────

/** Files other homes recorded at a verified SHA-256, and files in earlier backups. */
async function seedIndex() {
  const bySha = new Map();
  for (const home of SEED_HOMES) {
    const root = join(home, 'engines', ENGINE, 'models');
    let ids = [];
    try {
      ids = await readdir(root);
    } catch {
      continue;
    }
    for (const id of ids) {
      const manifest = await readJson(join(root, id, 'manifest.json'));
      for (const [name, sha] of Object.entries(manifest?.fileSha256 ?? {})) {
        const path = join(root, id, name);
        const size = await sizeOf(path);
        if (size !== null && !bySha.has(sha.toLowerCase())) {
          bySha.set(sha.toLowerCase(), { kind: 'file', path, size });
        }
      }
    }
  }
  if (!args['no-seed']) {
    for (const sidecar of (await existingBackups()).values()) {
      if (!sidecar.verification?.ok) continue;
      const bundle = bundlePath(sidecar.signature);
      if ((await sizeOf(bundle)) !== sidecar.bundle?.sizeBytes) continue;
      for (const f of sidecar.files) {
        if (!bySha.has(f.sha256)) {
          bySha.set(f.sha256, {
            kind: 'bundle',
            bundle,
            entry: `model/${f.name}`,
            size: f.sizeBytes,
          });
        }
      }
    }
  }
  return bySha;
}

/**
 * Put already-verified copies of a model's pinned files into its staging
 * folder with a manifest recording their digests. The installer skips any
 * file whose recorded digest equals the pin and whose size matches, so the
 * pull downloads only what no source had. Files are cloned (APFS) or copied,
 * never hard-linked, so nothing the installer does can touch a source home.
 * The final verification re-hashes every byte, so a bad seed cannot pass.
 */
async function seed(entry, index) {
  const dir = join(STAGED_MODELS, entry.id);
  const existing = (await readJson(join(dir, 'manifest.json')))?.fileSha256 ?? {};
  const recorded = {};
  let seededBytes = 0;
  for (const f of entry.files) {
    const target = join(dir, f.name);
    if (existing[f.name]?.toLowerCase() === f.sha256 && (await sizeOf(target)) === f.sizeBytes) {
      recorded[f.name] = f.sha256;
      seededBytes += f.sizeBytes;
      continue;
    }
    const source = index.get(f.sha256);
    if (!source || source.size !== f.sizeBytes) continue;
    await mkdir(dir, { recursive: true });
    const partial = `${target}.seed-${randomUUID()}`;
    try {
      if (source.kind === 'file') {
        await copyFile(source.path, partial, constants.COPYFILE_FICLONE);
      } else {
        await extractEntry(source.bundle, source.entry, partial);
      }
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      log(`  ${entry.id}: could not reuse ${f.name} (${error.message}); it will be downloaded`);
      continue;
    }
    recorded[f.name] = f.sha256;
    seededBytes += f.sizeBytes;
  }
  if (Object.keys(recorded).length > 0) {
    await writeFile(
      join(dir, 'manifest.json'),
      `${JSON.stringify({ id: entry.id, name: entry.name, fileSha256: recorded }, null, 2)}\n`,
    );
  }
  return seededBytes;
}

async function extractEntry(bundle, entryName, dest) {
  const zip = await openZip(bundle);
  try {
    const entries = await zipEntries(zip);
    const entry = entries.find((e) => e.fileName === entryName);
    if (!entry) throw new Error(`${entryName} is not in ${basename(bundle)}`);
    await pipeline(await entryStream(zip, entry), createWriteStream(dest, { flags: 'wx' }));
  } finally {
    zip.close();
  }
}

// ── One model ────────────────────────────────────────────────────────────

async function pull(entry, index) {
  const seeded = index ? await seed(entry, index) : 0;
  if (seeded > 0) log(`  ${entry.signature}: reusing ${gb(seeded)} already on disk`);
  log(`  ${entry.signature}: downloading ${gb(entry.bytes - seeded)}`);
  let last = { code: 1, logPath: '' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await gezel(['model', 'pull', entry.id, '--provider', ENGINE], entry.signature);
    if (last.code === 0) return { ok: true };
    log(`  ${entry.signature}: pull attempt ${attempt} failed: ${await tail(last.logPath, 3)}`);
  }
  return { ok: false, reason: `pull failed: ${await tail(last.logPath, 3)}` };
}

async function exportAndVerify(entry, context) {
  await mkdir(INCOMING, { recursive: true });
  const incoming = join(INCOMING, `${entry.signature}.gezmodel`);
  const result = await gezel(
    ['model', 'export', entry.id, incoming, '--provider', ENGINE, '--no-pull', '--force'],
    entry.signature,
  );
  if (result.code !== 0) {
    return { ok: false, reason: `export failed: ${await tail(result.logPath, 4)}` };
  }
  log(`  ${entry.signature}: exported, verifying against the catalog pins`);
  const verification = await verifyBundle(incoming, entry);
  if (!verification.ok) {
    return { ok: false, reason: verification.problems.join('; '), verification, incoming };
  }
  const bundleSize = await sizeOf(incoming);
  const sidecar = {
    schema: SIDECAR_SCHEMA,
    signature: entry.signature,
    id: entry.id,
    name: entry.name,
    engine: ENGINE,
    catalogVersion: entry.version,
    weightsSignature: entry.weightsSignature,
    gilde: { package: '@bendyline/gilde', version: GILDE_VERSION },
    source: entry.source,
    files: entry.files,
    bundle: { file: basename(bundlePath(entry.signature)), sizeBytes: bundleSize },
    exportedAt: new Date().toISOString(),
    exportedBy: { daemonVersion: context.daemonVersion, gitCommit: context.gitCommit },
    verification,
  };
  await rename(incoming, bundlePath(entry.signature));
  await writeFile(sidecarPath(entry.signature), `${JSON.stringify(sidecar, null, 2)}\n`);
  return { ok: true, sidecar };
}

async function dropStaged(client, id) {
  if (args['keep-staged']) return;
  await client.deleteLlamaCppModel(id).catch(() => {});
  await rm(join(STAGED_MODELS, id), { recursive: true, force: true });
}

// ── Index ────────────────────────────────────────────────────────────────

async function writeIndex(plan, superseded, orphaned) {
  const backups = await existingBackups();
  const models = plan.map((e) => {
    const sidecar = e.signature ? backups.get(e.signature) : null;
    return {
      id: e.id,
      ...(e.version ? { catalogVersion: e.version, signature: e.signature } : {}),
      status: e.status,
      ...(e.bytes ? { modelBytes: e.bytes } : {}),
      ...(sidecar?.verification?.ok
        ? { bundle: sidecar.bundle.file, verifiedAt: sidecar.verification.at }
        : {}),
      ...(e.reason ? { reason: e.reason } : {}),
    };
  });
  const index = {
    schema: 'gezel-model-backup-index/1',
    generatedAt: new Date().toISOString(),
    engine: ENGINE,
    gilde: { package: '@bendyline/gilde', version: GILDE_VERSION },
    maxModelBytes: MAX_BYTES,
    counts: Object.fromEntries(
      [...new Set(models.map((m) => m.status))].map((s) => [
        s,
        models.filter((m) => m.status === s).length,
      ]),
    ),
    models,
    superseded,
    orphaned,
  };
  await writeFile(join(DEST, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
}

// ── Restore test ─────────────────────────────────────────────────────────

/**
 * Import bundles into a throwaway home the way the app does (upload, scan,
 * confirm), check the restored install records every pinned file, then wait
 * for the daemon's own post-install fitness probe: it loads the restored
 * model in llama-server and runs a turn, so a pass means the model works.
 */
async function restoreTest(ids) {
  const home = join(STAGING, 'restore-test');
  await rm(home, { recursive: true, force: true });
  // An ordinary Metal daemon, not the staging one's `cuda` view, so the
  // import is judged the way a restore on this computer would be.
  const env = {
    ...stagingEnv(),
    GEZEL_HOME: home,
    GEZEL_MACHINE_SHARED_HOME: join(home, '.none'),
    GEZEL_LLAMA_SERVER_BIN: REAL_LLAMA_BIN,
    GEZEL_LLAMA_SERVER_BACKEND: 'metal',
  };
  const { client } = await startDaemon(home, env);
  const backups = await existingBackups();
  let failures = 0;
  try {
    for (const id of ids) {
      const sidecar = [...backups.values()]
        .filter((s) => s.id === id && s.verification?.ok)
        .sort((a, b) => b.exportedAt.localeCompare(a.exportedAt))[0];
      if (!sidecar) {
        log(`restore ${id}: no verified backup`);
        failures++;
        continue;
      }
      const path = bundlePath(sidecar.signature);
      const size = await sizeOf(path);
      log(`restore ${sidecar.signature}: importing ${gb(size)} into a scratch home`);
      const started = Date.now();
      const { Readable } = await import('node:stream');
      const review = await client.scanModelBundle(Readable.toWeb(createReadStream(path)), {
        totalBytes: size,
      });
      await client.confirmModelBundleImport(review.importId);
      const installedPath = join(home, 'engines', ENGINE, 'models', id, 'manifest.json');
      const installed = await readJson(installedPath);
      const problems = [];
      if (installed?.catalogVersion !== sidecar.catalogVersion) {
        problems.push(`restored version ${installed?.catalogVersion}`);
      }
      for (const f of sidecar.files) {
        const file = join(home, 'engines', ENGINE, 'models', id, f.name);
        if ((await sizeOf(file)) !== f.sizeBytes) problems.push(`${f.name} size`);
        if (installed?.fileSha256?.[f.name]?.toLowerCase() !== f.sha256) {
          problems.push(`${f.name} not recorded at its pin`);
        }
      }
      const listed = (await client.listLlamaCppModels()).models.some((m) => m.id === id);
      if (!listed) problems.push('not listed as installed');
      const fitness = problems.length ? null : await waitForFitness(client, id);
      if (fitness && !(fitness.status === 'probed' && fitness.admitted)) {
        problems.push(
          `fitness probe ${fitness.status}${fitness.admitted === false ? ' (not admitted)' : ''}`,
        );
      }
      const secs = Math.round((Date.now() - started) / 1000);
      if (problems.length) {
        failures++;
        log(`restore ${sidecar.signature}: FAILED (${problems.join('; ')})`);
      } else {
        log(
          `restore ${sidecar.signature}: ok in ${secs}s, ${sidecar.files.length} file(s) installed at their pins; loaded and answered at ${fitness.genTokensPerSec?.toFixed(0) ?? '?'} tok/s`,
        );
      }
      await client.deleteLlamaCppModel(id).catch(() => {});
    }
  } finally {
    await gezelAt(home, env, ['stop']);
    // Keep the scratch daemon's logs; they are the only record of a failed probe.
    const kept = join(LOGS, `restore-test-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(kept, { recursive: true });
    for (const name of await readdir(join(home, 'logs')).catch(() => [])) {
      if (name.endsWith('.log')) await copyFile(join(home, 'logs', name), join(kept, name));
    }
    await writeFile(
      join(kept, 'fitness.json'),
      `${JSON.stringify(await readJson(join(home, 'model-fitness.json')), null, 2)}\n`,
    ).catch(() => {});
    await rm(home, { recursive: true, force: true });
    log(`restore logs kept in ${kept}`);
  }
  return failures;
}

async function waitForFitness(client, id, timeoutMs = 15 * 60_000) {
  const key = `${ENGINE}:${id}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { records } = await client.listModelFitness().catch(() => ({ records: [] }));
    const record = records.find((r) => r.key === key)?.record;
    if (record && record.status !== 'deferred') return record;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { status: 'timed out' };
}

async function gezelAt(home, env, cliArgs) {
  await new Promise((resolveExit) => {
    const child = spawn(process.execPath, [CLI, '--standalone', '--home', home, ...cliArgs], {
      env,
      stdio: 'ignore',
    });
    child.once('exit', resolveExit);
    child.once('error', resolveExit);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  await writeNoLaunchBin();
  if (args['restore-test']) {
    const failures = await restoreTest(args['restore-test'].split(',').map((s) => s.trim()));
    process.exitCode = failures ? 1 : 0;
    return;
  }

  await stat(DEST).catch(() => {
    throw new Error(`${DEST} does not exist`);
  });
  await takeRunLock();
  await mkdir(DEST_ENGINE, { recursive: true });
  // Exports an interrupted run left half-written; nothing else writes here.
  await rm(INCOMING, { recursive: true, force: true });
  log(`destination ${DEST_ENGINE}, staging home ${STAGING}, Gilde ${GILDE_VERSION}`);

  const daemon = await startDaemon(STAGING, stagingEnv());
  const client = daemon.client;
  const health = await client.health();
  const gitCommit = await new Promise((resolveCommit) => {
    const child = spawn('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.once('exit', () => resolveCommit(out.trim() || undefined));
    child.once('error', () => resolveCommit(undefined));
  });
  const context = { daemonVersion: health.version, gitCommit };
  log(`staging daemon ${daemon.outcome} (pid ${daemon.pid}, version ${health.version})`);

  const plan = [];
  for (const { id } of await catalogIds()) {
    if (ONLY && !ONLY.has(id)) continue;
    plan.push(await planEntry(client, id));
  }
  if (ONLY) {
    for (const id of ONLY) {
      if (!plan.some((e) => e.id === id))
        plan.push({ id, status: 'unavailable', reason: 'not in the catalog' });
    }
  }

  const backups = await existingBackups();
  for (const entry of plan.filter((e) => e.status === 'pending')) {
    if (await isCurrent(entry, backups.get(entry.signature))) entry.status = 'current';
  }

  if (args.reverify) {
    for (const entry of plan.filter((e) => e.status === 'current')) {
      log(`re-verifying ${entry.signature}`);
      const verification = await verifyBundle(bundlePath(entry.signature), entry);
      const sidecar = backups.get(entry.signature);
      sidecar.verification = verification;
      await writeFile(sidecarPath(entry.signature), `${JSON.stringify(sidecar, null, 2)}\n`);
      if (!verification.ok) {
        entry.status = 'pending';
        log(
          `  ${entry.signature}: FAILED (${verification.problems.join('; ')}); it will be rebuilt`,
        );
      } else {
        log(
          `  ${entry.signature}: ok (${gb(verification.hashedBytes)} in ${verification.seconds}s)`,
        );
      }
    }
  }

  const currentSignatures = new Set(plan.filter((e) => e.signature).map((e) => e.signature));
  const catalogIdSet = new Set(plan.map((e) => e.id));
  const superseded = [...backups.values()]
    .filter((s) => catalogIdSet.has(s.id) && !currentSignatures.has(s.signature))
    .map((s) => s.signature);
  const orphaned = ONLY
    ? []
    : [...backups.values()].filter((s) => !catalogIdSet.has(s.id)).map((s) => s.signature);

  const todo = plan.filter((e) => e.status === 'pending').sort((a, b) => a.bytes - b.bytes);
  const index = SEED_HOMES.length || !args['no-seed'] ? await seedIndex() : null;
  const downloadBytes = todo.reduce(
    (sum, e) =>
      sum + e.files.filter((f) => !index?.has(f.sha256)).reduce((s, f) => s + f.sizeBytes, 0),
    0,
  );
  const writeBytes = todo.reduce((sum, e) => sum + e.bytes, 0);
  const counts = (s) => plan.filter((e) => e.status === s).length;
  log(
    `${plan.length} catalog models: ${counts('current')} current, ${todo.length} to back up (${gb(writeBytes)}, about ${gb(downloadBytes)} to download), ${counts('too-large')} over ${args['max-gb']} GB, ${counts('no-engine') + counts('unavailable')} without a llama.cpp build here`,
  );
  for (const e of plan.filter((x) => x.status === 'failed')) log(`  ${e.id}: ${e.reason}`);
  if (superseded.length)
    log(
      `superseded backups: ${superseded.join(', ')}${args.prune ? '' : ' (pass --prune to delete)'}`,
    );
  if (orphaned.length) log(`backups no longer in the catalog (kept): ${orphaned.join(', ')}`);

  if (args['dry-run']) {
    for (const e of todo) log(`  would back up ${e.signature} (${gb(e.bytes)})`);
    await writeIndex(plan, superseded, orphaned);
    return;
  }

  const fs = await statfs(DEST);
  const free = fs.bavail * fs.bsize;
  if (writeBytes + DEST_MARGIN_BYTES > free) {
    throw new Error(`${gb(writeBytes)} of bundles does not fit in ${gb(free)} free on ${DEST}`);
  }

  // Hugging Face serves each connection at a fraction of the line's speed, so
  // several models download at once. Each model holds its slot from download
  // until it has been exported and dropped from staging, which bounds staging
  // to that many models. Downloads start in plan order (smallest first);
  // exports run one at a time, in whatever order downloads finish, so a fast
  // model never waits on a slow one ahead of it.
  const slots = createSlots(CONCURRENCY);
  const exportLock = createSlots(1);
  let finished = 0;
  const backUp = async (entry) => {
    const pulled = await pull(entry, index).catch((error) => ({
      ok: false,
      reason: error.message,
    }));
    await exportLock.acquire();
    try {
      log(`[${++finished}/${todo.length}] ${entry.signature} (${gb(entry.bytes)})`);
      let result = pulled.ok
        ? await exportAndVerify(entry, context).catch((error) => ({
            ok: false,
            reason: error.message,
          }))
        : pulled;
      if (!result.ok && result.verification && index) {
        // A reused file that drifted from its recorded digest: start over from Hugging Face.
        log(
          `  ${entry.signature}: verification failed (${result.reason}); retrying with a clean download`,
        );
        await rm(result.incoming, { force: true });
        await dropStaged(client, entry.id);
        const fresh = await pull(entry, null);
        result = fresh.ok ? await exportAndVerify(entry, context) : fresh;
      }
      if (result.ok) {
        entry.status = 'current';
        const v = result.sidecar.verification;
        log(
          `  ${entry.signature}: verified ${gb(v.hashedBytes)} in ${v.seconds}s -> ${result.sidecar.bundle.file}`,
        );
        if (args.prune) {
          for (const old of superseded.filter((s) => s.startsWith(`${entry.id}@`))) {
            await rm(bundlePath(old), { force: true });
            await rm(sidecarPath(old), { force: true });
            superseded.splice(superseded.indexOf(old), 1);
            log(`  pruned superseded ${old}`);
          }
        }
      } else {
        entry.status = 'failed';
        entry.reason = result.reason;
        log(`  ${entry.signature}: FAILED: ${result.reason}`);
        await rm(join(INCOMING, `${entry.signature}.gezmodel`), { force: true });
      }
      await dropStaged(client, entry.id);
      await writeIndex(plan, superseded, orphaned);
    } finally {
      exportLock.release();
    }
  };
  await Promise.all(
    todo.map(async (entry) => {
      await slots.acquire();
      try {
        await backUp(entry);
      } finally {
        slots.release();
      }
    }),
  );
  await writeIndex(plan, superseded, orphaned);
  await rm(INCOMING, { recursive: true, force: true }).catch(() => {});
  log(
    `done: ${counts('current')} current, ${counts('failed')} failed, ${counts('too-large')} over the size limit`,
  );
  if (args['stop-daemon']) await gezel(['stop'], 'daemon');
  if (counts('failed')) process.exitCode = 1;
}

/** One backup run per staging home: two would share its daemon and `.incoming`. */
async function takeRunLock() {
  const lock = join(STAGING, 'model-backup.lock');
  await mkdir(STAGING, { recursive: true });
  const holder = Number.parseInt(await readFile(lock, 'utf8').catch(() => ''), 10);
  if (holder && holder !== process.pid) {
    let alive = false;
    try {
      process.kill(holder, 0);
      alive = true;
    } catch {}
    if (alive) throw new Error(`another backup run (pid ${holder}) is using ${STAGING}`);
  }
  await writeFile(lock, `${process.pid}\n`);
  process.once('exit', () => {
    try {
      if (readFileSync(lock, 'utf8').trim() === String(process.pid)) {
        rmSync(lock, { force: true });
      }
    } catch {}
  });
}

/** A FIFO counting semaphore. */
function createSlots(count) {
  let free = count;
  const waiting = [];
  return {
    acquire() {
      if (free > 0) {
        free--;
        return Promise.resolve();
      }
      return new Promise((resolveSlot) => waiting.push(resolveSlot));
    },
    release() {
      const nextWaiter = waiting.shift();
      if (nextWaiter) nextWaiter();
      else free++;
    },
  };
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
