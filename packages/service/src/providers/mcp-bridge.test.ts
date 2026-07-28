import { mkdtemp, rm } from 'node:fs/promises';
/**
 * End-to-end test for McpBridge: spawns the real @bendyline/gezel-mcp server
 * as a subprocess and drives it through the bridge. Verifies that the SDK
 * client can list tools and invoke them — which is the exact path the
 * OpenAI provider uses when a session has MCP servers configured.
 *
 * Runs against a live gezel service with GEZEL_MOCK_PROVIDER=1 so no real
 * credentials are needed. Tools that hit the API (list_documents, etc.)
 * exercise the full loop.
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { gezelPaths } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../service.js';
import { McpBridge } from './mcp-bridge.js';

const require = createRequire(import.meta.url);

// These tests spawn a real gezel-mcp child process and several poll for
// kickoff sessions that are created asynchronously after start_project /
// start_job returns. The 5s default test timeout is too tight under
// full-suite CPU contention (multiple test files each spawning MCP
// servers), so give every test in this file headroom — matching the 30s
// per-test budget the sibling manager-mcp.test.ts already uses.
vi.setConfig({ testTimeout: 30_000 });

let svc: RunningService;
let bridge: McpBridge;
let mcpPath: string;
let bridgeEnv: Record<string, string>;

async function waitForProjectSessionText(projectId: string, pattern: RegExp): Promise<string> {
  // The kickoff macros return once the entry step is ENQUEUED on the task
  // runner; the handoff session and its seed message only exist after a
  // runner tick dispatches it and the fire-and-forget send lands. Drive
  // both ends rather than racing a wall clock: `tick()` is public for
  // exactly this, and `drainBackground()` awaits the detached send.
  // A timed poll passed here for months and then failed on CI, where the
  // 5s ticker and a per-session MCP child spawn on a loaded 4-vCPU runner
  // outran the window — a slow machine must not change the outcome.
  for (let pass = 0; pass < 10; pass++) {
    // Drain first so slots and writes from earlier tests' unawaited
    // kickoffs settle before this pass measures anything.
    await svc.context.chat.drainBackground();
    await svc.context.taskRunner.tick();
    await svc.context.chat.drainBackground();
    const sessions = await svc.context.store.listSessions({ projectId });
    for (const summary of sessions) {
      const session = await svc.context.store.getSession(summary.gezelId, summary.id);
      const text = session?.messages.map((m) => m.content).join('\n') ?? '';
      if (pattern.test(text)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return '';
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const home = await mkdtemp(join(tmpdir(), 'gezel-mcp-bridge-'));
  svc = await startService({ home });

  const scheme = svc.cert ? 'https' : 'http';
  const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  // Create a gezel + the default project so the MCP tools have context.
  await httpFetch(`${baseUrl}/api/gezels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Ada', role: 'Developer' }),
  });

  mcpPath = require.resolve('@bendyline/gezel-mcp/dist/server.js');

  bridge = new McpBridge();
  // The gezel-mcp child reads `GEZEL_CERT_PATH` to build a trusting
  // dispatcher; without it (HTTPS-disabled run) the child uses plain
  // fetch. Mirrors what `chat/manager.ts` does in production.
  const env: Record<string, string> = {
    GEZEL_BASE_URL: baseUrl,
    GEZEL_TOKEN: svc.context.token,
    GEZEL_AGENT_ID: 'ada',
    GEZEL_PROJECT_ID: 'default',
    GEZEL_HOME: svc.context.home,
  };
  if (svc.cert) env.GEZEL_CERT_PATH = gezelPaths(svc.context.home).runtime.cert;
  bridgeEnv = env;
  await bridge.start({
    command: 'node',
    args: [mcpPath],
    env,
  });
}, 30_000);

afterAll(async () => {
  await bridge?.stop();
  await svc?.stop();
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
});

describe('McpBridge', () => {
  it('lists the expected gezel-mcp tools', () => {
    const tools = bridge.getOpenAITools();
    const names = tools.map((t) => t.name);
    // Spot-check the major categories.
    expect(names).toContain('list_dir');
    expect(names).toContain('read_file');
    expect(names).toContain('list_artifacts');
    expect(names).toContain('write_artifact');
    expect(names).toContain('list_documents');
    expect(names).toContain('read_document');
    expect(names).toContain('write_document');
    expect(names).toContain('search_memory');
    // Team-management tools (meester surface).
    expect(names).toContain('list_gezels');
    expect(names).toContain('create_gezel');
    expect(names).toContain('update_gezel');
    expect(names).toContain('list_projects');
    expect(names).toContain('start_project');
    expect(names).toContain('update_project');
    // `create_project` is intentionally NOT exposed as an MCP tool —
    // `start_project` is the single project-creation entry point for
    // models. The underlying API stays available for direct HTTP
    // consumers but the model never sees both.
    expect(names).not.toContain('create_project');
    // The role-shaped consultation macro — collapses ensure_gezel +
    // ask_gezel into one call.
    expect(names).toContain('ask_specialist');
  });

  it('hasTool returns true for known names, false for bogus ones', () => {
    expect(bridge.hasTool('list_dir')).toBe(true);
    expect(bridge.hasTool('definitely_not_a_tool')).toBe(false);
  });

  it('accepts legacy and miscased spellings end-to-end (alias dispatch)', async () => {
    // Pinned gilde role prompts still teach `readFile`/`readdir`, and small
    // models guess spellings from training priors — either must reach the
    // renamed tool through the real gezel-mcp subprocess, while never
    // appearing in the advertised list.
    const advertised = new Set(bridge.getOpenAITools().map((t) => t.name));
    expect(advertised.has('read_file')).toBe(true);
    expect(advertised.has('readFile')).toBe(false);
    expect(advertised.has('readdir')).toBe(false);

    expect(bridge.hasTool('readFile')).toBe(true);
    expect(bridge.hasTool('read-file')).toBe(true);

    const viaLegacy = await bridge.callTool('readdir', { path: '.' });
    expect(viaLegacy).not.toContain('not found');
    const viaCanonical = await bridge.callTool('list_dir', { path: '.' });
    expect(viaLegacy).toBe(viaCanonical);
  });

  // Static-decision hooks (the shape `buildAutoAllowHook` produces for
  // `autoAllow` toolsets) resolve with no ScriptRunner wired — this
  // bridge never has one. Proves the auto-allow path works standalone.
  describe('static-decision craftbook hooks', () => {
    it('denies a matching tool via a static deny hook (no runner)', async () => {
      bridge.installCraftbookHooks('cb-deny', [
        { phase: 'PreToolUse', matcher: '^list_dir$', decision: 'deny', label: 'blocked for test' },
      ]);
      try {
        const out = await bridge.callTool('list_dir', { path: '.' });
        expect(out).toContain('blocked for test');
      } finally {
        bridge.uninstallCraftbookHooks('cb-deny');
      }
    });

    it('lets a matching tool run via a static allow hook (no runner)', async () => {
      bridge.installCraftbookHooks('cb-allow', [
        { phase: 'PreToolUse', matcher: '^list_dir$', decision: 'allow', label: 'auto-allowed' },
      ]);
      try {
        const out = await bridge.callTool('list_dir', { path: '.' });
        // An allow decision is a no-op: the call proceeds and the result
        // is the real tool output, not the hook's deny reason.
        expect(out).not.toContain('blocked by hook');
      } finally {
        bridge.uninstallCraftbookHooks('cb-allow');
      }
    });

    it('does not gate tools the matcher misses', async () => {
      bridge.installCraftbookHooks('cb-narrow', [
        { phase: 'PreToolUse', matcher: '^camera_snapshot$', decision: 'deny' },
      ]);
      try {
        const out = await bridge.callTool('list_dir', { path: '.' });
        expect(out).not.toContain('blocked by hook');
      } finally {
        bridge.uninstallCraftbookHooks('cb-narrow');
      }
    });

    it('routes ask decisions through askUser: approve proceeds, decline/unset deny', async () => {
      bridge.installCraftbookHooks('cb-ask', [
        { phase: 'PreToolUse', matcher: '^list_dir$', decision: 'ask', label: 'careful check' },
      ]);
      try {
        // No askUser wired → fail closed (guardrails must not silently pass).
        bridge.askUser = undefined;
        const unset = await bridge.callTool('list_dir', { path: '.' });
        expect(unset).toContain('cancelled by user');

        // User approves → the call proceeds to the real tool.
        bridge.askUser = async () => true;
        const approved = await bridge.callTool('list_dir', { path: '.' });
        expect(approved).not.toContain('cancelled by user');

        // User declines → deny with the cancel reason.
        bridge.askUser = async () => false;
        const declined = await bridge.callTool('list_dir', { path: '.' });
        expect(declined).toContain('cancelled by user');
      } finally {
        bridge.uninstallCraftbookHooks('cb-ask');
        bridge.askUser = undefined;
      }
    });
  });

  it('advertises each tool with an OpenAI-compatible schema', () => {
    for (const t of bridge.getOpenAITools()) {
      expect(t.type).toBe('function');
      expect(typeof t.name).toBe('string');
      expect(t.parameters).toBeTypeOf('object');
    }
  });

  it('callTool(list_documents) returns text content', async () => {
    const out = await bridge.callTool('list_documents', {});
    expect(typeof out).toBe('string');
    // With a fresh home there are no documents — server returns the
    // friendly "No documents found." message.
    expect(out).toMatch(/No documents found|📄|📁/);
  });

  it('callTool(write_document) + callTool(read_document) round-trips content', async () => {
    const writeResult = await bridge.callTool('write_document', {
      path: 'e2e/hello.md',
      content: '# Hello from MCP bridge\n\nTest content.',
    });
    expect(writeResult).toMatch(/Wrote document/);

    const readResult = await bridge.callTool('read_document', {
      path: 'e2e/hello.md',
    });
    expect(readResult).toContain('Hello from MCP bridge');
    expect(readResult).toContain('Test content.');
  });

  it('steers workspace paths away from artifact tools', async () => {
    await bridge.callTool('write_file', {
      path: 'surface/bug_report.md',
      content: '# Workspace report\n\nThis belongs to the project workspace.\n',
    });

    const wrongRead = await bridge.callTool('read_artifact', { path: 'surface/bug_report.md' });
    expect(wrongRead).toMatch(/ERROR:/);
    expect(wrongRead).toContain('workspace file exists');
    expect(wrongRead).toContain('read_file');

    const wrongWrite = await bridge.callTool('write_artifact', {
      path: 'surface/bug_report.md',
      content: '# Wrong drawer\n',
    });
    expect(wrongWrite).toMatch(/ERROR:/);
    expect(wrongWrite).toContain('Refusing write_artifact');
    expect(wrongWrite).toContain('not update the project');

    const readBack = await bridge.callTool('read_file', { path: 'surface/bug_report.md' });
    expect(readBack).toContain('# Workspace report');
    expect(readBack).toContain('This belongs to the project workspace.');
  });

  it('redirects source deliverables written to artifacts into the workspace', async () => {
    const redirected = await bridge.callTool('write_artifact', {
      path: 'index.html',
      content: '<!doctype html><html><body><h1>Pet shop</h1></body></html>',
    });

    expect(redirected).not.toMatch(/ERROR:/);
    expect(redirected).toContain('project workspace');
    expect(redirected).toContain('write_file');

    const workspaceFile = await bridge.callTool('read_file', { path: 'index.html' });
    expect(workspaceFile).toContain('<h1>Pet shop</h1>');

    const missingArtifact = await bridge.callTool('read_artifact', { path: 'index.html' });
    expect(missingArtifact).toMatch(/ERROR:/);
    expect(missingArtifact).toContain('workspace file exists');
  });

  it('redirects exact expected markdown deliverables from side drawers into the workspace', async () => {
    const expectedBridge = new McpBridge();
    await expectedBridge.start({
      command: 'node',
      args: [mcpPath],
      env: {
        ...bridgeEnv,
        GEZEL_EXPECTED_DELIVERABLE: JSON.stringify({
          kind: 'file',
          filePath: 'reports/release-notes.md',
        }),
      },
    });

    try {
      const artifactRedirect = await expectedBridge.callTool('write_artifact', {
        path: 'reports/release-notes.md',
        content: '# Release notes\n\n- First workspace pass from the artifact drawer.\n',
      });
      expect(artifactRedirect).not.toMatch(/ERROR:/);
      expect(artifactRedirect).toContain('expected deliverable is a workspace file');

      let workspaceFile = await expectedBridge.callTool('read_file', {
        path: 'reports/release-notes.md',
      });
      expect(workspaceFile).toContain('First workspace pass');

      const documentRedirect = await expectedBridge.callTool('write_document', {
        path: 'reports/release-notes.md',
        content: '# Release notes\n\n- Second workspace pass from the document library.\n',
      });
      expect(documentRedirect).not.toMatch(/ERROR:/);
      expect(documentRedirect).toContain('expected deliverable is a workspace file');

      workspaceFile = await expectedBridge.callTool('read_file', {
        path: 'reports/release-notes.md',
      });
      expect(workspaceFile).toContain('Second workspace pass');

      const missingArtifact = await expectedBridge.callTool('read_artifact', {
        path: 'reports/release-notes.md',
      });
      expect(missingArtifact).toMatch(/ERROR:/);
      expect(missingArtifact).toContain('workspace file exists');
    } finally {
      await expectedBridge.stop();
    }
  });

  it('callTool(list_documents) reflects newly-written files', async () => {
    // After the previous test wrote a doc, it should appear in the listing.
    const out = await bridge.callTool('list_documents', { recursive: true });
    expect(out).toContain('e2e/hello.md');
  });

  it('list_gezels returns the seeded ada gezel', async () => {
    const out = await bridge.callTool('list_gezels', {});
    expect(out).toContain('Ada');
  });

  it('create_gezel + list_gezels shows the new gezel', async () => {
    await bridge.callTool('create_gezel', {
      role: 'Reviewer',
      about:
        '## Identity\n\nYou are a reviewer gezel. You look at artifacts and give ' +
        'terse, actionable critique. Prefer concrete line-level feedback over ' +
        'abstractions.\n',
    });
    const listing = await bridge.callTool('list_gezels', {});
    expect(listing).toContain('Reviewer');
  });

  it('list_projects contains the default project', async () => {
    const out = await bridge.callTool('list_projects', {});
    expect(out.toLowerCase()).toContain('default');
  });

  it('start_project + update_project round-trip', async () => {
    // `create_project` is no longer an MCP tool; `start_project` is
    // the crew-mode macro and exercises the same underlying
    // `api.createProject` HTTP route alongside its voorman / task /
    // message side-effects. The test only asserts the round-trip on
    // the project itself; the side-effects are exercised separately.
    const create = await bridge.callTool('start_project', {
      name: 'Alpha',
      about:
        'Alpha is a test project used by the MCP bridge integration tests. It exists to prove the create/update round-trip via the start_project macro.',
      missionObjectives: '- Prove start_project + update_project work end-to-end\n- Nothing else',
      taskDescription:
        'Verify that the project created by the macro can be updated end-to-end through the bridge.',
    });
    expect(create).toContain('Alpha');
    const match = create.match(/\(([a-z0-9-]+)\)/);
    expect(match).not.toBeNull();
    const id = match![1]!;

    await bridge.callTool('update_project', { id, description: 'updated' });
    const listing = await bridge.callTool('list_projects', {});
    expect(listing).toContain('updated');
  });

  it('start_project kickoff keeps build deliverable and image guidance on the task (D1: no chat notify)', async () => {
    const create = await bridge.callTool('start_project', {
      name: 'Pet Shop Regression',
      about:
        'Pet Shop Regression is a single-page website project used to ensure kickoff handoffs start with real workspace deliverables instead of design-only planning.',
      missionObjectives:
        '- Build a responsive single-page website\n- Generate a custom PNG logo\n- Reference that PNG from the HTML with an img tag',
      taskDescription:
        'Build the single-page pet shop website and generate/integrate a custom PNG logo, ensuring the image is correctly referenced in the final HTML output.',
    });
    const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;

    // The steering rides the TASK now — every step session reads it under
    // `### Current task`, not a one-shot chat bubble.
    const [task] = await svc.context.tasks.list({ projectId });
    expect(task).toBeTruthy();
    const description = task!.description ?? '';
    expect(description).toContain('write_file({ path: "index.html"');
    expect(description).toContain('not `workspace/index.html`');
    expect(description).toContain('Do not impose an artificial byte/line cap');
    expect(description).not.toContain('under ~2.5 KB');
    expect(description).toContain('message_gezel');
    expect(description).toContain('image-generator');
    expect(description).toContain('generate_image');
    expect(description).toContain(
      'expectedDeliverable: { kind: "file", filePath: "assets/logo.png" }',
    );
    expect(description).toContain('<img src="assets/logo.png">');

    // …and the worker starts in a task-scoped ENTRY handoff, not a chat notify.
    const entryText = await waitForProjectSessionText(
      projectId,
      new RegExp(`You've been assigned task ${task!.ref}`),
    );
    expect(entryText).toContain('advance_task_step');
  });

  it('start_project appends the standard build guard to custom kickoff text', async () => {
    const create = await bridge.callTool('start_project', {
      name: 'Custom Kickoff Guard',
      about:
        'Custom Kickoff Guard is a browser game project used to verify custom kickoff text cannot bypass the standard workspace-file guidance.',
      missionObjectives:
        '- Build a playable browser game\n- Ship the actual game as workspace/index.html',
      taskDescription:
        'Build the playable browser game as one self-contained HTML file at workspace/index.html.',
      kickoffMessage:
        'Start the project by delivering a single index.html file that contains the entire game logic.',
    });
    const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;

    // The custom kickoffMessage folds into the task description as a
    // meester note — it can no longer bypass the standard build guard.
    const [task] = await svc.context.tasks.list({ projectId });
    const description = task!.description ?? '';
    expect(description).toContain(
      'Note from the meester: Start the project by delivering a single index.html file',
    );
    expect(description).toContain('write_file({ path: "index.html"');
    expect(description).toContain('not `workspace/index.html`');
    expect(description).toContain('Do not impose an artificial byte/line cap');
  });

  it('start_job promotes website plus generated-logo asks to crew project', async () => {
    const create = await bridge.callTool('start_job', {
      name: 'Pet Shop Solo Promotion',
      about:
        'Pet Shop Solo Promotion is a single-page website with a custom AI-generated logo asset that must be part of the shipped page.',
      missionObjectives:
        '- Build the pet shop website\n- Generate a custom PNG logo\n- Reference the logo from the HTML with an img tag',
      taskDescription:
        'Build the single-page pet shop website and use the image-generation tool to produce a custom PNG logo that the HTML displays.',
      specialistRole: 'builder',
    });
    expect(create).toContain('Promoted start_job to start_project');
    expect(create).toContain('Started project "Pet Shop Solo Promotion"');
    expect(create).toContain('as voorman');

    const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;

    // The promoted crew project's task carries the image-delegation recipe.
    const [task] = await svc.context.tasks.list({ projectId });
    const description = task!.description ?? '';
    expect(description).toContain('message_gezel');
    expect(description).toContain('image-generator');
    expect(description).toContain('generate_image');
  });

  it('start_job fills missing mission fields instead of schema-failing small-model calls', async () => {
    // Earlier macro tests intentionally do not await their fire-and-forget
    // kickoff sends. Drain those before measuring this handoff so its poll
    // window covers this job, not unrelated work queued by previous tests.
    await svc.context.chat.drainBackground();

    const create = await bridge.callTool('start_job', {
      name: 'Tic-Tac-Toe Solo Fallback',
      about:
        'Build a playable browser tic-tac-toe game as a single HTML file at workspace/index.html.',
      missionObjectives: [
        'Create a single HTML file at workspace/index.html',
        'Allow two players to take turns',
        'Display the winner when the game ends',
      ],
    });

    expect(create).toContain('Started job "Tic-Tac-Toe Solo Fallback"');
    expect(create).not.toContain('failed');

    const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;

    // Solo fallback: the task description carries the write_file guidance
    // and the step carries an ENFORCED deliverable (the old notify's
    // advisory expectedDeliverable became an advanceWhen + gate).
    const [task] = await svc.context.tasks.list({ projectId });
    const description = task!.description ?? '';
    expect(description).toContain('write_file({ path: "index.html"');
    expect(description).toContain('not `workspace/index.html`');
    const entryStep = task!.craftbook.steps[0]!;
    expect(entryStep.advanceWhen?.file).toBe('index.html');
    const entryText = await waitForProjectSessionText(
      projectId,
      new RegExp(`You've been assigned task ${task!.ref}`),
    );
    expect(entryText).toBeTruthy();
    expect(create).toContain('template: developer');
  });

  it('start_job normalizes image_generator to the image-generator template', async () => {
    const create = await bridge.callTool('start_job', {
      name: 'Sunset Role Alias',
      about:
        'Render a single stylized sunset-over-mountains PNG image and save it in the workspace.',
      missionObjectives:
        '- Produce a PNG image\n- Save the generated image as workspace/sunset.png',
      taskDescription:
        'Render a stylized sunset over mountains as a PNG image. Save the final image to workspace/sunset.png.',
      specialistRole: 'image_generator',
    });

    expect(create).toContain('Started job "Sunset Role Alias"');
    expect(create).toContain('template: image-generator');

    const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;

    // The image deliverable is enforced on the step: inferSourceDeliverablePath
    // picked up sunset.png, so the entry step gates on the actual PNG landing.
    const [task] = await svc.context.tasks.list({ projectId });
    expect(task!.craftbook.steps[0]!.advanceWhen?.file).toBe('sunset.png');
  });

  it('update_project sets about, missionObjectives, and voormanGezelId', async () => {
    // Pre-create a gezel to be the voorman.
    const createGezel = await bridge.callTool('create_gezel', {
      role: 'Voorman',
      about:
        '## Identity\n\nYou are a voorman — the foreman of this project. ' +
        'You plan work, delegate to the right gezels, and keep tasks moving ' +
        'through their phases.\n',
    });
    const gezelMatch = createGezel.match(/id: ([a-z0-9-]+)/);
    expect(gezelMatch).not.toBeNull();
    const voormanId = gezelMatch![1]!;

    const createProj = await bridge.callTool('start_project', {
      name: 'Gamma',
      about:
        'Gamma is the project used by the voorman-round-trip test — it gets a voorman, about text, and mission objectives applied via update_project.',
      missionObjectives: '- Voorman id round-trips\n- about + mission persist',
      taskDescription:
        'Stand up the project shell so the test can re-assign the voorman and rewrite about/mission via update_project.',
    });
    const projMatch = createProj.match(/\(([a-z0-9-]+)\)/);
    expect(projMatch).not.toBeNull();
    const projectId = projMatch![1]!;

    await bridge.callTool('update_project', {
      id: projectId,
      voormanGezelId: voormanId,
      about: 'Project Gamma about text.',
      missionObjectives: '- Goal 1\n- Goal 2',
    });

    // list_projects should now mention the voorman id.
    const listing = await bridge.callTool('list_projects', {});
    expect(listing).toContain('voorman:');
  });

  it('update_task warns that assignee changes do not notify the gezel', async () => {
    const create = await bridge.callTool('start_project', {
      name: 'Notify Regression',
      about:
        'Notify Regression is a test project for task reassignment guidance when a voorman hands work to another gezel.',
      missionObjectives: '- Assign a task\n- Ensure the assignee is explicitly messaged',
      taskDescription:
        'Build a concrete deliverable and make sure reassignment guidance tells the model to notify the target gezel.',
    });
    const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;
    const ref = create.match(/Created task (\S+)/)![1]!;
    const created = await bridge.callTool('create_gezel', {
      role: 'developer',
      about:
        '## Identity\n\nYou are a developer gezel who turns clear implementation asks into files in the project workspace.\n',
    });
    const gezelId = created.match(/id: ([a-z0-9-]+)/)![1]!;

    const updated = await bridge.callTool('update_task', {
      ref,
      assignee: { kind: 'gezel', gezelId },
    });

    expect(updated).toContain('has NOT been notified');
    expect(updated).toContain('message_gezel');
    expect(updated).toContain('Writing task notes or changing assignee does not notify them');
  });

  describe('set_task_status verification gate (mission objectives)', () => {
    // petshop diagnosis: the Voorman wrote the page once,
    // then called set_task_status({ status: 'complete' }) ~1 min later
    // from prose, never having checked the deliverable against the
    // project's mission objectives. The gate forces the model to either
    // (a) supply a `verification` argument citing how each objective is
    // met, or (b) pick `paused` and keep working.
    it('rejects status=complete on a mission-objective project when verification is missing', async () => {
      const create = await bridge.callTool('start_project', {
        name: 'GatedClose',
        about:
          'GatedClose is the test project for the set_task_status verification gate. It carries explicit mission objectives so the gate fires on close.',
        missionObjectives: '- Page renders\n- Page has a clickable button',
        taskDescription: 'Build a single-page deliverable for the gated-close test.',
      });
      const projectIdMatch = create.match(/\(([a-z0-9-]+)\)/);
      expect(projectIdMatch).not.toBeNull();
      const projectId = projectIdMatch![1]!;

      const tasks = await bridge.callTool('list_tasks', { project: projectId });
      const taskRefMatch = tasks.match(/• (\S+\/\d+) \[/);
      expect(taskRefMatch).not.toBeNull();
      const ref = taskRefMatch![1]!;

      const closed = await bridge.callTool('set_task_status', { ref, status: 'complete' });
      expect(closed).toMatch(/Cannot mark.*complete yet/i);
      expect(closed).toContain('Mission objectives');
      expect(closed).toContain('verification');

      // Task is still active — the close was refused.
      const listing = await bridge.callTool('list_tasks', { project: projectId });
      expect(listing).toContain('[active]');
      expect(listing).not.toContain('[complete]');
    });

    it('rejects status=complete when verification claims an app but no workspace deliverable exists', async () => {
      const create = await bridge.callTool('start_project', {
        name: 'GatedCloseNoFile',
        about:
          'GatedCloseNoFile is a test project for app-like mission objectives without a real workspace deliverable.',
        missionObjectives: '- Ship a playable browser game\n- Write workspace/index.html',
        taskDescription: 'Build the playable browser game for the no-file close gate test.',
      });
      const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;
      const tasks = await bridge.callTool('list_tasks', { project: projectId });
      const ref = tasks.match(/• (\S+\/\d+) \[/)![1]!;

      const closed = await bridge.callTool('set_task_status', {
        ref,
        status: 'complete',
        verification:
          'The game is playable and the UI shows a winner. Evidence: artifacts/plan.md describes the implementation.',
      });

      expect(closed).toMatch(/no shippable file/i);
      expect(closed).toContain('write_file');
      expect(closed).toContain('Artifact-only plans');

      const listing = await bridge.callTool('list_tasks', { project: projectId });
      expect(listing).toContain('[active]');
      expect(listing).not.toContain('[complete]');
    });

    it('accepts status=complete when verification is provided + writes it to task notes', async () => {
      const create = await bridge.callTool('start_project', {
        name: 'GatedCloseOk',
        about: 'GatedCloseOk is the happy-path project for the set_task_status verification gate.',
        missionObjectives: '- Index.html exists\n- Has clickable grid',
        taskDescription: 'Build the page for the verification-passes test.',
      });
      const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;
      const tasks = await bridge.callTool('list_tasks', { project: projectId });
      const ref = tasks.match(/• (\S+\/\d+) \[/)![1]!;
      await svc.context.store.writeProjectWorkspaceFile(
        projectId,
        'index.html',
        '<!doctype html><html><body><button>Click</button><script>document.querySelector("button").onclick=()=>{};</script></body></html>',
      );

      const closed = await bridge.callTool('set_task_status', {
        ref,
        status: 'complete',
        verification:
          'Wrote workspace/index.html (4.2 KB), re-read it: contains a 3x3 grid + click handlers. Satisfies both objectives.',
      });
      expect(closed).toContain(`${ref} → complete`);

      // Status flipped.
      const listing = await bridge.callTool('list_tasks', { project: projectId });
      expect(listing).toContain('[complete]');

      // Verification persisted as a task note (audit log).
      const notes = await bridge.callTool('read_task_notes', { ref });
      expect(notes).toContain('Verification on close');
      expect(notes).toContain('3x3 grid');
    });

    it('does not gate non-complete statuses (paused/active/canceled go through unconditionally)', async () => {
      const create = await bridge.callTool('start_project', {
        name: 'GatedPaused',
        about:
          'GatedPaused tests that the gate ONLY fires on status=complete — paused, active, and canceled should land without verification.',
        missionObjectives:
          '- Verify paused status accepts no verification\n- Verify active status accepts no verification',
        taskDescription: 'Open task that will be paused mid-flight without verification.',
      });
      const projectId = create.match(/\(([a-z0-9-]+)\)/)![1]!;
      const tasks = await bridge.callTool('list_tasks', { project: projectId });
      const ref = tasks.match(/• (\S+\/\d+) \[/)![1]!;

      const paused = await bridge.callTool('set_task_status', { ref, status: 'paused' });
      expect(paused).toContain(`${ref} → paused`);
      expect(paused).not.toMatch(/Cannot mark/i);
    });

    it('repairs index.html draft plans by attaching deliverable gates instead of looping on status', async () => {
      const started = await bridge.callTool('start_plan', {
        goal: 'Build a self-contained index.html bug triage board for a small support team.',
        title: 'Draft Gate Recovery Plan',
      });
      const ref = started.match(/Drafting a plan in (\S+)\./)?.[1];
      expect(ref).toBeTruthy();

      const repaired = await bridge.callTool('set_task_status', { ref, status: 'active' });
      expect(repaired).toContain('Recovered from set_task_status on draft task');
      expect(repaired).toContain('set_step_deliverable');
      expect(repaired).toContain('remains a draft plan');

      const taskJson = await bridge.callTool('get_task', { ref });
      const task = JSON.parse(taskJson);
      const implement = task.craftbook.steps.find(
        (step: { id: string }) => step.id === 'implement',
      );
      expect(task.status).toBe('draft');
      expect(implement.advanceWhen.file).toBe('index.html');
      expect(implement.gate.scripts[0].name).toBe('checkHtmlComplete');
    });
  });

  describe('copy_artifact_to_workspace (binary-safe artifact → workspace)', () => {
    // petshop case: model called write_file with image content
    // as a JSON-string body, ended up with a 4-byte logo.png. This tool
    // is the binary-safe path — the bytes are copied server-side, never
    // round-trip through a JSON string.
    it('preserves bytes when copying a binary artifact into the workspace', async () => {
      // PNG magic + 120 bytes of varied data, including bytes that
      // wouldn't survive a UTF-8 round-trip (0xFF, 0x80–0x9F). 128 bytes
      // total.
      const pngBytes = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...Array.from({ length: 120 }, (_, i) => (i * 7 + 33) & 0xff),
      ]);

      // Drop the PNG into the artifacts drawer via the raw HTTP route —
      // there's no MCP-level tool to land raw bytes into artifacts
      // (image-generator is the producer in real life). The bridge's
      // env wires GEZEL_PROJECT_ID=default, so the artifact must live
      // in the `default` project for the bridge-driven tool to find it.
      const scheme = svc.cert ? 'https' : 'http';
      const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
      const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
      const upload = await httpFetch(
        `${baseUrl}/api/projects/default/artifacts/raw?path=${encodeURIComponent('test-logo.png')}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${svc.context.token}`,
            'Content-Type': 'application/octet-stream',
          },
          body: pngBytes,
        },
      );
      expect(upload.ok).toBe(true);

      const copied = await bridge.callTool('copy_artifact_to_workspace', {
        source: 'test-logo.png',
        dest: 'assets/logo.png',
      });
      expect(copied).toContain('Copied');
      expect(copied).toContain('128 bytes'); // 8 magic + 120 padding

      // Read the workspace file back as raw bytes and assert byte-equality
      // with the original PNG. This is the regression guard against the
      // petshop bug where bytes round-tripped through JSON.
      const readBack = await httpFetch(
        `${baseUrl}/api/projects/default/workspace/read?path=${encodeURIComponent('assets/logo.png')}&raw=1`,
        { headers: { Authorization: `Bearer ${svc.context.token}` } },
      );
      expect(readBack.ok).toBe(true);
      const got = new Uint8Array(await readBack.arrayBuffer());
      expect(got.length).toBe(pngBytes.length);
      for (let i = 0; i < pngBytes.length; i++) {
        expect(got[i]).toBe(pngBytes[i]);
      }
    });

    it('returns an error when the source artifact does not exist', async () => {
      const out = await bridge.callTool('copy_artifact_to_workspace', {
        source: 'does-not-exist.png',
        dest: 'assets/logo.png',
      });
      expect(out).toMatch(/ERROR:|artifact not found/);
    });
  });

  describe('validate (file integrity + parse checks)', () => {
    // The companion to the verification gate: model writes a deliverable,
    // calls validate to confirm shape before set_task_status({ complete }).
    // Should produce evidence the model can cite verbatim in `verification`.
    it('validates an HTML deliverable and returns PASS with structured checks', async () => {
      await bridge.callTool('write_file', {
        path: 'index.html',
        content:
          '<!DOCTYPE html><html><body><h1>Pets</h1><script>\nfunction go() { return 1; }\nconsole.log(go());\n</script></body></html>',
      });
      const out = await bridge.callTool('validate', { path: 'index.html' });
      expect(out).toContain('PASS');
      expect(out).toContain('script-tag-present');
      expect(out).toContain('script-body-parses');
    });

    it('routes a 4-byte image to the copy_artifact_to_workspace hint', async () => {
      // Simulates the petshop bug shape — a "PNG" landed in
      // the workspace via write_file (UTF-8 round-trip), so it's
      // actually just 4 ASCII bytes. The validator should catch it via
      // magic-byte mismatch and point the model at the right repair.
      const scheme = svc.cert ? 'https' : 'http';
      const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
      const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
      await httpFetch(`${baseUrl}/api/projects/default/workspace/file`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${svc.context.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: 'broken.png', content: 'abcd' }),
      });
      const out = await bridge.callTool('validate', { path: 'broken.png' });
      expect(out).toMatch(/FAIL/);
      expect(out).toMatch(/magic-bytes/);
      expect(out).toMatch(/copy_artifact_to_workspace/);
    });

    it('returns an actionable error with line + excerpt on a JS syntax error in HTML', async () => {
      await bridge.callTool('list_projects', {}); // ensure context exists
      // write_file refuses HTML with broken script body, so use
      // write_artifact (no syntax validation) to land the broken file
      // for validate to look at.
      await bridge.callTool('write_artifact', {
        path: 'broken-page.html',
        content: [
          '<!DOCTYPE html>',
          '<html><body><script>',
          'function broken( {', // syntax error
          '  return 1;',
          '}',
          '</script></body></html>',
        ].join('\n'),
        force: true,
      });
      const out = await bridge.callTool('validate', {
        path: 'broken-page.html',
        where: 'artifact',
      });
      expect(out).toMatch(/FAIL/);
      expect(out).toMatch(/at line \d+/);
      expect(out).toContain('← here');
    });
  });

  it('callTool with an unknown tool returns an ERROR string', async () => {
    // The SDK's callTool doesn't throw on MCP errors — it returns a result
    // with `isError: true` which our bridge coalesces into an "ERROR: ..."
    // string so the caller (OpenAI tool loop) can feed it back as output.
    const result = await bridge
      .callTool('this_tool_does_not_exist', {})
      .catch((err: unknown) => `CAUGHT: ${(err as Error).message}`);
    // Accept either "ERROR:" (normal path) or "CAUGHT:" (if the SDK starts
    // rejecting in the future — be forgiving).
    expect(result).toMatch(/ERROR:|CAUGHT:/);
  });

  describe('write_file syntax validation (HTML + JS/TS)', () => {
    it('write_file persists a first-write HTML draft with unparseable inline <script>', async () => {
      // Mirrors the gemma4-e4b tictactoe failure mode:
      // 4 KB of valid HTML with one truncated `function` body, all
      // <script> tags balanced. Without the validator the file lands
      // and the model gets a Wrote confirmation; now the model gets a
      // parse error, but the first draft lands so read/repair tools can
      // recover without re-streaming the whole file.
      const brokenHtml =
        '<!DOCTYPE html><html><body><script>\nfunction reset() {\n  board = [];\n// missing close brace\nfor (let i = 0; i < 9; i++) {}\n</script></body></html>';
      const out = await bridge.callTool('write_file', {
        path: 'broken.html',
        content: brokenHtml,
      });
      expect(out).toMatch(/ERROR:|inline <script>/);
      expect(out).toContain('Invalid first draft broken.html was saved');

      const readBack = await bridge.callTool('read_file', { path: 'broken.html' });
      expect(readBack).toContain('function reset()');
      expect(readBack).toContain('// missing close brace');
    });

    it('completes a first-write truncated HTML partial (valid body) by appending the missing tail', async () => {
      // The source-write-guard wrapper auto-closes a truncated HTML write
      // when the JS so far parses: it appends the missing </script></body>
      // </html> rather than rejecting, so a model that ran out of output
      // budget mid-tail still lands a usable file. Genuinely broken bodies
      // still reach the server's reject/recover path (see the parse-error
      // cases below).
      const partialHtml = '<!DOCTYPE html><html><body><canvas></canvas><script>\nconst x = 1;\n';
      const out = await bridge.callTool('write_file', {
        path: 'partial-game.html',
        content: partialHtml,
      });
      expect(out).toMatch(/Wrote partial-game\.html/);

      const readBack = await bridge.callTool('read_file', { path: 'partial-game.html' });
      expect(readBack).toContain('<canvas>');
      expect(readBack).toContain('const x = 1;');
      expect(readBack).toContain('</script>');
      expect(readBack).toContain('</html>');
    });

    it('write_file preserves an existing file when a replacement HTML write has a balanced script parse error', async () => {
      await bridge.callTool('write_file', {
        path: 'keep-good-balanced.html',
        content: '<!DOCTYPE html><html><body><script>window.ok = true;</script></body></html>',
      });
      const out = await bridge.callTool('write_file', {
        path: 'keep-good-balanced.html',
        content:
          '<!DOCTYPE html><html><body><script>\nfunction reset() {\n  window.ok = false;\n</script></body></html>',
      });
      expect(out).toMatch(/ERROR:/);
      expect(out).toContain('Existing keep-good-balanced.html was left untouched');

      const readBack = await bridge.callTool('read_file', { path: 'keep-good-balanced.html' });
      expect(readBack).toContain('window.ok = true');
      expect(readBack).not.toContain('window.ok = false');
    });

    it('completes a truncated replacement HTML write (valid body) and overwrites', async () => {
      // The replacement body parses and isn't a destructive shrink, so the
      // wrapper closes the tail and the overwrite goes through. A much
      // shorter truncation is still refused by the destructive-overwrite
      // guard, and a balanced-but-unparseable replacement is preserved (see
      // the parse-error case above).
      await bridge.callTool('write_file', {
        path: 'keep-good.html',
        content: '<!DOCTYPE html><html><body><script>window.ok = true;</script></body></html>',
      });
      const out = await bridge.callTool('write_file', {
        path: 'keep-good.html',
        content: '<!DOCTYPE html><html><body><script>\nwindow.ok = false;\n',
      });
      expect(out).toMatch(/Wrote keep-good\.html/);

      const readBack = await bridge.callTool('read_file', { path: 'keep-good.html' });
      expect(readBack).toContain('window.ok = false');
      expect(readBack).toContain('</script>');
    });

    it('write_file accepts a clean HTML file', async () => {
      const okHtml = '<!DOCTYPE html><html><body><script>console.log("hi");</script></body></html>';
      const out = await bridge.callTool('write_file', {
        path: 'good.html',
        content: okHtml,
      });
      expect(out).toMatch(/Wrote good\.html/);
    });

    it('write_file repairs recoverable Gemma HTML write artifacts before persisting', async () => {
      const recoveredHtml =
        '<!DOCTYPE html><html><body><button id="cell"></button><script>\n' +
        'document.getElementById("cell").innerTextText = "X";\n' +
        '</script></body></html>\n""",path: "index.html"';
      const out = await bridge.callTool('write_file', {
        path: 'recovered-gemma.html',
        content: recoveredHtml,
      });
      expect(out).toMatch(/Wrote recovered-gemma\.html/);

      const readBack = await bridge.callTool('read_file', { path: 'recovered-gemma.html' });
      expect(readBack).toContain('.innerText = "X"');
      expect(readBack).not.toContain('innerTextText');
      expect(readBack).not.toContain('""",path');
      expect(readBack.trim()).toMatch(/<\/html>$/);
    });

    it('write_file rejects a .ts file with a syntax error', async () => {
      const out = await bridge.callTool('write_file', {
        path: 'lib.ts',
        content: 'export function f(x: number {\n  return x;\n}\n',
      });
      expect(out).toMatch(/syntax error/);
    });

    it('write_file accepts a clean .tsx file with type annotations', async () => {
      const out = await bridge.callTool('write_file', {
        path: 'Hello.tsx',
        content:
          'export function Hello(props: { name: string }) { return <span>{props.name}</span>; }\n',
      });
      expect(out).toMatch(/Wrote Hello\.tsx/);
    });
  });

  // Layer 4: surgical-edit tools (replace_in_file / apply_patch /
  // insert_at_marker). Each round-trips through the real MCP subprocess
  // and the real service, exercising path safety, atomic write, diff
  // generation, and the structuredContent passthrough.
  describe('surgical-edit tools (Layer 4)', () => {
    it('replace_in_file rewrites a single occurrence and surfaces a unified diff via structuredContent', async () => {
      // Seed a file the model will edit.
      await bridge.callTool('write_file', {
        path: 'layer4/notes.md',
        content: 'hello world\nfoo bar\n',
      });
      // Capture the next tool-call event so we can inspect the diff
      // payload the bridge forwards via structuredContent.
      const captured: Array<{ name: string; structured?: Record<string, unknown> }> = [];
      const prior = bridge.onToolCall;
      bridge.onToolCall = (info) => {
        captured.push({ name: info.name, structured: info.structuredContent });
      };
      try {
        const out = await bridge.callTool('replace_in_file', {
          path: 'layer4/notes.md',
          find: 'foo bar',
          replace: 'FOO BAR',
        });
        expect(out).toMatch(/Edited layer4\/notes\.md \(\+1 −1\)/);
      } finally {
        bridge.onToolCall = prior;
      }
      // The bridge's `_invokeRaw` trims its text join, so a trailing
      // newline in the file content doesn't survive the read_file call.
      // Compare against the trimmed expected value to match.
      const readBack = await bridge.callTool('read_file', { path: 'layer4/notes.md', raw: true });
      expect(readBack).toBe('hello world\nFOO BAR');
      const event = captured.find((c) => c.name === 'replace_in_file');
      expect(event?.structured).toBeDefined();
      expect(event?.structured?.diff).toMatch(/-foo bar/);
      expect(event?.structured?.diff).toMatch(/\+FOO BAR/);
      expect(event?.structured?.addedLines).toBe(1);
      expect(event?.structured?.removedLines).toBe(1);
    });

    it('replace_in_file returns a clear error when the pattern matches multiple places', async () => {
      await bridge.callTool('write_file', {
        path: 'layer4/dupes.md',
        content: 'cat cat cat\n',
      });
      const out = await bridge.callTool('replace_in_file', {
        path: 'layer4/dupes.md',
        find: 'cat',
        replace: 'dog',
      });
      expect(out).toMatch(/ERROR:/);
      expect(out).toMatch(/specify occurrence/);
    });

    it('replace_in_file rejects and restores edits that break inline HTML scripts', async () => {
      const cleanHtml = '<html><body><script>const score = 1;</script></body></html>';
      await bridge.callTool('write_file', {
        path: 'layer4/replace-broken.html',
        content: cleanHtml,
      });

      const out = await bridge.callTool('replace_in_file', {
        path: 'layer4/replace-broken.html',
        find: 'const score = 1;',
        replace: 'const score = ;',
      });

      expect(out).toMatch(/ERROR:/);
      expect(out).toMatch(/failed source validation/);
      const readBack = await bridge.callTool('read_file', {
        path: 'layer4/replace-broken.html',
        raw: true,
      });
      expect(readBack).toBe(cleanHtml);
    });

    it('apply_patch applies a unified diff and returns the change envelope', async () => {
      await bridge.callTool('write_file', {
        path: 'layer4/patched.txt',
        content: 'one\ntwo\nthree\n',
      });
      const diff = [
        '--- a/layer4/patched.txt',
        '+++ b/layer4/patched.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '',
      ].join('\n');
      const out = await bridge.callTool('apply_patch', {
        path: 'layer4/patched.txt',
        diff,
      });
      expect(out).toMatch(/Applied patch to layer4\/patched\.txt/);
      const readBack = await bridge.callTool('read_file', {
        path: 'layer4/patched.txt',
        raw: true,
      });
      expect(readBack).toBe('one\nTWO\nthree');
    });

    it('apply_patch rejects a multi-file diff with guidance', async () => {
      await bridge.callTool('write_file', { path: 'layer4/m1.txt', content: 'a\n' });
      await bridge.callTool('write_file', { path: 'layer4/m2.txt', content: 'b\n' });
      const diff = [
        '--- a/layer4/m1.txt',
        '+++ b/layer4/m1.txt',
        '@@ -1 +1 @@',
        '-a',
        '+A',
        '--- a/layer4/m2.txt',
        '+++ b/layer4/m2.txt',
        '@@ -1 +1 @@',
        '-b',
        '+B',
        '',
      ].join('\n');
      const out = await bridge.callTool('apply_patch', {
        path: 'layer4/m1.txt',
        diff,
      });
      expect(out).toMatch(/ERROR:/);
      expect(out).toMatch(/one-file-per-call/);
    });

    it('apply_patch rejects and restores edits that break JavaScript syntax', async () => {
      await bridge.callTool('write_file', {
        path: 'layer4/patch-broken.js',
        content: 'const score = 1;\n',
      });
      const diff = [
        '--- a/layer4/patch-broken.js',
        '+++ b/layer4/patch-broken.js',
        '@@ -1 +1 @@',
        '-const score = 1;',
        '+const score = ;',
        '',
      ].join('\n');

      const out = await bridge.callTool('apply_patch', {
        path: 'layer4/patch-broken.js',
        diff,
      });

      expect(out).toMatch(/ERROR:/);
      expect(out).toMatch(/failed source validation/);
      const readBack = await bridge.callTool('read_file', {
        path: 'layer4/patch-broken.js',
        raw: true,
      });
      expect(readBack).toBe('const score = 1;');
    });

    it('insert_at_marker drops content after the marker by default', async () => {
      await bridge.callTool('write_file', {
        path: 'layer4/exports.ts',
        content: "// EXPORTS\nexport * from './a.js';\n",
      });
      const out = await bridge.callTool('insert_at_marker', {
        path: 'layer4/exports.ts',
        marker: '// EXPORTS\n',
        content: "export * from './b.js';\n",
      });
      expect(out).toMatch(/Inserted/);
      const readBack = await bridge.callTool('read_file', { path: 'layer4/exports.ts', raw: true });
      expect(readBack).toBe("// EXPORTS\nexport * from './b.js';\nexport * from './a.js';");
    });

    it('insert_at_marker rejects when the marker is ambiguous', async () => {
      await bridge.callTool('write_file', {
        path: 'layer4/ambig.txt',
        content: 'X\nbody\nX\n',
      });
      const out = await bridge.callTool('insert_at_marker', {
        path: 'layer4/ambig.txt',
        marker: 'X',
        content: 'y',
      });
      expect(out).toMatch(/ERROR:/);
      expect(out).toMatch(/longer literal substring/);
    });

    it('insert_at_marker rejects and restores edits that break inline HTML scripts', async () => {
      const cleanHtml = '<html><body><script>\nconst score = 1;\n</script></body></html>';
      await bridge.callTool('write_file', {
        path: 'layer4/insert-broken.html',
        content: cleanHtml,
      });

      const out = await bridge.callTool('insert_at_marker', {
        path: 'layer4/insert-broken.html',
        marker: '<script>\n',
        content: 'const broken = ;\n',
      });

      expect(out).toMatch(/ERROR:/);
      expect(out).toMatch(/failed source validation/);
      const readBack = await bridge.callTool('read_file', {
        path: 'layer4/insert-broken.html',
        raw: true,
      });
      expect(readBack).toBe(cleanHtml);
    });
  });
});
