import { CliError } from './connection.js';

export async function resolveRunPrompt(
  parts: string[] | undefined,
  input: AsyncIterable<string | Buffer> & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (parts?.length !== 1 || parts[0] !== '-') {
    const prompt = (parts ?? []).join(' ').trim();
    if (!prompt) throw new CliError('usage: gezel run "<prompt>" or gezel run -');
    return prompt;
  }

  if (input.isTTY) {
    throw new CliError('gezel run - requires piped input or a redirected file.');
  }

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (error) {
    throw new CliError(
      `Could not read prompt from stdin: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const prompt = Buffer.concat(chunks).toString('utf8');
  if (!prompt.trim())
    throw new CliError('gezel run - received empty input. Supply a prompt on stdin.');
  return prompt;
}
