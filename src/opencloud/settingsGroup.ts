import type { Setting, SettingDefinitionGroup, SettingDefinitionItem, SettingGroupItem } from 'obsidian';
import type { DavSyncSettings } from '../types';
import { ForkSettingsStore, normalizeSpaceFolder, type OpenCloudSpaceSettings } from './forkSettings';
import { normalizeServerUrl } from './serverUrl';
import { listSpaces as defaultListSpaces, type OpenCloudSpace, type SpaceListingCredentials } from './spaces';

// The fork's settings rows. Upstream's buildSettingDefinitions() runs unchanged (its tests pin its rows); this module then
// swaps the "Nextcloud" group for an "OpenCloud" group and adjusts the few other rows that mention Nextcloud.
// SettingTab.getSettingDefinitions() is the single call site (marked [opencloud-fork]).

/** What the settings rows need from the plugin and the settings tab. */
export interface OpenCloudSettingsDeps {
  /** Live settings object (data.json). */
  settings: DavSyncSettings;
  /** Live space settings (opencloud.json). */
  space: ForkSettingsStore;
  readToken(): string | null;
  saveSettings(): Promise<void>;
  /** Clears this device's tracking state, as "Reset vault index" does, without its own dialog. */
  resetSyncState(): Promise<void>;
  /** Rebuilds the sync engine so the next sync uses the new target. */
  reinitEngine(): Promise<void>;
  confirm(opts: { title: string; message: string; cta: string }): Promise<boolean>;
  notify(message: string, timeoutMs?: number): void;
  /** Rebuilds the settings rows (SettingTab.update()). */
  refresh(): void;
  renderAppPassword(setting: Setting): unknown;
  renderNotice(setting: Setting, text: string, cls?: string): unknown;
  renderReadOnly(setting: Setting, value: string, cls?: string): unknown;
  listSpaces?: (creds: SpaceListingCredentials) => Promise<OpenCloudSpace[]>;
}

export const OPENCLOUD_GROUP_HEADING = 'OpenCloud';
export const OPENCLOUD_ROWS = {
  serverUrl: 'Server URL',
  username: 'Username',
  token: 'App token',
  connect: 'Connect',
  space: 'Space',
  folder: 'Folder in space',
  target: 'Sync target',
  noSpace: 'No space selected',
} as const;

const NO_SPACE_TEXT = 'Choose the space this vault syncs into: enter the server URL, username and app token, press "Connect", then pick a space. Syncing stays disabled until you do.';
const AUTH_BANNER_TEXT = 'Enter the OpenCloud server URL, your username and an app token below, press "Connect" and choose a space. Syncing stays disabled until you do.';
const PER_VAULT_TEXT = 'Settings are stored per vault. Each vault can sync with a different OpenCloud server, account and space.';
const TOKEN_HELP = 'An OpenCloud app token, not your account password. Create one in OpenCloud (your account settings → App tokens, if your server shows that page) or ask your administrator, who can run: opencloud auth-app create --user-name=<you> --expiration=8760h. Click "Link…" to store it in Obsidian\'s encrypted Secret Storage — it is never saved in data.json. Tokens can expire; a sync then fails with HTTP 401 until you link a new one.';

export class OpenCloudSettingsController {
  /** Spaces from the last successful "Connect"; null = not connected in this settings session. */
  private spaces: OpenCloudSpace[] | null = null;
  private connecting = false;

  constructor(private readonly deps: OpenCloudSettingsDeps) {}

  get spaceSettings(): OpenCloudSpaceSettings { return this.deps.space.value; }
  get hasSpace(): boolean { return !!this.spaceSettings.spaceId && !!this.spaceSettings.spaceWebDavUrl; }
  get loadedSpaces(): readonly OpenCloudSpace[] | null { return this.spaces; }

