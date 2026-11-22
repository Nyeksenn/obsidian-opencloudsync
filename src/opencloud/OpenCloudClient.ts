import { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { requestUrlWithTimeout } from '../network/requestWithTimeout';
import {
  AppPasswordReader,
  ConflictError,
  CredentialsNotFoundError,
  DavSyncSettings,
  FeatureUnsupportedError,
  FileLockedError,
  FileVersion,
  NetworkError,
  NextcloudFeatures,
  PreconditionFailedError,
  RemoteDirCreateError,
  RemoteDirInfo,
  RemoteFileInfo,
  RemoteRootMissingError,
  ServerLockedError,
  SyncChanges,
  VaultRootOutcome,
} from '../types';
import { IWebDAVClient } from '../network/IWebDAVClient';
import {
  encodeRemoteUrl, encodeServerUrl, ensureRemoteDir, hrefToRelative, isTransportFailure, mkcolStrict,
  prepareMissingParentRetry, toRemotePath,
} from '../network/remotePath';
import { RemoteDirCache } from '../network/RemoteDirCache';
import { NO_CACHE_HEADERS } from '../network/noCacheHeaders';
import {
  readDavProps, readHref, readIsCollection, readLockDiscoveryOwner, readMultistatus, readProp,
} from '../network/dav/propfind';
import { withRetry } from '../util/retry';
import { createLimiter } from '../util/ConcurrencyLimiter';
import { PARSE_YIELD_EVERY } from '../util/limits';
import { base64Utf8, basicAuthHeader, header, isSha1Hex, readJsonObject, readOpenCloudProps, sha1Hex, USER_AGENT } from './http';
import { OpenCloudAuthError, OpenCloudMaintenanceError, SpaceNotFoundError, SpaceNotSelectedError } from './errors';
import type { OpenCloudSpaceSettings } from './forkSettings';
import { listSpaces } from './spaces';
import { normalizeServerUrl } from './serverUrl';

// IWebDAVClient for one OpenCloud space (docs/opencloud.md). Request handling follows upstream's NextcloudClient; what differs
// is what OpenCloud does differently, each verified against a live server (docs/opencloud.md "Server behaviour"):
// - PROPFIND Depth: infinity is refused (400), so listings walk the tree with Depth: 1;
// - checksums are SHA-1 (no SHA-256), uploads carry `OC-Checksum: SHA1:<hex>`;
// - large uploads use TUS (no Nextcloud chunking v2);
// - versions live under /dav/meta/<fileid>/v and a version is restored by COPY onto the file addressed by its id;
// - there is no creation-time property and no server-side checksum recompute.

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getetag/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <oc:checksums/>
    <oc:fileid/>
  </d:prop>
</d:propfind>`;

const LOCKDISCOVERY_BODY = `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>`;
const LOCKINFO_BODY = `<?xml version="1.0" encoding="utf-8"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner>Obsidian OpenCloud Sync</d:owner></d:lockinfo>`;
const VERSIONS_BODY = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>`;
const TUS_VERSION = '1.0.0';

/** Capabilities read at connect time that the engine's feature flags cannot carry. */
export interface OpenCloudCapabilities {
  productVersion: string;
  hasTus: boolean;
  /** 0 = the server advertises no limit. */
  tusMaxChunkBytes: number;
  hasVersions: boolean;
}

interface ListingEntry {
  path: string;
  isDir: boolean;
  file?: RemoteFileInfo;
  dir?: RemoteDirInfo;
}

export class OpenCloudClient implements IWebDAVClient {
  private capabilities: OpenCloudCapabilities | null = null;
  private readonly createdDirs = new RemoteDirCache();
  // Lock tokens this client holds: OpenCloud refuses the lock holder's own write without them (423), unlike Nextcloud's user locks.
  private readonly heldLocks = new Map<string, string>();
  // The space's WebDAV root, as Graph reports it. Refreshed by connect() if the server moved it.
  private webDavUrl: string;

  constructor(
    private readonly settings: DavSyncSettings,
    private readonly space: OpenCloudSpaceSettings,
    private readonly readAppPassword: AppPasswordReader,
    private readonly diag?: (msg: string) => void,
  ) {
    if (!space.spaceId || !space.spaceWebDavUrl) throw new SpaceNotSelectedError();
    this.webDavUrl = space.spaceWebDavUrl.replace(/\/+$/, '');
  }

  /** Read after connect(); null before. */
  getCapabilities(): OpenCloudCapabilities | null { return this.capabilities; }

  // ---------------------------------------------------------------- URLs, auth, transport

  private get baseUrl(): string { return encodeServerUrl(this.webDavUrl); }
  private get remoteBase(): string { return this.space.spaceFolder; }

  // The server root as the server itself names it (OC_URL): the WebDAV root minus its /dav/spaces/<id> tail.
  private get serverRoot(): string {
    const i = this.webDavUrl.indexOf('/dav/spaces/');
    return i >= 0 ? this.webDavUrl.slice(0, i) : normalizeServerUrl(this.settings.serverUrl);
  }

  private get origin(): string { return new URL(this.webDavUrl).origin; }

  private remoteUrl(rel: string): string {
    return encodeRemoteUrl(this.baseUrl, toRemotePath(this.remoteBase, rel));
  }

  // Vault-relative path of a listing href, or null when it lies outside this space. Upstream's hrefToRelative keeps an href
  // that does not start with the base path as-is and relies on the sync-folder prefix to drop it; syncing into the space
  // root has no such prefix, so an href elsewhere on the server would become a vault file. Hence the explicit check first.
  private hrefToSyncPath(href: string): string | null {
    let pathname: string;
    let basePath: string;
    try {
      pathname = decodeURIComponent(new URL(href, this.baseUrl).pathname).replace(/\/+$/, '');
      basePath = decodeURIComponent(new URL(this.baseUrl).pathname).replace(/\/+$/, '');
    } catch {
      return null;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return null;
    return hrefToRelative(this.baseUrl, this.remoteBase, href);
  }

  // Read on every request so a changed token applies without a restart (docs/spec.md §15.2).
  private get authHeader(): string {
    const token = this.readAppPassword();
    if (!token) throw new CredentialsNotFoundError();
    return basicAuthHeader(this.settings.username, token);
  }

  private get timeoutMs(): number { return (this.settings.networkTimeoutSeconds ?? 0) * 1000; }

  private get dirCtx(): { baseUrl: string; authHeader: string; timeoutMs: number } {
    return { baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.authHeader, 'User-Agent': USER_AGENT, ...NO_CACHE_HEADERS, ...extra };
  }

  // A write to a path this client has locked must name the lock, or OpenCloud answers 423 to its own holder.
  private withLockToken(path: string, h: Record<string, string>): Record<string, string> {
    const token = this.heldLocks.get(path);
    return token ? { ...h, If: `(${token})` } : h;
  }

  private req(params: RequestUrlParam): Promise<RequestUrlResponse> {
    return requestUrlWithTimeout(params, this.timeoutMs);
  }

  // Same contract as upstream: req() rejects only when no HTTP response arrived, so a read-only request retries twice.
  private reqReadonly(params: RequestUrlParam): Promise<RequestUrlResponse> {
    return withRetry(() => this.req(params), 2, 1000, (err) => {
      this.diag?.(`reqReadonly retry: ${params.method ?? 'GET'} ${params.url} (${err instanceof Error ? err.message : String(err)})`);
      return true;
    });
  }

  private propfind(url: string, depth: '0' | '1', body = PROPFIND_BODY): Promise<RequestUrlResponse> {
    return this.reqReadonly({
      url, method: 'PROPFIND', body, throw: false,
      headers: this.headers({ Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }),
    });
  }

  // ---------------------------------------------------------------- connect

  async connect(): Promise<NextcloudFeatures> {
    const root = this.serverRoot;
    const productVersion = await this.probeStatus(root);
    this.capabilities = { ...(await this.probeCapabilities(root)), productVersion: productVersion };
    await this.verifySpace(root);

    // The flag names are upstream's. To the engine, `isNextcloud` means "the server speaks the extended protocol": it turns on
    // the root-ETag short-circuit (OpenCloud propagates ETags to the space root) and "the listing reports the checksums we
    // upload" (it does, as SHA-1). `hasAccountDav` gates chunked upload and version history, both served here by OpenCloud's
    // own endpoints; a server without TUS or versions makes those calls fail softly (PUT fallback / FeatureUnsupportedError).
    return {
      isNextcloud: true,
      version: productVersion,
      hasChecksums: true,
      hasFilesLocking: true,
      hasBulkUpload: false,
      hasAccountDav: true,
      syncToken: null,
    };
  }

  /** status.php (no credentials): maintenance mode stops here; returns the product version ('' when not reported). */
  private async probeStatus(root: string): Promise<string> {
    const res = await this.reqReadonly({ url: `${root}/status.php`, method: 'GET', headers: { ...NO_CACHE_HEADERS }, throw: false });
    if (res.status !== 200) return '';
    const body = readJsonObject(res);
    if (body?.maintenance === true) throw new OpenCloudMaintenanceError();
    const v = body?.productversion ?? body?.versionstring;
    return typeof v === 'string' ? v : '';
  }

  private async probeCapabilities(root: string): Promise<Omit<OpenCloudCapabilities, 'productVersion'>> {
    const res = await this.reqReadonly({
      url: `${root}/ocs/v1.php/cloud/capabilities?format=json`,
      method: 'GET',
      headers: this.headers({ 'OCS-APIRequest': 'true' }),
      throw: false,
    });
    if (res.status === 401) throw new OpenCloudAuthError();
    if (res.status !== 200) throw new NetworkError(res.status, res.text, 'GET');
    return parseCapabilities(readJsonObject(res));
  }

  // Refuses a space that is gone instead of letting a 404 listing reach the engine (an empty listing means "delete everything").
  private async verifySpace(root: string): Promise<void> {
    const token = this.readAppPassword();
    if (!token) throw new CredentialsNotFoundError();
    const spaces = await listSpaces({ serverUrl: root, username: this.settings.username, token, timeoutMs: this.timeoutMs });
    const found = spaces.find((s) => s.id === this.space.spaceId);
    if (!found) throw new SpaceNotFoundError(this.space.spaceName || this.space.spaceId);
    if (found.webDavUrl && found.webDavUrl !== this.webDavUrl) {
      this.diag?.(`space WebDAV URL changed: ${this.webDavUrl} -> ${found.webDavUrl}`);
      this.webDavUrl = found.webDavUrl;
    }
  }

  // ---------------------------------------------------------------- listings

  async getFiles(path: string): Promise<RemoteFileInfo[]> {
    const entries = await this.walk(path, 'getFiles');
    return entries.filter((e) => !e.isDir).map((e) => e.file!);
  }

  async getDirectories(path: string): Promise<RemoteDirInfo[]> {
    const entries = await this.walk(path, 'getDirectories');
    return entries.filter((e) => e.isDir).map((e) => e.dir!);
  }

  // Depth: 1 walk of the subtree under `rel` (OpenCloud refuses Depth: infinity), requests bounded by the network-concurrency
  // setting. The walk root itself is never returned. Only a 404 on the ROOT of a full listing is an error (the folder is gone,
  // which must never read as "no files"); deeper, a 404 is a subfolder that vanished mid-walk. Any unreadable body aborts the
  // whole call, so a partial listing can never be mistaken for a complete one.
  private async walk(rel: string, op: 'getFiles' | 'getDirectories'): Promise<ListingEntry[]> {
    const out: ListingEntry[] = [];
    const limit = createLimiter(Math.max(1, this.settings.networkConcurrency || 1));
    const visited = new Set<string>();
    const visit = async (dir: string): Promise<void> => {
      if (visited.has(dir)) return;
      visited.add(dir);
      const res = await limit(() => this.propfind(this.remoteUrl(dir), '1'));
      if (res.status === 404) {
        if (dir === rel && rel === '' && op === 'getFiles') throw new RemoteRootMissingError();
        return;
      }
      if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
      const entries = await this.parseListing(res.text, { op, path: dir, status: res.status, method: 'PROPFIND' });
      const children: string[] = [];
      for (const e of entries) {
        if (e.path === dir) continue; // the collection itself
        out.push(e);
        if (e.isDir) children.push(e.path);
      }
      await Promise.all(children.map(visit));
    };
    await visit(rel);
    return out;
  }

  async statFile(remotePath: string): Promise<RemoteFileInfo | null> {
    const res = await this.propfind(this.remoteUrl(remotePath), '0');
    if (res.status === 404) return null;
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    const entries = await this.parseListing(res.text, { op: 'statFile', path: remotePath, status: res.status, method: 'PROPFIND' });
    const hit = entries.find((e) => e.path === remotePath);
    return hit && !hit.isDir ? hit.file! : null;
  }

  async getRootEtag(): Promise<string | null> {
    // OpenCloud propagates every descendant change to the root ETag (verified), so one Depth: 0 request can skip a full walk.
    try {
      const res = await this.propfind(this.remoteUrl(''), '0');
      if (res.status !== 207) return null;
      const responses = readMultistatus(res.text, { op: 'getRootEtag', path: '', status: res.status, method: 'PROPFIND' });
      const prop = responses[0] ? readProp(responses[0]) : null;
      const etag = prop ? readDavProps(prop).etag : null;
      return etag && etag.length > 0 ? etag : null;
    } catch {
      return null;
    }
  }

  async isRemoteDirEmpty(path: string): Promise<boolean> {
    const res = await this.propfind(this.remoteUrl(path), '1');
    if (res.status !== 207) return false;
    try {
      const entries = await this.parseListing(res.text, { op: 'isRemoteDirEmpty', path, status: res.status, method: 'PROPFIND' });
      return entries.every((e) => e.path === path);
    } catch {
      return false; // an unreadable body is exactly the ambiguity a recursive DELETE must never act on
    }
  }

  async remoteExists(remotePath: string): Promise<boolean> {
    try {
      const res = await this.propfind(this.remoteUrl(remotePath), '0');
      return res.status !== 404;
    } catch {
      return true; // conservative: never report "gone" on a failed check
    }
  }

  // No sync-collection REPORT on OpenCloud's files DAV; the engine only calls getChanges with a token, and there never is one.
  async getSyncToken(): Promise<string | null> { return null; }

  async getChanges(_syncToken: string): Promise<SyncChanges> {
    throw new FeatureUnsupportedError('sync-token');
  }

  private async parseListing(
    xml: string, ctx: { op: string; path: string; status: number; method: 'PROPFIND' | 'REPORT' },
  ): Promise<ListingEntry[]> {
    const responses = readMultistatus(xml, ctx);
    const out: ListingEntry[] = [];
    for (let i = 0; i < responses.length; i++) {
      // Yield so a large folder does not freeze the UI or trigger an Android ANR.
      if (i > 0 && i % PARSE_YIELD_EVERY === 0) await new Promise((r) => window.setTimeout(r, 0));
      const resp = responses[i];
      const prop = readProp(resp);
      if (!prop) continue;
      const path = this.hrefToSyncPath(readHref(resp));
      if (path === null) continue; // outside the sync root, or an unsafe path
      const { etag, size, lastModified } = readDavProps(prop);
      const { checksum, fileId } = readOpenCloudProps(prop);
      if (readIsCollection(prop)) {
        out.push({ path, isDir: true, dir: { path, fileId, etag, lastModified } });
      } else {
        // creationTime stays undefined: OpenCloud has no creation-time property, so there is nothing to align (docs/spec.md §9.7).
        out.push({ path, isDir: false, file: { path, fileId, checksum, etag, size, lastModified } });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- folders

  async createDirectory(path: string): Promise<void> {
    // ensureRemoteDir creates every segment except the last (it expects a file name), hence the dummy segment.
    await ensureRemoteDir(this.dirCtx, toRemotePath(this.remoteBase, `${path}/_`), this.createdDirs);
  }

  async createVaultRoot(): Promise<VaultRootOutcome> {
    // Syncing into the space root: there is no folder to create, and 'exists' keeps the caller off its re-seed path.
    if (!this.remoteBase) return 'exists';
    const ctx = this.dirCtx;
    await ensureRemoteDir(ctx, this.remoteBase, this.createdDirs).catch(() => undefined);
    const outcome = await mkcolStrict(ctx, this.remoteBase);
    if (outcome === 'created') this.createdDirs.clear();
    return outcome;
  }

  async deleteCollection(path: string): Promise<void> {
    const res = await this.req({ url: this.remoteUrl(path), method: 'DELETE', headers: this.headers(), throw: false });
    if (res.status === 404) return;
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'DELETE');
  }

  // ---------------------------------------------------------------- files

  async downloadFile(remotePath: string): Promise<ArrayBuffer> {
    const res = await this.reqReadonly({ url: this.remoteUrl(remotePath), method: 'GET', headers: this.headers(), throw: false });
    if (res.status !== 200) throw new NetworkError(res.status, '', 'GET');
    return res.arrayBuffer;
  }

  async uploadFile(
    remotePath: string, data: ArrayBuffer, mtime?: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null; ctime?: number },
  ): Promise<void> {
    // The engine's precomputed hash is SHA-1 in this fork (docs/opencloud.md); anything else is recomputed, because OpenCloud
    // rejects a wrong OC-Checksum with 400.
    const sum = isSha1Hex(opts?.precomputedSha256) ? opts.precomputedSha256.toLowerCase() : await sha1Hex(data);
    let h: Record<string, string> = this.headers({ 'OC-Checksum': `SHA1:${sum}` });
    if (mtime) h['X-OC-Mtime'] = String(Math.floor(mtime / 1000));
    if (opts?.ifMatchEtag) h['If-Match'] = quoteEtag(opts.ifMatchEtag);
    h = this.withLockToken(remotePath, h);

    const put = () => this.req({ url: this.remoteUrl(remotePath), method: 'PUT', headers: h, body: data, throw: false });
    let res = await put();
    // Missing parent: create the ancestors, then retry once.
    let dirError: RemoteDirCreateError | null = null;
    if (res.status === 409 || res.status === 404) {
      dirError = await prepareMissingParentRetry(this.dirCtx, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
      if (isTransportFailure(dirError)) throw dirError;
      res = await put();
    }
    if (res.status === 412) throw new PreconditionFailedError(remotePath);
    if (res.status === 423) await this.errorFor423(remotePath, 'PUT', res.text);
    if (res.status < 200 || res.status >= 300) throw dirError ?? new NetworkError(res.status, res.text, 'PUT');
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    const ctx = this.dirCtx;
    const target = toRemotePath(this.remoteBase, newPath);
    // Speculative parent creation; its failure cannot explain an unrelated MOVE failure, so it is discarded (see upstream).
    await ensureRemoteDir(ctx, target, this.createdDirs).catch((err) => {
      if (!(err instanceof RemoteDirCreateError)) throw err;
    });
    const move = () => this.req({
      url: this.remoteUrl(oldPath),
      method: 'MOVE',
      headers: this.withLockToken(oldPath, this.headers({ Destination: this.remoteUrl(newPath), Overwrite: 'F' })),
      throw: false,
    });
    let res = await move();
    let dirError: RemoteDirCreateError | null = null;
    if (res.status === 409 || res.status === 404) {
      dirError = await prepareMissingParentRetry(ctx, target, this.createdDirs);
      if (isTransportFailure(dirError)) throw dirError;
      res = await move();
    }
    if (res.status === 412) throw new ConflictError(newPath);
    if (res.status < 200 || res.status >= 300) throw dirError ?? new NetworkError(res.status, res.text, 'MOVE');
  }

  async deleteFile(path: string, _expectedRemoteId: string): Promise<void> {
    const res = await this.req({ url: this.remoteUrl(path), method: 'DELETE', headers: this.withLockToken(path, this.headers()), throw: false });
    if (res.status === 404) return;
    if (res.status === 423) await this.errorFor423(path, 'DELETE', res.text);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'DELETE');
  }

  // OpenCloud has no server-side recompute; callers fall back to content comparison.
  async recalcChecksum(_remotePath: string): Promise<string | null> { return null; }

  // OpenCloud has no creation-time property. 'rejected' is the engine's permanent "cannot express it" answer.
  async setCreationTime(_remotePath: string, _seconds: number): Promise<'applied' | 'rejected'> { return 'rejected'; }

  // Always throws: ServerLockedError naming the owner when lockdiscovery says who holds it, else the plain 423.
  private async errorFor423(path: string, method: 'PUT' | 'DELETE', originalText: string): Promise<never> {
    try {
      const res = await this.propfind(this.remoteUrl(path), '0', LOCKDISCOVERY_BODY);
      if (res.status === 207) {
        const owner = readLockDiscoveryOwner(res.text);
        if (owner) throw new ServerLockedError(path, method, owner);
      }
    } catch (err) {
      if (err instanceof ServerLockedError) throw err;
    }
    throw new NetworkError(423, originalText, method);
  }

  // ---------------------------------------------------------------- TUS upload (uploadChunked)

  async uploadChunked(
    remotePath: string, data: ArrayBuffer, chunkSizeBytes: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null; mtime?: number; ctime?: number },
  ): Promise<void> {
    const caps = this.capabilities;
    // A NetworkError makes the upload strategy fall back to a single PUT.
    if (caps && !caps.hasTus) throw new NetworkError(501, 'the server does not support TUS uploads', 'POST');
    const max = caps?.tusMaxChunkBytes ?? 0;
    const chunkSize = Math.max(1, max > 0 ? Math.min(chunkSizeBytes, max) : chunkSizeBytes);
    const total = data.byteLength;
    const sum = isSha1Hex(opts?.precomputedSha256) ? opts.precomputedSha256.toLowerCase() : await sha1Hex(data);

    const full = toRemotePath(this.remoteBase, remotePath);
    const slash = full.lastIndexOf('/');
    const parent = slash >= 0 ? full.slice(0, slash) : '';
    const name = slash >= 0 ? full.slice(slash + 1) : full;
    // The parent must exist before the upload is created; a failure is kept to explain a later 404/409.
    let dirError: RemoteDirCreateError | null = null;
    try {
      await ensureRemoteDir(this.dirCtx, full, this.createdDirs);
    } catch (err) {
      if (!(err instanceof RemoteDirCreateError)) throw err;
      if (isTransportFailure(err)) throw err;
      dirError = err;
    }

    const metadata = [`filename ${base64Utf8(name)}`];
    if (opts?.mtime) metadata.push(`mtime ${base64Utf8(String(Math.floor(opts.mtime / 1000)))}`);
    const first = data.slice(0, Math.min(chunkSize, total));
    const createHeaders = this.headers({
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(total),
      'Upload-Metadata': metadata.join(','),
      'Content-Type': 'application/offset+octet-stream',
    });
    if (opts?.ifMatchEtag) createHeaders['If-Match'] = quoteEtag(opts.ifMatchEtag);

    // creation-with-upload: the first chunk travels with the POST.
    const created = await this.req({
      url: encodeRemoteUrl(this.baseUrl, parent), method: 'POST', headers: createHeaders, body: first, throw: false,
    });
    if (created.status === 412) throw new PreconditionFailedError(remotePath);
    if (created.status === 404 || created.status === 409) throw dirError ?? new NetworkError(created.status, created.text, 'POST');
    if (created.status !== 201) throw new NetworkError(created.status, created.text, 'POST');
    const location = header(created, 'location');
    if (!location) throw new NetworkError(created.status, 'TUS create returned no Location', 'POST');
    const uploadUrl = new URL(location, this.origin).toString();

    let offset = Number(header(created, 'upload-offset') ?? first.byteLength);
    try {
      while (offset < total) {
        const end = Math.min(offset + chunkSize, total);
        const res = await this.req({
          url: uploadUrl,
          method: 'PATCH',
          headers: this.headers({
            'Tus-Resumable': TUS_VERSION,
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          }),
          body: data.slice(offset, end),
          throw: false,
        });
        if (res.status !== 204 && res.status !== 200) throw new NetworkError(res.status, res.text, 'PATCH');
        const next = Number(header(res, 'upload-offset') ?? end);
        if (!(next > offset)) throw new NetworkError(res.status, `TUS upload made no progress at offset ${offset}`, 'PATCH');
        offset = next;
      }
    } catch (err) {
      // Best-effort termination so the server can drop the partial upload; the final path never shows it (TUS is atomic).
      await this.req({ url: uploadUrl, method: 'DELETE', headers: this.headers({ 'Tus-Resumable': TUS_VERSION }), throw: false })
        .catch(() => undefined);
      throw err;
    }

    // The upload completes atomically; confirm the server holds exactly these bytes before the engine records them.
    const stat = await this.statFile(remotePath);
    if (stat?.checksum && stat.checksum !== sum) {
      throw new NetworkError(0, `Checksum mismatch after TUS upload: ${remotePath}`);
    }
  }

  // ---------------------------------------------------------------- versions

  async listVersions(fileId: string): Promise<FileVersion[]> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    if (this.capabilities && !this.capabilities.hasVersions) throw new FeatureUnsupportedError('versions');
    const res = await this.propfind(`${this.serverRoot}/dav/meta/${encodeURIComponent(fileId)}/v`, '1', VERSIONS_BODY);
    if (res.status === 404) return [];
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    return parseVersions(res.text);
  }

  async getVersionContent(version: FileVersion, fileId: string): Promise<ArrayBuffer> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    const res = await this.reqReadonly({ url: this.versionUrl(version), method: 'GET', headers: this.headers(), throw: false });
    if (res.status !== 200) throw new NetworkError(res.status, '', 'GET');
    return res.arrayBuffer;
  }

  async restoreVersion(version: FileVersion, fileId: string): Promise<void> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    // The interface hands over the file id, not its path; OpenCloud addresses a resource by id under /dav/spaces/<id>.
    const res = await this.req({
      url: this.versionUrl(version),
      method: 'COPY',
      headers: this.headers({ Destination: `${this.serverRoot}/dav/spaces/${encodeURIComponent(fileId)}` }),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'COPY');
  }

  // The server's own href, already encoded, is used as-is: re-encoding it would double-encode the id's `%21`.
  private versionUrl(version: FileVersion): string {
    return /^https?:\/\//i.test(version.href) ? version.href : `${this.origin}${version.href}`;
  }

  // ---------------------------------------------------------------- locks

  async lockFile(remotePath: string): Promise<string> {
    const res = await this.req({
      url: this.remoteUrl(remotePath),
      method: 'LOCK',
      headers: this.headers({ Timeout: 'Second-300', 'Content-Type': 'application/xml; charset=utf-8' }),
      body: LOCKINFO_BODY,
      throw: false,
    });
    if (res.status === 423) throw new FileLockedError(remotePath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'LOCK');
    const token = (header(res, 'lock-token') ?? '').trim();
    if (token) this.heldLocks.set(remotePath, token);
    return token;
  }

  async unlockFile(remotePath: string, token: string): Promise<void> {
    this.heldLocks.delete(remotePath);
    try {
      await this.req({ url: this.remoteUrl(remotePath), method: 'UNLOCK', headers: this.headers({ 'Lock-Token': token }), throw: false });
    } catch {
      // Best-effort; the lock times out on the server.
    }
  }
}

