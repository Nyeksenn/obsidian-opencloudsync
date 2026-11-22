// What the user types as "Server URL" is reduced to the server root (origin plus any reverse-proxy path prefix).
// Every other URL is derived from that root, so a pasted WebDAV, web UI or API address is trimmed back to it.

// Path segments where OpenCloud's own routes begin; everything from the first of them on is dropped.
const ROUTE_START = /\/(dav|remote\.php|webdav|graph|ocs|files|f|s|status\.php|auth-app|data|index\.html)(\/|$|\?|#).*$/;

/** Normalised server root without a trailing slash, or '' when the input is not an http(s) URL. */
export function normalizeServerUrl(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  const path = url.pathname.replace(ROUTE_START, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}
