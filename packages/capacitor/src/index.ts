import { GezelSdkError } from '@bendyline/gezel-app-sdk/browser';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { GezelRuntimePlugin } from './definitions.js';
import { connectRuntime } from './transport.js';

export type { GezelRuntimePlugin } from './definitions.js';
export { connectRuntime } from './transport.js';
export const GezelRuntime = registerPlugin<GezelRuntimePlugin>('GezelRuntime');

/** Connect the ordinary App SDK client to this app's on-device runtime. */
export function connect() {
  if (!Capacitor.isNativePlatform())
    throw new GezelSdkError('An iOS or Android native host is required', {
      code: 'native_unavailable',
    });
  return connectRuntime(GezelRuntime);
}

export * from './model-manager.js';
export * from './embedding.js';
import { createRuntimeEmbedding } from './embedding.js';
/** Opt-in wrapper; construction and setEnabled(true) do not touch native services. */
export function createMobileEmbedding(options: Parameters<typeof createRuntimeEmbedding>[1] = {}) {
  return createRuntimeEmbedding(GezelRuntime, options);
}
export { selectModel } from '@bendyline/gezel-app-sdk/browser';
