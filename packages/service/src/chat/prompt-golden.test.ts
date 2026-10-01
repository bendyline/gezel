import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatModelManifest, ProjectDetail, Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { resolveProfile } from '../model-profile/index.js';
import { type BuildInstructionsOptions, buildInstructions } from './instructions.js';

/**
 * The system prompt's exact bytes over a corpus of sessions, recorded before
 * the prompt builder moved into core so the move can be proven byte-identical
 * (and so any later prompt change shows up as a reviewed snapshot diff).
 */
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '__golden__', 'prompt');

const project = {
  id: 'repair-day',
  name: 'Repair Day',
  description: 'Community repair cafe planning.',
  mode: 'scaffold',
  about: 'We run a monthly repair cafe at Maple Hall. Volunteers fix lamps and small appliances.',
  missionObjectives: '- Announce every event two weeks ahead.\n- Keep a record of repairs.',
  voormanGezelId: 'noor',
  gezelIds: ['noor', 'wren'],
} as unknown as ProjectDetail;

const task = {
  ref: 'repair-day/1',
  projectId: 'repair-day',
  num: 1,
  title: 'Prepare repair handover',
  description: 'Write the handover note so the next volunteer knows the cabinet phrase and owner.',
  status: 'active',
  assignee: { kind: 'gezel', gezelId: 'wren' },
  activeStepId: 'write',
  craftbook: {
    name: 'Handover',
    steps: [
      {
        id: 'write',
        name: 'Write the handover note',
        procedure: 'Write `tasks/1/handover.md` naming the owner and the opening time.',
        advanceWhen: { file: 'tasks/1/handover.md', artifact: true },
      },
      { id: 'review', name: 'Review', procedure: 'Check the note.' },
    ],
  },
} as unknown as Task;

const tools = [
  { name: 'read_file', description: 'Read one project-workspace file.' },
  { name: 'write_file', description: 'Create or overwrite a file in the project.' },
  { name: 'write_artifact', description: "Create or update a file in the project's artifacts." },
  { name: 'advance_task_step', description: 'Mark the named step complete.' },
  { name: 'ask_user_question', description: 'Ask the user a question and end your turn.' },
];

const gemma = {
  id: 'gemma4-e4b-q4',
  style: { family: 'gemma', reasoningFormat: 'channel', toolCallFormat: 'function-call' },
  behaviors: [
    'reasoning.strip-channel-tags',
    'prompt.private-reasoning-guidance',
    'prompt.tool-cookbook-condensed',
    'prompt.prefer-writefile-edits',
    'prompt.derive-by-execution',
    'turn.preamble-folding',
  ],
} as unknown as ChatModelManifest;

const base: BuildInstructionsOptions = {
  name: 'Wren',
  role: 'Generalist',
  about: 'You carry a whole task yourself, from the first step to the last.',
  providerName: 'llama-cpp',
  project,
  voormanName: 'Noor',
  gezelId: 'wren',
  workspaceFiles: ['brief.md', 'inputs/counts.csv'],
  availableTools: tools,
} as unknown as BuildInstructionsOptions;

const corpus: Record<string, BuildInstructionsOptions> = {
  'local-small-profile': {
    ...base,
    modelId: 'gemma4-e4b-q4',
    localModelTier: 'small',
    profile: resolveProfile({ manifest: gemma, tier: 'small', providerName: 'llama-cpp' }),
  } as BuildInstructionsOptions,
  'local-small-task': {
    ...base,
    modelId: 'gemma4-e4b-q4',
    localModelTier: 'small',
    profile: resolveProfile({ manifest: gemma, tier: 'small', providerName: 'llama-cpp' }),
    task: { task, step: task.craftbook.steps[0] },
  } as unknown as BuildInstructionsOptions,
  'local-tiny-minimal': {
    ...base,
    modelId: 'qwen3.5-2b-q4',
    localModelTier: 'tiny',
    minimalContext: true,
    profile: resolveProfile({ manifest: undefined, tier: 'tiny', providerName: 'llama-cpp' }),
  } as BuildInstructionsOptions,
  'cloud-meester': {
    ...base,
    name: 'Dagny',
    role: 'Meester',
    providerName: 'anthropic',
    gezelId: 'dagny',
    profile: resolveProfile({ manifest: undefined, tier: 'cloud', providerName: 'anthropic' }),
  } as BuildInstructionsOptions,
  'lean-no-project': {
    ...base,
    project: null,
    leanProfile: true,
    workspaceFiles: [],
  } as BuildInstructionsOptions,
  'layered-cache-assigned': {
    ...base,
    layeredPrefixCache: true,
    assignedTasks: [task],
    recallBlock: '\n\n### Recalled\n- The cabinet phrase is ORCHARD-7284.',
  } as BuildInstructionsOptions,
};

describe('system prompt golden', () => {
  for (const [name, opts] of Object.entries(corpus)) {
    it(`renders ${name} byte-for-byte`, () => {
      const built = buildInstructions(opts);
      const actual = `${JSON.stringify(built, null, 2)}\n`;
      const file = join(dir, `${name}.json`);
      if (process.env.UPDATE_PROMPT_GOLDEN === '1') {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, actual);
      }
      expect(actual).toBe(readFileSync(file, 'utf8'));
    });
  }
});
