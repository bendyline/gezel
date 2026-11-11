/**
 * Where other programs reach Gezel's models. The service binds these
 * addresses and the command line prints them, so the ports and the rule for
 * a container's address live here once.
 */

/** Ollama's well-known port: the fixed, plain-HTTP, no-key listener a person can switch on. */
export const OLLAMA_EMULATION_PORT = 11434;

/** The port a Gezel container answers on, beside a desktop install's 6228 on the same host. */
export const DEFAULT_CONTAINER_PORT = 6230;

/**
 * The address people outside a container reach it at: `GEZEL_PUBLIC_URL`
 * when the container was told one, else localhost on the container's port.
 * `boundPort` is the port the listener actually took, when the caller is the
 * service that bound it.
 */
export function containerPublicBase(
  env: { GEZEL_PUBLIC_URL?: string | undefined; GEZEL_CONTAINER_PORT?: string | undefined },
  boundPort?: number | null,
): string {
  const told = env.GEZEL_PUBLIC_URL?.replace(/\/+$/, '');
  if (told) return told;
  const asked = Number.parseInt(env.GEZEL_CONTAINER_PORT ?? '', 10);
  const port =
    boundPort ??
    (Number.isInteger(asked) && asked > 0 && asked < 65536 ? asked : DEFAULT_CONTAINER_PORT);
  return `http://localhost:${port}`;
}

/** The no-key addresses the Ollama emulation serves while it is on. */
export function ollamaEmulationAddresses(): { openai: string; ollama: string } {
  const origin = `http://127.0.0.1:${OLLAMA_EMULATION_PORT}`;
  return { openai: `${origin}/v1`, ollama: origin };
}
