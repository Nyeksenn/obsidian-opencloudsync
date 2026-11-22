import type { DataAdapter } from 'obsidian';

// The fork's own settings live in their own file next to data.json, not in DavSyncSettings: upstream's settings test
// requires every DEFAULT_SETTINGS key to have an upstream settings row, so adding keys there would break it on every merge.

export interface OpenCloudSpaceSettings {
  /** Graph drive id of the chosen space; '' = none chosen (sync is blocked). */
  spaceId: string;
  /** Display name at the time it was chosen. */
  spaceName: string;
  /** The space's WebDAV root as reported by Graph (`root.webDavUrl`); every file request is relative to it. */
  spaceWebDavUrl: string;
  /** Optional folder inside the space to sync into ('' = the space root). Slash-separated, no leading/trailing slash. */
  spaceFolder: string;
}

export const DEFAULT_SPACE_SETTINGS: OpenCloudSpaceSettings = {
  spaceId: '', spaceName: '', spaceWebDavUrl: '', spaceFolder: '',
};

export const FORK_SETTINGS_FILE = 'opencloud.json';

export function normalizeSpaceFolder(raw: string): string {
  return (raw ?? '').trim().replace(/\\/g, '/').split('/').map((s) => s.trim()).filter((s) => s && s !== '.' && s !== '..').join('/');
}

/** True when switching from `a` to `b` points the vault at different remote content, so the tracking state must be reset. */
export function changesSyncTarget(a: OpenCloudSpaceSettings, b: OpenCloudSpaceSettings): boolean {
  return a.spaceId !== b.spaceId || normalizeSpaceFolder(a.spaceFolder) !== normalizeSpaceFolder(b.spaceFolder);
}

export class ForkSettingsStore {
  /** Live object: readers keep the reference and always see the latest saved values. */
  readonly value: OpenCloudSpaceSettings = { ...DEFAULT_SPACE_SETTINGS };

  constructor(private readonly adapter: DataAdapter, private readonly pluginDir: string) {}

  private get path(): string { return `${this.pluginDir}/${FORK_SETTINGS_FILE}`; }

  async load(): Promise<void> {
    let parsed: Partial<OpenCloudSpaceSettings> = {};
    try {
      if (await this.adapter.exists(this.path)) {
        const raw: unknown = JSON.parse(await this.adapter.read(this.path));
        if (raw && typeof raw === 'object') parsed = raw;
      }
    } catch {
      // An unreadable file is treated as "nothing chosen": sync stays blocked until a space is picked again.
      parsed = {};
    }
    for (const key of Object.keys(DEFAULT_SPACE_SETTINGS) as (keyof OpenCloudSpaceSettings)[]) {
      const v = parsed[key];
      this.value[key] = typeof v === 'string' ? v : DEFAULT_SPACE_SETTINGS[key];
    }
    this.value.spaceFolder = normalizeSpaceFolder(this.value.spaceFolder);
  }

  async save(next: Partial<OpenCloudSpaceSettings>): Promise<void> {
    Object.assign(this.value, next);
    this.value.spaceFolder = normalizeSpaceFolder(this.value.spaceFolder);
    if (!(await this.adapter.exists(this.pluginDir))) await this.adapter.mkdir(this.pluginDir);
    await this.adapter.write(this.path, JSON.stringify(this.value, null, 2));
  }
}
