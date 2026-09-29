import { z } from 'zod';

/**
 * A tool's argument rejection, in words a small model can act on. Handed Zod's
 * issue list, Qwen 3.5 2B apologized and rewrote a `write_artifact` call as
 * prose instead of retrying without the one extra key (Galaxy S20 FE,
 * 2026-09-26).
 */
export function describeToolArgumentError(
  tool: string,
  error: z.ZodError,
  schema?: z.ZodType,
): string {
  const problems = error.issues.map((issue) => {
    const at = issue.path.join('.');
    if (issue.code === 'unrecognized_keys')
      return `does not take ${issue.keys.map((key) => `\`${key}\``).join(', ')}`;
    if (issue.code === 'invalid_type' && at)
      return /received undefined/.test(issue.message)
        ? `needs \`${at}\``
        : `needs \`${at}\` to be ${issue.expected}`;
    return at ? `\`${at}\`: ${issue.message}` : issue.message;
  });
  const accepted =
    schema instanceof z.ZodObject
      ? Object.entries(schema.shape as Record<string, z.ZodType>).map(
          ([key, value]) => `${key}${value.safeParse(undefined).success ? '?' : ''}`,
        )
      : [];
  const takes = accepted.length ? ` It takes: ${accepted.join(', ')} (? is optional).` : '';
  return `${tool} ${[...new Set(problems)].join('; ')}.${takes} Call it again with corrected arguments.`;
}
