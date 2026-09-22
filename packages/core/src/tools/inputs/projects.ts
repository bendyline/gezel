import { z } from 'zod';

export const UpdateProjectInputSchema = z
  .object({
    id: z.string().describe('Project id (from list_projects)'),
    name: z.string().optional(),
    description: z.string().optional(),
    voormanGezelId: z
      .string()
      .optional()
      .describe(
        'Gezel id that acts as voorman (foreman) of this project, or empty string to clear',
      ),
    about: z
      .string()
      .optional()
      .describe(
        "Replace the project's documents/about.md with this markdown. Flows into agent system prompts when a session is scoped to this project.",
      ),
    missionObjectives: z
      .string()
      .optional()
      .describe(
        "Replace the project's documents/missionObjectives.md. Also flows into system prompts.",
      ),
  })
  .strict();

/** Models often hand objectives over as a list; read it as the bullets they meant. */
export const MissionObjectivesInputSchema = z
  .preprocess(
    (value) => (Array.isArray(value) ? value.map((item) => `- ${String(item)}`).join('\n') : value),
    z.string().optional(),
  )
  .describe(
    'Concrete success criteria as a bullet list. What does "done" look like? If you can\'t name it, you can\'t ship it.',
  );

export const StartProjectInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(200)
      .describe('Human-readable name (e.g. "Space Invaders Browser Game").'),
    about: z
      .string()
      .optional()
      .describe(
        "A few paragraphs: who is this for, what's in scope, what's explicitly out of scope. " +
          "First thing any gezel joining reads — get it right or they'll guess wrong.",
      ),
    missionObjectives: MissionObjectivesInputSchema,
    taskDescription: z
      .string()
      .min(40)
      .optional()
      .describe(
        'Job-to-be-done for the kickoff task — what does success look like for the lead? Drives their first move. Distinct from `about` (overall scope) and `missionObjectives` (overall success).',
      ),
    taskTitle: z
      .string()
      .optional()
      .describe('Title for the kickoff task. Defaults to "Build <name>".'),
    kickoffMessage: z
      .string()
      .optional()
      .describe(
        'Optional note from you to the lead — folded into the kickoff task description they read in their task-scoped session. Defaults to the mission-derived brief alone.',
      ),
  })
  .strict();
