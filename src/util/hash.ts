// [opencloud-fork] The digest behind sha256() is switchable so the engine's content hash can match the server's checksum
// algorithm (OpenCloud offers SHA-1, not SHA-256) without touching any call site. The default stays SHA-256.
export type ContentDigest = 'SHA-256' | 'SHA-1';
let contentDigest: ContentDigest = 'SHA-256';

export function setContentDigest(digest: ContentDigest): void { contentDigest = digest; }
export function getContentDigest(): ContentDigest { return contentDigest; }

export async function sha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(contentDigest, data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
