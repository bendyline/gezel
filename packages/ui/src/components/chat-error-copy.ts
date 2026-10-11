/**
 * Detect "the engine has no such model" across the several spellings the
 * layers below produce, and recover the model id for the message.
 *
 * The service humanizes this case at its source now, but the shapes below can
 * still reach a user: an older machine engine on the far side of an upgrade, a
 * broker rejection surfaced by a path that stringifies rather than rethrows, or
 * the `/v1` model-not-installed error. A raw `HTTP 404
 * {"error":"model_not_loaded",…}` on a failed turn is the exact failure this
 * defends against — the user cannot act on a status code.
 *
 * Returns the model id, `''` when the shape matched but carried no id, or
 * `undefined` when this isn't a missing-model error at all.
 */
function missingModelFromError(raw: string): string | undefined {
  const loaded = /"error"\s*:\s*"model_not_loaded"/.test(raw) || /model_not_loaded/.test(raw);
  const notInstalled = /is not available locally for provider/i.test(raw);
  const notFound = /"error"\s*:\s*"model_not_found"/.test(raw);
  if (!loaded && !notInstalled && !notFound) return undefined;
  const fromJson = /"model"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  const fromQuoted = /Model\s+"([^"]+)"/i.exec(raw)?.[1];
  const id = fromJson ?? fromQuoted ?? '';
  // Broker ids arrive engine-namespaced (`llama-cpp:qwen3.6-27b-q8`); users
  // recognize the model half, which is what every picker shows them.
  const separator = id.indexOf(':');
  return separator === -1 ? id : id.slice(separator + 1);
}

/**
 * Translate raw provider errors into something a user can act on. The
 * Copilot SDK surfaces `session.idle` timeouts as a ~60-character
 * technical string; when that fires after the model streamed nothing,
 * the most helpful thing we can say is "retry." A model the engine
 * cannot serve gets named plainly with the fix. Other errors pass
 * through untouched so bugs stay visible.
 *
 * Display only: callers keep the raw string for classification and reports.
 */
export function humanizeChatError(raw: string): string {
  if (!raw) return raw;
  const unavailableModel = missingModelFromError(raw);
  if (unavailableModel !== undefined) {
    const named = unavailableModel ? `"${unavailableModel}" ` : '';
    return `The model ${named}isn't available on this device — it may never have finished downloading. Pick a model that is installed, or download this one, in Settings → Artificial Intelligence.`;
  }
  if (/Timeout\s+after\s+\d+ms\s+waiting\s+for\s+session\.idle/i.test(raw)) {
    return (
      'Copilot stalled without streaming a reply — this usually means ' +
      'the SDK lost its connection. Your message is saved; try Send ' +
      'again, or pick a different model in Settings → Defaults.'
    );
  }
  if (/timed out after \d+s/i.test(raw)) {
    return "The model didn't respond in time. Your message is saved — try " + 'Send again.';
  }
  return raw;
}
