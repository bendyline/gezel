import { resolveSecurityPolicy, securityPolicyForLevel } from '@bendyline/gezel';
import { BUILTIN_TOOLSETS, BUILTIN_TOOL_TO_GROUP } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import {
  claudeBuiltinsToAllow,
  claudeBuiltinsToDisallow,
  computeToolAllowlist,
  constrainAllowlistForDirectFileWork,
  constrainAllowlistForExistingSourceEdit,
  constrainAllowlistForImmediateFileWrite,
  constrainAllowlistForImmediateNamedTool,
  constrainAllowlistForProjectRetrievalFirst,
  constrainAllowlistForScenarioFileRepair,
  expandToolsetGroups,
  extractDeliverableTargetPath,
  gezelMcpToolsToAllow,
  isRoleDelegationTool,
  permitsBrowserAutomation,
  projectTypeIsBrowserFacing,
  rolePermitsBrowserAutomation,
  roleToolAllowlist,
  roleToolsetGroups,
  shouldConstrainToDirectFileWork,
  shouldConstrainToExistingSourceEdit,
  shouldConstrainToImmediateFileWrite,
  shouldConstrainToProjectRetrievalFirst,
  shouldConstrainToScenarioFileRepair,
} from './role-tool-filter.js';

describe('roleToolsetGroups', () => {
  it('returns the meester default groups', () => {
    const groups = roleToolsetGroups('meester');
    expect(groups).toContain('team-management');
    expect(groups).toContain('memory');
    // Trim landed: Meester takes `tasks-readonly` (the
    // delegation read-only subset) instead of the full `tasks`
    // surface, and drops `web` entirely — research routes via
    // `ask_specialist({ role: 'researcher' })`.
    expect(groups).toContain('tasks-readonly');
    expect(groups).not.toContain('tasks');
    expect(groups).not.toContain('web');
    expect(groups).not.toContain('workspace-fs-read');
    expect(groups).not.toContain('workspace-fs-write');
    expect(groups).not.toContain('code-execution');
  });

  it('gives the voorman read-only workspace access (so they can investigate before delegating)', () => {
    const groups = roleToolsetGroups('voorman');
    expect(groups).toContain('workspace-fs-read');
    // No write access — that stays the developer's lane.
    expect(groups).not.toContain('workspace-fs-write');
    expect(groups).not.toContain('code-execution');
    // No code-intel: symbol-level navigation is the
    // developer's surface; the voorman reads-to-diagnose then delegates.
    // Trims per-turn tool-schema prefill on medium local models.
    expect(groups).not.toContain('code-intel');
    const allow = roleToolAllowlist('voorman');
    expect(allow.has('read_file')).toBe(true); // still investigates
    expect(allow.has('read_symbol')).toBe(false);
    expect(allow.has('map_repo')).toBe(false);
    expect(allow.has('find_references')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(roleToolsetGroups('MEESTER')).toEqual(roleToolsetGroups('meester'));
    expect(roleToolsetGroups('  Developer  ')).toEqual(roleToolsetGroups('developer'));
  });

  it('returns the default group set for unknown roles', () => {
    const unknown = roleToolsetGroups('zookeeper');
    expect(unknown).toContain('memory');
    expect(unknown).toContain('workspace-fs-read');
    expect(unknown).toContain('workspace-fs-write');
    expect(unknown).toContain('tasks'); // tasks now in DEFAULT_GROUPS
    expect(unknown).toContain('artifacts'); // artifacts now in DEFAULT_GROUPS
    expect(unknown).not.toContain('code-execution');
  });

  it('returns the default group set for undefined role', () => {
    expect(roleToolsetGroups(undefined)).toEqual(roleToolsetGroups('zookeeper'));
  });

  it('aliases "Backend Engineer" / "Builder" / "DevOps" onto the (generic) developer preset', () => {
    const dev = roleToolsetGroups('developer');
    expect(roleToolsetGroups('Backend Engineer')).toEqual(dev);
    expect(roleToolsetGroups('Builder')).toEqual(dev);
    expect(roleToolsetGroups('Senior Software Engineer')).toEqual(dev);
    expect(roleToolsetGroups('DevOps')).toEqual(dev);
    // Generic developer is the tighter kit — no `web` group (so no
    // Playwright auto-spawn either, see `rolePermitsBrowserAutomation`).
    expect(dev).not.toContain('web');
  });

  it('aliases "Web Developer" / "Frontend Developer" / "Full-stack" onto the web-developer preset', () => {
    // Web-flavored dev roles get the `web` group back AND
    // `rolePermitsBrowserAutomation` flips on so Playwright auto-spawns.
    // This split keeps the generic developer's roster lean (~36 tools)
    // while web/frontend devs still have the full ~57-tool surface.
    const webDev = roleToolsetGroups('web-developer');
    expect(roleToolsetGroups('Web Developer')).toEqual(webDev);
    expect(roleToolsetGroups('Frontend Developer')).toEqual(webDev);
    expect(roleToolsetGroups('Front-End Engineer')).toEqual(webDev);
    expect(roleToolsetGroups('Full-stack Developer')).toEqual(webDev);
    expect(roleToolsetGroups('Fullstack Engineer')).toEqual(webDev);
    expect(webDev).toContain('web');
    expect(webDev).toContain('workspace-fs-write');
  });

  it('aliases "UX Designer" onto the designer preset', () => {
    expect(roleToolsetGroups('UX Designer')).toEqual(roleToolsetGroups('designer'));
  });

  it('researcher trim: drops git + task-mutation, keeps write/web/scripted browser', () => {
    const groups = roleToolsetGroups('researcher');
    // Dropped groups.
    expect(groups).not.toContain('git');
    expect(groups).toContain('tasks-readonly');
    expect(groups).not.toContain('tasks');

    const allow = roleToolAllowlist('researcher');
    // Git surface gone (PR-review tools were the Reviewer's lane).
    expect(allow.has('run_git')).toBe(false);
    expect(allow.has('github_pr_create')).toBe(false);
    // Task mutation gone; read-only task context retained.
    expect(allow.has('create_task')).toBe(false);
    expect(allow.has('assign_task')).toBe(false);
    expect(allow.has('spawn_task_instances')).toBe(false);
    expect(allow.has('read_task_notes')).toBe(true);
    // Load-bearing research surface retained.
    expect(allow.has('write_file')).toBe(true);
    expect(allow.has('write_artifact')).toBe(true);
    expect(allow.has('fetch_url')).toBe(true);
    expect(allow.has('run_playwright_script')).toBe(true);
    expect(allow.has('read_file')).toBe(true);

    // The role explicitly owns scripted browser automation in addition
    // to the dynamically spawned interactive Playwright surface.
    expect(groups).toContain('browser-automation');
    expect(rolePermitsBrowserAutomation('researcher')).toBe(true);
  });

  it('copywriter can write workspace copy files without getting browser automation', () => {
    const groups = roleToolsetGroups('copywriter');
    expect(groups).toContain('workspace-fs-read');
    expect(groups).toContain('workspace-fs-write');
    const allow = roleToolAllowlist('copywriter');
    expect(allow.has('read_file')).toBe(true);
    expect(allow.has('write_file')).toBe(true);
    expect(allow.has('write_artifact')).toBe(true);
    expect(rolePermitsBrowserAutomation('copywriter')).toBe(false);
  });

  it('routes "AI Image Generation Specialist" to the image-generator preset', () => {
    // Wild-caught from the petshop eval: a freshly-created
    // gezel with this role used to fall through to DEFAULT_GROUPS, which
    // included `workspace-fs-write` + `artifacts` but NOT `images`. The
    // model then "saved a logo" by writing prose into a `logo.png`
    // artifact via `write_artifact`, fabricating the deliverable.
    const groups = roleToolsetGroups('AI Image Generation Specialist');
    expect(groups).toContain('images');
    // No workspace writes — the image-gen route already drops a
    // workspace copy of every render at `assets/generated/`.
    expect(groups).not.toContain('workspace-fs-write');
    expect(groups).not.toContain('code-execution');
    // generate_image is reachable from the resolved allowlist.
    const allow = roleToolAllowlist('AI Image Generation Specialist');
    expect(allow.has('generate_image')).toBe(true);
    expect(allow.has('write_file')).toBe(false);
  });

  it('still routes "Visual Designer" to the designer preset (not image-generator)', () => {
    // Designer alias `visual` lives in match.ts; here in role-tool-filter
    // the substring `design` matches first and lands on the designer
    // kit, which already includes `images`. The image-generator alias
    // is intentionally narrower so a generalist designer keeps
    // `workspace-fs-write`.
    const groups = roleToolsetGroups('Visual Designer');
    expect(groups).toEqual(roleToolsetGroups('designer'));
    expect(groups).toContain('workspace-fs-write');
  });

  it('aliases "Code Reviewer" onto the reviewer preset', () => {
    expect(roleToolsetGroups('Code Reviewer')).toEqual(roleToolsetGroups('reviewer'));
  });
});

describe('permitsBrowserAutomation (role ∨ browser-facing project)', () => {
  it('widens a generic Developer to browser automation on browser-facing projects', () => {
    // The Space War incident: a Developer on a `browser-game` project had
    // no way to see the page he was shipping. The project's deliverable
    // type now qualifies the session even though the lean developer kit
    // has no `web` group.
    for (const typeId of ['browser-game', 'web-app', 'static-site', 'design-prototype']) {
      expect(permitsBrowserAutomation({ role: 'Developer', projectTypeId: typeId })).toBe(true);
    }
  });

  it('keeps the lean roster for developers outside browser-facing projects', () => {
    expect(permitsBrowserAutomation({ role: 'Developer', projectTypeId: undefined })).toBe(false);
    expect(permitsBrowserAutomation({ role: 'Developer', projectTypeId: 'cli-tool' })).toBe(false);
    expect(
      permitsBrowserAutomation({ role: 'Backend Engineer', projectTypeId: 'api-service' }),
    ).toBe(false);
  });

  it('role-qualified sessions pass regardless of project type', () => {
    expect(permitsBrowserAutomation({ role: 'Web Developer', projectTypeId: undefined })).toBe(
      true,
    );
    expect(permitsBrowserAutomation({ role: 'researcher', projectTypeId: 'cli-tool' })).toBe(true);
  });

  it('the copywriter carve-out survives the project-type widening', () => {
    expect(permitsBrowserAutomation({ role: 'copywriter', projectTypeId: 'browser-game' })).toBe(
      false,
    );
  });

  it('read-only roles do not gain a browser from the project type', () => {
    // Planner has `web` but no `workspace-fs-write`; the widening path
    // requires a role that builds things.
    expect(permitsBrowserAutomation({ role: 'planner', projectTypeId: 'browser-game' })).toBe(
      false,
    );
  });

  it('projectTypeIsBrowserFacing knows the taxonomy split', () => {
    expect(projectTypeIsBrowserFacing('browser-game')).toBe(true);
    expect(projectTypeIsBrowserFacing('data-analysis')).toBe(false);
    expect(projectTypeIsBrowserFacing(undefined)).toBe(false);
  });
});

describe('expandToolsetGroups', () => {
  it('expands a group id to its tool names', () => {
    const tools = expandToolsetGroups(['memory']);
    expect(tools).toEqual(new Set(['search_memory', 'save_memory', 'list_memories']));
  });

  it('unions tools across multiple groups', () => {
    const tools = expandToolsetGroups(['memory', 'interaction']);
    expect(tools.has('search_memory')).toBe(true);
    expect(tools.has('ask_user_question')).toBe(true);
  });

  it('silently drops unknown group ids', () => {
    const tools = expandToolsetGroups(['memory', 'definitely-not-a-group']);
    expect(tools.size).toBeGreaterThan(0);
    expect(tools.has('search_memory')).toBe(true);
  });

  it('returns an empty set for empty input', () => {
    expect(expandToolsetGroups([]).size).toBe(0);
  });
});

describe('roleToolAllowlist', () => {
  it('expands the meester default to a tool-name set', () => {
    const allow = roleToolAllowlist('meester');
    expect(allow.has('list_gezels')).toBe(true);
    expect(allow.has('search_memory')).toBe(true);
    expect(allow.has('read_file')).toBe(false);
    expect(allow.has('run_nodejs_script')).toBe(false);
  });

  it('post-trim: meester surface includes the consultation macro and project-membership tools', () => {
    const allow = roleToolAllowlist('meester');
    // Consultation macro lives in `interaction`.
    expect(allow.has('ask_specialist')).toBe(true);
    expect(allow.has('ask_gezel')).toBe(true);
    expect(allow.has('ask_user_question')).toBe(true);
    // Project-membership tools moved into `team-management` (were
    // leaking through pre-trim because they weren't in any group).
    expect(allow.has('list_project_gezels')).toBe(true);
    expect(allow.has('add_gezel_to_project')).toBe(true);
    expect(allow.has('remove_gezel_from_project')).toBe(true);
  });

  it('post-trim: meester gets the read-only task subset, not the full tasks surface', () => {
    const allow = roleToolAllowlist('meester');
    // Visibility kept — Meester pings projects to see status.
    expect(allow.has('list_tasks')).toBe(true);
    expect(allow.has('get_task')).toBe(true);
    expect(allow.has('read_task_notes')).toBe(true);
    // Mutation gone — the macros + voorman handle these.
    expect(allow.has('create_task')).toBe(false);
    expect(allow.has('update_task')).toBe(false);
    expect(allow.has('assign_task')).toBe(false);
    expect(allow.has('set_task_status')).toBe(false);
    expect(allow.has('add_task_step')).toBe(false);
    expect(allow.has('advance_task_step')).toBe(false);
    expect(allow.has('write_task_note')).toBe(false);
    expect(allow.has('spawn_task_instances')).toBe(false);
    expect(allow.has('list_task_children')).toBe(false);
  });

  it('post-trim: meester loses web tools (research routes via ask_specialist({ role: "researcher" }))', () => {
    const allow = roleToolAllowlist('meester');
    expect(allow.has('web_search')).toBe(false);
    expect(allow.has('wikipedia_search')).toBe(false);
    expect(allow.has('fetch_url')).toBe(false);
    expect(allow.has('browser_find_page_element')).toBe(false);
  });

  it('post-trim: audio tools are not in any default role', () => {
    // The new `audio` group exists but is opt-in — installing the
    // toolset adds the tools, but no role default pulls them in.
    for (const role of ['meester', 'voorman', 'developer', 'designer', 'reviewer', 'planner']) {
      const allow = roleToolAllowlist(role);
      expect(allow.has('transcribe_audio'), `${role} got transcribe_audio`).toBe(false);
      expect(allow.has('synthesize_speech'), `${role} got synthesize_speech`).toBe(false);
    }
  });

  it('expands the developer default to include workspace-fs and code-execution', () => {
    const allow = roleToolAllowlist('developer');
    expect(allow.has('read_file')).toBe(true);
    expect(allow.has('write_file')).toBe(true);
    expect(allow.has('run_nodejs_script')).toBe(true);
    expect(allow.has('list_gezels')).toBe(false);
  });
});

describe('computeToolAllowlist', () => {
  it('returns null when mode is "never" and no search-tool gates fire', () => {
    // mode 'never' is the power-user opt-out from role-based filtering.
    // With a real keyed search backend AND a non-cloud tier, both
    // search-tool gates are inactive → null (full surface).
    expect(
      computeToolAllowlist({
        role: 'developer',
        mode: 'never',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        webSearchProvider: 'brave',
      }),
    ).toBeNull();
  });

  it('still applies search-tool gates even when mode is "never"', () => {
    // When the user opts out of role filtering, we still hide
    // misleading tools — `web_search` when no real backend, and
    // `wikipedia_search` for cloud models that already have it in
    // pretraining. Both are UX corrections independent of TPM tuning.
    const allow = computeToolAllowlist({
      role: 'developer',
      mode: 'never',
      provider: 'openai',
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('web_search')).toBe(false); // no backend configured
    expect(allow!.has('wikipedia_search')).toBe(false); // cloud tier
    // The rest of the surface is unaffected.
    expect(allow!.has('read_file')).toBe(true);
    expect(allow!.has('list_gezels')).toBe(true);
  });

  it('exposes replace_lines wherever replace_in_file is available (positional edit for small models)', () => {
    // Invariant: a role that can content-edit (`replace_in_file`) can also
    // line-edit (`replace_lines`) — the surgical tool small models can drive
    // (target by line number off the gutter; no byte-exact `find`). The
    // resolver backfills it so a curated/older toolset can't ship one
    // without the other. See the augmentation at the end of the resolver.
    const allow = computeToolAllowlist({
      role: 'developer',
      mode: 'never',
      provider: 'llama-cpp',
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('replace_in_file')).toBe(true);
    expect(allow!.has('replace_lines')).toBe(true);
  });

  it('filters for OpenAI in default ("always") mode', () => {
    const allow = computeToolAllowlist({
      role: 'meester',
      mode: undefined,
      provider: 'openai',
      webSearchProvider: 'brave',
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('list_gezels')).toBe(true);
    expect(allow!.has('read_file')).toBe(false);
  });

  it('skips role-based filtering for cloud-tier providers in "small-model" mode', () => {
    // Cloud providers always classify as `cloud` regardless of model
    // id, so `'small-model'` mode never triggers role-based narrowing
    // for them. With real backend configured, the only cloud-tier
    // gate that fires is `wikipedia_search` — `web_search` and the
    // rest of the surface stay exposed.
    for (const opts of [
      { role: 'meester' as const, provider: 'openai' as const, modelId: undefined },
      { role: 'meester' as const, provider: 'copilot' as const, modelId: 'gpt-4o' },
    ]) {
      const allow = computeToolAllowlist({
        role: opts.role,
        mode: 'small-model',
        provider: opts.provider,
        ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
        webSearchProvider: 'brave',
      });
      expect(allow).not.toBeNull();
      // No role-narrowing: a tool outside the meester default groups
      // (e.g. `read_file`) is still present because mode skipped
      // role-based narrowing.
      expect(allow!.has('read_file')).toBe(true);
      // wikipedia_search stripped (cloud), web_search kept (brave).
      expect(allow!.has('wikipedia_search')).toBe(false);
      expect(allow!.has('web_search')).toBe(true);
    }
  });

  it('filters in "small-model" mode for tiny-tier local models on every local engine', () => {
    // Used to be Ollama-only — now extended via the shared tier
    // classifier to mlx + llama-cpp too.
    for (const [provider, modelId] of [
      ['ollama', 'gemma4:e2b'],
      ['mlx', 'gemma4-e2b-mlx'],
      ['llama-cpp', 'm:4b'],
    ] as const) {
      const allow = computeToolAllowlist({
        role: 'developer',
        mode: 'small-model',
        provider,
        modelId,
        webSearchProvider: 'brave',
      });
      expect(allow, `${provider}/${modelId}`).not.toBeNull();
      expect(allow!.has('read_file')).toBe(true);
    }
  });

  it('skips "small-model" filtering for ≥5B local models when no search gates fire', () => {
    for (const [provider, modelId] of [
      ['ollama', 'mistral:7b'], // small tier
      ['mlx', 'qwen3.6-27b-mlx'], // medium tier
      ['llama-cpp', 'meta-llama/Llama-3-70B'], // large tier
    ] as const) {
      expect(
        computeToolAllowlist({
          role: 'developer',
          mode: 'small-model',
          provider,
          modelId,
          webSearchProvider: 'brave',
        }),
        `${provider}/${modelId}`,
      ).toBeNull();
    }
  });

  it('filters in "small-model" mode when the model id is unparseable on a local provider', () => {
    // Conservative default — unknown size on a local provider →
    // tier `tiny` → filter applied. Better to over-filter than miss
    // a real small-model regression.
    const allow = computeToolAllowlist({
      role: 'developer',
      mode: 'small-model',
      provider: 'mlx',
      modelId: 'something-weird',
      webSearchProvider: 'brave',
    });
    expect(allow).not.toBeNull();
  });

  describe('security-policy gates', () => {
    it('keeps the full developer surface under free', () => {
      const free = computeToolAllowlist({
        role: 'developer',
        mode: 'always',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        securityPolicy: resolveSecurityPolicy({ securityPolicy: securityPolicyForLevel('free') }),
      });
      expect(free!.has('write_file')).toBe(true);
      expect(free!.has('run_git')).toBe(true);
    });

    it('strips code-execution, services and git — but NOT workspace writes — under super-lockdown', () => {
      const allow = computeToolAllowlist({
        role: 'developer',
        mode: 'always',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        webSearchProvider: 'brave',
        githubLinked: true,
        isGitRepo: true,
        securityPolicy: resolveSecurityPolicy({
          securityPolicy: securityPolicyForLevel('super-lockdown'),
        }),
      });
      // workspace writes survive — they are governed per project
      // (projectManagedWorkspaceWritable), not by the global policy…
      expect(allow!.has('write_file')).toBe(true);
      expect(allow!.has('replace_in_file')).toBe(true);
      // …code execution gone…
      expect(allow!.has('run_nodejs_script')).toBe(false);
      expect(allow!.has('npm_install')).toBe(false);
      expect(allow!.has('run_playwright_script')).toBe(false);
      // …model git gone…
      expect(allow!.has('run_git')).toBe(false);
      // …external services gone…
      expect(allow!.has('web_search')).toBe(false);
      // …and read + artifacts survive (the sandbox escape hatch).
      expect(allow!.has('read_file')).toBe(true);
      expect(allow!.has('write_artifact')).toBe(true);
    });

    it('strips scripted Playwright from a browser-capable role when scripts are disabled', () => {
      const allow = computeToolAllowlist({
        role: 'researcher',
        mode: 'always',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        securityPolicy: resolveSecurityPolicy({
          securityPolicy: securityPolicyForLevel('super-lockdown'),
        }),
      });
      expect(roleToolAllowlist('researcher').has('run_playwright_script')).toBe(true);
      expect(allow!.has('run_playwright_script')).toBe(false);
    });

    it('strips workspace-write when the project is not writable, regardless of policy', () => {
      const allow = computeToolAllowlist({
        role: 'developer',
        mode: 'always',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        securityPolicy: resolveSecurityPolicy({ securityPolicy: securityPolicyForLevel('free') }),
        workspaceWritable: false,
      });
      expect(allow!.has('write_file')).toBe(false);
      expect(allow!.has('replace_in_file')).toBe(false);
      // Reads and artifacts stay.
      expect(allow!.has('read_file')).toBe(true);
      expect(allow!.has('write_artifact')).toBe(true);
    });

    it('workspaceWritable: false fires alone, without any securityPolicy', () => {
      const allow = computeToolAllowlist({
        role: 'developer',
        mode: 'always',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        workspaceWritable: false,
      });
      expect(allow!.has('write_file')).toBe(false);
      expect(allow!.has('read_file')).toBe(true);
    });

    it('lockdown keeps edits/scripts/git but not open-web services', () => {
      const allow = computeToolAllowlist({
        role: 'developer',
        mode: 'always',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        webSearchProvider: 'brave',
        githubLinked: true,
        isGitRepo: true,
        securityPolicy: resolveSecurityPolicy({
          securityPolicy: securityPolicyForLevel('lockdown'),
        }),
      });
      expect(allow!.has('write_file')).toBe(true);
      expect(allow!.has('run_git')).toBe(true);
      expect(allow!.has('web_search')).toBe(false);
    });

    it('fires even when role filtering is off (mode: never)', () => {
      const allow = computeToolAllowlist({
        role: 'developer',
        mode: 'never',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        securityPolicy: resolveSecurityPolicy({
          securityPolicy: securityPolicyForLevel('super-lockdown'),
        }),
        workspaceWritable: false,
      });
      // mode:never would otherwise return null (no filtering); the
      // security ceiling + per-project write gate force a concrete,
      // stripped set instead.
      expect(allow).not.toBeNull();
      expect(allow!.has('write_file')).toBe(false);
      expect(allow!.has('run_nodejs_script')).toBe(false);
    });
  });

  describe('search-tool gates', () => {
    // Use `web-developer` in this block — generic `developer` no longer
    // has the `web` group post-split, so its allowlist doesn't include
    // web_search / wikipedia_search / fetch_url at all and the gates
    // are vacuous. `web-developer` is the canonical "this role does
    // browser-shaped work" preset and is what the gates are meant to
    // act on.
    it('strips web_search when no webSearch.provider is configured', () => {
      const allow = computeToolAllowlist({
        role: 'web-developer',
        mode: 'always',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        // webSearchProvider intentionally omitted
      });
      expect(allow!.has('web_search')).toBe(false);
      // Wikipedia is the honest fallback for non-cloud tiers.
      expect(allow!.has('wikipedia_search')).toBe(true);
      // fetch_url stays available — useful when the user pastes a URL.
      expect(allow!.has('fetch_url')).toBe(true);
    });

    it('strips web_search when webSearchProvider is wikipedia (use the explicit tool instead)', () => {
      const allow = computeToolAllowlist({
        role: 'web-developer',
        mode: 'always',
        provider: 'mlx',
        modelId: 'meta-llama/Llama-3-70B',
        webSearchProvider: 'wikipedia',
      });
      expect(allow!.has('web_search')).toBe(false);
      expect(allow!.has('wikipedia_search')).toBe(true);
    });

    it('keeps web_search when a real keyed backend is configured', () => {
      for (const provider of ['brave', 'tavily', 'mock'] as const) {
        const allow = computeToolAllowlist({
          role: 'web-developer',
          mode: 'always',
          provider: 'mlx',
          modelId: 'meta-llama/Llama-3-70B',
          webSearchProvider: provider,
        });
        expect(allow!.has('web_search'), provider).toBe(true);
      }
    });

    it('strips wikipedia_search for cloud-tier models (already in pretraining)', () => {
      const allow = computeToolAllowlist({
        role: 'web-developer',
        mode: 'always',
        provider: 'openai',
        webSearchProvider: 'brave',
      });
      expect(allow!.has('wikipedia_search')).toBe(false);
      // web_search stays — Brave hits the live web, distinct from
      // the model's frozen pretraining corpus.
      expect(allow!.has('web_search')).toBe(true);
    });

    it('keeps wikipedia_search for non-cloud tiers across all sizes', () => {
      for (const [provider, modelId] of [
        ['ollama', 'llama3.2:3b'], // tiny
        ['mlx', 'mistral:7b'], // small
        ['llama-cpp', 'qwen3.6-27b-mlx'], // medium
        ['ollama', 'meta-llama/Llama-3-70B'], // large
      ] as const) {
        const allow = computeToolAllowlist({
          role: 'web-developer',
          mode: 'always',
          provider,
          modelId,
          webSearchProvider: 'brave',
        });
        expect(allow!.has('wikipedia_search'), `${provider}/${modelId}`).toBe(true);
      }
    });
  });

  it('uses toolsetsGroupOverride when non-empty', () => {
    const allow = computeToolAllowlist({
      role: 'meester',
      mode: 'always',
      provider: 'openai',
      toolsetsGroupOverride: ['workspace-fs-read', 'workspace-fs-write', 'images'],
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('read_file')).toBe(true);
    expect(allow!.has('write_file')).toBe(true);
    expect(allow!.has('generate_image')).toBe(true);
    expect(allow!.has('list_gezels')).toBe(false); // role default no longer applies
  });

  it('falls back to role default when toolsetsGroupOverride is empty', () => {
    const allow = computeToolAllowlist({
      role: 'meester',
      mode: 'always',
      provider: 'openai',
      toolsetsGroupOverride: [],
    });
    expect(allow!.has('list_gezels')).toBe(true);
  });

  it('strips onward consultation from default implementer roles while preserving direct-write tools', () => {
    for (const role of ['developer', 'Builder', 'web-developer', 'Frontend Engineer']) {
      const allow = computeToolAllowlist({
        role,
        mode: 'always',
        provider: 'mlx',
        modelId: 'qwen3.6-27b-q8',
        webSearchProvider: 'brave',
      });
      expect(allow, role).not.toBeNull();
      expect(allow!.has('write_file'), role).toBe(true);
      expect(allow!.has('read_file'), role).toBe(true);
      expect(allow!.has('ask_user_question'), role).toBe(true);
      expect(allow!.has('ask_specialist'), role).toBe(false);
      expect(allow!.has('ask_gezel'), role).toBe(false);
    }
  });

  it('honors explicit toolset overrides for implementer consultation tools', () => {
    const allow = computeToolAllowlist({
      role: 'developer',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.6-27b-q8',
      toolsetsGroupOverride: ['interaction'],
    });
    expect(allow!.has('ask_specialist')).toBe(true);
    expect(allow!.has('ask_gezel')).toBe(true);
  });

  it('constrains urgent missing-file implementer nudges to write_file only', () => {
    const nudge =
      '[Message from Wren]: [scenario check] There is still **no `index.html`** in the workspace. ' +
      'Stop reading/planning and write the file now: `write_file({ path: "index.html", content: <the full deliverable contents> })`. ' +
      'Do not end your turn until `write_file` has landed the file.';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.6-27b-q8',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Builder',
      latestUserMessage: nudge,
    });
    expect(shouldConstrainToImmediateFileWrite({ role: 'Builder', latestUserMessage: nudge })).toBe(
      true,
    );
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('constrains initial index.html deliverable handoffs to write_file only', () => {
    const nudge =
      '[Deliverable expected as a FILE at `index.html`. Your first assistant action should be the tool call ' +
      '`write_file({ path, content })`; draft inside the tool argument, not in chat. Reply in chat with the path.]';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Developer',
      latestUserMessage: nudge,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Developer', latestUserMessage: nudge }),
    ).toBe(true);
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('still recognizes pre-rename `writeFile` spellings in handoff messages', () => {
    // Handoffs replayed from old sessions and pinned gilde prose say
    // `writeFile`; the message-matching regexes accept both spellings.
    const nudge =
      '[Deliverable expected as a FILE at `index.html`. Your first assistant action should be the tool call ' +
      '`writeFile({ path, content })`; draft inside the tool argument, not in chat. Reply in chat with the path.]';
    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Developer', latestUserMessage: nudge }),
    ).toBe(true);
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Developer',
      latestUserMessage: nudge,
    });
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('does not collapse an explicit append-only repair to write_file-only', () => {
    const nudge =
      '[Message from Priya]: INCIDENT POSTMORTEM APPEND: the document already has the required structure. ' +
      'Your next tool call must be `append_to_file({ path: "postmortem.md", content: "<new analysis>" })`. ' +
      'Do not call `write_file`, rewrite existing sections, or answer in chat first. ' +
      '[Deliverable expected as a FILE at `postmortem.md`. Your first assistant action should be the tool call `write_file({ path, content })`.]';
    const allow = computeToolAllowlist({
      role: 'Researcher',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-e4b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Researcher',
      latestUserMessage: nudge,
      existingSubstantialFile: true,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Researcher', latestUserMessage: nudge }),
    ).toBe(false);
    expect(constrained!.has('append_to_file')).toBe(true);
    expect([...constrained!]).not.toEqual(['write_file']);
  });

  it('constrains non-HTML expected file handoffs to write_file only for implementers', () => {
    const nudge =
      '[Deliverable expected as a FILE at `out/customers.json`. Your first assistant action should be the tool call ' +
      '`write_file({ path, content })`; draft inside the tool argument, not in chat. Reply in chat with the path.]';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Developer',
      latestUserMessage: nudge,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Developer', latestUserMessage: nudge }),
    ).toBe(true);
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('constrains copywriter expected markdown handoffs to write_file only', () => {
    const nudge =
      '[Deliverable expected as a FILE at `customer-notice.md`. Your first assistant action should be the tool call ' +
      '`write_file({ path, content })`; draft inside the tool argument, not in chat. Reply in chat with the path.]';
    const allow = computeToolAllowlist({
      role: 'Copywriter',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.5-9b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Copywriter',
      latestUserMessage: nudge,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Copywriter', latestUserMessage: nudge }),
    ).toBe(true);
    // Copywriter has no code-execution group, so the script ride-alongs
    // intersect away — write_file stays the whole surface for this role.
    expect([...constrained!]).toEqual(['write_file']);
  });

  it('keeps surgical edit tools when the deliverable is an existing substantial file', () => {
    const nudge =
      '[Deliverable expected as a FILE at `workspace/index.html`. Your first assistant action should be the tool call ' +
      '`write_file({ path, content })`; draft inside the tool argument, not in chat.]';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Developer',
      latestUserMessage: nudge,
      existingSubstantialFile: true,
    });
    // Surgical patch tools survive so a small edit doesn't force a full
    // (corruption-prone) rewrite; write_file is still there too.
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('insert_at_marker')).toBe(true);
    // But it's still constrained to write tools only — no reads/consults.
    expect(constrained!.has('read_file')).toBe(false);
    expect(constrained!.has('ask_specialist')).toBe(false);
  });

  it('constrains direct data-output asks to a compact file-work surface', () => {
    const prompt =
      'Please clean up our customer exports. Read the three CSV files under data/raw/ ' +
      '(data/raw/customers_a.csv, data/raw/customers_b.csv, data/raw/legacy_export.csv) and produce the normalized out/customers.json. ' +
      'Write the result to out/customers.json as a single JSON array. A local validator is available: run node tools/check_customers.mjs after writing out/customers.json.';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'ds4',
      modelId: 'deepseek-v4-flash-284b-q2',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForDirectFileWork(allow, {
      role: 'Developer',
      latestUserMessage: prompt,
    });

    expect(shouldConstrainToDirectFileWork({ role: 'Developer', latestUserMessage: prompt })).toBe(
      true,
    );
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('make_dir')).toBe(true);
    expect(constrained!.has('run_nodejs_script')).toBe(true);
    expect(constrained!.has('message_gezel')).toBe(false);
    expect(constrained!.has('ask_specialist')).toBe(false);
    expect(constrained!.has('start_project')).toBe(false);
  });

  it('constrains structured record-keeper CSV asks to a compact file-work surface', () => {
    const prompt =
      'Please consolidate the registration sources into one clean CSV at `records/attendees.csv`. ' +
      'Read the source files, derive the rows, and write the result.';
    const allow = computeToolAllowlist({
      role: 'Boekwachter',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.5-9b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForDirectFileWork(allow, {
      role: 'Boekwachter',
      latestUserMessage: prompt,
    });

    expect(
      shouldConstrainToDirectFileWork({ role: 'Boekwachter', latestUserMessage: prompt }),
    ).toBe(true);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('validate')).toBe(true);
    expect(constrained!.has('message_gezel')).toBe(false);
    expect(constrained!.has('ask_specialist')).toBe(false);
  });

  it('constrains Meester project code-location asks to indexed retrieval and handoff tools', () => {
    const prompt =
      'In the "winkelwagen" project there is a bug: gift-voucher discounts come out one cent too high. ' +
      'Find where gift-voucher discounts are applied and reply in chat with the file path, line, and what is wrong. Do not fix anything.';
    const allow = computeToolAllowlist({
      role: 'Meester',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.5-9b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForProjectRetrievalFirst(allow, {
      role: 'Meester',
      latestUserMessage: prompt,
    });

    expect(
      shouldConstrainToProjectRetrievalFirst({ role: 'Meester', latestUserMessage: prompt }),
    ).toBe(true);
    expect([...constrained!]).toEqual([
      'list_projects',
      'ensure_gezel',
      'ask_gezel',
      'message_gezel',
      'search_code',
      'grep_files',
      'find_symbol',
      'find_references',
      'map_repo',
    ]);
  });

  it('constrains project specialist code-location asks to indexed retrieval tools', () => {
    const prompt =
      '[Message from Thandiwe]: Investigate the winkelwagen project for a bug where gift-voucher discounts come out one cent too high. ' +
      'Find where gift-voucher discounts are applied and report back the file path, the exact line, and what is causing the off-by-one-cent error. Do not fix anything.';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.6-27b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForProjectRetrievalFirst(allow, {
      role: 'Developer',
      latestUserMessage: prompt,
      currentProjectId: 'winkelwagen',
    });

    expect(
      shouldConstrainToProjectRetrievalFirst({ role: 'Developer', latestUserMessage: prompt }),
    ).toBe(true);
    expect([...constrained!]).toEqual([
      'list_projects',
      'ensure_gezel',
      'ask_gezel',
      'message_gezel',
      'search_code',
      'grep_files',
      'find_symbol',
      'find_references',
      'map_repo',
    ]);
  });

  it('does not treat remote repo intake or build requests as project retrieval-first turns', () => {
    expect(
      shouldConstrainToProjectRetrievalFirst({
        role: 'Meester',
        latestUserMessage: 'Review https://github.com/acme/app and find where auth refresh lives.',
      }),
    ).toBe(false);
    expect(
      shouldConstrainToProjectRetrievalFirst({
        role: 'Meester',
        latestUserMessage: 'Build a tiny app that finds duplicate invoices.',
      }),
    ).toBe(false);
  });

  it('uses a handoff-only route when a Default-scoped Meester lookup names another project', () => {
    const prompt =
      'In the "winkelwagen" project there is a bug. Find where gift-voucher discounts are applied.';
    const allow = computeToolAllowlist({
      role: 'Meester',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.5-9b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForProjectRetrievalFirst(allow, {
      role: 'Meester',
      latestUserMessage: prompt,
      currentProjectId: 'default',
    });

    expect([...constrained!]).toEqual([
      'list_projects',
      'ensure_gezel',
      'ask_gezel',
      'message_gezel',
    ]);
  });

  it('constrains stale single-file completion asks to a compact file-work surface', () => {
    const prompt =
      'Verify the CURRENT state against the mission yourself: read notes.html and check each criterion. ' +
      'Then get it actually finished: the deliverable is the file notes.html at the workspace root — edit it in place via write_file/replace_in_file.';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'ds4',
      modelId: 'deepseek-v4-flash-284b-q2',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForDirectFileWork(allow, {
      role: 'Developer',
      latestUserMessage: prompt,
    });

    expect(shouldConstrainToDirectFileWork({ role: 'Developer', latestUserMessage: prompt })).toBe(
      true,
    );
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('read_files')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('message_gezel')).toBe(false);
  });

  it('does not apply direct-file work clamps to reviewer report prompts', () => {
    const prompt =
      'Please conduct a comprehensive architecture and code review for the repository and write the final report to review.md.';

    expect(
      shouldConstrainToDirectFileWork({ role: 'Code Reviewer', latestUserMessage: prompt }),
    ).toBe(false);
  });

  it('does not treat bare shared-document creates as direct workspace file work', () => {
    expect(
      shouldConstrainToDirectFileWork({
        role: 'Developer',
        latestUserMessage: 'create a.md and b.md',
      }),
    ).toBe(false);
  });

  it('constrains explicit existing-codebase source edits even when the medium-model role filter is otherwise off', () => {
    const msg =
      'Phase 2: modify the existing Launch Board codebase, do not start over. ' +
      'Your next assistant action should be a workspace `replace_in_file` or `write_file` edit for `index.html`, not a chat-only plan. ' +
      'Add task priority support.';
    const constrained = constrainAllowlistForExistingSourceEdit(null, {
      role: 'Developer',
      latestUserMessage: msg,
    });

    expect(shouldConstrainToExistingSourceEdit({ role: 'Developer', latestUserMessage: msg })).toBe(
      true,
    );
    expect([...constrained!]).toEqual([
      'read_file',
      'read_files',
      'list_dir',
      'stat',
      'validate',
      'replace_in_file',
      'replace_lines',
      'write_file',
      'append_to_file',
      'run_installed_script',
      'get_script_run',
    ]);
  });

  it('constrains strong existing-codebase follow-ups even without tool names', () => {
    const msg =
      'Phase 3: continue evolving the existing Launch Board codebase in `index.html`, do not start over. Add due dates and preserve the Phase 2 priority behavior.';

    expect(shouldConstrainToExistingSourceEdit({ role: 'Developer', latestUserMessage: msg })).toBe(
      true,
    );
  });

  it('does not constrain generic source-fix requests without explicit edit-tool wording', () => {
    const msg = 'Can you fix src/game.ts?';
    expect(shouldConstrainToExistingSourceEdit({ role: 'Developer', latestUserMessage: msg })).toBe(
      false,
    );
    expect(
      constrainAllowlistForExistingSourceEdit(null, {
        role: 'Developer',
        latestUserMessage: msg,
      }),
    ).toBeNull();
  });

  it('extractDeliverableTargetPath pulls the path from the deliverable annotation', () => {
    expect(
      extractDeliverableTargetPath(
        'do it\n\n[Deliverable expected as a FILE at `workspace/index.html`. Your first assistant action…]',
      ),
    ).toBe('workspace/index.html');
    expect(extractDeliverableTargetPath('no annotation here')).toBeNull();
  });

  it('constrains browser-app first-move handoffs to write_file only', () => {
    const nudge =
      '[Message from Dagny]: New job "Tic-Tac-Toe Game" - task tic-tac-toe-game/1: Create a tic-tac-toe game in a single HTML file at index.html.\n\n' +
      'First move: create the workspace deliverable, not a design/planning phase. For browser games/sites/apps, the next concrete action should land a compact but complete workspace/index.html: write_file({ path: "index.html", content: "..." }). Keep the first pass under ~2.5 KB / 65 lines unless the user asked for more; do not revise or debate inside the file.';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Builder',
      latestUserMessage: nudge,
    });

    expect(shouldConstrainToImmediateFileWrite({ role: 'Builder', latestUserMessage: nudge })).toBe(
      true,
    );
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('constrains concise workspace-file first-move handoffs to write_file only', () => {
    const nudge =
      '[Message from Imara]: New job "Tic-Tac-Toe Game" - task tic-tac-toe-game/1: Build a Tic-Tac-Toe game for two players in a single file at index.html.\n\n' +
      'First move: create the workspace deliverable, not a design/planning phase. For browser games/sites/apps, the next concrete action should land a concise but substantive workspace file: write_file({ path: "index.html", content: "..." }). The write_file path is relative to the workspace root, so do not pass "workspace/index.html".';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Builder',
      latestUserMessage: nudge,
    });

    expect(shouldConstrainToImmediateFileWrite({ role: 'Builder', latestUserMessage: nudge })).toBe(
      true,
    );
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('constrains direct first-version source creation asks to write_file only', () => {
    const prompt =
      'Phase 1: build the first version of the Launch Board app at `index.html`. Keep this first version monolithic: HTML, CSS, and inline JavaScript in that one file; do not create `src/` files yet. Use workspace `write_file` paths relative to the workspace root.';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gpt-oss-20b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Developer',
      latestUserMessage: prompt,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Developer', latestUserMessage: prompt }),
    ).toBe(true);
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('does not treat existing-codebase feature requests as immediate create writes', () => {
    const prompt =
      'Phase 2: modify the existing Launch Board codebase, do not start over. Add task priority support: each task can be Low, Medium, or High priority, the add-task form lets the user choose priority, and the UI can filter by priority.';

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Developer', latestUserMessage: prompt }),
    ).toBe(false);
  });

  it('constrains direct eval-harness missing-file kicks to write_file only', () => {
    const nudge =
      "Direct kick from the eval harness: the deliverable hasn't landed in the project's workspace yet (`index.html`). " +
      'Do not write more planning documents, do not ask for confirmation. Your next tool call MUST be `write_file` creating the actual deliverable file at `index.html` in the project workspace.';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Builder',
      latestUserMessage: nudge,
    });

    expect(shouldConstrainToImmediateFileWrite({ role: 'Builder', latestUserMessage: nudge })).toBe(
      true,
    );
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('constrains urgent missing review deliverables for reviewer roles', () => {
    const nudge =
      '[Message from Wren]: [scenario check] There is still **no `review.md`** in the workspace.\n\n' +
      'Write the actual deliverable file now with the requested content. Stop reading/planning and write the file now: ' +
      '`write_file({ path: "review.md", content: <the full deliverable contents> })`.\n\n' +
      'Do not end your turn until `write_file` has landed the file.';
    const allow = computeToolAllowlist({
      role: 'Reviewer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Reviewer',
      latestUserMessage: nudge,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Reviewer', latestUserMessage: nudge }),
    ).toBe(true);
    // Reviewer has no code-execution group, so the script ride-alongs
    // intersect away — write_file stays the whole surface for this role.
    expect([...constrained!]).toEqual(['write_file']);
  });

  it('keeps source-read tools for initial reviewer review.md handoff briefs', () => {
    const handoff =
      '[Message from Linnea]: Please conduct a comprehensive architecture and code review for the Squisq repository. ' +
      'The review must be at least 5KB, include sections for Architecture, Major issues, Minor issues, and Recommendations, ' +
      'and cite at least 5 specific source files. Write the final report to review.md in the workspace root.';
    const allow = computeToolAllowlist({
      role: 'Code Reviewer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Code Reviewer',
      latestUserMessage: handoff,
    });

    expect(
      shouldConstrainToImmediateFileWrite({
        role: 'Code Reviewer',
        latestUserMessage: handoff,
      }),
    ).toBe(false);
    expect(constrained).toBe(allow);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('list_dir')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
  });

  it('does not constrain image-link repair nudges that quote prior missing-file context', () => {
    const repair =
      '[Message from Wren]: [scenario check] I looked at `index.html` and the success check is still missing **working-image**. ' +
      'The earlier failure said there is still **no `index.html`** in the workspace, but that is now stale. ' +
      'Patch the `<img>` source to the real generated image and use `replace_in_file({ path: "index.html", search: "assets/generated/pet-shop-logo.png", replace: "assets/generated/image-26572039.png" })`. ' +
      'Do not end your turn until `write_file` has landed the file.';
    expect(
      shouldConstrainToImmediateFileWrite({
        role: 'Builder',
        latestUserMessage: repair,
      }),
    ).toBe(false);
  });

  it('does not collapse source-parse repair nudges to immediate write_file only', () => {
    const repair =
      "[Message from Priya]: [scenario check] I looked at `index.html` and the success criteria aren't met yet.\n" +
      'Signals that fired: name, grid, click, win-detect, js-size-ok.\n' +
      "Signals that didn't fire: **js-parses**.\n" +
      "Specific failure: inline JS does not parse (Unexpected token ']').\n" +
      'Because this is a source parse failure in an existing file, patch the deliverable with the smallest syntax fix first. ' +
      'Exact patch candidate(s): replace_in_file({ path: "index.html", find: "board[combo[0]]]", replace: "board[combo[0]]", occurrence: "all" }). ' +
      'Whole-file `write_file` overwrites are validated and can be refused if the re-emitted HTML still has a parse error.';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const immediate = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Builder',
      latestUserMessage: repair,
    });
    const constrained = constrainAllowlistForScenarioFileRepair(immediate, {
      role: 'Builder',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(false);
    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('read_files')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect([...constrained!]).not.toEqual(['write_file']);
  });

  it('does not treat existing scenario checks with stale deliverable annotations as fresh write_file creates', () => {
    const repair =
      "[Message from Priya]: [scenario check] I looked at `index.html` and the success criteria aren't met yet.\n" +
      'Signals that fired: index-present, launch-board-title, status-columns.\n' +
      "Signals that didn't fire: **due-date-input**, **due-summary**, **date-logic**.\n" +
      'Specific failure: due-date-input: The add-task form must include a due date input.\n' +
      'CODEBASE_EVOLUTION_PHASE_3: patch the existing Launch Board codebase for the current phase only. Your next assistant action must edit the current `index.html`; do not reply with a plan or create a new project.\n\n' +
      '[Deliverable expected as a FILE at `index.html`. Your first assistant action should be the tool call `write_file({ path, content })`; draft inside the tool argument, not in chat.]';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'qwen3.6-27b-q4',
      webSearchProvider: 'brave',
    });
    const immediate = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Developer',
      latestUserMessage: repair,
    });
    const constrained = constrainAllowlistForScenarioFileRepair(immediate, {
      role: 'Developer',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(false);
    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(true);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('read_files')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('replace_lines')).toBe(true);
    expect(constrained!.has('validate')).toBe(true);
    expect([...constrained!]).not.toEqual(['write_file']);
  });

  it('constrains scenario sniff repair nudges to direct file repair tools', () => {
    const repair =
      "[Message from Priya]: [scenario check] I looked at `index.html` and the success criteria aren't met yet.\n" +
      'Signals that fired: name, grid, click, win-detect, js-parses.\n' +
      "Signals that didn't fire: **js-size-ok**.\n" +
      'Specific failure: Add at least 2 features to flesh it out.\n' +
      'The artifact exists but the trial-level checker is waiting for the missing signals above. ' +
      'Re-read the scenario prompt + mission objectives, identify what each missing signal is testing for, and patch the deliverable (use `replace_in_file` for small fixes, `write_file` for re-emit).';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.6-27b-q8',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForScenarioFileRepair(allow, {
      role: 'Builder',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('validate')).toBe(true);
    expect(constrained!.has('message_gezel')).toBe(false);
    expect(constrained!.has('ask_specialist')).toBe(false);
    expect(constrained!.has('set_task_status')).toBe(false);
  });

  it('constrains researcher document repair nudges to direct file repair tools', () => {
    const repair =
      "[Message from Wren]: [scenario check] I looked at `postmortem.md` and the success criteria aren't met yet.\n" +
      'Signals that fired: all-sections, summary-concise, evidence-citations, timestamp-citations, action-items-formatted.\n' +
      "Signals that didn't fire: **file-present**.\n" +
      'Specific failure: postmortem.md is 3910B (need >= 6 KB)\n' +
      'The artifact exists but the trial-level checker is waiting for the missing signals above. ' +
      'Re-read the scenario prompt + mission objectives, identify what each missing signal is testing for, and patch the deliverable (use `replace_in_file` for small fixes, `write_file` for re-emit).';
    const allow = computeToolAllowlist({
      role: 'Researcher',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-31b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForScenarioFileRepair(allow, {
      role: 'Researcher',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Researcher', latestUserMessage: repair }),
    ).toBe(true);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('append_to_file')).toBe(true);
    expect(constrained!.has('message_gezel')).toBe(false);
    expect(constrained!.has('ask_specialist')).toBe(false);
  });

  it('constrains runtime repair nudges to direct file repair tools', () => {
    const repair =
      '[Message from Priya]: [runtime check] I opened `index.html` in a headless browser. 1 assertion(s) failed:\n' +
      '- **click-marks-a-cell**: cell content unchanged after click (was "", still "")\n\n' +
      'Browser console reported 1 page error(s) — first: GameState is not defined\n' +
      '(1 other assertion(s) passed: nine-cells-rendered)\n\n' +
      "The static structure looks correct (the sniff signals all fire) but the page doesn't actually function. " +
      'Read `index.html`, find the specific code that should make the failing assertion(s) pass, and patch with `replace_in_file` (preferred for small fixes) or re-emit with `write_file`.';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForScenarioFileRepair(allow, {
      role: 'Builder',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('validate')).toBe(true);
    expect(constrained!.has('message_gezel')).toBe(false);
    expect(constrained!.has('set_task_status')).toBe(false);
  });

  it('collapses an explicit whole-file scenario repair to write_file without unrelated tools', () => {
    const repair =
      "[Message from Dana]: [scenario check] I looked at `src/controller.ts` and the success criteria aren't met yet.\n" +
      "Signals that didn't fire: **all-call-sites-updated**.\n" +
      'The file still has several stale field accesses. Rewrite `src/controller.ts` completely with `write_file`. ' +
      'The next assistant action must start with `write_file` for the complete corrected version.';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'generic-local-model',
      webSearchProvider: 'brave',
    });
    const immediate = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Developer',
      latestUserMessage: repair,
    });
    const constrained = constrainAllowlistForScenarioFileRepair(immediate, {
      role: 'Developer',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(true);
    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(true);
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('keeps a prepended mandatory first-write directive authoritative over patch fallback prose', () => {
    const repair =
      '[Deliverable expected as a FILE at `src/controller.ts`. Your first assistant action should be the tool call `write_file({ path, content })`; draft inside the tool argument.]\n' +
      "[scenario check] I looked at `src/controller.ts` and the success criteria aren't met yet. " +
      "Signals that didn't fire: **all-call-sites-updated**. " +
      'If this is a small edit, use `replace_in_file`; otherwise use `write_file` to re-emit the checked file. ' +
      'Your next assistant action should be a file-writing tool call for `src/controller.ts`.';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'generic-local-model',
      webSearchProvider: 'brave',
    });
    const immediate = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Developer',
      latestUserMessage: repair,
    });
    const constrained = constrainAllowlistForScenarioFileRepair(immediate, {
      role: 'Developer',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(true);
    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(true);
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('constrains direct single-file source repair requests to repair tools', () => {
    const repair =
      'Please fix the bug in `index.html` in this project. First call `read_file(path: "index.html")` to read it. ' +
      'Then identify the JavaScript syntax error and edit the file in place via `write_file`. Do not rewrite the file from scratch; the fix should be a single-line correction.';
    const allow = computeToolAllowlist({
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'llama3.2',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForScenarioFileRepair(allow, {
      role: 'Developer',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(true);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('validate')).toBe(true);
    expect(constrained!.has('message_gezel')).toBe(false);
    expect(constrained!.has('list_gezels')).toBe(false);
    expect(constrained!.has('start_project')).toBe(false);
    expect(constrained!.has('ask_user_question')).toBe(false);
  });

  it('collapses an explicit next-and-only blocking handoff to its named tool', () => {
    const kickoff = [
      'This project is fully specified. Do not ask the user for clarification.',
      'Your next and only action must be this blocking file handoff:',
      'ask_gezel({"gezel":"deepak","project":"relocation","question":"Write plan.md"})',
      'When it returns, end with a one-sentence status.',
    ].join('\n');
    const allow = new Set(['ask_gezel', 'ask_user_question', 'list_gezels', 'message_gezel']);

    expect(constrainAllowlistForImmediateNamedTool(allow, kickoff)).toEqual(new Set(['ask_gezel']));
  });

  it('does not infer an immediate named-tool clamp from ordinary tool examples', () => {
    const message = 'You can call `ask_gezel({ gezel, question })` if delegation is useful.';
    const allow = new Set(['ask_gezel', 'ask_user_question']);

    expect(constrainAllowlistForImmediateNamedTool(allow, message)).toBe(allow);
  });

  it('recognizes a small failing-acceptance defect as an existing-source repair', () => {
    const repair =
      'Running `node accept.mjs` currently FAILS. Your job: make it pass. The defect in `lib/paginate.mjs` is small (a few lines at most) once diagnosed. Read `lib/paginate.mjs`, leave `accept.mjs` untouched, and edit files in place via write_file/replace_in_file.';

    expect(
      shouldConstrainToExistingSourceEdit({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(true);
    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Developer', latestUserMessage: repair }),
    ).toBe(true);
  });

  it('collapses tic-tac-toe full runtime rewrites to write_file only', () => {
    const repair =
      '[Message from Priya]: [runtime check] I opened `tic-tac-toe-game/workspace/index.html` in a headless browser. 2 assertion(s) failed:\n' +
      '- **nine-cells-rendered**: only 1 cell-like elements (need >= 9)\n' +
      '- **click-marks-a-cell**: no clickable cell found to drive\n\n' +
      'TICTACTOE_FULL_REWRITE: this page must be mechanically simple enough for the browser check to drive.\n' +
      'Your next tool call MUST be `write_file` for `tic-tac-toe-game/workspace/index.html`; do not call `validate`, `read_file`, `ask_user_question`, create another project, or delegate again before writing.';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'qwen3.5-2b',
      webSearchProvider: 'brave',
    });
    const immediate = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Builder',
      latestUserMessage: repair,
    });
    const constrained = constrainAllowlistForScenarioFileRepair(immediate, {
      role: 'Builder',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('collapses tic-tac-toe full sniff rewrites to write_file only', () => {
    const repair =
      "[Message from Priya]: [scenario check] I looked at `index.html` and the success criteria aren't met yet.\n" +
      'Signals that fired: name, click, win-detect, js-parses.\n' +
      "Signals that didn't fire: **grid**, **js-size-ok**.\n" +
      'TICTACTOE_FULL_REWRITE: this is not a planning or polish issue; the tic-tac-toe page still lacks the concrete game structure the checker can run.\n' +
      'Your next tool call MUST be `write_file` for `index.html`; do not call `validate`, `read_file`, `ask_user_question`, create another project, or delegate again before writing.';
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'llama3.2',
      webSearchProvider: 'brave',
    });
    const immediate = constrainAllowlistForImmediateFileWrite(allow, {
      role: 'Builder',
      latestUserMessage: repair,
    });
    const constrained = constrainAllowlistForScenarioFileRepair(immediate, {
      role: 'Builder',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToImmediateFileWrite({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
    expect([...constrained!]).toEqual(['write_file', 'run_installed_script', 'get_script_run']);
  });

  it('keeps repeated runtime repair nudges on the direct file repair surface', () => {
    const repair =
      '[Message from Priya]: [runtime check - attempt 2] I re-opened `index.html` after your latest edit. The SAME assertion(s) are still failing:\n' +
      '- **click-marks-a-cell**: cell content unchanged after click (was "", still "")\n\n' +
      'Browser console reported 1 page error(s) - first: GameState is not defined\n' +
      '(1 other assertion(s) passed: nine-cells-rendered)\n\n' +
      'Your previous edit didn\'t address the cause. Re-read `index.html` carefully - the failing assertion\'s "why" string above tells you exactly what the browser saw. ' +
      "The fix is almost certainly NOT another full rewrite; it's a targeted patch to the code path that should make the assertion pass.";
    const allow = computeToolAllowlist({
      role: 'Builder',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForScenarioFileRepair(allow, {
      role: 'Builder',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
    expect(constrained!.has('read_file')).toBe(true);
    expect(constrained!.has('replace_in_file')).toBe(true);
    expect(constrained!.has('write_file')).toBe(true);
    expect(constrained!.has('message_gezel')).toBe(false);
    expect(constrained!.has('set_task_status')).toBe(false);
  });

  it('keeps late stop-rewriting runtime repair nudges on the direct file repair surface', () => {
    const repair =
      "[runtime check - attempt 3, STOP REWRITING] You've now rewritten `index.html` 2 time(s) and the SAME assertion(s) keep failing. Your current approach isn't fixing the cause. Failures:\n" +
      '- **nine-cells-rendered**: only 0 cell-like elements (need >= 9)\n\n' +
      'Different rewrites with the same defect strongly suggest a misdiagnosis. Before any further edit: open the existing file and find the SPECIFIC code that the assertion is checking, then patch.';

    expect(
      shouldConstrainToScenarioFileRepair({ role: 'Builder', latestUserMessage: repair }),
    ).toBe(true);
  });

  it('constrains reviewer review.md sniff repairs to write-only patch tools', () => {
    const repair =
      "[Message from Wren]: [scenario check] I looked at `workspace/squisq-code-review/review.md` and the success criteria aren't met yet.\n" +
      'Signals that fired: section-major, section-recommendations.\n' +
      "Signals that didn't fire: **section-architecture**, **source-citations**, **size-ok**.\n" +
      'Specific failure: missing required section(s): section-architecture.\n' +
      'The artifact exists but the trial-level checker is waiting for the missing signals above. ' +
      'Re-read the scenario prompt + mission objectives, identify what each missing signal is testing for, and patch the deliverable (use `replace_in_file` for small fixes, `write_file` for re-emit).';
    const allow = computeToolAllowlist({
      role: 'Code Reviewer',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      webSearchProvider: 'brave',
    });
    const constrained = constrainAllowlistForScenarioFileRepair(allow, {
      role: 'Code Reviewer',
      latestUserMessage: repair,
    });

    expect(
      shouldConstrainToScenarioFileRepair({
        role: 'Code Reviewer',
        latestUserMessage: repair,
      }),
    ).toBe(true);
    expect([...constrained!].sort()).toEqual(
      ['append_to_file', 'replace_in_file', 'replace_lines', 'write_file'].sort(),
    );
  });

  it('does not constrain coordinator roles or explicit toolset overrides for urgent file nudges', () => {
    const nudge =
      '[scenario check] There is still **no `index.html`** in the workspace. ' +
      'write_file({ path: "index.html", content: "..." }). ' +
      'Do not end your turn until `write_file` has landed the file.';
    expect(
      shouldConstrainToImmediateFileWrite({
        role: 'Voorman',
        latestUserMessage: nudge,
      }),
    ).toBe(false);
    expect(
      shouldConstrainToImmediateFileWrite({
        role: 'Builder',
        latestUserMessage: nudge,
        hasToolsetOverride: true,
      }),
    ).toBe(false);
    expect(
      shouldConstrainToScenarioFileRepair({
        role: 'Builder',
        latestUserMessage:
          "[scenario check] I looked at `index.html` and the success criteria aren't met yet. Signals that didn't fire: js-size-ok. patch the deliverable with replace_in_file.",
        hasToolsetOverride: true,
      }),
    ).toBe(false);
  });

  it('strips team-management tools when projectMode is "solo" (developer ambachtsman)', () => {
    // A developer running a solo project should keep workspace + code +
    // tasks + artifacts, but lose nothing (developer never had team-
    // management to begin with). Same shape as crew mode.
    const crew = computeToolAllowlist({
      role: 'developer',
      mode: 'always',
      provider: 'openai',
      projectMode: 'crew',
    });
    const solo = computeToolAllowlist({
      role: 'developer',
      mode: 'always',
      provider: 'openai',
      projectMode: 'solo',
    });
    expect(solo).toEqual(crew);
    expect(solo!.has('read_file')).toBe(true);
    expect(solo!.has('list_gezels')).toBe(false);
  });

  it('strips team-management even from a voorman-roled gezel on a solo project', () => {
    const crew = computeToolAllowlist({
      role: 'voorman',
      mode: 'always',
      provider: 'openai',
      projectMode: 'crew',
    });
    const solo = computeToolAllowlist({
      role: 'voorman',
      mode: 'always',
      provider: 'openai',
      projectMode: 'solo',
    });
    // Crew voorman has the team tools she uses; solo voorman does not.
    // (Probe with `update_project`, a team tool the voorman keeps —
    // `start_project` is now stripped as Meester-only, covered below.)
    expect(crew!.has('list_gezels')).toBe(true);
    expect(crew!.has('ensure_gezel')).toBe(true);
    expect(crew!.has('message_gezel')).toBe(true);
    expect(crew!.has('update_project')).toBe(true);
    expect(solo!.has('list_gezels')).toBe(false);
    expect(solo!.has('ensure_gezel')).toBe(false);
    expect(solo!.has('message_gezel')).toBe(false);
    expect(solo!.has('update_project')).toBe(false);
    // The Meester-only kickoff tools ride in `team-management`, but a
    // default-roster voorman is a foreman within one project — she never
    // starts projects/jobs, fetches repos, or provisions gezels, so those
    // are stripped by name (VOORMAN_STRIPPED_MEESTER_TOOLS) to keep her
    // roster from bloating into the tier cap. Group membership is intact
    // (the team tools above survive), so her cross-project token scope is
    // unchanged.
    expect(crew!.has('start_project')).toBe(false);
    expect(crew!.has('start_project_from_type')).toBe(false);
    expect(crew!.has('start_job')).toBe(false);
    expect(crew!.has('fetch_repo')).toBe(false);
    expect(crew!.has('create_gezel')).toBe(false);
    expect(crew!.has('create_gezel_from_gilde')).toBe(false);
    // Other groups (tasks, artifacts, memory, etc.) remain.
    expect(solo!.has('list_tasks')).toBe(true);
    expect(solo!.has('write_artifact')).toBe(true);
  });

  it('strips team-management from toolsetsGroupOverride too when projectMode is solo', () => {
    const allow = computeToolAllowlist({
      role: 'meester',
      mode: 'always',
      provider: 'openai',
      toolsetsGroupOverride: ['team-management', 'memory'],
      projectMode: 'solo',
    });
    expect(allow!.has('search_memory')).toBe(true);
    expect(allow!.has('list_gezels')).toBe(false);
    expect(allow!.has('ensure_gezel')).toBe(false);
  });

  it('treats missing projectMode the same as "crew" (back-compat)', () => {
    const undef = computeToolAllowlist({
      role: 'meester',
      mode: 'always',
      provider: 'openai',
    });
    const crew = computeToolAllowlist({
      role: 'meester',
      mode: 'always',
      provider: 'openai',
      projectMode: 'crew',
    });
    expect(undef).toEqual(crew);
    expect(undef!.has('list_gezels')).toBe(true);
  });
});

describe('computeToolAllowlist — git/github gating', () => {
  const GITHUB_TOOLS = [
    'github_pr_list',
    'github_pr_view',
    'github_pr_files',
    'github_pr_diff',
    'github_pr_comments',
    'github_pr_comment',
    'github_pr_create',
    'github_workflow_runs',
    'github_check_status',
  ];

  it('strips github_* tools when githubLinked is false (reviewer role)', () => {
    // The reviewer default includes the `git` group, so without the
    // gate it would carry all 9 github_* tools — exactly the ones that
    // 400 at the API layer when the project has no `.github` link.
    const allow = computeToolAllowlist({
      role: 'reviewer',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      webSearchProvider: 'brave',
      githubLinked: false,
      isGitRepo: true,
    });
    expect(allow).not.toBeNull();
    for (const t of GITHUB_TOOLS) {
      expect(allow!.has(t), `${t} should be stripped`).toBe(false);
    }
    // run_git survives: the folder is a git repo, just not linked.
    expect(allow!.has('run_git')).toBe(true);
  });

  it('keeps github_* tools when githubLinked is true', () => {
    const allow = computeToolAllowlist({
      role: 'reviewer',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      webSearchProvider: 'brave',
      githubLinked: true,
      isGitRepo: true,
    });
    expect(allow).not.toBeNull();
    for (const t of GITHUB_TOOLS) {
      expect(allow!.has(t), `${t} should be present`).toBe(true);
    }
    expect(allow!.has('run_git')).toBe(true);
  });

  it('strips run_git when isGitRepo is false, independent of github tools', () => {
    const allow = computeToolAllowlist({
      role: 'reviewer',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      webSearchProvider: 'brave',
      githubLinked: false,
      isGitRepo: false,
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('run_git')).toBe(false);
    for (const t of GITHUB_TOOLS) {
      expect(allow!.has(t)).toBe(false);
    }
  });

  it('leaves the surface untouched when the git flags are omitted (back-compat)', () => {
    // Existing callers that don't know the git state pass neither flag;
    // undefined must NOT strip, or every pre-existing session loses its
    // git tools.
    const allow = computeToolAllowlist({
      role: 'reviewer',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      webSearchProvider: 'brave',
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('run_git')).toBe(true);
    expect(allow!.has('github_pr_list')).toBe(true);
  });

  it('fires the git gate even in "never" mode (like the search gates)', () => {
    // mode 'never' normally returns the full surface (null) when no
    // other gate fires. An explicit githubLinked:false must still
    // strip — a guaranteed-to-fail tool shouldn't show up just because
    // the user opted out of role filtering.
    const allow = computeToolAllowlist({
      role: 'developer',
      mode: 'never',
      provider: 'mlx',
      modelId: 'meta-llama/Llama-3-70B',
      webSearchProvider: 'brave',
      githubLinked: false,
      isGitRepo: true,
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('github_pr_list')).toBe(false);
    expect(allow!.has('run_git')).toBe(true);
    // Non-git tools are otherwise fully present (mode 'never').
    expect(allow!.has('read_file')).toBe(true);
  });
});

describe('BUILTIN_TOOLSETS coverage', () => {
  it('every group id referenced by a role default exists', () => {
    const ids = new Set(BUILTIN_TOOLSETS.map((g) => g.id));
    for (const role of [
      'meester',
      'voorman',
      'reviewer',
      'copywriter',
      'designer',
      'developer',
      'planner',
    ]) {
      for (const groupId of roleToolsetGroups(role)) {
        expect(ids, `role ${role} references unknown group ${groupId}`).toContain(groupId);
      }
    }
  });

  it('group tool lists do not overlap with each other (except declared subset groups)', () => {
    // Subset-group exceptions: a `<base>-readonly` group is allowed to
    // be a strict subset of `<base>` so delegation roles can take a
    // narrower slice of the same surface (Meester gets
    // `tasks-readonly` instead of `tasks`). Every other pair must be
    // disjoint.
    const SUBSET_OF: Record<string, string> = {
      'tasks-readonly': 'tasks',
      'craftbook-launch': 'tasks',
    };
    const seen = new Map<string, string>();
    for (const g of BUILTIN_TOOLSETS) {
      for (const t of g.tools) {
        const prior = seen.get(t);
        if (prior === undefined) {
          seen.set(t, g.id);
          continue;
        }
        // Allow declared subset relationships in either order.
        const allowedSubset = SUBSET_OF[g.id] === prior || SUBSET_OF[prior] === g.id;
        if (allowedSubset) continue;
        expect(
          undefined,
          `tool "${t}" appears in both "${prior}" and "${g.id}" — built-in groups should be disjoint or declared as a subset pair`,
        ).toBe(prior);
      }
    }
  });
});

describe('claudeBuiltinsToDisallow', () => {
  it('disallows workspace-fs / code-execution / web built-ins for the Meester', () => {
    // Post-trim: Meester drops the `web` group — research
    // routes via `ask_specialist({ role: "researcher" })`. So WebFetch
    // and WebSearch join the disallow list alongside workspace-fs and
    // code-execution. Meester delegates building AND research.
    const disallowed = claudeBuiltinsToDisallow({
      role: 'meester',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(disallowed.sort()).toEqual(
      [
        'Bash',
        'Edit',
        'Glob',
        'Grep',
        'NotebookEdit',
        'Read',
        'WebFetch',
        'WebSearch',
        'Write',
      ].sort(),
    );
  });

  it('disallows write + execute + web built-ins for the Voorman, but lets them Read/Grep/Glob', () => {
    // Voorman gets `workspace-fs-read` so they can investigate a bug
    // before delegating the fix — Read/Grep/Glob unblock that. Write/
    // Edit/NotebookEdit and Bash stay disallowed: the developer does
    // the building. WebFetch/WebSearch are also disallowed: research is
    // a specialist's job, surfaced through `ask_specialist` rather than
    // by the voorman directly.
    const disallowed = claudeBuiltinsToDisallow({
      role: 'voorman',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(disallowed.sort()).toEqual(
      ['Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Write'].sort(),
    );
  });

  it('disallows workspace + code-execution built-ins for the Planner (no read access either)', () => {
    // Planner's a pure delegation role — they coordinate, they don't
    // read or write. Same shape as Meester.
    const disallowed = claudeBuiltinsToDisallow({
      role: 'planner',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(disallowed.sort()).toEqual(
      ['Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Write'].sort(),
    );
  });

  it('disallows WebFetch + WebSearch for a (generic) Developer (no web group post-split)', () => {
    // Generic developer is the tighter post-split kit — no `web` group,
    // research routes through `ask_specialist({ role: 'researcher' })`.
    // Bash / Edit / Read etc. are still allowed (they have
    // workspace-fs-write + code-execution).
    const disallowed = claudeBuiltinsToDisallow({
      role: 'developer',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(disallowed.sort()).toEqual(['WebFetch', 'WebSearch'].sort());
  });

  it('returns an empty list for a Web Developer (full toolset coverage)', () => {
    const disallowed = claudeBuiltinsToDisallow({
      role: 'web-developer',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(disallowed).toEqual([]);
  });

  it('disallows only Bash for a Reviewer (workspace-fs + web; no code-execution)', () => {
    const disallowed = claudeBuiltinsToDisallow({
      role: 'reviewer',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(disallowed).toEqual(['Bash']);
  });

  it('honors `mode: never` and returns no disallowances', () => {
    const disallowed = claudeBuiltinsToDisallow({
      role: 'meester',
      mode: 'never',
      provider: 'anthropic-cli',
    });
    expect(disallowed).toEqual([]);
  });

  it('lets a toolset override grant `code-execution` access to a Meester', () => {
    const disallowed = claudeBuiltinsToDisallow({
      role: 'meester',
      mode: 'always',
      provider: 'anthropic-cli',
      toolsetsGroupOverride: ['code-execution', 'memory'],
    });
    // `code-execution` covers Bash; everything else still gated.
    expect(disallowed).not.toContain('Bash');
    expect(disallowed).toContain('Read');
    expect(disallowed).toContain('Write');
  });
});

describe('computeToolAllowlist — consultationMode', () => {
  // Consultation sessions are spawned by `askGezelAndWait` to answer
  // ONE question. Without these strips the specialist (e.g. a
  // Planner) can fan out further consultations and lose track of the
  // single question they were invoked to answer — wild-caught on
  // gemma4-26b/MLX in a Choplifter-style project where a Planner
  // spawned for "what stack?" started reasoning about asking a
  // designer themselves.

  it('strips the team-management group (no ensure_gezel, message_gezel, start_project, etc.)', () => {
    const allow = computeToolAllowlist({
      role: 'planner',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      consultationMode: true,
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('ensure_gezel')).toBe(false);
    expect(allow!.has('message_gezel')).toBe(false);
    expect(allow!.has('create_gezel_from_gilde')).toBe(false);
    expect(allow!.has('start_project')).toBe(false);
    expect(allow!.has('start_job')).toBe(false);
    expect(allow!.has('update_project')).toBe(false);
  });

  it('strips ask_specialist and ask_gezel so consultations cannot chain', () => {
    const allow = computeToolAllowlist({
      role: 'planner',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      consultationMode: true,
    });
    expect(allow!.has('ask_specialist')).toBe(false);
    expect(allow!.has('ask_gezel')).toBe(false);
  });

  it('keeps ask_user_question (the addendum tells the model to use it only when truly ambiguous)', () => {
    const allow = computeToolAllowlist({
      role: 'planner',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      consultationMode: true,
    });
    expect(allow!.has('ask_user_question')).toBe(true);
  });

  it('keeps the essentials: memory, artifacts, documents', () => {
    const allow = computeToolAllowlist({
      role: 'planner',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      consultationMode: true,
    });
    // Memory — the consultation may want to remember/recall.
    expect(allow!.has('search_memory')).toBe(true);
    expect(allow!.has('save_memory')).toBe(true);
    // Artifacts — the answer might literally be a sketch/diagram artifact.
    expect(allow!.has('read_artifact')).toBe(true);
    expect(allow!.has('write_artifact')).toBe(true);
    // Documents — for consulting shared guidelines.
    expect(allow!.has('read_document')).toBe(true);
  });

  it('strips a *non*-consultation Planner does NOT lose team or ask_specialist', () => {
    // Counterpart: the same Planner in a normal session keeps the
    // tools — this is what makes the consultation strip a delta, not
    // a permanent role downgrade.
    const allow = computeToolAllowlist({
      role: 'planner',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      // consultationMode intentionally omitted
    });
    expect(allow!.has('ask_specialist')).toBe(true);
    expect(allow!.has('ask_gezel')).toBe(true);
    // Planner's role default DOES include team-management — they can
    // recruit a designer to own a phase from a normal session.
    expect(allow!.has('ensure_gezel')).toBe(true);
  });

  it('composes with solo projectMode (both strips apply)', () => {
    // Edge case: a consultation spawned inside a solo-mode project.
    // Solo mode already strips team-management; consultation mode
    // strips it again (idempotent) AND additionally strips ask_*.
    const allow = computeToolAllowlist({
      role: 'planner',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-26b',
      projectMode: 'solo',
      consultationMode: true,
    });
    expect(allow!.has('ensure_gezel')).toBe(false);
    expect(allow!.has('ask_specialist')).toBe(false);
  });
});

describe('claudeBuiltinsToAllow', () => {
  it('allows only TodoWrite for the Meester (post-trim: no web group)', () => {
    // Post-trim, Meester delegates research via `ask_specialist`, so
    // WebFetch/WebSearch are no longer auto-allowed.
    const allowed = claudeBuiltinsToAllow({
      role: 'meester',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(allowed).toEqual(['TodoWrite']);
  });

  it('allows code + workspace + TodoWrite for a (generic) Developer, not Web (no web group post-split)', () => {
    const allowed = claudeBuiltinsToAllow({
      role: 'developer',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(allowed.sort()).toEqual(
      ['Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'TodoWrite', 'Write'].sort(),
    );
  });

  it('allows every built-in for a Web Developer (full toolset coverage)', () => {
    const allowed = claudeBuiltinsToAllow({
      role: 'web-developer',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(allowed.sort()).toEqual(
      [
        'Bash',
        'Edit',
        'Glob',
        'Grep',
        'NotebookEdit',
        'Read',
        'TodoWrite',
        'WebFetch',
        'WebSearch',
        'Write',
      ].sort(),
    );
  });

  it('Reviewer gets workspace-fs + web built-ins + TodoWrite, not Bash', () => {
    const allowed = claudeBuiltinsToAllow({
      role: 'reviewer',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    expect(allowed.sort()).toEqual(
      [
        'Edit',
        'Glob',
        'Grep',
        'NotebookEdit',
        'Read',
        'TodoWrite',
        'WebFetch',
        'WebSearch',
        'Write',
      ].sort(),
    );
  });

  it('disallow + allow are exhaustive over the gated built-ins', () => {
    const opts = {
      role: 'reviewer' as const,
      mode: 'always' as const,
      provider: 'anthropic-cli' as const,
    };
    const disallowed = new Set(claudeBuiltinsToDisallow(opts));
    const allowed = new Set(claudeBuiltinsToAllow(opts));
    // No overlap (a tool can't be both disallowed and allowed).
    for (const t of disallowed) expect(allowed.has(t)).toBe(false);
    // Combined coverage of the gated set + always-allowed TodoWrite.
    const combined = new Set([...disallowed, ...allowed]);
    expect(combined.has('TodoWrite')).toBe(true);
    expect(combined.has('Bash')).toBe(true);
    expect(combined.has('Read')).toBe(true);
  });

  it('honors mode: never (no auto-approval — every tool flows through prompt-tool)', () => {
    const allowed = claudeBuiltinsToAllow({
      role: 'developer',
      mode: 'never',
      provider: 'anthropic-cli',
    });
    // mode: never means we don't filter — but the allow-list also stops
    // bypassing prompts. Only TodoWrite (always-allowed) survives.
    expect(allowed).toEqual(['TodoWrite']);
  });
});

describe('gezelMcpToolsToAllow', () => {
  it('returns the server-wide wildcard for the Meester', () => {
    const allowed = gezelMcpToolsToAllow({
      role: 'meester',
      mode: 'always',
      provider: 'anthropic-cli',
    });
    // Single wildcard entry — covers every gezel-mcp tool without
    // having to enumerate. `mcp__<server>` is Claude CLI's accepted
    // form for "any tool from this server."
    expect(allowed).toEqual(['mcp__gezel']);
  });

  it('returns the wildcard for every role (Designer, Reviewer, custom — all the same)', () => {
    for (const role of ['designer', 'reviewer', 'copywriter', 'developer', 'web developer']) {
      expect(gezelMcpToolsToAllow({ role, mode: 'always', provider: 'anthropic-cli' })).toEqual([
        'mcp__gezel',
      ]);
    }
  });

  it('returns the wildcard regardless of toolFilterMode', () => {
    // Auto-approval is unconditional — we trust our own server's
    // tools whether or not the user opted into role-based filtering.
    for (const mode of ['always', 'never', 'small-model'] as const) {
      expect(gezelMcpToolsToAllow({ role: 'developer', mode, provider: 'anthropic-cli' })).toEqual([
        'mcp__gezel',
      ]);
    }
  });
});

describe('role-typed delegation tools (tools.gezels-as-roles)', () => {
  const ALL_ROLE_TOOLS = [
    'developer',
    'designer',
    'reviewer',
    'planner',
    'researcher',
    'builder',
    'writer',
    'image_generator',
    'voorman',
    'meester',
  ].flatMap((r) => [`delegate_${r}`, `consult_${r}`]);

  it('every delegate_*/consult_* tool is a member of a builtin toolset group', () => {
    // Linchpin: the allowlist (mcp-bridge-pool getOpenAITools) only gates
    // tools in BUILTIN_TOOL_TO_GROUP. A role tool missing from a group
    // would bypass the allowlist entirely (always visible + callable).
    for (const name of ALL_ROLE_TOOLS) {
      expect(BUILTIN_TOOL_TO_GROUP.has(name), `${name} must be in a builtin group`).toBe(true);
    }
  });

  it('isRoleDelegationTool matches only delegate_/consult_ prefixes', () => {
    expect(isRoleDelegationTool('delegate_developer')).toBe(true);
    expect(isRoleDelegationTool('consult_image_generator')).toBe(true);
    expect(isRoleDelegationTool('message_gezel')).toBe(false);
    expect(isRoleDelegationTool('write_file')).toBe(false);
  });

  it('expandToolsetGroups("role-delegation") yields the doer delegate/consult tools', () => {
    const tools = expandToolsetGroups(['role-delegation']);
    expect(tools.has('delegate_developer')).toBe(true);
    expect(tools.has('consult_designer')).toBe(true);
    expect(tools.has('delegate_image_generator')).toBe(true);
    // escalation roles are NOT in the downward group
    expect(tools.has('delegate_voorman')).toBe(false);
  });

  it('flag absent → no role tools, generics retained (regression guard)', () => {
    const allow = computeToolAllowlist({
      role: 'meester',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-12b-q4',
      parameterSize: '12B',
      webSearchProvider: 'brave',
    });
    expect(allow).not.toBeNull();
    expect([...allow!].some((n) => isRoleDelegationTool(n))).toBe(false);
    expect(allow!.has('ask_specialist')).toBe(true);
    expect(allow!.has('ask_gezel')).toBe(true);
  });

  it('meester with rolesAsTools gains downward role tools and drops ask_specialist/ask_gezel', () => {
    const allow = computeToolAllowlist({
      role: 'meester',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-12b-q4',
      parameterSize: '12B',
      rolesAsTools: true,
      webSearchProvider: 'brave',
    });
    expect(allow).not.toBeNull();
    expect(allow!.has('delegate_developer')).toBe(true);
    expect(allow!.has('consult_developer')).toBe(true);
    expect(allow!.has('delegate_image_generator')).toBe(true);
    // generic dispatchers demoted...
    expect(allow!.has('ask_specialist')).toBe(false);
    expect(allow!.has('ask_gezel')).toBe(false);
    // ...but message_gezel kept as a name-addressed escape hatch.
    expect(allow!.has('message_gezel')).toBe(true);
  });

  it('voorman with rolesAsTools gets the downward delegation set, minus image-generator', () => {
    const allow = computeToolAllowlist({
      role: 'voorman',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-12b-q4',
      parameterSize: '12B',
      rolesAsTools: true,
      webSearchProvider: 'brave',
    });
    expect(allow!.has('delegate_developer')).toBe(true);
    expect(allow!.has('delegate_designer')).toBe(true);
    expect(allow!.has('delegate_reviewer')).toBe(true);
    // Image-generator delegation stripped for the voorman:
    // she has no image surface herself; image work routes via a designer.
    // The group keeps the pair — only the voorman drops it by name — so
    // the meester (above) still has it.
    expect(allow!.has('delegate_image_generator')).toBe(false);
    expect(allow!.has('consult_image_generator')).toBe(false);
  });

  it('a specialist (developer) with rolesAsTools gets only the escalation set', () => {
    const allow = computeToolAllowlist({
      role: 'developer',
      mode: 'always',
      provider: 'mlx',
      modelId: 'gemma4-12b-q4',
      parameterSize: '12B',
      rolesAsTools: true,
      webSearchProvider: 'brave',
    });
    // escalate up to voorman/meester...
    expect(allow!.has('delegate_voorman')).toBe(true);
    expect(allow!.has('consult_meester')).toBe(true);
    // ...not the downward doer tools.
    expect(allow!.has('delegate_developer')).toBe(false);
  });
});
