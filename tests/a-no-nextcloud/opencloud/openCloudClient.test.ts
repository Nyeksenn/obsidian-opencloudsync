// [opencloud-fork] OpenCloudClient request shapes and safety guards, against the requestUrl mock (no server).
// The live layer (tests/opencloud-live) checks the same client against a real OpenCloud.
import { requestUrl } from 'obsidian';
import { createHash } from 'crypto';
import { OpenCloudClient, parseCapabilities, parseVersions } from '../../../src/opencloud/OpenCloudClient';
import { OpenCloudAuthError, OpenCloudMaintenanceError, SpaceNotFoundError, SpaceNotSelectedError } from '../../../src/opencloud/errors';
import type { OpenCloudSpaceSettings } from '../../../src/opencloud/forkSettings';
import {
  DEFAULT_SETTINGS, DavSyncSettings, MaintenanceModeError, NetworkError, PreconditionFailedError,
  RemoteListingUnreadableError, RemoteRootMissingError,
} from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const SERVER = 'https://oc.example';
const SPACE_ID = 'store$space';
const DAV = `${SERVER}/dav/spaces/${SPACE_ID}`;
const DAV_PATH = `/dav/spaces/${SPACE_ID}`;

const settings: DavSyncSettings = { ...DEFAULT_SETTINGS, serverUrl: SERVER, username: 'alice', deviceId: 'dev-1', networkConcurrency: 3 };
const space = (over: Partial<OpenCloudSpaceSettings> = {}): OpenCloudSpaceSettings => ({
  spaceId: SPACE_ID, spaceName: 'Personal', spaceWebDavUrl: DAV, spaceFolder: '', chosenOnServer: SERVER, ...over,
});
const token = (): string => 'word word word';

type Req = { url: string; method?: string; headers?: Record<string, string>; body?: unknown };
type Res = { status: number; text?: string; json?: unknown; headers?: Record<string, string>; arrayBuffer?: ArrayBuffer };
function respond(handler: (r: Req) => Res): Req[] {
  const calls: Req[] = [];
  mockRequestUrl.mockImplementation((r: Req) => {
    calls.push(r);
    const out = handler(r);
    return Promise.resolve({ text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {}, ...out });
  });
  return calls;
}

const CAPS = {
  ocs: { data: { capabilities: {
    checksums: { supportedTypes: ['sha1', 'md5', 'adler32'], preferredUploadType: 'sha1' },
    files: { versioning: true, tus_support: { version: '1.0.0', max_chunk_size: 10000000 } },
  } } },
};
const DRIVES = { value: [{ id: SPACE_ID, name: 'Personal', driveType: 'personal', root: { webDavUrl: DAV } }] };

function connectRoutes(r: Req): Res | null {
  if (r.url.endsWith('/status.php')) return { status: 200, json: { maintenance: false, productversion: '9.2.0' } };
  if (r.url.includes('/ocs/v1.php/cloud/capabilities')) return { status: 200, json: CAPS };
  if (r.url.endsWith('/graph/v1.0/me/drives')) return { status: 200, json: DRIVES };
  return null;
}

const entry = (href: string, opts: { dir?: boolean; sha1?: string; etag?: string; size?: number; fileId?: string } = {}): string => `
  <d:response><d:href>${href}</d:href><d:propstat><d:prop>
    <d:getetag>"${opts.etag ?? 'e'}"</d:getetag>
    <d:getcontentlength>${opts.size ?? 0}</d:getcontentlength>
    <d:getlastmodified>Tue, 14 Nov 2023 22:13:20 GMT</d:getlastmodified>
    <d:resourcetype>${opts.dir ? '<d:collection/>' : ''}</d:resourcetype>
    ${opts.sha1 ? `<oc:checksums><oc:checksum>SHA1:${opts.sha1} MD5:abc ADLER32:def</oc:checksum></oc:checksums>` : ''}
    <oc:fileid>${opts.fileId ?? 'fid'}</oc:fileid>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const multistatus = (...entries: string[]): string =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${entries.join('')}</d:multistatus>`;

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const sha1 = (b: ArrayBuffer): string => createHash('sha1').update(Buffer.from(b)).digest('hex');

