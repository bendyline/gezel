import { APP_TOOL_SURFACE_HEADER, AppToolSurfaceIdSchema } from '@bendyline/gezel';

/**
 * Query parameter a host frames the embedded chat with to name its **app
 * surface**: the id it registered its own tools under (the Office pane's
 * document tools). The chat sends every request with that id in
 * `APP_TOOL_SURFACE_HEADER`, and the daemon offers those tools only to the
 * threads this chat is driving.
 */
export const APP_SURFACE_PARAM = 'appSurface';

export function readAppSurface(search: string): string | null {
  const parsed = AppToolSurfaceIdSchema.safeParse(
    new URLSearchParams(search).get(APP_SURFACE_PARAM),
  );
  return parsed.success ? parsed.data : null;
}

export function withAppSurface(fetchImpl: typeof fetch, surfaceId: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(APP_TOOL_SURFACE_HEADER, surfaceId);
    return fetchImpl(input, { ...init, headers });
  };
}
