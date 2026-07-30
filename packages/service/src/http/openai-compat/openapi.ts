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
import { APP_GRANTABLE_SCOPES } from '../token-store.js';

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
            'the app polls `GET /v1/apps/grant/:id` until decided. Grants with stateful ' +
            'authority return a short verification code that the requesting app must show ' +
            'to the user; the user types it into the desktop consent dialog. When ' +
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
      '/v1/apps/grant/{grantId}/approve': {
        parameters: [{ name: 'grantId', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Approve a pending app grant.',
          description:
            'Requires a first-party root or UI token. When registration returned ' +
            '`verificationRequired: true`, the requester-visible code is required in the body.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GrantApprovalRequest' },
              },
            },
          },
          responses: {
            '200': { description: 'Approved.' },
            '400': { description: 'Verification code required or malformed request.' },
            '403': { description: 'Incorrect verification code.' },
            '404': { description: 'Unknown grant id.' },
            '409': { description: 'Grant already decided.' },
            '410': { description: 'Grant expired.' },
            '429': { description: 'Five incorrect codes; grant expired.' },
          },
        },
      },
      '/v1/apps': {
        get: {
          summary: 'List connected apps and grants.',
          description: 'Requires a first-party root or UI scope. Drives Connected Apps settings.',
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
      '/v1/models/{id}': {
        get: {
          summary: 'Retrieve one model entry by its qualified id.',
          security: [{ bearerAuth: ['openai'] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The model entry.' },
            '404': { description: 'Unknown model id.' },
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
            scopes: {
              type: 'array',
              items: {
                type: 'string',
                enum: [...APP_GRANTABLE_SCOPES],
              },
              minItems: 1,
              maxItems: 16,
            },
            requireVerificationCode: {
              type: 'boolean',
              description:
                'Require requester-code verification even when every requested scope is inference-only.',
            },
            iconUrl: { type: 'string', format: 'uri' },
          },
        },
        RegisterResponse: {
          type: 'object',
          required: ['grantRequestId', 'status'],
          properties: {
            grantRequestId: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'approved', 'denied', 'expired'] },
            token: { type: 'string', description: 'Present when status="approved".' },
            verificationRequired: {
              type: 'boolean',
              description: 'True when approval requires the requester-visible code.',
            },
            verificationCode: {
              type: 'string',
              pattern: '^[2-9A-HJ-KM-NP-TV-Z]{3}-[2-9A-HJ-KM-NP-TV-Z]{3}$',
              description:
                'Present only in this registration response. Show it in the requesting app.',
            },
          },
        },
        GrantApprovalRequest: {
          type: 'object',
          properties: {
            verificationCode: {
              type: 'string',
              description: 'Code shown by the requesting app, when required.',
            },
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
                  role: {
                    type: 'string',
                    enum: ['system', 'developer', 'user', 'assistant', 'tool'],
                  },
                  content: { type: 'string' },
                  name: { type: 'string' },
                  tool_calls: { type: 'array', items: { type: 'object' } },
                  tool_call_id: { type: 'string' },
                },
              },
            },
            stream: { type: 'boolean' },
            stream_options: {
              type: 'object',
              properties: { include_usage: { type: 'boolean' } },
            },
            tools: {
              type: 'array',
              description:
                'OpenAI function-tool definitions. Advertised to the model but not executed; captured calls return with finish_reason=tool_calls. Rejected with 400 for providers without external-tools support.',
              items: { type: 'object' },
            },
            tool_choice: {
              description:
                'String forms (auto / required / none) are honored via the tuning layer. The function-pinning object form is rejected with 400.',
            },
            response_format: {
              type: 'object',
              description:
                'json_object and json_schema are honored via the tuning layer (llama.cpp json_schema, OpenAI strict mode). Copilot/CLI backends ignore tuning.',
            },
            temperature: {
              type: 'number',
              minimum: 0,
              maximum: 2,
              description:
                'Overlaid onto the model’s resolved tuning as the topmost layer. Applied by tuning-consuming providers (local engines, OpenAI, Anthropic); Copilot/CLI backends ignore it.',
            },
            max_tokens: {
              type: 'integer',
              minimum: 1,
              description:
                'Output cap, overlaid onto resolved tuning. `max_completion_tokens` wins when both are sent. Reaching the cap reports finish_reason=length.',
            },
            max_completion_tokens: { type: 'integer', minimum: 1 },
            top_p: { type: 'number', minimum: 0, maximum: 1 },
            presence_penalty: { type: 'number', minimum: -2, maximum: 2 },
            frequency_penalty: { type: 'number', minimum: -2, maximum: 2 },
            seed: { type: 'integer' },
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
                      tool_calls: { type: 'array', items: { type: 'object' } },
                    },
                  },
                  finish_reason: { type: 'string', enum: ['stop', 'tool_calls', 'length'] },
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