beforeEach(() => mockRequestUrl.mockReset());

// PROPFIND parsing needs a DOMParser, which the a-layer node environment lacks (same polyfill as upstream's client tests).
let prevDOMParser: unknown;
beforeAll(() => {
  prevDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- test-only polyfill, as in upstream's statFile.test.ts
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = require('@xmldom/xmldom').DOMParser;
});
afterAll(() => { (globalThis as unknown as { DOMParser: unknown }).DOMParser = prevDOMParser; });

describe('OpenCloudClient: construction and connect', () => {
  it('refuses to exist without a chosen space', () => {
    expect(() => new OpenCloudClient(settings, space({ spaceId: '' }), token)).toThrow(SpaceNotSelectedError);
  });

  it('reports the extended-protocol flags and reads TUS / versions from the capabilities', async () => {
    respond((r) => connectRoutes(r) ?? { status: 500 });
    const c = new OpenCloudClient(settings, space(), token);
    expect(await c.connect()).toEqual({
      isNextcloud: true, version: '9.2.0', hasChecksums: true, hasFilesLocking: true,
      hasBulkUpload: false, hasAccountDav: true, syncToken: null,
    });
    expect(c.getCapabilities()).toEqual({ productVersion: '9.2.0', hasTus: true, tusMaxChunkBytes: 10000000, hasVersions: true });
  });

  it('sends basic auth with the app token, UTF-8 safe', async () => {
    const calls = respond((r) => connectRoutes(r) ?? { status: 500 });
    await new OpenCloudClient(settings, space(), token).connect();
    const caps = calls.find((r) => r.url.includes('capabilities'))!;
    expect(caps.headers!.Authorization).toBe(`Basic ${Buffer.from('alice:word word word').toString('base64')}`);
  });

  it('throws a maintenance error that is still a MaintenanceModeError', async () => {
    respond((r) => (r.url.endsWith('/status.php') ? { status: 200, json: { maintenance: true } } : { status: 500 }));
    const err = await new OpenCloudClient(settings, space(), token).connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenCloudMaintenanceError);
    expect(err).toBeInstanceOf(MaintenanceModeError);
  });

  it('turns a 401 on the capabilities into OpenCloudAuthError', async () => {
    respond((r) => (r.url.endsWith('/status.php') ? { status: 200, json: {} } : { status: 401 }));
    await expect(new OpenCloudClient(settings, space(), token).connect()).rejects.toBeInstanceOf(OpenCloudAuthError);
  });

  it('refuses a space the account no longer lists, instead of letting a listing come back empty', async () => {
    respond((r) => (r.url.endsWith('/me/drives') ? { status: 200, json: { value: [] } } : connectRoutes(r) ?? { status: 500 }));
    await expect(new OpenCloudClient(settings, space(), token).connect()).rejects.toBeInstanceOf(SpaceNotFoundError);
  });
});

