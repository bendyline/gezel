import { setTimeout as wait } from 'node:timers/promises';
import type { GezelClient } from '@bendyline/gezel-client/node';

/**
 * Pick the "best" multiple-choice option for a headless eval.
 *
 * Naive `choice[0]` works for design/style preference questions ("Which
 * color palette?") but misfires when a gezel offers options that defer
 * the work back to the human ("Provide a logo image (upload)") or skip
 * it ("Use a placeholder for now"). The eval is meant to test whether
 * the gezels can complete the task; picking those options trains the
 * harness to reward avoidance.
 *
 * The scoring is intentionally conservative — small bonuses/penalties
 * keyed on action verbs vs deferral verbs. Ties resolve by original
 * index (so the gezel's own ordering still matters).
 *
 * Returns the index of the chosen option. Exported for unit testing.
 */
export function pickAutoAnswerChoice(choices: readonly string[], prompt = ''): number {
  if (choices.length === 0) return 0;

  // Verbs that indicate the gezel will *do* the work (good — pick this).
  // The petshop trial added "use generate_image" / "call the .+
  // tool" / "delegate to (the )?image-generator" to the positive set:
  // when the team was stuck on "how do I make a logo?", picking a choice
  // that explicitly named the right MCP tool was the rescue path the
  // harness should reward.
  const positive =
    /\b(generate|generating|create|creating|render|rendering|build|building|draw|drawing|design|designing|write|writing|make|making|produce|producing|ship|shipping|code|coding|implement|implementing|use the (image|generation|.+) tool|call the .+ tool|use generate_image|invoke .+ tool|delegate to (the )?image-generator|use the existing tool|use the bundled .+ tool|@mention the image-generator)\b/i;

  // Verbs that defer the work back to a human or skip it (bad — avoid).
  // Added `install\s+(a |the )?\S+\s+(npm |package|library)` after the
  // petshop trial where the auto-answerer picked "Install a
  // standard AI image generation package (e.g., 'ai-generator')" because
  // "generate" in the prefix outweighed any deferral signal. The new term
  // catches package-install proposals that re-route real MCP work into
  // npm-fantasy land. Also added `mock\b` to catch "use a mock service"
  // / "swap in a mock", which is the same fabrication-by-deferral pattern.
  const negative =
    /\b(upload|user[- ]?provided?|user[- ]?supplied|placeholder|skip|defer|postpone|ask the user|manual(ly)?|stock photo|stock image|wait for|hand-?off to (the )?user|come back later|install\s+(a |an |the )?\S+\s+(npm |package|library|module|sdk)|use\s+(a |an |the )?mock\b|swap\s+in\s+(a |an |the )?mock\b)\b/i;
  const asksForProjectWriteTarget =
    /\bwhich\s+project\b/i.test(prompt) &&
    /\b(write|create|put|place|save|deliverable|index\.html|workspace)\b/i.test(prompt);

  let bestIdx = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i] ?? '';
    let score = 0;
    if (positive.test(c)) score += 2;
    if (negative.test(c)) score -= 3;
    if (asksForProjectWriteTarget) {
      if (/^default$/i.test(c.trim())) score -= 4;
      if (/\b(project|arcade|website|app|game|store|shop|review|migration|api)\b/i.test(c)) {
        score += 2;
      }
    }
    // Tie-breaker: earlier choices win when the score is equal —
    // preserves the gezel's own ordering preference.
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function repoSourceAutoAnswerText(
  prompt: string,
  choices: readonly string[] = [],
): string | null {
  const haystack = [prompt, ...choices].join('\n');
  if (!/\b(source code|repository|repo|github|clone|fetch_repo|squisq)\b/i.test(haystack)) {
    return null;
  }
  if (
    !/\b(stuck|provide|send|need|missing|do not have|don't have|cannot access|can't access|unavailable|source code now)\b/i.test(
      haystack,
    )
  ) {
    return null;
  }
  const squisqHint = /\bsquisq\b/i.test(haystack)
    ? ' For Squisq specifically, call `fetch_repo({ url: "https://github.com/bendyline/squisq", projectName: "Squisq Code Review" })`.'
    : '';
  return `Do not wait for source code from me. Use the available \`fetch_repo\` tool with the repository URL from the task prompt, then inspect the cloned workspace with \`list_dir\` and \`read_file\`, and write the requested deliverable file.${squisqHint}`;
}