  async connect(): Promise<void> {
    if (this.connecting) return;
    const s = this.deps.settings;
    const server = normalizeServerUrl(s.serverUrl);
    if (!server) { this.deps.notify('Enter the OpenCloud server URL first, e.g. https://cloud.example.com'); return; }
    if (!s.username.trim()) { this.deps.notify('Enter your OpenCloud username first.'); return; }
    const token = this.deps.readToken();
    if (!token) { this.deps.notify('Link an app token first (App token → "Link…").'); return; }
    if (server !== s.serverUrl || s.username !== s.username.trim()) {
      s.serverUrl = server;
      s.username = s.username.trim();
      await this.deps.saveSettings();
    }

    this.connecting = true;
    try {
      const list = this.deps.listSpaces ?? defaultListSpaces;
      const spaces = await list({ serverUrl: server, username: s.username, token, timeoutMs: (s.networkTimeoutSeconds ?? 30) * 1000 });
      this.spaces = spaces;
      const current = this.spaceSettings;
      const still = spaces.find((sp) => sp.id === current.spaceId);
      if (still && current.chosenOnServer === server && (still.webDavUrl !== current.spaceWebDavUrl || still.name !== current.spaceName)) {
        await this.deps.space.save({ spaceWebDavUrl: still.webDavUrl, spaceName: still.name });
      }
      if (spaces.length === 0) {
        this.deps.notify('Connected, but this account has no space to sync into.', 8000);
      } else if (still && current.chosenOnServer === server) {
        this.deps.notify(`✅ Connected. Syncing into "${still.name}".`, 5000);
      } else {
        this.deps.notify(`✅ Connected. Choose one of ${spaces.length} space${spaces.length === 1 ? '' : 's'} below.`, 6000);
      }
    } catch (err) {
      this.spaces = null;
      this.deps.notify(`❌ Could not connect: ${(err as Error).message}`, 8000);
    } finally {
      this.connecting = false;
      this.deps.refresh();
    }
  }

  async chooseSpace(spaceId: string): Promise<void> {
    const space = this.spaces?.find((sp) => sp.id === spaceId);
    if (!space) { this.deps.refresh(); return; }
    const server = normalizeServerUrl(this.deps.settings.serverUrl);
    const cur = this.spaceSettings;
    if (cur.spaceId === space.id && cur.chosenOnServer === server) return;
    await this.changeTarget(
      { spaceId: space.id, spaceName: space.name, spaceWebDavUrl: space.webDavUrl, chosenOnServer: server, spaceFolder: cur.spaceFolder },
      `Sync this vault with the space "${space.name}"`,
    );
  }

  async setFolder(raw: string): Promise<void> {
    const folder = normalizeSpaceFolder(raw);
    if (folder === this.spaceSettings.spaceFolder) return;
    await this.changeTarget({ spaceFolder: folder }, folder ? `Sync this vault into the folder "${folder}"` : 'Sync this vault into the space root');
  }

  // A different target makes this device's tracking state describe the wrong files: on the next sync they would look
  // deleted on the new target. So an already-configured vault is reset first, after confirmation (docs/opencloud.md).
  private async changeTarget(next: Partial<OpenCloudSpaceSettings>, what: string): Promise<void> {
    const hadTarget = this.hasSpace;
    if (hadTarget) {
      const ok = await this.deps.confirm({
        title: 'Change sync target',
        message: `${what}? This device's sync tracking is reset first, so the next sync compares the whole vault with the new target. No files are deleted locally or on the server.`,
        cta: 'Change',
      });
      if (!ok) { this.deps.refresh(); return; }
      await this.deps.resetSyncState();
    }
    await this.deps.space.save(next);
    await this.deps.reinitEngine();
    const t = this.spaceSettings;
    this.deps.notify(`Sync target: ${t.spaceName}${t.spaceFolder ? ` / ${t.spaceFolder}` : ''}`, 5000);
    this.deps.refresh();
  }

  // ------------------------------------------------------------------ rows

