// [opencloud-fork] Server URL normalisation, space parsing, the space settings store, the content digest and the factory guards.
import { normalizeServerUrl } from '../../../src/opencloud/serverUrl';
import { parseSpaces } from '../../../src/opencloud/spaces';
import { ForkSettingsStore, changesSyncTarget, normalizeSpaceFolder, DEFAULT_SPACE_SETTINGS } from '../../../src/opencloud/forkSettings';
import { OpenCloudFactory } from '../../../src/opencloud/OpenCloudFactory';
import { ServerChangedError, SpaceNotSelectedError } from '../../../src/opencloud/errors';
import { getContentDigest, setContentDigest, sha256 } from '../../../src/util/hash';
import { CredentialsNotFoundError, DEFAULT_SETTINGS } from '../../../src/types';
import { createHash } from 'crypto';
import type { App, DataAdapter } from 'obsidian';

describe('normalizeServerUrl', () => {
  it.each([
    ['https://cloud.example.com', 'https://cloud.example.com'],
    ['https://cloud.example.com/', 'https://cloud.example.com'],
    ['  cloud.example.com  ', 'https://cloud.example.com'],
    ['https://cloud.example.com:9200/dav/spaces/abc$def/Notes', 'https://cloud.example.com:9200'],
    ['https://cloud.example.com/remote.php/dav/files/alice/', 'https://cloud.example.com'],
    ['https://cloud.example.com/files/spaces/personal/alice?items-per-page=100', 'https://cloud.example.com'],
    ['https://cloud.example.com/graph/v1.0/me/drives', 'https://cloud.example.com'],
    ['https://example.com/opencloud/dav/spaces/x', 'https://example.com/opencloud'],
    ['http://localhost:8080/', 'http://localhost:8080'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each(['', '   ', 'ftp://cloud.example.com', 'https://'])('rejects %j', (input) => {
    expect(normalizeServerUrl(input)).toBe('');
  });
});

describe('parseSpaces', () => {
  it('keeps personal and project spaces, personal first, and drops virtual and disabled ones', () => {
    const spaces = parseSpaces([
      { id: 'p2', name: 'Zeta', driveType: 'project', root: { webDavUrl: 'https://s/dav/spaces/p2/' } },
      { id: 'v', name: 'Shares', driveType: 'virtual', root: { webDavUrl: 'https://s/dav/spaces/v' } },
      { id: 'p1', name: 'Alpha', driveType: 'project', root: { webDavUrl: 'https://s/dav/spaces/p1' } },
      { id: 'me', name: 'Alice', driveType: 'personal', root: { webDavUrl: 'https://s/dav/spaces/me' } },
      { id: 'gone', name: 'Old', driveType: 'project', root: { webDavUrl: 'https://s/dav/spaces/gone', deleted: { state: 'trashed' } } },
      { id: 'broken', driveType: 'project', root: {} },
      'not an object',
    ]);
    expect(spaces.map((s) => s.id)).toEqual(['me', 'p1', 'p2']);
    expect(spaces[2].webDavUrl).toBe('https://s/dav/spaces/p2');
  });
});

describe('space settings', () => {
  function memoryAdapter(): DataAdapter & { files: Map<string, string> } {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    return {
      files,
      exists: async (p: string) => files.has(p) || dirs.has(p),
      read: async (p: string) => files.get(p)!,
      write: async (p: string, d: string) => { files.set(p, d); },
      mkdir: async (p: string) => { dirs.add(p); },
    } as unknown as DataAdapter & { files: Map<string, string> };
  }

  it('round-trips through opencloud.json and normalises the folder', async () => {
    const adapter = memoryAdapter();
    const a = new ForkSettingsStore(adapter, '.obsidian/plugins/opencloud-sync');
    await a.load();
    expect(a.value).toEqual(DEFAULT_SPACE_SETTINGS);
    await a.save({ spaceId: 's', spaceName: 'S', spaceWebDavUrl: 'https://x/dav/spaces/s', spaceFolder: ' /Obsidian\\Work/ ', chosenOnServer: 'https://x' });
    expect(adapter.files.has('.obsidian/plugins/opencloud-sync/opencloud.json')).toBe(true);
    const b = new ForkSettingsStore(adapter, '.obsidian/plugins/opencloud-sync');
    await b.load();
    expect(b.value).toMatchObject({ spaceId: 's', spaceFolder: 'Obsidian/Work', chosenOnServer: 'https://x' });
  });

  it('treats an unreadable file as "nothing chosen"', async () => {
    const adapter = memoryAdapter();
    adapter.files.set('dir/opencloud.json', '{not json');
    const s = new ForkSettingsStore(adapter, 'dir');
    await s.load();
    expect(s.value.spaceId).toBe('');
  });

  it('normalises folders and detects a changed target', () => {
    expect(normalizeSpaceFolder('/a//b/../c/')).toBe('a/b/c');
    const base = { ...DEFAULT_SPACE_SETTINGS, spaceId: 's', spaceFolder: 'a' };
    expect(changesSyncTarget(base, { ...base, spaceName: 'renamed' })).toBe(false);
    expect(changesSyncTarget(base, { ...base, spaceFolder: '/a/' })).toBe(false);
    expect(changesSyncTarget(base, { ...base, spaceFolder: 'b' })).toBe(true);
    expect(changesSyncTarget(base, { ...base, spaceId: 't' })).toBe(true);
  });
});

describe('content digest', () => {
  afterEach(() => setContentDigest('SHA-256'));

  it('defaults to SHA-256, so upstream behaviour and tests are unchanged', async () => {
    expect(getContentDigest()).toBe('SHA-256');
    const data = new TextEncoder().encode('abc').buffer;
    expect(await sha256(data)).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('switches the same function to SHA-1 for the fork', async () => {
    setContentDigest('SHA-1');
    const data = new TextEncoder().encode('abc').buffer;
    expect(await sha256(data)).toBe(createHash('sha1').update('abc').digest('hex'));
  });
});

describe('OpenCloudFactory guards', () => {
  const app = {} as App;
  const settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://oc.example', username: 'alice' };
  const space = { ...DEFAULT_SPACE_SETTINGS, spaceId: 's', spaceName: 'S', spaceWebDavUrl: 'https://oc.example/dav/spaces/s', chosenOnServer: 'https://oc.example' };
  afterEach(() => setContentDigest('SHA-256'));

  it('needs a token, then a space', async () => {
    setContentDigest('SHA-1');
    await expect(new OpenCloudFactory(app, settings, space, () => null).createClient()).rejects.toBeInstanceOf(CredentialsNotFoundError);
    await expect(new OpenCloudFactory(app, settings, { ...space, spaceId: '' }, () => 't').createClient()).rejects.toBeInstanceOf(SpaceNotSelectedError);
  });

  it('refuses a space chosen on another server', async () => {
    setContentDigest('SHA-1');
    const moved = { ...settings, serverUrl: 'https://other.example' };
    await expect(new OpenCloudFactory(app, moved, space, () => 't').createClient()).rejects.toBeInstanceOf(ServerChangedError);
  });

  it('refuses to run with the SHA-256 digest (a wiring mistake would re-transfer every file)', async () => {
    await expect(new OpenCloudFactory(app, settings, space, () => 't').createClient()).rejects.toThrow(/SHA-1/);
  });
});
