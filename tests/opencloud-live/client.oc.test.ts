// OpenCloudClient against a live OpenCloud server: the IWebDAVClient contract the engine relies on.
import { createHash } from 'crypto';
import { OpenCloudClient } from '../../src/opencloud/OpenCloudClient';
import { SpaceNotFoundError } from '../../src/opencloud/errors';
import { PreconditionFailedError, RemoteRootMissingError } from '../../src/types';
import { ocEnv, settingsFor, spaceFor, uniqueFolder } from './support/env';

const env = ocEnv();
const enc = (s: string): ArrayBuffer => { const b = new TextEncoder().encode(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const sha1 = (b: ArrayBuffer): string => createHash('sha1').update(Buffer.from(b)).digest('hex');

function clientIn(folder: string): OpenCloudClient {
  return new OpenCloudClient(settingsFor(env, 'contract'), spaceFor(env, folder), () => env.token);
}

describe('OpenCloudClient (live)', () => {
  it('connects and reports the extended-protocol flags', async () => {
    const c = clientIn('');
    const f = await c.connect();
    expect(f).toMatchObject({ isNextcloud: true, hasAccountDav: true, hasBulkUpload: false, syncToken: null });
    expect(c.getCapabilities()).toMatchObject({ hasTus: true, hasVersions: true });
    expect(c.getCapabilities()!.tusMaxChunkBytes).toBeGreaterThan(0);
  });

  it('refuses a space that does not exist instead of listing it as empty', async () => {
    const c = new OpenCloudClient(settingsFor(env, 'contract'),
      { ...spaceFor(env, ''), spaceId: 'no-such-space', spaceName: 'Gone' }, () => env.token);
    await expect(c.connect()).rejects.toBeInstanceOf(SpaceNotFoundError);
  });

  it('uploads with SHA-1 and mtime, then lists the file with the same SHA-1, creating missing parents', async () => {
    const folder = uniqueFolder('upload');
    const c = clientIn(folder);
    await c.connect();
    expect(await c.createVaultRoot()).toBe('created');
    const body = enc('hello opencloud\n');
    await c.uploadFile('deep/er/note.md', body, Date.UTC(2023, 10, 14, 22, 13, 20));
    const stat = await c.statFile('deep/er/note.md');
    expect(stat).not.toBeNull();
    expect(stat!.checksum).toBe(sha1(body));
    expect(stat!.size).toBe(body.byteLength);
    expect(stat!.lastModified).toBe(Date.UTC(2023, 10, 14, 22, 13, 20));
    expect(stat!.fileId).toBeTruthy();
    expect(dec(await c.downloadFile('deep/er/note.md'))).toBe('hello opencloud\n');
  });

  it('walks nested folders with Depth: 1 and returns every file and folder', async () => {
    const folder = uniqueFolder('walk');
    const c = clientIn(folder);
    await c.connect();
    await c.createVaultRoot();
    const paths = ['a.md', 'x/b.md', 'x/y/c.md', 'x/y/z/d.md', 'w/e.md', 'Space name/ü ñ.md'];
    for (const p of paths) await c.uploadFile(p, enc(p));
    await c.createDirectory('empty/inner');
    const files = (await c.getFiles('')).map((f) => f.path).sort();
    expect(files).toEqual([...paths].sort());
    const dirs = (await c.getDirectories('')).map((d) => d.path).sort();
    expect(dirs).toEqual(['Space name', 'empty', 'empty/inner', 'w', 'x', 'x/y', 'x/y/z']);
    expect(await c.isRemoteDirEmpty('empty/inner')).toBe(true);
    expect(await c.isRemoteDirEmpty('x')).toBe(false);
  });

  it('changes the root ETag when a deep file changes', async () => {
    const folder = uniqueFolder('etag');
    const c = clientIn(folder);
    await c.connect();
    await c.createVaultRoot();
    await c.uploadFile('a/b/c.md', enc('one'));
    const before = await c.getRootEtag();
    await c.uploadFile('a/b/c.md', enc('two'));
    const after = await c.getRootEtag();
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('refuses an upload whose If-Match ETag is stale (lost-update guard)', async () => {
    const folder = uniqueFolder('ifmatch');
    const c = clientIn(folder);
    await c.connect();
    await c.createVaultRoot();
    await c.uploadFile('n.md', enc('v1'));
    const etag = (await c.statFile('n.md'))!.etag!;
    await c.uploadFile('n.md', enc('v2'), undefined, { ifMatchEtag: etag });
    await expect(c.uploadFile('n.md', enc('v3'), undefined, { ifMatchEtag: etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(dec(await c.downloadFile('n.md'))).toBe('v2');
  });

  it('uploads a large file through TUS in several chunks, atomically and with the right checksum', async () => {
    const folder = uniqueFolder('tus');
    const c = clientIn(folder);
    await c.connect();
    await c.createVaultRoot();
    const size = 23 * 1024 * 1024 + 123;
    const big = new Uint8Array(size);
    for (let i = 0; i < size; i++) big[i] = (i * 31 + 7) & 0xff;
    // Asks for 10 MiB chunks, above the server's 10,000,000-byte limit: the client must clamp.
    await c.uploadChunked('media/big.bin', big.buffer, 10 * 1024 * 1024, { mtime: Date.UTC(2024, 0, 2, 3, 4, 5) });
    const stat = await c.statFile('media/big.bin');
    expect(stat!.size).toBe(size);
    expect(stat!.checksum).toBe(sha1(big.buffer));
    expect(stat!.lastModified).toBe(Date.UTC(2024, 0, 2, 3, 4, 5));
  });

  it('refuses a TUS overwrite whose If-Match ETag is stale', async () => {
    const folder = uniqueFolder('tus-ifmatch');
    const c = clientIn(folder);
    await c.connect();
    await c.createVaultRoot();
    await c.uploadFile('f.bin', enc('original'));
    await expect(c.uploadChunked('f.bin', enc('replacement'), 1024, { ifMatchEtag: '"stale"' }))
      .rejects.toBeInstanceOf(PreconditionFailedError);
    expect(dec(await c.downloadFile('f.bin'))).toBe('original');
  });

  it('lists, reads and restores versions', async () => {
    const folder = uniqueFolder('versions');
    const c = clientIn(folder);
    await c.connect();
    await c.createVaultRoot();
    await c.uploadFile('v.md', enc('first'));
    await new Promise((r) => setTimeout(r, 1100)); // versions are keyed by mtime
    await c.uploadFile('v.md', enc('second'));
    const fileId = (await c.statFile('v.md'))!.fileId!;
    const versions = await c.listVersions(fileId);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const first = versions[versions.length - 1];
    expect(dec(await c.getVersionContent(first, fileId))).toBe('first');
    await c.restoreVersion(first, fileId);
    expect(dec(await c.downloadFile('v.md'))).toBe('first');
  });

  it('moves and deletes files; a missing sync folder is RemoteRootMissingError, not an empty listing', async () => {
    const folder = uniqueFolder('move');
    const c = clientIn(folder);
    await c.connect();
    await c.createVaultRoot();
    await c.uploadFile('old/name.md', enc('m'));
    await c.moveFile('old/name.md', 'new/place/name.md');
    expect(await c.statFile('old/name.md')).toBeNull();
    expect(dec(await c.downloadFile('new/place/name.md'))).toBe('m');
    await c.deleteFile('new/place/name.md', '');
    expect(await c.remoteExists('new/place/name.md')).toBe(false);

    const missing = clientIn(uniqueFolder('never-created'));
    await missing.connect();
    await expect(missing.getFiles('')).rejects.toBeInstanceOf(RemoteRootMissingError);
  });
});
