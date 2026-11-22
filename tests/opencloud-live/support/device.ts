// A SyncEngine "device" over upstream's in-memory FakeVault and a real OpenCloudClient: the fork's counterpart of
// tests/b1-nextcloud-headless/support/engineDevice.ts. Counts transfers so a test can prove a re-sync moves nothing.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { StateDB } from '../../../src/data/StateDB';
import { MergeBaseStore } from '../../../src/data/MergeBaseStore';
import { CleanSideStore } from '../../../src/data/CleanSideStore';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { DavSyncSettings, NextcloudFeatures } from '../../../src/types';
import { OpenCloudClient } from '../../../src/opencloud/OpenCloudClient';
import { FakeVault } from '../../b1-nextcloud-headless/support/fakeVault';
import { OcEnv, settingsFor, spaceFor } from './env';

const PLUGIN_DIR = '.obsidian/plugins/opencloud-sync';
const CONFIG_DIR = '.obsidian';

const noopStatusBar = {
  setStatus(): void {}, setProgress(): void {}, setConflictCount(): void {},
  setErrorCount(): void {}, setSyncComplete(): void {},
};

export interface TransferCounts { uploads: number; downloads: number; deletes: number; moves: number }

export interface Device {
  engine: SyncEngine;
  vault: FakeVault;
  stateDB: StateDB;
  client: OpenCloudClient;
  settings: DavSyncSettings;
  counts: TransferCounts;
  resetCounts(): void;
  sync(): Promise<void>;
}

export function makeDevice(
  env: OcEnv, folder: string, deviceId: string, over: Partial<DavSyncSettings> = {}, vault: FakeVault = new FakeVault(),
): Device {
  const settings = settingsFor(env, deviceId, over);
  const readToken = (): string => env.token;
  const localAdapter = new LocalAdapter(vault.adapter, vault.vault, undefined, async () => 'readOnly' as const);
  const stateDB = new StateDB(vault.adapter, PLUGIN_DIR, deviceId);
  const baseStore = new MergeBaseStore(vault.adapter, PLUGIN_DIR, deviceId);
  const cleanSideStore = new CleanSideStore(vault.adapter, PLUGIN_DIR, deviceId);
  const client = new OpenCloudClient(settings, spaceFor(env, folder), readToken);

  const counts: TransferCounts = { uploads: 0, downloads: 0, deletes: 0, moves: 0 };
  const wrap = <K extends keyof OpenCloudClient>(name: K, counter: keyof TransferCounts): void => {
    const original = (client[name] as (...a: unknown[]) => Promise<unknown>).bind(client);
    (client as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { counts[counter]++; return original(...args); };
  };
  wrap('uploadFile', 'uploads');
  wrap('uploadChunked', 'uploads');
  wrap('downloadFile', 'downloads');
  wrap('deleteFile', 'deletes');
  wrap('moveFile', 'moves');

  const webdavFactory = {
    async createClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
      return { client, features: await client.connect() };
    },
  };
  const engine = new SyncEngine({
    app: vault.app,
    settings,
    localAdapter,
    stateDB,
    baseStore,
    cleanSideStore,
    statusBar: noopStatusBar,
    webdavFactory,
    readAppPassword: readToken,
    pluginDir: PLUGIN_DIR,
    configDir: CONFIG_DIR,
  } as never);
  return {
    engine, vault, stateDB, client, settings, counts,
    resetCounts: () => { counts.uploads = 0; counts.downloads = 0; counts.deletes = 0; counts.moves = 0; },
    sync: () => engine.syncManual({ manual: true }),
  };
}
