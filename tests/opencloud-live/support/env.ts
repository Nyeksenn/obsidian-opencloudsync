import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';
import type { OpenCloudSpaceSettings } from '../../../src/opencloud/forkSettings';

// Provided by tests/opencloud-live/run.sh. A missing value fails the run: a live layer that silently skips verifies nothing.
export interface OcEnv {
  serverUrl: string;
  username: string;
  token: string;
  spaceId: string;
  spaceName: string;
  spaceWebDavUrl: string;
}

export function ocEnv(): OcEnv {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set — run the live layer through tests/opencloud-live/run.sh (pnpm test:oc)`);
    return v;
  };
  return {
    serverUrl: need('OC_URL'),
    username: need('OC_USER'),
    token: need('OC_TOKEN'),
    spaceId: need('OC_SPACE_ID'),
    spaceName: need('OC_SPACE_NAME'),
    spaceWebDavUrl: need('OC_SPACE_DAV'),
  };
}

let counter = 0;
/** A folder inside the run's space that no other test uses. */
export function uniqueFolder(label: string): string {
  counter++;
  return `t-${Date.now().toString(36)}-${counter}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
}

export function settingsFor(env: OcEnv, deviceId: string, over: Partial<DavSyncSettings> = {}): DavSyncSettings {
  return { ...DEFAULT_SETTINGS, serverUrl: env.serverUrl, username: env.username, deviceId, networkConcurrency: 4, ...over };
}

export function spaceFor(env: OcEnv, folder: string): OpenCloudSpaceSettings {
  return { spaceId: env.spaceId, spaceName: env.spaceName, spaceWebDavUrl: env.spaceWebDavUrl, spaceFolder: folder, chosenOnServer: '' };
}
