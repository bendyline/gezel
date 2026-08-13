/**
 * Keep every useful question-text field a model supplied. Some models use
 * `question` as a short heading and `prompt` or `description` for the actual
 * explanation; choosing the first alias made the user card cryptic.
 */
export function composeQuestionPrompt(parts: {
  question?: string;
  prompt?: string;
  description?: string;
}): string {
  const unique: string[] = [];
  for (const value of [parts.question, parts.prompt, parts.description]) {
    const trimmed = value?.trim();
    if (trimmed && !unique.includes(trimmed)) unique.push(trimmed);
  }
  return unique.join('\n\n');
}

/** Explicit tool input wins; otherwise inherit the task bound to the chat. */
export function resolveQuestionTaskRef(
  explicitTaskRef: string | undefined,
  sessionTaskRef: string,
): string | undefined {
  return explicitTaskRef ?? (sessionTaskRef.trim() || undefined);
}
