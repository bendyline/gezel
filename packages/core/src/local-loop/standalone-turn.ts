/** How many system messages lead a transcript. */
export function leadingSystemMessages(messages: readonly { role: string }[]): number {
  let systems = 0;
  while (systems < messages.length && messages[systems]!.role === 'system') systems++;
  return systems;
}

/**
 * The messages a standalone turn sends: the leading system messages (the
 * instructions, and the volatile band when the prompt is layered) and the
 * current turn from its user message on. The session's transcript is left
 * whole; only this request leaves the earlier conversation out.
 */
export function standaloneTurnMessages<T extends { role: string }>(
  messages: readonly T[],
  turnStart: number,
): T[] {
  const systems = leadingSystemMessages(messages);
  return [...messages.slice(0, systems), ...messages.slice(Math.max(systems, turnStart))];
}
