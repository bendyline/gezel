import type {
  CreateInputStagingRequest,
  CreateInputStagingResponse,
  InputStagingFileResponse,
  TaskInputPreviewRequest,
  TaskInputPreviewResponse,
} from '@bendyline/gezel';
import { GezelApiError, describeTransportError } from './api-error.js';

/**
 * Craftbook inputs before launch: a dry-run of a source (what a launch would
 * pick up, or the message it would fail with) and the upload staging area
 * for files the user picks from their own computer. Reached as
 * `client.taskInputs`. See docs/craftbook-inputs.md.
 */
export class TaskInputsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async send<T>(
    method: string,
    path: string,
    body: { json: unknown } | { bytes: Blob | Uint8Array } | null,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body && 'json' in body ? { 'Content-Type': 'application/json' } : {}),
          ...(body && 'bytes' in body ? { 'Content-Type': 'application/octet-stream' } : {}),
        },
        ...(body ? { body: 'json' in body ? JSON.stringify(body.json) : body.bytes } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const message = describeTransportError(error);
      throw new GezelApiError(
        `Gezel API transport unavailable on ${method} ${path}: ${message}`,
        0,
        {
          kind: 'transport',
          cause: message,
        },
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let details: unknown = text || undefined;
      try {
        details = JSON.parse(text);
      } catch {
        /* plain-text body */
      }
      throw new GezelApiError(
        `Gezel API error ${res.status} on ${method} ${path}`,
        res.status,
        details,
      );
    }
    return (await res.json()) as T;
  }

  private projectPath(projectId: string, rest: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}${rest}`;
  }

  /** What a launch would pick up from this source, or why it would refuse it. */
  previewTaskInput(
    projectId: string,
    req: TaskInputPreviewRequest,
  ): Promise<TaskInputPreviewResponse> {
    return this.send('POST', this.projectPath(projectId, '/tasks/input-preview'), { json: req });
  }

  /** Open an upload staging area; the response carries the input's limits. */
  createInputStaging(
    projectId: string,
    req: CreateInputStagingRequest,
  ): Promise<CreateInputStagingResponse> {
    return this.send('POST', this.projectPath(projectId, '/input-staging'), { json: req });
  }

  /**
   * Upload one file as a raw body the daemon streams to disk. `relPath` keeps
   * the picked folder's structure. A 413 carries the limit hit in
   * `details.reason`.
   */
  uploadInputStagingFile(
    projectId: string,
    stagingId: string,
    relPath: string,
    data: Blob | ArrayBuffer | Uint8Array,
    signal?: AbortSignal,
  ): Promise<InputStagingFileResponse> {
    const bytes = data instanceof Blob || data instanceof Uint8Array ? data : new Uint8Array(data);
    const path = this.projectPath(
      projectId,
      `/input-staging/${encodeURIComponent(stagingId)}/file?path=${encodeURIComponent(relPath)}`,
    );
    return this.send('PUT', path, { bytes }, signal);
  }

  /** Drop a staging area — the launcher was closed or the pick replaced. */
  deleteInputStaging(projectId: string, stagingId: string): Promise<{ ok: true }> {
    const path = this.projectPath(projectId, `/input-staging/${encodeURIComponent(stagingId)}`);
    return this.send('DELETE', path, null);
  }
}
