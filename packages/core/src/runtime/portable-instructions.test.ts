import { describe, expect, it } from 'vitest';
import { resolveProfile } from '../model-profile/registry.js';
import { buildInstructions } from '../prompt/instructions.js';
import { formatTaskNotesDigest, newestTaskNotesFirst } from '../prompt/task-notes-digest.js';
import { BUILTIN_TOOLSETS } from '../tools/builtin-groups.js';
import { buildPortableInstructions } from './portable-instructions.js';
import { portableToolSurface } from './product-tools.js';
import { portableFixture } from './test-files.js';

async function fixture() {
  const { store } = portableFixture();
  await store.ensureLayout();
  const noor = await store.createGezel({ name: 'Noor', role: 'Voorman' });
  const wren = await store.createGezel({ name: 'Wren', role: 'Generalist' });
  const project = await store.createProject({
    name: 'Repair Day',
    about: 'We run a monthly repair cafe at Maple Hall.',
    missionObjectives: '- Announce every event two weeks ahead.',
  });
  await store.addGezelToProject(project.id, noor.id);
  await store.addGezelToProject(project.id, wren.id);
  await store.updateProject(project.id, { voormanGezelId: noor.id });
  await store.writeFile('workspace', project.id, 'inputs/counts.csv', 'item,count\nlamp,3\n');
  await store.writeFile('workspace', project.id, 'brief.md', '# Repair day\n');
  const task = await store.createTask(project.id, {
    title: 'Prepare repair handover',
    description: 'Write the handover note so the next volunteer knows the cabinet phrase.',
    assignee: { kind: 'gezel', gezelId: wren.id },
    steps: [
      { id: 'write', name: 'Write the note', prompt: 'Write `tasks/1/handover.md`.' },
      { id: 'review', name: 'Review', prompt: 'Check the note.' },
    ],
  });
  await store.appendTaskNote(task.ref, 'Owner is Noor.', 'write', wren.id);
  const profile = resolveProfile({
    manifest: {
      id: 'gemma4-e4b-q4',
      behaviors: ['prompt.tool-cookbook-condensed', 'prompt.prefer-writefile-edits'],
    },
    tier: 'small',
    providerName: 'llama-cpp',
  });
  return { store, noor, wren, project, task, profile };
}

describe('buildPortableInstructions', () => {
  it('keeps what the crew knows about the person in front of every gezel', async () => {
    const { store, wren, project, profile } = await fixture();
    await store.saveMemory({
      scope: 'user',
      id: 'user',
      kind: 'fact',
      text: 'Is travelling to Valencia in May.',
    });
    const session = await store.createSession({
      gezelId: wren.id,
      projectId: project.id,
      providerName: 'llama-cpp',
    });
    const built = await buildPortableInstructions({
      store,
      config: await store.readConfig(),
      session,
      context: await store.getProjectContext(project.id, wren.id),
      modelId: 'gemma4-e4b-q4',
      tier: 'small',
      profile,
      toolNames: [],
      minimalContext: true,
    });
    expect(built.full).toContain('### About the person');
    expect(built.full).toContain('- Is travelling to Valencia in May.');
  });

  it("is the desktop builder over the phone's store, fed the way the chat manager feeds it", async () => {
    const { store, noor, wren, project, task, profile } = await fixture();
    const session = await store.createSession({
      gezelId: wren.id,
      projectId: project.id,
      providerName: 'llama-cpp',
      taskRef: task.ref,
      stepId: 'write',
    });
    const tools = await portableToolSurface(store, session);
    const context = await store.getProjectContext(project.id, wren.id);
    const built = await buildPortableInstructions({
      store,
      config: await store.readConfig(),
      session,
      context,
      task,
      modelId: 'gemma4-e4b-q4',
      tier: 'small',
      profile,
      toolNames: tools.map((tool) => tool.name),
      minimalContext: false,
    });

    const notes = newestTaskNotesFirst(await store.listTaskNotes(task.ref));
    const step = task.craftbook.steps[0]!;
    const desktop = buildInstructions({
      name: 'Wren',
      roleBasedNameOnlyMode: false,
      gezelId: wren.id,
      about: context.gezel.about,
      role: 'Generalist',
      providerName: 'llama-cpp',
      generalistKickoff: 'off',
      project: context.project,
      hasObservationTables: false,
      workspaceFiles: [
        { name: 'brief.md', path: 'brief.md', isDirectory: false },
        { name: 'inputs', path: 'inputs', isDirectory: true },
        { name: 'counts.csv', path: 'inputs/counts.csv', isDirectory: false },
      ],
      documentFiles: [],
      voormanName: noor.name,
      task: {
        task,
        step,
        stepNotes: formatTaskNotesDigest(notes.filter((note) => note.stepId === 'write')),
      },
      assignedTasks: [],
      recallBlock: '',
      localModelTier: 'small',
      modelId: 'gemma4-e4b-q4',
      profile,
      installedToolsetIds: new Set(),
      // The desktop's prediction: built-in group order, first group wins.
      availableTools: BUILTIN_TOOLSETS.flatMap((group) => group.tools)
        .filter((name, index, all) => all.indexOf(name) === index)
        .filter((name) => tools.some((tool) => tool.name === name))
        .map((name) => ({ name, description: '' })),
      thirdPartyToolsetIds: [],
      workspaceWritable: true,
      layeredPrefixCache: true,
    });
    expect(built).toEqual(desktop);
    expect(built.volatileContext).toBeTruthy();
    expect(built.volatileContext).toContain('Owner is Noor.');
    expect(built.full).toContain('The voorman of this project is **Noor**.');
    expect(built.full).toContain('### About this project');
  });

  // Told nothing, a phone model wrote a desktop project and told the person
  // to open localhost.
  it('tells a phone model how a web page runs here, in place of desktop browser setup', async () => {
    const { store, wren, project, profile } = await fixture();
    const session = await store.createSession({
      gezelId: wren.id,
      projectId: project.id,
      providerName: 'llama-cpp',
    });
    const tools = await portableToolSurface(store, session);
    const build = (inAppWebPreview: boolean) =>
      store.getProjectContext(project.id, wren.id).then(async (context) =>
        buildPortableInstructions({
          store,
          config: await store.readConfig(),
          session,
          context,
          modelId: 'gemma4-e4b-q4',
          tier: 'small',
          profile,
          toolNames: tools.map((tool) => tool.name),
          minimalContext: false,
          inAppWebPreview,
        }),
      );
    const phone = (await build(true)).full;
    expect(phone).toContain('**Web pages.** The person runs a web page by opening its HTML file');
    expect(phone).toContain('Never tell the person to open localhost');
    expect(phone).not.toContain('Browser automation is not installed');
    expect((await build(false)).full).not.toContain('**Web pages.**');
  });
});