function quoteEtag(etag: string): string {
  return `"${etag.replace(/^"|"$/g, '')}"`;
}

export function parseCapabilities(body: Record<string, unknown> | null): Omit<OpenCloudCapabilities, 'productVersion'> {
  const ocs = body?.ocs as Record<string, unknown> | undefined;
  const data = ocs?.data as Record<string, unknown> | undefined;
  const caps = data?.capabilities as Record<string, unknown> | undefined;
  if (!caps) throw new NetworkError(200, 'capabilities response has no ocs.data.capabilities', 'GET');
  const checksums = caps.checksums as Record<string, unknown> | undefined;
  const types = Array.isArray(checksums?.supportedTypes) ? (checksums.supportedTypes as unknown[]).map((t) => String(t).toLowerCase()) : [];
  // The engine compares local and remote content by hash; without SHA-1 every file would look changed after each upload.
  if (!types.includes('sha1')) {
    throw new Error('This server does not offer SHA-1 checksums, which OpenCloud Sync needs. Is this an OpenCloud server?');
  }
  const files = caps.files as Record<string, unknown> | undefined;
  const tus = files?.tus_support as Record<string, unknown> | undefined;
  const maxChunk = Number(tus?.max_chunk_size ?? 0);
  return {
    hasTus: !!tus && typeof tus.version === 'string',
    tusMaxChunkBytes: Number.isFinite(maxChunk) && maxChunk > 0 ? maxChunk : 0,
    hasVersions: files?.versioning === true,
  };
}

// Version entries are the children of /dav/meta/<fileid>/v; the collection itself (href ending in '/') is skipped.
export function parseVersions(xml: string): FileVersion[] {
  const versions: FileVersion[] = [];
  const responses = readMultistatus(xml, { op: 'listVersions', path: '', status: 207, method: 'PROPFIND' });
  for (const resp of responses) {
    const href = readHref(resp);
    if (!href || href.endsWith('/') || !href.includes('/v/')) continue;
    const segments = href.split('/').filter(Boolean);
    const versionId = decodeURIComponent(segments[segments.length - 1] ?? '');
    if (!versionId) continue;
    const prop = readProp(resp);
    const { size, lastModified } = prop ? readDavProps(prop) : { size: 0, lastModified: 0 };
    versions.push({ versionId, href, lastModified, size });
  }
  return versions.sort((a, b) => b.lastModified - a.lastModified);
}
