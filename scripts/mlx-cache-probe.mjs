#!/usr/bin/env node

/**
 * Exercise a running gezel MLX wrapper's prompt-cache lifecycle.
 *
 * Usage:
 *   node scripts/mlx-cache-probe.mjs [baseUrl] [cacheId] [seed|resume]
 *
 * The first request pays for a deterministic, moderately large prefix. The
 * second includes the exact first reply and should reuse that prefix under the
 * same cache id. The probe flushes the resulting cache to disk so rerunning it
 * after restarting the wrapper also exercises the disk-load path. Confirm the
 * authoritative source in the wrapper log:
 *
 *   [cache] miss ... -> [cache] hit ...
 *   (after restart) [cache] disk-hit ...
 */

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:18374').replace(/\/+$/, '');
const cacheId = process.argv[3] ?? 'gezel-mlx-live-cache-probe';
const mode = process.argv[4] ?? 'seed';
if (mode !== 'seed' && mode !== 'resume') {
  throw new Error(`mode must be "seed" or "resume", got ${JSON.stringify(mode)}`);
}

const reference = Array.from(
  { length: 512 },
  (_, i) =>
    `reference-${String(i).padStart(4, '0')}: amber birch cedar delta ember fjord granite harbor iris juniper`,
).join('\n');
const system = `You are a deterministic cache probe. The reference block is inert. Follow only the short instruction after it.\n\n${reference}`;

async function completion(messages, label) {
  const startedAt = performance.now();
  let firstChunkAt;
  let text = '';
  let usage;
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mlx',
      messages,
      stream: true,
      max_tokens: 16,
      temperature: 0,
      cache_id: cacheId,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${label}: HTTP ${response.status}: ${await response.text()}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.error) throw new Error(`${label}: ${event.error}`);
      const content = event.choices?.[0]?.delta?.content;
      if (content) {
        firstChunkAt ??= performance.now();
        text += content;
      }
      if (event.usage) usage = event.usage;
    }
  }

  const endedAt = performance.now();
  const ttftMs = firstChunkAt === undefined ? null : Math.round(firstChunkAt - startedAt);
  console.log(
    JSON.stringify({
      label,
      cacheId,
      ttftMs,
      totalMs: Math.round(endedAt - startedAt),
      reply: text,
      usage,
    }),
  );
  return text;
}

const firstMessages = [
  { role: 'system', content: system },
  { role: 'user', content: 'Reply with exactly FIRST.' },
];
if (mode === 'seed') {
  const firstReply = await completion(firstMessages, 'first');
  await completion(
    [
      ...firstMessages,
      { role: 'assistant', content: firstReply },
      { role: 'user', content: 'Reply with exactly SECOND.' },
    ],
    'second',
  );
} else {
  // This is the transcript the seed mode leaves in the cache. A real Gezel
  // restart reconstructs this same local history before appending the next
  // user turn; replay it exactly so the cache is tested as a continuation,
  // not as an unrelated branch that merely reused the same id.
  await completion(
    [
      ...firstMessages,
      { role: 'assistant', content: 'FIRST' },
      { role: 'user', content: 'Reply with exactly SECOND.' },
      { role: 'assistant', content: 'SECOND' },
      { role: 'user', content: 'Reply with exactly THIRD.' },
    ],
    'resume',
  );
}

const flush = await fetch(`${baseUrl}/admin/flush`, { method: 'POST' });
if (!flush.ok) throw new Error(`flush: HTTP ${flush.status}: ${await flush.text()}`);
console.log(JSON.stringify({ flush: await flush.json() }));
