import { requestUrlWithTimeout } from '../network/requestWithTimeout';
import { NO_CACHE_HEADERS } from '../network/noCacheHeaders';
import { NetworkError } from '../types';
import { basicAuthHeader, readJsonObject, USER_AGENT } from './http';
import { OpenCloudAuthError } from './errors';

export type SpaceType = 'personal' | 'project';

export interface OpenCloudSpace {
  id: string;
  name: string;
  driveType: SpaceType;
  webDavUrl: string;
}

export interface SpaceListingCredentials {
  /** Normalised server root (see normalizeServerUrl). */
  serverUrl: string;
  username: string;
  token: string;
  timeoutMs: number;
}

/**
 * The spaces this account can sync into: its personal space and the project spaces it is a member of, personal first,
 * then by name. "virtual" drives (the Shares jail) and disabled spaces are left out.
 * @throws OpenCloudAuthError on 401, NetworkError on any other non-200 or an unreadable body.
 */
export async function listSpaces(creds: SpaceListingCredentials): Promise<OpenCloudSpace[]> {
  const res = await requestUrlWithTimeout({
    url: `${creds.serverUrl}/graph/v1.0/me/drives`,
    method: 'GET',
    headers: { Authorization: basicAuthHeader(creds.username, creds.token), 'User-Agent': USER_AGENT, ...NO_CACHE_HEADERS },
    throw: false,
  }, creds.timeoutMs);
  if (res.status === 401) throw new OpenCloudAuthError();
  if (res.status !== 200) throw new NetworkError(res.status, res.text, 'GET');
  const value = readJsonObject(res)?.value;
  if (!Array.isArray(value)) throw new NetworkError(res.status, 'drive listing is not a Graph collection', 'GET');
  return parseSpaces(value);
}

export function parseSpaces(value: unknown[]): OpenCloudSpace[] {
  const spaces: OpenCloudSpace[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as Record<string, unknown>;
    const root = (typeof d.root === 'object' && d.root !== null ? d.root : {}) as Record<string, unknown>;
    const driveType = d.driveType;
    if (driveType !== 'personal' && driveType !== 'project') continue;
    // A disabled (trashed) project space still appears for managers, with root.deleted.state = "trashed".
    const deleted = root.deleted as Record<string, unknown> | undefined;
    if (deleted && deleted.state === 'trashed') continue;
    if (typeof d.id !== 'string' || typeof root.webDavUrl !== 'string') continue;
    spaces.push({
      id: d.id,
      name: typeof d.name === 'string' && d.name ? d.name : d.id,
      driveType,
      webDavUrl: root.webDavUrl.replace(/\/+$/, ''),
    });
  }
  return spaces.sort((a, b) =>
    a.driveType === b.driveType ? a.name.localeCompare(b.name) : a.driveType === 'personal' ? -1 : 1);
}
