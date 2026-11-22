# Local OpenCloud server for development

`compose.yml` in the repository root starts a throwaway OpenCloud instance for manual testing of the plugin and for the
live test layer (`pnpm test:oc`). It is meant for development only: fixed credentials, self-signed TLS.

## Start and stop

```bash
podman-compose up -d        # rootless Podman; first start generates the config (~5–10 s)
podman-compose logs -f      # follow the server log
podman-compose down         # stop, keep config and data
podman-compose down -v      # stop and wipe config and data (fresh instance on next start)
```

## Credentials

| What | Value |
|---|---|
| Web UI | https://localhost:8080 — log in as `admin` / `admin` |
| Plugin "Server URL" | `https://localhost:8080` |
| Plugin "Username" | `admin` |
| Plugin "App token" | create one (below) |

The port is bound to `127.0.0.1` only.

The account password works only for the web UI. Sync (and any API call) needs an **app token**:

```bash
podman exec opencloud-dev opencloud auth-app create --user-name=admin --expiration=720h
```

It prints `token: <several words>`; paste the whole phrase, spaces included, as the plugin's app token.

Quick check from a shell (`-k` because the certificate is self-signed):

```bash
curl -k -u 'admin:<token>' https://localhost:8080/graph/v1.0/me/drives
```

A project space to test the space picker with:

```bash
curl -k -u 'admin:<token>' -X POST -H 'Content-Type: application/json' \
  -d '{"name":"Vault Test"}' https://localhost:8080/graph/v1.0/drives
```

## Live tests

`pnpm test:oc` uses this server. For each run it creates a 2-hour app token and a fresh project space (deleted again
afterwards), and trusts the server's self-signed certificate for that run only. It exits 3 when the server is not
running.

## Things to know

- **HTTPS only, self-signed.** OpenCloud's built-in IDP refuses to start unless `OC_URL` is `https://`, so the server
  terminates TLS itself with a generated certificate (valid for `localhost` and `127.0.0.1`). Obsidian must trust it to
  sync from the app; see the certificate FAQ in the README. Not verified here: the generated certificate is a
  self-signed leaf (`CA:FALSE`), not a CA, so the "add your CA to the trust store" route may not accept it as is. The
  live tests do not depend on this; they trust it explicitly.
- **Port 8080 is set in three places** — `ports`, `PROXY_HTTP_ADDR` and `OC_URL`. Change all three together, or login
  ends in `/access-denied`.
- **Init runs once.** The first start writes `/etc/opencloud/opencloud.yaml` into the `opencloud-config` volume; later
  starts reuse it. Changing `IDM_ADMIN_PASSWORD` after that has no effect until `down -v`.
- **Rootless Podman:** named volumes are used instead of bind mounts so ownership matches the image's uid 1000 without
  extra `userns` settings.
- This server is independent of upstream's Docker test layers in `tests/docker/` (those start Nextcloud / plain WebDAV).