describe('OpenCloudClient: listings', () => {
  it('walks the tree with Depth: 1 (never Depth: infinity) and returns every file and folder', async () => {
    const calls = respond((r) => {
      const path = decodeURIComponent(new URL(r.url).pathname);
      if (path === DAV_PATH) return { status: 207, text: multistatus(entry(`${DAV_PATH}/`, { dir: true }), entry(`${DAV_PATH}/a.md`, { sha1: 'a'.repeat(40) }), entry(`${DAV_PATH}/x/`, { dir: true })) };
      if (path === `${DAV_PATH}/x`) return { status: 207, text: multistatus(entry(`${DAV_PATH}/x/`, { dir: true }), entry(`${DAV_PATH}/x/b%20c.md`), entry(`${DAV_PATH}/x/y/`, { dir: true })) };
      if (path === `${DAV_PATH}/x/y`) return { status: 207, text: multistatus(entry(`${DAV_PATH}/x/y/`, { dir: true })) };
      return { status: 404 };
    });
    const c = new OpenCloudClient(settings, space(), token);
    const files = await c.getFiles('');
    expect(files.map((f) => f.path).sort()).toEqual(['a.md', 'x/b c.md']);
    expect(files.find((f) => f.path === 'a.md')!.checksum).toBe('a'.repeat(40));
    expect(files.find((f) => f.path === 'a.md')!.creationTime).toBeUndefined();
    expect(calls.every((r) => r.method === 'PROPFIND' && r.headers!.Depth === '1')).toBe(true);
    expect((await c.getDirectories('')).map((d) => d.path).sort()).toEqual(['x', 'x/y']);
  });

  it('scopes every path to the folder inside the space', async () => {
    respond((r) => {
      const path = decodeURIComponent(new URL(r.url).pathname);
      if (path === `${DAV_PATH}/Obsidian/Work`) {
        return { status: 207, text: multistatus(entry(`${DAV_PATH}/Obsidian/Work/`, { dir: true }), entry(`${DAV_PATH}/Obsidian/Work/n.md`)) };
      }
      return { status: 404 };
    });
    const files = await new OpenCloudClient(settings, space({ spaceFolder: 'Obsidian/Work' }), token).getFiles('');
    expect(files.map((f) => f.path)).toEqual(['n.md']);
  });

  it('reads a 404 on the sync root as RemoteRootMissingError, never as an empty vault', async () => {
    respond(() => ({ status: 404 }));
    await expect(new OpenCloudClient(settings, space(), token).getFiles('')).rejects.toBeInstanceOf(RemoteRootMissingError);
  });

  it('aborts the whole listing when any folder body is unreadable', async () => {
    respond((r) => {
      const path = decodeURIComponent(new URL(r.url).pathname);
      if (path === DAV_PATH) return { status: 207, text: multistatus(entry(`${DAV_PATH}/`, { dir: true }), entry(`${DAV_PATH}/x/`, { dir: true })) };
      return { status: 207, text: '<html>proxy error</html>' };
    });
    await expect(new OpenCloudClient(settings, space(), token).getFiles('')).rejects.toBeInstanceOf(RemoteListingUnreadableError);
  });

  it('ignores hrefs outside the space, also when syncing into the space root', async () => {
    const hrefs = [`${DAV_PATH}/../evil.md`, '/dav/spaces/other/x.md', `${DAV_PATH}-sibling/y.md`, 'https://elsewhere.example/z.md'];
    respond(() => ({ status: 207, text: multistatus(entry(`${DAV_PATH}/`, { dir: true }), ...hrefs.map((h) => entry(h)), entry(`${DAV_PATH}/ok.md`)) }));
    expect((await new OpenCloudClient(settings, space(), token).getFiles('')).map((f) => f.path)).toEqual(['ok.md']);
    respond(() => ({ status: 207, text: multistatus(entry(`${DAV_PATH}/sub/`, { dir: true }), ...hrefs.map((h) => entry(h)), entry(`${DAV_PATH}/sub/ok.md`)) }));
    expect((await new OpenCloudClient(settings, space({ spaceFolder: 'sub' }), token).getFiles('')).map((f) => f.path)).toEqual(['ok.md']);
  });

  it('statFile returns null for a folder and for 404, and throws on other failures', async () => {
    const c = new OpenCloudClient(settings, space(), token);
    respond(() => ({ status: 207, text: multistatus(entry(`${DAV_PATH}/f/`, { dir: true })) }));
    expect(await c.statFile('f')).toBeNull();
    respond(() => ({ status: 404 }));
    expect(await c.statFile('f')).toBeNull();
    respond(() => ({ status: 500 }));
    await expect(c.statFile('f')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('OpenCloudClient: uploads', () => {
  it('sends OC-Checksum SHA1 and X-OC-Mtime, recomputing a precomputed hash that is not SHA-1', async () => {
    const calls = respond(() => ({ status: 201 }));
    const body = enc('hello');
    await new OpenCloudClient(settings, space(), token).uploadFile('n.md', body, 1700000000123, { precomputedSha256: 'f'.repeat(64) });
    const put = calls.find((r) => r.method === 'PUT')!;
    expect(put.headers!['OC-Checksum']).toBe(`SHA1:${sha1(body)}`);
    expect(put.headers!['X-OC-Mtime']).toBe('1700000000');
  });

  it('uses a precomputed SHA-1 as is', async () => {
    const calls = respond(() => ({ status: 201 }));
    await new OpenCloudClient(settings, space(), token).uploadFile('n.md', enc('x'), undefined, { precomputedSha256: 'AB'.repeat(20) });
    expect(calls[0].headers!['OC-Checksum']).toBe(`SHA1:${'ab'.repeat(20)}`);
  });

  it('maps 412 to PreconditionFailedError and sends the If-Match ETag quoted', async () => {
    const calls = respond(() => ({ status: 412 }));
    await expect(new OpenCloudClient(settings, space(), token).uploadFile('n.md', enc('x'), undefined, { ifMatchEtag: 'abc' }))
      .rejects.toBeInstanceOf(PreconditionFailedError);
    expect(calls[0].headers!['If-Match']).toBe('"abc"');
  });

  it('creates missing parents and retries the PUT once', async () => {
    let puts = 0;
    const calls = respond((r) => {
      if (r.method === 'PUT') return { status: ++puts === 1 ? 409 : 201 };
      if (r.method === 'MKCOL') return { status: 201 };
      return { status: 500 };
    });
    await new OpenCloudClient(settings, space(), token).uploadFile('a/b/n.md', enc('x'));
    expect(calls.filter((r) => r.method === 'MKCOL').map((r) => decodeURIComponent(new URL(r.url).pathname))).toEqual([`${DAV_PATH}/a`, `${DAV_PATH}/a/b`]);
    expect(puts).toBe(2);
  });

  it('sends its own lock token on writes to a path it locked', async () => {
    const calls = respond((r) => (r.method === 'LOCK' ? { status: 200, headers: { 'lock-token': '<urn:uuid:1>' } } : { status: 204 }));
    const c = new OpenCloudClient(settings, space(), token);
    expect(await c.lockFile('n.md')).toBe('<urn:uuid:1>');
    await c.uploadFile('n.md', enc('x'));
    expect(calls.find((r) => r.method === 'PUT')!.headers!.If).toBe('(<urn:uuid:1>)');
    await c.unlockFile('n.md', '<urn:uuid:1>');
    await c.uploadFile('n.md', enc('y'));
    expect(calls.filter((r) => r.method === 'PUT')[1].headers!.If).toBeUndefined();
  });

  it('uploads through TUS in chunks no larger than the server allows, then verifies the SHA-1', async () => {
    const data = new Uint8Array(25).map((_, i) => i).buffer;
    const calls = respond((r) => {
      const c = connectRoutes(r);
      if (c) return c;
      if (r.method === 'MKCOL') return { status: 405 };
      if (r.method === 'POST') return { status: 201, headers: { Location: `${SERVER}/data/tus/abc`, 'Upload-Offset': '10' } };
      if (r.method === 'PATCH') {
        const off = Number(r.headers!['Upload-Offset']);
        return { status: 204, headers: { 'Upload-Offset': String(off + (r.body as ArrayBuffer).byteLength) } };
      }
      if (r.method === 'PROPFIND') return { status: 207, text: multistatus(entry(`${DAV_PATH}/m/big.bin`, { sha1: sha1(data), size: 25 })) };
      return { status: 500 };
    });
    // A server that caps chunks at 10 bytes; the strategy asks for 10 MiB.
    const caps = JSON.parse(JSON.stringify(CAPS)) as typeof CAPS;
    caps.ocs.data.capabilities.files.tus_support.max_chunk_size = 10;
    respondWithCaps(calls, caps);
    const c = new OpenCloudClient(settings, space(), token);
    await c.connect();
    await c.uploadChunked('m/big.bin', data, 10 * 1024 * 1024, { mtime: 1700000000999 });
    const post = calls.find((r) => r.method === 'POST')!;
    expect(decodeURIComponent(new URL(post.url).pathname)).toBe(`${DAV_PATH}/m`);
    expect(post.headers!['Upload-Length']).toBe('25');
    expect(post.headers!['Upload-Metadata']).toBe(`filename ${Buffer.from('big.bin').toString('base64')},mtime ${Buffer.from('1700000000').toString('base64')}`);
    expect((post.body as ArrayBuffer).byteLength).toBe(10);
    const patches = calls.filter((r) => r.method === 'PATCH');
    expect(patches.map((r) => r.headers!['Upload-Offset'])).toEqual(['10', '20']);
    expect(patches.map((r) => (r.body as ArrayBuffer).byteLength)).toEqual([10, 5]);
  });

  it('fails a TUS upload whose stored checksum differs from the bytes sent', async () => {
    respond((r) => {
      const c = connectRoutes(r);
      if (c) return c;
      if (r.method === 'MKCOL') return { status: 405 };
      if (r.method === 'POST') return { status: 201, headers: { Location: `${SERVER}/data/tus/abc`, 'Upload-Offset': '3' } };
      if (r.method === 'PROPFIND') return { status: 207, text: multistatus(entry(`${DAV_PATH}/f.bin`, { sha1: '0'.repeat(40) })) };
      return { status: 500 };
    });
    const c = new OpenCloudClient(settings, space(), token);
    await c.connect();
    // A NetworkError (like upstream's chunked-upload check), so the upload strategy retries with a single PUT.
    const err = await c.uploadChunked('f.bin', enc('abc'), 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).body).toMatch(/Checksum mismatch/);
  });
});

// Swaps the capabilities answer of an already-installed respond() handler.
function respondWithCaps(_calls: Req[], caps: unknown): void {
  const previous = mockRequestUrl.getMockImplementation() as (r: Req) => Promise<unknown>;
  mockRequestUrl.mockImplementation((r: Req) => {
    if (r.url.includes('/ocs/v1.php/cloud/capabilities')) {
      _calls.push(r);
      return Promise.resolve({ status: 200, text: '', json: caps, arrayBuffer: new ArrayBuffer(0), headers: {} });
    }
    return previous(r);
  });
}

describe('OpenCloud capability and version parsing', () => {
  it('requires SHA-1 checksums', () => {
    expect(() => parseCapabilities({ ocs: { data: { capabilities: { checksums: { supportedTypes: ['MD5'] }, files: {} } } } }))
      .toThrow(/SHA-1/);
  });

  it('reads a server without TUS or versions', () => {
    expect(parseCapabilities({ ocs: { data: { capabilities: { checksums: { supportedTypes: ['SHA1'] }, files: {} } } } }))
      .toEqual({ hasTus: false, tusMaxChunkBytes: 0, hasVersions: false });
  });

  it('lists versions newest first and skips the collection itself', () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/meta/s%21f/</d:href><d:propstat><d:prop/></d:propstat></d:response>
      <d:response><d:href>/dav/meta/s%21f/v/f.REV.2023-11-14T22:13:20Z</d:href><d:propstat><d:prop>
        <d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Tue, 14 Nov 2023 22:13:20 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
      <d:response><d:href>/dav/meta/s%21f/v/f.REV.2026-01-01T00:00:00Z</d:href><d:propstat><d:prop>
        <d:getcontentlength>3</d:getcontentlength><d:getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
    </d:multistatus>`;
    const v = parseVersions(xml);
    expect(v.map((x) => x.versionId)).toEqual(['f.REV.2026-01-01T00:00:00Z', 'f.REV.2023-11-14T22:13:20Z']);
    expect(v[1]).toMatchObject({ size: 12, href: '/dav/meta/s%21f/v/f.REV.2023-11-14T22:13:20Z' });
  });

  it('restores a version by COPY onto the file addressed by its id, using the server href unchanged', async () => {
    const calls = respond(() => ({ status: 204 }));
    await new OpenCloudClient(settings, space(), token).restoreVersion(
      { versionId: 'x', href: '/dav/meta/s%21f/v/x', lastModified: 0, size: 0 }, 's$p!f');
    expect(calls[0]).toMatchObject({ method: 'COPY', url: `${SERVER}/dav/meta/s%21f/v/x` });
    expect(calls[0].headers!.Destination).toBe(`${SERVER}/dav/spaces/${encodeURIComponent('s$p!f')}`);
  });
});