  group(): SettingDefinitionGroup {
    const d = this.deps;
    const s = d.settings;
    const credentialsMissing = (): boolean => !normalizeServerUrl(s.serverUrl) || !s.username.trim() || !d.readToken();
    const items: SettingGroupItem[] = [
      notice(d, OPENCLOUD_ROWS.noSpace, NO_SPACE_TEXT, () => !this.hasSpace, 'ncs-auth-warning'),
      {
        name: OPENCLOUD_ROWS.serverUrl,
        desc: 'Address of your OpenCloud server, e.g. https://cloud.example.com. Everything else (WebDAV, spaces, versions) is discovered from it.',
        aliases: ['endpoint', 'host', 'address', 'url', 'server'],
        control: { type: 'text', key: 'serverUrl', placeholder: 'https://cloud.example.com' },
      },
      {
        name: OPENCLOUD_ROWS.username,
        desc: 'Your OpenCloud username.',
        aliases: ['user', 'account', 'login name'],
        control: { type: 'text', key: 'username' },
      },
      {
        name: OPENCLOUD_ROWS.token,
        desc: TOKEN_HELP,
        aliases: ['token', 'app password', 'credential', 'password', 'secret'],
        render: (setting: Setting) => d.renderAppPassword(setting),
      } as SettingGroupItem,
      {
        name: OPENCLOUD_ROWS.connect,
        desc: 'Checks the server URL, username and app token, and loads the spaces you can sync into.',
        aliases: ['login', 'sign in', 'test connection', 'load spaces'],
        disabled: credentialsMissing,
        action: () => { void this.connect(); },
      },
      {
        name: OPENCLOUD_ROWS.space,
        desc: 'The OpenCloud space this vault syncs into: your personal space or a project space you are a member of. Press "Connect" to load the list.',
        aliases: ['space', 'drive', 'project', 'destination', 'target'],
        render: (setting: Setting) => this.renderSpacePicker(setting),
      },
      {
        name: OPENCLOUD_ROWS.folder,
        desc: 'Optional folder inside the space, e.g. "Obsidian/Work". Leave empty to sync into the space root. Created if missing.',
        aliases: ['subfolder', 'remote folder', 'path'],
        render: (setting: Setting) => this.renderFolder(setting),
      },
      {
        name: OPENCLOUD_ROWS.target,
        desc: 'Read-only: where this vault syncs to.',
        aliases: ['effective url', 'remote path', 'destination'],
        render: (setting: Setting) => d.renderReadOnly(setting, this.targetText(), 'ncs-break-all'),
      } as SettingGroupItem,
    ];
    return { type: 'group', heading: OPENCLOUD_GROUP_HEADING, items };
  }

  targetText(): string {
    const t = this.spaceSettings;
    if (!this.hasSpace) return '(no space selected)';
    const path = t.spaceFolder ? `/${t.spaceFolder}` : '/';
    return `${t.spaceName}${path} — ${t.spaceWebDavUrl}${t.spaceFolder ? `/${t.spaceFolder}` : ''}`;
  }

  private renderSpacePicker(setting: Setting): void {
    const cur = this.spaceSettings;
    const spaces = this.spaces;
    setting.addDropdown((dd) => {
      if (spaces) {
        dd.addOption('', spaces.length ? 'Choose a space…' : '(no spaces available)');
        for (const sp of spaces) dd.addOption(sp.id, sp.driveType === 'personal' ? `${sp.name} (personal space)` : sp.name);
        dd.setValue(spaces.some((sp) => sp.id === cur.spaceId) ? cur.spaceId : '');
        dd.onChange((value) => { if (value) void this.chooseSpace(value); });
      } else {
        // Not connected in this session: show the current choice, read-only, until "Connect" loads the list.
        dd.addOption(cur.spaceId, this.hasSpace ? cur.spaceName : 'Press "Connect" to load spaces');
        dd.setValue(cur.spaceId);
        dd.setDisabled(true);
      }
    });
  }

  private renderFolder(setting: Setting): void {
    setting.addText((text) => {
      text.setPlaceholder('Space root').setValue(this.spaceSettings.spaceFolder);
      // Committed on blur/Enter, not per keystroke: each change of the target asks for confirmation.
      text.inputEl.addEventListener('change', () => { void this.setFolder(text.getValue()); });
    });
  }
}

