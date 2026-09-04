import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAdvisories } from './audit-vulnerabilities-lib.mjs';

test('retries transient timeouts and preserves the request', async () => {
  const requests = [];
  const delays = [];
  const warnings = [];

  const advisories = await requestAdvisories(
    { example: ['1.2.3'] },
    {
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (requests.length < 3) throw new DOMException('timed out', 'TimeoutError');
        return new Response('{}', { status: 200 });
      },
      sleep: async (delayMs) => delays.push(delayMs),
      random: () => 0.5,
      warn: (message) => warnings.push(message),
    },
  );

  assert.deepEqual(advisories, []);
  assert.equal(requests.length, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(warnings.length, 2);
  for (const { url, init } of requests) {
    assert.equal(url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{"example":["1.2.3"]}');
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('retries transient HTTP responses', async () => {
  let attempts = 0;
  const advisories = await requestAdvisories(
    { example: ['1.2.3'] },
    {
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response('temporarily unavailable', { status: 503 })
          : new Response('{}', { status: 200 });
      },
      sleep: async () => {},
      warn: () => {},
    },
  );

  assert.deepEqual(advisories, []);
  assert.equal(attempts, 2);
});

test('does not retry caller or malformed-response failures', async () => {
  let attempts = 0;
  await assert.rejects(
    requestAdvisories(
      { example: ['1.2.3'] },
      {
        fetchImpl: async () => {
          attempts += 1;
          return new Response('bad request', { status: 400 });
        },
        sleep: async () => {},
        warn: () => {},
      },
    ),
    /HTTP 400/,
  );
  assert.equal(attempts, 1);

  await assert.rejects(
    requestAdvisories(
      { example: ['1.2.3'] },
      {
        fetchImpl: async () => new Response('[]', { status: 200 }),
        sleep: async () => {},
        warn: () => {},
      },
    ),
    /invalid response/,
  );
});

test('fails closed after exhausting transient retries', async () => {
  let attempts = 0;
  await assert.rejects(
    requestAdvisories(
      { example: ['1.2.3'] },
      {
        maxAttempts: 3,
        fetchImpl: async () => {
          attempts += 1;
          throw new TypeError('socket closed');
        },
        sleep: async () => {},
        warn: () => {},
      },
    ),
    /failed after 3 attempts: TypeError: socket closed/,
  );
  assert.equal(attempts, 3);
});

test('deduplicates and sorts advisory results', async () => {
  const duplicate = {
    id: 7,
    severity: 'moderate',
    title: 'example issue',
    url: 'https://example.test/advisory/7',
  };
  const advisories = await requestAdvisories(
    { alpha: ['1.0.0'], beta: ['2.0.0'] },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            alpha: [duplicate],
            beta: [
              { ...duplicate, name: 'alpha' },
              { id: 8, severity: 'critical', title: 'critical issue' },
            ],
          }),
          { status: 200 },
        ),
    },
  );

  assert.deepEqual(
    advisories.map(({ id, name, severity }) => ({ id, name, severity })),
    [
      { id: 8, name: 'beta', severity: 'critical' },
      { id: 7, name: 'alpha', severity: 'moderate' },
    ],
  );
});
