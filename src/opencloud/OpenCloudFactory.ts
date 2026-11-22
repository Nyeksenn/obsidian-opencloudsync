import { App } from 'obsidian';
import { AppPasswordReader, CredentialsNotFoundError, DavSyncSettings, NextcloudFeatures } from '../types';
import { IWebDAVClient } from '../network/IWebDAVClient';
import { WebDAVFactory } from '../network/WebDAVFactory';
import { getContentDigest } from '../util/hash';
import { OpenCloudClient } from './OpenCloudClient';
import { SpaceNotSelectedError } from './errors';
import type { OpenCloudSpaceSettings } from './forkSettings';

// Extends upstream's factory only so SyncEngine (typed against the WebDAVFactory class) takes it unchanged; nothing of
// the parent's Nextcloud / plain-WebDAV selection is used. There is no fallback client: this fork speaks to OpenCloud only.
export class OpenCloudFactory extends WebDAVFactory {
  constructor(
    app: App,
    private readonly ocSettings: DavSyncSettings,
    // Live object from ForkSettingsStore: a newly chosen space applies to the next client without a restart.
    private readonly space: OpenCloudSpaceSettings,
    private readonly readToken: AppPasswordReader,
    private readonly log?: (msg: string) => void,
  ) {
    super(app, ocSettings, readToken, log);
  }

  override async createClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    if (!this.readToken()) throw new CredentialsNotFoundError();
    if (!this.space.spaceId || !this.space.spaceWebDavUrl) throw new SpaceNotSelectedError();
    // The client reports SHA-1 checksums and the engine compares them with its own content hash; a mismatch would make
    // every uploaded file look changed. main.ts sets the digest at load, so this only guards against a wiring mistake.
    if (getContentDigest() !== 'SHA-1') throw new Error('Internal error: content digest is not SHA-1 (setContentDigest was not called).');
    const client = new OpenCloudClient(this.ocSettings, this.space, this.readToken, this.log);
    const features = await client.connect();
    return { client, features };
  }
}
