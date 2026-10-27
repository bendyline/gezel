/**
 * The starting `gezel.md` and `about.md` the Store writes when it creates a
 * gezel without them, plus the id seed its voice pick uses.
 */

import type { GezelCharacter, GezelFrontmatter, GezelGender } from '@bendyline/gezel';

export function defaultAboutMarkdown(role?: string): string {
  const roleDescription = role?.trim() ? ` for the "${role.trim()}" role` : '';
  return `# About this role

Write a few paragraphs describing the responsibilities${roleDescription}, the expertise the work requires, how to approach the work, and anything a task runner should know. Write in the second person and do not add a name, pronouns, gender, or backstory. This content is injected into the system prompt whenever a task uses this gezel.
`;
}

export function stringSeed(s: string): number {
  // djb2 — same family as the poppetje seed helper, kept local to
  // avoid pulling a stringHash export into core just for this. Returns
  // a 32-bit unsigned int.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function defaultAgentMarkdown(params: {
  id: string;
  name: string;
  description?: string;
  role?: string;
  roleBasedName?: string;
  gender?: GezelGender;
  voice?: string;
  /** Seeded from the id at creation (or a template's default) and persisted. */
  character?: GezelCharacter;
  model?: string;
  templateId?: string;
  templateVersion?: string;
  /**
   * Frontmatter the template wants merged in. `fixedFunction` is the
   * legacy non-scalar passthrough; `tuningProfile`, `tuning`,
   * `reasoningEffort`, and `provider` flow from gezel-template
   * manifests (e.g. Builder template declares
   * `frontmatter.tuningProfile: 'thinking-coding'`). Until this
   * function rendered them, the resolver at
   * `manager.ts:resolveTuning` saw `gezel.parsed.frontmatter.tuningProfile`
   * as undefined — the entire profile workstream was a no-op.
   * When `fixedFunction` is set we still skip the LLM-shaped
   * sections — the gezel has no system prompt.
   */
  extraFrontmatter?: Partial<GezelFrontmatter>;
}): string {
  const ff = params.extraFrontmatter?.fixedFunction;
  const tuningProfile = params.extraFrontmatter?.tuningProfile;
  const suggestedTuningProfile = params.extraFrontmatter?.suggestedTuningProfile;
  const tuning = params.extraFrontmatter?.tuning;
  const reasoningEffort = params.extraFrontmatter?.reasoningEffort;
  const factualWriting = params.extraFrontmatter?.factualWriting;
  const provider = params.extraFrontmatter?.provider;
  const frontmatter = [
    '---',
    `id: ${params.id}`,
    `name: ${JSON.stringify(params.name)}`,
    ...(params.description ? [`description: ${JSON.stringify(params.description)}`] : []),
    ...(params.role ? [`role: ${JSON.stringify(params.role)}`] : []),
    ...(params.roleBasedName ? [`roleBasedName: ${JSON.stringify(params.roleBasedName)}`] : []),
    ...(params.gender ? [`gender: ${JSON.stringify(params.gender)}`] : []),
    ...(params.voice ? [`voice: ${JSON.stringify(params.voice)}`] : []),
    ...(params.character ? [`character: ${JSON.stringify(params.character)}`] : []),
    ...(params.model ? [`model: ${params.model}`] : []),
    ...(provider ? [`provider: ${JSON.stringify(provider)}`] : []),
    ...(params.templateId ? [`templateId: ${JSON.stringify(params.templateId)}`] : []),
    ...(params.templateVersion
      ? [`templateVersion: ${JSON.stringify(params.templateVersion)}`]
      : []),
    ...(tuningProfile ? [`tuningProfile: ${JSON.stringify(tuningProfile)}`] : []),
    ...(suggestedTuningProfile
      ? [`suggestedTuningProfile: ${JSON.stringify(suggestedTuningProfile)}`]
      : []),
    ...(reasoningEffort ? [`reasoningEffort: ${JSON.stringify(reasoningEffort)}`] : []),
    ...(factualWriting !== undefined ? [`factualWriting: ${factualWriting}`] : []),
    ...(tuning ? [`tuning: ${JSON.stringify(tuning)}`] : []),
    ...(ff
      ? [
          'fixedFunction:',
          `  tool: ${JSON.stringify(ff.tool)}`,
          `  promptKey: ${JSON.stringify(ff.promptKey ?? 'prompt')}`,
          ...(ff.defaults && Object.keys(ff.defaults).length > 0
            ? [`  defaults: ${JSON.stringify(ff.defaults)}`]
            : []),
        ]
      : []),
    '---',
  ].join('\n');
  if (ff) {
    return `${frontmatter}\n`;
  }
  return `${frontmatter}

## Instructions {[instruction]}

You are a helpful agent. Describe how you should behave here.

## Memory {[memory]}

(Long-term facts the agent should remember go here.)

## Output Format {[output]}

(Describe the expected output format here.)
`;
}
