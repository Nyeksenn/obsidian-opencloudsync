import { readFileSync } from 'fs';
import { join } from 'path';
import { requestUrl } from 'obsidian';
import { mkcolStrict } from '../../../src/network/remotePath';
import { RemoteDirCache } from '../../../src/network/RemoteDirCache';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import {
  DEFAULT_SETTINGS, DavSyncSettings, MISSING_PARENT_HINT, MissingParentFolderError, NetworkError, RemoteDirCreateError,
} from '../../../src/types';

// A Server URL whose trailing subfolder does not exist makes the vault-folder MKCOL answer 409. The message must say so
// (docs/spec.md §11.2) without changing what the plugin does.

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const BASE = 'https://nc/remote.php/dav/files/alice/Test';
const ctx = { baseUrl: BASE, authHeader: 'Basic redacted', timeoutMs: 0 };

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: `${BASE}/`,
  username: 'alice',
  // 0 = unbounded: keeps requestUrlWithTimeout from arming a real timer in the test process.
  networkTimeoutSeconds: 0,
};

const res = (status: number, text = ''): Promise<unknown> =>
  Promise.resolve({ status, text, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });

const HINT_FRAGMENT = 'a parent folder is missing';

beforeEach(() => mockRequestUrl.mockReset());

describe('[SPEC:SU-1] MKCOL 409 carries the missing-subfolder hint', () => {
  it('mkcolStrict: 409 rejects with MissingParentFolderError, keeping the HTTP 409 (MKCOL) prefix', async () => {
    mockRequestUrl.mockReturnValue(res(409));
    const error = await mkcolStrict(ctx, 'Vault').then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(MissingParentFolderError);
    expect(error).toBeInstanceOf(NetworkError);
    const failure = error as MissingParentFolderError;
    expect(failure.status).toBe(409);
    expect(failure.method).toBe('MKCOL');
    expect(failure.body).toBe('');
    expect(failure.message.startsWith('HTTP 409 (MKCOL)')).toBe(true);
    expect(failure.message).toContain(MISSING_PARENT_HINT);
    // [opencloud-fork] The fork creates the folder inside the space itself; the hint points at a removed space instead.
    expect(MISSING_PARENT_HINT).toContain('creates the folder inside the space itself');
    expect(MISSING_PARENT_HINT).toContain('Connect');
  });

  it('RemoteDirCreateError: a 409 from the ancestor MKCOL keeps its folder message and adds the hint', async () => {
    const error = await new RemoteDirCache().ensure('Vault', async () => 409).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteDirCreateError);
    const failure = error as RemoteDirCreateError;
    expect(failure.status).toBe(409);
    expect(failure.dirPath).toBe('Vault');
    expect(failure.message.startsWith("Could not create the remote folder 'Vault': MKCOL → HTTP 409")).toBe(true);
    expect(failure.message).toContain(MISSING_PARENT_HINT);
  });

  it.each([
    ['NextcloudClient', () => new NextcloudClient(settings, () => 'pw', 'Vault')],
    ['StandardWebDAVClient', () => new StandardWebDAVClient(settings, () => 'pw', 'Vault')],
  ])('%s: createVaultRoot rejects with the hint when the vault-folder MKCOL answers 409', async (_name, makeClient) => {
    mockRequestUrl.mockImplementation(() => res(409));
    const error = await makeClient().createVaultRoot().then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(MissingParentFolderError);
    expect((error as Error).message).toContain(HINT_FRAGMENT);
  });

  it.each([
    ['NextcloudClient', () => new NextcloudClient(settings, () => 'pw', 'Vault')],
    ['StandardWebDAVClient', () => new StandardWebDAVClient(settings, () => 'pw', 'Vault')],
  ])('%s: createDirectory surfaces the hint through RemoteDirCreateError', async (_name, makeClient) => {
    mockRequestUrl.mockImplementation(() => res(409));
    const error = await makeClient().createDirectory('F').then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteDirCreateError);
    expect((error as Error).message).toContain(HINT_FRAGMENT);
  });
});

describe('[SPEC:SU-2] no hint for anything but a MKCOL 409', () => {
  it('mkcolStrict: 201 and 405 are answers, not errors', async () => {
    mockRequestUrl.mockReturnValueOnce(res(201));
    await expect(mkcolStrict(ctx, 'Vault')).resolves.toBe('created');
    mockRequestUrl.mockReturnValueOnce(res(405));
    await expect(mkcolStrict(ctx, 'Vault')).resolves.toBe('exists');
  });

  it.each([401, 403, 404, 423, 500, 507])('mkcolStrict: %s stays a plain NetworkError without the hint', async (status) => {
    mockRequestUrl.mockReturnValue(res(status));
    const error = await mkcolStrict(ctx, 'Vault').then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(MissingParentFolderError);
    expect((error as Error).message).toBe(`HTTP ${status} (MKCOL)`);
  });

  it.each([0, 401, 403, 423, 500])('RemoteDirCreateError with status %s has no hint', async (status) => {
    const error = await new RemoteDirCache()
      .ensure('Vault', async () => { if (status === 0) throw new Error('network timeout'); return status; })
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteDirCreateError);
    expect((error as Error).message).not.toContain(HINT_FRAGMENT);
    expect((error as RemoteDirCreateError).status).toBe(status);
  });

  it('a 409 on another method (PUT) is not given the hint', async () => {
    mockRequestUrl.mockImplementation(() => res(409));
    const client = new NextcloudClient(settings, () => 'pw', 'Vault');
    // The retry path re-issues MKCOLs and fails at the first level; whatever is thrown for the PUT itself must not claim the hint.
    const error = await client.uploadFile('a.md', new ArrayBuffer(4)).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    // Only a failed MKCOL (RemoteDirCreateError) may carry it; a bare PUT NetworkError must not.
    if (!(error instanceof RemoteDirCreateError)) expect((error as Error).message).not.toContain(HINT_FRAGMENT);
  });

  it('the chunked-upload session MKCOL (dav/uploads) answering 409 keeps its bare message', async () => {
    mockRequestUrl.mockImplementation(() => res(409));
    const client = new NextcloudClient(settings, () => 'pw', 'Vault');
    const error = await client.uploadChunked('a.md', new ArrayBuffer(4), 1024).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toBe('HTTP 409 (MKCOL)');
  });
});

describe('[SPEC:SU-4] the README states the premise and how to check a 409', () => {
  // [opencloud-fork] README.md only (the Japanese README was removed), with the fork's premise: the plugin creates the
  // folder inside the space, so a 409 means the space or a parent folder was removed.
  const root = join(__dirname, '..', '..', '..');
  const en = readFileSync(join(root, 'README.md'), 'utf-8');

  it('README.md says the plugin creates the folder itself, names HTTP 409 (MKCOL) and what to check', () => {
    expect(en).toMatch(/creates the \*Folder in space\*/i);
    expect(en).toContain('HTTP 409 (MKCOL)');
    expect(en).toMatch(/space or a parent\s+folder was removed/i);
  });
});
