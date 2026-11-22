# OpenCloud Sync — fork specification addendum

This repository is a fork of [siosig/obsidian-nextcloudsync](https://github.com/siosig/obsidian-nextcloudsync) that syncs
an Obsidian vault with a space on an **OpenCloud** server. `docs/spec.md` and `docs/plan.md` are upstream's documents and
stay unchanged so upstream changes merge cleanly. Where they say "Nextcloud", this file says what the fork does instead.
The sync engine itself (`src/sync/`, `src/data/`, `src/sync/merge/`) is upstream's code, unmodified.

## Sign-in and sync target

The user enters three things in settings and picks a space:

| Setting | Stored in | Notes |
|---|---|---|
| Server URL | `data.json` (`serverUrl`) | Normalised to the server root; a pasted WebDAV, web UI or API URL is trimmed (`src/opencloud/serverUrl.ts`). |
| Username | `data.json` (`username`) | |
| App token | Obsidian SecretStorage (`passwordSecretId`) | An OpenCloud app token, never the account password. Sent as HTTP basic auth. |
| Space | `opencloud.json` in the plugin folder | Chosen from a dropdown after "Connect". |
| Folder in space | `opencloud.json` | Optional; `''` syncs into the space root. |

Every other URL is derived, not configured:

| What | URL |
|---|---|
| Spaces of the account | `<server>/graph/v1.0/me/drives` (personal + project spaces; the "Shares" virtual drive and disabled spaces are left out) |
| Files | the space's `root.webDavUrl` from Graph (`<server>/dav/spaces/<space id>`) |
| Capabilities | `<server>/ocs/v1.php/cloud/capabilities?format=json` |
| Maintenance / version | `<server>/status.php` |
| Versions of a file | `<server>/dav/meta/<file id>/v` |
| A file by id (version restore target) | `<server>/dav/spaces/<file id>` |
| Large uploads | TUS: `POST` to the parent folder's WebDAV URL, then `PATCH` the returned `Location` |

Why the space settings live in `opencloud.json` and not in `DavSyncSettings`: upstream's settings test requires every
`DEFAULT_SETTINGS` key to have one of upstream's settings rows. New keys there would break that test on every merge.

### Changing the sync target

Pointing an already-synced vault at another space or folder resets this device's tracking state first (after a
confirmation), exactly like the existing "Reset vault index" maintenance action. Without the reset, the state database
would describe files of the old target, and the first sync could read them as deleted on the new one.

### Errors that block a sync

