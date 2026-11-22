# Local OpenCloud server for development

`compose.yml` in the repository root starts a throwaway OpenCloud instance for testing the plugin in Obsidian and for
the live test layer (`pnpm test:oc`). It is meant for development only: fixed credentials, **plain HTTP**, no web login.

## Start and stop

```bash
podman-compose up -d        # rootless Podman; first start generates the config (~5–10 s)
podman-compose logs -f      # follow the server log
podman-compose down         # stop, keep config and data
podman-compose down -v      # stop and wipe config and data (fresh instance on next start)
```

## Credentials

| Plugin setting | Value |
|---|---|
| Server URL | `http://localhost:8080` |
| Username | `admin` |
| App token | create one (below) |

The port is bound to `127.0.0.1` only. Sync (and any API call) needs an **app token**:

```bash
podman exec opencloud-dev opencloud auth-app create --user-name=admin --expiration=720h
```

It prints `token: <several words>`; paste the whole phrase, spaces included, as the plugin's app token.

Quick check, and a project space to test the space picker with:

```bash
curl -u 'admin:<token>' http://localhost:8080/graph/v1.0/me/drives
curl -u 'admin:<token>' -X POST -H 'Content-Type: application/json' \
  -d '{"name":"Vault Test"}' http://localhost:8080/graph/v1.0/drives
```

List the files of a space (its `webDavUrl` comes from the `drives` answer):

```bash
curl -u 'admin:<token>' -X PROPFIND -H 'Depth: 1' '<webDavUrl>/'
```

## Testing the plugin in Obsidian

1. Create an empty folder, e.g. `~/ObsidianTest`, and open it in Obsidian with *Open folder as vault*. Never use a
   real vault for testing.
2. Build into it; the watcher rebuilds on every save:
   ```bash
   OUTDIR=~/ObsidianTest/.obsidian/plugins/opencloud-sync pnpm dev
   ```
3. *Settings → Community plugins*: turn community plugins on and enable **OpenCloud Sync**.
4. *Settings → OpenCloud Sync*: Server URL `http://localhost:8080`, username `admin`, app token via *Link…*; press
   **Connect**, pick a space, **Sync now**.
5. After a code change: toggle the plugin off and on, or run *Reload app without saving* from the command palette.
   `Ctrl+Shift+I` opens the developer console; *Enable logging* writes `opencloud-debug_<device>.txt` into the vault.
6. Two devices: open a second throwaway vault on the same space. Each vault has its own device id and sync state.

Phones cannot reach `localhost`, and Android may refuse plain HTTP, so this setup is for desktop testing.

## Live tests

`pnpm test:oc` uses this server. For each run it creates a 2-hour app token and a fresh project space (deleted again
afterwards). It exits 3 when the server is not running. `OC_URL=https://… pnpm test:oc` runs against an HTTPS server
instead; the script then trusts that server's current certificate for the run only.

## Things to know

- **Plain HTTP, no web login.** OpenCloud's built-in login service (IDP) refuses to start unless `OC_URL` is
  `https://`, so it is switched off (`OC_EXCLUDE_RUN_SERVICES=idp`). The plugin does not use it: it authenticates with
  an app token over basic auth, which the proxy checks itself. The web UI therefore cannot log in; use `curl` or the
  plugin to look at files. Real servers should of course use HTTPS.
- **Port 8080 is set in three places** — `ports`, `PROXY_HTTP_ADDR` and `OC_URL`. Change all three together.
- **Init runs once.** The first start writes `/etc/opencloud/opencloud.yaml` into the `opencloud-config` volume; later
  starts reuse it. Switching between HTTP and HTTPS needs no re-init: the URLs come from `OC_URL` at start.
- **Rootless Podman:** named volumes are used instead of bind mounts so ownership matches the image's uid 1000 without
  extra `userns` settings.
- This server is independent of upstream's Docker test layers in `tests/docker/` (those start Nextcloud / plain WebDAV).
