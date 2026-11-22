// [opencloud-fork] The OpenCloud settings rows over upstream's real buildSettingDefinitions(), and the connect /
// choose-space / change-target flow.
import type { SettingDefinitionGroup, SettingDefinitionItem } from 'obsidian';
import { buildSettingDefinitions, type SettingDefinitionsHost } from '../../../src/settings/settingDefinitions';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';
import { DEFAULT_SPACE_SETTINGS, type ForkSettingsStore, type OpenCloudSpaceSettings } from '../../../src/opencloud/forkSettings';
import {
  OPENCLOUD_GROUP_HEADING, OPENCLOUD_ROWS, OpenCloudSettingsController, withOpenCloudSettings, type OpenCloudSettingsDeps,
} from '../../../src/opencloud/settingsGroup';
import type { OpenCloudSpace } from '../../../src/opencloud/spaces';

const SPACES: OpenCloudSpace[] = [
  { id: 'me', name: 'Alice', driveType: 'personal', webDavUrl: 'https://oc.example/dav/spaces/me' },
  { id: 'team', name: 'Team', driveType: 'project', webDavUrl: 'https://oc.example/dav/spaces/team' },
];

function fakeStore(initial: Partial<OpenCloudSpaceSettings> = {}): ForkSettingsStore {
  const value: OpenCloudSpaceSettings = { ...DEFAULT_SPACE_SETTINGS, ...initial };
  return { value, load: async () => undefined, save: async (n: Partial<OpenCloudSpaceSettings>) => { Object.assign(value, n); } } as unknown as ForkSettingsStore;
}

function makeDeps(over: Partial<OpenCloudSettingsDeps> = {}, space: Partial<OpenCloudSpaceSettings> = {}) {
  const log: string[] = [];
  const settings: DavSyncSettings = { ...DEFAULT_SETTINGS, serverUrl: 'https://oc.example/dav/spaces/me', username: ' alice ' };
  const deps: OpenCloudSettingsDeps = {
    settings,
    space: fakeStore(space),
    readToken: () => 'tok',
    saveSettings: async () => { log.push('save'); },
    resetSyncState: async () => { log.push('reset'); },
    reinitEngine: async () => { log.push('reinit'); },
    confirm: async () => { log.push('confirm'); return true; },
    notify: (m) => { log.push(`notify:${m}`); },
    refresh: () => { log.push('refresh'); },
    renderAppPassword: () => undefined,
    renderNotice: () => undefined,
    renderReadOnly: () => undefined,
    listSpaces: async () => SPACES,
    ...over,
  };
  return { deps, log, settings };
}

function upstreamHost(settings: DavSyncSettings): SettingDefinitionsHost {
  const noop = (): undefined => undefined;
  return {
    settings, isMobile: false, isIosApp: false, isSignedIn: true, configDir: '.obsidian', vaultName: 'V',
    syncTargetUrl: () => '', runSyncNow: noop, runRemoteMirror: noop, resetVaultIndex: noop, openSyncStatus: noop,
    startLoginFlow: noop, addExcludedFolder: noop, removeExcludedFolder: noop, openCommunityPluginPicker: noop,
    removeSyncedCommunityPlugin: noop, renderAppPassword: noop, renderNumberSlider: noop, renderReadOnly: noop,
    renderNotice: noop, renderExtensionList: noop, renderAddExcludedFolder: noop,
  };
}

const groups = (defs: SettingDefinitionItem[]): SettingDefinitionGroup[] => defs as SettingDefinitionGroup[];
const rowNames = (g: SettingDefinitionGroup): string[] => (g.items ?? []).map((r) => (r as { name: string }).name);
const row = (defs: SettingDefinitionItem[], name: string): Record<string, unknown> =>
  groups(defs).flatMap((g) => g.items ?? []).find((r) => (r as { name: string }).name === name) as unknown as Record<string, unknown>;

describe('withOpenCloudSettings over upstream rows', () => {
  function build(space: Partial<OpenCloudSpaceSettings> = {}) {
    const { deps, settings } = makeDeps({}, space);
    const controller = new OpenCloudSettingsController(deps);
    settings.lastKnownServerVersion = '9.2.0'; // would show upstream's Nextcloud version banner
    return withOpenCloudSettings(buildSettingDefinitions(upstreamHost(settings)), controller, deps);
  }

  it('puts the OpenCloud group where the Nextcloud group was, with the fork rows', () => {
    const defs = build();
    const headings = groups(defs).map((g) => g.heading);
    expect(headings).not.toContain('Nextcloud');
    expect(headings[1]).toBe(OPENCLOUD_GROUP_HEADING);
    expect(rowNames(groups(defs)[1])).toEqual([
      OPENCLOUD_ROWS.noSpace, OPENCLOUD_ROWS.serverUrl, OPENCLOUD_ROWS.username, OPENCLOUD_ROWS.token,
      OPENCLOUD_ROWS.connect, OPENCLOUD_ROWS.space, OPENCLOUD_ROWS.folder, OPENCLOUD_ROWS.target,
    ]);
  });

  it('binds the server URL and username rows to upstream settings keys', () => {
    const defs = build();
    expect((row(defs, OPENCLOUD_ROWS.serverUrl).control as { key: string }).key).toBe('serverUrl');
    expect((row(defs, OPENCLOUD_ROWS.username).control as { key: string }).key).toBe('username');
  });

  it('drops the Nextcloud version banner and leaves no "Nextcloud" in any description', () => {
    const defs = build();
    expect(row(defs, 'Server compatibility')).toBeUndefined();
    const descs = groups(defs).flatMap((g) => g.items ?? []).map((r) => (r as { desc?: unknown }).desc).filter((d) => typeof d === 'string');
    expect(descs.filter((d) => /nextcloud/i.test(d as string))).toEqual([]);
  });

  it('keeps "Sync now" disabled until a space is chosen', () => {
    const disabledWithout = (row(build(), 'Sync now').disabled as () => boolean)();
    const disabledWith = (row(build({ spaceId: 'me', spaceWebDavUrl: 'https://oc.example/dav/spaces/me' }), 'Sync now').disabled as () => boolean)();
    expect(disabledWithout).toBe(true);
    expect(disabledWith).toBe(false);
  });

  it('shows the "no space" notice only without a space', () => {
    expect((row(build(), OPENCLOUD_ROWS.noSpace).visible as () => boolean)()).toBe(true);
    expect((row(build({ spaceId: 'me', spaceWebDavUrl: 'u' }), OPENCLOUD_ROWS.noSpace).visible as () => boolean)()).toBe(false);
  });
});

