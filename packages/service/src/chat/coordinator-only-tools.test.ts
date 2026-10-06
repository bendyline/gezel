import type { ChatSession } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { COORDINATOR_ONLY_TOOLS } from './coordinator-only-tools.js';
import { roleHasTeamScope } from './role-tool-filter.js';
import {
  type ResolveSessionToolSurfaceOptions,
  resolveSessionToolSurface,
} from './session-tool-surface.js';

/**
 * The roster half of the worker/coordinator contract: a session whose MCP
 * token lacks `team` must not be offered a tool the scope guard refuses it.
 * The guard half lives in coordinator-only-tools-guard.test.ts.
 */

function session(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    gezelId: 'dato',
    projectId: 'supplier-intake',
    providerName: 'llama-cpp',
    title: '',
    messages: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    lastActivityAt: '2026-10-01T00:00:00.000Z',
    ...over,
  } as unknown as ChatSession;
}

async function surface(
  over: Partial<ResolveSessionToolSurfaceOptions> = {},
): Promise<Set<string> | null> {
  const res = await resolveSessionToolSurface({
    surface: 'bridge',
    session: session(),
    role: 'Developer',
    mode: 'always',
    provider: 'llama-cpp',
    modelId: 'qwen3.8-27b-q4',
    parameterSize: '27B',
    toolsetsGroupOverride: [],
    githubLinked: false,
    isGitRepo: false,
    tier: 'medium',
    latestUserMessage: undefined,
    ...over,
  });
  return res.allowlist;
}

function coordinatorOnlyIn(allow: Set<string>): string[] {
  return [...allow].filter((name) => COORDINATOR_ONLY_TOOLS.has(name)).sort();
}

/** Every group a coordinator-only tool rides in, plus the craftbook authoring kit. */
const BROAD_KIT = [
  'tasks',
  'craftbooks',
  'craftbook-launch',
  'team-management',
  'interaction',
  'workspace-fs-read',
  'workspace-fs-write',
] as const;

describe('worker sessions are not offered coordinator-only tools', () => {
  it('the Developer that looped on import_skill no longer sees it, or its siblings', async () => {
    // craftbook-export-generalize, qwen3.8-27b: 21 × import_skill, then
    // invoke_craftbook and the escalation pair, every one a 403.
    const allow = (await surface({ rolesAsTools: true }))!;
    expect(coordinatorOnlyIn(allow)).toEqual([]);
    for (const name of ['import_skill', 'invoke_craftbook', 'create_task', 'consult_meester']) {
      expect(allow.has(name)).toBe(false);
    }
    // What the worker can actually do with a task stays.
    for (const name of [
      'list_craftbooks',
      'suggest_craftbook',
      'list_tasks',
      'read_task_notes',
      'write_task_note',
      'advance_task_step',
      'write_file',
    ]) {
      expect(allow.has(name)).toBe(true);
    }
  });

  it('keeps the craftbook authoring tools a worker is granted', async () => {
    const allow = (await surface({ toolsetsGroupOverride: BROAD_KIT }))!;
    expect(coordinatorOnlyIn(allow)).toEqual([]);
    for (const name of [
      'craftbook_read',
      'craftbook_write',
      'export_task_craftbook',
      'list_craftbooks',
      'list_gezels',
    ]) {
      expect(allow.has(name)).toBe(true);
    }
  });

  it('keeps export_task_craftbook in a worker-held craftbook editor', async () => {
    const allow = (await surface({ session: session({ craftbookRef: 'supplier-intake' }) }))!;
    expect(allow.has('export_task_craftbook')).toBe(true);
    expect(allow.has('craftbook_update_step')).toBe(true);
    expect(coordinatorOnlyIn(allow)).toEqual([]);
  });

  it('a required tool cannot re-grant a coordinator-only tool to a worker', async () => {
    const allow = (await surface({ requiredTool: 'invoke_craftbook' }))!;
    expect(allow.has('invoke_craftbook')).toBe(false);
  });

  it('subtracts from an unfiltered surface instead of leaving it unfiltered', async () => {
    // mode=never with every gate inert is the one path that yields `null`.
    const unfiltered = {
      mode: 'never' as const,
      githubLinked: true,
      isGitRepo: true,
      webSearchProvider: 'brave' as const,
    };
    expect(await surface({ ...unfiltered, role: 'Meester' })).toBeNull();
    const worker = (await surface(unfiltered))!;
    expect(worker).not.toBeNull();
    expect(coordinatorOnlyIn(worker)).toEqual([]);
    expect(worker.has('read_file')).toBe(true);
    expect(worker.has('craftbook_write')).toBe(true);
  });

  it('a retrieval handoff clamp of nothing but coordinator tools does not apply to a worker', async () => {
    const clamps: string[] = [];
    const prompt = 'Where is the retry handler defined in the checkout project?';
    const allow = (await surface({
      session: session({ projectId: 'default' }),
      latestUserMessage: prompt,
      onClamp: (kind) => clamps.push(kind),
    }))!;
    expect(clamps).not.toContain('project-retrieval-first');
    expect(coordinatorOnlyIn(allow)).toEqual([]);
    expect(allow.has('read_file')).toBe(true);
    expect(allow.has('search')).toBe(true);
  });
});