| Error | When | Effect |
|---|---|---|
| `SpaceNotSelectedError` | no space chosen | sync refused with a notice pointing to the settings |
| `SpaceNotFoundError` | the chosen space is no longer listed for the account | sync refused; never treated as an empty listing (which would delete local files) |
| `OpenCloudAuthError` | HTTP 401 at connect | sync refused; check username / token (tokens can expire) |
| `OpenCloudMaintenanceError` | `status.php` reports maintenance | sync refused (a `MaintenanceModeError`, so upstream's handling applies) |

## How OpenCloud maps onto the engine

The engine talks to the server only through `IWebDAVClient` and the `NextcloudFeatures` flags. `OpenCloudClient` implements
the interface; `OpenCloudFactory` extends upstream's `WebDAVFactory` (the engine is typed against that class) and builds it.

| Flag | Value | Effect in the engine |
|---|---|---|
| `isNextcloud` | `true` | Means "speaks the extended protocol": root-ETag short-circuit of the full listing, and "the listing reports the checksum we upload". Both hold for OpenCloud. |
| `hasAccountDav` | `true` | Enables chunked upload (served by TUS) and version history (served by `/dav/meta`). |
| `hasFilesLocking` | `true` | LOCK/UNLOCK work; upstream keeps locking switched off anyway (`FIXED.fileLockingEnabled`). |
| `hasChecksums` | `true` | Informational only. |
| `hasBulkUpload` | `false` | — |
| `syncToken` | `null` | OpenCloud has no sync-collection REPORT on the files DAV. |

### Content hash: SHA-1

The engine compares its local content hash with the server's checksum and, after an upload, records `remoteId = localHash`.
OpenCloud offers SHA-1, MD5 and Adler-32, not SHA-256. `src/util/hash.ts` therefore lets the digest behind upstream's
`sha256()` be switched; `main.ts` calls `setContentDigest('SHA-1')` before anything is hashed, and `OpenCloudFactory`
refuses to build a client otherwise. Internal state records keep upstream's label `idType: 'sha256'` while holding SHA-1
values; the label is never shown, and the new plugin id means no SHA-256 state exists to be mixed in.

### Calls OpenCloud answers differently

| Call | OpenCloud behaviour |
|---|---|
| `getFiles` / `getDirectories` | `Depth: 1` walk (OpenCloud refuses `Depth: infinity` with 400), bounded by the network-concurrency setting |
| `uploadFile` | `PUT` with `OC-Checksum: SHA1:<hex>` (a wrong value is refused with 400) and `X-OC-Mtime` |
| `uploadChunked` | TUS creation-with-upload, chunks clamped to the server's `max_chunk_size` |
| `recalcChecksum` | `null` (no server-side recompute) |
| `setCreationTime` | `'rejected'` (no creation-time property); listings leave `creationTime` undefined |
| `restoreVersion` | `COPY` of the version onto `/dav/spaces/<file id>` |
| `lockFile` | RFC 4918 LOCK; the client remembers its tokens and sends `If: (<token>)` on its own writes, which OpenCloud requires |

## Server behaviour (verified)

Checked against `opencloudeu/opencloud-rolling` (product version 9.2.0) with the local server from `compose.yml`, and kept
true by the live layer (`pnpm test:oc`).

- **App tokens:** the auth-app service is on by default. `opencloud auth-app create --user-name=<user> --expiration=<dur>`
  prints a token (several words separated by spaces). Basic auth with `<user>:<token>` works on Graph and WebDAV; the
  account password does not (401).
- **Spaces:** `me/drives` lists `personal`, `project` and `virtual` ("Shares") drives with `id`, `name` and
  `root.webDavUrl`. Space and file ids contain `$` and `!`; hrefs show `!` as `%21`.
- **Capabilities:** checksums `sha1`, `md5`, `adler32` (preferred `sha1`); TUS 1.0.0 with `creation` and
  `creation-with-upload`, `max_chunk_size` 10,000,000; versioning on.
- **PROPFIND:** `oc:fileid`, `oc:checksums` (`SHA1:… MD5:… ADLER32:…`, present immediately after upload) and `getetag`
  are returned. `Depth: infinity` → 400. A change deep in the tree changes the space root's ETag. The file id survives a MOVE.
- **Writes:** `X-OC-Mtime` is honoured; a wrong `OC-Checksum` → 400; a stale `If-Match` → 412; `If-None-Match: *` is
  *not* honoured on an existing file.
- **Locks:** LOCK returns the token in the `Lock-Token` header; while locked, the holder's own PUT without `If:` → 423.
- **Versions:** `PROPFIND /dav/meta/<file id>/v` lists older versions (not the current one); `GET` reads one; `COPY` onto
  the file restores it.
- **TUS:** the file stays absent (404) until the last chunk; `Upload-Metadata` `mtime` (seconds) is honoured; a stale
  `If-Match` on the creating POST → 412; `Upload-Checksum` is *not* validated, so the client verifies the listed SHA-1
  after the upload instead.

## Upstream merge workflow

```bash
git remote add upstream https://github.com/siosig/obsidian-nextcloudsync.git   # once
git config merge.ours.driver true                                             # once: honours .gitattributes merge=ours
git fetch upstream
git merge upstream/main
pnpm build && pnpm lint && pnpm test && pnpm test:oc
```

Rules that keep this cheap:

1. Don't edit upstream-owned code: `src/sync/**`, `src/data/**`, `src/util/**` (except `hash.ts`),
   `src/network/**`, `docs/spec.md`, `docs/plan.md`, and upstream's tests. Upstream's Nextcloud and plain-WebDAV clients
   stay in the tree, never constructed, so upstream fixes to them still merge. They are still bundled into `main.js` (`WebDAVFactory` and the settings tab import them), which costs bundle size, not behaviour.
2. Fork code lives in new files: `src/opencloud/**`, `tests/a-no-nextcloud/opencloud/**`, `tests/opencloud-live/**`.
3. The few edits to shared files are marked `[opencloud-fork]`.
4. Files the fork owns completely (README, CHANGELOG, `manifest.json`, `versions.json`) resolve as "ours" via `.gitattributes`.
