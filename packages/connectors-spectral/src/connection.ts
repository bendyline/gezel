/**
 * Maps a gezel SecretStore credential blob to the spectral `Connection` shape a
 * component's `client.ts` reads (`connection.token?.access_token` for OAuth,
 * `connection.fields.<x>` for apikey/basic).
 */

export interface SpectralConnection {
  key: string;
  token?: { access_token?: string };
  fields: Record<string, unknown>;
}

export function toSpectralConnection(blob: string, connectionKey: string): SpectralConnection {
  const parsed = JSON.parse(blob) as Record<string, unknown>;
  const accessToken = parsed.accessToken ?? parsed.access_token;
  if (accessToken !== undefined) {
    return { key: connectionKey, token: { access_token: String(accessToken) }, fields: parsed };
  }
  return { key: connectionKey, fields: parsed };
}
