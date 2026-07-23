/**
 * Builds a deterministic fixture "world" over the typed GezelClient so every
 * worker's daemon renders the same content: fixed-name gezels (stable poppetje
 * avatars), a project, tasks with steps, a craftbook, a document tree, and a
 * chat session carrying a known user message + its mock reply.
 *
 * Determinism notes:
 *  - Gezel names + explicit gender pin the avatar (derived from the gezel key).
 *  - `createProject` enforces about ≥60 / missionObjectives ≥40 chars.
 *  - `createTask` requires exactly one of `craftbookId` | inline `steps`.
 *  - `POST /sessions/:id/send` is 202 + async; the mock reply ("Mock reply: …")
 *    lands via the chat worker, so we poll getChatSession until it arrives.
 */
import type { GezelClient } from '@bendyline/gezel-client';
import type { Store } from '@bendyline/gezel-service';

export interface SeedWorld {
  gezelIds: { ada: string; bram: string; cleo: string };
  meesterId: string | null;
  projectId: string;
  taskRefs: string[];
  sessionId: string;
  meesterSessionId: string | null;
  docPaths: string[];
  craftbookId: string | null;
}

const ABOUT =
  'Fixture Project is the deterministic world the gezel web e2e suite renders. ' +
  'It exists to give the UI a stable project: a known name, a fixed mission, a ' +
  'handful of tasks, and one seeded conversation so screenshots never drift.';
const MISSION =
  '- Render deterministically in screenshots\n- Carry tasks with steps\n- Hold one seeded chat exchange';

const SEED_PROMPT = 'Hello from the web e2e seed';
const SEEDED_ADA_MEMORY = 'Ada prefers concise fixture notes for web E2E screenshots.';

export async function seed(
  client: GezelClient,
  store: Pick<Store, 'appendMemory'>,
): Promise<SeedWorld> {
  // Fixed names + explicit gender → byte-stable poppetje avatars across runs.
  const ada = await client.createGezel({
    name: 'Ada Lovelace',
    gender: 'female',
    role: 'Engineer',
  });
  const bram = await client.createGezel({ name: 'Bram Visser', gender: 'male', role: 'Designer' });
  const cleo = await client.createGezel({
    name: 'Cleo Mertens',
    gender: 'female',
    role: 'Reviewer',
  });

  // Pin the displayed meester/klerk to deterministic gezels so the prominent
  // home / composer / greeting frames don't churn on the auto-provisioned
  // (randomly-named) meester. updateConfig merges, so this is a safe partial
  // patch. Reassigning (vs renaming) sidesteps the renameGezel id-reslug bug.
  await client.updateConfig({ meesterGezelId: ada.id, klerkGezelId: bram.id }).catch(() => {});

  const project = await client.createProject({
    name: 'Fixture Project',
    description: 'Deterministic fixture world for UX screenshots.',
    about: ABOUT,
    missionObjectives: MISSION,
  });

  const taskRefs: string[] = [];
  const t1 = await client.createTask(project.id, {
    title: 'Wire up the landing page',
    description:
      'Build the landing page with a hero, feature grid, and footer. Done = it renders and links work.',
    assignee: { kind: 'gezel', gezelId: ada.id },
    steps: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
      { id: 'review', name: 'Review' },
    ],
    entryStepId: 'plan',
  });
  taskRefs.push(t1.ref);

  const t2 = await client.createTask(project.id, {
    title: 'Review the design system',
    description:
      'Audit spacing, color, and typography tokens for consistency across the app surfaces.',
    assignee: { kind: 'user' },
    steps: [{ id: 'audit', name: 'Audit' }],
    entryStepId: 'audit',
  });
  taskRefs.push(t2.ref);

  // A document tree (best-effort — a write failure shouldn't sink the world).
  const docPaths: string[] = [];
  try {
    await client.writeDocument(
      'Welcome.md',
      '# Welcome\n\nThis is a seeded fixture document for UX screenshots.\n',
    );
    await client.writeDocument(
      'notes/ideas.md',
      '# Ideas\n\n- Stable gallery\n- Predictable names\n',
    );
    docPaths.push('Welcome.md', 'notes/ideas.md');
  } catch {
    /* documents are optional for most frames */
  }

  let craftbookId: string | null = null;
  try {
    const cb = await client.createCraftbook({
      name: 'Fixture Craftbook',
      description: 'A seeded reusable craftbook for the gallery.',
      steps: [
        { id: 'draft', name: 'Draft' },
        { id: 'ship', name: 'Ship' },
      ],
      entryStepId: 'draft',
    });
    craftbookId = cb.craftbook?.id ?? null;
  } catch {
    /* craftbook is optional for most frames */
  }

  // Project-scoped chat with deterministic content.
  const session = await client.createChatSession({ gezelId: ada.id, projectId: project.id });
  await client.sendToChatSession(session.id, SEED_PROMPT);
  await waitForReply(client, session.id);

  // The chat worker extracts memories in the background. Seed one visible
  // gezel-scoped memory through the Store so the fixture does not deliberately
  // call the embedding-backed HTTP endpoint while embeddings are disabled.
  // The API read below still verifies that the UI-visible memory surface sees
  // the persisted source-of-truth markdown.
  await store.appendMemory('gezel', ada.id, SEEDED_ADA_MEMORY, 'pref');
  await waitForMemory(client, ada.id, SEEDED_ADA_MEMORY);

  // Seed a meester exchange so the Home workshop conversation has content.
  // NB: don't rename the auto-provisioned meester/klerk — renameGezel reslugs
  // the gezel id and moves its dir, but config.meesterGezelId isn't repointed,
  // which orphans the meester (session creation then 500s). Their random names
  // are fine for the regenerated, gitignored gallery.
  const meesterId = ada.id; // pinned above
  let meesterSessionId: string | null = null;
  try {
    const ms = await client.createChatSession({ gezelId: meesterId });
    await client.sendToChatSession(ms.id, 'What should we build today?');
    await waitForReply(client, ms.id);
    meesterSessionId = ms.id;
  } catch {
    /* meester exchange is best-effort */
  }

  return {
    gezelIds: { ada: ada.id, bram: bram.id, cleo: cleo.id },
    meesterId,
    projectId: project.id,
    taskRefs,
    sessionId: session.id,
    meesterSessionId,
    docPaths,
    craftbookId,
  };
}

async function waitForReply(
  client: GezelClient,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await client.getChatSession(sessionId);
    if (s.messages.some((m) => m.role === 'assistant' && m.content.includes('Mock reply'))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `seed: assistant reply did not arrive for session ${sessionId} within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForMemory(
  client: GezelClient,
  gezelId: string,
  text: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { days } = await client.listMemoryDays('gezel', gezelId);
    for (const day of days) {
      const { content } = await client.readMemoryDay('gezel', gezelId, day);
      if (content.includes(text)) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`seed: memory did not appear for gezel ${gezelId} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
