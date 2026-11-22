# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

An Obsidian community plugin for bidirectional Vault sync over WebDAV. The code base is a fork of
`siosig/obsidian-nextcloudsync` ("Nextcloud Sync", plugin id `nextcloud-sync`); this repo
(`Nyeksenn/obsidian-opencloudsync`) is reworking it for OpenCloud on the `feature/opencloud-rework` branch.
Names, docs, tests and hooks still say "Nextcloud" throughout — treat that as inherited, not as the target.

The plugin talks to the server through `IWebDAVClient`, which has two implementations:
`NextcloudClient` (Nextcloud extensions: `oc:checksums`, file IDs, sync-token REPORT, chunked upload,
LOCK, versions, OCS capabilities, Login Flow v2) and `StandardWebDAVClient` (plain WebDAV fallback,
`Depth: 1` recursion). `WebDAVFactory` picks one from capability detection.

## Commands

pnpm is required (version pinned by `packageManager` in `package.json`, Node 26).

```bash
pnpm install                 # also sets core.hooksPath=.githooks via "prepare"
pnpm dev                     # esbuild watch build -> ./main.js (OUTDIR=<vault>/.obsidian/plugins/<id> to build straight into a vault; copies manifest.json + styles.css)
pnpm build                   # tsc --noEmit + production bundle
pnpm lint                    # eslint src (mirrors the Obsidian community-directory reviewer)
pnpm test                    # layer "a": pure-logic Jest suite (the only layer CI runs)
pnpm test tests/a-no-nextcloud/sync/cleanSideSnapshot.test.ts   # single file
pnpm test -t 'CSS-12'        # single test by name / spec tag
```

Local OpenCloud dev server (rootless Podman): `podman-compose up -d` using `compose.yml`, then
`https://localhost:8080` with **admin / admin** (self-signed TLS, WebDAV root
`https://localhost:8080/remote.php/dav/files/admin/`). Details and caveats: `docs/local-opencloud.md`.

Live layers run only through Docker (`tests/docker/run.sh`, see `tests/README.md` for host prerequisites
and exit codes):

```bash
bash tests/docker/run.sh <a|b1|b2|b3|b4|all>   # b1 live Nextcloud headless, b2 desktop Obsidian UI (wdio),
                                               # b3 Android/Redroid (needs binder + AppArmor profile), b4 plain WebDAV (Apache mod_dav)
bash tests/docker/run.sh --changed <layer>     # skip a layer that already passed on this exact working tree
```

Jest configs: `jest.config.js` (a, excludes all b* dirs), `jest.b1.config.js` (`*.b1.test.ts`),
`jest.b4.config.js` (`*.b4.test.ts`); b2/b3 use `wdio.conf.mts` / `wdio.android.conf.mts`. Each layer maps
`obsidian` to its own mock (`tests/a-no-nextcloud/support/obsidian.ts`, `tests/*/__mocks__/obsidian.ts`).

## Spec-driven workflow

- `docs/spec.md` is the behavioural source of truth (clauses with IDs like `CSS-1`, `WSF-3`, `CTE-7`);
  `docs/plan.md` is the implementation design (components, orchestration, module boundaries).
- Tests cite clauses only via a `[SPEC:<id>]` tag in the `describe`/`it` title (or the `spec()` helper in
  `tests/a-no-nextcloud/support/specRef.ts`). Skipped tests do not count.
- `tests/a-no-nextcloud/spec-coverage/clauses.ts` is the clause catalog; `coverage.test.ts` fails when a
  clause has no test. `docsReferences.test.ts` checks that every `docs/spec.md §…` / `docs/plan.md §…`
  reference in a code comment points at a real heading, and that comments carry no feature-number history.
- When behaviour changes: update `docs/spec.md`, update `clauses.ts`, add/adjust tagged tests, make `pnpm test` green.
- Clause tags live on `SyncEngine`-level tests; directly tested extracted modules (e.g. `sync/policy/`, `sync/scan/`)
  carry no tags, to avoid double-counting.

## Architecture

`src/main.ts` is the plugin host: init, DI, lifecycle, commands, triggers (manual / interval / startup /
foreground resume / Vault watch events).

