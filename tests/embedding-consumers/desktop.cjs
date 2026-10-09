const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  // Electron main is commonly CommonJS; the SDK remains an external ESM import.
  const { createDesktopEmbedding } = await import('@bendyline/gezel-app-sdk/host');
  const modelId = 'llama-cpp:fixture';
  let starts = 0;
  let stops = 0;
  const host = createDesktopEmbedding({
    appId: 'consumer-fixture',
    appName: 'Consumer fixture',
    adoptUserDaemon: false,
    host: {
      home: path.resolve('private-ai'),
      serviceModule: {
        async startService(options) {
          starts++;
          assert.equal(options.embeddedInferenceOnly, true);
          return {
            port: 0,
            clientToken: 'fixture',
            cert: null,
            profile: 'embedded-inference',
            fetch: async (input) => {
              const pathname = new URL(typeof input === 'string' ? input : input.url).pathname;
              if (pathname === '/v1/models')
                return Response.json({
                  object: 'list',
                  data: [
                    {
                      id: modelId,
                      object: 'model',
                      created: 0,
                      owned_by: 'llama-cpp',
                      availability: 'available',
                    },
                  ],
                });
              return new Response(
                'data: {"choices":[{"delta":{"content":"consumer passed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              );
            },
            stop: async () => {
              stops++;
            },
          };
        },
      },
    },
  });
  const { GezelSdkError } = await import('@bendyline/gezel-app-sdk');
  await assert.rejects(
    host.models.list(),
    (error) => error instanceof GezelSdkError && error.code === 'disabled',
  );
  await host.setEnabled(true);
  assert.equal(starts, 0);
  assert.deepEqual(
    (await host.models.list()).map((model) => model.id),
    [modelId],
  );
  const reply = await host.streamText({
    model: modelId,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(reply.text, 'consumer passed');
  assert.equal(reply.cancelled, false);
  await host.close();
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  process.stdout.write('External Electron-main consumer passed\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