describe('OpenCloudSettingsController', () => {
  it('connect normalises the server URL and username, then loads the spaces', async () => {
    let creds: unknown;
    const { deps, log, settings } = makeDeps({ listSpaces: async (c) => { creds = c; return SPACES; } });
    const c = new OpenCloudSettingsController(deps);
    await c.connect();
    expect(settings.serverUrl).toBe('https://oc.example');
    expect(settings.username).toBe('alice');
    expect(creds).toMatchObject({ serverUrl: 'https://oc.example', username: 'alice', token: 'tok' });
    expect(c.loadedSpaces).toEqual(SPACES);
    expect(log).toContain('save');
    expect(log[log.length - 1]).toBe('refresh');
  });

  it('connect reports a failure and keeps no stale list', async () => {
    const { deps, log } = makeDeps({ listSpaces: async () => { throw new Error('HTTP 401'); } });
    const c = new OpenCloudSettingsController(deps);
    await c.connect();
    expect(c.loadedSpaces).toBeNull();
    expect(log.some((l) => l.startsWith('notify:❌ Could not connect: HTTP 401'))).toBe(true);
  });

  it('connect does nothing without a token', async () => {
    const listSpaces = jest.fn(async () => SPACES);
    const { deps } = makeDeps({ readToken: () => null, listSpaces });
    await new OpenCloudSettingsController(deps).connect();
    expect(listSpaces).not.toHaveBeenCalled();
  });

  it('choosing the first space needs no confirmation and no reset', async () => {
    const { deps, log } = makeDeps();
    const c = new OpenCloudSettingsController(deps);
    await c.connect();
    log.length = 0;
    await c.chooseSpace('me');
    expect(deps.space.value).toMatchObject({ spaceId: 'me', spaceName: 'Alice', spaceWebDavUrl: SPACES[0].webDavUrl, chosenOnServer: 'https://oc.example' });
    expect(log).not.toContain('confirm');
    expect(log).not.toContain('reset');
    expect(log).toContain('reinit');
  });

  it('switching space confirms, then resets tracking before saving the new target', async () => {
    const { deps, log } = makeDeps({}, { spaceId: 'me', spaceName: 'Alice', spaceWebDavUrl: SPACES[0].webDavUrl, chosenOnServer: 'https://oc.example' });
    const c = new OpenCloudSettingsController(deps);
    await c.connect();
    log.length = 0;
    await c.chooseSpace('team');
    expect(log.slice(0, 3)).toEqual(['confirm', 'reset', 'reinit']);
    expect(deps.space.value.spaceId).toBe('team');
  });

  it('a declined switch changes nothing', async () => {
    const { deps, log } = makeDeps({ confirm: async () => false }, { spaceId: 'me', spaceName: 'Alice', spaceWebDavUrl: 'u', chosenOnServer: 'https://oc.example' });
    const c = new OpenCloudSettingsController(deps);
    await c.connect();
    log.length = 0;
    await c.chooseSpace('team');
    expect(deps.space.value.spaceId).toBe('me');
    expect(log).not.toContain('reset');
  });

  it('changing the folder inside the space is a target change too', async () => {
    const { deps, log } = makeDeps({}, { spaceId: 'me', spaceName: 'Alice', spaceWebDavUrl: 'u', chosenOnServer: 'https://oc.example' });
    const c = new OpenCloudSettingsController(deps);
    await c.setFolder(' /Obsidian/Work/ ');
    expect(deps.space.value.spaceFolder).toBe('Obsidian/Work');
    expect(log.slice(0, 2)).toEqual(['confirm', 'reset']);
    log.length = 0;
    await c.setFolder('Obsidian/Work'); // unchanged after normalisation
    expect(log).toEqual([]);
  });

  it('re-choosing the same space on the same server is a no-op', async () => {
    const { deps, log } = makeDeps({}, { spaceId: 'me', spaceName: 'Alice', spaceWebDavUrl: SPACES[0].webDavUrl, chosenOnServer: 'https://oc.example' });
    const c = new OpenCloudSettingsController(deps);
    await c.connect();
    log.length = 0;
    await c.chooseSpace('me');
    expect(log).toEqual([]);
  });
});
