/**
 * A JSON `Response`, built by hand.
 *
 * `Response.json()` is a static the WebView on this project's iOS floor
 * (16.4) does not have; Safari gained it in 17. Every route on every host
 * builds its reply here so no device is left unable to read one.
 */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