`src/sync/SyncEngine.ts` is the composition root and the core loop: session lifetime
(`runSyncSession` → `ensureClient` → `initialSync` | `incrementalSync`, `finally` persists StateDB),
the three-point comparison (local / remote / last-synced state), per-file decision (`processFile`) and
~60 thin delegations to extracted modules. Only one full session runs at a time (balking guard on `running`);
watch operations arriving mid-session are queued in a pending set.

Extracted modules under `src/sync/` each own one concern (`transfer/`, `deletion/`, `directory/`, `mirror/`,
`conflict/`, `resolution/`, `scan/`, `session/`, `watch/`, `ctime/`, `plugins/`, `versions/`, `identity/`) and
follow these conventions (plan.md §17.1):

- Never import `SyncEngineOptions`; declare the minimal interface needed.
- Receive `IWebDAVClient` / `IUploadStrategy` as call arguments, never store them (the client is created lazily and can be replaced).
- Values that change over the engine lifetime (settings, `isNextcloud`, times, `isCancelled`) are passed as accessors; lazy evaluation is intentional.
- Mutable state lives with its owner (e.g. held locks in `TransferService`, in-flight/pending sets in `WatchOperations`, run start time in `SyncJournal`); core-loop state stays in `SyncEngine`.
- Outward effects go through injected function ports. Only `watch/` calls back into the engine, via the injected `processFile` port — watch decides nothing itself.
- Decision vs. execution are split: pure deciders (`ConflictResolver`, `sync/policy/`, `directory/classify.ts`,
  `mirror/convergence.ts`, `util/creationTime.ts`, `network/dav/` PROPFIND parsers, most of `sync/plugins/`) and
  executors (`ConflictApplier`, `CreationTimeAligner`, services).

Other layers:

- `src/network/` — clients, `serverUrl.ts` (URL parsing, public-share detection), `certTrust.ts`, timeouts/retry. Clients read the app password on every request via an `AppPasswordReader`.
- `src/data/` — `LocalAdapter` (Obsidian DataAdapter + Vault cache, atomic writes), `StateDB` (per-device per-path `FileState`, fileId index, sync token), `MergeBaseStore` (3-way merge bases), `SyncHistoryStore`, `CleanSideStore`.
- `src/sync/merge/` — `MergeEngine` tries `ReconcileTextStrategy` then `Diff3Strategy`; frontmatter has its own strategy. Conflicts are always settled (no "hold" state).
- `src/settings/` — `settingDefinitions.ts` drives the settings tab; `util/fixedSyncConfig.ts` holds non-UI fixed values; `util/limits.ts` holds tuning constants; `util/settingsMigration.ts` migrates stored settings.
- `src/ui/` — modals, status bar, ribbon.

## Repo rules enforced by hooks

`.githooks/` (installed by `pnpm install`):

- **commit-msg**: commit messages must contain no Japanese/CJK characters.
- **pre-commit**: secretlint on staged files (uses gitignored `.secretlintrc.local.json` if present); no CJK in staged
  files except `*.ja*`; **author email must be the upstream author's (`siosig@…`)** — this gate is inherited from
  upstream and will reject commits from this fork's author until it is changed or bypassed with `--no-verify`.
- **pre-push**: `pnpm lint`, `pnpm build`, README.md and README.ja.md must both name the `manifest.json` version in their
  "What's new" heading and mention `minAppVersion`; stable versions need `[x.y.z]` entries in CHANGELOG.md and
  CHANGELOG.ja.md; pre-release versions run `tests/docker/run.sh --changed a` (falls back to `pnpm test`).

Other conventions:

- English for code, comments, commit messages and docs; Japanese only in `*.ja.md` mirrors (keep them in sync with the English files).
- Lint mirrors the community-directory reviewer: every `eslint-disable` needs a `-- reason`; use `createDiv`/`createSpan`, not `createEl('div'|'span')`; no `any`.
- TypeScript is held at 6.0.x and `@wdio/*` at 9.31.6 (spec §20 explains why); all dependency specifiers are caret ranges, real pinning is `pnpm-lock.yaml`; don't add `js-yaml` (frontmatter is parsed via the Obsidian API).
- Releases: push a bare version tag (`1.2.3`, no `v`) equal to `manifest.json` version; `.github/workflows/release.yml` builds and attaches `main.js`, `manifest.json`, `styles.css`. Betas (`x.y.z-beta.N`) must pass `bash tests/docker/run.sh --changed all` first.
