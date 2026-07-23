import type { ChatManager } from '../chat/manager.js';

/**
 * Draft an `about.md` and `missionObjectives.md` for a freshly-linked
 * GitHub repo, so the New Project dialog can pre-fill those fields
 * from the repo's README rather than asking the user to write
 * paragraphs from scratch. Returns deterministic shape: two markdown
 * strings that comfortably exceed the 60- / 40-char minimums the
 * project schema enforces.
 *
 * The single one-shot prompt asks for both sections inside one
 * response, separated by a known delimiter, so we pay one LLM
 * round-trip rather than two. Falls back to a minimal stub if
 * parsing fails — better to populate something the user can edit
 * than to leave the dialog blank.
 */

const SECTION_DELIMITER = '---MISSION_OBJECTIVES---';

export interface ProjectAboutInput {
  name: string;
  repoUrl: string;
  description?: string;
  topics?: string[];
  /** README contents, already truncated by the repo-preview fetcher. */
  readme: string;
}

export async function generateProjectAboutFromRepo(
  manager: ChatManager,
  input: ProjectAboutInput,
): Promise<{ about: string; missionObjectives: string }> {
  const prompt = buildPrompt(input);
  const raw = await manager.oneShotCompletion(prompt, 120_000, {
    useKlerk: true,
    jobLabel: `project-about · ${input.name}`,
  });
  const parsed = parseSections(raw);
  if (parsed) return parsed;
  return fallback(input);
}

function buildPrompt(input: ProjectAboutInput): string {
  const lines: string[] = [
    `Draft two short markdown documents for a software project named "${input.name}".`,
    '',
    'Source material:',
    `- GitHub URL: ${input.repoUrl}`,
  ];
  if (input.description && input.description.trim().length > 0) {
    lines.push(`- One-liner: ${input.description.trim()}`);
  }
  if (input.topics && input.topics.length > 0) {
    lines.push(`- Topics: ${input.topics.join(', ')}`);
  }
  lines.push('');
  if (input.readme && input.readme.trim().length > 0) {
    lines.push('README excerpt (may be truncated):');
    lines.push('```');
    lines.push(input.readme.trim());
    lines.push('```');
  } else {
    lines.push('No README content was retrievable; rely on the URL/topics/description above.');
  }
  lines.push(
    '',
    'Produce TWO sections separated by a single line containing exactly:',
    SECTION_DELIMITER,
    '',
    'Before the delimiter — the **About** section:',
    '- 2-4 short paragraphs (60-300 words total).',
    "- Cover: who this project is for, what problem it solves, what's in scope, what's explicitly out of scope.",
    '- Plain prose, no headings, no bullet points. Read like the first thing a new contributor reads to orient themselves.',
    '- Do not invent specifics not implied by the source material. If the README is thin, lean on broad framing rather than fabricated details.',
    '',
    'After the delimiter — the **Mission objectives** section:',
    '- A bullet list of concrete success criteria (5-10 bullets, 40-300 words total).',
    '- Each bullet starts with `- ` and is one sentence.',
    '- Frame each as something measurable or observable — what does "done" look like for this project? What are we building toward?',
    '- Avoid generic platitudes ("write good code"); prefer concrete capabilities or outcomes.',
    '',
    'Return ONLY the two sections and the delimiter. No preamble, no closing remarks, no code fences.',
  );
  return lines.join('\n');
}

function parseSections(raw: string): { about: string; missionObjectives: string } | null {
  const stripped = stripFences(raw).trim();
  const idx = stripped.indexOf(SECTION_DELIMITER);
  if (idx < 0) return null;
  const about = stripped.slice(0, idx).trim();
  const mission = stripped.slice(idx + SECTION_DELIMITER.length).trim();
  if (about.length < 60) return null;
  if (mission.length < 40) return null;
  return { about, missionObjectives: mission };
}

function stripFences(text: string): string {
  const fenceMatch = text.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch && fenceMatch[1] !== undefined) return fenceMatch[1];
  return text;
}

/**
 * Last-resort placeholder so the dialog never lands with empty fields
 * after a "successful" preview. The user can rewrite freely; we just
 * need to clear the schema's min-length floor (60 / 40 chars).
 */
function fallback(input: ProjectAboutInput): { about: string; missionObjectives: string } {
  const desc = input.description?.trim();
  const about = desc
    ? `${input.name} — ${desc}. Sourced from ${input.repoUrl}. Replace this placeholder with a real description of who the project is for and what's in and out of scope.`
    : `${input.name} is a project linked from ${input.repoUrl}. Replace this placeholder with a real description of who the project is for, what problem it solves, and what's in and out of scope before kicking off work.`;
  const mission = [
    '- Define the first concrete deliverable that proves the idea.',
    '- Set criteria for what "done" looks like for an MVP.',
    '- Identify the audience or stakeholders who will judge success.',
    '- Note any constraints (deadline, platforms, dependencies) that bound the work.',
  ].join('\n');
  return { about, missionObjectives: mission };
}