function notice(deps: OpenCloudSettingsDeps, name: string, text: string, visible?: () => boolean, cls?: string): SettingGroupItem {
  return {
    name, desc: text, searchable: false,
    ...(visible ? { visible } : {}),
    render: (setting: Setting) => deps.renderNotice(setting, text, cls),
  } as SettingGroupItem;
}

// Upstream row names this module rewrites or removes (from src/settings/settingDefinitions.ts).
const UPSTREAM_GROUP_HEADING = 'Nextcloud';
const UPSTREAM_AUTH_BANNER = 'Not signed in yet';
const UPSTREAM_SERVER_COMPAT = 'Server compatibility';
const UPSTREAM_PER_VAULT = 'Per-vault settings';
const UPSTREAM_SYNC_NOW = 'Sync now';

/**
 * Upstream's definitions with the OpenCloud group in place of the Nextcloud group. Also: the auth banner and the
 * per-vault note get OpenCloud text, the Nextcloud version banner is dropped (its version check is Nextcloud's), "Sync now"
 * additionally needs a space, and any remaining "Nextcloud" in a plain description reads "OpenCloud".
 * If upstream renames the Nextcloud group, the OpenCloud group is appended instead and the fork test fails loudly.
 */
export function withOpenCloudSettings(defs: SettingDefinitionItem[], controller: OpenCloudSettingsController, deps: OpenCloudSettingsDeps): SettingDefinitionItem[] {
  let replaced = false;
  const out = defs.map((item): SettingDefinitionItem => {
    if (!isGroup(item)) return item;
    if (item.heading === UPSTREAM_GROUP_HEADING) { replaced = true; return controller.group(); }
    const items = (item.items ?? [])
      .filter((row) => rowName(row) !== UPSTREAM_SERVER_COMPAT)
      .map((row): SettingGroupItem => {
        const name = rowName(row);
        if (name === UPSTREAM_AUTH_BANNER) {
          const visible = (row as { visible?: () => boolean }).visible;
          return notice(deps, name, AUTH_BANNER_TEXT, visible, 'ncs-auth-warning');
        }
        if (name === UPSTREAM_PER_VAULT) return notice(deps, name, PER_VAULT_TEXT);
        let next = row;
        if (name === UPSTREAM_SYNC_NOW) {
          const disabled = (row as { disabled?: () => boolean }).disabled;
          next = {
            ...row,
            desc: 'Sync this vault with OpenCloud now. Enabled once the server URL, username, app token and a space are set.',
            disabled: () => (disabled ? disabled() : false) || !controller.hasSpace,
          } as SettingGroupItem;
        }
        return rewordNextcloud(next);
      });
    return { ...item, items };
  });
  if (!replaced) out.splice(1, 0, controller.group());
  return out;
}

function isGroup(item: SettingDefinitionItem): item is SettingDefinitionGroup {
  const g = item as { type?: unknown; items?: unknown };
  return g.type === 'group' && Array.isArray(g.items);
}

function rowName(row: SettingGroupItem): string | undefined {
  const name = (row as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function rewordNextcloud(row: SettingGroupItem): SettingGroupItem {
  const desc = (row as { desc?: unknown }).desc;
  if (typeof desc !== 'string' || !desc.includes('Nextcloud')) return row;
  return { ...row, desc: desc.replace(/Nextcloud/g, 'OpenCloud') };
}

// One controller per settings tab, so the loaded space list survives the re-renders Obsidian does on every update().
const controllers = new WeakMap<object, OpenCloudSettingsController>();
export function controllerFor(owner: object, makeDeps: () => OpenCloudSettingsDeps): { controller: OpenCloudSettingsController; deps: OpenCloudSettingsDeps } {
  let controller = controllers.get(owner);
  const deps = makeDeps();
  if (!controller) {
    controller = new OpenCloudSettingsController(deps);
    controllers.set(owner, controller);
  }
  return { controller, deps };
}
