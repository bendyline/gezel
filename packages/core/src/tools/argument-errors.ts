import { z } from 'zod';

/**
 * A tool's argument rejection, in words a small model can act on. Handed Zod's
 * issue list, Qwen 3.5 2B apologized and rewrote a `write_artifact` call as
 * prose instead of retrying without the one extra key (Galaxy S20 FE,
 * 2026-09-26). The accepted keys are listed only when the keys were the
 * problem. Told every key after a bad optional value, Gemini Nano sent all of
 * them back, two with no value at all (Galaxy S26+, 2026-10-02), so a bad
 * optional value is answered with leaving it out.
 */
export function describeToolArgumentError(
  tool: string,
  error: z.ZodError,
  schema?: z.ZodType,
): string {
  const shape =
    schema instanceof z.ZodObject ? (schema.shape as Record<string, z.ZodType>) : undefined;
  const isOptional = (key: string) => shape?.[key]?.safeParse(undefined).success === true;
  let keysWrong = false;
  const omit = new Set<string>();
  const problems = error.issues.map((issue) => {
    const at = issue.path.join('.');
    const top = issue.path[0];
    const missing = issue.code === 'invalid_type' && /received undefined/.test(issue.message);
    if (issue.code === 'unrecognized_keys' || missing) keysWrong = true;
    else if (typeof top === 'string' && isOptional(top)) omit.add(top);
    if (issue.code === 'unrecognized_keys')
      return `does not take ${issue.keys.map((key) => `\`${key}\``).join(', ')}`;
    if (issue.code === 'invalid_type' && at)
      return missing ? `needs \`${at}\`` : `needs \`${at}\` to be ${issue.expected}`;
    return at ? `\`${at}\`: ${issue.message}` : issue.message;
  });
  const omitted = [...omit].map((key) => `\`${key}\``);
  const leaveOut = omitted.length
    ? ` Leave out ${omitted.join(' and ')}: ${omitted.length === 1 ? 'it is' : 'they are'} optional.`
    : '';
  const accepted =
    keysWrong && shape
      ? Object.keys(shape).map((key) => `${key}${isOptional(key) ? '?' : ''}`)
      : [];
  const takes = accepted.length ? ` It takes: ${accepted.join(', ')} (? is optional).` : '';
  return `${tool} ${[...new Set(problems)].join('; ')}.${leaveOut}${takes} Call it again with corrected arguments.`;
}
