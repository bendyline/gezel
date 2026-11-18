/**
 * Draft a Spectral connector type from a published Prismatic component.
 *
 *   pnpm --filter @bendyline/gezel-service run connectors:draft-spectral -- \
 *     airtable 0.3.0 --action listRecords [--connection personalAccessToken] \
 *     [--id airtable-records] [--out draft.json]
 *
 * Without --action or --trigger it lists what the component offers.
 *
 * Nothing here trusts the package: the version must be at least 7 days old
 * (the workspace's release-age hold), the tarball must match the registry's
 * integrity, and it is installed through the component store, with every
 * check a connection makes. Its shape is read by `describe` in runner v2,
 * in the sandbox with the network denied. Nothing of it runs in this
 * process. The draft names candidate origins (every https host the entry
 * mentions) and a normalize skeleton; a person prunes and finishes both.
 */

import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SpectralComponentPin, connectorSourceProblems } from '@bendyline/gezel';
import { fetchPinnedNpmTarball } from '@bendyline/gezel-catalog';
import { runSpectralComponent } from '../src/connectors/drivers/spectral-host.js';
import { ComponentStore } from '../src/connectors/spectral/component-store.js';

const REGISTRY = 'https://registry.npmjs.org';
const HOLD_MS = 7 * 24 * 60 * 60_000;

interface Input {
  type?: string;
  label?: string;
  required?: boolean;
  default?: unknown;
  comments?: string;
}

interface Description {
  key?: string;
  label?: string;
  description?: string;
  actions: Record<string, { label?: string; description?: string; inputs: Record<string, Input> }>;
  triggers: Record<
    string,
    { label?: string; description?: string; polling: boolean; inputs: Record<string, Input> }
  >;
  connections: {
    key: string;
    label?: string;
    oauth2Type?: string;
    inputs: Record<string, Input>;
  }[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`draft-spectral-connector: ${message}\n`);
  process.exit(1);
}

