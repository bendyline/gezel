/**
 * Grows the web suite's seeded world into one at the scale people reach:
 * about 30 projects, 40 gezels, 60 chat sessions, and a project whose
 * timeline holds 2,000 messages with tool calls, reasoning and long markdown.
 *
 * Projects, gezels and sessions are created through the API so every index
 * and roster knows them. Message history is written straight into the session
 * files, as `e2e-web/performance.spec.ts` does: sending 2,000 turns through
 * the mock would take minutes and teach nothing about rendering.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client';
import type { SeedWorld } from '../../e2e-web/helpers/seed.js';

export interface ScaleWorld {
  /** The project holding the long timeline (the base world's Fixture Project). */
  bigProjectId: string;
  /** A second, ordinary project to move to and from. */
  otherProjectId: string;
  /** A session in the big project that holds no seeded history, for streaming into. */
  streamSessionId: string;
  /** The gezel that owns `streamSessionId`. */
  streamGezelId: string;
  messageCount: number;
  projectCount: number;
  gezelCount: number;
  sessionCount: number;
}

const ROLES = ['Engineer', 'Designer', 'Reviewer', 'Researcher', 'Writer', 'Analyst'];
const FIRST = ['Anouk', 'Bas', 'Daan', 'Eva', 'Fenna', 'Gijs', 'Hanna', 'Ivo', 'Joris', 'Lotte'];
const LAST = ['Bakker', 'de Jong', 'Smit', 'Mulder', 'Visser', 'Bos', 'Meijer', 'Peters'];
const TOOLS = ['read_file', 'write_file', 'search', 'list_dir', 'replace_in_file', 'run_tests'];

/** Long-form assistant markdown of the kind a working session produces. */
function assistantMarkdown(i: number): string {
  const file = `src/module-${i % 37}/part-${i % 11}.ts`;
  const paragraphs = [
    `I looked at \`${file}\` and the tests around it. The change touches the loader, the cache and one caller, so I kept the edit small and covered each branch.`,
    '## What changed\n\n- Moved the retry into the loader so callers stop repeating it\n- Kept the cache key stable across restarts\n- Added a test for the empty case, which failed before',
    '```ts\nexport function load(id: string): Promise<Item> {\n  const cached = cache.get(id);\n  if (cached) return Promise.resolve(cached);\n  return fetchItem(id).then((item) => {\n    cache.set(id, item);\n    return item;\n  });\n}\n```',
    `The suite passes locally (${120 + (i % 40)} tests). One follow-up: the old helper in \`${file.replace('.ts', '.legacy.ts')}\` has no callers left and can go.`,
  ];
  return paragraphs.slice(0, 2 + (i % 3)).join('\n\n');
}

function message(i: number, base: number): Record<string, unknown> {
  const at = new Date(base + i * 45_000).toISOString();
  if (i % 2 === 0) {
    return {
      role: 'user',
      content:
        i % 6 === 0
          ? `Can you look at the loader in module ${i % 37}? It retries twice on a cold start and I would like to know why.`
          : `Thanks. Next, please check part ${i % 11} and tell me if the cache key is stable.`,
      at,
      referencedFiles: [],
      referencedTasks: [],
    };
  }
  const withTools = i % 3 === 1;
  return {
    role: 'assistant',
    content: assistantMarkdown(i),
    at,
    referencedFiles: [],
    referencedTasks: [],
    ...(i % 5 === 1
      ? {
          reasoning:
            'The retry happens because the first read races the index build. Checking whether the cache is warmed before the read, and whether the key includes the version.',
          reasoningDurationMs: 2_400,
        }
      : {}),
    ...(withTools
      ? {
          toolCalls: Array.from({ length: 3 + (i % 4) }, (_, k) => ({
            name: TOOLS[(i + k) % TOOLS.length],
            at,
            durationMs: 40 + ((i * 7 + k * 13) % 900),
            success: (i + k) % 17 !== 0,
            path: `src/module-${(i + k) % 37}/part-${k}.ts`,
            argsSummary: `file: src/module-${(i + k) % 37}/part-${k}.ts`,
          })),
        }
      : {}),
  };
}

async function writeHistory(
  home: string,
  gezelId: string,
  sessionId: string,
  count: number,
  base: number,
): Promise<void> {
  const path = join(home, 'gezels', gezelId, 'sessions', `${sessionId}.json`);
  const session = JSON.parse(await readFile(path, 'utf8')) as {
    messages: unknown[];
    lastActivityAt?: string;
  };
  session.messages = Array.from({ length: count }, (_, i) => message(i, base));
  session.lastActivityAt = new Date(base + count * 45_000).toISOString();
  await writeFile(path, JSON.stringify(session));
}

export async function seedScale(
  client: GezelClient,
  home: string,
  world: SeedWorld,
): Promise<ScaleWorld> {
  const gezelIds = Object.values(world.gezelIds);
  for (let i = gezelIds.length; i < 40; i++) {
    const gezel = await client.createGezel({
      name: `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]} ${i}`,
      role: ROLES[i % ROLES.length],
    });
    gezelIds.push(gezel.id);
  }

  const projectIds: string[] = [];
  for (let i = 0; i < 28; i++) {
    const project = await client.createProject({
      name: `Scale Project ${String(i + 1).padStart(2, '0')}`,
      description: 'A project in the perf suite world.',
      about:
        'Scale Project exists so the navigation rail, the project list and the activity views carry a realistic number of entries during performance runs.',
      missionObjectives: '- Exist\n- Carry a few conversations\n- Stay out of the way',
    });
    projectIds.push(project.id);
  }

  // The big project: the base world's project, with 2,000 messages across one
  // long session and 20 shorter ones spread over four gezels.
  const bigProjectId = world.projectId;
  const base = Date.UTC(2026, 4, 1);
  const crew = gezelIds.slice(0, 4);
  for (const gezelId of crew.slice(1)) await client.addGezelToProject(bigProjectId, gezelId);
  await writeHistory(home, world.gezelIds.ada, world.sessionId, 1_200, base);
  let messageCount = 1_200;
  let sessionCount = 1;
  for (let s = 0; s < 20; s++) {
    const gezelId = crew[s % crew.length]!;
    const session = await client.createChatSession({ gezelId, projectId: bigProjectId });
    await writeHistory(home, gezelId, session.id, 40, base + (s + 1) * 86_400_000);
    messageCount += 40;
    sessionCount++;
  }

  // Shorter sessions elsewhere, so session lists and Home have volume too.
  for (let s = 0; s < 38; s++) {
    const gezelId = gezelIds[(s * 5) % gezelIds.length]!;
    const projectId = projectIds[s % projectIds.length]!;
    const session = await client.createChatSession({ gezelId, projectId });
    await writeHistory(home, gezelId, session.id, 12, base + s * 3_600_000);
    sessionCount++;
  }

  const stream = await client.createChatSession({
    gezelId: world.gezelIds.ada,
    projectId: bigProjectId,
  });
  sessionCount++;

  return {
    bigProjectId,
    otherProjectId: projectIds[0]!,
    streamSessionId: stream.id,
    streamGezelId: world.gezelIds.ada,
    messageCount,
    projectCount: projectIds.length + 2,
    gezelCount: gezelIds.length,
    sessionCount,
  };
}
