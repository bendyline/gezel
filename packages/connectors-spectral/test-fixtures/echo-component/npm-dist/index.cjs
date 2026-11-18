// Test fixture: shaped like a published @prismatic-io/components-* entry.
const spectral = require('@prismatic-io/spectral');
const spectralHttp = require('@prismatic-io/spectral/http');

const apiKeyConnection = spectral.connection({
  key: 'apiKey',
  display: { label: 'API key', description: 'A key for the echo service.' },
  inputs: {
    apiKey: { label: 'API key', type: 'password', required: true, shown: true },
  },
});

const connectionInput = spectral.input({ label: 'Connection', type: 'connection', required: true });
const baseUrl = spectral.input({
  label: 'Base URL',
  type: 'string',
  required: true,
  comments: 'Where the echo service listens.',
});
const page = spectral.input({ label: 'Page', type: 'string', required: false });

const client = (connection, base) =>
  spectralHttp.createClient({
    baseUrl: base,
    headers: { Authorization: `Bearer ${connection.fields.apiKey}` },
  });

const listItems = spectral.action({
  display: { label: 'List items', description: 'One page of items.' },
  inputs: { connection: connectionInput, baseUrl, page },
  perform: async (context, params) => {
    const { data } = await client(params.connection, params.baseUrl).get('/items', {
      params: params.page ? { page: params.page } : {},
    });
    context.logger.info(`listed ${data.items.length} items`);
    return { data: data.items, next: data.next };
  },
});

// Misbehaves on purpose: hands back, logs and throws the credential.
const revealKey = spectral.action({
  display: { label: 'Reveal key', description: 'Returns the key it was given.' },
  inputs: {
    connection: connectionInput,
    fail: spectral.input({
      label: 'Fail',
      type: 'boolean',
      required: false,
      clean: (v) => v === true || v === 'true',
    }),
  },
  perform: async (context, params) => {
    context.logger.warn(`using ${params.connection.fields.apiKey}`);
    if (params.fail) throw new Error(`the key ${params.connection.fields.apiKey} was rejected`);
    return { data: { key: params.connection.fields.apiKey } };
  },
});

const changes = spectral.pollingTrigger({
  display: { label: 'Changes', description: 'Items changed since the last poll.' },
  inputs: { connection: connectionInput, baseUrl },
  batchConfig: { batchSize: 2 },
  triggerResolver: {
    resolveItems: (_context, { payload }) => payload.body.data.items,
    getNextPaginationState: (_context, { payload }) => payload.paginationState ?? null,
  },
  perform: async (context, payload, params) => {
    const state = context.polling.getState() ?? {};
    const incoming = payload.paginationState;
    const { data } = await client(params.connection, params.baseUrl).get('/changes', {
      params: { since: state.since ?? '0', ...(incoming ? { cursor: incoming.cursor } : {}) },
    });
    const done = !data.cursor;
    if (done) context.polling.setState({ since: data.now });
    return {
      payload: {
        ...payload,
        paginationState: done ? undefined : { cursor: data.cursor },
        body: { data: { items: data.items } },
      },
      polledNoChanges: data.items.length === 0 && done,
    };
  },
});

const definition = spectral.component({
  key: 'gezel-echo',
  public: true,
  display: {
    label: 'Echo',
    description: 'A test component.',
    iconPath: 'icon.png',
    category: 'Testing',
  },
  actions: { listItems, revealKey },
  triggers: { changes },
  connections: [apiKeyConnection],
});

module.exports = spectral.callableComponent(definition);
