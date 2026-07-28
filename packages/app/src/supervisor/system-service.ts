/**
 * Compatibility barrel for the supervisor. The shared implementation lives
 * in the Node client package so Electron and the CLI use exactly the same
 * platform paths, TLS metadata, and runtime-file parsing.
 */
export {
  readSystemServiceEndpoint,
  readSystemServiceRuntime,
  systemServiceHome,
} from '@bendyline/gezel-client/node';
export type {
  SystemServiceEndpoint,
  SystemServiceRuntime,
} from '@bendyline/gezel-client/node';
