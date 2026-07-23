/**
 * Hand-authored OpenAPI 3.1 schema for the public `/v1/*` surface.
 *
 * Generating from Zod would be lovely but the existing route schemas
 * are inline rather than registered under a Zod-to-OpenAPI converter,
 * and the public contract is small enough (5 endpoints in 4 groups)
 * that the hand-authored doc is easier to keep accurate as the surface
 * evolves than a converter wired across every route file.
 *
 * Served at `GET /v1/openapi.json` so third-party app authors can
 * point an OpenAPI viewer or codegen at it directly.
 */
export interface OpenApiDoc {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  paths: Record<string, unknown>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
}

export function buildOpenApiDoc(version: string): OpenApiDoc {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Gezel Public API',
      version,
      description:
        'OpenAI-compatible chat / embeddings / models facade plus gezel-specific consent ' +
        '(`/v1/apps/*`) and ensure-model (`/v1/models/ensure`) endpoints. Loopback only ' +
        '(`https://127.0.0.1:<port>`); auth via per-app bearer tokens issued through the ' +
        'consent flow.',
    },
    servers: [
      {
        url: 'https://127.0.0.1:{port}',
        description: 'Local gezel daemon. Port is per-launch (see `~/.gezel/runtime/port`).',
      },
    ],
    paths: {
      '/v1/apps/register': {
        post: {
          summary: 'Open a new consent request.',
          description:
            'Unauthenticated. The user sees a consent dialog in the gezel desktop app; ' +
            'the app polls `GET /v1/apps/grant/:id` until decided. When ' +
            '`GEZEL_AUTOAPPROVE_APPS` lists the appId, the response carries a token ' +
            'immediately and `status: "approved"`.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RegisterRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Grant request created.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RegisterResponse' },
                },
              },
            },
            '409': {
              description: 'App is already connected — rotate via DELETE first.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Error' } },
              },
            },
          },
        },
      },
      '/v1/apps/grant/{grantId}': {
        parameters: [
          { name: 'grantId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'wait',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 30 },
            description: 'Long-poll seconds. Returns earlier if the status flips.',
          },
        ],
        get: {
          summary: 'Poll for grant status (optionally long-poll).',
          description: 'Unauthenticated. When status="approved" the token is present.',
          responses: {
            '200': {
              description: 'Grant snapshot.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GrantPollResponse' },
                },
              },
            },
            '404': { description: 'Unknown grant id.' },
          },
        },
      },
      '/v1/apps/grant/{grantId}/events': {
        parameters: [{ name: 'grantId', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'SSE stream of grant status changes.',
          description: 'Unauthenticated. `data:` payloads are `GrantPollResponse` JSON objects.',
          responses: {
            '200': { description: 'event-stream' },
            '404': { description: 'Unknown grant id.' },
          },
        },
      },
      '/v1/apps': {
        get: {
          summary: 'List connected apps and grants.',
          description: 'Requires root scope. Drives the Settings → Connected Apps view.',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'App + grant roster.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AppsListResponse' },
                },
              },
            },
          },
        },
      },
      '/v1/apps/{appId}/token': {
        parameters: [{ name: 'appId', in: 'path', required: true, schema: { type: 'string' } }],
        delete: {
          summary: 'Revoke an app token (self-revoke or root admin).',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Revoked.' },
            '403': { description: 'Cross-app revocation without root scope.' },
            '404': { description: 'App not found.' },
          },
        },
      },
      '/v1/chat/completions': {
        post: {
          summary: 'OpenAI-compatible chat completion (streaming + non-streaming).',
          description:
            'Tool calling and structured outputs are not supported in v1 — requests carrying ' +
            '`tools`, `tool_choice`, or `response_format` return 400. Stream via Accept: ' +
            'text/event-stream + `stream: true` body field.',
          security: [{ bearerAuth: ['openai'] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Chat completion or SSE stream.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatCompletionResponse' },
                },
                'text/event-stream': { schema: { type: 'string' } },
              },
            },
            '400': { description: 'Bad request (tool calling / structured outputs).' },
            '404': { description: 'Unknown model.' },
          },
        },
      },
      '/v1/embeddings': {
        post: {
          summary: 'OpenAI-compatible embeddings.',
          security: [{ bearerAuth: ['openai'] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EmbeddingsRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Embeddings list.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/EmbeddingsResponse' },
                },
              },
            },
            '400': {
              description: 'Provider does not support embeddings or encoding_format not supported.',
            },
          },
        },
      },
      '/v1/models': {
        get: {
          summary: 'List available models across every configured provider.',
          security: [{ bearerAuth: ['openai'] }],
          responses: {
            '200': {
              description: 'Model list.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ModelListResponse' },
                },
              },
            },
          },
        },
      },
      '/v1/models/ensure': {
        post: {
          summary: 'Make sure a local model is downloaded and ready.',
          description:
            'Idempotent. `ready` → already installed; `downloading` → install job started ' +
            '(poll the job or subscribe via SSE).',
          security: [{ bearerAuth: ['openai'] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EnsureRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Already installed.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/EnsureResult' },
                },
              },
            },
            '202': {
              description: 'Install job started.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/EnsureResult' },
                },
              },
            },
            '400': { description: 'Ambiguous or no-source-for-backend.' },
            '404': { description: 'Unknown model.' },
          },
        },
      },
      '/v1/models/ensure/{jobId}': {
        parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Poll a job snapshot.',
          security: [{ bearerAuth: ['openai'] }],
          responses: {
            '200': { description: 'Snapshot.' },
            '404': { description: 'Unknown job id.' },
          },
        },
      },
      '/v1/models/ensure/{jobId}/events': {
        parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'SSE stream of install events.',
          security: [{ bearerAuth: ['openai'] }],
          responses: {
            '200': { description: 'event-stream' },
            '404': { description: 'Unknown job id.' },
          },
        },
      },
      '/v1/openapi.json': {
        get: {
          summary: 'This document.',
          responses: { '200': { description: 'OpenAPI 3.1 doc' } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Per-app token issued via `/v1/apps/register`, OR the per-launch root token ' +
            'from `~/.gezel/runtime/auth-token`.',
        },
      },
      schemas: {
        RegisterRequest: {
          type: 'object',
          required: ['appId', 'appName', 'scopes'],
          properties: {
            appId: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$', maxLength: 64 },
            appName: { type: 'string', maxLength: 120 },
            scopes: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
            iconUrl: { type: 'string', format: 'uri' },
          },
        },
        RegisterResponse: {
          type: 'object',
          required: ['grantRequestId', 'status'],
          properties: {
            grantRequestId: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'approved', 'denied'] },
            token: { type: 'string', description: 'Present when status="approved".' },
          },
        },
        GrantPollResponse: {
          type: 'object',
          required: ['id', 'status', 'appId', 'appName', 'scopes'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'approved', 'denied', 'expired'] },
            appId: { type: 'string' },
            appName: { type: 'string' },
            scopes: { type: 'array', items: { type: 'string' } },
            token: { type: 'string' },
          },
        },
        AppsListResponse: {
          type: 'object',
          required: ['apps', 'grants'],
          properties: {
            apps: { type: 'array', items: { type: 'object' } },
            grants: { type: 'array', items: { type: 'object' } },
          },
        },
        ChatCompletionRequest: {
          type: 'object',
          required: ['model', 'messages'],
          properties: {
            model: {
              type: 'string',
              description: 'Qualified `<provider>:<model>` or bare provider for default.',
            },
            messages: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                  content: { type: 'string' },
                  name: { type: 'string' },
                },
              },
            },
            stream: { type: 'boolean' },
            temperature: { type: 'number', minimum: 0, maximum: 2 },
            max_tokens: { type: 'integer', minimum: 1 },
          },
        },
        ChatCompletionResponse: {
          type: 'object',
          required: ['id', 'object', 'created', 'model', 'choices', 'usage'],
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['chat.completion'] },
            created: { type: 'integer' },
            model: { type: 'string' },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  message: {
                    type: 'object',
                    properties: {
                      role: { type: 'string', enum: ['assistant'] },
                      content: { type: 'string' },
                    },
                  },
                  finish_reason: { type: 'string', enum: ['stop'] },
                },
              },
            },
            usage: {
              type: 'object',
              properties: {
                prompt_tokens: { type: 'integer' },
                completion_tokens: { type: 'integer' },
                total_tokens: { type: 'integer' },
              },
            },
          },
        },
        EmbeddingsRequest: {
          type: 'object',
          required: ['model', 'input'],
          properties: {
            model: { type: 'string' },
            input: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' }, minItems: 1 },
              ],
            },
          },
        },
        EmbeddingsResponse: {
          type: 'object',
          required: ['object', 'data', 'model', 'usage', 'id'],
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  object: { type: 'string', enum: ['embedding'] },
                  index: { type: 'integer' },
                  embedding: { type: 'array', items: { type: 'number' } },
                },
              },
            },
            model: { type: 'string' },
            usage: {
              type: 'object',
              properties: {
                prompt_tokens: { type: 'integer' },
                total_tokens: { type: 'integer' },
              },
            },
            id: { type: 'string' },
          },
        },
        ModelListResponse: {
          type: 'object',
          required: ['object', 'data'],
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  object: { type: 'string', enum: ['model'] },
                  created: { type: 'integer' },
                  owned_by: { type: 'string' },
                },
              },
            },
          },
        },
        EnsureRequest: {
          type: 'object',
          required: ['model'],
          properties: {
            model: {
              type: 'string',
              description: 'Backend-qualified id: `<backend>:<catalogId>`.',
            },
          },
        },
        EnsureResult: {
          type: 'object',
          required: ['status', 'model_id'],
          properties: {
            status: { type: 'string', enum: ['ready', 'downloading'] },
            model_id: { type: 'string' },
            job_id: {
              type: 'string',
              description: 'Set when status="downloading".',
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    code: { type: 'string' },
                    type: { type: 'string' },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}
