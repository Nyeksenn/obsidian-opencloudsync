import { RequestUrlResponse } from 'obsidian';

// Small pieces shared by the OpenCloud client and the settings screen.

export const USER_AGENT = 'Obsidian OpenCloud Sync';
const OC_NS = 'http://owncloud.org/ns';

/** HTTP basic credentials for username + app token (UTF-8 safe; app tokens contain spaces). */
export function basicAuthHeader(username: string, token: string): string {
  const bytes = new TextEncoder().encode(`${username}:${token}`);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return `Basic ${btoa(binary)}`;
}

/** Base64 of a UTF-8 string, for TUS Upload-Metadata values. */
export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Lowercase hex SHA-1, independent of the engine's switchable content digest. */
export async function sha1Hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A 40-hex-digit value is already a SHA-1; anything else (absent, or a SHA-256 from another digest) is not. */
export function isSha1Hex(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

/** Reads a JSON object body; anything else is null, never an exception. */
export function readJsonObject(res: RequestUrlResponse): Record<string, unknown> | null {
  try {
    const v: unknown = res.json;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * oc:checksums / oc:fileid of one PROPFIND <d:prop>. OpenCloud reports "SHA1:<hex> MD5:<hex> ADLER32:<hex>"; only SHA-1
 * is taken, since it is the digest the engine compares against in this fork. Upstream's readOwncloudProps reads SHA-256 only.
 */
export function readOpenCloudProps(prop: Element): { checksum: string | null; fileId: string | null } {
  const raw = prop.getElementsByTagNameNS(OC_NS, 'checksums')[0]?.textContent ?? null;
  const m = raw ? raw.match(/SHA1:([0-9a-fA-F]{40})/i) : null;
  const fileId = prop.getElementsByTagNameNS(OC_NS, 'fileid')[0]?.textContent?.trim() || null;
  return { checksum: m ? m[1].toLowerCase() : null, fileId };
}

/** Case-insensitive response header lookup (requestUrl lowercases on some platforms, not on others). */
export function header(res: RequestUrlResponse, name: string): string | undefined {
  const lower = name.toLowerCase();
  const key = Object.keys(res.headers ?? {}).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : res.headers[key];
}
