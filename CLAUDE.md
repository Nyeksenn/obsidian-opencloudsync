# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

"OpenCloud Sync" (plugin id `opencloud-sync`): an Obsidian plugin that syncs a vault with a **space on an OpenCloud
server**. It is a fork of `siosig/obsidian-nextcloudsync` ("Nextcloud Sync"). The fork keeps upstream's sync engine
**unmodified** and replaces only the server side, so that upstream improvements keep merging in. That constraint shapes
every change; read "Fork rules" below before editing anything outside `src/opencloud/`.

- Fork specification, server behaviour, merge workflow: `docs/opencloud.md` (read this first).
- Upstream's behavioural spec and design: `docs/spec.md`, `docs/plan.md`. They say "Nextcloud"; `docs/opencloud.md`
  says what differs.
- User docs: `.github/README.md` (the fork's README; the root `README.md` is upstream's, pinned by upstream tests).

## Fork rules

1. **Don't edit upstream-owned code**: `src/sync/**`, `src/data/**`, `src/network/**`, `src/util/**` (except
   `hash.ts`), `src/ui/**`, `docs/spec.md`, `docs/plan.md`, root `README*.md` / `CHANGELOG*.md`, and every existing test
   (`tests/a-no-nextcloud/**` outside `opencloud/`, `tests/b*`, `tests/docker/`). No renames, moves or reformatting.
2. **Fork code lives in new files**: `src/opencloud/**`, `tests/a-no-nextcloud/opencloud/**`, `tests/opencloud-live/**`,
   `docs/opencloud.md`, `.github/README.md`, `CHANGELOG.opencloud.md`.
3. **Unavoidable edits to shared files are marked `[opencloud-fork]`** and kept to a few lines: `src/main.ts`,
   `src/settings/SettingTab.ts`, `src/util/hash.ts`, `src/ui/StatusBarItem.ts`, `jest.config.js`, `.githooks/*`.
   Check with `git diff 21f8902 --stat -- src` (21f8902 = upstream 1.0.18): the engine must show no changes.
4. Prefer **wrapping over editing**: e.g. settings rows are built by upstream's `buildSettingDefinitions()` and then
   transformed by `src/opencloud/settingsGroup.ts`; `OpenCloudFactory` *extends* `WebDAVFactory`.
5. Upstream tests pin some files and strings (settings rows and `DEFAULT_SETTINGS` keys, README sections, the ribbon
   label). If a change would break one, find a fork-side way instead of editing the test.

## Commands

pnpm is required (version pinned by `packageManager` in `package.json`, Node 26).

```bash
pnpm install                 # also sets core.hooksPath=.githooks via "prepare"
pnpm dev                     # esbuild watch build -> ./main.js (OUTDIR=<vault>/.obsidian/plugins/opencloud-sync to build into a vault)
pnpm build                   # tsc --noEmit + production bundle
pnpm lint                    # eslint src (mirrors the Obsidian community-directory reviewer)
pnpm test                    # layer "a": upstream's unit suite + the fork's (tests/a-no-nextcloud/opencloud/)
pnpm test tests/a-no-nextcloud/opencloud/openCloudClient.test.ts   # single file
pnpm test -t 'TUS'           # single test by name
pnpm test:oc                 # live OpenCloud layer (needs the dev server below); exits 3 if it is not running
```

Local OpenCloud dev server (rootless Podman, `compose.yml`): `podman-compose up -d`, web UI `https://localhost:8080`
as **admin / admin**. Sync needs an app token, not the password:
`podman exec opencloud-dev opencloud auth-app create --user-name=admin --expiration=720h`. Details: `docs/local-opencloud.md`.

Upstream's live layers (`bash tests/docker/run.sh <b1|b2|b3|b4>`, Docker, see `tests/README.md`) target Nextcloud /
plain WebDAV and are not part of the fork's gate; they matter only when an upstream merge touches shared helpers.

## Architecture

- `src/main.ts` — plugin host: init, DI, lifecycle, commands, triggers. Fork edits: `setContentDigest('SHA-1')` at load,
  loads `ForkSettingsStore` (`opencloud.json`), builds `OpenCloudFactory`.
- `src/sync/SyncEngine.ts` (upstream) — composition root and core loop: `runSyncSession` → `ensureClient` →
  `initialSync` | `incrementalSync`; three-point comparison (local / remote / last-synced state) and the per-file
  decision. Extracted modules under `src/sync/` (`transfer/`, `deletion/`, `directory/`, `mirror/`, `conflict/`, …)
  follow docs/plan.md §17.1. The engine reaches the server **only** through `IWebDAVClient`
  (`src/network/IWebDAVClient.ts`) and the `NextcloudFeatures` flags.
