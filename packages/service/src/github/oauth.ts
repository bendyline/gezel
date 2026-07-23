import { DEFAULT_GITHUB_SCOPES, githubOauthClientId } from './oauth-config.js';

/**
 * GitHub OAuth Device Flow client.
 *
 * Two endpoints are involved:
 *   POST https://github.com/login/device/code        — start a session
 *   POST https://github.com/login/oauth/access_token — poll for completion
 *
 * GitHub returns `application/x-www-form-urlencoded` by default; we ask
 * for JSON via the Accept header so the responses are easy to parse.
 *
 * No Octokit dependency here — these endpoints aren't in the REST API
 * surface and `fetch` is the simplest path.
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between polls. */
  interval: number;
  /** Total seconds until the device code expires. */
  expiresIn: number;
}

export type DeviceFlowPoll =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied'; error?: string }
  | { status: 'success'; accessToken: string; scopes: string[]; tokenType: string };

/**
 * Start a device-flow session. Returns the user code to display, the
 * verification URI to open in a browser, and the device code we'll
 * poll with.
 */
export async function startDeviceFlow(
  scopes: readonly string[] = DEFAULT_GITHUB_SCOPES,
): Promise<DeviceFlowStart> {
  const clientId = githubOauthClientId();
  const body = new URLSearchParams({
    client_id: clientId,
    scope: scopes.join(' '),
  });
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'gezel/0.0.0',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`GitHub device-flow start failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (json.error) {
    throw new Error(
      `GitHub device-flow start refused: ${json.error}${
        json.error_description ? ` — ${json.error_description}` : ''
      }`,
    );
  }
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error(
      `GitHub device-flow start returned an unexpected shape: ${JSON.stringify(json)}`,
    );
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    interval: json.interval ?? 5,
    expiresIn: json.expires_in ?? 900,
  };
}

/**
 * Poll the access-token endpoint once. The caller is responsible for
 * pacing — GitHub's contract is that we wait `interval` seconds (or
 * `interval + 5` after a `slow_down` response) between calls.
 */
export async function pollDeviceFlow(deviceCode: string): Promise<DeviceFlowPoll> {
  const clientId = githubOauthClientId();
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'gezel/0.0.0',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`GitHub access-token poll failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (json.access_token) {
    return {
      status: 'success',
      accessToken: json.access_token,
      tokenType: json.token_type ?? 'bearer',
      scopes: (json.scope ?? '').split(/[,\s]+/).filter((s) => s.length > 0),
    };
  }
  switch (json.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down' };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return {
        status: 'denied',
        ...(json.error_description ? { error: json.error_description } : {}),
      };
    case 'unsupported_grant_type':
    case 'incorrect_client_credentials':
    case 'incorrect_device_code':
    case 'device_flow_disabled':
      throw new Error(
        `GitHub OAuth device flow misconfigured: ${json.error}${
          json.error_description ? ` — ${json.error_description}` : ''
        }`,
      );
    default:
      throw new Error(
        `GitHub access-token poll returned unexpected response: ${JSON.stringify(json)}`,
      );
  }
}