export function projectContextAutoAnswerText(
  prompt: string,
  choices: readonly string[] = [],
): string | null {
  const haystack = [prompt, ...choices].join('\n');
  if (!/\bmission\s*objectives\b|\bmissionObjectives\.md\b|\bobjectives\.md\b/i.test(haystack)) {
    return null;
  }
  if (
    !/\b(share|provide|paste|send|need|missing|where|location|review|assess|progress)\b/i.test(
      haystack,
    )
  ) {
    return null;
  }
  return [
    'Do not wait for missionObjectives.md from me.',
    'Use the project context and the kickoff message already available in this conversation as the objectives.',
    'The eval task is fully specified; do not ask for missionObjectives.md again.',
    'Continue now by writing or repairing the expected deliverable file in the workspace with `write_file`.',
  ].join(' ');
}

export function workspaceFixtureAutoAnswerText(
  prompt: string,
  choices: readonly string[] = [],
): string | null {
  const haystack = [prompt, ...choices].join('\n');
  const pathMatches = haystack.match(
    /\b(?:facts|fixtures|fixture|state|data|inputs?|logs|checks|specs?)\/[A-Za-z0-9._/-]+/gi,
  );
  const inferredPaths: string[] = [];
  if (/\bincident\s+brief\b/i.test(haystack)) inferredPaths.push('facts/incident-brief.md');
  if (/\blegal\s+requirements?\b/i.test(haystack)) {
    inferredPaths.push('facts/legal-requirements.md');
  }
  if (/\bvoice\s+guide\b/i.test(haystack)) inferredPaths.push('facts/voice-guide.md');

  if ((!pathMatches || pathMatches.length === 0) && inferredPaths.length === 0) return null;
  if (
    !/\b(share|provide|paste|send|contents?|need|missing|where|location|available|access)\b/i.test(
      haystack,
    )
  ) {
    return null;
  }
  const paths = Array.from(
    new Set([...(pathMatches ?? []).map((p) => p.replace(/[),.;:]+$/g, '')), ...inferredPaths]),
  ).slice(0, 6);
  const pathList = paths.length > 0 ? ` (${paths.map((p) => `\`${p}\``).join(', ')})` : '';
  return [
    `Do not wait for seeded workspace file contents from me${pathList}.`,
    'Those files already exist in the project workspace.',
    'Use `read_file` with the workspace-relative path for each needed file, then continue.',
    'Do not ask me to paste file contents again; write or repair the expected deliverable with `write_file`.',
  ].join(' ');
}

export function npmInstallAutoDecisions(
  intent: unknown,
): Array<{ package: string; version: string; decision: 'install' | 'decline' }> | null {
  if (!intent || typeof intent !== 'object') return null;
  if ((intent as { kind?: unknown }).kind !== 'npm-install-approval') return null;
  const packages = (intent as { packages?: unknown }).packages;
  if (!Array.isArray(packages) || packages.length === 0) return null;
  // Decline everything: trials are hermetic (local faked data only), and
  // an install here would hit the real npm registry mid-trial. The daemon
  // side enforces the same policy via GEZEL_NPM_INSTALL_OFFLINE (set in
  // spawn.ts); this branch only fires for stray pre-existing approval
  // questions and keeps the two layers consistent.
  const decisions: Array<{ package: string; version: string; decision: 'install' | 'decline' }> =
    [];
  for (const pkg of packages) {
    if (!pkg || typeof pkg !== 'object') continue;
    const name = (pkg as { package?: unknown }).package;
    const version = (pkg as { version?: unknown }).version;
    if (typeof name !== 'string' || typeof version !== 'string') continue;
    decisions.push({ package: name, version, decision: 'decline' });
  }
  return decisions.length > 0 ? decisions : null;
}

/**
 * Make headless confirmation answers operational, not merely affirmative.
 * Small local models can otherwise ask the same "should I proceed?" card
 * after every Yes response without taking the already-scoped action.
 */
export function permissionToProceedAutoAnswerText(prompt: string): string | null {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const asksPermission =
    /\b(?:are you ready for me to|should i|shall i|may i|can i|do you want me to|would you like me to)\b/i.test(
      normalized,
    ) || /\bdo you (?:want|authorize|approve|confirm)\b/i.test(normalized);
  const namesAction =
    /\b(?:proceed|continue|start|begin|implement|fix|write|create|delegate|hand\s*off|handoff)\b/i.test(
      normalized,
    );
  if (!asksPermission || !namesAction) return null;
  return [
    'Yes. The requested in-scope action is already authorized.',
    'Call the required action or handoff tool now and continue; do not ask for permission again.',
  ].join(' ');
}

/**
 * In a headless eval no human is available to answer the meester's
 * questions. Without an auto-responder, trials stall at:
 *
 *   1. Structured `ask_user_question` MCP calls — the question lands in
 *      `/api/questions?pending=true` and waits forever for an answer.
 *      Observed in the petshop scenario when Begonya (Designer) generated
 *      three logos and asked which aesthetic to use.
 *
 *   2. Inline chat questions — the meester sometimes asks the user a
 *      clarification in plain assistant text ("Is this a one-person job
 *      or a team effort?"), without using the MCP tool. The /questions
 *      poll never sees this; the trial sits idle until timeout.
 *
 * The auto-answerer addresses BOTH. Returns a stop function — call it on
 * trial teardown so the loop exits cleanly.
 */
export function startAutoAnswerer(opts: {
  client: GezelClient;
  /** Meester id — needed to watch the front-door chat for inline questions. */
  meesterId: string;
  log: (line: string) => void;
  pollIntervalMs?: number;
  /** Idle window before treating a meester `?`-ending message as a stuck question. */
  inlineIdleMs?: number;
  /** Override the canned generic answer. */
  defaultAnswer?: string;
  /** Abort signal — stops the loop without needing the returned fn. */
  signal?: AbortSignal;
}): () => Promise<void> {
  const interval = opts.pollIntervalMs ?? 5_000;
  const inlineIdleMs = opts.inlineIdleMs ?? 30_000;
  const defaultAnswer =
    opts.defaultAnswer ??
    'Use your best judgment — make the call you think fits this project best, document it in your reply, and proceed. Treat any open question as your call. No need to wait for further input.';
  const seenStructured = new Set<string>();
  let lastInlineRepliedToMessageAt: string | null = null;
  let stopped = false;

  function messageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) {
            const t = (part as { text?: unknown }).text;
            return typeof t === 'string' ? t : '';
          }
          return '';
        })
        .join('');
    }
    return '';
  }

  async function answerStructured(): Promise<void> {
    const { questions } = await opts.client.listQuestions({ pending: true });
    for (const q of questions) {
      if (seenStructured.has(q.id)) continue;
      seenStructured.add(q.id);
      // Surface the question prompt in the log so the postmortem can read
      // it without cross-referencing session JSONs. Truncate aggressively
      // — full markdown bodies blow past readable log-line width and the
      // first ~80 chars carry the intent in practice.
      const promptPreview =
        q.prompt.length > 80
          ? `${q.prompt.slice(0, 80).replace(/\s+/g, ' ')}…`
          : q.prompt.replace(/\s+/g, ' ');
      const choices = q.choices ?? [];
      const npmDecisions = npmInstallAutoDecisions(q.intent);
      if (npmDecisions) {
        await opts.client.answerQuestion(q.id, { npmInstallDecisions: npmDecisions });
        opts.log(
          `[auto-answer] structured ${q.id} (${q.gezelId}/${q.projectId}) "${promptPreview}" → npm decisions (${npmDecisions
            .map((d) => `${d.package}@${d.version}:${d.decision}`)
            .join(', ')})`,
        );
        continue;
      }
      const repoSourceAnswer = repoSourceAutoAnswerText(q.prompt, choices);
      if (repoSourceAnswer) {
        await opts.client.answerQuestion(q.id, { writeIn: repoSourceAnswer });
        opts.log(
          `[auto-answer] structured ${q.id} (${q.gezelId}/${q.projectId}) "${promptPreview}" → write-in (repo-source)`,
        );
        continue;
      }
      const workspaceFixtureAnswer = workspaceFixtureAutoAnswerText(q.prompt, choices);
      if (workspaceFixtureAnswer) {
        await opts.client.answerQuestion(q.id, { writeIn: workspaceFixtureAnswer });
        opts.log(
          `[auto-answer] structured ${q.id} (${q.gezelId}/${q.projectId}) "${promptPreview}" → write-in (workspace-fixture)`,
        );
        continue;
      }
      const projectContextAnswer = projectContextAutoAnswerText(q.prompt, choices);
      if (projectContextAnswer) {
        await opts.client.answerQuestion(q.id, { writeIn: projectContextAnswer });
        opts.log(
          `[auto-answer] structured ${q.id} (${q.gezelId}/${q.projectId}) "${promptPreview}" → write-in (project-context)`,
        );
        continue;
      }
      const permissionAnswer = permissionToProceedAutoAnswerText(q.prompt);
      if (permissionAnswer) {
        await opts.client.answerQuestion(q.id, { writeIn: permissionAnswer });
        opts.log(
          `[auto-answer] structured ${q.id} (${q.gezelId}/${q.projectId}) "${promptPreview}" → write-in (proceed-now)`,
        );
        continue;
      }
      if (choices.length > 0) {
        const pick = pickAutoAnswerChoice(choices, q.prompt);
        await opts.client.answerQuestion(q.id, { selectedChoices: [pick] });
        opts.log(
          `[auto-answer] structured ${q.id} (${q.gezelId}/${q.projectId}) "${promptPreview}" → choice[${pick}] = "${choices[pick]}"`,
        );
      } else {
        await opts.client.answerQuestion(q.id, { writeIn: defaultAnswer });
        opts.log(
          `[auto-answer] structured ${q.id} (${q.gezelId}/${q.projectId}) "${promptPreview}" → write-in (default)`,
        );
      }
    }
  }

  async function answerInline(): Promise<void> {
    // Look at the meester's most recent default-project session — that's
    // the one the trial drives. Other sessions belong to delegated work
    // and should not get user-impersonating replies (gezels handle their
    // own peer messaging via message_gezel).
    const { sessions } = await opts.client.listChatSessions({
      gezelId: opts.meesterId,
      projectId: 'default',
    });
    if (sessions.length === 0) return;
    // Pick the most recently active — there's usually only one.
    const summary = sessions
      .filter((s) => !s.archived)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    if (!summary) return;

    const session = await opts.client.getChatSession(summary.id);
    const last = session.messages[session.messages.length - 1];
    if (!last) return;
    if (last.role !== 'assistant') return;
    const text = messageText(last.content).trim();
    if (!text.endsWith('?')) return;
    if (lastInlineRepliedToMessageAt === last.at) return;

    // Idle gate: only respond if the meester has been quiet long enough
    // that we're confident she's actually waiting (not still streaming).
    const idleFor = Date.now() - new Date(last.at).getTime();
    if (idleFor < inlineIdleMs) return;

    const repoSourceAnswer = repoSourceAutoAnswerText(text);
    const workspaceFixtureAnswer = workspaceFixtureAutoAnswerText(text);
    const projectContextAnswer = projectContextAutoAnswerText(text);
    const answer =
      repoSourceAnswer ?? workspaceFixtureAnswer ?? projectContextAnswer ?? defaultAnswer;
    await opts.client.sendChatMessage(opts.meesterId, { message: answer, projectId: 'default' });
    lastInlineRepliedToMessageAt = last.at;
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    opts.log(
      `[auto-answer] inline meester (idle ${(idleFor / 1000).toFixed(0)}s, "${preview}") → ${
        answer === defaultAnswer
          ? 'default'
          : answer === repoSourceAnswer
            ? 'repo-source'
            : answer === workspaceFixtureAnswer
              ? 'workspace-fixture'
              : 'project-context'
      }`,
    );
  }

  async function run() {
    while (!stopped && !opts.signal?.aborted) {
      try {
        await answerStructured();
        await answerInline();
      } catch (err) {
        opts.log(`[auto-answer] poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
      const deadline = Date.now() + interval;
      while (Date.now() < deadline && !stopped && !opts.signal?.aborted) {
        await wait(Math.min(250, deadline - Date.now()));
      }
    }
  }

  const loop = run();

  return async () => {
    stopped = true;
    await loop;
  };
}
