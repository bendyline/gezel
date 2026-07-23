import type { GezelClient } from '@bendyline/gezel-client/node';
import {
  detectUnclosedScript,
  extractInlineScripts,
  validateScriptSyntax,
} from '../html-validation.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Self-correction — read, debug, fix a broken inline-JS file.
 *
 * Most scenarios test "can the model generate working code from
 * scratch." This scenario tests a different — and arguably more
 * realistic — capability: **given a broken file, can the model find
 * and fix the bug**?
 *
 * The setup hook seeds `workspace/index.html` with HTML whose inline
 * JS has a subtle truncation bug (missing closing brace on a function).
 * The prompt instructs the team to find and fix it without rewriting
 * the file from scratch. Pass: the inline JS parses cleanly AND the
 * file is still substantively the same shape (i.e. the model edited
 * rather than rewrote everything).
 *
 * The "substantively the same shape" check is forgiving — we don't
 * forbid rewriting (a small model might genuinely find that easier).
 * What we DO want to surface in the postmortem: did the model read
 * before writing? The score-trial counts readFile/grep_artifact calls
 * against this scenario's project; lots of writes + zero reads is the
 * tell-tale "I'll just regenerate from scratch" anti-pattern.
 */

const BROKEN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Counter</title>
</head>
<body>
  <h1>Click counter</h1>
  <button id="incr">Click me</button>
  <p>Clicks: <span id="count">0</span></p>
  <script>
    let count = 0;
    function increment() {
      count = count + 1;
      const span = document.getElementById('count');
      span.textContent = count;
    // ← function above is missing its closing brace
    document.getElementById('incr').addEventListener('click', increment);
  </script>
</body>
</html>
`;

const PROJECT_NAME = 'Broken Counter';
const DEVELOPER_NAME = 'Casey';

/**
 * Resolve the broken-counter project's id — find by exact name. The id
 * is assigned by the service at create time (slugified) and we want the
 * setup + successCheck to use the same one without coupling to a
 * specific slug algorithm.
 */
async function findBrokenCounterId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function setup({ client, log }: EvalContext): Promise<void> {
  // Create the broken-counter project. createProject's schema requires
  // non-trivial about + missionObjectives strings; both auto-inject
  // into the system prompt for any session in this project, so we use
  // them to give the team a clear briefing.
  let projectId = await findBrokenCounterId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A tiny click-counter web page with a syntax bug in its inline JavaScript. ' +
        'The button should increment a span when clicked, but the inline script has a ' +
        'truncation error — the team needs to read the file, find the bug, and fix it without rewriting the page from scratch.',
      missionObjectives:
        '1. Read workspace/index.html in this project. 2. Identify the JavaScript bug. ' +
        '3. Fix it with a minimal edit — preserve the existing structure and intent. 4. The fixed page should have a working click counter.',
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('self-correction setup: failed to resolve project id');

  await client.writeProjectWorkspaceFile(projectId, {
    path: 'index.html',
    content: BROKEN_HTML,
  });
  log(
    `[scenario:setup] seeded broken workspace/${projectId}/index.html (${BROKEN_HTML.length} bytes)`,
  );

  // Pre-create a developer gezel and join them to the project. This
  // dramatically simplifies what the Meester has to do: "ask Casey to
  // fix the bug in his project" beats "figure out who should fix this,
  // recruit them, create a sub-project, assign a task, ping them."
  // Wild-caught: the smallest model created a *new* project
  // ("Broken Counter Fix") for the work, then the recruited developer
  // got a 404 looking for index.html in that new project. Pre-staging
  // the developer + project eliminates the multi-hop delegation that's
  // where small models fail.
  let casey: { id: string };
  try {
    // No hand-written about: the service resolves the shipped Developer
    // template (product-shaped prompt). Task specifics live in the
    // kickoff message below — the eval measures the product
    // configuration, not a scenario-tuned system prompt.
    const created = await client.createGezel({
      name: DEVELOPER_NAME,
      role: 'Developer',
    });
    casey = { id: created.id };
    log(`[scenario:setup] created developer "${DEVELOPER_NAME}" id=${casey.id}`);
  } catch (err) {
    // If a previous trial already created Casey (unlikely in eval harness
    // since trial homes are fresh tempdirs, but defensive), find them.
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === DEVELOPER_NAME);
    if (!existing) throw err;
    casey = { id: existing.id };
    log(`[scenario:setup] reusing developer "${DEVELOPER_NAME}" id=${casey.id}`);
  }
  await client.addGezelToProject(projectId, casey.id);
  log(`[scenario:setup] joined ${DEVELOPER_NAME} to project ${projectId}`);

  // Kick Casey off in the broken-counter project session directly. The
  // trial harness's kickoff prompt lands on the Meester in the *default*
  // project (that's the runner's hardcoded `projectId: 'default'`), and
  // when the Meester then `message_gezel`s Casey, Casey receives the
  // message in his default-project session — NOT in broken-counter. As
  // a result he doesn't get the project's auto-injected about /
  // missionObjectives in his system prompt, doesn't have workspace-fs
  // scoped to broken-counter, and can't find index.html. Wild-caught
  //trial 2 had Casey on broken-counter's roster but his
  // chat went `casey/default` and he never found the file.
  //
  // Skipping the Meester routing entirely + dropping the message into
  // the project chat directly closes that gap. The Meester still gets
  // the trial's kickoff prompt as a benign nudge so the chat history
  // looks normal, but the actual work request goes to Casey in the
  // right project context.
  await client.sendChatMessage(casey.id, {
    message:
      'Please fix the bug in `index.html` in this project — the click counter does not ' +
      'increment when the button is clicked. ' +
      'First call `readFile(path: "index.html")` to read it — paths are relative to ' +
      'the workspace root, so do NOT use "workspace/index.html" or you will get 404. ' +
      'Then identify the JavaScript syntax error and edit the file in place via ' +
      '`writeFile`. Do not rewrite the file from scratch; the fix should be a single-' +
      'line correction. Stay in this project — do not create a new one.',
    projectId,
  });
  log(`[scenario:setup] sent kickoff message to ${DEVELOPER_NAME} in project ${projectId}`);
}

async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

export const selfCorrectionScenario: EvalScenario = {
  id: 'self-correction-broken-js',
  description:
    'Seeded with a broken click-counter HTML (inline JS missing a closing brace). The team must find and fix the bug. Tests read-debug-fix capability vs from-scratch regeneration.',
  // The setup hook has already (a) created the broken-counter project,
  // (b) seeded workspace/index.html with the broken HTML, (c) recruited
  // a developer named Casey into that project, AND (d) sent Casey a
  // direct work request in the project chat. So this prompt is a
  // benign FYI to the Meester — the actual work runs in parallel via
  // Casey's session. The Meester doesn't need to orchestrate; her
  // role here is just to keep the default chat alive (otherwise the
  // auto-answerer's "no idle session" guard kicks in).
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is fixing a JS bug in workspace/index.html on the`,
    `"${PROJECT_NAME}" project. They're working on it in that project's chat.`,
    `You don't need to do anything — just confirm you've seen this note.`,
  ].join(' '),
  // 25-min absolute ceiling (was 12) + a 10-min no-progress watchdog.
  // read + minimal-edit + verify is ~5-8 min on a fast medium model, but a
  // slow MLX engine that is legitimately reading-then-editing needs more than
  // 12 min — the 9b hit the old ceiling while "forward progress kept
  // happening" (a throughput artifact, MLX matrix). The diagnostic
  // is preserved AND sharpened: a model that can't decide to read makes NO
  // progress and now fails fast at the 10-min watchdog (the readFile-call
  // count is still the tell), while a model that's actually iterating gets the
  // headroom to close.
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  // Saturated fleet-wide (~100% incl. 2B models, ~1 min/trial) since the
  // Source-repair fixes — run as a 1-trial regression canary in
  // matrices; `symptom-debug` is the headroom successor.
  suggestedTrials: 1,
  setup,
  skipInitialPrompt: true,
  successCheck: async ({ client, logChanged }): Promise<SuccessCheckResult> => {
    const projectId = await findBrokenCounterId(client);
    if (!projectId) {
      logChanged('project', '[scenario] broken-counter project not present yet');
      return { done: false };
    }
    const html = await readWorkspaceText(client, projectId, 'index.html');
    if (html === null) {
      logChanged('file', `[scenario] ${projectId}/index.html not present yet`);
      return { done: false };
    }
    const closure = detectUnclosedScript(html);
    const scripts = extractInlineScripts(html);
    const validation = validateScriptSyntax(scripts);

    const signals: string[] = [];
    if (!closure.unclosed) signals.push('script-closed');
    if (validation.allParse) signals.push('js-parses');
    if (validation.totalBytes >= 200) signals.push('js-non-trivial');
    // Same-shape check: the title and the increment-on-click intent
    // should still be there. Forgive minor wording shifts.
    if (/click counter|click me|increment/i.test(html)) signals.push('preserves-intent');

    const fail: string | null = !closure.unclosed
      ? validation.allParse
        ? null
        : `inline JS still does not parse (${validation.firstError?.slice(0, 100) ?? 'unknown'})`
      : `still unclosed: ${closure.opens} <script> opens vs ${closure.closes} </script> closes`;

    logChanged(
      'sniff',
      `[scenario] index.html bytes=${html.length} signals=${signals.join(',') || 'none'}${fail ? ` failReason="${fail}"` : ''}`,
    );

    // Pass when JS parses cleanly AND the shape is preserved. Don't
    // require `script-closed` separately — parsing implies closure.
    if (validation.allParse && signals.includes('preserves-intent')) {
      return {
        done: true,
        success: true,
        reason: `JS now parses + intent preserved (signals: ${signals.join(', ')})`,
      };
    }
    return { done: false };
  },
};
