/**
 * Keep ONNX Runtime's own telemetry off.
 *
 * onnxruntime-node 1.30 carries Microsoft's 1DS uploader on macOS and Linux.
 * The first session it opens queues events naming the machine model, the OS, a
 * device GUID and a hashed hardware id for `mobile.events.data.microsoft.com`,
 * in `~/Library/Application Support/Microsoft/DeveloperTools/.onnxruntime/`
 * (2026-10-27 npm ship audit). Gezel loads ORT for embeddings, relevance, face
 * and media search and speech, so every install that used any of them had it.
 *
 * ORT reads `ORT_DISABLE_TELEMETRY` with `getenv()` when it first initializes
 * and keeps the answer for the life of the process. So this must run before the
 * first session, and on the main thread: a worker's `process.env` is a private
 * copy native code never sees. Set here, it reaches the real environment, which
 * every worker and child process started afterwards shares. Hosts call it at
 * start; each loader and worker spawn calls it too, for library callers that
 * never start a host. Windows builds report through ETW instead, which ignores
 * the variable and follows the person's Windows diagnostic-data setting.
 *
 * A value someone set explicitly is left alone.
 */
export const ORT_DISABLE_TELEMETRY_ENV = 'ORT_DISABLE_TELEMETRY';

export function disableOnnxRuntimeTelemetry(env: NodeJS.ProcessEnv = process.env): void {
  if (!env[ORT_DISABLE_TELEMETRY_ENV]) env[ORT_DISABLE_TELEMETRY_ENV] = '1';
}