async function packument(name: string): Promise<{
  versions: Record<
    string,
    {
      main?: string;
      exports?: unknown;
      license?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      dist: { integrity?: string };
    }
  >;
  time: Record<string, string>;
}> {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`);
  if (!res.ok) fail(`the registry answered ${res.status} for ${name}`);
  return (await res.json()) as Awaited<ReturnType<typeof packument>>;
}

function entryOf(meta: { main?: string; exports?: unknown }): string {
  const exp = meta.exports as { '.'?: { default?: string; require?: string } | string } | undefined;
  const dot = exp?.['.'];
  const raw = (typeof dot === 'string' ? dot : (dot?.require ?? dot?.default)) ?? meta.main;
  if (!raw) fail('the package names no entry');
  return raw.replace(/^\.\//, '');
}

function configType(input: Input): Record<string, unknown> {
  const type =
    input.type === 'boolean'
      ? 'boolean'
      : input.type === 'number' || input.type === 'float'
        ? 'number'
        : 'string';
  return {
    type,
    ...(input.label ? { title: input.label } : {}),
    ...(input.comments ? { description: input.comments } : {}),
    ...(input.default !== undefined && input.default !== '' ? { default: input.default } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const [key, version] = argv.filter(
    (a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') ?? false),
  );
  if (!key || !version || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(
      'usage: draft-spectral-connector <component-key> <exact-version> [--action K | --trigger K]',
    );
  }
  const name = `@prismatic-io/components-${key}`;
  const doc = await packument(name);
  const meta = doc.versions[version];
  if (!meta) fail(`${name}@${version} is not published`);
  const publishedAt = doc.time[version];
  if (!publishedAt || Date.now() - Date.parse(publishedAt) < HOLD_MS) {
    fail(
      `${name}@${version} was published ${publishedAt ?? 'at an unknown time'}; wait until it is 7 days old`,
    );
  }
  const spectral = meta.peerDependencies?.['@prismatic-io/spectral'];
  if (!spectral) fail(`${name}@${version} names no Spectral SDK peer`);
  if (meta.license !== 'Apache-2.0' && meta.license !== 'MIT')
    fail(`${name} is licensed ${meta.license}`);

  const work = await mkdtemp(join(tmpdir(), 'gezel-draft-spectral-'));
  try {
    const tarball = join(work, 'package.tgz');
    const sha256 = await fetchPinnedNpmTarball({ packageName: name, version, dest: tarball });
    const bytes = await readFile(tarball);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (meta.dist.integrity && meta.dist.integrity !== integrity) {
      fail('the tarball does not match the registry’s own integrity');
    }
    const entry = entryOf(meta);
    // The entry hash comes from the installed copy, so fill a placeholder,
    // install through the store with it relaxed, then pin what was installed.
    const home = join(work, 'home');
    const provisional: SpectralComponentPin = {
      name,
      version,
      sha256,
      entry,
      entrySha256: '0'.repeat(64),
      spectral,
      license: meta.license as 'Apache-2.0' | 'MIT',
      publishedAt: new Date(publishedAt).toISOString(),
    };
    const { extractNpmPackageTarball } = await import('@bendyline/gezel-catalog');
    const extracted = await extractNpmPackageTarball({
      tarballPath: tarball,
      destination: work,
      expectedName: name,
      expectedVersion: version,
    });
    const entrySha256 = createHash('sha256')
      .update(await readFile(join(extracted, entry)))
      .digest('hex');
    const pin = { ...provisional, entrySha256 };
    const installed = await new ComponentStore({ home }).ensure(pin);

    const run = await runSpectralComponent({
      v: 2,
      op: 'describe',
      component: installed,
      // No recordings: every request is refused, and the sandbox denies the network.
      replay: [],
    });
    await run.dispose();
    if (!run.result.ok || run.result.op !== 'describe') {
      fail(`describe failed: ${JSON.stringify(run.result)}`);
    }
    const component = run.result.component as unknown as Description;

    const actionKey = arg('action');
    const triggerKey = arg('trigger');
    if (!actionKey && !triggerKey) {
      process.stdout.write(`${name}@${version}: ${component.label ?? key}\n\nActions:\n`);
      for (const [k, a] of Object.entries(component.actions)) {
        process.stdout.write(`  ${k} — ${a.label ?? ''}\n`);
      }
      process.stdout.write('\nTriggers:\n');
      for (const [k, t] of Object.entries(component.triggers)) {
        process.stdout.write(`  ${k} — ${t.label ?? ''}${t.polling ? ' (polling)' : ''}\n`);
      }
      process.stdout.write('\nConnections:\n');
      for (const c of component.connections) {
        process.stdout.write(`  ${c.key} — ${c.label ?? ''}${c.oauth2Type ? ' (OAuth)' : ''}\n`);
      }
      process.stdout.write('\nRe-run with --action <key> or --trigger <key>.\n');
      return;
    }
    const mode = triggerKey ? 'trigger' : 'action';
    const entity = triggerKey ? component.triggers[triggerKey] : component.actions[actionKey!];
    if (!entity) fail(`no ${mode} named ${triggerKey ?? actionKey}`);
    if (triggerKey && !component.triggers[triggerKey]?.polling)
      fail(`${triggerKey} is not a polling trigger`);

    const connection =
      component.connections.find((c) => c.key === arg('connection')) ??
      component.connections.find((c) => !c.oauth2Type) ??
      component.connections[0];
    if (!connection) fail('the component declares no connection');
    const connectionInput = Object.entries(entity.inputs).find(
      ([, i]) => i.type === 'connection',
    )?.[0];
    if (!connectionInput) fail(`${triggerKey ?? actionKey} takes no connection input`);

    const settings = Object.entries(entity.inputs).filter(([, i]) => i.type !== 'connection');
    const secretField =
      Object.entries(connection.inputs).find(([, i]) => i.type === 'password')?.[0] ??
      Object.keys(connection.inputs)[0];
    const text = await readFile(join(installed.dir, entry), 'utf8');
    const origins = [
      ...new Set(
        [...text.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/"'`\s])/gi)].map(
          (m) => `https://${m[1]!.toLowerCase()}`,
        ),
      ),
    ].sort();

    const id = arg('id') ?? `${key}-${mode === 'trigger' ? 'changes' : 'records'}`;
    const draft = {
      schemaVersion: 1,
      kind: 'connector-type',
      id,
      name: component.label ?? key,
      description: component.description ?? '',
      tags: [key, 'spectral'],
      maintainer: { name: 'Gezel' },
      version: '1.0.0',
      releasedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      driver: 'spectral',
      source: {
        package: pin,
        mode,
        ...(triggerKey ? { trigger: triggerKey } : { action: actionKey }),
        connection: { key: connection.key, input: connectionInput },
        inputs: Object.fromEntries(settings.map(([k]) => [k, `$config.${k}`])),
        items: triggerKey ? { resolver: true } : { paths: ['$.data'] },
        idPath: '$.id',
        origins,
      },
      configSchema: {
        type: 'object',
        properties: Object.fromEntries(settings.map(([k, i]) => [k, configType(i)])),
        required: settings.filter(([, i]) => i.required && i.default === undefined).map(([k]) => k),
      },
      secretShape: connection.oauth2Type
        ? { kind: 'oauth2', label: connection.label ?? 'Account' }
        : {
            kind: 'apikey',
            field: secretField,
            label: connection.inputs[secretField ?? '']?.label ?? connection.label ?? 'API key',
            required: true,
          },
      normalize: { kind: 'mapping', map: { id: '$.id', title: '$.name', body: '$' } },
      completeness: mode === 'trigger' ? 'window' : 'mirror',
      notes: `Drafted from ${name}@${version}. Check origins (every https host the entry mentions), the normalize mapping, and idPath before publishing.`,
    };
    const problems = connectorSourceProblems('spectral', draft.source);
    const out = `${JSON.stringify(draft, null, 2)}\n`;
    const file = arg('out');
    if (file) await writeFile(file, out);
    else process.stdout.write(out);
    if (problems.length)
      process.stderr.write(`source problems to fix:\n  ${problems.join('\n  ')}\n`);
    if (connection.oauth2Type) {
      process.stderr.write(
        'OAuth connection: fill secretShape from the component’s authorize and token URLs.\n',
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