- `src/opencloud/` (fork):
  - `OpenCloudClient.ts` implements `IWebDAVClient` for one space. Depth-1 listing walk (OpenCloud refuses
    `Depth: infinity`), SHA-1 checksums, TUS for `uploadChunked`, versions under `/dav/meta/<fileid>/v`, restore by
    `COPY` onto `/dav/spaces/<fileid>`. `connect()` sets `isNextcloud: true` / `hasAccountDav: true` (meaning "extended
    protocol") and refuses a missing space (`SpaceNotFoundError`), since an empty listing would read as "delete everything".
  - `OpenCloudFactory.ts` extends upstream's `WebDAVFactory` (the engine is typed against that class); guards: token,
    space chosen, space chosen on the current server, SHA-1 digest active.
  - `spaces.ts` (Graph `me/drives`), `serverUrl.ts` (normalise to the server root), `forkSettings.ts` (space choice in
    `opencloud.json`, not `data.json`, because upstream tests pin `DEFAULT_SETTINGS`' keys), `errors.ts`.
  - `settingsGroup.ts` / `settingsTab.ts` — replace upstream's "Nextcloud" settings group with the OpenCloud group
    (server URL, username, app token, Connect, space picker, folder in space). Changing the target confirms and resets
    the tracking state (`syncEngine.resetIndex()`).
- `src/util/hash.ts` — `sha256()` hashes with a switchable digest (default SHA-256 for upstream's tests; the fork sets
  SHA-1 to match OpenCloud's checksums). State records keep the label `idType: 'sha256'`.
- Upstream's `NextcloudClient`, `StandardWebDAVClient` and `LoginFlowV2` stay in the tree, never constructed.

## Tests

- `tests/a-no-nextcloud/opencloud/` — fork unit tests (client request shapes against the `requestUrl` mock, factory
  guards, settings swap over upstream's real `buildSettingDefinitions()`). They carry no `[SPEC:…]` tags, so upstream's
  clause catalog (`tests/a-no-nextcloud/spec-coverage/clauses.ts`) stays untouched.
- `tests/opencloud-live/` (`jest.opencloud.config.js`, run via `run.sh`) — client contract and two-device engine tests
  against the dev server. Reuses upstream's live `obsidian` mock and `FakeVault` from `tests/b1-nextcloud-headless/`.
  Each run gets a fresh project space and trusts the server certificate via `NODE_EXTRA_CA_CERTS` (checks stay on).
- Upstream's spec-driven rules still apply to upstream code: `docs/spec.md` clauses, `[SPEC:<id>]` tags, `clauses.ts`,
  `coverage.test.ts`, and `docsReferences.test.ts` (every `docs/spec.md §…` reference in a comment must exist).
- `jest.config.js` skips upstream's `sliderLimits.test.ts` while its private `specs/` mockup is absent.

## Hooks and conventions

`.githooks/` (installed by `pnpm install`):

- **commit-msg**: no Japanese/CJK in commit messages.
- **pre-commit**: secretlint on staged files; no CJK in staged files except `*.ja*`. (Upstream's author-email gate is removed.)
- **pre-push**: lint, build, `.github/README.md` names the `manifest.json` version in a "What's new (x.y.z)" heading
  and mentions `minAppVersion`; stable versions need `[x.y.z]` in `CHANGELOG.opencloud.md`; `pnpm test`; `pnpm test:oc`
  (skipped with a notice when no dev server runs).

Conventions:

- English for code, comments, commit messages and docs.
- Lint mirrors the community-directory reviewer: every `eslint-disable` needs a `-- reason`; `createDiv`/`createSpan`,
  not `createEl('div'|'span')`; no `any`; sentence case in UI text.
- TypeScript held at 6.0.x and `@wdio/*` at 9.31.6 (docs/spec.md §20); caret ranges, real pinning in `pnpm-lock.yaml`.
- Releases: push a bare version tag equal to `manifest.json` version (`0.1.0-beta.1`, no `v`);
  `.github/workflows/release.yml` builds and attaches `main.js`, `manifest.json`, `styles.css`.
- Upstream merges: `git fetch upstream && git merge upstream/main` (remote: `siosig/obsidian-nextcloudsync`); once per
  clone `git config merge.ours.driver true` for `.gitattributes`. Then build, lint, `pnpm test`, `pnpm test:oc`.
