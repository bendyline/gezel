import type { ChatManager } from '../chat/manager.js';

/**
 * Generate an initial about.md draft for a new gezel based on their
 * role and, optionally, free-text context about why they're being
 * created. The name is intentionally NOT passed in — we want the
 * persona to come from the job title alone so it reads like a role
 * description, not a bio of a specific individual.
 *
 * When `context` is supplied (from the `ensureGezel` bespoke path),
 * the prompt weaves it in as situational framing so the new gezel
 * understands what their first assignment is about without the
 * persona hard-coding it.
 */
export async function generateGezelAbout(
  manager: ChatManager,
  role: string,
  context?: string,
): Promise<string> {
  const parts: string[] = [
    `Write an "about" document for an AI agent whose job is "${role}".`,
    '',
    "This document is injected into the agent's system prompt whenever they run a task,",
    'so it should shape how they think, speak, and work. It is NOT a bio of a specific person —',
    'do not give them a name, do not say "I am ___", and do not mention age, gender, or backstory.',
  ];
  if (context && context.trim().length > 0) {
    parts.push(
      '',
      `Context on why this agent is being created: ${context.trim()}`,
      'Use this to make the "Expertise" and "Working Style" sections concrete for the kind of work the agent will see — without locking the persona to this single project.',
    );
  }
  parts.push(
    '',
    'Requirements:',
    `- Write in the second person ("You are a ${role}..."). Address the agent directly.`,
    '- Structure with markdown headings: ## Identity, ## Expertise, ## Working Style, ## Preferences.',
    '- 200-400 words total, tightly written.',
    '- Concrete and specific to the role — avoid generic filler like "always do your best".',
    '- **Do NOT name specific tools, MCP tool names, or CLI commands** (no `write_artifact`, `writeFile`, `message_gezel`, `bash`, `curl`, etc.). The agent discovers its actual toolset separately from this document, and baking tool names here causes drift when tools rename or change semantics. Describe *intent* — "save your work so the team can pick it up", "hand off to the next gezel", "read the brief before you start" — and let the agent map that to the tools it has.',
    '- **Do NOT hard-wrap lines.** Each paragraph and each list item must be a single physical line — no inserting newlines in the middle of a sentence at ~72 or ~80 columns. The editor reflows long lines; hard wraps render as awkward extra paragraph breaks.',
    '- Return ONLY the markdown content. No code fences, no preamble, no closing remarks.',
  );

  const raw = await manager.oneShotCompletion(parts.join('\n'), 120_000, {
    useKlerk: true,
    jobLabel: `about · ${role}`,
  });
  const cleaned = stripFences(raw).trim();
  if (!cleaned) {
    throw new Error('About generation failed — the model returned no content.');
  }
  return cleaned;
}

function stripFences(text: string): string {
  // LLMs sometimes wrap markdown in ```markdown ... ``` despite being asked not to.
  const fenceMatch = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch && fenceMatch[1] !== undefined) return fenceMatch[1];
  return text;
}
