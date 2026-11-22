# Changelog — OpenCloud Sync

Release history of this fork. Upstream's history (Nextcloud Sync 1.0.18 and earlier, whose sync engine this fork
uses unchanged) is in the [upstream changelog](https://github.com/siosig/obsidian-nextcloudsync/blob/main/CHANGELOG.md).
Stable releases need an entry here (checked by `.githooks/pre-push`); pre-releases are folded into the next stable entry.

## [Unreleased]

### Added

- OpenCloud backend: `OpenCloudClient` for one space (Depth-1 listing walk, SHA-1 checksums, TUS uploads, versions
  under `/dav/meta`, restore by file id), built by `OpenCloudFactory`.
- Settings: server URL, username, app token, *Connect*, space picker (personal and project spaces), optional folder
  inside the space. Changing the target confirms and resets this device's tracking first.
- Safety: a missing space, a space chosen on another server, and an href outside the space never reach the engine as
  an empty or foreign listing.
- Live test layer against a local OpenCloud (`pnpm test:oc`, `compose.yml`).

### Changed

- All user-visible text says OpenCloud: ribbon, status bar, notices, debug-log file (`opencloud-debug_<device>.txt`),
  mass-delete reports, and the default Secret Storage name of the token (`opencloud-sync-app-token`).
- README and CHANGELOG are the fork's own; the Japanese translations were removed.
- Plugin id `opencloud-sync`, name "OpenCloud Sync". The engine's content digest is SHA-1 (OpenCloud has no SHA-256).

[Unreleased]: https://github.com/Nyeksenn/obsidian-opencloudsync/commits/feature/opencloud-rework