describe('coordinator sessions keep the orchestration tools', () => {
  it('keeps advisers and craftbook launch callable for a Conversationalist', async () => {
    const allow = (await surface({ role: 'Conversationalist', rolesAsTools: true }))!;
    for (const name of [
      'search',
      'read_document',
      'ask_specialist',
      'ask_gezel',
      'invoke_craftbook',
    ]) {
      expect(allow.has(name), name).toBe(true);
    }
    expect(allow.has('create_task')).toBe(false);
    expect(allow.has('ensure_gezel')).toBe(false);
    expect(allow.has('write_file')).toBe(false);
  });
  it('a crew Voorman keeps every coordinator-only tool its kit grants', async () => {
    const allow = (await surface({ role: 'Voorman' }))!;
    for (const name of [
      'import_skill',
      'invoke_craftbook',
      'create_task',
      'ensure_gezel',
      'message_gezel',
      'craftbook_write',
      'export_task_craftbook',
    ]) {
      expect(allow.has(name)).toBe(true);
    }
  });

  it('the Meester keeps its kickoff and launch tools', async () => {
    const allow = (await surface({ role: 'Meester' }))!;
    for (const name of ['invoke_craftbook', 'ensure_gezel', 'message_gezel', 'list_projects']) {
      expect(allow.has(name)).toBe(true);
    }
  });
});

describe('the roster reads the same predicate the session token is minted with', () => {
  const roles = ['Meester', 'Voorman', 'Planner', 'Developer', 'Reviewer', 'Copywriter', 'Wizard'];
  for (const role of roles) {
    for (const projectMode of ['crew', 'solo'] as const) {
      it(`${role} in a ${projectMode} project`, async () => {
        const allow = (await surface({ role, projectMode, toolsetsGroupOverride: BROAD_KIT }))!;
        const team = roleHasTeamScope(role, projectMode);
        for (const name of ['import_skill', 'invoke_craftbook', 'create_task', 'ask_gezel']) {
          expect(allow.has(name), `${name} for ${role}/${projectMode}`).toBe(team);
        }
        expect(allow.has('craftbook_write')).toBe(true);
      });
    }
  }
});

describe('a specialist made the project voorman stays a worker', () => {
  // `voormanGezelId` is informational and changes no access (CLAUDE.md,
  // "Project"); the token's team bit comes from the role. The roster must
  // agree, or the project's lead is offered tools that 403.
  it('is offered no coordinator-only tool, matching its worker token', async () => {
    expect(roleHasTeamScope('Developer', 'crew')).toBe(false);
    const allow = (await surface({
      role: 'Developer',
      projectMode: 'crew',
      isProjectVoorman: true,
      rolesAsTools: true,
    }))!;
    expect(coordinatorOnlyIn(allow)).toEqual([]);
    expect(allow.has('delegate_voorman')).toBe(false);
  });
});
