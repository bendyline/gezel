/**
 * The `/v1/remote/*` wire contract now lives in core (`@bendyline/gezel/remote`)
 * so a phone compiles against the same schemas as the daemon. Re-exported here
 * so the service's own imports keep their paths.
 */
export * from '@bendyline/gezel/remote';
