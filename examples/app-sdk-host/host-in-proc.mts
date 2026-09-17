/**
 * The embedding story end to end, in one file.
 *
 * Hosts a gezel daemon inside this process against a throwaway home, installs
 * the example-journal AI App, registers a tool this script implements, and
 * holds one turn with the app's gezel.
 *
 *   pnpm build                                   # once
 *   node examples/app-sdk-host/host-in-proc.mts  # mock model, no network
 *   node examples/app-sdk-host/host-in-proc.mts --real
 *
 * `--real` drops mock mode and provisions Gemma 4 E2B for real, which
 * downloads an engine and a couple of gigabytes of weights.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// In your application these are ordinary npm imports:
//
//   import { connectOrHost } from '@bendyline/gezel-app-sdk/host';
//   import { packGezappFromSource } from '@bendyline/gezel-service/gezapp';
//
// This file sits outside the workspace's packages, so it loads the same two
// entry points from the repository's build output instead.
const repoRoot = new URL('../../', import.meta.url).pathname;
const fromDist = async (pkg: string, entry: string): Promise<Record<string, never>> =>
  import(pathToFileURL(join(repoRoot, 'packages', pkg, 'dist', entry)).href);

const { connectOrHost } = (await fromDist('app-sdk', 'host.js')) as unknown as typeof import(
  '@bendyline/gezel-app-sdk/host',
);
const { packGezappFromSource } = (await fromDist(
  'service',
  'gezapp.js',
)) as unknown as typeof import('@bendyline/gezel-service/gezapp');

const real = process.argv.includes('--real');
if (!real) process.env.GEZEL_MOCK_PROVIDER = '1';

const root = await mkdtemp(join(tmpdir(), 'gezel-host-example-'));
const projectFolder = join(root, 'journal');

console.log(`working under ${root}`);

const gezel = await connectOrHost({
  appId: 'example-host',
  appName: 'Example Host',
  // Stay in our own home rather than asking a real Gezel for consent.
  adoptUserDaemon: false,
  host: { home: join(root, 'app-home') },
});

try {
  console.log(`daemon: ${gezel.mode} at ${gezel.daemon.baseUrl}`);

  if (real) {
    await gezel.ensureModel({
      model: 'gemma4-e2b-q4',
      onEvent: (event) => {
        if (event.phase === 'ready') console.log(`model ready (${event.source})`);
        else console.log(`  ${event.phase}: ${'message' in event ? event.message : ''}`);
      },
    });
  } else {
    // Mock mode pins `copilot`, which runs its own tool loop and so never sees
    // app tools. A real hosted app runs an on-device engine, which does.
    await gezel.client.updateConfig({ provider: 'openai' });
  }

  const packed = await packGezappFromSource(join(repoRoot, 'examples/apps/example-journal'));
  const project = await gezel.ensureProject({
    package: new Uint8Array(packed.buffer),
    folder: projectFolder,
  });
  console.log(`app ${project.app?.id}@${project.app?.version} → project ${project.id}`);
  console.log(`crew: ${JSON.stringify(project.gezels)}`);

  // Chats and tools are project-scoped, so they hang off the project rather
  // than taking its id back as a parameter.
  const registration = await project.registerTools({
    tools: [
      {
        name: 'add_travel_points',
        description: 'Award travel points to the traveller.',
        inputSchema: {
          type: 'object',
          properties: { points: { type: 'number' }, reason: { type: 'string' } },
          required: ['points'],
        },
        handler: async ({ points, reason }) => {
          console.log(`  [app] awarding ${points} points (${reason ?? 'no reason given'})`);
          return `awarded ${points} points`;
        },
      },
    ],
  });

  try {
    const chat = await project.openChat({ role: 'example-journal-keeper' });

    // Prove the tool is on the gezel's real surface, then hold a turn.
    const invoked = await gezel.client.invokeSessionTool(chat.sessionId, 'add_travel_points', {
      points: 3,
      reason: 'ran the example',
    });
    console.log(`tool said: ${invoked.text.trim()}`);

    process.stdout.write('gezel: ');
    for await (const event of chat.send('Write one line about today.')) {
      if (event.type === 'delta') process.stdout.write(event.content);
    }
    process.stdout.write('\n');
  } finally {
    await registration.close();
  }
} finally {
  await gezel.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
